import { createHash } from 'crypto';
import { dialog } from 'electron';
import { exec } from 'child_process';
import { promisify } from 'util';
import { access, constants, readdir, stat } from 'fs/promises';
import path from 'path';
import type {
  ScanProgress,
  ScanResult,
  LocalRepositoryInfo,
  ScanError,
  Commit,
  CommitData,
} from '../../shared/types';

const execAsync = promisify(exec);

export class LocalGitService {
  /**
   * Opens native directory picker dialog
   * @returns Selected directory path or null if cancelled
   */
  async selectDirectory(): Promise<string | null> {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select Directory to Scan for Git Repositories',
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  }

  /**
   * Generates unique ID for local repository based on path
   * @param absolutePath - Absolute path to repository
   * @returns Unique identifier in format 'local-{hash}'
   */
  generateRepositoryId(absolutePath: string): string {
    const hash = createHash('sha256')
      .update(absolutePath)
      .digest('hex')
      .substring(0, 12);
    return `local-${hash}`;
  }

  /**
   * Checks if git is installed and accessible
   * @returns true if git is available
   */
  async isGitAvailable(): Promise<boolean> {
    try {
      await execAsync('git --version');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Checks if a path exists and is accessible
   * @param repoPath - Path to check
   * @returns true if path exists and is readable
   */
  async validateRepositoryPath(repoPath: string): Promise<boolean> {
    try {
      await access(repoPath, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Recursively scans directory for git repositories
   * @param rootPath - Directory to scan
   * @param onProgress - Callback for progress updates
   * @returns Scan results with discovered repositories and any errors
   */
  async scanForRepositories(
    rootPath: string,
    onProgress?: (progress: ScanProgress) => void
  ): Promise<ScanResult> {
    const repositories: LocalRepositoryInfo[] = [];
    const errors: ScanError[] = [];
    let directoriesScanned = 0;

    // Directories to skip during scanning
    const skipDirs = new Set(['.git', 'node_modules']);

    // Check if root path exists
    try {
      await access(rootPath, constants.R_OK);
    } catch {
      errors.push({
        path: rootPath,
        error: 'Directory not found or not accessible',
      });
      return { repositories, errors };
    }

    const scanDirectory = async (dirPath: string): Promise<void> => {
      directoriesScanned++;

      // Emit progress
      if (onProgress) {
        onProgress({
          currentPath: dirPath,
          repositoriesFound: repositories.length,
          directoriesScanned,
        });
      }

      let entries: string[];
      try {
        entries = await readdir(dirPath);
      } catch (err) {
        // Handle permission errors gracefully
        const errorMessage = err instanceof Error ? err.message : String(err);
        const errorCode = (err as NodeJS.ErrnoException).code;
        if (errorCode === 'EACCES' || errorCode === 'EPERM') {
          errors.push({
            path: dirPath,
            error: `Permission denied: ${errorMessage}`,
          });
        } else {
          errors.push({
            path: dirPath,
            error: errorMessage,
          });
        }
        return;
      }

      // Check if this directory is a git repository
      if (entries.includes('.git')) {
        try {
          const gitPath = path.join(dirPath, '.git');
          const gitStat = await stat(gitPath);
          if (gitStat.isDirectory()) {
            // This is a git repository
            let defaultBranch = 'main'; // Default fallback
            try {
              defaultBranch = await this.detectDefaultBranch(dirPath);
            } catch {
              // If detectDefaultBranch fails, use fallback
            }
            repositories.push({
              path: dirPath,
              name: path.basename(dirPath),
              defaultBranch,
              parentFolder: path.basename(path.dirname(dirPath)),
            });

            // Emit progress after finding a repo
            if (onProgress) {
              onProgress({
                currentPath: dirPath,
                repositoriesFound: repositories.length,
                directoriesScanned,
              });
            }
          }
        } catch {
          // If we can't stat .git, continue scanning
        }
      }

      // Recursively scan subdirectories
      const scanPromises: Promise<void>[] = [];
      for (const entry of entries) {
        // Skip excluded directories
        if (skipDirs.has(entry)) {
          continue;
        }

        const entryPath = path.join(dirPath, entry);
        try {
          const entryStat = await stat(entryPath);
          if (entryStat.isDirectory()) {
            scanPromises.push(scanDirectory(entryPath));
          }
        } catch (err) {
          // Handle permission errors for individual entries
          const errorCode = (err as NodeJS.ErrnoException).code;
          if (errorCode === 'EACCES' || errorCode === 'EPERM') {
            errors.push({
              path: entryPath,
              error: `Permission denied`,
            });
          }
          // Skip entries we can't stat
        }
      }

      await Promise.all(scanPromises);
    };

    await scanDirectory(rootPath);

    return { repositories, errors };
  }

  /**
   * Detects the default branch of a repository
   * @param repoPath - Path to git repository
   * @returns Branch name (e.g., 'main', 'master')
   */
  async detectDefaultBranch(repoPath: string): Promise<string> {
    // First, try to get the current branch using git symbolic-ref
    try {
      const { stdout } = await execAsync('git symbolic-ref --short HEAD', {
        cwd: repoPath,
      });
      const branch = stdout.trim();
      if (branch) {
        return branch;
      }
    } catch {
      // symbolic-ref fails in detached HEAD state, fall through to fallback
    }

    // Fallback: read .git/HEAD file directly
    try {
      const { readFile } = await import('fs/promises');
      const headPath = path.join(repoPath, '.git', 'HEAD');
      const headContent = await readFile(headPath, 'utf-8');
      const trimmedContent = headContent.trim();

      // HEAD file format: "ref: refs/heads/branch-name" or a commit hash (detached)
      if (trimmedContent.startsWith('ref: refs/heads/')) {
        return trimmedContent.replace('ref: refs/heads/', '');
      }

      // If it's a detached HEAD (just a commit hash), return 'main' as default
      // This is a reasonable fallback since we can't determine the "default" branch
      return 'main';
    } catch {
      // If we can't read the HEAD file, return 'main' as a safe default
      return 'main';
    }
  }

  /**
   * Extracts commit history from local repository using git CLI
   * @param repoPath - Path to git repository
   * @param since - Optional date to fetch commits after
   * @returns Array of commits
   */
  async fetchCommits(repoPath: string, since?: Date): Promise<CommitData[]> {
    // Validate repository path exists
    const pathExists = await this.validateRepositoryPath(repoPath);
    if (!pathExists) {
      throw new Error(`Repository path not found: ${repoPath}`);
    }

    // Check if git is available
    const gitAvailable = await this.isGitAvailable();
    if (!gitAvailable) {
      throw new Error('Git is not installed or not accessible');
    }

    // Use ASCII control characters as delimiters to avoid shell interpretation issues
    // \x1f = Unit Separator (ASCII 31) - separates fields within a commit
    // \x1e = Record Separator (ASCII 30) - separates commits from each other
    const FIELD_SEP = '\x1f';
    const RECORD_SEP = '\x1e';

    // Build git log command with custom format
    // Format: hash, author name, author email, date (ISO), branch names, message (subject + body)
    // The format string uses %x1f and %x1e to insert the control characters
    // %D shows ref names (branches, tags) - we'll parse this to get branch info
    const format = '%H%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%B%x1e';

    let command = `git log --format="${format}" --all`;

    // Add --since flag if date is provided
    if (since) {
      const isoDate = since.toISOString();
      command += ` --since="${isoDate}"`;
    }

    try {
      const { stdout } = await execAsync(command, {
        cwd: repoPath,
        maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large repos
      });

      if (!stdout.trim()) {
        return [];
      }

      const commits: CommitData[] = [];
      // Split by record separator to get individual commits
      const rawCommits = stdout.split(RECORD_SEP);

      for (const rawCommit of rawCommits) {
        const trimmed = rawCommit.trim();
        if (!trimmed) {
          continue;
        }

        const fields = trimmed.split(FIELD_SEP);
        if (fields.length < 6) {
          // Skip malformed entries
          continue;
        }

        const [hash, authorName, authorEmail, dateStr, refNames, ...messageParts] = fields;
        const message = messageParts.join(FIELD_SEP).trim();

        // Parse the ISO date string
        const date = new Date(dateStr);

        // Extract branch name from ref names (format: "HEAD -> main, origin/main, tag: v1.0")
        // We want the local branch name (after "HEAD -> " or just the first branch)
        let branch: string | undefined;
        if (refNames) {
          const headMatch = refNames.match(/HEAD -> ([^,]+)/);
          if (headMatch) {
            branch = headMatch[1].trim();
          } else {
            // If no HEAD pointer, take the first branch reference (not a tag or remote)
            const branches = refNames.split(',')
              .map(ref => ref.trim())
              .filter(ref => !ref.startsWith('tag:') && !ref.includes('/'));
            if (branches.length > 0) {
              branch = branches[0];
            }
          }
        }

        // Validate required fields are present
        if (!hash || !authorName || !authorEmail || isNaN(date.getTime())) {
          continue;
        }

        commits.push({
          hash,
          authorName,
          authorEmail,
          date,
          message,
          branch,
        });
      }

      return commits;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      // Handle empty repository (no commits yet)
      if (errorMessage.includes('does not have any commits yet')) {
        return [];
      }
      throw new Error(`Failed to fetch commits: ${errorMessage}`);
    }
  }
}

// Singleton instance
let localGitInstance: LocalGitService | null = null;

export function getLocalGitService(): LocalGitService {
  if (!localGitInstance) {
    localGitInstance = new LocalGitService();
  }
  return localGitInstance;
}
