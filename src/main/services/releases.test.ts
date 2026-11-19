import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { LocalGitService } from './local-git';
import { orderReleaseTags, parseReleaseCommits, RELEASE_COMMIT_FORMAT, type RawReleaseTag } from './releases';
import { extractTicketKeys } from '../../shared/ticketKeys';

const tag = (name: string, sha: string, iso: string): RawReleaseTag => ({
  tag: name,
  sha,
  releasedAt: new Date(iso),
  dateSource: 'tag',
});

describe('orderReleaseTags', () => {
  it('orders oldest to newest and links each tag to the previous one', () => {
    const ordered = orderReleaseTags([
      tag('v1.2.0', 'c', '2025-03-03T00:00:00Z'),
      tag('v1.0.0', 'a', '2025-01-01T00:00:00Z'),
      tag('v1.1.0', 'b', '2025-02-01T00:00:00Z'),
    ]);
    expect(ordered.map((t) => t.tag)).toEqual(['v1.0.0', 'v1.1.0', 'v1.2.0']);
    expect(ordered[0].previous).toBeUndefined();
    expect(ordered[1].previous?.tag).toBe('v1.0.0');
    expect(ordered[2].previous?.tag).toBe('v1.1.0');
  });

  it('collapses tags on the same commit to the newest one', () => {
    const ordered = orderReleaseTags([
      tag('v1.0.0', 'a', '2025-01-01T00:00:00Z'),
      tag('v1.0.0-final', 'a', '2025-01-02T00:00:00Z'),
    ]);
    expect(ordered.map((t) => t.tag)).toEqual(['v1.0.0-final']);
  });
});

describe('parseReleaseCommits', () => {
  it('parses fields and flags merge commits', () => {
    const f = '\x1f';
    const out =
      `aaa${f}Ann${f}ann@x.com${f}2025-01-02T03:04:05+00:00${f}p1${f}DEV-1 Fix thing\n\nbody\x1e` +
      `bbb${f}Bob${f}bob@x.com${f}2025-01-03T03:04:05+00:00${f}p1 p2${f}Merge branch\x1e`;
    const commits = parseReleaseCommits(out);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({ hash: 'aaa', authorName: 'Ann', isMerge: false });
    expect(commits[0].message).toBe('DEV-1 Fix thing\n\nbody');
    expect(commits[1].isMerge).toBe(true);
  });

  it('exposes a format string with the same field count it parses', () => {
    expect(RELEASE_COMMIT_FORMAT.split('%x1f')).toHaveLength(6);
  });
});

describe('extractTicketKeys', () => {
  it('finds unique keys in order', () => {
    expect(extractTicketKeys('DEV-12 and LTC-4261, again DEV-12; not dev-1 or A-1x')).toEqual([
      'DEV-12',
      'LTC-4261',
    ]);
  });
});

describe('LocalGitService.fetchReleases', () => {
  let dir: string;
  const service = new LocalGitService();

  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Tester',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 'Tester',
        GIT_COMMITTER_EMAIL: 't@example.com',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    });

  const commit = (message: string) => {
    git('commit', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD').trim();
  };

  const initRepo = (branch: string) => {
    git('init', '-q', '-b', branch);
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'releases-test-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('groups commits between tags on main into releases', async () => {
    initRepo('main');
    commit('DEV-1 first');
    git('tag', '-a', 'v1.0.0', '-m', 'v1.0.0');
    commit('DEV-2 second');
    commit('DEV-3 third');
    git('tag', 'v1.0.1');

    const releases = await service.fetchReleases(dir);
    expect(releases.map((r) => r.tag)).toEqual(['v1.0.0', 'v1.0.1']);
    expect(releases[0].previousTag).toBeUndefined();
    expect(releases[0].dateSource).toBe('tag');
    expect(releases[0].commits.map((c) => c.message)).toEqual(['DEV-1 first']);
    expect(releases[1].previousTag).toBe('v1.0.0');
    expect(releases[1].dateSource).toBe('commit');
    expect(releases[1].commits.map((c) => c.message).sort()).toEqual(['DEV-2 second', 'DEV-3 third']);
  });

  it('ignores tags that are not reachable from main', async () => {
    initRepo('main');
    commit('on main');
    git('tag', 'v1.0.0');
    git('checkout', '-q', '-b', 'develop');
    commit('only on develop');
    git('tag', 'v2.0.0-rc1');

    const releases = await service.fetchReleases(dir);
    expect(releases.map((r) => r.tag)).toEqual(['v1.0.0']);
  });

  it('returns nothing for a repository that uses master unless master is allowed', async () => {
    initRepo('master');
    commit('legacy');
    git('tag', 'v1.0.0');

    expect(await service.fetchReleases(dir)).toEqual([]);
    expect((await service.fetchReleases(dir, new Map(), ['master'])).map((r) => r.tag)).toEqual(['v1.0.0']);
    expect((await service.fetchReleases(dir, new Map(), ['main', 'master'])).map((r) => r.tag)).toEqual(['v1.0.0']);
  });

  it('prefers main over master when both exist', async () => {
    initRepo('main');
    commit('on main');
    git('tag', 'v1.0.0');
    git('checkout', '-q', '-b', 'master');
    commit('only on master');
    git('tag', 'v0.9.0-legacy');

    const releases = await service.fetchReleases(dir, new Map(), ['main', 'master']);
    expect(releases.map((r) => r.tag)).toEqual(['v1.0.0']);
  });

  it('skips tags already stored with the same commit', async () => {
    initRepo('main');
    const first = commit('one');
    git('tag', 'v1.0.0');
    commit('two');
    git('tag', 'v1.1.0');

    const releases = await service.fetchReleases(dir, new Map([['v1.0.0', first]]));
    expect(releases.map((r) => r.tag)).toEqual(['v1.1.0']);
    // The skipped tag still bounds the next release.
    expect(releases[0].previousTag).toBe('v1.0.0');
    expect(releases[0].commits.map((c) => c.message)).toEqual(['two']);
  });
});
