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
  ScmProjectRepository,
  ScmLocalComparison,
  ScmLocalComparisonEntry,
  ScmLocalOnlyEntry,
} from '../../shared/types';

const execAsync = promisify(exec);

/**
 * Removes embedded credentials from any string that may contain an
 * authenticated URL, so tokens never leak into logs or error messages. Kept as
 * a defensive guard on clone error output even though SSH URLs carry no secret.
 */
export function redactCloneUrl(text: string): string {
  // Replace the "user:pass@" userinfo segment of any https URL with "***@".
  return text.replace(/(https:\/\/)[^@/\s]+@/g, '$1***@');
}

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
   * Opens a native directory picker for choosing the folder to compare against.
   * @returns Selected directory path or null if cancelled
   */
  async selectFolder(title = 'Select Local Folder'): Promise<string | null> {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title,
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  }

  /**
   * Returns the names of immediate child directories of a folder.
   * @param folderPath - Folder to list
   */
  async listSubdirectories(folderPath: string): Promise<string[]> {
    const entries = await readdir(folderPath, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  }

  /**
   * Compares a set of SCM repositories against the immediate subdirectories of a
   * local folder, flagging each repository as present or missing locally.
   * Matching is done on repository slug/name, case-insensitively.
   */
  async compareWithLocalFolder(
    localFolder: string,
    repositories: ScmProjectRepository[]
  ): Promise<ScmLocalComparison> {
    const folderExists = await this.validateRepositoryPath(localFolder);
    if (!folderExists) {
      throw new Error(`Local folder not found: ${localFolder}`);
    }

    const subdirs = await this.listSubdirectories(localFolder);
    const byLowerName = new Map<string, string>();
    for (const name of subdirs) {
      byLowerName.set(name.toLowerCase(), name);
    }

    // Track which local subdirectories were matched by an SCM repo so the
    // unmatched ones can be reported as local-only below.
    const matchedLowerNames = new Set<string>();

    const describeLocalDir = async (
      name: string
    ): Promise<{ localPath: string; isGitRepo: boolean; localBranch?: string }> => {
      const localPath = path.join(localFolder, name);
      let isGitRepo = false;
      try {
        const gitStat = await stat(path.join(localPath, '.git'));
        isGitRepo = gitStat.isDirectory() || gitStat.isFile();
      } catch {
        isGitRepo = false;
      }
      const localBranch = isGitRepo ? await this.getCurrentBranch(localPath) : undefined;
      return { localPath, isGitRepo, localBranch };
    };

    const entries: ScmLocalComparisonEntry[] = [];
    for (const repository of repositories) {
      const matchName = byLowerName.get(repository.name.toLowerCase());
      if (!matchName) {
        entries.push({ repository, present: false });
        continue;
      }

      matchedLowerNames.add(matchName.toLowerCase());
      const { localPath, isGitRepo, localBranch } = await describeLocalDir(matchName);
      entries.push({ repository, present: true, localPath, isGitRepo, localBranch });
    }

    // Local directories that exist but match no SCM repo in the project.
    const localOnly: ScmLocalOnlyEntry[] = [];
    for (const name of subdirs) {
      if (matchedLowerNames.has(name.toLowerCase())) continue;
      const { localPath, isGitRepo, localBranch } = await describeLocalDir(name);
      localOnly.push({ name, localPath, isGitRepo, localBranch });
    }
    localOnly.sort((a, b) => a.name.localeCompare(b.name));

    return { localFolder, entries, localOnly };
  }

  /**
   * Clones a repository into {destinationDir}/{name}. Intended to be given an
   * SSH clone URL (git@host:owner/repo.git) so it uses the user's existing SSH
   * keys/agent. Runs non-interactively: if SSH auth is not set up for the host,
   * git fails fast rather than blocking on a prompt, and the error is surfaced.
   * @returns The absolute path the repository was cloned into
   */
  async cloneRepository(
    cloneUrl: string,
    destinationDir: string,
    name: string
  ): Promise<{ path: string }> {
    const gitAvailable = await this.isGitAvailable();
    if (!gitAvailable) {
      throw new Error('Git is not installed or not accessible');
    }

    const targetPath = path.join(destinationDir, name);

    try {
      await execAsync(`git clone ${JSON.stringify(cloneUrl)} ${JSON.stringify(targetPath)}`, {
        maxBuffer: 50 * 1024 * 1024,
        env: {
          ...process.env,
          // Never block on an interactive credential prompt.
          GIT_TERMINAL_PROMPT: '0',
          // Fail fast instead of prompting for an unknown host key or password;
          // honor the user's existing keys via BatchMode SSH.
          GIT_SSH_COMMAND:
            process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
        },
      });
      return { path: targetPath };
    } catch (err) {
      // redactCloneUrl is harmless for SSH URLs and still guards any https
      // fallback a URL might contain.
      const rawMessage = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to clone ${name}: ${redactCloneUrl(rawMessage)}`);
    }
  }

  /**
   * Returns the branch currently checked out in a local repository, without the
   * misleading 'main' fallback used by {@link detectDefaultBranch}.
   * @returns The branch name, '(detached)' for a detached HEAD, or undefined if
   *   the branch cannot be determined.
   */
  async getCurrentBranch(repoPath: string): Promise<string | undefined> {
    // Primary: ask git directly. Augment PATH so a packaged macOS .app (which
    // launches with a minimal PATH) can still find Homebrew/Xcode git.
    try {
      const { stdout } = await execAsync('git symbolic-ref --short HEAD', {
        cwd: repoPath,
        env: {
          ...process.env,
          PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin:/usr/bin`,
        },
      });
      const branch = stdout.trim();
      if (branch) return branch;
    } catch {
      // symbolic-ref fails on a detached HEAD or when git is unavailable;
      // fall through to inspect the HEAD file directly.
    }

    // Fallback: read HEAD without git. Resolve a `.git` that is a gitdir
    // pointer file (worktrees/submodules) to the real git directory first.
    try {
      const { readFile } = await import('fs/promises');
      let gitDir = path.join(repoPath, '.git');
      const gitEntry = await stat(gitDir);
      if (gitEntry.isFile()) {
        // ".git" file contains "gitdir: <path>"
        const pointer = (await readFile(gitDir, 'utf-8')).trim();
        const match = pointer.match(/^gitdir:\s*(.+)$/);
        if (match) {
          const resolved = match[1].trim();
          gitDir = path.isAbsolute(resolved) ? resolved : path.resolve(repoPath, resolved);
        }
      }

      const headContent = (await readFile(path.join(gitDir, 'HEAD'), 'utf-8')).trim();
      if (headContent.startsWith('ref: refs/heads/')) {
        return headContent.replace('ref: refs/heads/', '');
      }
      // A bare commit hash means a detached HEAD.
      if (headContent) return '(detached)';
    } catch {
      // HEAD still unreadable; report unknown rather than guessing.
    }

    return undefined;
  }

  /**
   * Runs a git command in a repo with an augmented PATH so a packaged macOS
   * .app (launched with a minimal PATH) can still find git.
   */
  private async git(repoPath: string, args: string): Promise<string> {
    const { stdout } = await execAsync(`git ${args}`, {
      cwd: repoPath,
      env: {
        ...process.env,
        PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin:/usr/bin`,
      },
    });
    return stdout.trim();
  }

  /**
   * Resolves the first branch name that actually exists in the repo, trying a
   * list of candidates against both local and remote-tracking refs. Returns the
   * ref to use in rev-list (preferring the local branch, else origin/<name>),
   * or undefined if none of the candidates exist.
   */
  private async resolveBranchRef(
    repoPath: string,
    candidates: string[]
  ): Promise<string | undefined> {
    for (const name of candidates) {
      try {
        await this.git(repoPath, `rev-parse --verify --quiet refs/heads/${name}`);
        return name;
      } catch {
        // Not a local branch; try the remote-tracking ref next.
      }
      try {
        await this.git(repoPath, `rev-parse --verify --quiet refs/remotes/origin/${name}`);
        return `origin/${name}`;
      } catch {
        // Neither local nor remote; try the next candidate.
      }
    }
    return undefined;
  }

  /**
   * Computes how far a comparison branch (develop) is ahead of / behind a base
   * branch (main) for a LOCAL repository. Uses whatever refs exist in the local
   * clone (no network fetch), so results reflect the last pull. Returns null if
   * either side cannot be resolved (e.g. the repo has no develop branch).
   *
   * Note: local repositories only — cloud (GitHub/Bitbucket) comparison is not
   * supported yet.
   */
  async getBranchDivergence(repoPath: string): Promise<import('../../shared/types').BranchDivergence | null> {
    const base = await this.resolveBranchRef(repoPath, ['main', 'master']);
    const compare = await this.resolveBranchRef(repoPath, ['develop', 'dev']);
    if (!base || !compare) {
      return null;
    }
    try {
      // `--left-right --count A...B` prints "<left>\t<right>": left = commits on
      // base not on compare (behind), right = commits on compare not on base (ahead).
      const out = await this.git(repoPath, `rev-list --left-right --count ${base}...${compare}`);
      const parts = out.split(/\s+/).map((n) => parseInt(n, 10));
      if (parts.length < 2 || parts.some((n) => Number.isNaN(n))) {
        return null;
      }
      const [behind, ahead] = parts;
      return {
        base: base.replace(/^origin\//, ''),
        compare: compare.replace(/^origin\//, ''),
        ahead,
        behind,
      };
    } catch {
      return null;
    }
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
