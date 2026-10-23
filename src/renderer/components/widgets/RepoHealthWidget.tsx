import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChartWidgetProps } from './types';
import type { SnykRepoIssueCounts, SnykHealthResult, BranchDivergence } from '../../../shared/types';
import { useElectronAPI } from '../../hooks';
import './RepoHealthWidget.css';

interface RepoHealth {
  repoId: string;
  repoName: string;
  parentFolder?: string;
  provider: string;
  totalCommits: number;
  lastCommitDate: Date;
  daysSinceLastCommit: number;
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
  | 'high';

type SortDir = 'asc' | 'desc';

export function RepoHealthWidget({ commits, repositories, authorGrouping }: ChartWidgetProps) {
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
      setSortDir(key === 'repoName' || key === 'defaultBranch' ? 'asc' : 'desc');
    }
  };

  const [snykConnected, setSnykConnected] = useState(false);
  const [snykCounts, setSnykCounts] = useState<Record<string, SnykRepoIssueCounts>>({});
  const [snykLoading, setSnykLoading] = useState(false);
  const [snykError, setSnykError] = useState<string | null>(null);
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

  const repos = useMemo<RepoHealth[]>(() => {
    const now = new Date();
    const repoMap = new Map<string, { name: string; parentFolder?: string; dates: Date[]; authors: Set<string> }>();

    for (const c of commits) {
      if (!repoMap.has(c.repositoryId)) {
        repoMap.set(c.repositoryId, { name: c.repositoryName, parentFolder: c.repositoryParentFolder, dates: [], authors: new Set() });
      }
      const r = repoMap.get(c.repositoryId)!;
      r.dates.push(new Date(c.date));
      r.authors.add(groupByName ? c.authorName : c.authorEmail);
    }

    return Array.from(repoMap.entries()).map(([repoId, r]) => {
      const sorted = r.dates.sort((a, b) => b.getTime() - a.getTime());
      const lastCommit = sorted[0];
      const daysSince = Math.floor((now.getTime() - lastCommit.getTime()) / 86400000);
      const earliest = sorted[sorted.length - 1];
      const weeks = Math.max(1, (lastCommit.getTime() - earliest.getTime()) / (7 * 86400000));

      return {
        repoId, repoName: r.name, parentFolder: r.parentFolder,
        provider: providerById.get(repoId) ?? 'unknown',
        totalCommits: r.dates.length,
        lastCommitDate: lastCommit,
        daysSinceLastCommit: daysSince,
        defaultBranch: defaultBranchById.get(repoId) ?? '—',
        uniqueContributors: r.authors.size,
        commitsPerWeek: Math.round((r.dates.length / weeks) * 10) / 10,
      };
    });
  }, [commits, groupByName, defaultBranchById, providerById]);

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
        case 'critical':
          return lookupSnyk(r.repoName)?.critical ?? 0;
        case 'high':
          return lookupSnyk(r.repoName)?.high ?? 0;
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
  }, [repos, sortKey, sortDir, lookupSnyk]);

  if (commits.length === 0) {
    return <div className="repo-health repo-health--empty">No commits match the current filters</div>;
  }

  const stalenessClass = (days: number) => days <= 7 ? 'repo-health__staleness--fresh' : days <= 30 ? 'repo-health__staleness--recent' : days <= 90 ? 'repo-health__staleness--stale' : 'repo-health__staleness--dead';

  const sortArrow = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

  const gridClass = snykConnected ? 'repo-health__table repo-health__table--snyk' : 'repo-health__table';

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
      {snykConnected && (
        <div className="repo-health__snyk-bar">
          <span className="repo-health__snyk-meta">
            {snykLoading ? (
              'Refreshing Snyk issue counts…'
            ) : snykError ? (
              <span className="repo-health__snyk-error-text">Snyk: {snykError}</span>
            ) : snykDiag ? (
              <>
                Snyk: {snykDiag.criticalHighIssues} critical/high across{' '}
                {Object.keys(snykCounts).length} repos
                {snykFetchedAt && (
                  <>
                    {' · '}updated {formatAge(snykFetchedAt)}
                    {snykFromCache ? ' (cached)' : ''}
                  </>
                )}
              </>
            ) : (
              'Snyk connected'
            )}
          </span>
          <button
            type="button"
            className="repo-health__snyk-refresh"
            onClick={() => loadSnyk(true)}
            disabled={snykLoading}
            title="Fetch fresh issue counts from Snyk now"
          >
            {snykLoading ? '↻ Refreshing…' : '↻ Refresh'}
          </button>
        </div>
      )}
      <div className={gridClass}>
        <div className="repo-health__header-row">
          <button type="button" className="repo-health__sort" onClick={() => toggleSort('repoName')}>Repository{sortArrow('repoName')}</button>
          <button type="button" className="repo-health__sort" onClick={() => toggleSort('totalCommits')}>Commits{sortArrow('totalCommits')}</button>
          <button type="button" className="repo-health__sort" onClick={() => toggleSort('daysSinceLastCommit')}>Last Activity{sortArrow('daysSinceLastCommit')}</button>
          <button type="button" className="repo-health__sort" onClick={() => toggleSort('commitsPerWeek')}>Commits/wk{sortArrow('commitsPerWeek')}</button>
          <button type="button" className="repo-health__sort" onClick={() => toggleSort('defaultBranch')}>Default Branch{sortArrow('defaultBranch')}</button>
          <span title="develop ahead/behind main (local repositories only)">Dev vs Main</span>
          <button type="button" className="repo-health__sort" onClick={() => toggleSort('uniqueContributors')}>Contributors{sortArrow('uniqueContributors')}</button>
          {snykConnected && <button type="button" className="repo-health__sort" title="Snyk critical open issues" onClick={() => toggleSort('critical')}>Critical{sortArrow('critical')}</button>}
          {snykConnected && <button type="button" className="repo-health__sort" title="Snyk high open issues" onClick={() => toggleSort('high')}>High{sortArrow('high')}</button>}
        </div>
        {sortedRepos.map(r => {
          const snyk = snykConnected ? lookupSnyk(r.repoName) : undefined;
          return (
            <div key={r.repoId} className="repo-health__row">
              <span className="repo-health__repo-name">
                {r.parentFolder ? `${r.parentFolder}/` : ''}{r.repoName}
              </span>
              <span>{r.totalCommits}</span>
              <span className={`repo-health__staleness ${stalenessClass(r.daysSinceLastCommit)}`}>
                {r.daysSinceLastCommit === 0 ? 'Today' : `${r.daysSinceLastCommit}d ago`}
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
  description: 'Activity, staleness, default branch, velocity, and Snyk issue counts per repository',
  requiredFields: ['date'] as const,
  supportsDateFilter: true,
  supportsRepoFilter: true,
  component: RepoHealthWidget,
};
