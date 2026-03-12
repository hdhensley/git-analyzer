import { useMemo } from 'react';
import type { ChartWidgetProps } from './types';
import type { AuthorCommitCount } from '../../../shared/types';
import './CommitsPerUserWidget.css';

export function aggregateCommitsByAuthor(commits: { authorName: string; authorEmail: string }[]): AuthorCommitCount[] {
  const authorMap = new Map<string, AuthorCommitCount>();

  for (const commit of commits) {
    const existing = authorMap.get(commit.authorEmail);
    if (existing) {
      existing.commitCount++;
    } else {
      authorMap.set(commit.authorEmail, {
        authorName: commit.authorName,
        authorEmail: commit.authorEmail,
        commitCount: 1,
      });
    }
  }

  return Array.from(authorMap.values()).sort((a, b) => b.commitCount - a.commitCount);
}

export function CommitsPerUserWidget({ commits }: ChartWidgetProps) {
  const authorCounts = useMemo(() => aggregateCommitsByAuthor(commits), [commits]);
  const totalCommits = commits.length;
  const maxCount = authorCounts[0]?.commitCount ?? 0;

  if (commits.length === 0) {
    return (
      <div className="commits-per-user commits-per-user--empty">
        No commits match the current filters
      </div>
    );
  }

  return (
    <div className="commits-per-user">
      <div className="commits-per-user__summary">
        <span className="commits-per-user__total">{totalCommits}</span>
        <span className="commits-per-user__label">total commits from {authorCounts.length} contributors</span>
      </div>

      <div className="commits-per-user__chart">
        {authorCounts.map((author) => (
          <div key={author.authorEmail} className="commits-per-user__bar-row">
            <div className="commits-per-user__author">
              <span className="commits-per-user__author-name">{author.authorName}</span>
              <span className="commits-per-user__author-email">{author.authorEmail}</span>
            </div>
            <div className="commits-per-user__bar-container">
              <div 
                className="commits-per-user__bar"
                style={{ width: `${(author.commitCount / maxCount) * 100}%` }}
              />
              <span className="commits-per-user__count">{author.commitCount}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Widget definition for registry
export const CommitsPerUserWidgetDefinition = {
  id: 'commits-per-user',
  name: 'Commits Per User',
  description: 'Bar chart showing commit count per contributor',
  requiredFields: ['authorName', 'authorEmail'] as const,
  supportsDateFilter: true,
  supportsRepoFilter: true,
  component: CommitsPerUserWidget,
};
