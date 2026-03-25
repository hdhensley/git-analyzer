import { useState, useEffect, useMemo } from 'react';
import { useElectronAPI } from '../../hooks';
import type { SCMProvider, Repository } from '../../../shared/types';
import './RepositoryList.css';

interface RepositoryListProps {
  provider: SCMProvider;
  onSelectionChange?: (selected: Repository[]) => void;
}

/**
 * Returns the appropriate icon for a provider
 */
function getProviderIcon(provider: SCMProvider): string {
  switch (provider) {
    case 'github':
      return '🐙'; // GitHub octocat
    case 'bitbucket':
      return '🪣'; // Bitbucket bucket
    default:
      return '📦'; // Generic package
  }
}

export function RepositoryList({ provider, onSelectionChange }: RepositoryListProps) {
  const api = useElectronAPI();
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [searchTerm, setSearchTerm] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set());

  const fetchRepositories = async (pageNum: number, append = false) => {
    // Guard: only call API methods when api is available
    if (!api) return;
    
    try {
      setLoading(true);
      setError(null);
      const result = await api.repositories.list(provider, pageNum);
      
      if (append) {
        setRepositories(prev => {
          const existingIds = new Set(prev.map(r => r.id));
          const newRepos = result.repositories.filter(r => !existingIds.has(r.id));
          return [...prev, ...newRepos];
        });
      } else {
        setRepositories(result.repositories);
      }
      
      setHasMore(result.hasNextPage);
      setPage(pageNum);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch repositories');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Only call fetchRepositories when api is available
    if (api) {
      fetchRepositories(1);
      setSelected(new Set());
      setSelectedProjects(new Set());
    }
  }, [provider, api]);

  const availableProjects = useMemo(() => {
    const projects = new Set<string>();
    for (const repo of repositories) {
      if (repo.parentFolder) projects.add(repo.parentFolder);
    }
    return Array.from(projects).sort();
  }, [repositories]);

  const filteredRepositories = useMemo(() => {
    let result = repositories;
    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase();
      result = result.filter(repo =>
        repo.name.toLowerCase().includes(term) ||
        repo.owner.toLowerCase().includes(term)
      );
    }
    if (selectedProjects.size > 0) {
      result = result.filter(repo =>
        repo.parentFolder != null && selectedProjects.has(repo.parentFolder)
      );
    }
    return result;
  }, [repositories, searchTerm, selectedProjects]);

  const handleToggleProject = (project: string) => {
    setSelectedProjects(prev => {
      const next = new Set(prev);
      if (next.has(project)) {
        next.delete(project);
      } else {
        next.add(project);
      }
      return next;
    });
  };

  const handleLoadMore = () => {
    if (!loading && hasMore) {
      fetchRepositories(page + 1, true);
    }
  };

  const handleToggleSelect = (repo: Repository) => {
    const newSelected = new Set(selected);
    if (newSelected.has(repo.id)) {
      newSelected.delete(repo.id);
    } else {
      newSelected.add(repo.id);
    }
    setSelected(newSelected);
    onSelectionChange?.(repositories.filter(r => newSelected.has(r.id)));
  };

  const handleSelectAll = () => {
    const allIds = new Set(filteredRepositories.map(r => r.id));
    setSelected(allIds);
    onSelectionChange?.(filteredRepositories);
  };

  const handleSelectNone = () => {
    setSelected(new Set());
    onSelectionChange?.([]);
  };

  const selectedInView = filteredRepositories.filter(r => selected.has(r.id)).length;

  const providerName = provider === 'github' ? 'GitHub' : 'Bitbucket';
  const providerIcon = getProviderIcon(provider);

  // Display loading state when api is null
  if (!api) {
    return (
      <div className="repository-list">
        <div className="repository-list__header">
          <h3><span className="repository-list__provider-icon">{providerIcon}</span> {providerName} Repositories</h3>
        </div>
        <div className="repository-list__loading">Waiting for connection...</div>
      </div>
    );
  }

  return (
    <div className="repository-list">
      <div className="repository-list__header">
        <h3><span className="repository-list__provider-icon">{providerIcon}</span> {providerName} Repositories</h3>
        <div className="repository-list__search">
          <input
            type="text"
            placeholder="Search repositories..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="repository-list__search-input"
          />
        </div>
      </div>

      {availableProjects.length > 1 && (
        <div className="repository-list__project-filter">
          <button
            type="button"
            className={`repository-list__project-btn${selectedProjects.size === 0 ? ' repository-list__project-btn--active' : ''}`}
            onClick={() => setSelectedProjects(new Set())}
          >
            All Projects
          </button>
          {availableProjects.map(project => (
            <button
              key={project}
              type="button"
              className={`repository-list__project-btn${selectedProjects.has(project) ? ' repository-list__project-btn--active' : ''}`}
              onClick={() => handleToggleProject(project)}
            >
              {project}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="repository-list__error">
          {error}
          <button type="button" onClick={() => fetchRepositories(1)}>Retry</button>
        </div>
      )}

      {filteredRepositories.length > 0 && (
        <div className="repository-list__actions">
          <button type="button" onClick={handleSelectAll}>Select All</button>
          <button type="button" onClick={handleSelectNone}>Select None</button>
          <span className="repository-list__count">
            {selectedInView} of {filteredRepositories.length} selected
          </span>
        </div>
      )}

      <div className="repository-list__items">
        {filteredRepositories.map(repo => (
          <label key={repo.id} className="repository-list__item">
            <input
              type="checkbox"
              checked={selected.has(repo.id)}
              onChange={() => handleToggleSelect(repo)}
            />
            <div className="repository-list__item-info">
              <span className="repository-list__item-name">{repo.name}</span>
              <span className="repository-list__item-owner">{repo.parentFolder || repo.owner}</span>
            </div>
          </label>
        ))}
      </div>

      {loading && <div className="repository-list__loading">Loading...</div>}

      {hasMore && !loading && (
        <button 
          type="button"
          className="repository-list__load-more"
          onClick={handleLoadMore}
        >
          Load More
        </button>
      )}

      {!loading && filteredRepositories.length === 0 && (
        <div className="repository-list__empty">
          {searchTerm ? 'No repositories match your search' : 'No repositories found'}
        </div>
      )}
    </div>
  );
}
