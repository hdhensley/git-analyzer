import { ipcMain, BrowserWindow, dialog, type IpcMainInvokeEvent } from 'electron';
import { getUpdateService } from './services';
import type { SpaceManager } from './spaces/space-manager';
import type { SpaceContext } from './spaces/space-context';
import type { FetchProgressCallback } from './services/git';
import { auditPipelines, listAwsProfiles } from './services/pipeline-audit';
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
  ScmProjectRepository,
  CloneProgress,
} from '../shared/types';

/**
 * Returns a stand-in for one of the active space's services. Every property
 * access is resolved against whichever space is active at that moment, so
 * handlers registered once at startup never hold a service from a space that
 * has since been closed.
 */
function fromActiveSpace<K extends 'auth' | 'snyk' | 'git' | 'localGit' | 'db'>(
  spaces: SpaceManager,
  key: K
): SpaceContext[K] {
  return new Proxy({} as SpaceContext[K], {
    get(_target, prop) {
      const target = spaces.active()[key] as unknown as Record<string | symbol, unknown>;
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function registerIpcHandlers(spaces: SpaceManager, onSpacesChanged: () => void = () => {}): void {
  // Registers a handler for long-running work that a space switch must not
  // interrupt (the switch is refused while any such handler is running).
  const handleBusy = (
    channel: string,
    label: string,
    listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown // eslint-disable-line @typescript-eslint/no-explicit-any
  ): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      const release = spaces.beginBusy(label);
      try {
        return await listener(event, ...args);
      } finally {
        release();
      }
    });
  };

  const authService = fromActiveSpace(spaces, 'auth');
  const snykService = fromActiveSpace(spaces, 'snyk');
  const gitService = fromActiveSpace(spaces, 'git');
  const db = fromActiveSpace(spaces, 'db');

  // Auth handlers
  handleBusy('auth:authenticate', 'sign-in', async (_event, provider: SCMProvider) => {
    return authService.authenticate(provider);
  });

  handleBusy(
    'auth:authenticateWithToken',
    'sign-in',
    async (
      _event,
      provider: SCMProvider,
      token: string,
      username?: string,
      workspace?: string
    ) => {
      return authService.authenticateWithToken(provider, token, username, workspace);
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

  // Snyk handlers
  ipcMain.handle('snyk:getStatus', async () => {
    return snykService.getStatus();
  });

  ipcMain.handle('snyk:connect', async (_event, token: string, orgId?: string) => {
    return snykService.connect(token, orgId);
  });

  ipcMain.handle('snyk:disconnect', async () => {
    return snykService.disconnect();
  });

  handleBusy('snyk:getHealth', 'a Snyk refresh', async (_event, options?: { force?: boolean }) => {
    return snykService.getHealth(options);
  });

  // Repository handlers
  ipcMain.handle('repositories:list', async (_event, provider: SCMProvider, page: number) => {
    return gitService.listRepositories(provider, page);
  });

  handleBusy('repositories:import', 'an import', async (event, repos: Repository[]) => {
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

  handleBusy('repositories:sync', 'a sync', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    // Local repos first: they're quick on-disk reads, so the bulk of the
    // progress bar moves immediately and the slow network-bound cloud repos
    // run last. Array.sort is stable, so import order is kept within each group.
    const repos = db
      .getImportedRepositories()
      .sort((a, b) => Number(a.provider !== 'local') - Number(b.provider !== 'local'));
    const localGit = fromActiveSpace(spaces, 'localGit');
    let processedRepos = 0;
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
        totalRepos: repos.length,
        processedRepos,
        phase: repo.provider === 'local' ? 'local' : 'cloud',
        step: 'Starting',
      };
      // Sends an in-flight step update for the current repo.
      const reportStep = (step: string) => {
        progress.step = step;
        window?.webContents.send('sync:progress', { ...progress });
      };
      const onFetchProgress: FetchProgressCallback = (info) => {
        if (info.rateLimitRetrySeconds) {
          reportStep(`Rate limited, retrying in ${info.rateLimitRetrySeconds}s`);
        } else if (info.currentPage) {
          const soFar = info.commitsSoFar ? `, ${info.commitsSoFar} so far` : '';
          reportStep(`Fetching commits (page ${info.currentPage}${soFar})`);
        }
      };
      window?.webContents.send('sync:progress', { ...progress });

      try {
        let newCommits = 0;

        if (repo.provider === 'local') {
          reportStep('Checking repository path');
          if (!repo.localPath) {
            progress.status = 'skipped';
            processedRepos += 1;
            progress.processedRepos = processedRepos;
            window?.webContents.send('sync:progress', progress);
            continue;
          }
          const pathExists = await localGit.validateRepositoryPath(repo.localPath);
          if (!pathExists) {
            db.updateRepositoryAvailability(repo.id, false);
            progress.status = 'skipped';
            progress.error = 'Path no longer exists';
            processedRepos += 1;
            progress.processedRepos = processedRepos;
            window?.webContents.send('sync:progress', progress);
            continue;
          }
          db.updateRepositoryAvailability(repo.id, true);
          // Refresh the default branch in case it changed since import.
          reportStep('Checking default branch');
          try {
            const detected = await localGit.detectDefaultBranch(repo.localPath);
            if (detected && detected !== repo.defaultBranch) {
              db.updateRepositoryDefaultBranch(repo.id, detected);
            }
          } catch {
            // Non-fatal: keep the stored default branch.
          }
          reportStep('Reading git log');
          const commits = await localGit.fetchCommits(repo.localPath, repo.lastSyncAt);
          if (commits.length > 0) {
            reportStep(`Saving ${commits.length} commit${commits.length !== 1 ? 's' : ''}`);
            db.saveCommits(repo.id, commits);
            newCommits = commits.length;
          }
        } else {
          // Cloud repo (github/bitbucket)
          try {
            // Refresh the default branch in case it changed on the provider
            // since import. Non-fatal if it can't be fetched.
            reportStep(`Checking default branch on ${repo.provider}`);
            const latestBranch = await gitService.fetchDefaultBranch(repo);
            if (latestBranch && latestBranch !== repo.defaultBranch) {
              db.updateRepositoryDefaultBranch(repo.id, latestBranch);
              // Keep the in-memory repo aligned so this cycle's commit fetch
              // uses the refreshed branch.
              repo.defaultBranch = latestBranch;
            }
            const existingCommitCount = db.getCommitCount(repo.id);
            const fetchResult =
              existingCommitCount === 0
                ? await gitService.fetchGitLog(repo, onFetchProgress)
                : await gitService.fetchNewCommits(repo, repo.lastSyncAt, onFetchProgress);
            if (fetchResult.commits.length > 0) {
              const n = fetchResult.commits.length;
              reportStep(`Saving ${n} commit${n !== 1 ? 's' : ''}`);
              db.saveCommits(repo.id, fetchResult.commits);
              newCommits = fetchResult.commits.length;
            }
          } catch (authErr) {
            // If not authenticated, skip rather than fail the whole sync
            progress.status = 'skipped';
            progress.error = authErr instanceof Error ? authErr.message : 'Auth error';
            processedRepos += 1;
            progress.processedRepos = processedRepos;
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
        processedRepos += 1;
        progress.processedRepos = processedRepos;
        window?.webContents.send('sync:progress', progress);
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        progress.status = 'error';
        progress.error = msg;
        processedRepos += 1;
        progress.processedRepos = processedRepos;
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

  ipcMain.handle('commits:getRepoActivity', async (_event, repositoryIds: string[]) => {
    return db.getRepoActivity(repositoryIds);
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
  const localGitService = fromActiveSpace(spaces, 'localGit');

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

  // Update handlers
  const updateService = getUpdateService();

  ipcMain.handle('updates:check', async () => {
    return updateService.checkForUpdates(true);
  });

  handleBusy('localRepositories:import', 'an import', async (event, repositories: LocalRepositoryInfo[]) => {
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

  ipcMain.handle('localRepositories:branchDivergence', async (_event, repoId: string) => {
    const repo = db.getImportedRepositories().find((r) => r.id === repoId);
    if (!repo || repo.provider !== 'local' || !repo.localPath) {
      return null;
    }
    const pathExists = await localGitService.validateRepositoryPath(repo.localPath);
    if (!pathExists) {
      return null;
    }
    return localGitService.getBranchDivergence(repo.localPath);
  });

  // Space handlers. Switching reloads the renderer so none of its state (sync
  // timers, caches, selections) can carry over from the previous space.
  ipcMain.handle('spaces:list', async () => spaces.listWithConnections());
  ipcMain.handle('spaces:getActive', async () => spaces.getActive());
  ipcMain.handle('spaces:create', async (_event, name: string, color?: string) => {
    const created = spaces.create(name, color);
    onSpacesChanged();
    return created;
  });
  ipcMain.handle('spaces:rename', async (_event, id: string, name: string, color?: string) => {
    const renamed = spaces.rename(id, name, color);
    onSpacesChanged();
    return renamed;
  });
  ipcMain.handle('spaces:switch', async (event, id: string) => {
    spaces.switchTo(id);
    onSpacesChanged();
    BrowserWindow.fromWebContents(event.sender)?.webContents.reload();
  });
  ipcMain.handle('spaces:delete', async (_event, id: string) => {
    await spaces.delete(id);
    onSpacesChanged();
  });
  ipcMain.handle('spaces:duplicate', async (_event, id: string, name: string, color?: string) => {
    const copy = await spaces.duplicate(id, name, color);
    onSpacesChanged();
    return copy;
  });
  ipcMain.handle('spaces:export', async (event, id: string) => {
    const space = spaces.list().find((s) => s.id === id);
    if (!space) throw new Error(`Unknown space: ${id}`);
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: `Export "${space.name}"`,
      defaultPath: `${space.name.replace(/[^\w.-]+/g, '-')}.db`,
      filters: [{ name: 'SQLite database', extensions: ['db'] }],
    };
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    await spaces.exportTo(id, result.filePath);
    return result.filePath;
  });

  ipcMain.handle('spaceSettings:get', async (_event, key: string) => db.getSetting(key));
  ipcMain.handle('spaceSettings:set', async (_event, key: string, value: string | null) => {
    db.setSetting(key, value);
  });

  // Pipeline audit handlers (CDK pipeline + Snyk completeness, deployed-state check)
  ipcMain.handle('pipelineAudit:listProfiles', async () => {
    return listAwsProfiles();
  });

  ipcMain.handle(
    'pipelineAudit:run',
    async (_event, options: { repoIds: string[]; profile?: string }) => {
      const wanted = new Set(options.repoIds);
      const repos = db
        .getImportedRepositories()
        .filter((r) => wanted.has(r.id) && r.provider === 'local' && r.localPath)
        .map((r) => ({ id: r.id, name: r.name, localPath: r.localPath as string }));
      return auditPipelines(repos, options.profile || undefined);
    }
  );

  // SCM-to-local comparison handlers
  // Project groups come from the local cache (imported/synced repositories) so
  // the dropdown is instant and works offline. The per-project repo list used
  // for the comparison is still fetched live (see listGroupRepositories).
  ipcMain.handle('scmCompare:listProjectGroups', async (_event, provider: SCMProvider) => {
    const imported = db.getImportedRepositories();
    return gitService.listCachedScmProjectGroups(provider, imported);
  });

  ipcMain.handle(
    'scmCompare:listGroupRepositories',
    async (_event, provider: SCMProvider, group: string) => {
      return gitService.listScmGroupRepositories(provider, group);
    }
  );

  ipcMain.handle('scmCompare:selectLocalFolder', async () => {
    return localGitService.selectFolder('Select Local Folder to Compare');
  });

  ipcMain.handle(
    'scmCompare:compare',
    async (_event, localFolder: string, repositories: ScmProjectRepository[]) => {
      return localGitService.compareWithLocalFolder(localFolder, repositories);
    }
  );

  handleBusy(
    'scmCompare:cloneRepositories',
    'cloning',
    async (event, localFolder: string, repositories: ScmProjectRepository[]) => {
      const window = BrowserWindow.fromWebContents(event.sender);

      for (const repo of repositories) {
        const progress: CloneProgress = {
          repositoryName: repo.name,
          status: 'cloning',
        };
        window?.webContents.send('clone:progress', progress);

        try {
          // Clone over SSH using the user's existing SSH keys/agent. If SSH is
          // not set up for this host, git fails and we surface the error.
          const result = await localGitService.cloneRepository(
            repo.sshCloneUrl,
            localFolder,
            repo.name
          );
          progress.status = 'complete';
          progress.localPath = result.path;
          window?.webContents.send('clone:progress', progress);
        } catch (error) {
          progress.status = 'error';
          progress.error = error instanceof Error ? error.message : 'Unknown error';
          window?.webContents.send('clone:progress', progress);
        }
      }
    }
  );
}
