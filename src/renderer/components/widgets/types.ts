import type { ComponentType } from 'react';
import type { Commit, DateRange } from '../../../shared/types';

export type GitLogField = 'hash' | 'authorName' | 'authorEmail' | 'date' | 'message';

export interface ChartWidgetProps {
  commits: Commit[];
  dateRange: DateRange | null;
  selectedRepoIds: string[];
  onError: (error: Error) => void;
}

export interface ChartWidgetDefinition {
  id: string;
  name: string;
  description: string;
  requiredFields: readonly GitLogField[];
  supportsDateFilter: boolean;
  supportsRepoFilter: boolean;
  component: ComponentType<ChartWidgetProps>;
}
