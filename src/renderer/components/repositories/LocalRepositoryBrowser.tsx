import { useState, useEffect, useCallback } from 'react';
import { useElectronAPI } from '../../hooks';
import type { LocalRepositoryInfo, ScanProgress, ScanResult, ImportProgress as ImportProgressType } from '../../../shared/types';
import './LocalRepositoryBrowser.css';

interface LocalRepositoryBrowserProps {
  onImportComplete?: () => void;
}

type BrowserState = 'idle' | 'scanning' | 'selecting' | 'importing';

/**
 * Main component for browsing and importing local repositories.
 * Manages the flow: directory selection -> scanning -> selection -> import
 */
export function LocalRepositoryBrowser({ onImportComplete }: LocalRepositoryBrowserProps): JSX.Element {
  const api = useElectronAPI();
  
  // State management
  const [gitAvailable, setGitAvailable] = useState<boolean | null>(null);
  const [selectedDirectory, setSelectedDirectory] = useState<string | null>(null);
  const [browserState, setBrowserState] = useState<BrowserState>('idle');
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [selectedRepos, setSelectedRepos] = useState<LocalRepositoryInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [importProgress, setImportProgress] = useState<Map<string, ImportProgressType>>(new Map());

  // Check git availability on mount
  useEffect(() => {
    if (!api) return;

    const checkGit = async () => {
      try {
        const available = await api.localRepositories.checkGit();
        setGitAvailable(available);
      } catch (err) {
        setGitAvailable(false);
        setError('Failed to check git availability');
      }
    };

    checkGit();
  }, [api]);

  // Listen for scan progress events
  useEffect(() => {
    if (!api) return;

    const unsubscribe = api.onScanProgress((progress) => {
      setScanProgress(progress);
    });

    return unsubscribe;
  }, [api]);

  // Listen for import progress events
  useEffect(() => {
    if (!api) return;

    const unsubscribe = api.onImportProgress((p) => {
      setImportProgress(prev => new Map(prev).set(p.repositoryId, p));
    });

    return unsubscribe;
  }, [api]);

  // Handle directory selection
  const handleSelectDirectory = useCallback(async () => {
    if (!api) return;

    setError(null);
    try {
      const directory = await api.localRepositories.selectDirectory();
      if (directory) {
        setSelectedDirectory(directory);
        // Start scanning immediately after selection
        setBrowserState('scanning');
        setScanProgress(null);
        setScanResult(null);
        setSelectedRepos([]);

        const result = await api.localRepositories.scan(directory);
        setScanResult(result);
        setBrowserState('selecting');

        // Auto-select all repositories by default
        setSelectedRepos(result.repositories);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to scan directory');
      setBrowserState('idle');
    }
  }, [api]);

  // Handle repository selection toggle
  const handleToggleRepo = useCallback((repo: LocalRepositoryInfo) => {
    setSelectedRepos(prev => {
      const isSelected = prev.some(r => r.path === repo.path);
      if (isSelected) {
        return prev.filter(r => r.path !== repo.path);
      }
      return [...prev, repo];
    });
  }, []);

  // Handle select all
  const handleSelectAll = useCallback(() => {
    if (scanResult) {
      setSelectedRepos(scanResult.repositories);
    }
  }, [scanResult]);

  // Handle select none
  const handleSelectNone = useCallback(() => {
    setSelectedRepos([]);
  }, []);

  // Handle import
  const handleImport = useCallback(async () => {
    if (!api || selectedRepos.length === 0) return;

    setError(null);
    setImportProgress(new Map());
    setBrowserState('importing');

    try {
      await api.localRepositories.import(selectedRepos);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to import repositories');
      setBrowserState('selecting');
    }
  }, [api, selectedRepos]);

  // Handle reset/cancel
  const handleReset = useCallback(() => {
    setBrowserState('idle');
    setSelectedDirectory(null);
    setScanProgress(null);
    setScanResult(null);
    setSelectedRepos([]);
    setError(null);
  }, []);

  // Display loading state when api is null
  if (!api) {
    return (
      <div className="local-repo-browser">
        <div className="local-repo-browser__loading">Waiting for connection...</div>
      </div>
    );
  }

  // Display loading state while checking git
  if (gitAvailable === null) {
    return (
      <div className="local-repo-browser">
        <div className="local-repo-browser__loading">Checking git availability...</div>
      </div>
    );
  }

  // Display error if git is not available
  if (!gitAvailable) {
    return (
      <div className="local-repo-browser">
        <div className="local-repo-browser__error">
          <span className="local-repo-browser__error-icon">⚠️</span>
          <div className="local-repo-browser__error-content">
            <strong>Git is not installed</strong>
            <p>Git is required to browse local repositories. Please install Git and restart the application.</p>
            <a 
              href="https://git-scm.com/downloads" 
              target="_blank" 
              rel="noopener noreferrer"
              className="local-repo-browser__link"
            >
              Download Git
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="local-repo-browser">
      <div className="local-repo-browser__header">
        <h3>Local Repositories</h3>
        {browserState !== 'idle' && (
          <button 
            type="button" 
            className="local-repo-browser__cancel-btn"
            onClick={handleReset}
          >
            Cancel
          </button>
        )}
      </div>

      {error && (
        <div className="local-repo-browser__error">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {/* Idle state - show directory selection button */}
      {browserState === 'idle' && (
        <div className="local-repo-browser__idle">
          <p>Select a directory to scan for git repositories.</p>
          <button 
            type="button" 
            className="local-repo-browser__select-btn"
            onClick={handleSelectDirectory}
          >
            Select Directory
          </button>
        </div>
      )}

      {/* Scanning state - show progress */}
      {browserState === 'scanning' && (
        <div className="local-repo-browser__scanning">
          <div className="local-repo-browser__spinner" />
          <p>Scanning for repositories...</p>
          {scanProgress && (
            <div className="local-repo-browser__progress">
              <div className="local-repo-browser__progress-stat">
                <span className="local-repo-browser__progress-label">Repositories found:</span>
                <span className="local-repo-browser__progress-value">{scanProgress.repositoriesFound}</span>
              </div>
              <div className="local-repo-browser__progress-stat">
                <span className="local-repo-browser__progress-label">Directories scanned:</span>
                <span className="local-repo-browser__progress-value">{scanProgress.directoriesScanned}</span>
              </div>
              <div className="local-repo-browser__progress-path">
                {scanProgress.currentPath}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Selecting state - show discovered repositories */}
      {browserState === 'selecting' && scanResult && (
        <div className="local-repo-browser__selecting">
          {selectedDirectory && (
            <div className="local-repo-browser__directory">
              <span className="local-repo-browser__directory-label">Scanned:</span>
              <span className="local-repo-browser__directory-path">{selectedDirectory}</span>
            </div>
          )}

          {scanResult.repositories.length === 0 ? (
            <div className="local-repo-browser__empty">
              <p>No git repositories found in the selected directory.</p>
              <button 
                type="button" 
                className="local-repo-browser__select-btn"
                onClick={handleSelectDirectory}
              >
                Select Another Directory
              </button>
            </div>
          ) : (
            <>
              <div className="local-repo-browser__actions">
                <button type="button" onClick={handleSelectAll}>Select All</button>
                <button type="button" onClick={handleSelectNone}>Select None</button>
                <span className="local-repo-browser__count">
                  {selectedRepos.length} of {scanResult.repositories.length} selected
                </span>
              </div>

              <div className="local-repo-browser__items">
                {scanResult.repositories.map(repo => (
                  <label key={repo.path} className="local-repo-browser__item">
                    <input
                      type="checkbox"
                      checked={selectedRepos.some(r => r.path === repo.path)}
                      onChange={() => handleToggleRepo(repo)}
                    />
                    <div className="local-repo-browser__item-info">
                      <span className="local-repo-browser__item-name">
                        {repo.parentFolder ? `${repo.parentFolder}/` : ''}{repo.name}
                      </span>
                      <span className="local-repo-browser__item-path">{repo.path}</span>
                      <span className="local-repo-browser__item-branch">
                        Branch: {repo.defaultBranch}
                      </span>
                    </div>
                  </label>
                ))}
              </div>

              {scanResult.errors.length > 0 && (
                <div className="local-repo-browser__warnings">
                  <details>
                    <summary>{scanResult.errors.length} directories could not be scanned</summary>
                    <ul>
                      {scanResult.errors.map((err, idx) => (
                        <li key={idx}>
                          <strong>{err.path}</strong>: {err.error}
                        </li>
                      ))}
                    </ul>
                  </details>
                </div>
              )}

              <div className="local-repo-browser__footer">
                <button 
                  type="button" 
                  className="local-repo-browser__select-btn"
                  onClick={handleSelectDirectory}
                >
                  Select Different Directory
                </button>
                <button 
                  type="button" 
                  className="local-repo-browser__import-btn"
                  onClick={handleImport}
                  disabled={selectedRepos.length === 0}
                >
                  Import Selected ({selectedRepos.length})
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Importing state - show import progress */}
      {browserState === 'importing' && (
        <div className="local-repo-browser__importing">
          <h4>Import Progress</h4>
          <div className="local-repo-browser__import-items">
            {Array.from(importProgress.values()).map(p => (
              <div 
                key={p.repositoryId} 
                className={`local-repo-browser__import-item local-repo-browser__import-item--${p.status}`}
              >
                <span className="local-repo-browser__import-icon">
                  {p.status === 'pending' && '⏳'}
                  {p.status === 'fetching' && '🔄'}
                  {p.status === 'saving' && '💾'}
                  {p.status === 'complete' && '✅'}
                  {p.status === 'error' && '❌'}
                </span>
                <div className="local-repo-browser__import-info">
                  <span className="local-repo-browser__import-name">{p.repositoryName}</span>
                  <span className="local-repo-browser__import-status">
                    {p.status === 'pending' && 'Waiting...'}
                    {p.status === 'fetching' && (
                      p.commitsFetched 
                        ? `Fetching commits... (${p.commitsFetched} so far)` 
                        : 'Fetching commits...'
                    )}
                    {p.status === 'saving' && `Saving ${p.commitsFetched} commits...`}
                    {p.status === 'complete' && `Imported ${p.commitsFetched} commits`}
                    {p.status === 'error' && (p.error || 'Import failed')}
                  </span>
                </div>
              </div>
            ))}
          </div>

          {importProgress.size > 0 && Array.from(importProgress.values()).every(
            p => p.status === 'complete' || p.status === 'error'
          ) && (
            <div className="local-repo-browser__import-summary">
              <p className="local-repo-browser__import-summary-text">
                Import complete! {Array.from(importProgress.values()).filter(p => p.status === 'complete').length} of {importProgress.size} repositories imported successfully.
                {Array.from(importProgress.values()).some(p => p.status === 'error') && (
                  <span className="local-repo-browser__import-summary-errors">
                    {' '}{Array.from(importProgress.values()).filter(p => p.status === 'error').length} failed.
                  </span>
                )}
              </p>
              {onImportComplete && (
                <button
                  type="button"
                  className="local-repo-browser__continue-btn"
                  onClick={onImportComplete}
                >
                  View Analytics →
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
