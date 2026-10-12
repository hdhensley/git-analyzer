import { describe, it, expect, vi } from 'vitest';

// Avoid pulling in Electron/keytar via the real AuthService during construction.
vi.mock('./auth', () => ({
  getAuthService: () => ({
    getAuthHeader: vi.fn(),
    getCredentials: vi.fn(),
  }),
}));

import { GitService } from './git';

describe('GitService.listCachedScmProjectGroups', () => {
  const service = new GitService();

  it('groups imported repos by parentFolder and counts them, filtered by provider', () => {
    const imported = [
      { provider: 'bitbucket', parentFolder: 'Microservices' },
      { provider: 'bitbucket', parentFolder: 'Microservices' },
      { provider: 'bitbucket', parentFolder: 'Platform' },
      { provider: 'github', parentFolder: 'my-org' }, // different provider, excluded
    ];

    const groups = service.listCachedScmProjectGroups('bitbucket', imported);

    expect(groups).toEqual([
      { provider: 'bitbucket', name: 'Microservices', repositoryCount: 2 },
      { provider: 'bitbucket', name: 'Platform', repositoryCount: 1 },
    ]);
  });

  it('buckets repos without a parentFolder under (ungrouped)', () => {
    const imported = [
      { provider: 'bitbucket', parentFolder: undefined },
      { provider: 'bitbucket', parentFolder: 'Microservices' },
    ];

    const groups = service.listCachedScmProjectGroups('bitbucket', imported);

    expect(groups).toContainEqual({
      provider: 'bitbucket',
      name: '(ungrouped)',
      repositoryCount: 1,
    });
    expect(groups).toContainEqual({
      provider: 'bitbucket',
      name: 'Microservices',
      repositoryCount: 1,
    });
  });

  it('returns an empty list when no imported repos match the provider', () => {
    const groups = service.listCachedScmProjectGroups('bitbucket', [
      { provider: 'github', parentFolder: 'my-org' },
    ]);

    expect(groups).toEqual([]);
  });

  it('sorts groups alphabetically by name', () => {
    const imported = [
      { provider: 'bitbucket', parentFolder: 'Zeta' },
      { provider: 'bitbucket', parentFolder: 'Alpha' },
      { provider: 'bitbucket', parentFolder: 'Mu' },
    ];

    const groups = service.listCachedScmProjectGroups('bitbucket', imported);

    expect(groups.map((g) => g.name)).toEqual(['Alpha', 'Mu', 'Zeta']);
  });
});
