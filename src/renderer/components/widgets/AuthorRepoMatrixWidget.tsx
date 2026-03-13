import { useMemo } from 'react';
import type { ChartWidgetProps } from './types';
import './AuthorRepoMatrixWidget.css';

export function AuthorRepoMatrixWidget({ commits, authorGrouping }: ChartWidgetProps) {
  const groupByName = authorGrouping === 'name';

  const { authors, repos, matrix, maxCount, collaborationDays } = useMemo(() => {
    const authorSet = new Map<string, number>();
    const repoSet = new Map<string, string>();
    const m = new Map<string, number>();

    for (const c of commits) {
      const authorKey = groupByName ? c.authorName : c.authorEmail;
      authorSet.set(authorKey, (authorSet.get(authorKey) ?? 0) + 1);
      repoSet.set(c.repositoryId, c.repositoryName);
      const key = `${authorKey}|${c.repositoryId}`;
      m.set(key, (m.get(key) ?? 0) + 1);
    }

    const sortedAuthors = Array.from(authorSet.entries()).sort((a, b) => b[1] - a[1]).map(([name]) => name);
    const sortedRepos = Array.from(repoSet.entries()).map(([id, name]) => ({ id, name }));
    const max = Math.max(...Array.from(m.values()), 1);

    const dayRepoAuthors = new Map<string, Set<string>>();
    for (const c of commits) {
      const d = new Date(c.date);
      const dk = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const key = `${dk}|${c.repositoryId}`;
      if (!dayRepoAuthors.has(key)) dayRepoAuthors.set(key, new Set());
      dayRepoAuthors.get(key)!.add(groupByName ? c.authorName : c.authorEmail);
    }
    const collabDays = Array.from(dayRepoAuthors.values()).filter(s => s.size > 1).length;

    return { authors: sortedAuthors, repos: sortedRepos, matrix: m, maxCount: max, collaborationDays: collabDays };
  }, [commits, groupByName]);

  if (commits.length === 0) {
    return <div className="author-repo-matrix author-repo-matrix--empty">No commits match the current filters</div>;
  }

  const getLevel = (count: number): number => {
    if (count === 0) return 0;
    const r = count / maxCount;
    if (r <= 0.25) return 1;
    if (r <= 0.5) return 2;
    if (r <= 0.75) return 3;
    return 4;
  };

  return (
    <div className="author-repo-matrix">
      <div className="author-repo-matrix__summary">
        <span className="author-repo-matrix__stat">{collaborationDays} collaboration days</span>
        <span className="author-repo-matrix__stat-sub">(days where 2+ contributors committed to the same repo)</span>
      </div>
      <div className="author-repo-matrix__grid-wrapper">
        <table className="author-repo-matrix__table">
          <thead>
            <tr>
              <th className="author-repo-matrix__corner" />
              {repos.map(r => (
                <th key={r.id} className="author-repo-matrix__repo-header">
                  <span className="author-repo-matrix__repo-label" title={r.name}>{r.name}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {authors.slice(0, 20).map(author => (
              <tr key={author}>
                <td className="author-repo-matrix__author-label" title={author}>{author}</td>
                {repos.map(r => {
                  const count = matrix.get(`${author}|${r.id}`) ?? 0;
                  return (
                    <td key={r.id} className="author-repo-matrix__cell-td">
                      <div
                        className={`author-repo-matrix__cell author-repo-matrix__cell--level-${getLevel(count)}`}
                        data-tooltip={`${author} → ${r.name}: ${count} commits`}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="author-repo-matrix__legend">
        <span>None</span>
        {[0, 1, 2, 3, 4].map(l => (
          <div key={l} className={`author-repo-matrix__legend-cell author-repo-matrix__cell--level-${l}`} />
        ))}
        <span>Most</span>
      </div>
    </div>
  );
}

export const AuthorRepoMatrixWidgetDefinition = {
  id: 'author-repo-matrix',
  name: 'Contributor × Repository Matrix',
  description: 'Heatmap of who contributes where, plus collaboration overlap days',
  requiredFields: ['authorName', 'authorEmail', 'date'] as const,
  supportsDateFilter: true,
  supportsRepoFilter: true,
  component: AuthorRepoMatrixWidget,
};
