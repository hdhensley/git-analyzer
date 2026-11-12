import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { ChartWidgetProps } from './types';
import type {
  SnykRepoIssueCounts,
  SnykHealthResult,
  SnykRepoProjectInfo,
  BranchDivergence,
  AwsProfile,
  RepoActivity,
  PipelineAuditEntry,
  PipelineAuditResult,
} from '../../../shared/types';
import { useElectronAPI } from '../../hooks';
import { loadSpaceSetting, saveSpaceSetting } from '../../utils/spaceSettings';
import './RepoHealthWidget.css';

interface RepoHealth {
  repoId: string;
  repoName: string;
  parentFolder?: string;
  provider: string;
  totalCommits: number;
  lastCommitDate: Date | null; // null when the repo has no commits in the current filter
  daysSinceLastCommit: number | null;
  defaultBranch: string;
  uniqueContributors: number;
  commitsPerWeek: number;
}

type SortKey =
  | 'repoName'
  | 'totalCommits'
  | 'daysSinceLastCommit'
  | 'commitsPerWeek'
  | 'defaultBranch'
  | 'uniqueContributors'
  | 'critical'
  | 'high'
  | 'pipeline'
  | 'deployed'
  | 'snykOrg';

type SortDir = 'asc' | 'desc';

// Repository column resizing. Width is persisted so it survives reloads.
const REPO_COL_STORAGE_KEY = 'repoHealth.repoColumnWidth';
const REPO_COL_DEFAULT = 260;
const REPO_COL_MIN = 160;
const REPO_COL_MAX = 800;
const REPO_COL_KEY_STEP = 16;
// Minimum width of each non-repository column, gap, and row padding; used to
// compute a row min-width so the table scrolls horizontally instead of
// squashing the other columns when the repository column is widened.
const OTHER_COL_MIN = 72;
const COL_GAP = 8;
const ROW_PADDING_X = 24;

const AWS_PROFILE_SETTING_KEY = 'awsProfile';
const LEGACY_AWS_PROFILE_STORAGE_KEY = 'repoHealth.awsProfile';

// Higher rank = bigger problem; used for sorting, the "problems only" filter,
// and picking the worst entry when a repo has several pipeline stacks.
const PIPELINE_RANK: Record<PipelineAuditEntry['snykStatus'], number> = {
  none: 3,
  partial: 2,
  ok: 0,
  nopipe: -1,
};
const DEPLOY_RANK: Record<PipelineAuditEntry['deployStatus'], number> = {
  'out-of-sync': 4,
  'not-deployed': 3,
  error: 2,
  unknown: 1,
  'in-sync': 0,
  'no-env': -1,
  'not-checked': -1,
};
const PIPELINE_LABEL: Record<PipelineAuditEntry['snykStatus'], string> = {
  ok: 'OK',
  partial: 'Partial',
  none: 'No Snyk',
  nopipe: '—',
};
const DEPLOY_LABEL: Record<PipelineAuditEntry['deployStatus'], string> = {
  'in-sync': 'In sync',
  'out-of-sync': 'Out of sync',
  'not-deployed': 'Not deployed',
  'no-env': 'n/a',
  unknown: 'Unknown',
  error: 'Error',
  'not-checked': '—',
};

const isPipelineProblem = (e: PipelineAuditEntry) => PIPELINE_RANK[e.snykStatus] > 0;
const isDeployProblem = (e: PipelineAuditEntry) => DEPLOY_RANK[e.deployStatus] > 0;

const clampRepoWidth = (w: number) => Math.min(REPO_COL_MAX, Math.max(REPO_COL_MIN, Math.round(w)));

function readStoredRepoWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(REPO_COL_STORAGE_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? clampRepoWidth(n) : null;
  } catch {
    return null;
  }
}

