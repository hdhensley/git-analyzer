import type { AuthService } from './auth';
import type {
  SCMProvider,
  Repository,
  RepositoryPage,
  CommitData,
  ReleaseData,
  ReleaseCommit,
} from '../../shared/types';
import {
  FIRST_RELEASE_COMMIT_CAP,
  isWithinLookback,
  orderReleaseTags,
  type RawReleaseTag,
} from './releases';
import { DEFAULT_RELEASE_BRANCH_MODE, releaseBranchCandidates } from '../../shared/releaseBranch';

const PAGE_SIZE = 100;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;
const MAX_CLOUD_COMMITS = 2000;
const MAX_CLOUD_AGE_MS = 365 * 24 * 60 * 60 * 1000; // 1 year
const MAX_TAG_PAGES = 3; // 300 tags per repo is far more than a year of releases
const MAX_RELEASE_COMMITS = 500;

export type FetchProgressCallback = (info: {
  currentPage?: number;
  commitsSoFar?: number;
  rateLimitRetrySeconds?: number;
}) => void;

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  onProgress?: FetchProgressCallback,
  retries = MAX_RETRIES
): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch(url, options);

    if (response.status === 429) {
      if (attempt === retries) {
        throw new Error('Rate limited by API after multiple retries');
      }
      const retryAfter = response.headers.get('Retry-After');
      const delaySec = retryAfter
        ? parseInt(retryAfter, 10)
        : Math.ceil((BASE_DELAY_MS * Math.pow(2, attempt)) / 1000);
      onProgress?.({ rateLimitRetrySeconds: delaySec });
      await new Promise((resolve) => setTimeout(resolve, delaySec * 1000));
      continue;
    }

    return response;
  }

  throw new Error('Unexpected retry loop exit');
}

export class GitService {
  constructor(private readonly authService: AuthService) {}

