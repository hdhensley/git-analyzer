import { ipcMain, BrowserWindow } from 'electron';
import { getAuthService, getGitService, getDatabase, getLocalGitService } from './services';
import type {
  SCMProvider,
  Repository,
  CommitFilter,
  UserPreferences,
  ImportProgress,
  ScanProgress,
  SyncProgress,
  SyncResult,
  LocalRepositoryInfo,
} from '../shared/types';

export function registerIpcHandlers(): void {
  const authService = getAuthService();
  const gitService = getGitService();
  const db = getDatabase();

  // Auth handlers
  ipcMain.handle('auth:authenticate', async (_event, provider: SCMProvider) => {
    return authService.authenticate(provider);
  });

  ipcMain.handle(
    'auth:authenticateWithToken',
    async (_event, provider: SCMProvider, token: string, username?: string) => {
      return authService.authenticateWithToken(provider, token, username);
    }
  );

  ipcMain.handle('auth:isOAuthConfigured', async (_event, provider: SCMProvider) => {
    return authService.isOAuthConfigured(provider);
  });

  ipcMain.handle('auth:getStatus', async (_event, provider: SCMProvider) => {
    return authService.getStatus(provider);
  });

  ipcMain.handle('auth:disconnect', async (_event, provider: SCMProvider) => {
    return authService.disconnect(provider);
  });

  // Repository handlers
  ipcMain.handle('repositories:list', async (_event, provider: SCMProvider, page: number) => {
    return gitService.listRepositories(provider, page);
  });

  ipcMain.handle('repositories:import', async (event, repos: Repository[]) => {
    const window = BrowserWindow.fromWebContents(event.sender);

    for (const repo of repos) {
      const progress: ImportProgress = {
        repositoryId: repo.id,
        repositoryName: repo.name,
        status: 'fetching',
      };

      window?.webContents.send('import:progress', progress);

      try {
        const result = await gitService.fetchGitLog(repo, (info) => {
          if (info.rateLimitRetrySeconds) {
            progress.rateLimitRetrySeconds = info.rateLimitRetrySeconds;
          }
          if (info.currentPage !== undefined) {
            progress.currentPage = info.currentPage;
            progress.rateLimitRetrySeconds = undefined;
          }
          if (info.commitsSoFar !== undefined) {
            progress.commitsFetched = info.commitsSoFar;
          }
          window?.webContents.send('import:progress', { ...progress });
        });

        progress.status = 'saving';
        progress.commitsFetched = result.commits.length;
        window?.webContents.send('import:progress', progress);

        db.saveRepository(repo);
        db.saveCommits(repo.id, result.commits);

        progress.status = 'complete';
        window?.webContents.send('import:progress', progress);
      } catch (error) {
        progress.status = 'error';
        progress.error = error instanceof Error ? error.message : 'Unknown error';
        window?.webContents.send('import:progress', progress);
      }
    }
  });

  ipcMain.handle('repositories:getImported', async () => {
    return db.getImportedRepositories();
  });

  ipcMain.handle('repositories:delete', async (_event, repoId: string) => {
    db.deleteRepository(repoId);
  });

  ipcMain.handle('repositories:sync', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const repos = db.getImportedRepositories();
    const localGit = getLocalGitService();
    const result: SyncResult = {
      totalRepos: repos.length,
      syncedRepos: 0,
      totalNewCommits: 0,
      errors: [],
    };

    for (const repo of repos) {
      const progress: SyncProgress = {
        repositoryId: repo.id,
        repositoryName: repo.name,
        status: 'syncing',
      };
      window?.webContents.send('sync:progress', progress);

      try {
        let newCommits = 0;

        if (repo.provider === 'local') {
          if (!repo.localPath) {
            progress.status = 'skipped';
            window?.webContents.send('sync:progress', progress);
            continue;
          }
          const pathExists = await localGit.validateRepositoryPath(repo.localPath);
          if (!pathExists) {
            db.updateRepositoryAvailability(repo.id, false);
            progress.status = 'skipped';
            progress.error = 'Path no longer exists';
            window?.webContents.send('sync:progress', progress);
            continue;
          }
          db.updateRepositoryAvailability(repo.id, true);
          const commits = await localGit.fetchCommits(repo.localPath, repo.lastSyncAt);
          if (commits.length > 0) {
            db.saveCommits(repo.id, commits);
            newCommits = commits.length;
          }
        } else {
          // Cloud repo (github/bitbucket)
          try {
            const fetchResult = await gitService.fetchNewCommits(repo, repo.lastSyncAt);
            if (fetchResult.commits.length > 0) {
              db.saveCommits(repo.id, fetchResult.commits);
              newCommits = fetchResult.commits.length;
            }
          } catch (authErr) {
            // If not authenticated, skip rather than fail the whole sync
            progress.status = 'skipped';
            progress.error = authErr instanceof Error ? authErr.message : 'Auth error';
            window?.webContents.send('sync:progress', progress);
            result.errors.push({ repoName: repo.name, error: progress.error });
            continue;
          }
        }

        db.updateRepositorySyncTime(repo.id);
        result.syncedRepos++;
        result.totalNewCommits += newCommits;
        progress.status = 'complete';
        progress.newCommits = newCommits;
        window?.webContents.send('sync:progress', progress);
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        progress.status = 'error';
        progress.error = msg;
        window?.webContents.send('sync:progress', progress);
        result.errors.push({ repoName: repo.name, error: msg });
      }
    }

    return result;
  });

  // Commit handlers
  ipcMain.handle('commits:query', async (_event, filter: CommitFilter) => {
    return db.getCommits(filter);
  });

  ipcMain.handle('commits:getStats', async (_event, filter: CommitFilter) => {
    const commits = db.getCommits(filter);
    const authors = new Set(commits.map((c) => c.authorEmail));
    const dates = commits.map((c) => c.date.getTime());

    return {
      totalCommits: commits.length,
      authorCount: authors.size,
      dateRange:
        commits.length > 0
          ? {
              earliest: new Date(Math.min(...dates)),
              latest: new Date(Math.max(...dates)),
            }
          : { earliest: new Date(), latest: new Date() },
    };
  });

  // Preferences handlers
  ipcMain.handle('preferences:get', async () => {
    return db.getPreferences();
  });

  ipcMain.handle('preferences:save', async (_event, prefs: UserPreferences) => {
    db.savePreferences(prefs);
  });

  ipcMain.handle('preferences:clearAll', async () => {
    db.clearAllData();
  });

  // Local repository handlers
  const localGitService = getLocalGitService();

  ipcMain.handle('localRepositories:selectDirectory', async () => {
    return localGitService.selectDirectory();
  });

  ipcMain.handle('localRepositories:scan', async (event, directoryPath: string) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return localGitService.scanForRepositories(directoryPath, (progress: ScanProgress) => {
      window?.webContents.send('scan:progress', progress);
    });
  });

  ipcMain.handle('localRepositories:checkGit', async () => {
    return localGitService.isGitAvailable();
  });

  ipcMain.handle('localRepositories:import', async (event, repositories: LocalRepositoryInfo[]) => {
    const window = BrowserWindow.fromWebContents(event.sender);

    for (const repoInfo of repositories) {
      const repoId = localGitService.generateRepositoryId(repoInfo.path);

      const progress: ImportProgress = {
        repositoryId: repoId,
        repositoryName: repoInfo.name,
        status: 'pending',
      };

      // If repo with same localPath exists, clear it for re-import
      const existingRepos = db.getImportedRepositories();
      const existing = existingRepos.find((r) => r.localPath === repoInfo.path);

      if (existing) {
        db.deleteRepository(existing.id);
      }

      progress.status = 'fetching';
      window?.webContents.send('import:progress', progress);

      try {
        const commits = await localGitService.fetchCommits(repoInfo.path);

        progress.status = 'saving';
        progress.commitsFetched = commits.length;
        window?.webContents.send('import:progress', progress);

        const repo: Repository = {
          id: repoId,
          name: repoInfo.name,
          owner: 'local',
          provider: 'local',
          defaultBranch: repoInfo.defaultBranch,
          url: `file://${repoInfo.path}`,
          localPath: repoInfo.path,
          parentFolder: repoInfo.parentFolder,
        };

        db.saveRepository(repo);
        db.saveCommits(repoId, commits);

        progress.status = 'complete';
        window?.webContents.send('import:progress', progress);
      } catch (error) {
        progress.status = 'error';
        progress.error = error instanceof Error ? error.message : 'Unknown error';
        window?.webContents.send('import:progress', progress);
      }
    }
  });

  ipcMain.handle('localRepositories:refresh', async (_event, repoId: string) => {
    // Get repository from database
    const repos = db.getImportedRepositories();
    const repo = repos.find((r) => r.id === repoId);

    if (!repo || !repo.localPath) {
      throw new Error('Repository not found or not a local repository');
    }

    // Validate path still exists
    const pathExists = await localGitService.validateRepositoryPath(repo.localPath);

    if (!pathExists) {
      db.updateRepositoryAvailability(repoId, false);
      throw new Error('Repository path no longer exists');
    }

    // Ensure repository is marked as available
    db.updateRepositoryAvailability(repoId, true);

    // Fetch commits since last sync
    const newCommits = await localGitService.fetchCommits(repo.localPath, repo.lastSyncAt);

    // Save new commits
    if (newCommits.length > 0) {
      db.saveCommits(repoId, newCommits);
    }

    // Update sync timestamp
    db.updateRepositorySyncTime(repoId);

    return { newCommitsCount: newCommits.length };
  });

  ipcMain.handle('localRepositories:remove', async (_event, repoId: string) => {
    // Delete repository from database (commits are deleted via CASCADE)
    db.deleteRepository(repoId);
  });
}
