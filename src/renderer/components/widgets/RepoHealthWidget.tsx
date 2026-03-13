import { useMemo } from 'react';
import type { ChartWidgetProps } from './types';
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

  return (
    <div className="repo-health">
      <div className="repo-health__table">
        <div className="repo-health__header-row">
          <span>Repository</span>
          <span>Commits</span>
          <span>Last Activity</span>
          <span>Commits/wk</span>
          <span>Branches</span>
          <span>Contributors</span>
        </div>
        {repos.map(r => (
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
          </div>
        ))}
      </div>
    </div>
  );
}

export const RepoHealthWidgetDefinition = {
  id: 'repo-health',
  name: 'Repository Health',
  description: 'Activity, staleness, branch count, and velocity per repository',
  requiredFields: ['date'] as const,
  supportsDateFilter: true,
  supportsRepoFilter: true,
  component: RepoHealthWidget,
};
