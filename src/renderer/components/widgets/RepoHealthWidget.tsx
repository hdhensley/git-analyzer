import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
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

  // Column template is driven by CSS variables so the repository column can be
  // resized without touching the other columns' definitions.
  const otherColCount = snykConnected ? 8 : 6;
  const repoColMin = repoColWidth ?? REPO_COL_DEFAULT;
  const tableStyle = {
    '--repo-col': repoColWidth !== null ? `${repoColWidth}px` : `minmax(${REPO_COL_DEFAULT}px, 3fr)`,
    '--other-col-count': otherColCount,
    '--row-min-width': `${repoColMin + otherColCount * OTHER_COL_MIN + otherColCount * COL_GAP + ROW_PADDING_X}px`,
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
          {snykConnected && <button type="button" className="repo-health__sort" title="Snyk critical open issues" onClick={() => toggleSort('critical')}>Critical{sortArrow('critical')}</button>}
          {snykConnected && <button type="button" className="repo-health__sort" title="Snyk high open issues" onClick={() => toggleSort('high')}>High{sortArrow('high')}</button>}
        </div>
        {sortedRepos.map(r => {
          const snyk = snykConnected ? lookupSnyk(r.repoName) : undefined;
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
