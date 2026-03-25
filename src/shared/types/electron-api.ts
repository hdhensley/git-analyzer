import type {
  SCMProvider,
  AuthResult,
  AuthStatus,
  RepositoryPage,
  Repository,
  ImportedRepository,
  CommitFilter,
  Commit,
  CommitStats,
  UserPreferences,
  ImportProgress,
  LocalRepositoryInfo,
  ScanResult,
  ScanProgress,
  SyncProgress,
  SyncResult,
  UpdateCheckResult,
} from './index';

export interface ElectronAPI {
  auth: {
    authenticate: (provider: SCMProvider) => Promise<AuthResult>;
    authenticateWithToken: (
      provider: SCMProvider,
      token: string,
      username?: string
    ) => Promise<AuthResult>;
    isOAuthConfigured: (provider: SCMProvider) => Promise<boolean>;
    getStatus: (provider: SCMProvider) => Promise<AuthStatus>;
    disconnect: (provider: SCMProvider) => Promise<void>;
  };

  repositories: {
    list: (provider: SCMProvider, page: number) => Promise<RepositoryPage>;
    import: (repos: Repository[]) => Promise<void>;
    getImported: () => Promise<ImportedRepository[]>;
    delete: (repoId: string) => Promise<void>;
    sync: () => Promise<SyncResult>;
  };

  commits: {
    query: (filter: CommitFilter) => Promise<Commit[]>;
    getStats: (filter: CommitFilter) => Promise<CommitStats>;
  };

  preferences: {
    get: () => Promise<UserPreferences>;
    save: (prefs: UserPreferences) => Promise<void>;
    clearAll: () => Promise<void>;
  };

  localRepositories: {
    selectDirectory: () => Promise<string | null>;
    scan: (directoryPath: string) => Promise<ScanResult>;
    import: (repositories: LocalRepositoryInfo[]) => Promise<void>;
    refresh: (repoId: string) => Promise<void>;
    remove: (repoId: string) => Promise<void>;
    checkGit: () => Promise<boolean>;
  };

  updates: {
    check: () => Promise<UpdateCheckResult>;
  };

  onImportProgress: (callback: (progress: ImportProgress) => void) => () => void;
  onScanProgress: (callback: (progress: ScanProgress) => void) => () => void;
  onSyncProgress: (callback: (progress: SyncProgress) => void) => () => void;
  onSyncTrigger: (callback: () => void) => () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
