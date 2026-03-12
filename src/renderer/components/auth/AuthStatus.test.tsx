/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AuthStatus } from './AuthStatus';
import type { ElectronAPI } from '../../../shared/types/electron-api';

describe('AuthStatus', () => {
  const originalElectronAPI = (globalThis as any).window?.electronAPI;

  beforeEach(() => {
    // Reset window.electronAPI before each test
    if (typeof globalThis.window === 'undefined') {
      (globalThis as any).window = {};
    }
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
   * Task 7.3: Test for AuthStatus displaying loading state when API is unavailable
   * Validates: Requirements 2.3 - AuthStatus displays loading state when API is null
   */
  describe('when API is unavailable (null)', () => {
    it('should display "Waiting for connection..." when window.electronAPI is undefined', () => {
      // Ensure window.electronAPI is undefined
      delete (globalThis as any).window.electronAPI;

      render(<AuthStatus provider="github" />);

      expect(screen.getByText('Waiting for connection...')).toBeInTheDocument();
      expect(screen.getByText('GitHub')).toBeInTheDocument();
    });

    it('should display "Waiting for connection..." for Bitbucket provider when API is unavailable', () => {
      delete (globalThis as any).window.electronAPI;

      render(<AuthStatus provider="bitbucket" />);

      expect(screen.getByText('Waiting for connection...')).toBeInTheDocument();
      expect(screen.getByText('Bitbucket')).toBeInTheDocument();
    });

    it('should not crash or throw errors when API is unavailable', () => {
      delete (globalThis as any).window.electronAPI;

      // This should not throw
      expect(() => {
        render(<AuthStatus provider="github" />);
      }).not.toThrow();
    });

    it('should have the disconnected CSS class when API is unavailable', () => {
      delete (globalThis as any).window.electronAPI;

      const { container } = render(<AuthStatus provider="github" />);

      const authStatusDiv = container.querySelector('.auth-status');
      expect(authStatusDiv).toHaveClass('auth-status--disconnected');
    });

    it('should display a Retry button when API is unavailable', () => {
      delete (globalThis as any).window.electronAPI;

      render(<AuthStatus provider="github" />);

      expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    });
  });

  /**
   * Additional test: Verify AuthStatus works correctly when API is available
   * Validates: Requirements 3.2 - Preservation of normal behavior
   */
  describe('when API is available', () => {
    it('should display "Loading..." initially while fetching status', async () => {
      const mockAPI: ElectronAPI = {
        auth: {
          authenticate: vi.fn(),
          authenticateWithToken: vi.fn(),
          isOAuthConfigured: vi.fn().mockResolvedValue(false),
          getStatus: vi.fn().mockImplementation(() => new Promise(() => {})), // Never resolves
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
        },
        onImportProgress: vi.fn(),
        onScanProgress: vi.fn(() => () => {}),
      };

      (globalThis as any).window.electronAPI = mockAPI;

      render(<AuthStatus provider="github" />);

      expect(screen.getByText('Loading...')).toBeInTheDocument();
    });

    it('should call api.auth.getStatus when API is available', async () => {
      const mockGetStatus = vi.fn().mockResolvedValue({
        connected: true,
        provider: 'github',
        username: 'testuser',
      });

      const mockAPI: ElectronAPI = {
        auth: {
          authenticate: vi.fn(),
          authenticateWithToken: vi.fn(),
          isOAuthConfigured: vi.fn().mockResolvedValue(false),
          getStatus: mockGetStatus,
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
        },
        onImportProgress: vi.fn(),
        onScanProgress: vi.fn(() => () => {}),
      };

      (globalThis as any).window.electronAPI = mockAPI;

      render(<AuthStatus provider="github" />);

      // Wait for the effect to run
      await vi.waitFor(() => {
        expect(mockGetStatus).toHaveBeenCalledWith('github');
      });
    });
  });
});
