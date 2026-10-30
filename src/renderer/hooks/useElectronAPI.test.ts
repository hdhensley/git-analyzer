/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useElectronAPI } from './useElectronAPI';
import type { ElectronAPI } from '../../shared/types/electron-api';

// window.electronAPI is declared required globally; tests need to remove it,
// so they go through this optional view of window instead of `any`.
const testWindow = () => window as unknown as { electronAPI?: ElectronAPI };

describe('useElectronAPI', () => {
  let originalElectronAPI: ElectronAPI | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    // Store original value
    originalElectronAPI = window.electronAPI;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    // Restore original state
    if (originalElectronAPI !== undefined) {
      window.electronAPI = originalElectronAPI;
    } else {
      delete testWindow().electronAPI;
    }
  });

  const createMockAPI = (): ElectronAPI => ({
    auth: {
      authenticate: vi.fn(),
      authenticateWithToken: vi.fn(),
      isOAuthConfigured: vi.fn(),
      getStatus: vi.fn(),
      disconnect: vi.fn(),
    },
    repositories: {
      list: vi.fn(),
      import: vi.fn(),
      getImported: vi.fn(),
      delete: vi.fn(),
      sync: vi.fn(),
    },
    commits: {
      query: vi.fn(),
      getStats: vi.fn(),
    },
    preferences: {
      get: vi.fn(),
      save: vi.fn(),
      clearAll: vi.fn(),
    },
    localRepositories: {
      selectDirectory: vi.fn(),
      scan: vi.fn(),
      import: vi.fn(),
      refresh: vi.fn(),
      remove: vi.fn(),
      checkGit: vi.fn(),
      branchDivergence: vi.fn(),
    },
    snyk: {
      getStatus: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      getHealth: vi.fn(),
    },
    updates: {
      check: vi.fn(),
    },
    scmCompare: {
      listProjectGroups: vi.fn(),
      listGroupRepositories: vi.fn(),
      selectLocalFolder: vi.fn(),
      compare: vi.fn(),
      cloneRepositories: vi.fn(),
    },
    onImportProgress: vi.fn(),
    onScanProgress: vi.fn(() => () => {}),
    onSyncProgress: vi.fn(() => () => {}),
    onSyncTrigger: vi.fn(() => () => {}),
    onCloneProgress: vi.fn(() => () => {}),
  });

  describe('when window.electronAPI is undefined', () => {
    it('should return null initially', () => {
      delete testWindow().electronAPI;

      const { result } = renderHook(() => useElectronAPI());

      expect(result.current).toBeNull();
    });

    it('should detect API when it becomes available', async () => {
      delete testWindow().electronAPI;

      const { result } = renderHook(() => useElectronAPI());
      expect(result.current).toBeNull();

      // Simulate API becoming available
      const mockAPI = createMockAPI();
      window.electronAPI = mockAPI;

      // Advance timers to trigger the polling interval
      await act(async () => {
        vi.advanceTimersByTime(100);
      });

      expect(result.current).toBe(mockAPI);
    });
  });

  describe('when window.electronAPI is defined', () => {
    it('should return the ElectronAPI object immediately', () => {
      const mockAPI = createMockAPI();
      window.electronAPI = mockAPI;

      const { result } = renderHook(() => useElectronAPI());

      expect(result.current).toBe(mockAPI);
      expect(result.current).not.toBeNull();
    });

    it('should not start polling when API is already available', async () => {
      const mockAPI = createMockAPI();
      window.electronAPI = mockAPI;

      const { result } = renderHook(() => useElectronAPI());

      // Advance timers - should not affect result since API was already available
      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      expect(result.current).toBe(mockAPI);
    });
  });
});
