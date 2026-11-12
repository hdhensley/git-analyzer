import { useMemo, useState } from 'react';
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
    }).sort((a, b) => a.busFactor - b.busFactor || b.topPercent - a.topPercent);
  }, [commits, groupByName]);

  const [riskyOnly, setRiskyOnly] = useState(false);
  const riskyCount = repos.filter((r) => r.busFactor <= 1).length;
  const visible = riskyOnly ? repos.filter((r) => r.busFactor <= 1) : repos;

  if (commits.length === 0) {
    return <div className="bus-factor bus-factor--empty">No commits match the current filters</div>;
  }

  const badgeClass = (bf: number) =>
    bf <= 1 ? 'bus-factor__badge--danger' : bf <= 2 ? 'bus-factor__badge--warn' : 'bus-factor__badge--ok';

  return (
    <div className="bus-factor">
      <div className="bus-factor__summary">
        <span>
          <strong>{riskyCount}</strong> of {repos.length} repositories have a bus factor of 1
          (one person wrote more than half the commits in this period).
        </span>
        <label className="bus-factor__toggle">
          <input type="checkbox" checked={riskyOnly} onChange={(e) => setRiskyOnly(e.target.checked)} />
          Bus factor 1 only
        </label>
      </div>
      <div className="bus-factor__table" role="table" aria-label="Bus factor by repository">
        <div className="bus-factor__row bus-factor__row--head" role="row">
          <span role="columnheader">Repository</span>
          <span role="columnheader" title="Fewest contributors needed to cover more than 50% of commits">Bus factor</span>
          <span role="columnheader">Share of commits</span>
          <span role="columnheader">Top contributor</span>
          <span role="columnheader" className="bus-factor__num">Commits</span>
        </div>
        {visible.map((r) => (
          <div
            key={r.repoId}
            className="bus-factor__row"
            role="row"
            title={r.contributors.map((c) => `${c.name}: ${c.count} commits (${c.percent}%)`).join('\n')}
          >
            <span className="bus-factor__repo-name" role="cell">{r.repoName}</span>
            <span role="cell">
              <span className={`bus-factor__badge ${badgeClass(r.busFactor)}`}>{r.busFactor}</span>
            </span>
            <span className="bus-factor__bar-stack" role="cell">
              {r.contributors.map((c) => (
                <span key={c.name} className="bus-factor__segment" style={{ width: `${c.percent}%` }} />
              ))}
            </span>
            <span className="bus-factor__top" role="cell">
              {r.topContributor} <span className="bus-factor__contributor-pct">{r.topPercent}%</span>
            </span>
            <span className="bus-factor__num" role="cell">{r.totalCommits}</span>
          </div>
        ))}
      </div>
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
