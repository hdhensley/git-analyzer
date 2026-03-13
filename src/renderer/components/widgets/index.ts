export { WidgetRegistry } from './WidgetRegistry';
export { ChartWidget } from './ChartWidget';
export {
  CommitsPerUserWidget,
  CommitsPerUserWidgetDefinition,
  aggregateCommitsByAuthor,
} from './CommitsPerUserWidget';
export {
  MessageSummaryWidget,
  MessageSummaryWidgetDefinition,
  summarizeMessagesByAuthor,
  truncateMessage,
} from './MessageSummaryWidget';
export {
  RepositoryCommitSummaryWidget,
  RepositoryCommitSummaryWidgetDefinition,
} from './RepositoryCommitSummaryWidget';
export {
  ContributionGraphWidget,
  ContributionGraphWidgetDefinition,
} from './ContributionGraphWidget';
export type { ChartWidgetProps, ChartWidgetDefinition, GitLogField, AuthorGrouping } from './types';
