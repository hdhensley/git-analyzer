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
});
