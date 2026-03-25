// SCM Provider types
export type SCMProvider = 'github' | 'bitbucket';

// Extended to include 'local' as a repository source
export type RepositorySource = 'github' | 'bitbucket' | 'local';

// Authentication types
export interface AuthResult {
  success: boolean;
  provider: SCMProvider;
  username?: string;
  error?: string;
}

export interface AuthStatus {
  connected: boolean;
  provider: SCMProvider;
  username?: string;
}

export interface Credentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  username: string;
}

// Repository types
export interface Repository {
  id: string;
  name: string;
  owner: string;
  provider: RepositorySource; // Changed from SCMProvider to support 'local'
  defaultBranch: string;
  url: string;
  localPath?: string; // Only set for local repositories
  parentFolder?: string; // Parent directory name for display context
}

export interface ImportedRepository extends Repository {
  importedAt: Date;
  lastSyncAt: Date;
  commitCount: number;
  isAvailable?: boolean; // For local repos: false if path no longer exists
}

export interface RepositoryPage {
  repositories: Repository[];
  totalCount: number;
  hasNextPage: boolean;
  nextPage?: number;
}

// Commit types
export interface CommitData {
  hash: string;
  authorName: string;
  authorEmail: string;
  date: Date;
  message: string;
  branch?: string;
}

export interface Commit extends CommitData {
  repositoryId: string;
  repositoryName: string;
  repositoryParentFolder?: string;
}

export interface CommitFilter {
  repositoryIds?: string[];
  startDate?: Date;
  endDate?: Date;
  authorEmail?: string;
}

export interface CommitStats {
  totalCommits: number;
  authorCount: number;
  dateRange: { earliest: Date; latest: Date };
}

// Import progress types
export interface ImportProgress {
  repositoryId: string;
  repositoryName: string;
  status: 'pending' | 'fetching' | 'saving' | 'complete' | 'error';
  commitsFetched?: number;
  error?: string;
  currentPage?: number;
  rateLimitRetrySeconds?: number;
}

// Sync progress types
export interface SyncProgress {
  repositoryId: string;
  repositoryName: string;
  status: 'syncing' | 'complete' | 'error' | 'skipped';
  totalRepos?: number;
  processedRepos?: number;
  newCommits?: number;
  error?: string;
}

export interface SyncResult {
  totalRepos: number;
  syncedRepos: number;
  totalNewCommits: number;
  errors: { repoName: string; error: string }[];
}

// App update types
export type UpdateCheckStatus = 'up-to-date' | 'update-available' | 'error' | 'skipped';

export interface UpdateCheckResult {
  status: UpdateCheckStatus;
  currentVersion: string;
  latestVersion?: string;
  releaseUrl?: string;
  prompted?: boolean;
  message?: string;
}

// User preferences types
export type DateRangePreset = 'last7days' | 'last30days' | 'last90days' | 'lastYear' | 'custom';

export interface UserPreferences {
  selectedRepositoryIds: string[];
  dateRangePreset?: DateRangePreset;
  customDateRange?: { start: Date; end: Date };
}

// Error handling types
export type ErrorCode =
  | 'AUTH_DENIED'
  | 'AUTH_EXPIRED'
  | 'NETWORK_ERROR'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'SERVER_ERROR'
  | 'TIMEOUT'
  | 'DB_CORRUPTION'
  | 'DB_DISK_FULL'
  | 'VALIDATION_ERROR';

export interface AppError {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
  retryable: boolean;
}

export type Result<T> = { success: true; data: T } | { success: false; error: AppError };

// Analytics types
export interface AuthorCommitCount {
  authorName: string;
  authorEmail: string;
  commitCount: number;
}

export interface DateRange {
  start: Date;
  end: Date;
}

// Local Repository types

// Information about a discovered local repository before import
export interface LocalRepositoryInfo {
  path: string; // Absolute filesystem path
  name: string; // Directory name
  defaultBranch: string; // Detected default branch
  parentFolder: string; // Parent directory name for display context
}

// Progress during directory scanning
export interface ScanProgress {
  currentPath: string; // Currently scanning path
  repositoriesFound: number; // Count of repos found so far
  directoriesScanned: number; // Total directories processed
}

// Result of scanning operation
export interface ScanResult {
  repositories: LocalRepositoryInfo[];
  errors: ScanError[];
}

// Error encountered during scanning
export interface ScanError {
  path: string;
  error: string;
}

// Error types for local repository operations
export type LocalRepoErrorCode =
  | 'DIRECTORY_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'GIT_NOT_INSTALLED'
  | 'REPOSITORY_UNAVAILABLE'
  | 'GIT_COMMAND_FAILED'
  | 'DUPLICATE_REPOSITORY';

export interface LocalRepoError {
  code: LocalRepoErrorCode;
  message: string;
  path?: string;
  details?: Record<string, unknown>;
  retryable: boolean;
}
