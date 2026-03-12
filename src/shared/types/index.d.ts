export type SCMProvider = 'github' | 'bitbucket';
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
export interface Repository {
    id: string;
    name: string;
    owner: string;
    provider: SCMProvider;
    defaultBranch: string;
    url: string;
}
export interface ImportedRepository extends Repository {
    importedAt: Date;
    lastSyncAt: Date;
    commitCount: number;
}
export interface RepositoryPage {
    repositories: Repository[];
    totalCount: number;
    hasNextPage: boolean;
    nextPage?: number;
}
export interface Commit {
    hash: string;
    authorName: string;
    authorEmail: string;
    date: Date;
    message: string;
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
    dateRange: {
        earliest: Date;
        latest: Date;
    };
}
export interface ImportProgress {
    repositoryId: string;
    repositoryName: string;
    status: 'pending' | 'fetching' | 'saving' | 'complete' | 'error';
    commitsFetched?: number;
    error?: string;
}
export type DateRangePreset = 'last7days' | 'last30days' | 'last90days' | 'lastYear' | 'custom';
export interface UserPreferences {
    selectedRepositoryIds: string[];
    dateRangePreset?: DateRangePreset;
    customDateRange?: {
        start: Date;
        end: Date;
    };
}
export type ErrorCode = 'AUTH_DENIED' | 'AUTH_EXPIRED' | 'NETWORK_ERROR' | 'RATE_LIMITED' | 'NOT_FOUND' | 'SERVER_ERROR' | 'TIMEOUT' | 'DB_CORRUPTION' | 'DB_DISK_FULL' | 'VALIDATION_ERROR';
export interface AppError {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
    retryable: boolean;
}
export type Result<T> = {
    success: true;
    data: T;
} | {
    success: false;
    error: AppError;
};
export interface AuthorCommitCount {
    authorName: string;
    authorEmail: string;
    commitCount: number;
}
export interface CommitMessagePreview {
    hash: string;
    date: Date;
    message: string;
    truncated: boolean;
}
export interface AuthorMessageSummary {
    authorName: string;
    authorEmail: string;
    commitCount: number;
    dateRange: {
        earliest: Date;
        latest: Date;
    };
    messages: CommitMessagePreview[];
}
export interface DateRange {
    start: Date;
    end: Date;
}
//# sourceMappingURL=index.d.ts.map