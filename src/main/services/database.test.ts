import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseService } from './database';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('DatabaseService - Local Repository Support', () => {
  let db: DatabaseService;
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    // Create a temporary directory for the test database
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'db-test-'));
    dbPath = path.join(tempDir, 'test.db');
    db = new DatabaseService(dbPath);
  });

  afterEach(async () => {
    db.close();
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('saveRepository with localPath', () => {
    it('should save a local repository with localPath field', () => {
      const localRepo = {
        id: 'local-abc123def456',
        name: 'my-local-repo',
        owner: 'local',
        provider: 'local' as const,
        defaultBranch: 'main',
        url: '',
        localPath: '/home/user/projects/my-local-repo',
      };

      db.saveRepository(localRepo);
      const repos = db.getImportedRepositories();

      expect(repos).toHaveLength(1);
      expect(repos[0].id).toBe(localRepo.id);
      expect(repos[0].localPath).toBe(localRepo.localPath);
      expect(repos[0].provider).toBe('local');
      expect(repos[0].isAvailable).toBe(true);
    });

    it('should save a cloud repository without localPath', () => {
      const cloudRepo = {
        id: 'github-123',
        name: 'cloud-repo',
        owner: 'user',
        provider: 'github' as const,
        defaultBranch: 'main',
        url: 'https://github.com/user/cloud-repo',
      };

      db.saveRepository(cloudRepo);
      const repos = db.getImportedRepositories();

      expect(repos).toHaveLength(1);
      expect(repos[0].id).toBe(cloudRepo.id);
      expect(repos[0].localPath).toBeUndefined();
      expect(repos[0].provider).toBe('github');
    });
  });

  describe('getImportedRepositories', () => {
    it('should return localPath and isAvailable for local repositories', () => {
      const localRepo = {
        id: 'local-abc123def456',
        name: 'my-local-repo',
        owner: 'local',
        provider: 'local' as const,
        defaultBranch: 'main',
        url: '',
        localPath: '/home/user/projects/my-local-repo',
      };

      db.saveRepository(localRepo);
      const repos = db.getImportedRepositories();

      expect(repos).toHaveLength(1);
      expect(repos[0].localPath).toBe('/home/user/projects/my-local-repo');
      expect(repos[0].isAvailable).toBe(true);
    });

    it('should return mixed local and cloud repositories', () => {
      const localRepo = {
        id: 'local-abc123',
        name: 'local-repo',
        owner: 'local',
        provider: 'local' as const,
        defaultBranch: 'main',
        url: '',
        localPath: '/path/to/local',
      };

      const githubRepo = {
        id: 'github-456',
        name: 'github-repo',
        owner: 'user',
        provider: 'github' as const,
        defaultBranch: 'main',
        url: 'https://github.com/user/github-repo',
      };

      db.saveRepository(localRepo);
      db.saveRepository(githubRepo);

      const repos = db.getImportedRepositories();

      expect(repos).toHaveLength(2);
      
      const local = repos.find(r => r.provider === 'local');
      const github = repos.find(r => r.provider === 'github');

      expect(local?.localPath).toBe('/path/to/local');
      expect(local?.isAvailable).toBe(true);
      expect(github?.localPath).toBeUndefined();
    });
  });

  describe('updateRepositoryAvailability', () => {
    it('should update availability status to false', () => {
      const localRepo = {
        id: 'local-abc123',
        name: 'local-repo',
        owner: 'local',
        provider: 'local' as const,
        defaultBranch: 'main',
        url: '',
        localPath: '/path/to/local',
      };

      db.saveRepository(localRepo);
      db.updateRepositoryAvailability('local-abc123', false);

      const repos = db.getImportedRepositories();
      expect(repos[0].isAvailable).toBe(false);
    });

    it('should update availability status back to true', () => {
      const localRepo = {
        id: 'local-abc123',
        name: 'local-repo',
        owner: 'local',
        provider: 'local' as const,
        defaultBranch: 'main',
        url: '',
        localPath: '/path/to/local',
      };

      db.saveRepository(localRepo);
      db.updateRepositoryAvailability('local-abc123', false);
      db.updateRepositoryAvailability('local-abc123', true);

      const repos = db.getImportedRepositories();
      expect(repos[0].isAvailable).toBe(true);
    });
  });

  describe('getRepositoriesByProvider', () => {
    beforeEach(() => {
      // Set up test data with multiple providers
      db.saveRepository({
        id: 'local-1',
        name: 'local-repo-1',
        owner: 'local',
        provider: 'local',
        defaultBranch: 'main',
        url: '',
        localPath: '/path/1',
      });

      db.saveRepository({
        id: 'local-2',
        name: 'local-repo-2',
        owner: 'local',
        provider: 'local',
        defaultBranch: 'main',
        url: '',
        localPath: '/path/2',
      });

      db.saveRepository({
        id: 'github-1',
        name: 'github-repo',
        owner: 'user',
        provider: 'github',
        defaultBranch: 'main',
        url: 'https://github.com/user/repo',
      });

      db.saveRepository({
        id: 'bitbucket-1',
        name: 'bitbucket-repo',
        owner: 'user',
        provider: 'bitbucket',
        defaultBranch: 'main',
        url: 'https://bitbucket.org/user/repo',
      });
    });

    it('should return only local repositories when filtering by local', () => {
      const repos = db.getRepositoriesByProvider('local');

      expect(repos).toHaveLength(2);
      expect(repos.every(r => r.provider === 'local')).toBe(true);
    });

    it('should return only github repositories when filtering by github', () => {
      const repos = db.getRepositoriesByProvider('github');

      expect(repos).toHaveLength(1);
      expect(repos[0].provider).toBe('github');
      expect(repos[0].name).toBe('github-repo');
    });

    it('should return only bitbucket repositories when filtering by bitbucket', () => {
      const repos = db.getRepositoriesByProvider('bitbucket');

      expect(repos).toHaveLength(1);
      expect(repos[0].provider).toBe('bitbucket');
      expect(repos[0].name).toBe('bitbucket-repo');
    });

    it('should return empty array when no repositories match provider', () => {
      // Clear all data first
      db.clearAllData();

      const repos = db.getRepositoriesByProvider('local');

      expect(repos).toHaveLength(0);
    });

    it('should include localPath and isAvailable for local repositories', () => {
      const repos = db.getRepositoriesByProvider('local');

      expect(repos).toHaveLength(2);
      repos.forEach(repo => {
        expect(repo.localPath).toBeDefined();
        expect(repo.isAvailable).toBe(true);
      });
    });
  });
  describe('space settings', () => {
    it('returns null for an unset key', () => {
      expect(db.getSetting('awsProfile')).toBeNull();
    });

    it('stores, overwrites and removes values', () => {
      db.setSetting('awsProfile', 'work');
      expect(db.getSetting('awsProfile')).toBe('work');
      db.setSetting('awsProfile', 'other');
      expect(db.getSetting('awsProfile')).toBe('other');
      db.setSetting('awsProfile', null);
      expect(db.getSetting('awsProfile')).toBeNull();
    });

    it('keeps settings separate between databases', async () => {
      const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), 'db-test-other-'));
      const other = new DatabaseService(path.join(otherDir, 'other.db'));
      try {
        db.setSetting('k', 'a');
        expect(other.getSetting('k')).toBeNull();
      } finally {
        other.close();
        await fs.rm(otherDir, { recursive: true, force: true });
      }
    });
  });
});

