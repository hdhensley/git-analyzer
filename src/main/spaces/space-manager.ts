import fs from 'fs';
import path from 'path';
import type { SpaceConnections, SpaceSummary } from '../../shared/types';
import { DatabaseService } from '../services/database';
import { SecureStorage } from '../services/secure-storage';
import { createSpaceContext, type SpaceContext, type SpaceInfo } from './space-context';
import {
  SPACE_COLORS,
  SpaceRegistry,
  newSpaceId,
  spaceDbFile,
  type RegistryData,
  type SpaceRecord,
} from './space-registry';

export type SpaceContextFactory = typeof createSpaceContext;
/** Removes every keychain entry belonging to a credential namespace. */
export type CredentialCleaner = (namespace: string | undefined) => Promise<void>;

const keychainCleaner: CredentialCleaner = (namespace) =>
  new SecureStorage(namespace).deleteAllCredentials();

/** Reports which services have saved credentials under a namespace. */
export type ConnectionProbe = (namespace: string | undefined) => Promise<SpaceConnections>;

const keychainProbe: ConnectionProbe = async (namespace) => {
  const storage = new SecureStorage(namespace);
  // A locked or unavailable keychain must not break listing spaces.
  const has = (key: 'github' | 'bitbucket' | 'snyk') => storage.hasCredentials(key).catch(() => false);
  const [github, bitbucket, snyk] = await Promise.all([has('github'), has('bitbucket'), has('snyk')]);
  return { github, bitbucket, snyk };
};

/** Copies a database file to a new location (consistent, WAL-safe). */
export type DatabaseCopier = (src: string, dest: string) => Promise<void>;

/** Overridable collaborators; tests replace them to avoid the keychain and SQLite. */
export interface SpaceManagerDeps {
  factory?: SpaceContextFactory;
  cleanCredentials?: CredentialCleaner;
  probeConnections?: ConnectionProbe;
  copyDatabase?: DatabaseCopier;
}

const MAX_NAME_LENGTH = 40;

/**
 * Owns the registry and the active space. Callers must ask for `active()` at
 * the moment they need a service and never cache one across calls, so that a
 * switch cannot leave them holding a closed database.
 */
export class SpaceManager {
  private readonly registry: SpaceRegistry;
  private data: RegistryData | null = null;
  private current: SpaceContext | null = null;
  private busy = new Map<symbol, string>();

  private readonly factory: SpaceContextFactory;
  private readonly cleanCredentials: CredentialCleaner;
  private readonly probeConnections: ConnectionProbe;
  private readonly copyDatabase: DatabaseCopier;

  constructor(
    private readonly userDataDir: string,
    deps: SpaceManagerDeps = {}
  ) {
    this.factory = deps.factory ?? createSpaceContext;
    this.cleanCredentials = deps.cleanCredentials ?? keychainCleaner;
    this.probeConnections = deps.probeConnections ?? keychainProbe;
    this.copyDatabase = deps.copyDatabase ?? DatabaseService.copyFile;
    this.registry = new SpaceRegistry(userDataDir);
  }

  private state(): RegistryData {
    if (!this.data) this.data = this.registry.load();
    return this.data;
  }

  private record(id: string): SpaceRecord {
    const found = this.state().spaces.find((s) => s.id === id);
    if (!found) throw new Error(`Unknown space: ${id}`);
    return found;
  }

  private toSummary(r: SpaceRecord): SpaceSummary {
    return {
      id: r.id,
      name: r.name,
      color: r.color,
      createdAt: r.createdAt,
      active: r.id === this.state().activeId,
    };
  }

  private open(r: SpaceRecord): SpaceContext {
    const dbPath = path.join(this.userDataDir, r.dbFile);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const info: SpaceInfo = { id: r.id, name: r.name };
    return this.factory(info, { dbPath, credentialNamespace: r.credentialNamespace });
  }

  /** The active space, opened on first use. */
  active(): SpaceContext {
    if (!this.current) this.current = this.open(this.record(this.state().activeId));
    return this.current;
  }

  list(): SpaceSummary[] {
    return this.state().spaces.map((s) => this.toSummary(s));
  }

  /** Like `list`, plus which services are connected in each space. */
  async listWithConnections(): Promise<SpaceSummary[]> {
    return Promise.all(
      this.state().spaces.map(async (r) => ({
        ...this.toSummary(r),
        connections: await this.probeConnections(r.credentialNamespace),
      }))
    );
  }

  getActive(): SpaceSummary {
    return this.toSummary(this.record(this.state().activeId));
  }