  private normalizeBitbucketBranchName(branch: string | undefined): string | undefined {
    if (!branch) return undefined;
    const trimmed = branch.trim();
    if (!trimmed) return undefined;
    return trimmed.replace(/^refs\/heads\//, '');
  }

  private buildBitbucketCommitsUrl(repo: Repository, branch?: string): string {
    const encodedOwner = encodeURIComponent(repo.owner);
    const encodedRepo = encodeURIComponent(repo.name);
    const baseUrl = `https://api.bitbucket.org/2.0/repositories/${encodedOwner}/${encodedRepo}/commits`;

    if (branch) {
      return `${baseUrl}/${encodeURIComponent(branch)}?pagelen=100`;
    }

    return `${baseUrl}?pagelen=100`;
  }

  async listRepositories(provider: SCMProvider, page: number = 1): Promise<RepositoryPage> {
    const authHeader = await this.authService.getAuthHeader(provider);

    if (!authHeader) {
      throw new Error(`Not authenticated with ${provider}`);
    }

    if (provider === 'github') {
      return this.listGitHubRepositories(authHeader, page);
    } else {
      const credentials = await this.authService.getCredentials(provider);
      return this.listBitbucketRepositories(authHeader, credentials?.bitbucketWorkspaces ?? []);
    }
  }

  private async listGitHubRepositories(authHeader: string, page: number): Promise<RepositoryPage> {
    const url = new URL('https://api.github.com/user/repos');
    url.searchParams.set('per_page', PAGE_SIZE.toString());
    url.searchParams.set('page', page.toString());
    url.searchParams.set('sort', 'updated');
    url.searchParams.set('direction', 'desc');

    const response = await fetchWithRetry(url.toString(), {
      headers: {
        Authorization: authHeader,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch repositories: ${response.statusText}`);
    }

    type GitHubRepo = {
      id: number;
      name: string;
      owner: { login: string };
      default_branch: string;
      html_url: string;
    };

    const repos = (await response.json()) as GitHubRepo[];
    const linkHeader = response.headers.get('Link');
    const hasNextPage = linkHeader?.includes('rel="next"') ?? false;

    const repositories: Repository[] = repos.map((repo) => ({
      id: `github-${repo.id}`,
      name: repo.name,
      owner: repo.owner.login,
      provider: 'github' as const,
      defaultBranch: repo.default_branch,
      url: repo.html_url,
      parentFolder: repo.owner.login,
    }));

    return {
      repositories,
      totalCount: repositories.length + (hasNextPage ? PAGE_SIZE : 0),
      hasNextPage,
      nextPage: hasNextPage ? page + 1 : undefined,
    };
  }

  private async listBitbucketRepositories(
    authHeader: string,
    workspaces: string[]
  ): Promise<RepositoryPage> {
    if (workspaces.length === 0) {
      throw new Error(
        'No accessible Bitbucket workspaces found for this token. Reconnect with a scoped API token that has access to at least one workspace.'
      );
    }

    type BitbucketRepo = {
      uuid: string;
      slug: string;
      name: string;
      owner: { nickname?: string; username?: string; display_name?: string };
      workspace?: { slug: string; name?: string };
      mainbranch?: { name: string };
      links: { html: { href: string } };
      project?: { name: string };
      full_name?: string;
    };

    const allRepositories: Repository[] = [];

    // Scoped API tokens are workspace-scoped and cannot use the account-wide
    // /2.0/repositories?role=member listing (it returns 404). List per workspace
    // via /2.0/repositories/{workspace} instead.
    for (const workspace of workspaces) {
      let nextUrl: string | null = (() => {
        const url = new URL(
          `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(workspace)}`
        );
        url.searchParams.set('pagelen', PAGE_SIZE.toString());
        return url.toString();
      })();

      while (nextUrl) {
        const response: Response = await fetchWithRetry(nextUrl, {
          headers: {
            Authorization: authHeader,
            Accept: 'application/json',
          },
        });

        if (!response.ok) {
          throw new Error(
            `Failed to fetch repositories for workspace "${workspace}": ${response.statusText}`
          );
        }

        const data = (await response.json()) as {
          values: BitbucketRepo[];
          next?: string;
          size?: number;
        };

        for (const repo of data.values) {
          // Bitbucket API v2: use workspace.slug for API calls (owner.username is deprecated)
          // full_name is "workspace/repo-slug" which is the most reliable identifier
          const ownerSlug =
            repo.workspace?.slug ||
            repo.full_name?.split('/')[0] ||
            repo.owner?.nickname ||
            repo.owner?.username ||
            repo.owner?.display_name ||
            workspace;

          allRepositories.push({
            id: `bitbucket-${repo.uuid}`,
            name: repo.slug || repo.name,
            owner: ownerSlug,
            provider: 'bitbucket' as const,
            defaultBranch: repo.mainbranch?.name || 'main',
            url: repo.links.html.href,
            parentFolder: repo.project?.name,
          });
        }

        nextUrl = data.next || null;
      }
    }

    return {
      repositories: allRepositories,
      totalCount: allRepositories.length,
      hasNextPage: false,
      nextPage: undefined,
    };
  }

  /**
   * Fetches the CURRENT default branch for a single cloud repository from the
   * provider, so a default-branch change made on GitHub/Bitbucket after import
   * can be picked up during sync. Returns null if it can't be determined (the
   * caller then leaves the stored value unchanged).
   */
  async fetchDefaultBranch(repo: Repository): Promise<string | null> {
    const provider = repo.provider as SCMProvider;
    if (provider !== 'github' && provider !== 'bitbucket') {
      return null;
    }
    const authHeader = await this.authService.getAuthHeader(provider);
    if (!authHeader) {
      return null;
    }

    try {
      if (provider === 'github') {
        const url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
        const response = await fetchWithRetry(url, {
          headers: { Authorization: authHeader, Accept: 'application/vnd.github.v3+json' },
        });
        if (!response.ok) return null;
        const data = (await response.json()) as { default_branch?: string };
        return data.default_branch || null;
      } else {
        const url = `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
        const response = await fetchWithRetry(url, {
          headers: { Authorization: authHeader, Accept: 'application/json' },
        });
        if (!response.ok) return null;
        const data = (await response.json()) as { mainbranch?: { name?: string } };
        return data.mainbranch?.name || null;
      }
    } catch {
      return null;
    }
  }

  /**
   * Lists every repository the provider exposes as clone-ready SCM repositories,
   * paging through all results. Provider-agnostic: works for GitHub and
   * Bitbucket by reusing the existing listRepositories pagination.
   */
  async listAllScmRepositories(
    provider: SCMProvider
  ): Promise<import('../../shared/types').ScmProjectRepository[]> {
    const all: import('../../shared/types').ScmProjectRepository[] = [];
    let page: number | undefined = 1;

    // GitHub pages numerically; Bitbucket returns everything in one call
    // (hasNextPage=false). Loop on nextPage to cover both.
    while (page !== undefined) {
      const result = await this.listRepositories(provider, page);
      for (const repo of result.repositories) {
        all.push(this.toScmProjectRepository(repo, provider));
      }
      page = result.hasNextPage ? result.nextPage : undefined;
    }

    return all;
  }

  /**
   * Groups a provider's repositories by their project grouping (parentFolder:
   * Bitbucket project name / GitHub owner), returning the distinct groups with
   * their repository counts. Fetches the repository list live from the API.
   */
  async listScmProjectGroups(
    provider: SCMProvider
  ): Promise<import('../../shared/types').ScmProjectGroup[]> {
    const repos = await this.listAllScmRepositories(provider);
    return this.groupRepositories(provider, repos.map((r) => r.group));
  }

  /**
   * Builds the distinct project groups for a provider from the locally cached
   * (imported/synced) repositories, grouping by parentFolder. No network call,
   * so this is instant and works offline. Note: only reflects repositories that
   * have been imported, which may be a subset of the provider's full set.
   */
  listCachedScmProjectGroups(
    provider: SCMProvider,
    importedRepositories: Array<{ provider: string; parentFolder?: string }>
  ): import('../../shared/types').ScmProjectGroup[] {
    const groupNames = importedRepositories
      .filter((r) => r.provider === provider)
      .map((r) => r.parentFolder);
    return this.groupRepositories(provider, groupNames);
  }

  private groupRepositories(
    provider: SCMProvider,
    groupNames: Array<string | undefined>
  ): import('../../shared/types').ScmProjectGroup[] {
    const counts = new Map<string, number>();
    for (const name of groupNames) {
      const key = name || '(ungrouped)';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, repositoryCount]) => ({ provider, name, repositoryCount }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Lists the repositories in a specific project group for a provider. A
   * group of '(ungrouped)' matches repositories with no parentFolder.
   */
  async listScmGroupRepositories(
    provider: SCMProvider,
    group: string
  ): Promise<import('../../shared/types').ScmProjectRepository[]> {
    const repos = await this.listAllScmRepositories(provider);
    const normalized = group === '(ungrouped)' ? undefined : group;
    return repos
      .filter((r) => (r.group || undefined) === normalized)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Maps an internal Repository to the clone-ready ScmProjectRepository shape,
   * deriving an https clone URL from the browser URL.
   */
  private toScmProjectRepository(
    repo: Repository,
    provider: SCMProvider
  ): import('../../shared/types').ScmProjectRepository {
    let httpsCloneUrl: string;
    let sshCloneUrl: string;
    if (provider === 'github') {
      httpsCloneUrl = repo.url.endsWith('.git') ? repo.url : `${repo.url}.git`;
      sshCloneUrl = `git@github.com:${repo.owner}/${repo.name}.git`;
    } else {
      // Bitbucket browser URL is https://bitbucket.org/{workspace}/{slug}
      httpsCloneUrl = `https://bitbucket.org/${repo.owner}/${repo.name}.git`;
      sshCloneUrl = `git@ssh.bitbucket.org:${repo.owner}/${repo.name}.git`;
    }

    return {
      provider,
      name: repo.name,
      owner: repo.owner,
      group: repo.parentFolder,
      defaultBranch: repo.defaultBranch,
      url: repo.url,
      httpsCloneUrl,
      sshCloneUrl,
    };
  }

  async fetchGitLog(
    repo: Repository,
    onProgress?: FetchProgressCallback
  ): Promise<{ commits: CommitData[]; repository: Repository; fetchedAt: Date }> {
    if (repo.provider === 'local') {
      throw new Error('Local repositories should be handled by LocalGitService');
    }

    const authHeader = await this.authService.getAuthHeader(repo.provider as SCMProvider);

    if (!authHeader) {
      throw new Error(`Not authenticated with ${repo.provider}`);
    }

    let commits: CommitData[];
    if (repo.provider === 'github') {
      commits = await this.fetchGitHubCommits(authHeader, repo, onProgress);
    } else {
      commits = await this.fetchBitbucketCommits(authHeader, repo, onProgress);
    }

    return { commits, repository: repo, fetchedAt: new Date() };
  }

  private async fetchGitHubCommits(
    authHeader: string,
    repo: Repository,
    onProgress?: FetchProgressCallback
  ): Promise<CommitData[]> {
    const allCommits: CommitData[] = [];
    let page = 1;
    const perPage = 100;
    const oneYearAgo = new Date(Date.now() - MAX_CLOUD_AGE_MS);

    type GitHubCommit = {
      sha: string;
      commit: {
        author: { name: string; email: string; date: string };
        message: string;
      };
    };

    for (;;) {
      onProgress?.({ currentPage: page, commitsSoFar: allCommits.length });

      const url = new URL(`https://api.github.com/repos/${repo.owner}/${repo.name}/commits`);
      url.searchParams.set('per_page', perPage.toString());
      url.searchParams.set('page', page.toString());
      url.searchParams.set('sha', repo.defaultBranch);
      url.searchParams.set('since', oneYearAgo.toISOString());

      const response = await fetchWithRetry(
        url.toString(),
        {
          headers: {
            Authorization: authHeader,
            Accept: 'application/vnd.github.v3+json',
          },
        },
        onProgress
      );

      if (!response.ok) {
        if (response.status === 409) {
          // Empty repository
          return [];
        }
        throw new Error(`Failed to fetch commits: ${response.statusText}`);
      }

      const commits = (await response.json()) as GitHubCommit[];

      if (commits.length === 0) break;

      for (const commit of commits) {
        allCommits.push({
          hash: commit.sha,
          authorName: commit.commit.author.name,
          authorEmail: commit.commit.author.email,
          date: new Date(commit.commit.author.date),
          message: commit.commit.message,
          branch: repo.defaultBranch,
        });
        if (allCommits.length >= MAX_CLOUD_COMMITS) break;
      }

      if (allCommits.length >= MAX_CLOUD_COMMITS) break;
      if (commits.length < perPage) break;
      page++;
    }

    return allCommits;
  }

  private async fetchBitbucketCommits(
    authHeader: string,
    repo: Repository,
    onProgress?: FetchProgressCallback
  ): Promise<CommitData[]> {
    const allCommits: CommitData[] = [];
    const normalizedBranch = this.normalizeBitbucketBranchName(repo.defaultBranch);
    let nextUrl: string | null = this.buildBitbucketCommitsUrl(repo, normalizedBranch);
    let usedDefaultBranchFallback = false;
    let page = 1;
    const oneYearAgo = new Date(Date.now() - MAX_CLOUD_AGE_MS);

    while (nextUrl) {
      onProgress?.({ currentPage: page, commitsSoFar: allCommits.length });

      const response: Response = await fetchWithRetry(
        nextUrl,
        {
          headers: {
            Authorization: authHeader,
            Accept: 'application/json',
          },
        },
        onProgress
      );

      if (!response.ok) {
        if (
          !usedDefaultBranchFallback &&
          (response.status === 400 || response.status === 404 || response.status === 409)
        ) {
          nextUrl = this.buildBitbucketCommitsUrl(repo);
          usedDefaultBranchFallback = true;
          page = 1;
          continue;
        }
        throw new Error(`Failed to fetch commits: ${response.statusText}`);
      }

      type BitbucketCommitResponse = {
        values: Array<{
          hash: string;
          author: { user?: { display_name: string; email: string }; raw: string };
          date: string;
          message: string;
        }>;
        next?: string;
      };

      const data = (await response.json()) as BitbucketCommitResponse;

      // Some repositories report an unusable default branch. If the first page is empty,
      // retry once without a branch selector to let Bitbucket resolve it.
      if (
        !usedDefaultBranchFallback &&
        page === 1 &&
        data.values.length === 0 &&
        normalizedBranch
      ) {
        nextUrl = this.buildBitbucketCommitsUrl(repo);
        usedDefaultBranchFallback = true;
        continue;
      }

      let hitLimit = false;

      for (const commit of data.values) {
        const commitDate = new Date(commit.date);
        if (commitDate < oneYearAgo) {
          hitLimit = true;
          break;
        }
        allCommits.push({
          hash: commit.hash,
          authorName:
            commit.author.user?.display_name ||
            commit.author.raw?.split('<')[0].trim() ||
            'Unknown',
          authorEmail: commit.author.user?.email || commit.author.raw?.match(/<(.+)>/)?.[1] || '',
          date: commitDate,
          message: commit.message,
          branch: repo.defaultBranch,
        });
        if (allCommits.length >= MAX_CLOUD_COMMITS) {
          hitLimit = true;
          break;
        }
      }

      if (hitLimit) break;
      nextUrl = data.next || null;
      page++;
    }

    return allCommits;
  }

  async fetchNewCommits(
    repo: Repository,
    since: Date,
    onProgress?: FetchProgressCallback
  ): Promise<{ commits: CommitData[]; repository: Repository; fetchedAt: Date }> {
    if (repo.provider === 'local') {
      throw new Error('Local repositories should be handled by LocalGitService');
    }

    const authHeader = await this.authService.getAuthHeader(repo.provider as SCMProvider);

    if (!authHeader) {
      throw new Error(`Not authenticated with ${repo.provider}`);
    }

    let commits: CommitData[];
    if (repo.provider === 'github') {
      commits = await this.fetchGitHubCommitsSince(authHeader, repo, since, onProgress);
    } else {
      commits = await this.fetchBitbucketCommitsSince(authHeader, repo, since, onProgress);
    }

    return { commits, repository: repo, fetchedAt: new Date() };
  }

  private async fetchGitHubCommitsSince(
    authHeader: string,
    repo: Repository,
    since: Date,
    onProgress?: FetchProgressCallback
  ): Promise<CommitData[]> {
    const allCommits: CommitData[] = [];
    let page = 1;
    const perPage = 100;

    type GitHubCommit = {
      sha: string;
      commit: {
        author: { name: string; email: string; date: string };
        message: string;
      };
    };

    for (;;) {
      onProgress?.({ currentPage: page, commitsSoFar: allCommits.length });
      const url = new URL(`https://api.github.com/repos/${repo.owner}/${repo.name}/commits`);
      url.searchParams.set('per_page', perPage.toString());
      url.searchParams.set('page', page.toString());
      url.searchParams.set('sha', repo.defaultBranch);
      url.searchParams.set('since', since.toISOString());

      const response = await fetchWithRetry(
        url.toString(),
        {
          headers: {
            Authorization: authHeader,
            Accept: 'application/vnd.github.v3+json',
          },
        },
        onProgress
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch commits: ${response.statusText}`);
      }

      const commits = (await response.json()) as GitHubCommit[];

      if (commits.length === 0) break;

      for (const commit of commits) {
        allCommits.push({
          hash: commit.sha,
          authorName: commit.commit.author.name,
          authorEmail: commit.commit.author.email,
          date: new Date(commit.commit.author.date),
          message: commit.commit.message,
          branch: repo.defaultBranch,
        });
      }

      if (commits.length < perPage) break;
      page++;
    }

    return allCommits;
  }

  private async fetchBitbucketCommitsSince(
    authHeader: string,
    repo: Repository,
    since: Date,
    onProgress?: FetchProgressCallback
  ): Promise<CommitData[]> {
    const allCommits: CommitData[] = [];
    const normalizedBranch = this.normalizeBitbucketBranchName(repo.defaultBranch);
    let nextUrl: string | null = this.buildBitbucketCommitsUrl(repo, normalizedBranch);
    let usedDefaultBranchFallback = false;
    let page = 1;

    type BitbucketCommitResponse = {
      values: Array<{
        hash: string;
        author: { user?: { display_name: string; email: string }; raw: string };
        date: string;
        message: string;
      }>;
      next?: string;
    };

    while (nextUrl) {
      onProgress?.({ currentPage: page, commitsSoFar: allCommits.length });
      const response: Response = await fetchWithRetry(
        nextUrl,
        {
          headers: {
            Authorization: authHeader,
            Accept: 'application/json',
          },
        },
        onProgress
      );

      if (!response.ok) {
        if (
          !usedDefaultBranchFallback &&
          (response.status === 400 || response.status === 404 || response.status === 409)
        ) {
          nextUrl = this.buildBitbucketCommitsUrl(repo);
          usedDefaultBranchFallback = true;
          page = 1;
          continue;
        }
        throw new Error(`Failed to fetch commits: ${response.statusText}`);
      }

      const data = (await response.json()) as BitbucketCommitResponse;

      if (
        !usedDefaultBranchFallback &&
        page === 1 &&
        data.values.length === 0 &&
        normalizedBranch
      ) {
        nextUrl = this.buildBitbucketCommitsUrl(repo);
        usedDefaultBranchFallback = true;
        continue;
      }

      let foundOlder = false;

      for (const commit of data.values) {
        const commitDate = new Date(commit.date);
        if (commitDate <= since) {
          foundOlder = true;
          break;
        }

        allCommits.push({
          hash: commit.hash,
          authorName:
            commit.author.user?.display_name ||
            commit.author.raw?.split('<')[0].trim() ||
            'Unknown',
          authorEmail: commit.author.user?.email || commit.author.raw?.match(/<(.+)>/)?.[1] || '',
          date: commitDate,
          message: commit.message,
          branch: repo.defaultBranch,
        });
      }

      if (foundOlder) break;
      nextUrl = data.next || null;
      page++;
    }

    return allCommits;
  }

  /**
   * Reads a cloud repository's releases: tags reachable from the release
   * branch, with the commits between each tag and the one before it. Tags
   * already in `known` (same name and commit) are skipped so repeat syncs stay
   * cheap. `branches` are tried in order and the first that exists is used.
   */
  async fetchReleases(
    repo: Repository,
    known: Map<string, string> = new Map(),
    branches: string[] = releaseBranchCandidates(DEFAULT_RELEASE_BRANCH_MODE),
    onProgress?: FetchProgressCallback
  ): Promise<ReleaseData[]> {
    const provider = repo.provider as SCMProvider;
    if (provider !== 'github' && provider !== 'bitbucket') {
      throw new Error('Local repositories should be handled by LocalGitService');
    }
    const authHeader = await this.authService.getAuthHeader(provider);
    if (!authHeader) {
      throw new Error(`Not authenticated with ${provider}`);
    }

    const source: ReleaseSource =
      provider === 'github'
        ? new GitHubReleaseSource(authHeader, repo, onProgress)
        : new BitbucketReleaseSource(authHeader, repo, onProgress);

    const branch = await source.resolveBranch(branches);
    if (!branch) return [];

    const allTags = (await source.listTags()).sort(
      (a, b) => b.releasedAt.getTime() - a.releasedAt.getTime()
    );
    const inWindow = allTags.filter((tag) => isWithinLookback(tag));
    const isNew = (tag: RawReleaseTag) => known.get(tag.tag) !== tag.sha;
    if (!inWindow.some(isNew)) return [];

    // Walk newest to oldest keeping tags that are on the release branch. Known tags were
    // reachable when stored, so only new ones cost an API call. Past the
    // window, keep going until one reachable tag is found: it bounds the
    // oldest in-window release.
    const reachable: RawReleaseTag[] = [];
    for (const tag of inWindow) {
      if (!isNew(tag) || (await source.isOnBranch(tag.sha, branch))) reachable.push(tag);
    }
    for (const tag of allTags.filter((t) => !isWithinLookback(t)).slice(0, 5)) {
      if (await source.isOnBranch(tag.sha, branch)) {
        reachable.push(tag);
        break;
      }
    }

    const releases: ReleaseData[] = [];
    for (const ordered of orderReleaseTags(reachable)) {
      if (!isWithinLookback(ordered) || !isNew(ordered)) continue;
      const commits = await source.listCommits(ordered.sha, ordered.previous?.sha);
      releases.push({
        tag: ordered.tag,
        sha: ordered.sha,
        releasedAt: ordered.releasedAt,
        dateSource: ordered.dateSource,
        previousTag: ordered.previous?.tag,
        commits,
      });
    }
    return releases;
  }
}

interface ReleaseSource {
  listTags(): Promise<RawReleaseTag[]>;
  /** The first of `candidates` that exists as a branch, or null. */
  resolveBranch(candidates: string[]): Promise<string | null>;
  /** True when the commit is an ancestor of (or equal to) the branch. */
  isOnBranch(sha: string, branch: string): Promise<boolean>;
  /** Commits reachable from `sha` but not from `previousSha` (capped). */
  listCommits(sha: string, previousSha?: string): Promise<ReleaseCommit[]>;
}

class GitHubReleaseSource implements ReleaseSource {
  private readonly base: string;
  private readonly owner: string;
  private readonly name: string;

  constructor(
    private readonly authHeader: string,
    repo: Repository,
    private readonly onProgress?: FetchProgressCallback
  ) {
    this.base = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
    this.owner = repo.owner;
    this.name = repo.name;
  }

  private async get<T>(url: string): Promise<{ status: number; data: T | null }> {
    const response = await fetchWithRetry(
      url,
      { headers: { Authorization: this.authHeader, Accept: 'application/vnd.github.v3+json' } },
      this.onProgress
    );
    if (response.status === 404 || response.status === 409 || response.status === 422) {
      return { status: response.status, data: null };
    }
    if (!response.ok) {
      throw new Error(`GitHub request failed (${response.status}): ${response.statusText}`);
    }
    return { status: response.status, data: (await response.json()) as T };
  }

  async listTags(): Promise<RawReleaseTag[]> {
    type TagNode = {
      name: string;
      target: {
        oid: string;
        committedDate?: string;
        tagger?: { date?: string };
        target?: { oid: string; committedDate?: string };
      } | null;
    };
    type GraphQLResponse = {
      data?: {
        repository: {
          refs: { nodes: TagNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
        } | null;
      };
      errors?: Array<{ message: string }>;
    };
    const query = `query($owner: String!, $name: String!, $cursor: String) {
      repository(owner: $owner, name: $name) {
        refs(refPrefix: "refs/tags/", first: 100, after: $cursor,
             orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) {
          pageInfo { hasNextPage endCursor }
          nodes {
            name
            target {
              oid
              ... on Commit { committedDate }
              ... on Tag { tagger { date } target { oid ... on Commit { committedDate } } }
            }
          }
        }
      }
    }`;

    const tags: RawReleaseTag[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_TAG_PAGES; page++) {
      const response = await fetchWithRetry(
        'https://api.github.com/graphql',
        {
          method: 'POST',
          headers: { Authorization: this.authHeader, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, variables: { owner: this.owner, name: this.name, cursor } }),
        },
        this.onProgress
      );
      if (!response.ok) {
        throw new Error(`Failed to list tags: ${response.statusText}`);
      }
      const body = (await response.json()) as GraphQLResponse;
      if (body.errors?.length) {
        throw new Error(`Failed to list tags: ${body.errors[0].message}`);
      }
      const refs = body.data?.repository?.refs;
      if (!refs) break;
      for (const node of refs.nodes) {
        const target = node.target;
        if (!target) continue;
        const annotated = target.tagger?.date;
        const sha = target.target?.oid ?? target.oid;
        const committed = target.committedDate ?? target.target?.committedDate;
        const dateStr = annotated || committed;
        const releasedAt = dateStr ? new Date(dateStr) : null;
        if (!releasedAt || isNaN(releasedAt.getTime())) continue;
        tags.push({ tag: node.name, sha, releasedAt, dateSource: annotated ? 'tag' : 'commit' });
      }
      if (!refs.pageInfo.hasNextPage) break;
      cursor = refs.pageInfo.endCursor;
    }
    return tags;
  }

  async resolveBranch(candidates: string[]): Promise<string | null> {
    for (const name of candidates) {
      const { data } = await this.get<unknown>(`${this.base}/branches/${encodeURIComponent(name)}`);
      if (data) return name;
    }
    return null;
  }

  async isOnBranch(sha: string, branch: string): Promise<boolean> {
    const { data } = await this.get<{ status: string }>(
      `${this.base}/compare/${encodeURIComponent(sha)}...${encodeURIComponent(branch)}?per_page=1`
    );
    return data?.status === 'ahead' || data?.status === 'identical';
  }

  async listCommits(sha: string, previousSha?: string): Promise<ReleaseCommit[]> {
    type GitHubCommit = {
      sha: string;
      commit: { author: { name: string; email: string; date: string }; message: string };
      parents: unknown[];
    };
    const commits: ReleaseCommit[] = [];
    const cap = previousSha ? MAX_RELEASE_COMMITS : FIRST_RELEASE_COMMIT_CAP;
    for (let page = 1; commits.length < cap; page++) {
      const url = previousSha
        ? `${this.base}/compare/${encodeURIComponent(previousSha)}...${encodeURIComponent(sha)}?per_page=100&page=${page}`
        : `${this.base}/commits?sha=${encodeURIComponent(sha)}&per_page=100&page=${page}`;
      const { data } = await this.get<{ commits: GitHubCommit[] } | GitHubCommit[]>(url);
      if (!data) break;
      const items = Array.isArray(data) ? data : data.commits;
      for (const item of items) {
        commits.push({
          hash: item.sha,
          authorName: item.commit.author.name,
          authorEmail: item.commit.author.email,
          date: new Date(item.commit.author.date),
          message: item.commit.message,
          isMerge: item.parents.length > 1,
        });
      }
      if (items.length < 100) break;
    }
    return commits.slice(0, cap);
  }
}

class BitbucketReleaseSource implements ReleaseSource {
  private readonly base: string;

  constructor(
    private readonly authHeader: string,
    repo: Repository,
    private readonly onProgress?: FetchProgressCallback
  ) {
    this.base = `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  }

  private async get<T>(url: string): Promise<T | null> {
    const response = await fetchWithRetry(
      url,
      { headers: { Authorization: this.authHeader, Accept: 'application/json' } },
      this.onProgress
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Bitbucket request failed (${response.status}): ${response.statusText}`);
    }
    return (await response.json()) as T;
  }

  async listTags(): Promise<RawReleaseTag[]> {
    type BitbucketTag = {
      name: string;
      date?: string | null; // tagger date, only for annotated tags
      target: { hash: string; date?: string };
    };
    type Page = { values: BitbucketTag[]; next?: string };
    const tags: RawReleaseTag[] = [];
    let url: string | null = `${this.base}/refs/tags?sort=-target.date&pagelen=100`;
    for (let page = 0; url && page < MAX_TAG_PAGES; page++) {
      const data: Page | null = await this.get<Page>(url);
      if (!data) break;
      for (const value of data.values) {
        const dateStr = value.date || value.target.date;
        const releasedAt = dateStr ? new Date(dateStr) : null;
        if (!releasedAt || isNaN(releasedAt.getTime())) continue;
        tags.push({
          tag: value.name,
          sha: value.target.hash,
          releasedAt,
          dateSource: value.date ? 'tag' : 'commit',
        });
      }
      url = data.next ?? null;
    }
    return tags;
  }

  async resolveBranch(candidates: string[]): Promise<string | null> {
    for (const name of candidates) {
      const data = await this.get<unknown>(`${this.base}/refs/branches/${encodeURIComponent(name)}`);
      if (data) return name;
    }
    return null;
  }

  async isOnBranch(sha: string, branch: string): Promise<boolean> {
    type Page = { values: unknown[] };
    const data = await this.get<Page>(
      `${this.base}/commits?include=${encodeURIComponent(sha)}&exclude=${encodeURIComponent(branch)}&pagelen=1`
    );
    // An empty result means every commit of the tag is already on the branch.
    return data !== null && data.values.length === 0;
  }

  async listCommits(sha: string, previousSha?: string): Promise<ReleaseCommit[]> {
    type BitbucketCommit = {
      hash: string;
      author: { user?: { display_name: string; email?: string }; raw?: string };
      date: string;
      message: string;
      parents: unknown[];
    };
    type Page = { values: BitbucketCommit[]; next?: string };
    const cap = previousSha ? MAX_RELEASE_COMMITS : FIRST_RELEASE_COMMIT_CAP;
    const commits: ReleaseCommit[] = [];
    let url: string | null =
      `${this.base}/commits?include=${encodeURIComponent(sha)}` +
      (previousSha ? `&exclude=${encodeURIComponent(previousSha)}` : '') +
      '&pagelen=100';
    while (url && commits.length < cap) {
      const data: Page | null = await this.get<Page>(url);
      if (!data) break;
      for (const item of data.values) {
        commits.push({
          hash: item.hash,
          authorName:
            item.author.user?.display_name || item.author.raw?.split('<')[0].trim() || 'Unknown',
          authorEmail: item.author.user?.email || item.author.raw?.match(/<(.+)>/)?.[1] || '',
          date: new Date(item.date),
          message: item.message,
          isMerge: item.parents.length > 1,
        });
      }
      url = data.next ?? null;
    }
    return commits.slice(0, cap);
  }
}
