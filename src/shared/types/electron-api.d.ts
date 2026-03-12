import type { SCMProvider, AuthResult, AuthStatus, RepositoryPage, Repository, ImportedRepository, CommitFilter, Commit, CommitStats, UserPreferences, ImportProgress } from './index';
export interface ElectronAPI {
    auth: {
        authenticate: (provider: SCMProvider) => Promise<AuthResult>;
        getStatus: (provider: SCMProvider) => Promise<AuthStatus>;
        disconnect: (provider: SCMProvider) => Promise<void>;
    };
    repositories: {
        list: (provider: SCMProvider, page: number) => Promise<RepositoryPage>;
        import: (repos: Repository[]) => Promise<void>;
        getImported: () => Promise<ImportedRepository[]>;
        delete: (repoId: string) => Promise<void>;
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
    onImportProgress: (callback: (progress: ImportProgress) => void) => () => void;
}
declare global {
    interface Window {
        electronAPI: ElectronAPI;
    }
}
//# sourceMappingURL=electron-api.d.ts.map