describe('DatabaseService - Releases', () => {
  let db: DatabaseService;
  let tempDir: string;

  const repo = {
    id: 'bitbucket-1',
    name: 'billing',
    owner: 'team',
    provider: 'bitbucket' as const,
    defaultBranch: 'main',
    url: 'https://bitbucket.org/team/billing',
  };
  const release = (tag: string, sha: string, iso: string, messages: string[]) => ({
    tag,
    sha,
    releasedAt: new Date(iso),
    dateSource: 'tag' as const,
    commits: messages.map((message, i) => ({
      hash: `${sha}-${i}`,
      authorName: 'Ann',
      authorEmail: 'ann@example.com',
      date: new Date(iso),
      message,
      isMerge: false,
    })),
  });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'db-releases-'));
    db = new DatabaseService(path.join(tempDir, 'test.db'));
    db.saveRepository(repo);
  });

  afterEach(async () => {
    db.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns releases in the range, newest first, with their commits', () => {
    db.saveReleases(repo.id, [
      release('v1.0.0', 'a', '2025-01-10T00:00:00Z', ['DEV-1 one']),
      release('v1.1.0', 'b', '2025-02-10T00:00:00Z', ['DEV-2 two', 'DEV-3 three']),
      release('v1.2.0', 'c', '2025-03-10T00:00:00Z', ['DEV-4 four']),
    ]);

    const [result] = db.getReleases([repo.id], new Date('2025-02-01T00:00:00Z'), new Date('2025-03-31T00:00:00Z'));
    expect(result.repositoryName).toBe('billing');
    expect(result.releases.map((r) => r.tag)).toEqual(['v1.2.0', 'v1.1.0']);
    expect(result.releases[1].commits).toHaveLength(2);
  });

  it('includes repositories with no releases in the range', () => {
    const [result] = db.getReleases([repo.id], new Date('2025-01-01T00:00:00Z'), new Date('2025-12-31T00:00:00Z'));
    expect(result.releases).toEqual([]);
  });

  it('replaces a release saved again and reports stored tags', () => {
    db.saveReleases(repo.id, [release('v1.0.0', 'a', '2025-01-10T00:00:00Z', ['old'])]);
    db.saveReleases(repo.id, [release('v1.0.0', 'a2', '2025-01-10T00:00:00Z', ['new'])]);

    expect(db.getStoredReleaseTags(repo.id)).toEqual(new Map([['v1.0.0', 'a2']]));
    const [result] = db.getReleases([repo.id], new Date('2025-01-01T00:00:00Z'), new Date('2025-12-31T00:00:00Z'));
    expect(result.releases).toHaveLength(1);
    expect(result.releases[0].commits.map((c) => c.message)).toEqual(['new']);
  });

  it('removes releases when the repository is deleted', () => {
    db.saveReleases(repo.id, [release('v1.0.0', 'a', '2025-01-10T00:00:00Z', ['one'])]);
    db.deleteRepository(repo.id);
    expect(db.getStoredReleaseTags(repo.id).size).toBe(0);
  });

  it('defaults the release branch to main and discards releases when it changes', () => {
    expect(db.getReleaseBranchMode()).toBe('main');
    db.saveReleases(repo.id, [release('v1.0.0', 'a', '2025-01-10T00:00:00Z', ['one'])]);

    db.setReleaseBranchMode('main'); // unchanged: keeps releases
    expect(db.getStoredReleaseTags(repo.id).size).toBe(1);

    db.setReleaseBranchMode('auto');
    expect(db.getReleaseBranchMode()).toBe('auto');
    expect(db.getStoredReleaseTags(repo.id).size).toBe(0);
  });
});
