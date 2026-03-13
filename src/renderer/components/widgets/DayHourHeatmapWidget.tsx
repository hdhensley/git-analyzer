import { useMemo } from 'react';
import type { ChartWidgetProps } from './types';
import './DayHourHeatmapWidget.css';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOURS = Array.from({ length: 24 }, (_, i) => i);

export function DayHourHeatmapWidget({ commits }: ChartWidgetProps) {
  const { grid, maxCount } = useMemo(() => {
    const g: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const c of commits) {
      const d = new Date(c.date);
      g[d.getDay()][d.getHours()]++;
    }
    const max = Math.max(...g.flat(), 1);
    return { grid: g, maxCount: max };
  }, [commits]);

  if (commits.length === 0) {
    return <div className="day-hour-heatmap day-hour-heatmap--empty">No commits match the current filters</div>;
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
    <div className="day-hour-heatmap">
      <div className="day-hour-heatmap__grid-wrapper">
        <table className="day-hour-heatmap__table">
          <thead>
            <tr>
              <th className="day-hour-heatmap__corner" />
              {HOURS.map(h => (
                <th key={h} className="day-hour-heatmap__hour-label">
                  {h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DAYS.map((day, di) => (
              <tr key={day}>
                <td className="day-hour-heatmap__day-label">{day}</td>
                {HOURS.map(h => (
                  <td key={h} className="day-hour-heatmap__cell-td">
                    <div
                      className={`day-hour-heatmap__cell day-hour-heatmap__cell--level-${getLevel(grid[di][h])}`}
                      data-tooltip={`${day} ${h}:00 — ${grid[di][h]} commits`}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="day-hour-heatmap__legend">
        <span>Less</span>
        {[0, 1, 2, 3, 4].map(l => (
          <div key={l} className={`day-hour-heatmap__legend-cell day-hour-heatmap__cell--level-${l}`} />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}

export const DayHourHeatmapWidgetDefinition = {
  id: 'day-hour-heatmap',
  name: 'Activity Heatmap',
  description: 'Day-of-week × hour-of-day heatmap showing when commits happen',
  requiredFields: ['date'] as const,
  supportsDateFilter: true,
  supportsRepoFilter: true,
  component: DayHourHeatmapWidget,
};
