import { useState, useEffect, useMemo } from 'react';
import { useElectronAPI } from '../../hooks';
import type { ImportedRepository, RepositorySource } from '../../../shared/types';
import './RepositoryFilter.css';

interface RepositoryFilterProps {
  selectedIds: string[];
  onChange: (selectedIds: string[]) => void;
}

type SourceFilterOption = RepositorySource | 'all';

/**
 * Returns the appropriate icon/badge for a repository based on its provider
 */
function getProviderIcon(provider: RepositorySource): string {
  switch (provider) {
    case 'github':
      return '🐙'; // GitHub octocat
    case 'bitbucket':
      return '🪣'; // Bitbucket bucket
    case 'local':
      return '📁'; // Local folder
    default:
      return '📦'; // Generic package
  }
}

/**
 * Returns the display label for a repository provider
 */
function getProviderLabel(provider: RepositorySource): string {
  switch (provider) {
    case 'github':
      return 'GitHub';
    case 'bitbucket':
      return 'Bitbucket';
    case 'local':
      return 'Local';
    default:
      return provider;
  }
}

export function RepositoryFilter({ selectedIds, onChange }: RepositoryFilterProps) {
  const api = useElectronAPI();
  const [repositories, setRepositories] = useState<ImportedRepository[]>([]);
  const [loading, setLoading] = useState(true);
  const [sourceFilter, setSourceFilter] = useState<SourceFilterOption>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [folderFilter, setFolderFilter] = useState<string>('all');

  // Derive unique parent folders from visible repositories (after source filter)
  const availableFolders = useMemo(() => {
    const sourceFiltered = sourceFilter === 'all'
      ? repositories
      : repositories.filter(r => r.provider === sourceFilter);
    const folders = new Set<string>();
    for (const r of sourceFiltered) {
      if (r.parentFolder) folders.add(r.parentFolder);
    }
    return Array.from(folders).sort((a, b) => a.localeCompare(b));
  }, [repositories, sourceFilter]);

  // Reset folder filter when it's no longer valid
  useEffect(() => {
    if (folderFilter !== 'all' && !availableFolders.includes(folderFilter)) {
      setFolderFilter('all');
    }
  }, [availableFolders, folderFilter]);

  // Filter repositories by source, folder, search query, and sort alphabetically
  const filteredRepositories = useMemo(() => {
    let filtered = sourceFilter === 'all' 
      ? repositories 
      : repositories.filter(r => r.provider === sourceFilter);

    if (folderFilter !== 'all') {
      filtered = filtered.filter(r => r.parentFolder === folderFilter);
    }
    
    const searched = searchQuery.trim()
      ? filtered.filter(r => 
          r.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (r.parentFolder && r.parentFolder.toLowerCase().includes(searchQuery.toLowerCase()))
        )
      : filtered;
    
    return searched.sort((a, b) => a.name.localeCompare(b.name));
  }, [repositories, sourceFilter, folderFilter, searchQuery]);

  useEffect(() => {
    // Only call loadRepositories when api is available
    if (api) {
      loadRepositories();
    }
  }, [api]);

  const loadRepositories = async () => {
    // Guard: only call API methods when api is available
    if (!api) return;
    
    try {
      setLoading(true);
      const repos = await api.repositories.getImported();
      setRepositories(repos);
    } catch (err) {
      console.error('Failed to load repositories:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleToggle = (repoId: string) => {
    const newSelected = selectedIds.includes(repoId)
      ? selectedIds.filter(id => id !== repoId)
      : [...selectedIds, repoId];
    onChange(newSelected);
  };

  const handleSelectAll = () => {
    // Only select available repositories from the filtered list
    const availableRepos = filteredRepositories.filter(r => r.provider !== 'local' || r.isAvailable !== false);
    onChange(availableRepos.map(r => r.id));
  };

  const handleSelectNone = () => {
    onChange([]);
  };

  const handleRemove = async (repo: ImportedRepository, event: React.MouseEvent) => {
    // Prevent the click from toggling the checkbox
    event.preventDefault();
    event.stopPropagation();

    const isLocal = repo.provider === 'local';
    const message = isLocal
      ? `Remove "${repo.name}" from tracking?\n\nThis will delete the repository record and all associated commits from the database.\n\nThe actual git repository on your filesystem will NOT be affected.`
      : `Remove "${repo.name}" from tracking?\n\nThis will delete the repository record and all associated commits from the database.`;

    if (!api) return;

    if (window.confirm(message)) {
      try {
        if (isLocal) {
          await api.localRepositories.remove(repo.id);
        } else {
          await api.repositories.delete(repo.id);
        }
        // Refresh the list
        await loadRepositories();
        // Update selection if removed repo was selected
        if (selectedIds.includes(repo.id)) {
          onChange(selectedIds.filter(id => id !== repo.id));
        }
      } catch (err) {
        console.error('Failed to remove repository:', err);
      }
    }
  };

  // Display loading state when api is null
  if (!api) {
    return <div className="repository-filter repository-filter--loading">Waiting for connection...</div>;
  }

  if (loading) {
    return <div className="repository-filter repository-filter--loading">Loading repositories...</div>;
  }

  if (repositories.length === 0) {
    return (
      <div className="repository-filter repository-filter--empty">
        No imported repositories. Import some repositories to see analytics.
      </div>
    );
  }

  return (
    <div className="repository-filter">
      <div className="repository-filter__header">
        <span className="repository-filter__title">Repositories</span>
        <div className="repository-filter__actions">
          <button type="button" onClick={handleSelectAll}>All</button>
          <button type="button" onClick={handleSelectNone}>None</button>
        </div>
      </div>

      <div className="repository-filter__source-filter">
        <button 
          type="button" 
          className={`repository-filter__source-btn ${sourceFilter === 'all' ? 'repository-filter__source-btn--active' : ''}`}
          onClick={() => setSourceFilter('all')}
        >
          All
        </button>
        <button 
          type="button" 
          className={`repository-filter__source-btn ${sourceFilter === 'local' ? 'repository-filter__source-btn--active' : ''}`}
          onClick={() => setSourceFilter('local')}
        >
          📁 Local
        </button>
        <button 
          type="button" 
          className={`repository-filter__source-btn ${sourceFilter === 'github' ? 'repository-filter__source-btn--active' : ''}`}
          onClick={() => setSourceFilter('github')}
        >
          🐙 GitHub
        </button>
        <button 
          type="button" 
          className={`repository-filter__source-btn ${sourceFilter === 'bitbucket' ? 'repository-filter__source-btn--active' : ''}`}
          onClick={() => setSourceFilter('bitbucket')}
        >
          🪣 Bitbucket
        </button>
      </div>

      {availableFolders.length > 0 && (
        <div className="repository-filter__folder-filter">
          <button 
            type="button" 
            className={`repository-filter__source-btn ${folderFilter === 'all' ? 'repository-filter__source-btn--active' : ''}`}
            onClick={() => setFolderFilter('all')}
          >
            All Folders
          </button>
          {availableFolders.map(folder => (
            <button 
              key={folder}
              type="button" 
              className={`repository-filter__source-btn ${folderFilter === folder ? 'repository-filter__source-btn--active' : ''}`}
              onClick={() => setFolderFilter(folder)}
            >
              📂 {folder}
            </button>
          ))}
        </div>
      )}

      <div className="repository-filter__search">
        <input
          type="text"
          placeholder="Search repositories..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="repository-filter__search-input"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => setSearchQuery('')}
            className="repository-filter__search-clear"
            aria-label="Clear search"
          >
            ✕
          </button>
        )}
      </div>

      <div className="repository-filter__list">
        {filteredRepositories.length === 0 && sourceFilter !== 'all' && !searchQuery ? (
          <div className="repository-filter__empty-filter">
            No {getProviderLabel(sourceFilter)} repositories found.
          </div>
        ) : filteredRepositories.length === 0 && searchQuery ? (
          <div className="repository-filter__empty-filter">
            No repositories match "{searchQuery}"
          </div>
        ) : (
          filteredRepositories.map(repo => {
          const isLocal = repo.provider === 'local';
          const isUnavailable = isLocal && repo.isAvailable === false;
          
          return (
            <label 
              key={repo.id} 
              className={`repository-filter__item ${isUnavailable ? 'repository-filter__item--unavailable' : ''}`}
              title={isUnavailable ? `Path no longer exists: ${repo.localPath}` : repo.name}
            >
              <input
                type="checkbox"
                checked={selectedIds.includes(repo.id)}
                onChange={() => handleToggle(repo.id)}
                disabled={isUnavailable}
              />
              <div className="repository-filter__item-content">
                <div className="repository-filter__item-row">
                  <span className="repository-filter__name" title={repo.name}>
                    {repo.name}
                  </span>
                  {isUnavailable && (
                    <span className="repository-filter__unavailable-icon" title="Path no longer exists">
                      ⚠️
                    </span>
                  )}
                  <button
                    type="button"
                    className="repository-filter__remove-btn"
                    onClick={(e) => handleRemove(repo, e)}
                    title={`Remove ${repo.name} from tracking`}
                    aria-label={`Remove ${repo.name} from tracking`}
                  >
                    ✕
                  </button>
                </div>
                <div className="repository-filter__item-meta">
                  <span className={`repository-filter__badge repository-filter__badge--${repo.provider}`}>
                    {getProviderLabel(repo.provider)}
                  </span>
                  {repo.parentFolder && (
                    <span className="repository-filter__badge repository-filter__badge--folder">
                      {repo.parentFolder}
                    </span>
                  )}
                  <span className="repository-filter__count">{repo.commitCount} commits</span>
                </div>
              </div>
            </label>
          );
        })
        )}
      </div>

      {selectedIds.length === 0 && (
        <div className="repository-filter__warning">
          Select at least one repository to view analytics
        </div>
      )}
    </div>
  );
}
