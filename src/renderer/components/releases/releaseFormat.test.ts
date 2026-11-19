import { describe, it, expect } from 'vitest';
import type { RepoReleases } from '../../../shared/types';
import { buildReleaseNotesMarkdown, summarizeRepoReleases, visibleCommits } from './releaseFormat';

const commit = (hash: string, message: string, isMerge = false) => ({
  hash,
  authorName: 'Ann',
  authorEmail: 'ann@example.com',
  date: new Date('2025-02-01T00:00:00Z'),
  message,
  isMerge,
});

const repos: RepoReleases[] = [
  {
    repositoryId: '1',
    repositoryName: 'billing',
    provider: 'bitbucket',
    releases: [
      {
        tag: 'v1.1.0',
        sha: 'b',
        releasedAt: new Date('2025-02-10T00:00:00Z'),
        dateSource: 'tag',
        commits: [commit('2222222222', 'DEV-2 two\n\nbody'), commit('3333333333', 'Merge pull request', true)],
      },
      {
        tag: 'v1.0.0',
        sha: 'a',
        releasedAt: new Date('2025-01-10T00:00:00Z'),
        dateSource: 'tag',
        commits: [commit('1111111111', 'DEV-1 one')],
      },
    ],
  },
  { repositoryId: '2', repositoryName: 'auth', provider: 'github', releases: [] },
];

describe('releaseFormat', () => {
  it('summarizes releases, commits and the tag span', () => {
    expect(summarizeRepoReleases(repos[0])).toEqual({
      releaseCount: 2,
      commitCount: 3,
      firstTag: 'v1.0.0',
      lastTag: 'v1.1.0',
    });
    expect(summarizeRepoReleases(repos[0], true).commitCount).toBe(2);
    expect(summarizeRepoReleases(repos[1])).toEqual({ releaseCount: 0, commitCount: 0 });
  });

  it('hides merge commits on request', () => {
    expect(visibleCommits(repos[0].releases[0].commits, true)).toHaveLength(1);
  });

  it('builds markdown with releases and a list of repositories that shipped nothing', () => {
    const md = buildReleaseNotesMarkdown(
      repos,
      { start: new Date('2025-01-01T00:00:00Z'), end: new Date('2025-03-01T00:00:00Z') },
      true
    );
    expect(md).toContain('# Release notes, 2025-01-01 to 2025-03-01');
    expect(md).toContain('## billing');
    expect(md).toContain('### v1.1.0 (2025-02-10)');
    expect(md).toContain('- DEV-2 two (Ann, `2222222`)');
    expect(md).not.toContain('Merge pull request');
    expect(md).toContain('## No releases in this range\n\n- auth');
  });
});
