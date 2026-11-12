// SCM Provider types
export type SCMProvider = 'github' | 'bitbucket';

// Snyk integration types

// Connection status for the Snyk security integration.
export interface SnykStatus {
  connected: boolean;
  username?: string; // Snyk user/account name resolved from the token
  orgId?: string; // The Snyk organization the issue counts are scoped to
  orgName?: string; // Human-friendly org name, when resolvable
}

export interface SnykConnectResult {
  success: boolean;
  username?: string;
  orgName?: string;
  error?: string;
}

// Critical/high issue counts for a single project target (keyed by repo name).
export interface SnykRepoIssueCounts {
  // Normalized repository name used to join against imported repositories.
  repoName: string;
  critical: number;
  high: number;
}

// Where a repository's projects live in Snyk (which org(s), how many projects).
// Present even for repos with zero issues, unlike SnykRepoIssueCounts.
export interface SnykRepoProjectInfo {
  orgs: Array<{ id: string; name?: string; slug?: string }>;
  projectCount: number;
  origins: string[]; // e.g. "cli", "bitbucket-connect-app"
}

// Aggregate result returned to the renderer. `countsByRepoName` is keyed by the
// lowercased repository name so the Repository Health widget can look up counts
// without caring about the exact Snyk target naming.
export interface SnykHealthResult {
  fetchedAt: string; // ISO timestamp of when counts were fetched
  countsByRepoName: Record<string, SnykRepoIssueCounts>;
  // Keyed like `countsByRepoName`; lists the Snyk org(s)/projects for each repo.
  projectsByRepoName?: Record<string, SnykRepoProjectInfo>;
  // True when these counts came from the local cache rather than a live fetch.
  cached?: boolean;
  // True when the cached counts are older than the TTL (a background/forced
  // refresh is warranted). Only meaningful when `cached` is true.
  stale?: boolean;
  // Diagnostics to explain mismatches between Snyk and the repo list. Useful
  // when a repo shows 0 but Snyk reports issues.
  diagnostics?: {
    totalIssues: number;
    criticalHighIssues: number;
    unmatchedIssues: number; // critical/high issues whose project couldn't be mapped
    projectNames: string[]; // normalized repo names discovered from Snyk projects
  };
}

// Pipeline audit types (CDK CodePipeline + Snyk scanning completeness)

// An AWS credentials/config profile the user can pick for the deployed-state check.
export interface AwsProfile {
  name: string;
  region?: string; // Default region configured on the profile, when set
  isSso: boolean;
}

// Static classification of the Snyk step in the pipeline stack found in source.
//   ok      full standard: monitor + SCA test + code test --report, org, http url
//   partial has some Snyk scanning but is missing parts (see `snykIssues`)
//   none    pipeline stack exists but has no Snyk step
//   nopipe  no pipeline stack in the repository
export type PipelineSnykStatus = 'ok' | 'partial' | 'none' | 'nopipe';

// Result of comparing the pipeline in code with the one deployed in AWS.
//   not-checked  no AWS profile selected
//   in-sync      deployed pipeline + Snyk buildspec match the code
//   out-of-sync  deployed pipeline differs from the code (see `deployedIssues`)
//   not-deployed no pipeline with that name exists in the account/region
//   no-env       the profile's account has no matching environment in cdk.json
//   unknown      pipeline name could not be resolved from source
//   error        AWS call failed (see `deployedError`)
export type PipelineDeployStatus =
  | 'not-checked'
  | 'in-sync'
  | 'out-of-sync'
  | 'not-deployed'
  | 'no-env'
  | 'unknown'
  | 'error';

export interface PipelineAuditEntry {
  repoId: string;
  repoName: string;
  stackFile?: string; // Path of the pipeline stack relative to the repository
  pipelineName?: string;
  snykStatus: PipelineSnykStatus;
  snykIssues: string[];
  scaGating: 'gating' | 'non-gating' | 'n/a';
  snykOrg?: string;
  hasGitSecrets: boolean;
  deployStatus: PipelineDeployStatus;
  deployedIssues: string[];
  deployedError?: string;
  // Environment resolved from cdk.json for the selected profile's account.
  envKey?: string;
  region?: string;
}

