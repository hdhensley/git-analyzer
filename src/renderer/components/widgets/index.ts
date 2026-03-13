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
export { CommitFrequencyWidget, CommitFrequencyWidgetDefinition } from './CommitFrequencyWidget';
export { DayHourHeatmapWidget, DayHourHeatmapWidgetDefinition } from './DayHourHeatmapWidget';
export { StreakWidget, StreakWidgetDefinition } from './StreakWidget';
export { BusFactorWidget, BusFactorWidgetDefinition } from './BusFactorWidget';
export {
  CommitMessageAnalysisWidget,
  CommitMessageAnalysisWidgetDefinition,
} from './CommitMessageAnalysisWidget';
export { RepoHealthWidget, RepoHealthWidgetDefinition } from './RepoHealthWidget';
export { AuthorRepoMatrixWidget, AuthorRepoMatrixWidgetDefinition } from './AuthorRepoMatrixWidget';
export type { ChartWidgetProps, ChartWidgetDefinition, GitLogField, AuthorGrouping } from './types';
