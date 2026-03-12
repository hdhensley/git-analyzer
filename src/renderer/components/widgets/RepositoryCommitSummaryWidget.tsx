import { useMemo, useState } from 'react';
import type { ChartWidgetProps } from './types';
import type { Commit } from '../../../shared/types';
import './RepositoryCommitSummaryWidget.css';

const MAX_MESSAGE_LENGTH = 200;

interface CommitMessagePreview {
  hash: string;
  date: Date;
  message: string;
  truncated: boolean;
  fullMessage: string;
  authorName: string;
  branch?: string;
}

interface RepositoryCommitSummary {
  repositoryId: string;
  repositoryName: string;
  repositoryParentFolder?: string;
  commitCount: number;
  dateRange: { earliest: Date; latest: Date };
  messages: CommitMessagePreview[];
}

function truncateMessage(message: string): { message: string; truncated: boolean; fullMessage: string } {
  const firstLine = message.split('\n')[0];
  const truncated = firstLine.length > MAX_MESSAGE_LENGTH;
  
  return {
    message: truncated ? firstLine.substring(0, MAX_MESSAGE_LENGTH) + '...' : firstLine,
    truncated,
    fullMessage: message,
  };
}

function summarizeMessagesByRepository(commits: Commit[]): RepositoryCommitSummary[] {
  const repoMap = new Map<string, {
    repositoryId: string;
    repositoryName: string;
    repositoryParentFolder?: string;
    commits: Commit[];
  }>();

  for (const commit of commits) {
    const existing = repoMap.get(commit.repositoryId);
    if (existing) {
      existing.commits.push(commit);
    } else {
      repoMap.set(commit.repositoryId, {
        repositoryId: commit.repositoryId,
        repositoryName: commit.repositoryName,
        repositoryParentFolder: commit.repositoryParentFolder,
        commits: [commit],
      });
    }
  }

  return Array.from(repoMap.values())
    .map(({ repositoryId, repositoryName, repositoryParentFolder, commits }) => {
      const dates = commits.map(c => c.date.getTime());
      
      const messages: CommitMessagePreview[] = commits
        .sort((a, b) => b.date.getTime() - a.date.getTime())
        .slice(0, 10)
        .map(c => {
          const preview = truncateMessage(c.message);
          return {
            hash: c.hash,
            date: c.date,
            message: preview.message,
            truncated: preview.truncated,
            fullMessage: preview.fullMessage,
            authorName: c.authorName,
            branch: c.branch,
          };
        });

      return {
        repositoryId,
        repositoryName,
        repositoryParentFolder,
        commitCount: commits.length,
        dateRange: {
          earliest: new Date(Math.min(...dates)),
          latest: new Date(Math.max(...dates)),
        },
        messages,
      };
    })
    .sort((a, b) => b.commitCount - a.commitCount);
}

export function RepositoryCommitSummaryWidget({ commits }: ChartWidgetProps) {
  const summaries = useMemo(() => summarizeMessagesByRepository(commits), [commits]);
  const [expandedRepos, setExpandedRepos] = useState<Set<string>>(new Set());
  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set());

  if (commits.length === 0) {
    return (
      <div className="repo-commit-summary repo-commit-summary--empty">
        No commits match the current filters
      </div>
    );
  }

  const toggleRepo = (repoId: string) => {
    const newExpanded = new Set(expandedRepos);
    if (newExpanded.has(repoId)) {
      newExpanded.delete(repoId);
    } else {
      newExpanded.add(repoId);
    }
    setExpandedRepos(newExpanded);
  };

  const toggleMessage = (hash: string) => {
    const newExpanded = new Set(expandedMessages);
    if (newExpanded.has(hash)) {
      newExpanded.delete(hash);
    } else {
      newExpanded.add(hash);
    }
    setExpandedMessages(newExpanded);
  };

  const formatDate = (date: Date) => date.toLocaleDateString();

  return (
    <div className="repo-commit-summary">
      {summaries.map((summary) => (
        <div key={summary.repositoryId} className="repo-commit-summary__repository">
          <button
            type="button"
            className="repo-commit-summary__repo-header"
            onClick={() => toggleRepo(summary.repositoryId)}
          >
            <span className="repo-commit-summary__expand-icon">
              {expandedRepos.has(summary.repositoryId) ? '▼' : '▶'}
            </span>
            <div className="repo-commit-summary__repo-info">
              <span className="repo-commit-summary__repo-name">
                {summary.repositoryParentFolder ? `${summary.repositoryParentFolder}/` : ''}{summary.repositoryName}
              </span>
              <span className="repo-commit-summary__repo-stats">
                {summary.commitCount} commits • {formatDate(summary.dateRange.earliest)} - {formatDate(summary.dateRange.latest)}
              </span>
            </div>
          </button>

          {expandedRepos.has(summary.repositoryId) && (
            <div className="repo-commit-summary__messages">
              {summary.messages.map((msg) => (
                <div key={msg.hash} className="repo-commit-summary__message">
                  <span className="repo-commit-summary__message-date">
                    {formatDate(msg.date)}
                  </span>
                  {msg.branch && (
                    <span className="repo-commit-summary__message-branch">
                      {msg.branch}
                    </span>
                  )}
                  <span className="repo-commit-summary__message-author">
                    {msg.authorName}
                  </span>
                  <span className="repo-commit-summary__message-text">
                    {expandedMessages.has(msg.hash) ? msg.fullMessage : msg.message}
                    {msg.truncated && (
                      <button
                        type="button"
                        className="repo-commit-summary__expand-btn"
                        onClick={() => toggleMessage(msg.hash)}
                      >
                        {expandedMessages.has(msg.hash) ? 'Show less' : 'Show more'}
                      </button>
                    )}
                  </span>
                  <span className="repo-commit-summary__message-hash">
                    {msg.hash.substring(0, 7)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// Widget definition for registry
export const RepositoryCommitSummaryWidgetDefinition = {
  id: 'repository-commit-summary',
  name: 'Repository Commit Summary',
  description: 'Grouped list of commit messages by repository',
  requiredFields: ['hash', 'authorName', 'authorEmail', 'date', 'message', 'repositoryId', 'repositoryName'] as const,
  supportsDateFilter: true,
  supportsRepoFilter: true,
  component: RepositoryCommitSummaryWidget,
};
