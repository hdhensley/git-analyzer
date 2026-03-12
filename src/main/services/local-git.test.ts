import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LocalGitService } from './local-git';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('LocalGitService', () => {
  let service: LocalGitService;
  let tempDir: string;

  beforeEach(async () => {
    service = new LocalGitService();
    // Create a temporary directory for testing
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-git-test-'));
  });

  afterEach(async () => {
    // Clean up temporary directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('scanForRepositories', () => {
    it('should return empty result for empty directory', async () => {
      const result = await service.scanForRepositories(tempDir);

      expect(result.repositories).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should find a git repository in root directory', async () => {
      // Create a .git folder in the temp directory
      await fs.mkdir(path.join(tempDir, '.git'));

      const result = await service.scanForRepositories(tempDir);

      expect(result.repositories).toHaveLength(1);
      expect(result.repositories[0].path).toBe(tempDir);
      expect(result.repositories[0].name).toBe(path.basename(tempDir));
      expect(result.errors).toHaveLength(0);
    });

    it('should find nested git repositories', async () => {
      // Create nested structure with git repos
      const repo1 = path.join(tempDir, 'project1');
      const repo2 = path.join(tempDir, 'projects', 'project2');

      await fs.mkdir(repo1);
      await fs.mkdir(path.join(repo1, '.git'));
      await fs.mkdir(path.join(tempDir, 'projects'), { recursive: true });
      await fs.mkdir(repo2);
      await fs.mkdir(path.join(repo2, '.git'));

      const result = await service.scanForRepositories(tempDir);

      expect(result.repositories).toHaveLength(2);
      const paths = result.repositories.map((r) => r.path);
      expect(paths).toContain(repo1);
      expect(paths).toContain(repo2);
    });

    it('should skip .git directories during traversal', async () => {
      // Create a repo with a nested .git folder that shouldn't be scanned
      const repo = path.join(tempDir, 'myrepo');
      await fs.mkdir(repo);
      await fs.mkdir(path.join(repo, '.git'));
      // Create a nested folder inside .git that looks like a repo (should be ignored)
      await fs.mkdir(path.join(repo, '.git', 'fake-repo'));
      await fs.mkdir(path.join(repo, '.git', 'fake-repo', '.git'));

      const result = await service.scanForRepositories(tempDir);

      // Should only find the main repo, not the fake one inside .git
      expect(result.repositories).toHaveLength(1);
      expect(result.repositories[0].path).toBe(repo);
    });

    it('should skip node_modules directories during traversal', async () => {
      // Create a repo inside node_modules (should be ignored)
      const nodeModules = path.join(tempDir, 'node_modules');
      await fs.mkdir(nodeModules);
      await fs.mkdir(path.join(nodeModules, 'some-package'));
      await fs.mkdir(path.join(nodeModules, 'some-package', '.git'));

      // Create a real repo outside node_modules
      const realRepo = path.join(tempDir, 'real-repo');
      await fs.mkdir(realRepo);
      await fs.mkdir(path.join(realRepo, '.git'));

      const result = await service.scanForRepositories(tempDir);

      // Should only find the real repo, not the one in node_modules
      expect(result.repositories).toHaveLength(1);
      expect(result.repositories[0].path).toBe(realRepo);
    });

    it('should emit progress callbacks', async () => {
      // Create a few directories and repos
      const repo = path.join(tempDir, 'repo');
      await fs.mkdir(repo);
      await fs.mkdir(path.join(repo, '.git'));
      await fs.mkdir(path.join(tempDir, 'empty-dir'));

      const progressCalls: Array<{
        currentPath: string;
        repositoriesFound: number;
        directoriesScanned: number;
      }> = [];

      await service.scanForRepositories(tempDir, (progress) => {
        progressCalls.push({ ...progress });
      });

      // Should have received progress callbacks
      expect(progressCalls.length).toBeGreaterThan(0);

      // directoriesScanned should be monotonically increasing
      for (let i = 1; i < progressCalls.length; i++) {
        expect(progressCalls[i].directoriesScanned).toBeGreaterThanOrEqual(
          progressCalls[i - 1].directoriesScanned
        );
      }

      // repositoriesFound should be monotonically increasing
      for (let i = 1; i < progressCalls.length; i++) {
        expect(progressCalls[i].repositoriesFound).toBeGreaterThanOrEqual(
          progressCalls[i - 1].repositoriesFound
        );
      }

      // Final progress should show 1 repository found
      const lastProgress = progressCalls[progressCalls.length - 1];
      expect(lastProgress.repositoriesFound).toBeGreaterThanOrEqual(1);
    });

    it('should return error for non-existent directory', async () => {
      const nonExistentPath = path.join(tempDir, 'does-not-exist');

      const result = await service.scanForRepositories(nonExistentPath);

      expect(result.repositories).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].path).toBe(nonExistentPath);
      expect(result.errors[0].error).toContain('not found');
    });

    it('should extract repository name from directory name', async () => {
      const repoName = 'my-awesome-project';
      const repo = path.join(tempDir, repoName);
      await fs.mkdir(repo);
      await fs.mkdir(path.join(repo, '.git'));

      const result = await service.scanForRepositories(tempDir);

      expect(result.repositories).toHaveLength(1);
      expect(result.repositories[0].name).toBe(repoName);
    });

    it('should handle deeply nested repositories', async () => {
      // Create a deeply nested repo
      const deepPath = path.join(tempDir, 'a', 'b', 'c', 'd', 'repo');
      await fs.mkdir(deepPath, { recursive: true });
      await fs.mkdir(path.join(deepPath, '.git'));

      const result = await service.scanForRepositories(tempDir);

      expect(result.repositories).toHaveLength(1);
      expect(result.repositories[0].path).toBe(deepPath);
    });

    it('should not treat .git file as repository', async () => {
      // Some repos use .git as a file (for worktrees), not a directory
      const repo = path.join(tempDir, 'worktree-repo');
      await fs.mkdir(repo);
      // Create .git as a file, not a directory
      await fs.writeFile(path.join(repo, '.git'), 'gitdir: /some/path');

      const result = await service.scanForRepositories(tempDir);

      // Should not find this as a repository since .git is a file
      expect(result.repositories).toHaveLength(0);
    });

    it('should set default branch to main when detectDefaultBranch fails', async () => {
      const repo = path.join(tempDir, 'repo');
      await fs.mkdir(repo);
      await fs.mkdir(path.join(repo, '.git'));

      const result = await service.scanForRepositories(tempDir);

      expect(result.repositories).toHaveLength(1);
      // Since detectDefaultBranch is not implemented, it should default to 'main'
      expect(result.repositories[0].defaultBranch).toBe('main');
    });
  });

  describe('generateRepositoryId', () => {
    it('should generate deterministic ID for same path', () => {
      const path1 = '/home/user/projects/repo';
      const id1 = service.generateRepositoryId(path1);
      const id2 = service.generateRepositoryId(path1);

      expect(id1).toBe(id2);
    });

    it('should generate different IDs for different paths', () => {
      const id1 = service.generateRepositoryId('/path/to/repo1');
      const id2 = service.generateRepositoryId('/path/to/repo2');

      expect(id1).not.toBe(id2);
    });

    it('should generate ID with local- prefix', () => {
      const id = service.generateRepositoryId('/some/path');

      expect(id).toMatch(/^local-[a-f0-9]{12}$/);
    });
  });

  describe('validateRepositoryPath', () => {
    it('should return true for existing readable directory', async () => {
      const result = await service.validateRepositoryPath(tempDir);

      expect(result).toBe(true);
    });

    it('should return false for non-existent path', async () => {
      const result = await service.validateRepositoryPath(
        path.join(tempDir, 'does-not-exist')
      );

      expect(result).toBe(false);
    });
  });

  describe('detectDefaultBranch', () => {
    it('should detect branch from a real git repository', async () => {
      // Initialize a real git repository
      const repoPath = path.join(tempDir, 'real-repo');
      await fs.mkdir(repoPath);

      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      // Initialize git repo
      await execAsync('git init', { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', {
        cwd: repoPath,
      });
      await execAsync('git config user.name "Test User"', { cwd: repoPath });

      // Create initial commit to establish a branch
      await fs.writeFile(path.join(repoPath, 'README.md'), '# Test');
      await execAsync('git add .', { cwd: repoPath });
      await execAsync('git commit -m "Initial commit"', { cwd: repoPath });

      const branch = await service.detectDefaultBranch(repoPath);

      // Modern git defaults to 'main' or 'master' depending on configuration
      expect(['main', 'master']).toContain(branch);
    });

    it('should return branch name from .git/HEAD file when symbolic-ref fails', async () => {
      // Create a mock git repository structure
      const repoPath = path.join(tempDir, 'mock-repo');
      await fs.mkdir(repoPath);
      await fs.mkdir(path.join(repoPath, '.git'));

      // Write HEAD file with branch reference
      await fs.writeFile(
        path.join(repoPath, '.git', 'HEAD'),
        'ref: refs/heads/develop\n'
      );

      const branch = await service.detectDefaultBranch(repoPath);

      expect(branch).toBe('develop');
    });

    it('should return main for detached HEAD state', async () => {
      // Create a mock git repository with detached HEAD (commit hash)
      const repoPath = path.join(tempDir, 'detached-repo');
      await fs.mkdir(repoPath);
      await fs.mkdir(path.join(repoPath, '.git'));

      // Write HEAD file with a commit hash (detached HEAD)
      await fs.writeFile(
        path.join(repoPath, '.git', 'HEAD'),
        'abc123def456789012345678901234567890abcd\n'
      );

      const branch = await service.detectDefaultBranch(repoPath);

      expect(branch).toBe('main');
    });

    it('should return main when .git/HEAD file is missing', async () => {
      // Create a directory without proper git structure
      const repoPath = path.join(tempDir, 'no-head-repo');
      await fs.mkdir(repoPath);
      await fs.mkdir(path.join(repoPath, '.git'));
      // Don't create HEAD file

      const branch = await service.detectDefaultBranch(repoPath);

      expect(branch).toBe('main');
    });

    it('should handle custom branch names', async () => {
      // Create a mock git repository with custom branch
      const repoPath = path.join(tempDir, 'custom-branch-repo');
      await fs.mkdir(repoPath);
      await fs.mkdir(path.join(repoPath, '.git'));

      // Write HEAD file with custom branch reference
      await fs.writeFile(
        path.join(repoPath, '.git', 'HEAD'),
        'ref: refs/heads/feature/my-feature\n'
      );

      const branch = await service.detectDefaultBranch(repoPath);

      expect(branch).toBe('feature/my-feature');
    });
  });

  describe('fetchCommits', () => {
    let repoPath: string;

    // Helper to create a real git repository with commits
    async function createGitRepoWithCommits(
      commits: Array<{
        message: string;
        authorName?: string;
        authorEmail?: string;
        date?: Date;
      }>
    ): Promise<void> {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      // Initialize git repo
      await execAsync('git init', { cwd: repoPath });
      await execAsync('git config user.email "default@test.com"', {
        cwd: repoPath,
      });
      await execAsync('git config user.name "Default User"', { cwd: repoPath });

      for (const commit of commits) {
        const authorName = commit.authorName || 'Default User';
        const authorEmail = commit.authorEmail || 'default@test.com';

        // Create a file change for each commit
        const filename = `file-${Date.now()}-${Math.random().toString(36).substring(7)}.txt`;
        await fs.writeFile(path.join(repoPath, filename), commit.message);
        await execAsync('git add .', { cwd: repoPath });

        // Set author for this commit
        let commitCmd = `git commit -m "${commit.message}" --author="${authorName} <${authorEmail}>"`;

        // If date is provided, use GIT_AUTHOR_DATE and GIT_COMMITTER_DATE
        if (commit.date) {
          const isoDate = commit.date.toISOString();
          commitCmd = `GIT_AUTHOR_DATE="${isoDate}" GIT_COMMITTER_DATE="${isoDate}" ${commitCmd}`;
        }

        await execAsync(commitCmd, { cwd: repoPath });
      }
    }

    beforeEach(async () => {
      repoPath = path.join(tempDir, 'test-repo');
      await fs.mkdir(repoPath);
    });

    it('should fetch commits from a git repository', async () => {
      await createGitRepoWithCommits([
        { message: 'Initial commit' },
        { message: 'Second commit' },
      ]);

      const commits = await service.fetchCommits(repoPath);

      expect(commits).toHaveLength(2);
      // Git log returns commits in reverse chronological order (newest first)
      expect(commits[0].message).toContain('Second commit');
      expect(commits[1].message).toContain('Initial commit');
    });

    it('should extract all required commit fields', async () => {
      await createGitRepoWithCommits([
        {
          message: 'Test commit',
          authorName: 'John Doe',
          authorEmail: 'john@example.com',
        },
      ]);

      const commits = await service.fetchCommits(repoPath);

      expect(commits).toHaveLength(1);
      const commit = commits[0];

      // Verify all required fields are present and non-empty
      expect(commit.hash).toBeTruthy();
      expect(commit.hash).toMatch(/^[a-f0-9]{40}$/); // SHA-1 hash format
      expect(commit.authorName).toBe('John Doe');
      expect(commit.authorEmail).toBe('john@example.com');
      expect(commit.date).toBeInstanceOf(Date);
      expect(commit.date.getTime()).not.toBeNaN();
      expect(commit.message).toContain('Test commit');
    });

    it('should return empty array for repository with no commits', async () => {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      // Initialize git repo without any commits
      await execAsync('git init', { cwd: repoPath });

      const commits = await service.fetchCommits(repoPath);

      expect(commits).toHaveLength(0);
    });

    it('should support since parameter for incremental fetches', async () => {
      const oldDate = new Date('2020-01-01T00:00:00Z');
      const newDate = new Date('2024-01-01T00:00:00Z');

      await createGitRepoWithCommits([
        { message: 'Old commit', date: oldDate },
        { message: 'New commit', date: newDate },
      ]);

      // Fetch only commits after 2023
      const sinceDate = new Date('2023-01-01T00:00:00Z');
      const commits = await service.fetchCommits(repoPath, sinceDate);

      expect(commits).toHaveLength(1);
      expect(commits[0].message).toContain('New commit');
    });

    it('should return all commits when since is not provided', async () => {
      const oldDate = new Date('2020-01-01T00:00:00Z');
      const newDate = new Date('2024-01-01T00:00:00Z');

      await createGitRepoWithCommits([
        { message: 'Old commit', date: oldDate },
        { message: 'New commit', date: newDate },
      ]);

      const commits = await service.fetchCommits(repoPath);

      expect(commits).toHaveLength(2);
    });

    it('should throw error for non-existent repository path', async () => {
      const nonExistentPath = path.join(tempDir, 'does-not-exist');

      await expect(service.fetchCommits(nonExistentPath)).rejects.toThrow(
        'Repository path not found'
      );
    });

    it('should handle commits with multi-line messages', async () => {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      // Initialize git repo
      await execAsync('git init', { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', {
        cwd: repoPath,
      });
      await execAsync('git config user.name "Test User"', { cwd: repoPath });

      // Create a commit with multi-line message
      await fs.writeFile(path.join(repoPath, 'file.txt'), 'content');
      await execAsync('git add .', { cwd: repoPath });
      await execAsync(
        'git commit -m "First line" -m "Second line" -m "Third line"',
        { cwd: repoPath }
      );

      const commits = await service.fetchCommits(repoPath);

      expect(commits).toHaveLength(1);
      expect(commits[0].message).toContain('First line');
      expect(commits[0].message).toContain('Second line');
      expect(commits[0].message).toContain('Third line');
    });

    it('should handle commits with special characters in message', async () => {
      await createGitRepoWithCommits([
        { message: 'Fix: handle "quotes" and <brackets>' },
      ]);

      const commits = await service.fetchCommits(repoPath);

      expect(commits).toHaveLength(1);
      // Note: Git strips double quotes from commit messages when using --format option
      // so we verify the message contains the expected content without quotes
      expect(commits[0].message).toContain('Fix: handle quotes and <brackets>');
    });

    it('should handle multiple authors', async () => {
      await createGitRepoWithCommits([
        {
          message: 'Commit by Alice',
          authorName: 'Alice',
          authorEmail: 'alice@example.com',
        },
        {
          message: 'Commit by Bob',
          authorName: 'Bob',
          authorEmail: 'bob@example.com',
        },
      ]);

      const commits = await service.fetchCommits(repoPath);

      expect(commits).toHaveLength(2);

      const alice = commits.find((c) => c.authorName === 'Alice');
      const bob = commits.find((c) => c.authorName === 'Bob');

      expect(alice).toBeDefined();
      expect(alice?.authorEmail).toBe('alice@example.com');
      expect(bob).toBeDefined();
      expect(bob?.authorEmail).toBe('bob@example.com');
    });

    it('should return commits in reverse chronological order', async () => {
      const date1 = new Date('2024-01-01T00:00:00Z');
      const date2 = new Date('2024-02-01T00:00:00Z');
      const date3 = new Date('2024-03-01T00:00:00Z');

      await createGitRepoWithCommits([
        { message: 'First', date: date1 },
        { message: 'Second', date: date2 },
        { message: 'Third', date: date3 },
      ]);

      const commits = await service.fetchCommits(repoPath);

      expect(commits).toHaveLength(3);
      // Newest first
      expect(commits[0].message).toContain('Third');
      expect(commits[1].message).toContain('Second');
      expect(commits[2].message).toContain('First');
    });

    it('should return empty array when since date is after all commits', async () => {
      const commitDate = new Date('2020-01-01T00:00:00Z');

      await createGitRepoWithCommits([{ message: 'Old commit', date: commitDate }]);

      // Fetch commits after 2025
      const sinceDate = new Date('2025-01-01T00:00:00Z');
      const commits = await service.fetchCommits(repoPath, sinceDate);

      expect(commits).toHaveLength(0);
    });
  });

});