  /**
   * Marks long-running work (sync, import, OAuth...) that must not be cut off
   * by a space switch. Returns a release function; call it in a `finally`.
   */
  beginBusy(label: string): () => void {
    const token = Symbol(label);
    this.busy.set(token, label);
    return () => {
      this.busy.delete(token);
    };
  }

  private assertIdle(action: string): void {
    const [label] = this.busy.values();
    if (label) throw new Error(`Cannot ${action} while ${label} is in progress.`);
  }

  private validateName(name: string, exceptId?: string): string {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('A space needs a name.');
    if (trimmed.length > MAX_NAME_LENGTH) {
      throw new Error(`Space names are limited to ${MAX_NAME_LENGTH} characters.`);
    }
    const clash = this.state().spaces.some(
      (s) => s.id !== exceptId && s.name.toLowerCase() === trimmed.toLowerCase()
    );
    if (clash) throw new Error(`A space named "${trimmed}" already exists.`);
    return trimmed;
  }

  private persist(): void {
    this.registry.save(this.state());
  }

  create(name: string, color?: string): SpaceSummary {
    const clean = this.validateName(name);
    const id = newSpaceId();
    const record: SpaceRecord = {
      id,
      name: clean,
      color: color ?? SPACE_COLORS[this.state().spaces.length % SPACE_COLORS.length],
      dbFile: spaceDbFile(id),
      credentialNamespace: id,
      createdAt: new Date().toISOString(),
    };
    this.state().spaces.push(record);
    this.persist();
    return this.toSummary(record);
  }

  rename(id: string, name: string, color?: string): SpaceSummary {
    const record = this.record(id);
    record.name = this.validateName(name, id);
    if (color) record.color = color;
    this.persist();
    return this.toSummary(record);
  }

  private dbPathOf(r: SpaceRecord): string {
    return path.join(this.userDataDir, r.dbFile);
  }

  /**
   * Creates a new space holding a copy of another space's data (repositories,
   * commit history, settings). Saved connections are deliberately not copied:
   * the copy starts disconnected and credentials stay in their own space.
   */
  async duplicate(id: string, name: string, color?: string): Promise<SpaceSummary> {
    const source = this.record(id);
    const clean = this.validateName(name);
    const newId = newSpaceId();
    const dest: SpaceRecord = {
      id: newId,
      name: clean,
      color: color ?? source.color,
      dbFile: spaceDbFile(newId),
      credentialNamespace: newId,
      createdAt: new Date().toISOString(),
    };
    const destPath = this.dbPathOf(dest);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    try {
      // A space that was never opened has no database yet; the copy is empty too.
      if (fs.existsSync(this.dbPathOf(source))) {
        await this.copyDatabase(this.dbPathOf(source), destPath);
      }
    } catch (err) {
      fs.rmSync(path.dirname(destPath), { recursive: true, force: true });
      throw err;
    }
    this.state().spaces.push(dest);
    this.persist();
    return this.toSummary(dest);
  }

  /** Saves a copy of a space's database to `dest` (no credentials are included). */
  async exportTo(id: string, dest: string): Promise<void> {
    const source = this.dbPathOf(this.record(id));
    if (!fs.existsSync(source)) throw new Error('This space has no data to export yet.');
    await this.copyDatabase(source, dest);
  }

  /**
   * Makes `id` the active space. The current space is closed; the caller is
   * expected to reload the renderer so no stale state survives the switch.
   */
  switchTo(id: string): SpaceSummary {
    const target = this.record(id);
    if (id === this.state().activeId) return this.toSummary(target);
    this.assertIdle('switch spaces');
    this.current?.close();
    this.current = null;
    this.state().activeId = id;
    this.persist();
    return this.toSummary(target);
  }

  /**
   * Deletes a space: its database files and keychain entries. Repositories on
   * disk are never touched. The active space cannot be deleted.
   */
  async delete(id: string): Promise<void> {
    const record = this.record(id);
    if (id === this.state().activeId) throw new Error('Switch to another space before deleting this one.');
    this.assertIdle('delete a space');

    // Credentials first: if this fails the space still exists and can be retried.
    await this.cleanCredentials(record.credentialNamespace);

    const dbPath = path.join(this.userDataDir, record.dbFile);
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
    // Remove the per-space folder, but never the userData directory itself.
    const dir = path.dirname(dbPath);
    if (path.resolve(dir) !== path.resolve(this.userDataDir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    this.state().spaces = this.state().spaces.filter((s) => s.id !== id);
    this.persist();
  }

  close(): void {
    this.current?.close();
    this.current = null;
  }
}