export interface PipelineAuditResult {
  auditedAt: string;
  profile?: string;
  accountId?: string;
  // Set when the profile's credentials could not be used at all.
  credentialsError?: string;
  entries: PipelineAuditEntry[];
}

// All-time commit activity for one repository, independent of any date range.
// Powers the Snapshot view (Repository Health).
export interface RepoActivity {
  repositoryId: string;
  totalCommits: number;
  firstCommitDate: string | null; // ISO timestamp; null when the repo has no commits
  lastCommitDate: string | null;
  uniqueAuthorNames: number;
  uniqueAuthorEmails: number;
}

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
  // Bitbucket workspace slugs this credential can access. Scoped API tokens are
  // workspace-scoped and cannot use account-level endpoints, so repositories are
  // listed per workspace instead of via the account-wide role=member listing.
  bitbucketWorkspaces?: string[];
  // Snyk organization ID that issue counts are scoped to. Only set for the
  // Snyk credential.
  snykOrgId?: string;
  // Human-friendly Snyk organization name, when resolvable.
  snykOrgName?: string;
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
  // Which pass the sync is in: local repos are synced first (fast, on-disk),
  // then cloud repos (network-bound).
  phase?: 'local' | 'cloud';
  // Human-readable description of what the sync is doing for this repo right
  // now, e.g. "Reading git log" or "Fetching commits (page 3, 200 so far)".
  step?: string;
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

// Branch divergence (local repositories only)

// How far a comparison branch (e.g. develop) is ahead of / behind a base
// branch (e.g. main) in a local git repository.
export interface BranchDivergence {
  base: string; // Base branch name that was resolved (e.g. "main")
  compare: string; // Comparison branch name that was resolved (e.g. "develop")
  ahead: number; // Commits on `compare` not on `base`
  behind: number; // Commits on `base` not on `compare`
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

// SCM-to-local comparison types

// A grouping of repositories within an SCM source. The grouping maps to a
// provider-native concept: a project in Bitbucket, the owner/org in GitHub.
// `name` is the display name (and what `Repository.parentFolder` carries).
export interface ScmProjectGroup {
  provider: SCMProvider;
  name: string; // e.g. "Microservices" (Bitbucket project) or "my-org" (GitHub owner)
  repositoryCount: number;
}

// A single SCM repository within a project group, enriched with the clone URL
// needed to pull it down locally.
export interface ScmProjectRepository {
  provider: SCMProvider;
  name: string; // Repository slug, e.g. "payments-service"
  owner: string; // Workspace slug (Bitbucket) or owner/org (GitHub)
  group?: string; // Project group name this repo belongs to (parentFolder)
  defaultBranch: string;
  url: string; // Browser URL
  httpsCloneUrl: string; // Unauthenticated https clone URL (credentials added in main at clone time)
  sshCloneUrl: string; // SSH clone URL (e.g. git@ssh.bitbucket.org:workspace/repo.git)
}

// Result of comparing a group's repositories against a local folder.
export interface ScmLocalComparisonEntry {
  repository: ScmProjectRepository;
  present: boolean; // A matching subdirectory exists in the local folder
  localPath?: string; // Absolute path of the matching local directory, when present
  isGitRepo?: boolean; // Whether the matching local directory is itself a git repo
  localBranch?: string; // Currently checked-out branch of the local clone, when it is a git repo
}

// A local subdirectory that exists in the compared folder but does not match
// any repository in the selected SCM project group.
export interface ScmLocalOnlyEntry {
  name: string; // Subdirectory name
  localPath: string; // Absolute path of the local directory
  isGitRepo: boolean; // Whether the directory is itself a git repo
  localBranch?: string; // Current branch, when it is a git repo
}

export interface ScmLocalComparison {
  localFolder: string;
  entries: ScmLocalComparisonEntry[];
  // Local directories present in the folder but absent from the SCM project.
  localOnly: ScmLocalOnlyEntry[];
}

// Progress during a clone operation (one event per repository).
export interface CloneProgress {
  repositoryName: string;
  status: 'pending' | 'cloning' | 'complete' | 'error';
  localPath?: string;
  error?: string;
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
