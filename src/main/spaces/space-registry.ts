import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * One entry in the registry. Contains no secrets: credentials live in the OS
 * keychain, keyed by `credentialNamespace`.
 */
export interface SpaceRecord {
  id: string;
  name: string;
  color: string;
  /** Database path relative to the userData directory. */
  dbFile: string;
  /**
   * Keychain namespace. Undefined only for the legacy default space, which
   * keeps using the original un-prefixed keychain entries.
   */
  credentialNamespace?: string;
  createdAt: string;
}

export interface RegistryData {
  version: 1;
  activeId: string;
  spaces: SpaceRecord[];
}

export const REGISTRY_FILE = 'spaces.json';
export const LEGACY_DB_FILE = 'git-analytics.db';
export const DEFAULT_SPACE_ID = 'default';
export const SPACE_COLORS = ['#3b82f6', '#16a34a', '#d97706', '#dc2626', '#9333ea', '#0891b2'];

export function newSpaceId(): string {
  return `sp_${randomBytes(4).toString('hex')}`;
}

export function spaceDbFile(id: string): string {
  return path.join('spaces', id, LEGACY_DB_FILE);
}

function legacyDefaultSpace(): SpaceRecord {
  return {
    id: DEFAULT_SPACE_ID,
    name: 'Default',
    color: SPACE_COLORS[0],
    dbFile: LEGACY_DB_FILE,
    createdAt: new Date().toISOString(),
  };
}

function isSpaceRecord(value: unknown): value is SpaceRecord {
  const v = value as Partial<SpaceRecord> | null;
  return (
    !!v &&
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.color === 'string' &&
    typeof v.dbFile === 'string' &&
    typeof v.createdAt === 'string' &&
    (v.credentialNamespace === undefined || typeof v.credentialNamespace === 'string')
  );
}

function isValid(data: unknown): data is RegistryData {
  const d = data as Partial<RegistryData> | null;
  return (
    !!d &&
    d.version === 1 &&
    typeof d.activeId === 'string' &&
    Array.isArray(d.spaces) &&
    d.spaces.length > 0 &&
    d.spaces.every(isSpaceRecord) &&
    d.spaces.some((s) => s.id === d.activeId)
  );
}

/**
 * Persistent list of spaces under the userData directory. Writes are atomic
 * (temp file + rename) so a crash cannot leave a half-written registry.
 */
export class SpaceRegistry {
  private readonly file: string;

  constructor(private readonly baseDir: string) {
    this.file = path.join(baseDir, REGISTRY_FILE);
  }

  /**
   * Reads the registry. A missing file means a fresh or pre-spaces install and
   * yields the legacy default space; a corrupt file is set aside and rebuilt
   * from what is on disk, so existing data is never orphaned.
   */
  load(): RegistryData {
    if (fs.existsSync(this.file)) {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
        if (isValid(parsed)) return parsed;
      } catch {
        // Fall through to recovery below.
      }
      fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
    }
    const data = this.rebuild();
    this.save(data);
    return data;
  }

  save(data: RegistryData): void {
    fs.mkdirSync(this.baseDir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, this.file);
  }

  /** Default space plus any space databases found under `spaces/<id>/`. */
  private rebuild(): RegistryData {
    const spaces: SpaceRecord[] = [legacyDefaultSpace()];
    const spacesDir = path.join(this.baseDir, 'spaces');
    if (fs.existsSync(spacesDir)) {
      for (const entry of fs.readdirSync(spacesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dbFile = spaceDbFile(entry.name);
        if (!fs.existsSync(path.join(this.baseDir, dbFile))) continue;
        spaces.push({
          id: entry.name,
          name: `Recovered ${entry.name}`,
          color: SPACE_COLORS[spaces.length % SPACE_COLORS.length],
          dbFile,
          credentialNamespace: entry.name,
          createdAt: new Date().toISOString(),
        });
      }
    }
    return { version: 1, activeId: DEFAULT_SPACE_ID, spaces };
  }
}
