import { useMemo } from 'react';
import type { ChartWidgetProps } from './types';
import './BusFactorWidget.css';

interface RepoOwnership {
  repoName: string;
  repoId: string;
  totalCommits: number;
  topContributor: string;
  topPercent: number;
  busFactor: number;
  contributors: { name: string; count: number; percent: number }[];
}

export function BusFactorWidget({ commits, authorGrouping }: ChartWidgetProps) {
  const groupByName = authorGrouping === 'name';

  const repos = useMemo<RepoOwnership[]>(() => {
    const repoMap = new Map<string, { name: string; authors: Map<string, number> }>();
    for (const c of commits) {
      if (!repoMap.has(c.repositoryId)) repoMap.set(c.repositoryId, { name: c.repositoryName, authors: new Map() });
      const repo = repoMap.get(c.repositoryId)!;
      const authorKey = groupByName ? c.authorName : c.authorEmail;
      repo.authors.set(authorKey, (repo.authors.get(authorKey) ?? 0) + 1);
    }

    return Array.from(repoMap.entries()).map(([repoId, { name, authors }]) => {
      const total = Array.from(authors.values()).reduce((s, v) => s + v, 0);
      const sorted = Array.from(authors.entries())
        .map(([n, count]) => ({ name: n, count, percent: Math.round((count / total) * 100) }))
        .sort((a, b) => b.count - a.count);

      // Bus factor: minimum contributors needed to cover >50% of commits
      let cumulative = 0;
      let busFactor = 0;
      for (const c of sorted) {
        cumulative += c.count;
        busFactor++;
        if (cumulative > total * 0.5) break;
      }

      return {
        repoName: name, repoId, totalCommits: total,
        topContributor: sorted[0]?.name ?? '',
        topPercent: sorted[0]?.percent ?? 0,
        busFactor,
        contributors: sorted.slice(0, 5),
      };
    }).sort((a, b) => a.busFactor - b.busFactor);
  }, [commits, groupByName]);

  if (commits.length === 0) {
    return <div className="bus-factor bus-factor--empty">No commits match the current filters</div>;
  }

  return (
    <div className="bus-factor">
      {repos.map(r => (
        <div key={r.repoId} className={`bus-factor__repo ${r.busFactor <= 1 ? 'bus-factor__repo--risk' : ''}`}>
          <div className="bus-factor__repo-header">
            <span className="bus-factor__repo-name">{r.repoName}</span>
            <span className={`bus-factor__badge ${r.busFactor <= 1 ? 'bus-factor__badge--danger' : r.busFactor <= 2 ? 'bus-factor__badge--warn' : 'bus-factor__badge--ok'}`}>
              Bus factor: {r.busFactor}
            </span>
          </div>
          <div className="bus-factor__bar-stack">
            {r.contributors.map(c => (
              <div
                key={c.name}
                className="bus-factor__segment"
                style={{ width: `${c.percent}%` }}
                title={`${c.name}: ${c.count} commits (${c.percent}%)`}
              />
            ))}
          </div>
          <div className="bus-factor__contributors">
            {r.contributors.map(c => (
              <span key={c.name} className="bus-factor__contributor">
                {c.name} <span className="bus-factor__contributor-pct">{c.percent}%</span>
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export const BusFactorWidgetDefinition = {
  id: 'bus-factor',
  name: 'Bus Factor',
  description: 'Knowledge distribution risk — how many contributors cover 50% of each repo',
  requiredFields: ['authorName', 'authorEmail'] as const,
  supportsDateFilter: true,
  supportsRepoFilter: true,
  component: BusFactorWidget,
};
