import { getSecureStorage } from './secure-storage';
import { getDatabase } from './database';
import type {
  Credentials,
  SnykStatus,
  SnykConnectResult,
  SnykHealthResult,
  SnykRepoIssueCounts,
} from '../../shared/types';

const SNYK_API_BASE = 'https://api.snyk.io';
// Snyk requires a dated REST API version. This value is pinned so responses are
// stable; bump it deliberately when adopting newer response shapes.
const SNYK_API_VERSION = '2024-10-15';
const PAGE_LIMIT = 100;

// How long cached issue counts are considered fresh. Within this window the
// panel serves the cached result instead of re-crawling Snyk, unless a refresh
// is explicitly forced.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

interface SnykOrg {
  id: string;
  attributes?: { name?: string; slug?: string };
}

interface SnykProject {
  id: string;
  attributes?: { name?: string };
}

interface SnykIssue {
  attributes?: {
    effective_severity_level?: string;
    severity?: string;
    status?: string;
  };
  relationships?: {
    scan_item?: { data?: { id?: string; type?: string } };
  };
}

/**
 * Minimal client for the Snyk REST API, used to surface critical/high issue
 * counts per repository in the Repository Health widget.
 *
 * Auth uses a Snyk API token (service account or personal) sent as
 * `Authorization: token <token>`, which is what the REST API expects.
 */
export class SnykService {
  private secureStorage = getSecureStorage();
  private db = getDatabase();
  // Guards against overlapping fetches (e.g. a forced refresh landing while a
  // background refresh is already in flight).
  private inFlight: Promise<SnykHealthResult> | null = null;

  private authHeaders(token: string): Record<string, string> {
    return {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.api+json',
    };
  }

  /**
   * Resolves the Snyk org to use. If an orgId is provided it is validated;
   * otherwise the first org the token can see is used.
   */
  private async resolveOrg(
    token: string,
    orgId?: string
  ): Promise<{ id: string; name?: string } | null> {
    const res = await fetch(
      `${SNYK_API_BASE}/rest/orgs?version=${SNYK_API_VERSION}&limit=${PAGE_LIMIT}`,
      { headers: this.authHeaders(token) }
    );
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as { data?: SnykOrg[] };
    const orgs = body.data ?? [];
    if (orgs.length === 0) {
      return null;
    }
    if (orgId) {
      const match = orgs.find((o) => o.id === orgId);
      if (!match) {
        return null;
      }
      return { id: match.id, name: match.attributes?.name };
    }
    const first = orgs[0];
    return { id: first.id, name: first.attributes?.name };
  }

  /**
   * Validates the token (and optional org), then persists the credential.
   */
  async connect(token: string, orgId?: string): Promise<SnykConnectResult> {
    try {
      const normalized = token.replace(/^token\s+/i, '').trim();
      if (!normalized) {
        return { success: false, error: 'Please enter a Snyk API token.' };
      }

      // Resolve the authenticated user as a friendly identity.
      let username: string | undefined;
      try {
        const selfRes = await fetch(`${SNYK_API_BASE}/rest/self?version=${SNYK_API_VERSION}`, {
          headers: this.authHeaders(normalized),
        });
        if (selfRes.ok) {
          const selfBody = (await selfRes.json()) as {
            data?: { attributes?: { name?: string; username?: string; email?: string } };
          };
          const attrs = selfBody.data?.attributes;
          username = attrs?.name || attrs?.username || attrs?.email;
        }
      } catch {
        // Non-fatal: identity is cosmetic.
      }

      const trimmedOrgId = orgId?.trim();

      if (trimmedOrgId) {
        // Pin to a specific org, validating access.
        const org = await this.resolveOrg(normalized, trimmedOrgId);
        if (!org) {
          return {
            success: false,
            error:
              'Could not access that Snyk organization with this token. Check the token and org ID.',
          };
        }
        const credentials: Credentials = {
          accessToken: normalized,
          username: username ?? 'Snyk',
          snykOrgId: org.id,
          snykOrgName: org.name,
        };
        await this.secureStorage.setCredentials('snyk', credentials);
        return { success: true, username, orgName: org.name };
      }

      // No org pinned: scan all accessible orgs. Validate the token can see at
      // least one org before saving.
      const orgs = await this.listOrgs(normalized);
      if (orgs.length === 0) {
        return {
          success: false,
          error: 'Invalid Snyk API token, or the token has no accessible organizations.',
        };
      }
      const credentials: Credentials = {
        accessToken: normalized,
        username: username ?? 'Snyk',
        snykOrgId: '*', // sentinel: scan all orgs
        snykOrgName: `All organizations (${orgs.length})`,
      };
      await this.secureStorage.setCredentials('snyk', credentials);
      return { success: true, username, orgName: credentials.snykOrgName };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error occurred';
      return { success: false, error: message };
    }
  }

