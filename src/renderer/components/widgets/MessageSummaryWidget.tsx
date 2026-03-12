import { useMemo, useState } from 'react';
import type { ChartWidgetProps } from './types';
import type { Commit } from '../../../shared/types';
import './MessageSummaryWidget.css';

const MAX_MESSAGE_LENGTH = 200;

interface CommitMessagePreview {
  hash: string;
  date: Date;
  message: string;
  truncated: boolean;
  fullMessage: string;
  branch?: string;
}

interface RepositoryCommits {
  repositoryId: string;
  repositoryName: string;
  commitCount: number;
  messages: CommitMessagePreview[];
}

interface AuthorMessageSummary {
  authorName: string;
  authorEmail: string;
  commitCount: number;
  dateRange: { earliest: Date; latest: Date };
  repositories: RepositoryCommits[];
}

export function truncateMessage(message: string): CommitMessagePreview {
  const firstLine = message.split('\n')[0];
  const truncated = firstLine.length > MAX_MESSAGE_LENGTH;
  
  return {
    hash: '',
    date: new Date(),
    message: truncated ? firstLine.substring(0, MAX_MESSAGE_LENGTH) + '...' : firstLine,
    truncated,
    fullMessage: message,
  };
}

export function summarizeMessagesByAuthor(commits: Commit[]): AuthorMessageSummary[] {
  const authorMap = new Map<string, {
    authorName: string;
    authorEmail: string;
    commits: Commit[];
  }>();

  for (const commit of commits) {
    const existing = authorMap.get(commit.authorEmail);
    if (existing) {
      existing.commits.push(commit);
    } else {
      authorMap.set(commit.authorEmail, {
        authorName: commit.authorName,
        authorEmail: commit.authorEmail,
        commits: [commit],
      });
    }
  }

  return Array.from(authorMap.values())
    .map(({ authorName, authorEmail, commits }) => {
      const dates = commits.map(c => c.date.getTime());
      
      // Group commits by repository
      const repoMap = new Map<string, Commit[]>();
      for (const commit of commits) {
        const existing = repoMap.get(commit.repositoryId);
        if (existing) {
          existing.push(commit);
        } else {
          repoMap.set(commit.repositoryId, [commit]);
        }
      }

      const repositories: RepositoryCommits[] = Array.from(repoMap.entries())
        .map(([repositoryId, repoCommits]) => {
          const messages: CommitMessagePreview[] = repoCommits
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
                branch: c.branch,
              };
            });

          return {
            repositoryId,
            repositoryName: repoCommits[0].repositoryName,
            commitCount: repoCommits.length,
            messages,
          };
        })
        .sort((a, b) => b.commitCount - a.commitCount);

      return {
        authorName,
        authorEmail,
        commitCount: commits.length,
        dateRange: {
          earliest: new Date(Math.min(...dates)),
          latest: new Date(Math.max(...dates)),
        },
        repositories,
      };
    })
    .sort((a, b) => b.commitCount - a.commitCount);
}

export function MessageSummaryWidget({ commits }: ChartWidgetProps) {
  const summaries = useMemo(() => summarizeMessagesByAuthor(commits), [commits]);
  const [expandedAuthors, setExpandedAuthors] = useState<Set<string>>(new Set());
  const [expandedRepos, setExpandedRepos] = useState<Set<string>>(new Set());
  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set());

  if (commits.length === 0) {
    return (
      <div className="message-summary message-summary--empty">
        No commits match the current filters
      </div>
    );
  }

  const toggleAuthor = (email: string) => {
    const newExpanded = new Set(expandedAuthors);
    if (newExpanded.has(email)) {
      newExpanded.delete(email);
    } else {
      newExpanded.add(email);
    }
    setExpandedAuthors(newExpanded);
  };

  const toggleRepo = (key: string) => {
    const newExpanded = new Set(expandedRepos);
    if (newExpanded.has(key)) {
      newExpanded.delete(key);
    } else {
      newExpanded.add(key);
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
    <div className="message-summary">
      {summaries.map((summary) => (
        <div key={summary.authorEmail} className="message-summary__author">
          <button
            type="button"
            className="message-summary__author-header"
            onClick={() => toggleAuthor(summary.authorEmail)}
          >
            <span className="message-summary__expand-icon">
              {expandedAuthors.has(summary.authorEmail) ? '▼' : '▶'}
            </span>
            <div className="message-summary__author-info">
              <span className="message-summary__author-name">{summary.authorName}</span>
              <span className="message-summary__author-stats">
                {summary.commitCount} commits • {formatDate(summary.dateRange.earliest)} - {formatDate(summary.dateRange.latest)}
              </span>
            </div>
          </button>

          {expandedAuthors.has(summary.authorEmail) && (
            <div className="message-summary__repositories">
              {summary.repositories.map((repo) => {
                const repoKey = `${summary.authorEmail}-${repo.repositoryId}`;
                return (
                  <div key={repoKey} className="message-summary__repository">
                    <button
                      type="button"
                      className="message-summary__repo-header"
                      onClick={() => toggleRepo(repoKey)}
                    >
                      <span className="message-summary__expand-icon">
                        {expandedRepos.has(repoKey) ? '▼' : '▶'}
                      </span>
                      <span className="message-summary__repo-name">{repo.repositoryName}</span>
                      <span className="message-summary__repo-count">{repo.commitCount} commits</span>
                    </button>

                    {expandedRepos.has(repoKey) && (
                      <div className="message-summary__messages">
                        {repo.messages.map((msg) => (
                          <div key={msg.hash} className="message-summary__message">
                            <span className="message-summary__message-date">
                              {formatDate(msg.date)}
                            </span>
                            {msg.branch && (
                              <span className="message-summary__message-branch">
                                {msg.branch}
                              </span>
                            )}
                            <span className="message-summary__message-text">
                              {expandedMessages.has(msg.hash) ? msg.fullMessage : msg.message}
                              {msg.truncated && (
                                <button
                                  type="button"
                                  className="message-summary__expand-btn"
                                  onClick={() => toggleMessage(msg.hash)}
                                >
                                  {expandedMessages.has(msg.hash) ? 'Show less' : 'Show more'}
                                </button>
                              )}
                            </span>
                            <span className="message-summary__message-hash">
                              {msg.hash.substring(0, 7)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// Widget definition for registry
export const MessageSummaryWidgetDefinition = {
  id: 'message-summary',
  name: 'Commit Message Summary',
  description: 'Grouped list of commit messages by author',
  requiredFields: ['hash', 'authorName', 'authorEmail', 'date', 'message'] as const,
  supportsDateFilter: true,
  supportsRepoFilter: true,
  component: MessageSummaryWidget,
};
