import { useState, useEffect, useCallback, useRef } from 'react';
import { useElectronAPI } from '../../hooks';
import { AuthStatus } from '../auth';
import { RepositoryList, ImportProgress, LocalRepositoryBrowser } from '../repositories';
import { DateRangeFilter, RepositoryFilter, calculateDateRange } from '../filters';
import { ChartWidget, WidgetRegistry, CommitsPerUserWidgetDefinition, MessageSummaryWidgetDefinition, RepositoryCommitSummaryWidgetDefinition, ContributionGraphWidgetDefinition, CommitFrequencyWidgetDefinition, DayHourHeatmapWidgetDefinition, StreakWidgetDefinition, BusFactorWidgetDefinition, CommitMessageAnalysisWidgetDefinition, RepoHealthWidgetDefinition, AuthorRepoMatrixWidgetDefinition } from '../widgets';
import type { Repository, Commit, DateRange, DateRangePreset, UserPreferences } from '../../../shared/types';
import type { AuthorGrouping } from '../widgets';
import './Dashboard.css';

// Register built-in widgets
WidgetRegistry.register(CommitsPerUserWidgetDefinition);
WidgetRegistry.register(MessageSummaryWidgetDefinition);
WidgetRegistry.register(RepositoryCommitSummaryWidgetDefinition);
WidgetRegistry.register(ContributionGraphWidgetDefinition);
WidgetRegistry.register(CommitFrequencyWidgetDefinition);
WidgetRegistry.register(DayHourHeatmapWidgetDefinition);
WidgetRegistry.register(StreakWidgetDefinition);
WidgetRegistry.register(BusFactorWidgetDefinition);
WidgetRegistry.register(CommitMessageAnalysisWidgetDefinition);
WidgetRegistry.register(RepoHealthWidgetDefinition);
WidgetRegistry.register(AuthorRepoMatrixWidgetDefinition);

type View = 'connect' | 'import' | 'importing' | 'analytics';
type AnalyticsTab = 'overview' | 'by-user' | 'by-repository' | 'insights';
type ImportSource = null | 'local' | 'github' | 'bitbucket';