  async getStatus(): Promise<SnykStatus> {
    const credentials = await this.secureStorage.getCredentials('snyk');
    if (!credentials) {
      return { connected: false };
    }
    return {
      connected: true,
      username: credentials.username,
      orgId: credentials.snykOrgId === '*' ? undefined : credentials.snykOrgId,
      orgName: credentials.snykOrgName,
    };
  }

  async disconnect(): Promise<void> {
    await this.secureStorage.deleteCredentials('snyk');
    // Drop cached counts so a future connection (possibly a different token or
    // org scope) doesn't serve stale data.
    this.db.clearSnykCache();
  }

  /**
   * Pages through a Snyk REST collection following `links.next`, invoking
   * `onPage` for each page's `data` array.
   */
  private async paginate<T>(
    initialPath: string,
    token: string,
    onPage: (items: T[]) => void
  ): Promise<void> {
    let nextUrl: string | null = initialPath;
    while (nextUrl) {
      const url = nextUrl.startsWith('http') ? nextUrl : `${SNYK_API_BASE}${nextUrl}`;
      const res = await fetch(url, { headers: this.authHeaders(token) });
      if (!res.ok) {
        throw new Error(`Snyk API error ${res.status}`);
      }
      const body = (await res.json()) as {
        data?: T[];
        links?: { next?: string };
      };
      onPage(body.data ?? []);
      nextUrl = body.links?.next ?? null;
    }
  }

  /**
   * Normalizes a Snyk project/target name to a repository name so counts can be
   * joined against imported repositories. Snyk project names commonly look like
   * `owner/repo:path/to/manifest` or `owner/repo(branch)`; we strip the manifest
   * suffix and any owner prefix, leaving the repo slug.
   */
  private normalizeRepoName(projectName: string): string {
    let name = projectName.trim();
    // Drop manifest target after a colon: "repo:package.json" -> "repo"
    const colon = name.indexOf(':');
    if (colon !== -1) {
      name = name.slice(0, colon);
    }
    // Drop branch in parens: "repo(main)" -> "repo"
    name = name.replace(/\(.*\)\s*$/, '');
    // Drop owner/org prefix: "my-org/repo" -> "repo"
    const slash = name.lastIndexOf('/');
    if (slash !== -1) {
      name = name.slice(slash + 1);
    }
    return name.trim().toLowerCase();
  }

  private severityOf(issue: SnykIssue): string {
    return (
      issue.attributes?.effective_severity_level ||
      issue.attributes?.severity ||
      ''
    ).toLowerCase();
  }

  /**
   * Fetches critical/high open issue counts for the connected org, aggregated
   * per repository.
   *
   * Rather than fetch all org issues and try to join each one back to a project
   * (whose `scan_item` linkage is unreliable across issue types), this queries
   * issues per project scoped by `scan_item.id`/`scan_item.type=project`, so
   * every returned issue is attributed to a known project by construction.
   */
  /** Lists every org the token can access. */
  private async listOrgs(token: string): Promise<Array<{ id: string; name?: string }>> {
    const orgs: Array<{ id: string; name?: string }> = [];
    await this.paginate<SnykOrg>(
      `/rest/orgs?version=${SNYK_API_VERSION}&limit=${PAGE_LIMIT}`,
      token,
      (page) => {
        for (const o of page) {
          orgs.push({ id: o.id, name: o.attributes?.name });
        }
      }
    );
    return orgs;
  }

  /** Counts critical/high open issues per project within a single org. */
  private async collectOrgCounts(
    token: string,
    orgId: string,
    counts: Map<string, SnykRepoIssueCounts>,
    projectNames: string[]
  ): Promise<{ totalIssues: number; criticalHighIssues: number }> {
    const projects: Array<{ id: string; repoName: string }> = [];
    await this.paginate<SnykProject>(
      `/rest/orgs/${orgId}/projects?version=${SNYK_API_VERSION}&limit=${PAGE_LIMIT}`,
      token,
      (page) => {
        for (const p of page) {
          const repoName = this.normalizeRepoName(p.attributes?.name ?? '');
          projects.push({ id: p.id, repoName });
          if (repoName) projectNames.push(repoName);
        }
      }
    );

    let totalIssues = 0;
    let criticalHighIssues = 0;

    const bump = (repoName: string, severity: string) => {
      const existing = counts.get(repoName) ?? { repoName, critical: 0, high: 0 };
      if (severity === 'critical') existing.critical += 1;
      else existing.high += 1;
      counts.set(repoName, existing);
    };

    for (const project of projects) {
      if (!project.repoName) continue;
      const path =
        `/rest/orgs/${orgId}/issues?version=${SNYK_API_VERSION}&limit=${PAGE_LIMIT}` +
        `&scan_item.id=${encodeURIComponent(project.id)}&scan_item.type=project` +
        `&status=open`;
      await this.paginate<SnykIssue>(path, token, (issues) => {
        for (const issue of issues) {
          totalIssues += 1;
          const severity = this.severityOf(issue);
          if (severity !== 'critical' && severity !== 'high') continue;
          criticalHighIssues += 1;
          bump(project.repoName, severity);
        }
      });
    }

    return { totalIssues, criticalHighIssues };
  }

