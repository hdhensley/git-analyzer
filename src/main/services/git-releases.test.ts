import { describe, it, expect, vi, afterEach } from 'vitest';
import { GitService } from './git';
import type { AuthService } from './auth';
import type { Repository } from '../../shared/types';

// A stub keeps the real AuthService (and so Electron/keytar) out of the test.
const authStub = {
  getAuthHeader: vi.fn().mockResolvedValue('Bearer test'),
} as unknown as AuthService;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

/** Routes a mocked fetch by URL substring (first match wins). */
function stubFetch(routes: Array<[string, (url: string, init?: RequestInit) => Response]>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url);
      const route = routes.find(([needle]) => url.includes(needle));
      if (!route) throw new Error(`Unexpected request: ${url}`);
      return route[1](url, init);
    })
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GitService.fetchReleases (Bitbucket)', () => {
  const repo: Repository = {
    id: 'bb',
    name: 'billing',
    owner: 'team',
    provider: 'bitbucket',
    defaultBranch: 'main',
    url: 'https://bitbucket.org/team/billing',
  };
  const commit = (hash: string, message: string) => ({
    hash,
    author: { user: { display_name: 'Ann' }, raw: 'Ann <ann@example.com>' },
    date: daysAgo(3),
    message,
    parents: [{ hash: 'p' }],
  });

  it('keeps tags that are on main and lists commits since the previous tag', async () => {
    const calls = stubFetch([
      ['/refs/branches/main', () => json({ name: 'main' })],
      [
        '/refs/tags',
        () =>
          json({
            values: [
              { name: 'v1.1.0', date: daysAgo(2), target: { hash: 'sha2', date: daysAgo(5) } },
              { name: 'v1.0.0', date: daysAgo(20), target: { hash: 'sha1', date: daysAgo(21) } },
              { name: 'v2.0.0-rc', date: daysAgo(1), target: { hash: 'shaX', date: daysAgo(1) } },
            ],
          }),
      ],
      // Reachability: empty result means the tag is fully contained in main.
      ['include=shaX&exclude=main', () => json({ values: [{ hash: 'unmerged' }] })],
      ['exclude=main', () => json({ values: [] })],
      ['include=sha2&exclude=sha1', () => json({ values: [commit('c2', 'DEV-2 two')] })],
      ['include=sha1&pagelen', () => json({ values: [commit('c1', 'DEV-1 one')] })],
    ]);

    const releases = await new GitService(authStub).fetchReleases(repo);

    expect(releases.map((r) => r.tag)).toEqual(['v1.0.0', 'v1.1.0']);
    expect(releases[1].previousTag).toBe('v1.0.0');
    expect(releases[1].dateSource).toBe('tag');
    expect(releases[1].commits.map((c) => c.message)).toEqual(['DEV-2 two']);
    expect(releases[0].commits[0]).toMatchObject({ authorName: 'Ann', isMerge: false });
    expect(calls.some((url) => url.includes('exclude=master'))).toBe(false);
  });

  it('does not refetch tags that are already stored', async () => {
    stubFetch([
      ['/refs/branches/main', () => json({ name: 'main' })],
      [
        '/refs/tags',
        () => json({ values: [{ name: 'v1.0.0', date: daysAgo(2), target: { hash: 'sha1', date: daysAgo(3) } }] }),
      ],
    ]);

    const releases = await new GitService(authStub).fetchReleases(repo, new Map([['v1.0.0', 'sha1']]));
    expect(releases).toEqual([]);
  });

  it('treats a repository without the release branch as having no releases', async () => {
    stubFetch([['/refs/branches/main', () => json({ error: 'not found' }, 404)]]);

    expect(await new GitService(authStub).fetchReleases(repo)).toEqual([]);
  });

  it('uses master when configured, and falls back to it in auto mode', async () => {
    const routes: Array<[string, () => Response]> = [
      ['/refs/branches/main', () => json({ error: 'not found' }, 404)],
      ['/refs/branches/master', () => json({ name: 'master' })],
      [
        '/refs/tags',
        () => json({ values: [{ name: 'v1.0.0', date: daysAgo(2), target: { hash: 'sha1', date: daysAgo(3) } }] }),
      ],
      ['exclude=master', () => json({ values: [] })],
      ['include=sha1&pagelen', () => json({ values: [commit('c1', 'DEV-1 one')] })],
    ];
    stubFetch(routes);
    const onlyMaster = await new GitService(authStub).fetchReleases(repo, new Map(), ['master']);
    expect(onlyMaster.map((r) => r.tag)).toEqual(['v1.0.0']);

    stubFetch(routes);
    const auto = await new GitService(authStub).fetchReleases(repo, new Map(), ['main', 'master']);
    expect(auto.map((r) => r.tag)).toEqual(['v1.0.0']);
  });
});

describe('GitService.fetchReleases (GitHub)', () => {
  const repo: Repository = {
    id: 'gh',
    name: 'billing',
    owner: 'acme',
    provider: 'github',
    defaultBranch: 'main',
    url: 'https://github.com/acme/billing',
  };

  it('uses tagger dates, checks reachability from main, and lists commits via compare', async () => {
    stubFetch([
      ['/branches/main', () => json({ name: 'main' })],
      [
        '/graphql',
        () =>
          json({
            data: {
              repository: {
                refs: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      name: 'v1.1.0',
                      target: { oid: 'tagobj', tagger: { date: daysAgo(2) }, target: { oid: 'sha2', committedDate: daysAgo(6) } },
                    },
                    { name: 'v1.0.0', target: { oid: 'sha1', committedDate: daysAgo(30) } },
                  ],
                },
              },
            },
          }),
      ],
      ['compare/sha2...main', () => json({ status: 'ahead' })],
      ['compare/sha1...main', () => json({ status: 'ahead' })],
      [
        'compare/sha1...sha2',
        () =>
          json({
            commits: [
              {
                sha: 'c2',
                commit: { author: { name: 'Ann', email: 'ann@example.com', date: daysAgo(4) }, message: 'DEV-2 two' },
                parents: [{}],
              },
            ],
          }),
      ],
      [
        '/commits?sha=sha1',
        () =>
          json([
            {
              sha: 'c1',
              commit: { author: { name: 'Bob', email: 'bob@example.com', date: daysAgo(31) }, message: 'DEV-1 one' },
              parents: [{}, {}],
            },
          ]),
      ],
    ]);

    const releases = await new GitService(authStub).fetchReleases(repo);

    expect(releases.map((r) => r.tag)).toEqual(['v1.0.0', 'v1.1.0']);
    expect(releases[1].sha).toBe('sha2');
    expect(releases[1].dateSource).toBe('tag');
    expect(releases[0].dateSource).toBe('commit');
    expect(releases[0].commits[0].isMerge).toBe(true);
    expect(releases[1].commits.map((c) => c.hash)).toEqual(['c2']);
  });

  it('drops tags that main does not contain', async () => {
    stubFetch([
      ['/branches/main', () => json({ name: 'main' })],
      [
        '/graphql',
        () =>
          json({
            data: {
              repository: {
                refs: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [{ name: 'v9.9.9', target: { oid: 'shaZ', committedDate: daysAgo(1) } }],
                },
              },
            },
          }),
      ],
      ['compare/shaZ...main', () => json({ status: 'diverged' })],
    ]);

    expect(await new GitService(authStub).fetchReleases(repo)).toEqual([]);
  });

  it('returns nothing when the release branch does not exist', async () => {
    stubFetch([['/branches/main', () => json({ message: 'Branch not found' }, 404)]]);

    expect(await new GitService(authStub).fetchReleases(repo)).toEqual([]);
  });
});
