import { useMemo, useState, useEffect } from 'react';
import type { ChartWidgetProps } from './types';
import type { Commit } from '../../../shared/types';
import './ContributionGraphWidget.css';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', ''];

interface DayData {
  date: string; // YYYY-MM-DD
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getContributionLevel(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count === 0) return 0;
  if (max <= 4) return count as 0 | 1 | 2 | 3 | 4;
  const ratio = count / max;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

function buildGraph(commits: Commit[], dateRange: { start: Date; end: Date } | null): {
  weeks: DayData[][];
  monthLabels: { label: string; colIndex: number }[];
  total: number;
} {
  const countMap = new Map<string, number>();
  for (const c of commits) {
    const key = formatDate(new Date(c.date));
    countMap.set(key, (countMap.get(key) ?? 0) + 1);
  }

  let end: Date;
  let start: Date;
  if (dateRange) {
    end = new Date(dateRange.end);
    start = new Date(dateRange.start);
  } else {
    end = new Date();
    start = new Date();
    start.setFullYear(start.getFullYear() - 1);
  }

  const startDay = new Date(start);
  startDay.setDate(startDay.getDate() - startDay.getDay());

  const endDay = new Date(end);
  if (endDay.getDay() !== 6) {
    endDay.setDate(endDay.getDate() + (6 - endDay.getDay()));
  }

  const days: DayData[] = [];
  const cursor = new Date(startDay);
  while (cursor <= endDay) {
    const key = formatDate(cursor);
    days.push({ date: key, count: countMap.get(key) ?? 0, level: 0 });
    cursor.setDate(cursor.getDate() + 1);
  }

  const maxCount = Math.max(...days.map(d => d.count), 1);
  for (const d of days) {
    d.level = getContributionLevel(d.count, maxCount);
  }

  const weeks: DayData[][] = [];
  for (let i = 0; i < days.length; i += 7) {
    weeks.push(days.slice(i, i + 7));
  }

  const monthLabels: { label: string; colIndex: number }[] = [];
  let lastMonth = -1;
  for (let w = 0; w < weeks.length; w++) {
    const firstDay = weeks[w][0];
    const d = new Date(firstDay.date);
    const m = d.getMonth();
    if (m !== lastMonth) {
      monthLabels.push({ label: MONTHS[m], colIndex: w });
      lastMonth = m;
    }
  }

  return { weeks, monthLabels, total: commits.length };
}

interface AuthorInfo {
  name: string;
  emails: Set<string>;
  commitCount: number;
}

export function ContributionGraphWidget({ commits, dateRange, authorGrouping }: ChartWidgetProps) {
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const groupByName = authorGrouping === 'name';

  // Derive unique authors grouped by name or email, sorted by commit count descending
  const authors = useMemo<AuthorInfo[]>(() => {
    const map = new Map<string, AuthorInfo>();
    for (const c of commits) {
      const key = groupByName ? c.authorName : c.authorEmail;
      const existing = map.get(key);
      if (existing) {
        existing.emails.add(c.authorEmail);
        existing.commitCount++;
      } else {
        map.set(key, { name: c.authorName, emails: new Set([c.authorEmail]), commitCount: 1 });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.commitCount - a.commitCount);
  }, [commits, groupByName]);

  // Build a set of all emails belonging to selected author keys
  const selectedEmails = useMemo(() => {
    if (selectedKeys.size === 0) return null;
    const emails = new Set<string>();
    for (const a of authors) {
      const key = groupByName ? a.name : [...a.emails][0];
      if (selectedKeys.has(key)) {
        for (const e of a.emails) emails.add(e);
      }
    }
    return emails;
  }, [selectedKeys, authors, groupByName]);

  // Filter commits by selected authors (null = all)
  const filteredCommits = useMemo(() => {
    if (!selectedEmails) return commits;
    return commits.filter(c => selectedEmails.has(c.authorEmail));
  }, [commits, selectedEmails]);

  const { weeks, monthLabels, total } = useMemo(
    () => buildGraph(filteredCommits, dateRange),
    [filteredCommits, dateRange]
  );

  const toggleAuthor = (key: string) => {
    setSelectedKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  // Reset selection when grouping changes
  useEffect(() => {
    setSelectedKeys(new Set());
  }, [authorGrouping]);

  if (commits.length === 0) {
    return (
      <div className="contribution-graph contribution-graph--empty">
        No commits match the current filters
      </div>
    );
  }

  const cellSize = 13;
  const gap = 3;
  const colWidth = cellSize + gap;
  const labelOffset = 36;

  return (
    <div className="contribution-graph">
      <div className="contribution-graph__header">
        <div className="contribution-graph__summary">
          <span className="contribution-graph__total">{total.toLocaleString()}</span>
          <span className="contribution-graph__label">
            contributions{selectedKeys.size > 0 ? ` by ${selectedKeys.size} contributor${selectedKeys.size !== 1 ? 's' : ''}` : ' in the selected period'}
          </span>
        </div>

        {authors.length > 1 && (
          <div className="contribution-graph__author-filter">
            <button
              type="button"
              className={`contribution-graph__author-pill ${selectedKeys.size === 0 ? 'contribution-graph__author-pill--active' : ''}`}
              onClick={() => setSelectedKeys(new Set())}
            >
              All
            </button>
            {authors.map(a => {
              const key = groupByName ? a.name : [...a.emails][0];
              const label = groupByName ? a.name : [...a.emails][0];
              const tooltip = groupByName
                ? `${a.name} (${[...a.emails].join(', ')}) — ${a.commitCount} commits`
                : `${[...a.emails][0]} (${a.name}) — ${a.commitCount} commits`;
              return (
                <button
                  key={key}
                  type="button"
                  className={`contribution-graph__author-pill ${selectedKeys.has(key) ? 'contribution-graph__author-pill--active' : ''}`}
                  onClick={() => toggleAuthor(key)}
                  title={tooltip}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="contribution-graph__grid-wrapper">
        <div className="contribution-graph__month-labels">
          {monthLabels.map((m, i) => {
            const nextCol = i < monthLabels.length - 1 ? monthLabels[i + 1].colIndex : weeks.length;
            const spanCols = nextCol - m.colIndex;
            return (
              <span
                key={`${m.label}-${m.colIndex}`}
                className="contribution-graph__month-label"
                style={{
                  width: spanCols * colWidth,
                  marginLeft: i === 0 ? labelOffset + m.colIndex * colWidth : 0,
                }}
              >
                {m.label}
              </span>
            );
          })}
        </div>

        <div className="contribution-graph__grid">
          <div className="contribution-graph__day-labels">
            {DAY_LABELS.map((label, i) => (
              <span key={i} className="contribution-graph__day-label">{label}</span>
            ))}
          </div>

          <div className="contribution-graph__weeks">
            {weeks.map((week, wi) => (
              <div key={wi} className="contribution-graph__week">
                {week.map((day) => {
                  const d = new Date(day.date);
                  const tooltip = `${day.count} commit${day.count !== 1 ? 's' : ''} on ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
                  return (
                    <div
                      key={day.date}
                      className={`contribution-graph__cell contribution-graph__cell--level-${day.level}`}
                      data-tooltip={tooltip}
                      role="presentation"
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="contribution-graph__legend">
        <span>Less</span>
        <div className="contribution-graph__legend-cell contribution-graph__cell--level-0" />
        <div className="contribution-graph__legend-cell contribution-graph__cell--level-1" />
        <div className="contribution-graph__legend-cell contribution-graph__cell--level-2" />
        <div className="contribution-graph__legend-cell contribution-graph__cell--level-3" />
        <div className="contribution-graph__legend-cell contribution-graph__cell--level-4" />
        <span>More</span>
      </div>
    </div>
  );
}

export const ContributionGraphWidgetDefinition = {
  id: 'contribution-graph',
  name: 'Contribution Graph',
  description: 'GitHub-style contribution heatmap showing daily commit activity',
  requiredFields: ['date'] as const,
  supportsDateFilter: true,
  supportsRepoFilter: true,
  component: ContributionGraphWidget,
};