  /**
   * Returns per-repository critical/high issue counts, served from the local
   * cache when it is still within the TTL window.
   *
   * - Normal load: returns cached counts if fresh; otherwise fetches live,
   *   caches, and returns.
   * - `force: true`: always fetches live and refreshes the cache, even if the
   *   cache is still fresh (the manual override).
   */
  async getHealth(options?: { force?: boolean }): Promise<SnykHealthResult> {
    const credentials = await this.secureStorage.getCredentials('snyk');
    if (!credentials) {
      throw new Error('Snyk is not connected.');
    }

    const force = options?.force === true;
    const cache = this.db.getSnykCache();

    if (!force && cache) {
      const ageMs = Date.now() - cache.fetchedAt.getTime();
      if (ageMs < CACHE_TTL_MS) {
        try {
          const parsed = JSON.parse(cache.payload) as SnykHealthResult;
          return { ...parsed, cached: true, stale: false };
        } catch {
          // Corrupt cache: fall through to a live fetch.
        }
      }
    }

    // Coalesce concurrent fetches so a forced refresh and a background refresh
    // don't both crawl Snyk at once.
    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.fetchHealthFromApi(credentials)
      .then((result) => {
        this.db.saveSnykCache(JSON.stringify(result), new Date(result.fetchedAt));
        return result;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  /**
   * Fetches critical/high open issue counts aggregated per repository, live
   * from the Snyk API.
   *
   * If the connection pinned a specific org ID, only that org is scanned.
   * Otherwise every org the token can access is scanned and merged, since Snyk
   * commonly spreads a company's repositories across many orgs.
   */
  private async fetchHealthFromApi(credentials: Credentials): Promise<SnykHealthResult> {
    const token = credentials.accessToken;

    // Determine which orgs to scan. A pinned org id means "just this one";
    // the "all orgs" sentinel (or a missing id) means scan everything.
    const scanAllOrgs = !credentials.snykOrgId || credentials.snykOrgId === '*';
    const orgs = scanAllOrgs
      ? await this.listOrgs(token)
      : [{ id: credentials.snykOrgId!, name: credentials.snykOrgName }];

    const counts = new Map<string, SnykRepoIssueCounts>();
    const projectNames: string[] = [];
    let totalIssues = 0;
    let criticalHighIssues = 0;

    for (const org of orgs) {
      const result = await this.collectOrgCounts(token, org.id, counts, projectNames);
      totalIssues += result.totalIssues;
      criticalHighIssues += result.criticalHighIssues;
    }

    const countsByRepoName: Record<string, SnykRepoIssueCounts> = {};
    for (const [repoName, c] of counts) {
      countsByRepoName[repoName] = c;
    }

    const uniqueProjectNames = Array.from(new Set(projectNames)).sort();

    // eslint-disable-next-line no-console
    console.log(
      `[snyk] orgs=${orgs.length} (${scanAllOrgs ? 'all' : 'pinned'}) projects=${projectNames.length} ` +
        `issues=${totalIssues} critical/high=${criticalHighIssues} ` +
        `repos-with-counts=${Object.keys(countsByRepoName).length}`
    );
    // eslint-disable-next-line no-console
    console.log('[snyk] project repo names:', uniqueProjectNames);

    return {
      fetchedAt: new Date().toISOString(),
      countsByRepoName,
      diagnostics: {
        totalIssues,
        criticalHighIssues,
        unmatchedIssues: 0,
        projectNames: uniqueProjectNames,
      },
    };
  }
}

// Singleton instance
let snykInstance: SnykService | null = null;

export function getSnykService(): SnykService {
  if (!snykInstance) {
    snykInstance = new SnykService();
  }
  return snykInstance;
}
