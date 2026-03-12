import { useState, useEffect } from 'react';
import type { DateRange, DateRangePreset } from '../../../shared/types';
import './DateRangeFilter.css';

interface DateRangeFilterProps {
  value?: DateRange | null;
  preset?: DateRangePreset;
  onChange: (range: DateRange | null, preset?: DateRangePreset) => void;
}

const PRESETS: { label: string; value: DateRangePreset; days: number }[] = [
  { label: 'Last 7 days', value: 'last7days', days: 7 },
  { label: 'Last 30 days', value: 'last30days', days: 30 },
  { label: 'Last 90 days', value: 'last90days', days: 90 },
  { label: 'Last year', value: 'lastYear', days: 365 },
];

export function calculateDateRange(preset: DateRangePreset, referenceDate = new Date()): DateRange {
  const presetConfig = PRESETS.find(p => p.value === preset);
  const days = presetConfig?.days ?? 30;
  
  const end = new Date(referenceDate);
  end.setHours(23, 59, 59, 999);
  
  const start = new Date(referenceDate);
  start.setDate(start.getDate() - days);
  start.setHours(0, 0, 0, 0);
  
  return { start, end };
}

export function validateDateRange(start: Date, end: Date): boolean {
  return start <= end;
}

export function DateRangeFilter({ value, preset, onChange }: DateRangeFilterProps) {
  const [activePreset, setActivePreset] = useState<DateRangePreset | null>(preset ?? null);
  const [startDate, setStartDate] = useState(value?.start ? formatDate(value.start) : '');
  const [endDate, setEndDate] = useState(value?.end ? formatDate(value.end) : '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (preset && preset !== 'custom') {
      const range = calculateDateRange(preset);
      setStartDate(formatDate(range.start));
      setEndDate(formatDate(range.end));
      setActivePreset(preset);
    }
  }, [preset]);

  function formatDate(date: Date): string {
    return date.toISOString().split('T')[0];
  }

  function parseDate(str: string): Date | null {
    const date = new Date(str);
    return isNaN(date.getTime()) ? null : date;
  }

  const handlePresetClick = (presetValue: DateRangePreset) => {
    const range = calculateDateRange(presetValue);
    setStartDate(formatDate(range.start));
    setEndDate(formatDate(range.end));
    setActivePreset(presetValue);
    setError(null);
    onChange(range, presetValue);
  };

  const handleCustomDateChange = (type: 'start' | 'end', value: string) => {
    if (type === 'start') {
      setStartDate(value);
    } else {
      setEndDate(value);
    }
    setActivePreset('custom');

    const start = parseDate(type === 'start' ? value : startDate);
    const end = parseDate(type === 'end' ? value : endDate);

    if (start && end) {
      if (!validateDateRange(start, end)) {
        setError('Start date must be before or equal to end date');
        return;
      }
      setError(null);
      onChange({ start, end }, 'custom');
    }
  };

  const handleClear = () => {
    setStartDate('');
    setEndDate('');
    setActivePreset(null);
    setError(null);
    onChange(null);
  };

  return (
    <div className="date-range-filter">
      <div className="date-range-filter__presets">
        {PRESETS.map(p => (
          <button
            key={p.value}
            type="button"
            className={`date-range-filter__preset ${activePreset === p.value ? 'date-range-filter__preset--active' : ''}`}
            onClick={() => handlePresetClick(p.value)}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="date-range-filter__custom">
        <div className="date-range-filter__field">
          <label htmlFor="date-start">From</label>
          <input
            id="date-start"
            type="date"
            value={startDate}
            onChange={(e) => handleCustomDateChange('start', e.target.value)}
          />
        </div>
        <div className="date-range-filter__field">
          <label htmlFor="date-end">To</label>
          <input
            id="date-end"
            type="date"
            value={endDate}
            onChange={(e) => handleCustomDateChange('end', e.target.value)}
          />
        </div>
        {(startDate || endDate) && (
          <button type="button" className="date-range-filter__clear" onClick={handleClear}>
            Clear
          </button>
        )}
      </div>

      {error && <div className="date-range-filter__error">{error}</div>}
    </div>
  );
}
