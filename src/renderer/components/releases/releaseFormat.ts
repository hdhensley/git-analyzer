import type { ReleaseCommit, RepoReleases } from '../../../shared/types';
import { extractTicketKeys } from '../../../shared/ticketKeys';

export interface RepoReleaseSummary {
  releaseCount: number;
  commitCount: number;
  firstTag?: string;
  lastTag?: string;
}

/** First line of a commit message. */
export function commitSubject(message: string): string {
  return message.split('\n', 1)[0].trim();
}

/** Commits to show for a release, optionally without merge commits. */
export function visibleCommits(commits: ReleaseCommit[], hideMerges: boolean): ReleaseCommit[] {
  return hideMerges ? commits.filter((c) => !c.isMerge) : commits;
}

/** One-line numbers for a repository: releases, commits, and the tag span. */
export function summarizeRepoReleases(repo: RepoReleases, hideMerges = false): RepoReleaseSummary {
  // Releases arrive newest first.
  const { releases } = repo;
  return {
    releaseCount: releases.length,
    commitCount: releases.reduce(
      (total, release) => total + visibleCommits(release.commits, hideMerges).length,
      0
    ),
    ...(releases.length > 0 && {
      firstTag: releases[releases.length - 1].tag,
      lastTag: releases[0].tag,
    }),
  };
}

function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Markdown release notes for the repositories that shipped something in the
 * range. Repositories with no releases are listed at the end.
 */
export function buildReleaseNotesMarkdown(
  repos: RepoReleases[],
  range: { start: Date; end: Date } | null,
  hideMerges = false
): string {
  const lines: string[] = [];
  lines.push(
    range
      ? `# Release notes, ${formatDay(range.start)} to ${formatDay(range.end)}`
      : '# Release notes'
  );

  const shipped = repos.filter((repo) => repo.releases.length > 0);
  const quiet = repos.filter((repo) => repo.releases.length === 0);

  for (const repo of shipped) {
    lines.push('', `## ${repo.repositoryName}`);
    for (const release of repo.releases) {
      lines.push('', `### ${release.tag} (${formatDay(release.releasedAt)})`, '');
      const commits = visibleCommits(release.commits, hideMerges);
      if (commits.length === 0) {
        lines.push('- No commits');
        continue;
      }
      for (const commit of commits) {
        lines.push(`- ${commitSubject(commit.message)} (${commit.authorName}, \`${commit.hash.slice(0, 7)}\`)`);
      }
    }
  }

  if (quiet.length > 0) {
    lines.push('', '## No releases in this range', '');
    for (const repo of quiet) lines.push(`- ${repo.repositoryName}`);
  }

  return lines.join('\n') + '\n';
}

export { extractTicketKeys };
