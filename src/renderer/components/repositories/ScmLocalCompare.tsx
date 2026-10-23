import { useState, useEffect, useCallback, useMemo } from 'react';
import { useElectronAPI } from '../../hooks';
import type {
  SCMProvider,
  ScmProjectGroup,
  ScmProjectRepository,
  ScmLocalComparison,
  CloneProgress,
} from '../../../shared/types';
import './ScmLocalCompare.css';

interface ScmLocalCompareProps {
  githubConnected: boolean;
  bitbucketConnected: boolean;
  onConnectClick?: () => void;
}

type Phase = 'idle' | 'loading-groups' | 'loading-repos' | 'ready' | 'cloning';

function providerLabel(provider: SCMProvider): string {
  return provider === 'github' ? 'GitHub' : 'Bitbucket';
}

function providerIcon(provider: SCMProvider): string {
  return provider === 'github' ? '🐙' : '🪣';
}

/**
 * Compares a chosen SCM project group (Bitbucket project / GitHub owner)
 * against a local folder, showing which repositories are present locally and
 * which are missing, and allows cloning the missing ones into the folder.
 *
 * Mirrors the Analytics RepositoryFilter interface: pick a source, then a
 * project group within it.
 */
export function ScmLocalCompare({
  githubConnected,
  bitbucketConnected,
  onConnectClick,
}: ScmLocalCompareProps): JSX.Element {
  const api = useElectronAPI();

  const [gitAvailable, setGitAvailable] = useState<boolean | null>(null);
  const [provider, setProvider] = useState<SCMProvider | null>(null);
  const [groups, setGroups] = useState<ScmProjectGroup[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<string>('');
  // Repositories loaded for the selected group. Kept in its own state so the
  // folder-selection handler never reads a stale `comparison` snapshot.
  const [groupRepos, setGroupRepos] = useState<ScmProjectRepository[]>([]);
  const [localFolder, setLocalFolder] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [comparison, setComparison] = useState<ScmLocalComparison | null>(null);
  const [cloneProgress, setCloneProgress] = useState<Map<string, CloneProgress>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const connectedProviders = useMemo<SCMProvider[]>(() => {
    const list: SCMProvider[] = [];
    if (githubConnected) list.push('github');
    if (bitbucketConnected) list.push('bitbucket');
    return list;
  }, [githubConnected, bitbucketConnected]);

  // Check git availability on mount.
  useEffect(() => {
    if (!api) return;
    api.localRepositories
      .checkGit()
      .then(setGitAvailable)
      .catch(() => setGitAvailable(false));
  }, [api]);

  // Default the source to the first connected provider.
  useEffect(() => {
    if (provider === null && connectedProviders.length > 0) {
      setProvider(connectedProviders[0]);
    }
  }, [connectedProviders, provider]);

  // Load project groups whenever the selected provider changes.
  useEffect(() => {
    if (!api || !provider) return;
    setPhase('loading-groups');
    setError(null);
    setGroups([]);
    setSelectedGroup('');
    setGroupRepos([]);
    setLocalFolder(null);
    setComparison(null);
    setCloneProgress(new Map());
    api.scmCompare
      .listProjectGroups(provider)
      .then((result) => setGroups(result))
      .catch((err) =>
        setError(err instanceof Error ? err.message : `Failed to load ${providerLabel(provider)} projects`)
      )
      .finally(() => setPhase('ready'));
  }, [api, provider]);

  // Listen for clone progress.
  useEffect(() => {
    if (!api) return;
    const unsubscribe = api.onCloneProgress((p) => {
      setCloneProgress((prev) => new Map(prev).set(p.repositoryName, p));
    });
    return unsubscribe;
  }, [api]);

  const runComparison = useCallback(
    async (folder: string, repos: ScmProjectRepository[]) => {
      if (!api) return;
      try {
        const result = await api.scmCompare.compare(folder, repos);
        setComparison(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to compare with local folder');
      }
    },
    [api]
  );

  const handleGroupChange = useCallback(
    async (group: string) => {
      setSelectedGroup(group);
      // Changing the project clears the chosen folder and any prior comparison
      // so a stale folder/comparison can't carry over to a different project.
      setLocalFolder(null);
      setGroupRepos([]);
      setComparison(null);
      setCloneProgress(new Map());
      if (!api || !provider || !group) return;

      setPhase('loading-repos');
      setError(null);
      try {
        const repos = await api.scmCompare.listGroupRepositories(provider, group);
        setGroupRepos(repos);
        setPhase('ready');
        // Render the repo list before a folder is picked; everything shows as
        // uncompared until a folder is selected.
        setComparison({
          localFolder: '',
          entries: repos.map((repository) => ({ repository, present: false })),
          localOnly: [],
        });
      } catch (err) {
        setPhase('ready');
        setError(err instanceof Error ? err.message : 'Failed to load repositories');
      }
    },
    [api, provider]
  );

  const handleSelectFolder = useCallback(async () => {
    if (!api || groupRepos.length === 0) return;
    setError(null);
    const folder = await api.scmCompare.selectLocalFolder();
    if (!folder) return;
    setLocalFolder(folder);
    setCloneProgress(new Map());
    // Compare against the repos loaded for the current group. Reading from
    // groupRepos (not `comparison`) avoids a stale-closure snapshot.
    await runComparison(folder, groupRepos);
  }, [api, groupRepos, runComparison]);

  const repositories = useMemo(
    () => comparison?.entries.map((e) => e.repository) ?? [],
    [comparison]
  );

  const compared = !!comparison?.localFolder;

  const missingEntries = useMemo(
    () => (compared ? (comparison?.entries ?? []).filter((e) => !e.present) : []),
    [comparison, compared]
  );

  const localOnlyEntries = useMemo(
    () => (compared ? (comparison?.localOnly ?? []) : []),
    [comparison, compared]
  );

  const handleCloneOne = useCallback(
    async (repo: ScmProjectRepository) => {
      if (!api || !localFolder) return;
      setPhase('cloning');
      setError(null);
      await api.scmCompare.cloneRepositories(localFolder, [repo]);
      await runComparison(localFolder, groupRepos);
      setPhase('ready');
    },
    [api, localFolder, groupRepos, runComparison]
  );

  const handleCloneAllMissing = useCallback(async () => {
    if (!api || !localFolder || missingEntries.length === 0) return;
    setPhase('cloning');
    setError(null);
    await api.scmCompare.cloneRepositories(
      localFolder,
      missingEntries.map((e) => e.repository)
    );
    await runComparison(localFolder, groupRepos);
    setPhase('ready');
  }, [api, localFolder, missingEntries, groupRepos, runComparison]);

  // --- Render guards ---

  if (!api) {
    return (
      <div className="scm-compare">
        <div className="scm-compare__loading">Waiting for connection...</div>
      </div>
    );
  }

  if (connectedProviders.length === 0) {
    return (
      <div className="scm-compare">
        <div className="scm-compare__notice">
          <p>Connect to GitHub or Bitbucket to compare a project against a local folder.</p>
          {onConnectClick && (
            <button type="button" className="scm-compare__primary-btn" onClick={onConnectClick}>
              Go to Connect →
            </button>
          )}
        </div>
      </div>
    );
  }

  if (gitAvailable === false) {
    return (
      <div className="scm-compare">
        <div className="scm-compare__error">
          <span className="scm-compare__error-icon">⚠️</span>
          <div>
            <strong>Git is not installed</strong>
            <p>Git is required to clone repositories. Install Git and restart the application.</p>
          </div>
        </div>
      </div>
    );
  }

  const presentCount = compared
    ? (comparison?.entries ?? []).filter((e) => e.present).length
    : 0;

  return (
    <div className="scm-compare">
      <div className="scm-compare__header">
        <h3>Compare SCM Project to Local Folder</h3>
      </div>

      {error && (
        <div className="scm-compare__error">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {/* Source selection — mirrors the Analytics RepositoryFilter source row.
          Only connected providers are offered. */}
      <div className="scm-compare__source-filter">
        {(['github', 'bitbucket'] as SCMProvider[]).map((p) => {
          const connected = connectedProviders.includes(p);
          return (
            <button
              key={p}
              type="button"
              className={`scm-compare__source-btn ${
                provider === p ? 'scm-compare__source-btn--active' : ''
              }`}
              disabled={!connected}
              title={connected ? '' : `${providerLabel(p)} is not connected`}
              onClick={() => setProvider(p)}
            >
              {providerIcon(p)} {providerLabel(p)}
            </button>
          );
        })}
      </div>

      <div className="scm-compare__controls">
        <div className="scm-compare__control">
          <label className="scm-compare__label" htmlFor="scm-compare-group">
            Project
          </label>
          <select
            id="scm-compare-group"
            className="scm-compare__select"
            value={selectedGroup}
            disabled={phase === 'loading-groups' || groups.length === 0}
            onChange={(e) => handleGroupChange(e.target.value)}
          >
            <option value="">
              {phase === 'loading-groups'
                ? 'Loading projects...'
                : groups.length === 0
                  ? 'No projects found'
                  : 'Select a project'}
            </option>
            {groups.map((g) => (
              <option key={g.name} value={g.name}>
                {g.name} ({g.repositoryCount})
              </option>
            ))}
          </select>
        </div>

        <div className="scm-compare__control">
          <label className="scm-compare__label">Local folder</label>
          <button
            type="button"
            className="scm-compare__secondary-btn"
            onClick={handleSelectFolder}
            disabled={groupRepos.length === 0}
            title={groupRepos.length === 0 ? 'Choose a project first' : ''}
          >
            {localFolder ? 'Change folder' : 'Select folder'}
          </button>
          {localFolder && <span className="scm-compare__folder-path">{localFolder}</span>}
        </div>
      </div>

      {phase === 'loading-repos' && (
        <div className="scm-compare__loading">Loading repositories...</div>
      )}

      {selectedGroup && repositories.length === 0 && phase === 'ready' && (
        <div className="scm-compare__empty">This project has no repositories.</div>
      )}

      {repositories.length > 0 && (
        <>
          <div className="scm-compare__summary">
            {compared ? (
              <>
                <span className="scm-compare__summary-item scm-compare__summary-item--present">
                  {presentCount} present
                </span>
                <span className="scm-compare__summary-item scm-compare__summary-item--missing">
                  {missingEntries.length} missing
                </span>
                <span className="scm-compare__summary-item">{repositories.length} total</span>
                {localOnlyEntries.length > 0 && (
                  <span className="scm-compare__summary-item scm-compare__summary-item--local-only">
                    {localOnlyEntries.length} local-only
                  </span>
                )}
              </>
            ) : (
              <span className="scm-compare__summary-item">
                {repositories.length} repositories — select a local folder to compare
              </span>
            )}
            {compared && missingEntries.length > 0 && (
              <button
                type="button"
                className="scm-compare__primary-btn scm-compare__clone-all-btn"
                onClick={handleCloneAllMissing}
                disabled={phase === 'cloning'}
              >
                {phase === 'cloning'
                  ? 'Cloning...'
                  : `Clone all missing (${missingEntries.length})`}
              </button>
            )}
          </div>

          <div className="scm-compare__list">
            {comparison!.entries.map((entry) => {
              const progress = cloneProgress.get(entry.repository.name);
              return (
                <div
                  key={`${entry.repository.owner}/${entry.repository.name}`}
                  className={`scm-compare__row${
                    compared
                      ? entry.present
                        ? ' scm-compare__row--present'
                        : ' scm-compare__row--missing'
                      : ''
                  }`}
                >
                  <div className="scm-compare__row-main">
                    <span className="scm-compare__row-name">{entry.repository.name}</span>
                    <span className="scm-compare__row-branches">
                      <span
                        className="scm-compare__branch"
                        title="Default branch configured for this repository on Bitbucket"
                      >
                        <span className="scm-compare__branch-label">Bitbucket default:</span>{' '}
                        <span className="scm-compare__branch-value">
                          {entry.repository.defaultBranch}
                        </span>
                      </span>
                      {compared && entry.present && (
                        <span
                          className="scm-compare__branch"
                          title={
                            entry.localBranch
                              ? 'Branch currently checked out in your local clone'
                              : 'Local branch could not be determined'
                          }
                        >
                          <span className="scm-compare__branch-label">Local:</span>{' '}
                          <span className="scm-compare__branch-value">
                            {entry.localBranch ?? 'unknown'}
                          </span>
                        </span>
                      )}
                    </span>
                  </div>

                  <div className="scm-compare__row-status">
                    {!compared && <span className="scm-compare__badge">—</span>}
                    {compared && entry.present && (
                      <span className="scm-compare__badge scm-compare__badge--present">
                        ✓ Present
                      </span>
                    )}
                    {compared && !entry.present && !progress && (
                      <>
                        <span className="scm-compare__badge scm-compare__badge--missing">
                          Missing
                        </span>
                        <button
                          type="button"
                          className="scm-compare__clone-btn"
                          onClick={() => handleCloneOne(entry.repository)}
                          disabled={phase === 'cloning'}
                        >
                          Clone
                        </button>
                      </>
                    )}
                    {progress && (
                      <span
                        className={`scm-compare__badge scm-compare__badge--${progress.status}`}
                      >
                        {progress.status === 'cloning' && '⏳ Cloning...'}
                        {progress.status === 'pending' && 'Queued'}
                        {progress.status === 'complete' && '✓ Cloned'}
                        {progress.status === 'error' && `❌ ${progress.error ?? 'Failed'}`}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {compared && localOnlyEntries.length > 0 && (
            <div className="scm-compare__local-only">
              <h4 className="scm-compare__local-only-title">
                In this folder but not in the project ({localOnlyEntries.length})
              </h4>
              <p className="scm-compare__local-only-desc">
                These local directories don&apos;t match any repository in the selected project.
              </p>
              <div className="scm-compare__list">
                {localOnlyEntries.map((entry) => (
                  <div
                    key={entry.localPath}
                    className="scm-compare__row scm-compare__row--local-only"
                  >
                    <div className="scm-compare__row-main">
                      <span className="scm-compare__row-name">{entry.name}</span>
                      <span className="scm-compare__row-branches">
                        {entry.isGitRepo ? (
                          <span
                            className="scm-compare__branch"
                            title="Branch currently checked out in this local directory"
                          >
                            <span className="scm-compare__branch-label">Local:</span>{' '}
                            <span className="scm-compare__branch-value">
                              {entry.localBranch ?? 'unknown'}
                            </span>
                          </span>
                        ) : (
                          <span className="scm-compare__branch">
                            <span className="scm-compare__branch-value">Not a git repository</span>
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="scm-compare__row-status">
                      <span className="scm-compare__badge scm-compare__badge--local-only">
                        Local only
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
