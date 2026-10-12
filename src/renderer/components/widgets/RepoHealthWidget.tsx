import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChartWidgetProps } from './types';
import type { SnykRepoIssueCounts, SnykHealthResult } from '../../../shared/types';
import { useElectronAPI } from '../../hooks';
import './RepoHealthWidget.css';

interface RepoHealth {
  repoId: string;
  repoName: string;
  parentFolder?: string;
  totalCommits: number;
  lastCommitDate: Date;
  daysSinceLastCommit: number;
  activeBranches: number;
  uniqueContributors: number;
  commitsPerWeek: number;
}

export function RepoHealthWidget({ commits, authorGrouping }: ChartWidgetProps) {
  const groupByName = authorGrouping === 'name';
  const api = useElectronAPI();

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

  const repos = useMemo<RepoHealth[]>(() => {
    const now = new Date();
    const repoMap = new Map<string, { name: string; parentFolder?: string; dates: Date[]; branches: Set<string>; authors: Set<string> }>();

    for (const c of commits) {
      if (!repoMap.has(c.repositoryId)) {
        repoMap.set(c.repositoryId, { name: c.repositoryName, parentFolder: c.repositoryParentFolder, dates: [], branches: new Set(), authors: new Set() });
      }
      const r = repoMap.get(c.repositoryId)!;
      r.dates.push(new Date(c.date));
      if (c.branch) r.branches.add(c.branch);
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
        totalCommits: r.dates.length,
        lastCommitDate: lastCommit,
        daysSinceLastCommit: daysSince,
        activeBranches: r.branches.size,
        uniqueContributors: r.authors.size,
        commitsPerWeek: Math.round((r.dates.length / weeks) * 10) / 10,
      };
    }).sort((a, b) => a.daysSinceLastCommit - b.daysSinceLastCommit);
  }, [commits, groupByName]);

  if (commits.length === 0) {
    return <div className="repo-health repo-health--empty">No commits match the current filters</div>;
  }

  const stalenessClass = (days: number) => days <= 7 ? 'repo-health__staleness--fresh' : days <= 30 ? 'repo-health__staleness--recent' : days <= 90 ? 'repo-health__staleness--stale' : 'repo-health__staleness--dead';

  const lookupSnyk = (repoName: string): SnykRepoIssueCounts | undefined =>
    snykCounts[repoName.trim().toLowerCase()];

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
          <span>Repository</span>
          <span>Commits</span>
          <span>Last Activity</span>
          <span>Commits/wk</span>
          <span>Branches</span>
          <span>Contributors</span>
          {snykConnected && <span title="Snyk critical open issues">Critical</span>}
          {snykConnected && <span title="Snyk high open issues">High</span>}
        </div>
        {repos.map(r => {
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
              <span>{r.activeBranches}</span>
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
    </div>
  );
}

export const RepoHealthWidgetDefinition = {
  id: 'repo-health',
  name: 'Repository Health',
  description: 'Activity, staleness, branch count, velocity, and Snyk issue counts per repository',
  requiredFields: ['date'] as const,
  supportsDateFilter: true,
  supportsRepoFilter: true,
  component: RepoHealthWidget,
};
