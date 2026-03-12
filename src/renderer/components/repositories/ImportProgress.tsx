import { useState, useEffect } from 'react';
import { useElectronAPI } from '../../hooks';
import type { Repository, ImportProgress as ImportProgressType } from '../../../shared/types';
import './ImportProgress.css';

interface ImportProgressProps {
  repositories: Repository[];
  onComplete?: () => void;
  onRetry?: (repo: Repository) => void;
}

export function ImportProgress({ repositories, onComplete, onRetry }: ImportProgressProps) {
  const api = useElectronAPI();
  const [progress, setProgress] = useState<Map<string, ImportProgressType>>(new Map());
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    // Guard: only subscribe to import progress when api is available
    if (!api) return;

    const unsubscribe = api.onImportProgress((p) => {
      setProgress(prev => new Map(prev).set(p.repositoryId, p));
    });

    return unsubscribe;
  }, [api]);

  useEffect(() => {
    // Guard: only start import when api is available
    if (api && repositories.length > 0 && !importing) {
      startImport();
    }
  }, [repositories, api]);

  const startImport = async () => {
    // Guard: only call API methods when api is available
    if (!api) return;

    setImporting(true);
    const initialProgress = new Map<string, ImportProgressType>();
    repositories.forEach(repo => {
      initialProgress.set(repo.id, {
        repositoryId: repo.id,
        repositoryName: repo.name,
        status: 'pending',
      });
    });
    setProgress(initialProgress);

    try {
      await api.repositories.import(repositories);
    } finally {
      setImporting(false);
    }
  };

  const allComplete = Array.from(progress.values()).every(
    p => p.status === 'complete' || p.status === 'error'
  );

  const getStatusIcon = (p: ImportProgressType) => {
    if (p.status === 'fetching' && p.rateLimitRetrySeconds) return '⏱️';
    switch (p.status) {
      case 'pending': return '⏳';
      case 'fetching': return '🔄';
      case 'saving': return '💾';
      case 'complete': return '✅';
      case 'error': return '❌';
    }
  };

  const getStatusText = (p: ImportProgressType) => {
    switch (p.status) {
      case 'pending': return 'Waiting...';
      case 'fetching': {
        if (p.rateLimitRetrySeconds) {
          return `Rate limited — retrying in ${p.rateLimitRetrySeconds}s...`;
        }
        const parts: string[] = [];
        if (p.currentPage) parts.push(`page ${p.currentPage}`);
        if (p.commitsFetched) parts.push(`${p.commitsFetched} commits`);
        return parts.length > 0
          ? `Fetching commits... (${parts.join(', ')})`
          : 'Fetching commits...';
      }
      case 'saving': return `Saving ${p.commitsFetched} commits...`;
      case 'complete': return `Imported ${p.commitsFetched} commits`;
      case 'error': return p.error || 'Import failed';
    }
  };

  // Display loading state when api is null
  if (!api) {
    return (
      <div className="import-progress">
        <h3>Import Progress</h3>
        <div className="import-progress__loading">Waiting for connection...</div>
      </div>
    );
  }

  return (
    <div className="import-progress">
      <h3>Import Progress</h3>
      
      <div className="import-progress__items">
        {Array.from(progress.values()).map(p => (
          <div 
            key={p.repositoryId} 
            className={`import-progress__item import-progress__item--${p.status}`}
          >
            <span className="import-progress__icon">{getStatusIcon(p)}</span>
            <div className="import-progress__info">
              <span className="import-progress__name">{p.repositoryName}</span>
              <span className="import-progress__status">{getStatusText(p)}</span>
            </div>
            {p.status === 'error' && onRetry && (
              <button
                type="button"
                className="import-progress__retry"
                onClick={() => {
                  const repo = repositories.find(r => r.id === p.repositoryId);
                  if (repo) onRetry(repo);
                }}
              >
                Retry
              </button>
            )}
          </div>
        ))}
      </div>

      {allComplete && (
        <div className="import-progress__summary">
          <p className="import-progress__summary-text">
            Import complete! {Array.from(progress.values()).filter(p => p.status === 'complete').length} of {progress.size} repositories imported successfully.
            {Array.from(progress.values()).some(p => p.status === 'error') && (
              <span className="import-progress__summary-errors">
                {' '}{Array.from(progress.values()).filter(p => p.status === 'error').length} failed.
              </span>
            )}
          </p>
          {onComplete && (
            <button
              type="button"
              className="import-progress__continue-btn"
              onClick={onComplete}
            >
              View Analytics →
            </button>
          )}
        </div>
      )}
    </div>
  );
}
