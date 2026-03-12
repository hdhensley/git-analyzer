import Database from 'better-sqlite3';
import path from 'path';
import { app } from 'electron';
import type {
  Repository,
  ImportedRepository,
  Commit,
  CommitData,
  CommitFilter,
  UserPreferences,
  DateRangePreset,
  RepositorySource,
} from '../../shared/types';

export class DatabaseService {
  private db: Database.Database;

  constructor(dbPath?: string) {
    // Only access Electron's app module when no dbPath is provided
    // This allows tests to pass a custom path without requiring Electron
    let resolvedPath: string;
    if (dbPath) {
      resolvedPath = dbPath;
    } else {
      resolvedPath = path.join(app.getPath('userData'), 'git-analytics.db');
    }
    this.db = new Database(resolvedPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      -- SCM Provider connections
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        connected_at DATETIME NOT NULL,
        last_validated_at DATETIME
      );

      -- Imported repositories
      CREATE TABLE IF NOT EXISTS repositories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner TEXT NOT NULL,
        provider TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        url TEXT NOT NULL,
        imported_at DATETIME NOT NULL,
        last_sync_at DATETIME NOT NULL,
        local_path TEXT,
        is_available INTEGER DEFAULT 1,
        parent_folder TEXT
      );

      -- Git commits
      CREATE TABLE IF NOT EXISTS commits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        hash TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_email TEXT NOT NULL,
        commit_date DATETIME NOT NULL,
        message TEXT NOT NULL,
        branch TEXT,
        UNIQUE(repository_id, hash)
      );

      -- Indexes for query performance
      CREATE INDEX IF NOT EXISTS idx_commits_repo_date ON commits(repository_id, commit_date);
      CREATE INDEX IF NOT EXISTS idx_commits_author ON commits(author_email);
      CREATE INDEX IF NOT EXISTS idx_commits_date ON commits(commit_date);
      CREATE INDEX IF NOT EXISTS idx_repositories_provider ON repositories(provider);

      -- User preferences (single row)
      CREATE TABLE IF NOT EXISTS preferences (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        selected_repo_ids TEXT,
        date_range_preset TEXT,
        custom_start_date DATETIME,
        custom_end_date DATETIME
      );
    `);

    // Run migrations for existing databases
    this.runMigrations();
  }

  private runMigrations(): void {
    // Check if local_path column exists in repositories table
    const tableInfo = this.db.prepare("PRAGMA table_info(repositories)").all() as Array<{ name: string }>;
    const columnNames = tableInfo.map((col) => col.name);

    // Migration: Add local_path column if it doesn't exist
    if (!columnNames.includes('local_path')) {
      this.db.exec('ALTER TABLE repositories ADD COLUMN local_path TEXT');
    }

    // Migration: Add is_available column if it doesn't exist
    if (!columnNames.includes('is_available')) {
      this.db.exec('ALTER TABLE repositories ADD COLUMN is_available INTEGER DEFAULT 1');
    }

    // Migration: Add parent_folder column if it doesn't exist
    if (!columnNames.includes('parent_folder')) {
      this.db.exec('ALTER TABLE repositories ADD COLUMN parent_folder TEXT');
    }

    // Backfill: Extract parent_folder from local_path for existing local repos
    const reposNeedingBackfill = this.db.prepare(
      'SELECT id, local_path FROM repositories WHERE local_path IS NOT NULL AND parent_folder IS NULL'
    ).all() as Array<{ id: string; local_path: string }>;

    if (reposNeedingBackfill.length > 0) {
      const updateStmt = this.db.prepare('UPDATE repositories SET parent_folder = ? WHERE id = ?');
      for (const repo of reposNeedingBackfill) {
        const parts = repo.local_path.replace(/\/+$/, '').split('/');
        const parentFolder = parts.length >= 2 ? parts[parts.length - 2] : '';
        if (parentFolder) {
          updateStmt.run(parentFolder, repo.id);
        }
      }
    }

    // Check if branch column exists in commits table
    const commitsTableInfo = this.db.prepare("PRAGMA table_info(commits)").all() as Array<{ name: string }>;
    const commitsColumnNames = commitsTableInfo.map((col) => col.name);

    // Migration: Add branch column if it doesn't exist
    if (!commitsColumnNames.includes('branch')) {
      this.db.exec('ALTER TABLE commits ADD COLUMN branch TEXT');
    }

    // Migration: Remove UNIQUE(provider, owner, name) constraint from repositories table.
    // This constraint caused INSERT OR REPLACE to silently delete repos when a repo from
    // a different provider (e.g. bitbucket) shared the same owner+name as an existing one
    // (e.g. local). We rely on the PRIMARY KEY (id) for uniqueness instead.
    const indexInfo = this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='repositories'"
    ).get() as { sql: string } | undefined;

    if (indexInfo?.sql?.includes('UNIQUE(provider, owner, name)')) {
      // Disable foreign keys during table rebuild to prevent CASCADE deletes
      this.db.pragma('foreign_keys = OFF');
      this.db.exec(`
        CREATE TABLE repositories_new (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          owner TEXT NOT NULL,
          provider TEXT NOT NULL,
          default_branch TEXT NOT NULL,
          url TEXT NOT NULL,
          imported_at DATETIME NOT NULL,
          last_sync_at DATETIME NOT NULL,
          local_path TEXT,
          is_available INTEGER DEFAULT 1,
          parent_folder TEXT
        );
        INSERT INTO repositories_new SELECT * FROM repositories;
        DROP TABLE repositories;
        ALTER TABLE repositories_new RENAME TO repositories;
        CREATE INDEX IF NOT EXISTS idx_repositories_provider ON repositories(provider);
      `);
      this.db.pragma('foreign_keys = ON');
    }
  }


  // Repository operations
  saveRepository(repo: Repository): void {
    const stmt = this.db.prepare(`
      INSERT INTO repositories (id, name, owner, provider, default_branch, url, imported_at, last_sync_at, local_path, is_available, parent_folder)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        owner = excluded.owner,
        provider = excluded.provider,
        default_branch = excluded.default_branch,
        url = excluded.url,
        last_sync_at = datetime('now'),
        local_path = excluded.local_path,
        is_available = excluded.is_available,
        parent_folder = excluded.parent_folder
    `);
    // For local repositories, set is_available to 1 (true) by default
    const isAvailable = repo.localPath ? 1 : null;
    stmt.run(repo.id, repo.name, repo.owner, repo.provider, repo.defaultBranch, repo.url, repo.localPath ?? null, isAvailable, repo.parentFolder ?? null);
  }

  getImportedRepositories(): ImportedRepository[] {
    const stmt = this.db.prepare(`
      SELECT r.*, COUNT(c.id) as commit_count
      FROM repositories r
      LEFT JOIN commits c ON c.repository_id = r.id
      GROUP BY r.id
    `);
    const rows = stmt.all() as Array<{
      id: string;
      name: string;
      owner: string;
      provider: string;
      default_branch: string;
      url: string;
      imported_at: string;
      last_sync_at: string;
      commit_count: number;
      local_path: string | null;
      is_available: number | null;
      parent_folder: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      owner: row.owner,
      provider: row.provider as 'github' | 'bitbucket' | 'local',
      defaultBranch: row.default_branch,
      url: row.url,
      importedAt: new Date(row.imported_at),
      lastSyncAt: new Date(row.last_sync_at),
      commitCount: row.commit_count,
      ...(row.local_path && { localPath: row.local_path }),
      ...(row.is_available !== null && { isAvailable: row.is_available === 1 }),
      ...(row.parent_folder && { parentFolder: row.parent_folder }),
    }));
  }

  deleteRepository(repoId: string): void {
    const stmt = this.db.prepare('DELETE FROM repositories WHERE id = ?');
    stmt.run(repoId);
  }

  updateRepositorySyncTime(repoId: string): void {
    const stmt = this.db.prepare(`UPDATE repositories SET last_sync_at = datetime('now') WHERE id = ?`);
    stmt.run(repoId);
  }

  updateRepositoryAvailability(repoId: string, isAvailable: boolean): void {
    const stmt = this.db.prepare(`UPDATE repositories SET is_available = ? WHERE id = ?`);
    stmt.run(isAvailable ? 1 : 0, repoId);
  }

  getRepositoriesByProvider(provider: RepositorySource): ImportedRepository[] {
    const stmt = this.db.prepare(`
      SELECT r.*, COUNT(c.id) as commit_count
      FROM repositories r
      LEFT JOIN commits c ON c.repository_id = r.id
      WHERE r.provider = ?
      GROUP BY r.id
    `);
    const rows = stmt.all(provider) as Array<{
      id: string;
      name: string;
      owner: string;
      provider: string;
      default_branch: string;
      url: string;
      imported_at: string;
      last_sync_at: string;
      commit_count: number;
      local_path: string | null;
      is_available: number | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      owner: row.owner,
      provider: row.provider as RepositorySource,
      defaultBranch: row.default_branch,
      url: row.url,
      importedAt: new Date(row.imported_at),
      lastSyncAt: new Date(row.last_sync_at),
      commitCount: row.commit_count,
      ...(row.local_path && { localPath: row.local_path }),
      ...(row.is_available !== null && { isAvailable: row.is_available === 1 }),
    }));
  }

  // Commit operations
  saveCommits(repoId: string, commits: CommitData[]): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO commits (repository_id, hash, author_name, author_email, commit_date, message, branch)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((commits: CommitData[]) => {
      for (const commit of commits) {
        stmt.run(repoId, commit.hash, commit.authorName, commit.authorEmail, commit.date.toISOString(), commit.message, commit.branch ?? null);
      }
    });

    insertMany(commits);
  }

  getCommits(filter: CommitFilter): Commit[] {
    let sql = `
      SELECT c.*, r.name as repository_name, r.parent_folder as repository_parent_folder
      FROM commits c
      JOIN repositories r ON c.repository_id = r.id
      WHERE 1=1
    `;
    const params: unknown[] = [];

    if (filter.repositoryIds && filter.repositoryIds.length > 0) {
      sql += ` AND c.repository_id IN (${filter.repositoryIds.map(() => '?').join(',')})`;
      params.push(...filter.repositoryIds);
    }

    if (filter.startDate) {
      sql += ' AND c.commit_date >= ?';
      params.push(filter.startDate.toISOString());
    }

    if (filter.endDate) {
      sql += ' AND c.commit_date <= ?';
      params.push(filter.endDate.toISOString());
    }

    if (filter.authorEmail) {
      sql += ' AND c.author_email = ?';
      params.push(filter.authorEmail);
    }

    sql += ' ORDER BY c.commit_date DESC';

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Array<{
      repository_id: string;
      repository_name: string;
      repository_parent_folder: string | null;
      hash: string;
      author_name: string;
      author_email: string;
      commit_date: string;
      message: string;
      branch: string | null;
    }>;

    return rows.map((row) => ({
      hash: row.hash,
      authorName: row.author_name,
      authorEmail: row.author_email,
      date: new Date(row.commit_date),
      message: row.message,
      repositoryId: row.repository_id,
      repositoryName: row.repository_name,
      branch: row.branch ?? undefined,
      ...(row.repository_parent_folder && { repositoryParentFolder: row.repository_parent_folder }),
    }));
  }

  getCommitCount(repoId: string): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM commits WHERE repository_id = ?');
    const row = stmt.get(repoId) as { count: number };
    return row.count;
  }


  // Preferences operations
  savePreferences(prefs: UserPreferences): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO preferences (id, selected_repo_ids, date_range_preset, custom_start_date, custom_end_date)
      VALUES (1, ?, ?, ?, ?)
    `);
    stmt.run(
      JSON.stringify(prefs.selectedRepositoryIds),
      prefs.dateRangePreset ?? null,
      prefs.customDateRange?.start.toISOString() ?? null,
      prefs.customDateRange?.end.toISOString() ?? null
    );
  }

  getPreferences(): UserPreferences {
    const stmt = this.db.prepare('SELECT * FROM preferences WHERE id = 1');
    const row = stmt.get() as {
      selected_repo_ids: string | null;
      date_range_preset: string | null;
      custom_start_date: string | null;
      custom_end_date: string | null;
    } | undefined;

    if (!row) {
      return { selectedRepositoryIds: [] };
    }

    const prefs: UserPreferences = {
      selectedRepositoryIds: row.selected_repo_ids ? JSON.parse(row.selected_repo_ids) : [],
    };

    if (row.date_range_preset) {
      prefs.dateRangePreset = row.date_range_preset as DateRangePreset;
    }

    if (row.custom_start_date && row.custom_end_date) {
      prefs.customDateRange = {
        start: new Date(row.custom_start_date),
        end: new Date(row.custom_end_date),
      };
    }

    return prefs;
  }

  // Data management
  clearAllData(): void {
    this.db.exec(`
      DELETE FROM commits;
      DELETE FROM repositories;
      DELETE FROM providers;
      DELETE FROM preferences;
    `);
  }

  // Provider operations
  saveProvider(providerId: string, username: string): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO providers (id, username, connected_at, last_validated_at)
      VALUES (?, ?, datetime('now'), datetime('now'))
    `);
    stmt.run(providerId, username);
  }

  getProvider(providerId: string): { username: string; connectedAt: Date } | null {
    const stmt = this.db.prepare('SELECT username, connected_at FROM providers WHERE id = ?');
    const row = stmt.get(providerId) as { username: string; connected_at: string } | undefined;
    if (!row) return null;
    return { username: row.username, connectedAt: new Date(row.connected_at) };
  }

  deleteProvider(providerId: string): void {
    const stmt = this.db.prepare('DELETE FROM providers WHERE id = ?');
    stmt.run(providerId);
  }

  updateProviderValidation(providerId: string): void {
    const stmt = this.db.prepare(`UPDATE providers SET last_validated_at = datetime('now') WHERE id = ?`);
    stmt.run(providerId);
  }

  close(): void {
    this.db.close();
  }
}

// Singleton instance
let dbInstance: DatabaseService | null = null;

export function getDatabase(): DatabaseService {
  if (!dbInstance) {
    dbInstance = new DatabaseService();
  }
  return dbInstance;
}

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
