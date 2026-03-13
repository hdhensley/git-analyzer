import { useMemo } from 'react';
import type { ChartWidgetProps } from './types';
import type { AuthorGrouping } from './types';
import './StreakWidget.css';

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function nextDay(key: string): string {
  const d = new Date(key + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  return dateKey(d);
}

interface StreakInfo {
  label: string;
  currentStreak: number;
  longestStreak: number;
  longestStart: string;
  longestEnd: string;
  totalActiveDays: number;
}

function computeStreak(dates: Set<string>, label: string): StreakInfo {
  const sorted = Array.from(dates).sort();
  if (sorted.length === 0) return { label, currentStreak: 0, longestStreak: 0, longestStart: '', longestEnd: '', totalActiveDays: 0 };

  let longest = 1, longestStart = sorted[0], longestEnd = sorted[0];
  let current = 1, curStart = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (nextDay(sorted[i - 1]) === sorted[i]) {
      current++;
    } else {
      if (current > longest) { longest = current; longestStart = curStart; longestEnd = sorted[i - 1]; }
      current = 1;
      curStart = sorted[i];
    }
  }
  if (current > longest) { longest = current; longestStart = curStart; longestEnd = sorted[sorted.length - 1]; }

  // Current streak: count back from today
  const today = dateKey(new Date());
  let cs = 0;
  let check = today;
  while (dates.has(check)) { cs++; const d = new Date(check + 'T00:00:00'); d.setDate(d.getDate() - 1); check = dateKey(d); }

  return { label, currentStreak: cs, longestStreak: longest, longestStart, longestEnd, totalActiveDays: sorted.length };
}

export function StreakWidget({ commits, authorGrouping }: ChartWidgetProps) {
  const groupByName = authorGrouping === 'name';

  const streaks = useMemo(() => {
    // Team streak
    const teamDates = new Set<string>();
    const authorDates = new Map<string, Set<string>>();

    for (const c of commits) {
      const dk = dateKey(new Date(c.date));
      teamDates.add(dk);
      const authorKey = groupByName ? c.authorName : c.authorEmail;
      if (!authorDates.has(authorKey)) authorDates.set(authorKey, new Set());
      authorDates.get(authorKey)!.add(dk);
    }

    const team = computeStreak(teamDates, 'Team');
    const perAuthor = Array.from(authorDates.entries())
      .map(([key, dates]) => computeStreak(dates, key))
      .sort((a, b) => b.longestStreak - a.longestStreak);

    return { team, perAuthor };
  }, [commits, groupByName]);

  if (commits.length === 0) {
    return <div className="streak-widget streak-widget--empty">No commits match the current filters</div>;
  }

  const renderStreak = (s: StreakInfo) => (
    <div className="streak-widget__card" key={s.label}>
      <div className="streak-widget__card-header">{s.label}</div>
      <div className="streak-widget__stats">
        <div className="streak-widget__stat">
          <span className="streak-widget__stat-value">{s.currentStreak}</span>
          <span className="streak-widget__stat-label">Current streak</span>
        </div>
        <div className="streak-widget__stat">
          <span className="streak-widget__stat-value">{s.longestStreak}</span>
          <span className="streak-widget__stat-label">Longest streak</span>
        </div>
        <div className="streak-widget__stat">
          <span className="streak-widget__stat-value">{s.totalActiveDays}</span>
          <span className="streak-widget__stat-label">Active days</span>
        </div>
      </div>
      {s.longestStreak > 0 && (
        <div className="streak-widget__range">{s.longestStart} → {s.longestEnd}</div>
      )}
    </div>
  );

  return (
    <div className="streak-widget">
      {renderStreak(streaks.team)}
      <div className="streak-widget__authors">
        {streaks.perAuthor.slice(0, 10).map(renderStreak)}
      </div>
    </div>
  );
}

export const StreakWidgetDefinition = {
  id: 'streaks',
  name: 'Commit Streaks',
  description: 'Current and longest consecutive-day commit streaks per contributor',
  requiredFields: ['date', 'authorName', 'authorEmail'] as const,
  supportsDateFilter: true,
  supportsRepoFilter: true,
  component: StreakWidget,
};
