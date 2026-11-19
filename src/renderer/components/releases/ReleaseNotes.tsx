import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DateRange, Repository, RepoReleases } from '../../../shared/types';
import { useElectronAPI } from '../../hooks';
import {
  DEFAULT_RELEASE_BRANCH_MODE,
  RELEASE_BRANCH_MODES,
  isReleaseBranchMode,
  type ReleaseBranchMode,
} from '../../../shared/releaseBranch';
import {
  buildReleaseNotesMarkdown,
  commitSubject,
  extractTicketKeys,
  summarizeRepoReleases,
  visibleCommits,
} from './releaseFormat';
import './ReleaseNotes.css';

interface ReleaseNotesProps {
  repositories: Repository[];
  dateRange: DateRange | null;
}

const DEFAULT_LOOKBACK_DAYS = 365;

function formatDate(date: Date): string {
  return new Date(date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function ReleaseNotes({ repositories, dateRange }: ReleaseNotesProps) {
  const api = useElectronAPI();
  const [results, setResults] = useState<RepoReleases[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hideMerges, setHideMerges] = useState(false);
  const [branchMode, setBranchMode] = useState<ReleaseBranchMode>(DEFAULT_RELEASE_BRANCH_MODE);

  useEffect(() => {
    api?.releases
      .getBranchMode()
      .then((mode) => setBranchMode(isReleaseBranchMode(mode) ? mode : DEFAULT_RELEASE_BRANCH_MODE))
      .catch(() => undefined);
  }, [api]);

  const repoKey = repositories.map((r) => r.id).join('|');
  const range = useMemo(() => {
    if (dateRange) return dateRange;
    const end = new Date();
    const start = new Date(end.getTime() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    return { start, end };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateRange?.start?.getTime(), dateRange?.end?.getTime()]);

  const load = useCallback(async () => {
    if (!api || repositories.length === 0) {
      setResults([]);
      return [];
    }
    return api.releases.query({
      repositoryIds: repositories.map((r) => r.id),
      start: range.start,
      end: range.end,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, repoKey, range]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    load()
      .then((data) => {
        if (!cancelled) setResults(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load releases');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const handleRefresh = async () => {
    if (!api) return;
    setRefreshing(true);
    setError(null);
    setNotice(null);
    try {
      const sync = await api.releases.sync(repositories.map((r) => r.id));
      setResults(await load());
      const failed = sync.errors.map((e) => `${e.repoName}: ${e.error}`).join('; ');
      setNotice(
        `${sync.addedReleases} new release${sync.addedReleases === 1 ? '' : 's'} found` +
          (failed ? `. Could not read: ${failed}` : '')
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh releases');
    } finally {
      setRefreshing(false);
    }
  };

  const handleBranchChange = async (mode: ReleaseBranchMode) => {
    if (!api) return;
    setBranchMode(mode);
    setError(null);
    try {
      await api.releases.setBranchMode(mode);
      setResults(await load());
      await handleRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change the release branch');
    }
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(buildReleaseNotesMarkdown(results, range, hideMerges));
    setNotice('Markdown copied to the clipboard');
  };

  const shipped = results.filter((repo) => repo.releases.length > 0);
  const quiet = results.filter((repo) => repo.releases.length === 0);
  const totalReleases = shipped.reduce((n, repo) => n + repo.releases.length, 0);

  return (
    <section className="release-notes">
      <div className="release-notes__toolbar">
        <p className="release-notes__summary">
          {loading
            ? 'Loading releases...'
            : `${totalReleases} release${totalReleases === 1 ? '' : 's'} across ${shipped.length} of ${results.length} repositories`}
        </p>
        <label className="release-notes__toggle">
          Release branch
          <select
            className="release-notes__select"
            value={branchMode}
            disabled={refreshing}
            onChange={(e) => handleBranchChange(e.target.value as ReleaseBranchMode)}
          >
            {RELEASE_BRANCH_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="release-notes__toggle">
          <input type="checkbox" checked={hideMerges} onChange={(e) => setHideMerges(e.target.checked)} />
          Hide merge commits
        </label>
        <button type="button" className="release-notes__btn" onClick={handleCopy} disabled={shipped.length === 0}>
          Copy Markdown
        </button>
        <button type="button" className="release-notes__btn" onClick={handleRefresh} disabled={refreshing}>
          {refreshing ? 'Refreshing...' : 'Refresh tags'}
        </button>
      </div>

      {error && <p className="release-notes__error" role="alert">{error}</p>}
      {notice && <p className="release-notes__notice">{notice}</p>}

      {!loading && shipped.length === 0 && (
        <div className="release-notes__empty">
          No tagged releases on <code>{RELEASE_BRANCH_MODES.find((m) => m.id === branchMode)?.label}</code> in this range. Tags are read when you sync; use
          Refresh tags to check now.
        </div>
      )}

      {shipped.map((repo) => {
        const summary = summarizeRepoReleases(repo, hideMerges);
        return (
          <article className="release-notes__repo" key={repo.repositoryId}>
            <header className="release-notes__repo-header">
              <h3 className="release-notes__repo-name">
                {repo.repositoryParentFolder && (
                  <span className="release-notes__repo-folder">{repo.repositoryParentFolder}/</span>
                )}
                {repo.repositoryName}
              </h3>
              <span className="release-notes__repo-meta">
                {summary.releaseCount} release{summary.releaseCount === 1 ? '' : 's'}, {summary.commitCount} commit
                {summary.commitCount === 1 ? '' : 's'}
                {summary.firstTag && summary.firstTag !== summary.lastTag && (
                  <>
                    {' '}
                    ({summary.firstTag} to {summary.lastTag})
                  </>
                )}
              </span>
            </header>
            {repo.releases.map((release) => {
              const commits = visibleCommits(release.commits, hideMerges);
              const tickets = [...new Set(commits.flatMap((c) => extractTicketKeys(c.message)))];
              return (
                <details className="release-notes__release" key={release.tag}>
                  <summary>
                    <span className="release-notes__tag">{release.tag}</span>
                    <span
                      className="release-notes__date"
                      title={
                        release.dateSource === 'tag'
                          ? 'Date the tag was created'
                          : 'Lightweight tag: this is the tagged commit date, which can be earlier than the release'
                      }
                    >
                      {formatDate(release.releasedAt)}
                      {release.dateSource === 'commit' && ' (commit date)'}
                    </span>
                    <span className="release-notes__count">
                      {commits.length} commit{commits.length === 1 ? '' : 's'}
                    </span>
                  </summary>
                  {tickets.length > 0 && (
                    <p className="release-notes__tickets">Tickets: {tickets.join(', ')}</p>
                  )}
                  <ul className="release-notes__commits">
                    {commits.map((commit) => (
                      <li key={commit.hash}>
                        <span className="release-notes__subject">{commitSubject(commit.message)}</span>
                        <span className="release-notes__commit-meta">
                          {commit.authorName}, <code>{commit.hash.slice(0, 7)}</code>
                        </span>
                      </li>
                    ))}
                    {commits.length === 0 && <li className="release-notes__commit-meta">No commits</li>}
                  </ul>
                </details>
              );
            })}
          </article>
        );
      })}

      {quiet.length > 0 && !loading && (
        <details className="release-notes__quiet">
          <summary>
            {quiet.length} repositor{quiet.length === 1 ? 'y' : 'ies'} with no releases in this range
          </summary>
          <ul>
            {quiet.map((repo) => (
              <li key={repo.repositoryId}>{repo.repositoryName}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
