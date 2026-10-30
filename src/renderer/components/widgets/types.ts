import type { ComponentType } from 'react';
import type { Commit, DateRange, Repository } from '../../../shared/types';

export type GitLogField =
  | 'hash'
  | 'authorName'
  | 'authorEmail'
  | 'date'
  | 'message'
  | 'repositoryId'
  | 'repositoryName';

export type AuthorGrouping = 'name' | 'email';

export interface ChartWidgetProps {
  commits: Commit[];
  dateRange: DateRange | null;
  selectedRepoIds: string[];
  /** The currently selected repositories (metadata for repo-oriented widgets). */
  repositories: Repository[];
  authorGrouping: AuthorGrouping;
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
