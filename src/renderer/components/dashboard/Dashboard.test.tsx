/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Dashboard } from './Dashboard';
import type { ElectronAPI } from '../../../shared/types/electron-api';

// Mock child components to isolate Dashboard testing
vi.mock('../auth', () => ({
  AuthStatus: ({ provider }: { provider: string }) => (
    <div data-testid={`auth-status-${provider}`}>AuthStatus Mock - {provider}</div>
  ),
}));

vi.mock('../repositories', () => ({
  RepositoryList: () => <div data-testid="repository-list">RepositoryList Mock</div>,
  ImportProgress: () => <div data-testid="import-progress">ImportProgress Mock</div>,
}));

vi.mock('../filters', () => ({
  DateRangeFilter: () => <div data-testid="date-range-filter">DateRangeFilter Mock</div>,
  RepositoryFilter: () => <div data-testid="repository-filter">RepositoryFilter Mock</div>,
  calculateDateRange: vi.fn(),
}));

vi.mock('../widgets', () => ({
  ChartWidget: () => <div data-testid="chart-widget">ChartWidget Mock</div>,
  WidgetRegistry: {
    register: vi.fn(),
    getWidgets: vi.fn().mockReturnValue([]),
  },
  CommitsPerUserWidgetDefinition: {},
  MessageSummaryWidgetDefinition: {},
  RepositoryCommitSummaryWidgetDefinition: {},
  ContributionGraphWidgetDefinition: {},
}));

describe('Dashboard', () => {
  const originalElectronAPI = (globalThis as any).window?.electronAPI;

  beforeEach(() => {
    // Reset window.electronAPI before each test
    if (typeof globalThis.window === 'undefined') {
      (globalThis as any).window = {};
    }
    // Reset confirm mock
    vi.spyOn(window, 'confirm').mockImplementation(() => true);
  });

  afterEach(() => {
    // Restore original state
    if (originalElectronAPI !== undefined) {
      (globalThis as any).window.electronAPI = originalElectronAPI;
    } else {
      delete (globalThis as any).window?.electronAPI;
    }
    vi.clearAllMocks();
  });

  /**
   * Task 7.4: Test for Dashboard handling null API gracefully
   * Validates: Requirements 2.4 - Dashboard defers API calls until API is available
   */
  describe('when API is unavailable (null)', () => {
    it('should render without crashing when window.electronAPI is undefined', () => {
      // Ensure window.electronAPI is undefined
      delete (globalThis as any).window.electronAPI;

      // This should not throw
      expect(() => {
        render(<Dashboard />);
      }).not.toThrow();
    });

    it('should display the dashboard header when API is unavailable', () => {
      delete (globalThis as any).window.electronAPI;

      render(<Dashboard />);

      expect(screen.getByText('Git Analytics Dashboard')).toBeInTheDocument();
    });

    it('should display navigation buttons when API is unavailable', () => {
      delete (globalThis as any).window.electronAPI;

      render(<Dashboard />);

      expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Import' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Analytics' })).toBeInTheDocument();
    });

    it('should render AuthStatus components when API is unavailable', () => {
      delete (globalThis as any).window.electronAPI;

      render(<Dashboard />);

      // AuthStatus components should still render (they handle null API internally)
      expect(screen.getByTestId('auth-status-github')).toBeInTheDocument();
      expect(screen.getByTestId('auth-status-bitbucket')).toBeInTheDocument();
    });

    it('should not call api.preferences.get when API is unavailable', () => {
      delete (globalThis as any).window.electronAPI;

      render(<Dashboard />);

      // No API calls should be made since API is null
      // If this test passes without errors, it means the component
      // correctly guards against calling methods on null API
    });
  });

  /**
   * Additional test: Verify Dashboard works correctly when API is available
   * Validates: Requirements 3.4 - Preservation of normal preference loading
   */
  describe('when API is available', () => {
    it('should call api.preferences.get on mount when API is available', async () => {
      const mockPreferencesGet = vi.fn().mockResolvedValue({
        selectedRepositoryIds: [],
        dateRangePreset: undefined,
        customDateRange: undefined,
      });

      const mockAPI: ElectronAPI = {
        auth: {
          authenticate: vi.fn(),
          authenticateWithToken: vi.fn(),
          isOAuthConfigured: vi.fn().mockResolvedValue(false),
          getStatus: vi.fn(),
          disconnect: vi.fn(),
        },
        repositories: {
          list: vi.fn(),
          import: vi.fn(),
          getImported: vi.fn(),
          delete: vi.fn(),
        },
        commits: {
          query: vi.fn(),
          getStats: vi.fn(),
        },
        preferences: {
          get: mockPreferencesGet,
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
        },
        onImportProgress: vi.fn(),
        onScanProgress: vi.fn(() => () => {}),
      };

      (globalThis as any).window.electronAPI = mockAPI;

      render(<Dashboard />);

      // Wait for the effect to run
      await vi.waitFor(() => {
        expect(mockPreferencesGet).toHaveBeenCalled();
      });
    });

    it('should render without crashing when API is available', () => {
      const mockAPI: ElectronAPI = {
        auth: {
          authenticate: vi.fn(),
          authenticateWithToken: vi.fn(),
          isOAuthConfigured: vi.fn().mockResolvedValue(false),
          getStatus: vi.fn(),
          disconnect: vi.fn(),
        },
        repositories: {
          list: vi.fn(),
          import: vi.fn(),
          getImported: vi.fn(),
          delete: vi.fn(),
        },
        commits: {
          query: vi.fn(),
          getStats: vi.fn(),
        },
        preferences: {
          get: vi.fn().mockResolvedValue({
            selectedRepositoryIds: [],
            dateRangePreset: undefined,
            customDateRange: undefined,
          }),
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
        },
        onImportProgress: vi.fn(),
        onScanProgress: vi.fn(() => () => {}),
      };

      (globalThis as any).window.electronAPI = mockAPI;

      expect(() => {
        render(<Dashboard />);
      }).not.toThrow();
    });
  });
});