export function RepoHealthWidget({ commits, repositories, authorGrouping }: ChartWidgetProps) {
  // `commits` is the date-filtered set used by other widgets; it is only used
  // here as a signal that data changed (e.g. after a sync) so activity reloads.
  const groupByName = authorGrouping === 'name';
  const api = useElectronAPI();

  // Table sorting. Defaults to staleness ascending (most recently active first),
  // matching the widget's original ordering.
  const [sortKey, setSortKey] = useState<SortKey>('daysSinceLastCommit');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      // Text column defaults to A→Z; numeric columns default to high→low, which
      // is the more useful first glance for counts and velocity.
      setSortDir(key === 'repoName' || key === 'defaultBranch' || key === 'snykOrg' ? 'asc' : 'desc');
    }
  };

  // Repository column width in px; null means the default flexible width.
  const [repoColWidth, setRepoColWidth] = useState<number | null>(() => readStoredRepoWidth());
  const repoHeaderRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    try {
      if (repoColWidth === null) window.localStorage.removeItem(REPO_COL_STORAGE_KEY);
      else window.localStorage.setItem(REPO_COL_STORAGE_KEY, String(repoColWidth));
    } catch {
      // Storage unavailable; width just won't persist.
    }
  }, [repoColWidth]);

  const currentRepoWidth = () =>
    repoColWidth ?? repoHeaderRef.current?.getBoundingClientRect().width ?? REPO_COL_DEFAULT;

  const onResizePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startWidth: currentRepoWidth() };
  };

  const onResizePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setRepoColWidth(clampRepoWidth(drag.startWidth + (e.clientX - drag.startX)));
  };

  const onResizePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const onResizeKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const delta = e.key === 'ArrowRight' ? REPO_COL_KEY_STEP : -REPO_COL_KEY_STEP;
      setRepoColWidth(clampRepoWidth(currentRepoWidth() + delta));
    } else if (e.key === 'Home' || e.key === 'Escape') {
      e.preventDefault();
      setRepoColWidth(null);
    }
  };

  const [snykConnected, setSnykConnected] = useState(false);
  const [snykCounts, setSnykCounts] = useState<Record<string, SnykRepoIssueCounts>>({});
  const [snykLoading, setSnykLoading] = useState(false);
  const [snykError, setSnykError] = useState<string | null>(null);
  const [snykProjects, setSnykProjects] = useState<Record<string, SnykRepoProjectInfo>>({});
  const [snykDiag, setSnykDiag] = useState<SnykHealthResult['diagnostics'] | null>(null);
  const [snykFetchedAt, setSnykFetchedAt] = useState<string | null>(null);
  const [snykFromCache, setSnykFromCache] = useState(false);

  // Loads Snyk counts. `force` kicks off a live refresh even when the cached
  // copy is still within its TTL window (the manual override).
  const loadSnyk = useCallback(
    async (force: boolean) => {
      if (!api) return;
      try {
        const status = await api.snyk.getStatus();
        setSnykConnected(status.connected);
        if (!status.connected) {
          setSnykCounts({});
          return;
        }
        setSnykLoading(true);
        setSnykError(null);
        const health = await api.snyk.getHealth(force ? { force: true } : undefined);
        setSnykCounts(health.countsByRepoName);
        setSnykProjects(health.projectsByRepoName ?? {});
        setSnykDiag(health.diagnostics ?? null);
        setSnykFetchedAt(health.fetchedAt);
        setSnykFromCache(health.cached === true);
      } catch (err) {
        setSnykError(err instanceof Error ? err.message : 'Failed to load Snyk data');
      } finally {
        setSnykLoading(false);
      }
    },
    [api]
  );

  // On mount, load counts (served from cache when fresh, so no re-crawl on
  // every page load).
  useEffect(() => {
    loadSnyk(false);
  }, [loadSnyk]);

  // Pipeline audit: static check of the CDK pipeline stack (Snyk completeness)
  // runs automatically for local repos; the deployed-state comparison needs an
  // AWS profile and is run on demand.
  const [awsProfiles, setAwsProfiles] = useState<AwsProfile[]>([]);
  const [awsProfile, setAwsProfile] = useState<string>('');
  // The selection is stored per space; don't write back before it has loaded.
  const [awsProfileLoaded, setAwsProfileLoaded] = useState(false);
  const [audit, setAudit] = useState<PipelineAuditResult | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [onlyProblems, setOnlyProblems] = useState(false);

  const localRepoIdsKey = useMemo(
    () =>
      repositories
        .filter((r) => r.provider === 'local')
        .map((r) => r.id)
        .sort()
        .join('|'),
    [repositories]
  );

  const runAudit = useCallback(
    async (profile: string) => {
      if (!api || !localRepoIdsKey) return;
      try {
        setAuditLoading(true);
        setAuditError(null);
        const result = await api.pipelineAudit.run({
          repoIds: localRepoIdsKey.split('|'),
          profile: profile || undefined,
        });
        setAudit(result);
      } catch (err) {
        setAuditError(err instanceof Error ? err.message : 'Pipeline audit failed');
      } finally {
        setAuditLoading(false);
      }
    },
    [api, localRepoIdsKey]
  );

  useEffect(() => {
    if (!api?.pipelineAudit) return;
    api.pipelineAudit
      .listProfiles()
      .then(setAwsProfiles)
      .catch(() => setAwsProfiles([]));
  }, [api]);

  // Source-only audit on mount / when the local repo set changes.
  useEffect(() => {
    if (api?.pipelineAudit) runAudit('');
  }, [api, runAudit]);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    loadSpaceSetting(api, AWS_PROFILE_SETTING_KEY, LEGACY_AWS_PROFILE_STORAGE_KEY).then((v) => {
      if (cancelled) return;
      setAwsProfile(v ?? '');
      setAwsProfileLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (!api || !awsProfileLoaded) return;
    saveSpaceSetting(api, AWS_PROFILE_SETTING_KEY, awsProfile || null);
  }, [api, awsProfile, awsProfileLoaded]);

  // Worst pipeline entry per repo (a repo can have several pipeline stacks).
  const pipelineByRepo = useMemo(() => {
    const map = new Map<string, { worst: PipelineAuditEntry; all: PipelineAuditEntry[] }>();
    for (const e of audit?.entries ?? []) {
      const cur = map.get(e.repoId);
      if (!cur) {
        map.set(e.repoId, { worst: e, all: [e] });
        continue;
      }
      cur.all.push(e);
      const score = (x: PipelineAuditEntry) =>
        Math.max(PIPELINE_RANK[x.snykStatus], DEPLOY_RANK[x.deployStatus]);
      if (score(e) > score(cur.worst)) cur.worst = e;
    }
    return map;
  }, [audit]);

  // Any CDK pipeline stack found in the selected local repos.
  const hasPipelines = useMemo(
    () => (audit?.entries ?? []).some((e) => e.snykStatus !== 'nopipe'),
    [audit]
  );
  // The Snyk pipeline column is a Snyk feature: hide it when Snyk isn't connected.
  const showPipelineCol = hasPipelines && snykConnected;
  // The deployed-state check is about AWS, not Snyk, so it doesn't need Snyk.
  const showDeployCol = hasPipelines && Boolean(audit?.profile) && !audit?.credentialsError;

  const pipelineSummary = useMemo(() => {
    let snykProblems = 0;
    let deployProblems = 0;
    for (const { all } of pipelineByRepo.values()) {
      if (snykConnected && all.some(isPipelineProblem)) snykProblems++;
      if (all.some(isDeployProblem)) deployProblems++;
    }
    return { snykProblems, deployProblems };
  }, [pipelineByRepo, snykConnected]);

  // Repo id -> default branch / provider, sourced from repository metadata.
  const defaultBranchById = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of repositories) {
      map.set(r.id, r.defaultBranch);
    }
    return map;
  }, [repositories]);

  const providerById = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of repositories) {
      map.set(r.id, r.provider);
    }
    return map;
  }, [repositories]);

  // Branch divergence (develop vs main) per local repo. Keyed by repo id;
  // value is the divergence or null when it couldn't be computed.
  const [divergence, setDivergence] = useState<Record<string, BranchDivergence | null>>({});

  // All-time per-repo activity, fetched independently of the date range.
  const [activity, setActivity] = useState<RepoActivity[]>([]);
  const repoIdsKey = useMemo(() => repositories.map((r) => r.id).sort().join('|'), [repositories]);
  useEffect(() => {
    if (!api?.commits?.getRepoActivity || !repoIdsKey) {
      setActivity([]);
      return;
    }
    let cancelled = false;
    api.commits
      .getRepoActivity(repoIdsKey.split('|'))
      .then((rows) => {
        if (!cancelled) setActivity(rows);
      })
      .catch(() => {
        if (!cancelled) setActivity([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api, repoIdsKey, commits]);

  const repos = useMemo<RepoHealth[]>(() => {
    const now = new Date();
    const activityById = new Map(activity.map((a) => [a.repositoryId, a]));

    // One row per selected repository. Activity is all-time (not date-filtered)
    // so staleness and velocity describe the repository as it stands today.
    return repositories.map((repo): RepoHealth => {
      const a = activityById.get(repo.id);
      const base = {
        repoId: repo.id,
        repoName: repo.name,
        parentFolder: repo.parentFolder,
        provider: providerById.get(repo.id) ?? 'unknown',
        totalCommits: a?.totalCommits ?? 0,
        defaultBranch: defaultBranchById.get(repo.id) ?? '—',
        uniqueContributors: a ? (groupByName ? a.uniqueAuthorNames : a.uniqueAuthorEmails) : 0,
      };
      if (!a || !a.lastCommitDate || !a.firstCommitDate) {
        return { ...base, lastCommitDate: null, daysSinceLastCommit: null, commitsPerWeek: 0 };
      }
      const last = new Date(a.lastCommitDate);
      const first = new Date(a.firstCommitDate);
      const weeks = Math.max(1, (last.getTime() - first.getTime()) / (7 * 86400000));
      return {
        ...base,
        lastCommitDate: last,
        daysSinceLastCommit: Math.floor((now.getTime() - last.getTime()) / 86400000),
        commitsPerWeek: Math.round((a.totalCommits / weeks) * 10) / 10,
      };
    });
  }, [activity, repositories, groupByName, defaultBranchById, providerById]);

  // Fetch develop-vs-main divergence for local repos only. Cloud repos are not
  // supported yet (no stored per-branch graph).
  useEffect(() => {
    if (!api) return;
    const localRepoIds = repos.filter((r) => r.provider === 'local').map((r) => r.repoId);
    if (localRepoIds.length === 0) return;
    let cancelled = false;

    (async () => {
      const results = await Promise.all(
        localRepoIds.map(async (id) => {
          try {
            return [id, await api.localRepositories.branchDivergence(id)] as const;
          } catch {
            return [id, null] as const;
          }
        })
      );
      if (cancelled) return;
      setDivergence((prev) => {
        const next = { ...prev };
        for (const [id, d] of results) next[id] = d;
        return next;
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [api, repos]);

  const lookupProject = useCallback(
    (repoName: string): SnykRepoProjectInfo | undefined =>
      snykProjects[repoName.trim().toLowerCase()],
    [snykProjects]
  );

  const lookupSnyk = useCallback(
    (repoName: string): SnykRepoIssueCounts | undefined =>
      snykCounts[repoName.trim().toLowerCase()],
    [snykCounts]
  );

  const sortedRepos = useMemo<RepoHealth[]>(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    const value = (r: RepoHealth): string | number => {
      switch (sortKey) {
        case 'repoName':
          return `${r.parentFolder ? `${r.parentFolder}/` : ''}${r.repoName}`.toLowerCase();
        case 'defaultBranch':
          return r.defaultBranch.toLowerCase();
        case 'daysSinceLastCommit':
          return r.daysSinceLastCommit ?? Number.MAX_SAFE_INTEGER;
        case 'snykOrg': {
          const o = lookupProject(r.repoName)?.orgs[0];
          return (o?.slug ?? o?.name ?? '~').toLowerCase();
        }
        case 'critical':
          return lookupSnyk(r.repoName)?.critical ?? 0;
        case 'high':
          return lookupSnyk(r.repoName)?.high ?? 0;
        case 'pipeline':
          return pipelineByRepo.get(r.repoId)
            ? Math.max(...pipelineByRepo.get(r.repoId)!.all.map((e) => PIPELINE_RANK[e.snykStatus]))
            : -2;
        case 'deployed':
          return pipelineByRepo.get(r.repoId)
            ? Math.max(...pipelineByRepo.get(r.repoId)!.all.map((e) => DEPLOY_RANK[e.deployStatus]))
            : -2;
        default:
          return r[sortKey];
      }
    };
    return [...repos].sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      if (typeof av === 'string' && typeof bv === 'string') {
        return av.localeCompare(bv) * dir;
      }
      return ((av as number) - (bv as number)) * dir;
    });
  }, [repos, sortKey, sortDir, lookupSnyk, lookupProject, pipelineByRepo]);

  const visibleRepos = useMemo<RepoHealth[]>(() => {
    if (!onlyProblems || !audit) return sortedRepos;
    return sortedRepos.filter((r) => {
      const p = pipelineByRepo.get(r.repoId);
      return p ? p.all.some((e) => (snykConnected && isPipelineProblem(e)) || isDeployProblem(e)) : false;
    });
  }, [sortedRepos, onlyProblems, audit, pipelineByRepo, snykConnected]);

  if (repositories.length === 0) {
    return <div className="repo-health repo-health--empty">No repositories selected</div>;
  }

  const stalenessClass = (days: number | null) => days === null ? 'repo-health__staleness--none' : days <= 7 ? 'repo-health__staleness--fresh' : days <= 30 ? 'repo-health__staleness--recent' : days <= 90 ? 'repo-health__staleness--stale' : 'repo-health__staleness--dead';

  const sortArrow = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

  const gridClass = snykConnected ? 'repo-health__table repo-health__table--snyk' : 'repo-health__table';

  // Column template is built here so the Snyk Org column can be wider than the
  // numeric ones, and the repository column can be resized.
  const repoColMin = repoColWidth ?? REPO_COL_DEFAULT;
  const orgColMin = 190;
  const wideExtra = 16;
  const colTracks = [
    ...Array(6).fill(`minmax(${OTHER_COL_MIN}px, 1fr)`),
    ...(showPipelineCol ? [`minmax(${OTHER_COL_MIN + wideExtra}px, 1fr)`] : []),
    ...(showDeployCol ? [`minmax(${OTHER_COL_MIN + wideExtra}px, 1fr)`] : []),
    ...(snykConnected
      ? [`minmax(${orgColMin}px, 2.5fr)`, `minmax(${OTHER_COL_MIN}px, 1fr)`, `minmax(${OTHER_COL_MIN}px, 1fr)`]
      : []),
  ];
  const otherColCount = colTracks.length;
  const otherMin =
    6 * OTHER_COL_MIN +
    (showPipelineCol ? OTHER_COL_MIN + wideExtra : 0) +
    (showDeployCol ? OTHER_COL_MIN + wideExtra : 0) +
    (snykConnected ? orgColMin + 2 * OTHER_COL_MIN : 0);
  const tableStyle = {
    '--repo-col': repoColWidth !== null ? `${repoColWidth}px` : `minmax(${REPO_COL_DEFAULT}px, 3fr)`,
    '--other-cols': colTracks.join(' '),
    '--row-min-width': `${repoColMin + otherMin + otherColCount * COL_GAP + ROW_PADDING_X}px`,
  } as CSSProperties;

  const formatAge = (iso: string): string => {
    const diffMs = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  };

  return (
    <div className="repo-health">
      <div className="repo-health__sources">
        <section className="repo-health__source" aria-labelledby="rh-src-snyk">
          <h4 id="rh-src-snyk" className="repo-health__source-title">
            Security · Snyk
          </h4>
          <p className="repo-health__source-desc">
            Critical and high open issues per repository (Critical / High columns).
          </p>
          {snykConnected ? (
            <>
              <p className="repo-health__source-status">
                {snykLoading ? (
                  'Fetching issue counts from Snyk…'
                ) : snykError ? (
                  <span className="repo-health__snyk-error-text">Snyk: {snykError}</span>
                ) : snykDiag ? (
                  <>
                    {snykDiag.criticalHighIssues} critical/high across{' '}
                    {Object.keys(snykCounts).length} repos
                    {snykFetchedAt && (
                      <>
                        {' · '}updated {formatAge(snykFetchedAt)}
                        {snykFromCache ? ' (cached)' : ''}
                      </>
                    )}
                  </>
                ) : (
                  'Connected'
                )}
              </p>
              <div className="repo-health__source-actions">
                <button
                  type="button"
                  className="repo-health__action"
                  onClick={() => loadSnyk(true)}
                  disabled={snykLoading}
                  title="Counts are cached for 6 hours. This fetches fresh data from Snyk now."
                >
                  {snykLoading ? '↻ Refreshing…' : '↻ Refresh from Snyk'}
                </button>
              </div>
            </>
          ) : (
            <p className="repo-health__source-hint">
              <strong>Not connected.</strong> Connect Snyk from the Connect section of the
              dashboard to see which repositories carry the most critical and high issues, so you
              can prioritise fixes without leaving this view.
            </p>
          )}
        </section>

        <section className="repo-health__source" aria-labelledby="rh-src-pipe">
          <h4 id="rh-src-pipe" className="repo-health__source-title">
            Pipelines · CDK + AWS
          </h4>
          <p className="repo-health__source-desc">
            {snykConnected
              ? 'Checks each local repo\u2019s CodePipeline stack for complete Snyk scanning (monitor, dependency test, code scan) and, optionally, that AWS is running that same pipeline.'
              : 'Finds each local repo\u2019s CodePipeline stack and, optionally, checks that AWS is running that same pipeline. Connect Snyk to also audit the Snyk scanning in each pipeline.'}
          </p>
          {!api?.pipelineAudit || !localRepoIdsKey ? (
            <p className="repo-health__source-hint">
              <strong>No local repositories.</strong> Import repositories from a local folder so
              their pipeline stacks can be read. Cloud-only repositories are not checked.
            </p>
          ) : (
            <>
              <p className="repo-health__source-status">
                {auditLoading ? (
                  awsProfile ? 'Checking source and AWS…' : 'Scanning pipeline stacks…'
                ) : auditError ? (
                  <span className="repo-health__snyk-error-text">{auditError}</span>
                ) : audit?.credentialsError ? (
                  <span className="repo-health__snyk-error-text">AWS: {audit.credentialsError}</span>
                ) : hasPipelines ? (
                  <>
                    {snykConnected && (
                      <>
                        <strong>{pipelineSummary.snykProblems}</strong> with incomplete Snyk
                      </>
                    )}
                    {snykConnected && showDeployCol && ' · '}
                    {showDeployCol && (
                      <>
                        <strong>{pipelineSummary.deployProblems}</strong> out of sync or not
                        deployed (account {audit?.accountId})
                      </>
                    )}
                    {!snykConnected && !showDeployCol && (
                      <>
                        <strong>
                          {[...pipelineByRepo.values()].filter((v) => v.all.some((e) => e.snykStatus !== 'nopipe')).length}
                        </strong>{' '}
                        with a pipeline stack
                      </>
                    )}
                  </>
                ) : (
                  'No CDK pipeline stacks found in local repositories'
                )}
              </p>
              <div className="repo-health__source-actions">
                <button
                  type="button"
                  className="repo-health__action"
                  onClick={() => runAudit(awsProfile)}
                  disabled={auditLoading}
                  title="Re-read the pipeline stacks from your local checkouts (and re-query AWS if a profile is selected)"
                >
                  {auditLoading ? '↻ Scanning…' : '↻ Rescan'}
                </button>
              </div>
              <div className="repo-health__aws">
                <label className="repo-health__aws-label" htmlFor="rh-aws-profile">
                  Compare with AWS (optional)
                </label>
                {awsProfiles.length > 0 ? (
                  <>
                    <select
                      id="rh-aws-profile"
                      className="repo-health__pipeline-select"
                      value={awsProfile}
                      onChange={(e) => setAwsProfile(e.target.value)}
                      disabled={auditLoading}
                    >
                      <option value="">Source only (no AWS)</option>
                      {awsProfiles.map((p) => (
                        <option key={p.name} value={p.name}>
                          {p.name}
                          {p.isSso ? ' (SSO)' : ''}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="repo-health__action"
                      onClick={() => runAudit(awsProfile)}
                      disabled={auditLoading || !awsProfile}
                      title="Look up each pipeline in the profile's account and compare it with the code"
                    >
                      Check deployed
                    </button>
                    <p className="repo-health__source-hint">
                      {awsProfile
                        ? 'Read-only. Finds pipelines that are stale, missing, or running an older Snyk scan than the code defines. Needs an active login (aws sso login --profile …).'
                        : 'Pick a profile to also verify the pipeline deployed in that account matches your code, which flags stale or undeployed pipelines.'}
                    </p>
                  </>
                ) : (
                  <p className="repo-health__source-hint">
                    <strong>No AWS profiles found</strong> in ~/.aws. Add one (for example{' '}
                    <code>aws configure sso</code>) to also check that each deployed pipeline
                    matches the code and is running the current Snyk scan.
                  </p>
                )}
              </div>
            </>
          )}
        </section>
      </div>
      {(showPipelineCol || showDeployCol) && (
        <div className="repo-health__toolbar">
          <label className="repo-health__pipeline-check">
            <input
              type="checkbox"
              checked={onlyProblems}
              onChange={(e) => setOnlyProblems(e.target.checked)}
            />
            Only show repositories with pipeline problems
          </label>
        </div>
      )}
      <div className={gridClass} style={tableStyle}>
        <div className="repo-health__header-row">
          <div className="repo-health__repo-header" ref={repoHeaderRef}>
            <button type="button" className="repo-health__sort" onClick={() => toggleSort('repoName')}>Repository{sortArrow('repoName')}</button>
            <div
              className="repo-health__col-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize repository column"
              aria-valuemin={REPO_COL_MIN}
              aria-valuemax={REPO_COL_MAX}
              aria-valuenow={Math.round(repoColWidth ?? REPO_COL_DEFAULT)}
              tabIndex={0}
              title="Drag to resize · double-click to reset"
              onPointerDown={onResizePointerDown}
              onPointerMove={onResizePointerMove}
              onPointerUp={onResizePointerUp}
              onPointerCancel={onResizePointerUp}
              onDoubleClick={() => setRepoColWidth(null)}
              onKeyDown={onResizeKeyDown}
            />
          </div>
          <button type="button" className="repo-health__sort" onClick={() => toggleSort('totalCommits')}>Commits{sortArrow('totalCommits')}</button>
          <button type="button" className="repo-health__sort" onClick={() => toggleSort('daysSinceLastCommit')}>Last Activity{sortArrow('daysSinceLastCommit')}</button>
          <button type="button" className="repo-health__sort" onClick={() => toggleSort('commitsPerWeek')}>Commits/wk{sortArrow('commitsPerWeek')}</button>
          <button type="button" className="repo-health__sort" onClick={() => toggleSort('defaultBranch')}>Default Branch{sortArrow('defaultBranch')}</button>
          <span title="develop ahead/behind main (local repositories only)">Dev vs Main</span>
          <button type="button" className="repo-health__sort" onClick={() => toggleSort('uniqueContributors')}>Contributors{sortArrow('uniqueContributors')}</button>
          {showPipelineCol && <button type="button" className="repo-health__sort" title="Snyk scanning completeness in the CDK pipeline stack (monitor, SCA, SAST)" onClick={() => toggleSort('pipeline')}>Pipeline Snyk{sortArrow('pipeline')}</button>}
          {showDeployCol && <button type="button" className="repo-health__sort" title="Is the deployed CodePipeline the one in code?" onClick={() => toggleSort('deployed')}>Deployed{sortArrow('deployed')}</button>}
          {snykConnected && <button type="button" className="repo-health__sort" title="Snyk organization(s) that hold this repository's projects, and how many projects" onClick={() => toggleSort('snykOrg')}>Snyk Org{sortArrow('snykOrg')}</button>}
          {snykConnected && <button type="button" className="repo-health__sort" title="Snyk critical open issues" onClick={() => toggleSort('critical')}>Critical{sortArrow('critical')}</button>}
          {snykConnected && <button type="button" className="repo-health__sort" title="Snyk high open issues" onClick={() => toggleSort('high')}>High{sortArrow('high')}</button>}
        </div>
        {visibleRepos.map(r => {
          const snyk = snykConnected ? lookupSnyk(r.repoName) : undefined;
          const pipe = pipelineByRepo.get(r.repoId);
          return (
            <div key={r.repoId} className="repo-health__row">
              <span
                className="repo-health__repo-name"
                title={`${r.parentFolder ? `${r.parentFolder}/` : ''}${r.repoName}`}
              >
                <span className="repo-health__repo-leaf">{r.repoName}</span>
                {r.parentFolder && <span className="repo-health__repo-parent">{r.parentFolder}</span>}
              </span>
              <span>{r.totalCommits}</span>
              <span className={`repo-health__staleness ${stalenessClass(r.daysSinceLastCommit)}`}>
                {r.daysSinceLastCommit === null ? 'No commits' : r.daysSinceLastCommit === 0 ? 'Today' : `${r.daysSinceLastCommit}d ago`}
              </span>
              <span>{r.commitsPerWeek}</span>
              <span
                className={`repo-health__branch ${
                  r.defaultBranch === 'main'
                    ? 'repo-health__branch--main'
                    : 'repo-health__branch--other'
                }`}
              >
                {r.defaultBranch}
              </span>
              <span className="repo-health__divergence">
                {r.provider !== 'local' ? (
                  <span className="repo-health__divergence-na" title="Cloud repositories are not supported yet">—</span>
                ) : divergence[r.repoId] === undefined ? (
                  <span className="repo-health__divergence-na">…</span>
                ) : divergence[r.repoId] === null ? (
                  <span className="repo-health__divergence-na" title="No develop branch found locally">n/a</span>
                ) : (
                  <span
                    className={
                      divergence[r.repoId]!.ahead > 0 || divergence[r.repoId]!.behind > 0
                        ? 'repo-health__divergence-diff'
                        : 'repo-health__divergence-sync'
                    }
                    title={`${divergence[r.repoId]!.compare} vs ${divergence[r.repoId]!.base}`}
                  >
                    +{divergence[r.repoId]!.ahead} / −{divergence[r.repoId]!.behind}
                  </span>
                )}
              </span>
              <span>{r.uniqueContributors}</span>
              {showPipelineCol && (
                <span
                  className={`repo-health__pipe repo-health__pipe--${pipe ? pipe.worst.snykStatus : 'nopipe'}`}
                  title={
                    pipe
                      ? pipe.all
                          .map(
                            (e) =>
                              `${e.stackFile ?? ''}${e.snykOrg ? ` (org ${e.snykOrg}, SCA ${e.scaGating})` : ''}\n` +
                              (e.snykIssues.length ? e.snykIssues.map((i) => `• ${i}`).join('\n') : 'Complete')
                          )
                          .join('\n\n')
                      : 'Not a local repository'
                  }
                >
                  {pipe ? PIPELINE_LABEL[pipe.worst.snykStatus] : '—'}
                </span>
              )}
              {showDeployCol && (
                <span
                  className={`repo-health__pipe repo-health__deploy--${pipe ? pipe.worst.deployStatus : 'not-checked'}`}
                  title={
                    pipe
                      ? pipe.all
                          .map((e) => {
                            const where = [e.pipelineName, e.envKey, e.region].filter(Boolean).join(' · ');
                            const detail = e.deployedError
                              ? e.deployedError
                              : e.deployedIssues.map((i) => `• ${i}`).join('\n');
                            return [where, detail].filter(Boolean).join('\n');
                          })
                          .join('\n\n')
                      : ''
                  }
                >
                  {pipe ? DEPLOY_LABEL[pipe.worst.deployStatus] : '—'}
                </span>
              )}
              {snykConnected && (() => {
                const proj = lookupProject(r.repoName);
                const labels = proj?.orgs.map((o) => o.slug ?? o.name ?? o.id) ?? [];
                const expected = pipe?.all.map((e) => e.snykOrg).filter(Boolean) as string[] | undefined;
                const mismatch =
                  !!proj && !!expected?.length && !expected.some((x) => labels.includes(x));
                return (
                  <span
                    className={`repo-health__snyk-org ${
                      !proj ? 'repo-health__snyk-org--none' : mismatch ? 'repo-health__snyk-org--mismatch' : ''
                    }`}
                    title={
                      !proj
                        ? 'No Snyk projects found for this repository'
                        : `${proj.projectCount} project${proj.projectCount === 1 ? '' : 's'} · ${
                            proj.origins.join(', ') || 'unknown origin'
                          }${mismatch ? `\nPipeline scans into "${expected!.join(', ')}" but projects are in "${labels.join(', ')}"` : ''}`
                    }
                  >
                    {proj ? `${labels.join(', ')} · ${proj.projectCount}` : 'Not in Snyk'}
                  </span>
                );
              })()}
              {snykConnected && (
                <span className={`repo-health__sev repo-health__sev--critical ${snyk && snyk.critical > 0 ? 'repo-health__sev--active' : ''}`}>
                  {snyk ? snyk.critical : 0}
                </span>
              )}
              {snykConnected && (
                <span className={`repo-health__sev repo-health__sev--high ${snyk && snyk.high > 0 ? 'repo-health__sev--active' : ''}`}>
                  {snyk ? snyk.high : 0}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <p className="repo-health__note">
        <strong>Commits, Last Activity, Commits/wk and Contributors</strong> cover each
        repository&apos;s full synced history and ignore the date range.{' '}
        <strong>Dev vs Main</strong> shows how far <code>develop</code> is ahead of / behind{' '}
        <code>main</code> (+ahead / −behind), for local repositories only. Cloud (GitHub/Bitbucket)
        comparison is not supported yet.
      </p>
    </div>
  );
}

export const RepoHealthWidgetDefinition = {
  id: 'repo-health',
  name: 'Repository Health',
  description: 'All-time activity, staleness, default branch, velocity, pipelines, and Snyk issue counts per repository',
  requiredFields: ['date'] as const,
  supportsDateFilter: false,
  supportsRepoFilter: true,
  component: RepoHealthWidget,
};