export function Dashboard() {
  const api = useElectronAPI();
  
  // View state
  const [view, setView] = useState<View>('connect');
  const [analyticsTab, setAnalyticsTab] = useState<AnalyticsTab>('overview');
  
  // Auth state
  const [githubConnected, setGithubConnected] = useState(false);
  const [bitbucketConnected, setBitbucketConnected] = useState(false);
  
  // Import state
  const [selectedRepos, setSelectedRepos] = useState<Repository[]>([]);
  const [importingRepos, setImportingRepos] = useState<Repository[]>([]);
  const [importSource, setImportSource] = useState<ImportSource>(null);
  
  // Analytics state
  const [commits, setCommits] = useState<Commit[]>([]);
  const [selectedRepoIds, setSelectedRepoIds] = useState<string[]>([]);
  const [dateRange, setDateRange] = useState<DateRange | null>(null);
  const [dateRangePreset, setDateRangePreset] = useState<DateRangePreset | undefined>();
  const [loading, setLoading] = useState(false);
  const [authorGrouping, setAuthorGrouping] = useState<AuthorGrouping>('name');
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [syncErrors, setSyncErrors] = useState<{ repoName: string; error: string }[]>([]);
  const [syncErrorsExpanded, setSyncErrorsExpanded] = useState(false);
  const lastSyncRef = useRef<number>(0);
  const syncingRef = useRef(false);

  const SYNC_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes
  const SYNC_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

  // Load preferences on mount (only when api is available)
  useEffect(() => {
    if (api) {
      loadPreferences();
    }
  }, [api]);

  // Fetch commits when filters change (only when api is available)
  useEffect(() => {
    if (api && view === 'analytics' && selectedRepoIds.length > 0) {
      fetchCommits();
    }
  }, [api, selectedRepoIds, dateRange, view]);

  // Auto-sync on window focus (with cooldown)
  useEffect(() => {
    if (!api) return;
    const cleanup = api.onSyncTrigger(() => {
      if (syncingRef.current) return;
      if (Date.now() - lastSyncRef.current < SYNC_COOLDOWN_MS) return;
      handleSync();
    });
    return cleanup;
  }, [api]);

  // Background sync interval (10 min)
  useEffect(() => {
    if (!api) return;
    const id = setInterval(() => {
      if (syncingRef.current) return;
      if (Date.now() - lastSyncRef.current < SYNC_COOLDOWN_MS) return;
      handleSync();
    }, SYNC_INTERVAL_MS);
    return () => clearInterval(id);
  }, [api]);

  const loadPreferences = async () => {
    if (!api) {
      return;
    }
    try {
      const prefs = await api.preferences.get();
      if (prefs.selectedRepositoryIds.length > 0) {
        setSelectedRepoIds(prefs.selectedRepositoryIds);
        setView('analytics');
      }
      if (prefs.dateRangePreset) {
        setDateRangePreset(prefs.dateRangePreset);
        if (prefs.dateRangePreset !== 'custom') {
          setDateRange(calculateDateRange(prefs.dateRangePreset));
        } else if (prefs.customDateRange) {
          setDateRange(prefs.customDateRange);
        }
      }
    } catch (err) {
      console.error('Failed to load preferences:', err);
    }
  };

  const savePreferences = useCallback(async (prefs: Partial<UserPreferences>) => {
    if (!api) {
      return;
    }
    try {
      const current = await api.preferences.get();
      await api.preferences.save({ ...current, ...prefs });
    } catch (err) {
      console.error('Failed to save preferences:', err);
    }
  }, [api]);

  const fetchCommits = async () => {
    if (!api) {
      return;
    }
    try {
      setLoading(true);
      const result = await api.commits.query({
        repositoryIds: selectedRepoIds,
        startDate: dateRange?.start,
        endDate: dateRange?.end,
      });
      setCommits(result);
    } catch (err) {
      console.error('Failed to fetch commits:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleDateRangeChange = (range: DateRange | null, preset?: DateRangePreset) => {
    setDateRange(range);
    setDateRangePreset(preset);
    savePreferences({
      dateRangePreset: preset,
      customDateRange: preset === 'custom' && range ? range : undefined,
    });
  };

  const handleRepoSelectionChange = (ids: string[]) => {
    setSelectedRepoIds(ids);
    savePreferences({ selectedRepositoryIds: ids });
  };

  const handleStartImport = () => {
    if (selectedRepos.length > 0) {
      setImportingRepos(selectedRepos);
      setView('importing');
    }
  };

  const handleImportComplete = async () => {
    if (!api) {
      setView('import');
      return;
    }
    const imported = await api.repositories.getImported();
    if (imported.length > 0) {
      setSelectedRepoIds(imported.map(r => r.id));
      setView('analytics');
    } else {
      setView('import');
    }
  };

  const handleWidgetError = (error: Error) => {
    console.error('Widget error:', error);
  };

  const handleSync = async () => {
    if (!api || syncing) return;
    syncingRef.current = true;
    setSyncing(true);
    setSyncStatus('Syncing...');
    setSyncErrors([]);
    setSyncErrorsExpanded(false);
    try {
      const result = await api.repositories.sync();
      const now = new Date();
      lastSyncRef.current = now.getTime();
      const timeStr = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      if (result.totalNewCommits > 0) {
        setSyncStatus(`Synced ${result.totalNewCommits} new commit${result.totalNewCommits !== 1 ? 's' : ''} from ${result.syncedRepos} repo${result.syncedRepos !== 1 ? 's' : ''}`);
        await fetchCommits();
      } else {
        setSyncStatus(`Everything up to date as of ${timeStr}`);
      }
      if (result.errors.length > 0) {
        setSyncErrors(result.errors);
        setSyncStatus(prev => `${prev} (${result.errors.length} error${result.errors.length !== 1 ? 's' : ''})`);
      } else {
        // Auto-clear status after 5s only when no errors
        setTimeout(() => setSyncStatus(null), 5000);
      }
    } catch (err) {
      setSyncStatus('Sync failed');
      console.error('Sync error:', err);
      setTimeout(() => setSyncStatus(null), 5000);
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  };

  const anyConnected = githubConnected || bitbucketConnected;
  const widgets = WidgetRegistry.getWidgets();

  return (
    <div className="dashboard">
      <header className="dashboard__header">
        <h1>Git Analytics Dashboard</h1>
        <nav className="dashboard__nav">
          <button 
            type="button"
            className={view === 'connect' ? 'active' : ''}
            onClick={() => setView('connect')}
          >
            Connect
          </button>
          <button 
            type="button"
            className={view === 'import' ? 'active' : ''}
            onClick={() => { setView('import'); setImportSource(null); }}
          >
            Import
          </button>
          <button 
            type="button"
            className={view === 'analytics' ? 'active' : ''}
            onClick={() => setView('analytics')}
          >
            Analytics
          </button>
        </nav>
      </header>

      <main className="dashboard__content">
        {view === 'connect' && (
          <section className="dashboard__section">
            <h2>Connect Your Accounts</h2>
            <p>Connect to GitHub or Bitbucket to import your repositories.</p>
            <div className="dashboard__auth-providers">
              <AuthStatus 
                provider="github" 
                onStatusChange={(s) => setGithubConnected(s.connected)} 
              />
              <AuthStatus 
                provider="bitbucket" 
                onStatusChange={(s) => setBitbucketConnected(s.connected)} 
              />
            </div>
            {anyConnected && (
              <button 
                type="button"
                className="dashboard__cta"
                onClick={() => setView('import')}
              >
                Continue to Import →
              </button>
            )}
          </section>
        )}

        {view === 'import' && (
          <section className="dashboard__section">
            <h2>Import Repositories</h2>
            
            {/* Source selection */}
            {importSource === null && (
              <div className="dashboard__import-sources">
                <button
                  type="button"
                  className="dashboard__import-source-btn"
                  onClick={() => setImportSource('local')}
                >
                  <span className="dashboard__import-source-icon">📁</span>
                  <span className="dashboard__import-source-label">Local Repositories</span>
                  <span className="dashboard__import-source-desc">Import from your filesystem</span>
                </button>
                {githubConnected && (
                  <button
                    type="button"
                    className="dashboard__import-source-btn"
                    onClick={() => setImportSource('github')}
                  >
                    <span className="dashboard__import-source-icon">🐙</span>
                    <span className="dashboard__import-source-label">GitHub</span>
                    <span className="dashboard__import-source-desc">Connected</span>
                  </button>
                )}
                {bitbucketConnected && (
                  <button
                    type="button"
                    className="dashboard__import-source-btn"
                    onClick={() => setImportSource('bitbucket')}
                  >
                    <span className="dashboard__import-source-icon">🪣</span>
                    <span className="dashboard__import-source-label">Bitbucket</span>
                    <span className="dashboard__import-source-desc">Connected</span>
                  </button>
                )}
                {!githubConnected && (
                  <button
                    type="button"
                    className="dashboard__import-source-btn dashboard__import-source-btn--disabled"
                    onClick={() => setView('connect')}
                  >
                    <span className="dashboard__import-source-icon">🐙</span>
                    <span className="dashboard__import-source-label">GitHub</span>
                    <span className="dashboard__import-source-desc">Not connected — click to set up</span>
                  </button>
                )}
                {!bitbucketConnected && (
                  <button
                    type="button"
                    className="dashboard__import-source-btn dashboard__import-source-btn--disabled"
                    onClick={() => setView('connect')}
                  >
                    <span className="dashboard__import-source-icon">🪣</span>
                    <span className="dashboard__import-source-label">Bitbucket</span>
                    <span className="dashboard__import-source-desc">Not connected — click to set up</span>
                  </button>
                )}
              </div>
            )}

            {/* Back button when a source is selected */}
            {importSource !== null && (
              <button
                type="button"
                className="dashboard__back-btn"
                onClick={() => { setImportSource(null); setSelectedRepos([]); }}
              >
                ← Back to sources
              </button>
            )}

            {/* Local repositories */}
            {importSource === 'local' && (
              <div className="dashboard__local-import">
                <LocalRepositoryBrowser onImportComplete={handleImportComplete} />
              </div>
            )}

            {/* Cloud repositories */}
            {importSource === 'github' && (
              <div className="dashboard__import-lists">
                <RepositoryList 
                  provider="github" 
                  onSelectionChange={setSelectedRepos}
                />
                {selectedRepos.length > 0 && (
                  <button 
                    type="button"
                    className="dashboard__cta"
                    onClick={handleStartImport}
                  >
                    Import {selectedRepos.length} Repositories
                  </button>
                )}
              </div>
            )}

            {importSource === 'bitbucket' && (
              <div className="dashboard__import-lists">
                <RepositoryList 
                  provider="bitbucket" 
                  onSelectionChange={setSelectedRepos}
                />
                {selectedRepos.length > 0 && (
                  <button 
                    type="button"
                    className="dashboard__cta"
                    onClick={handleStartImport}
                  >
                    Import {selectedRepos.length} Repositories
                  </button>
                )}
              </div>
            )}
          </section>
        )}

        {view === 'importing' && (
          <section className="dashboard__section">
            <ImportProgress 
              repositories={importingRepos}
              onComplete={handleImportComplete}
            />
          </section>
        )}

        {view === 'analytics' && (
          <div className="dashboard__analytics">
            <aside className="dashboard__sidebar">
              <button
                type="button"
                className={`dashboard__sync-btn ${syncing ? 'dashboard__sync-btn--syncing' : ''}`}
                onClick={handleSync}
                disabled={syncing}
              >
                {syncing ? 'Syncing...' : '↻ Sync Repositories'}
              </button>
              {syncStatus && (
                <div className="dashboard__sync-status">
                  {syncStatus}
                  {syncErrors.length > 0 && (
                    <button
                      type="button"
                      className="dashboard__sync-errors-toggle"
                      onClick={() => setSyncErrorsExpanded(true)}
                    >
                      Show details
                    </button>
                  )}
                </div>
              )}
              {syncErrorsExpanded && syncErrors.length > 0 && (
                <div className="dashboard__modal-overlay" onClick={() => setSyncErrorsExpanded(false)}>
                  <div className="dashboard__modal" onClick={e => e.stopPropagation()}>
                    <div className="dashboard__modal-header">
                      <span>Sync Errors ({syncErrors.length})</span>
                      <button type="button" className="dashboard__modal-close" onClick={() => setSyncErrorsExpanded(false)}>✕</button>
                    </div>
                    <div className="dashboard__sync-errors">
                      {syncErrors.map((e, i) => (
                        <div key={i} className="dashboard__sync-error-row">
                          <span className="dashboard__sync-error-repo">{e.repoName}</span>
                          <span className="dashboard__sync-error-msg">{e.error}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              <div className="dashboard__filter-section">
                <h3>Date Range</h3>
                <DateRangeFilter
                  value={dateRange}
                  preset={dateRangePreset}
                  onChange={handleDateRangeChange}
                />
              </div>
              <div className="dashboard__filter-section">
                <RepositoryFilter
                  selectedIds={selectedRepoIds}
                  onChange={handleRepoSelectionChange}
                />
              </div>
            </aside>

            <div className="dashboard__main">
              <div className="dashboard__tabs">
                <button
                  type="button"
                  className={`dashboard__tab ${analyticsTab === 'overview' ? 'dashboard__tab--active' : ''}`}
                  onClick={() => setAnalyticsTab('overview')}
                >
                  Overview
                </button>
                <button
                  type="button"
                  className={`dashboard__tab ${analyticsTab === 'by-user' ? 'dashboard__tab--active' : ''}`}
                  onClick={() => setAnalyticsTab('by-user')}
                >
                  By User
                </button>
                <button
                  type="button"
                  className={`dashboard__tab ${analyticsTab === 'by-repository' ? 'dashboard__tab--active' : ''}`}
                  onClick={() => setAnalyticsTab('by-repository')}
                >
                  By Repository
                </button>
                <button
                  type="button"
                  className={`dashboard__tab ${analyticsTab === 'insights' ? 'dashboard__tab--active' : ''}`}
                  onClick={() => setAnalyticsTab('insights')}
                >
                  Insights
                </button>

                <div className="dashboard__grouping-toggle">
                  <span className="dashboard__grouping-label">Group by:</span>
                  <button
                    type="button"
                    className={`dashboard__grouping-btn ${authorGrouping === 'name' ? 'dashboard__grouping-btn--active' : ''}`}
                    onClick={() => setAuthorGrouping('name')}
                  >
                    Name
                  </button>
                  <button
                    type="button"
                    className={`dashboard__grouping-btn ${authorGrouping === 'email' ? 'dashboard__grouping-btn--active' : ''}`}
                    onClick={() => setAuthorGrouping('email')}
                  >
                    Email
                  </button>
                </div>
              </div>

              <div className="dashboard__widgets">
                {loading && <div className="dashboard__loading">Loading commits...</div>}
                
                {!loading && selectedRepoIds.length === 0 && (
                  <div className="dashboard__empty">
                    Select at least one repository to view analytics
                  </div>
                )}

                {!loading && selectedRepoIds.length > 0 && analyticsTab === 'overview' && (
                  <>
                    <ChartWidget
                      key="contribution-graph"
                      definition={ContributionGraphWidgetDefinition}
                      commits={commits}
                      dateRange={dateRange}
                      selectedRepoIds={selectedRepoIds}
                      authorGrouping={authorGrouping}
                      onError={handleWidgetError}
                    />
                    <ChartWidget
                      key="commit-frequency"
                      definition={CommitFrequencyWidgetDefinition}
                      commits={commits}
                      dateRange={dateRange}
                      selectedRepoIds={selectedRepoIds}
                      authorGrouping={authorGrouping}
                      onError={handleWidgetError}
                    />
                    <ChartWidget
                      key="day-hour-heatmap"
                      definition={DayHourHeatmapWidgetDefinition}
                      commits={commits}
                      dateRange={dateRange}
                      selectedRepoIds={selectedRepoIds}
                      authorGrouping={authorGrouping}
                      onError={handleWidgetError}
                    />
                    <ChartWidget
                      key="commits-per-user"
                      definition={CommitsPerUserWidgetDefinition}
                      commits={commits}
                      dateRange={dateRange}
                      selectedRepoIds={selectedRepoIds}
                      authorGrouping={authorGrouping}
                      onError={handleWidgetError}
                    />
                  </>
                )}

                {!loading && selectedRepoIds.length > 0 && analyticsTab === 'by-user' && (
                  <>
                    <ChartWidget
                      key="message-summary"
                      definition={MessageSummaryWidgetDefinition}
                      commits={commits}
                      dateRange={dateRange}
                      selectedRepoIds={selectedRepoIds}
                      authorGrouping={authorGrouping}
                      onError={handleWidgetError}
                    />
                    <ChartWidget
                      key="streaks"
                      definition={StreakWidgetDefinition}
                      commits={commits}
                      dateRange={dateRange}
                      selectedRepoIds={selectedRepoIds}
                      authorGrouping={authorGrouping}
                      onError={handleWidgetError}
                    />
                    <ChartWidget
                      key="author-repo-matrix"
                      definition={AuthorRepoMatrixWidgetDefinition}
                      commits={commits}
                      dateRange={dateRange}
                      selectedRepoIds={selectedRepoIds}
                      authorGrouping={authorGrouping}
                      onError={handleWidgetError}
                    />
                  </>
                )}

                {!loading && selectedRepoIds.length > 0 && analyticsTab === 'by-repository' && (
                  <>
                    <ChartWidget
                      key="repository-commit-summary"
                      definition={RepositoryCommitSummaryWidgetDefinition}
                      commits={commits}
                      dateRange={dateRange}
                      selectedRepoIds={selectedRepoIds}
                      authorGrouping={authorGrouping}
                      onError={handleWidgetError}
                    />
                    <ChartWidget
                      key="repo-health"
                      definition={RepoHealthWidgetDefinition}
                      commits={commits}
                      dateRange={dateRange}
                      selectedRepoIds={selectedRepoIds}
                      authorGrouping={authorGrouping}
                      onError={handleWidgetError}
                    />
                  </>
                )}

                {!loading && selectedRepoIds.length > 0 && analyticsTab === 'insights' && (
                  <>
                    <ChartWidget
                      key="bus-factor"
                      definition={BusFactorWidgetDefinition}
                      commits={commits}
                      dateRange={dateRange}
                      selectedRepoIds={selectedRepoIds}
                      authorGrouping={authorGrouping}
                      onError={handleWidgetError}
                    />
                    <ChartWidget
                      key="commit-message-analysis"
                      definition={CommitMessageAnalysisWidgetDefinition}
                      commits={commits}
                      dateRange={dateRange}
                      selectedRepoIds={selectedRepoIds}
                      authorGrouping={authorGrouping}
                      onError={handleWidgetError}
                    />
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
