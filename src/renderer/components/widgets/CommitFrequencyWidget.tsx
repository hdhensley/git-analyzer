import { useMemo, useState } from 'react';
import type { ChartWidgetProps } from './types';
import './CommitFrequencyWidget.css';

type Granularity = 'daily' | 'weekly' | 'monthly';

function formatDateKey(d: Date, granularity: Granularity): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  if (granularity === 'monthly') return `${y}-${m}`;
  if (granularity === 'weekly') {
    const jan1 = new Date(y, 0, 1);
    const week = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7);
    return `${y}-W${String(week).padStart(2, '0')}`;
  }
  return `${y}-${m}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatLabel(key: string, granularity: Granularity): string {
  if (granularity === 'monthly') {
    const [y, m] = key.split('-');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[parseInt(m) - 1]} ${y}`;
  }
  if (granularity === 'weekly') return key;
  return key;
}

export function CommitFrequencyWidget({ commits }: ChartWidgetProps) {
  const [granularity, setGranularity] = useState<Granularity>('weekly');

  const { buckets, maxCount } = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of commits) {
      const key = formatDateKey(new Date(c.date), granularity);
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    const sorted = Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const max = Math.max(...sorted.map(([, v]) => v), 1);
    return { buckets: sorted, maxCount: max };
  }, [commits, granularity]);

  if (commits.length === 0) {
    return <div className="commit-freq commit-freq--empty">No commits match the current filters</div>;
  }

  return (
    <div className="commit-freq">
      <div className="commit-freq__controls">
        {(['daily', 'weekly', 'monthly'] as Granularity[]).map(g => (
          <button
            key={g}
            type="button"
            className={`commit-freq__granularity-btn ${granularity === g ? 'commit-freq__granularity-btn--active' : ''}`}
            onClick={() => setGranularity(g)}
          >
            {g.charAt(0).toUpperCase() + g.slice(1)}
          </button>
        ))}
      </div>
      <div className="commit-freq__chart">
        {buckets.map(([key, count]) => (
          <div key={key} className="commit-freq__bar-col" title={`${formatLabel(key, granularity)}: ${count} commits`}>
            <div className="commit-freq__bar" style={{ height: `${(count / maxCount) * 100}%` }} />
            {buckets.length <= 31 && (
              <span className="commit-freq__bar-label">{granularity === 'monthly' ? key.split('-')[1] : key.split('-').pop()}</span>
            )}
          </div>
        ))}
      </div>
      <div className="commit-freq__summary">
        <span>{buckets.length} {granularity === 'daily' ? 'days' : granularity === 'weekly' ? 'weeks' : 'months'} with activity</span>
        <span>Peak: {maxCount} commits</span>
      </div>
    </div>
  );
}

export const CommitFrequencyWidgetDefinition = {
  id: 'commit-frequency',
  name: 'Commit Frequency',
  description: 'Commit volume over time with daily/weekly/monthly granularity',
  requiredFields: ['date'] as const,
  supportsDateFilter: true,
  supportsRepoFilter: true,
  component: CommitFrequencyWidget,
};
