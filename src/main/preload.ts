import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type { ElectronAPI } from '../shared/types/electron-api';
import type { LocalRepositoryInfo, ScanProgress } from '../shared/types';

const electronAPI: ElectronAPI = {
  auth: {
    authenticate: (provider) => ipcRenderer.invoke('auth:authenticate', provider),
    authenticateWithToken: (provider, token, username) => ipcRenderer.invoke('auth:authenticateWithToken', provider, token, username),
    isOAuthConfigured: (provider) => ipcRenderer.invoke('auth:isOAuthConfigured', provider),
    getStatus: (provider) => ipcRenderer.invoke('auth:getStatus', provider),
    disconnect: (provider) => ipcRenderer.invoke('auth:disconnect', provider),
  },

  repositories: {
    list: (provider, page) => ipcRenderer.invoke('repositories:list', provider, page),
    import: (repos) => ipcRenderer.invoke('repositories:import', repos),
    getImported: () => ipcRenderer.invoke('repositories:getImported'),
    delete: (repoId) => ipcRenderer.invoke('repositories:delete', repoId),
  },

  commits: {
    query: (filter) => ipcRenderer.invoke('commits:query', filter),
    getStats: (filter) => ipcRenderer.invoke('commits:getStats', filter),
  },

  preferences: {
    get: () => ipcRenderer.invoke('preferences:get'),
    save: (prefs) => ipcRenderer.invoke('preferences:save', prefs),
    clearAll: () => ipcRenderer.invoke('preferences:clearAll'),
  },

  localRepositories: {
    selectDirectory: () => ipcRenderer.invoke('localRepositories:selectDirectory'),
    scan: (directoryPath: string) => ipcRenderer.invoke('localRepositories:scan', directoryPath),
    import: (repositories: LocalRepositoryInfo[]) => ipcRenderer.invoke('localRepositories:import', repositories),
    refresh: (repoId: string) => ipcRenderer.invoke('localRepositories:refresh', repoId),
    remove: (repoId: string) => ipcRenderer.invoke('localRepositories:remove', repoId),
    checkGit: () => ipcRenderer.invoke('localRepositories:checkGit'),
  },

  onImportProgress: (callback) => {
    const subscription = (_event: Electron.IpcRendererEvent, progress: unknown) => {
      callback(progress as Parameters<typeof callback>[0]);
    };
    ipcRenderer.on('import:progress', subscription);
    return () => {
      ipcRenderer.removeListener('import:progress', subscription);
    };
  },

  onScanProgress: (callback: (progress: ScanProgress) => void) => {
    const handler = (_event: IpcRendererEvent, progress: ScanProgress) => callback(progress);
    ipcRenderer.on('scan:progress', handler);
    return () => ipcRenderer.removeListener('scan:progress', handler);
  },
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
