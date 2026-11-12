import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SpaceRegistry, REGISTRY_FILE, DEFAULT_SPACE_ID, LEGACY_DB_FILE } from './space-registry';

describe('SpaceRegistry', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates the legacy default space when no registry exists', () => {
    const data = new SpaceRegistry(dir).load();
    expect(data.activeId).toBe(DEFAULT_SPACE_ID);
    expect(data.spaces).toHaveLength(1);
    expect(data.spaces[0]).toMatchObject({
      id: DEFAULT_SPACE_ID,
      dbFile: LEGACY_DB_FILE,
    });
    // Legacy space keeps the original un-prefixed keychain entries.
    expect(data.spaces[0].credentialNamespace).toBeUndefined();
    expect(fs.existsSync(path.join(dir, REGISTRY_FILE))).toBe(true);
  });

  it('never moves or touches the legacy database file', () => {
    const db = path.join(dir, LEGACY_DB_FILE);
    fs.writeFileSync(db, 'sqlite-bytes');
    new SpaceRegistry(dir).load();
    expect(fs.readFileSync(db, 'utf-8')).toBe('sqlite-bytes');
  });

  it('round-trips saved data', () => {
    const registry = new SpaceRegistry(dir);
    const data = registry.load();
    data.spaces.push({
      id: 'sp_1', name: 'Work', color: '#fff', dbFile: 'spaces/sp_1/git-analytics.db',
      credentialNamespace: 'sp_1', createdAt: new Date().toISOString(),
    });
    data.activeId = 'sp_1';
    registry.save(data);
    expect(new SpaceRegistry(dir).load()).toEqual(data);
    expect(fs.existsSync(path.join(dir, `${REGISTRY_FILE}.tmp`))).toBe(false);
  });

  it('sets a corrupt registry aside and rebuilds, recovering space databases on disk', () => {
    fs.writeFileSync(path.join(dir, REGISTRY_FILE), '{ not json');
    fs.mkdirSync(path.join(dir, 'spaces', 'sp_abc'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'spaces', 'sp_abc', LEGACY_DB_FILE), 'x');

    const data = new SpaceRegistry(dir).load();
    expect(data.spaces.map((s) => s.id)).toEqual([DEFAULT_SPACE_ID, 'sp_abc']);
    expect(data.spaces[1].credentialNamespace).toBe('sp_abc');
    expect(fs.readdirSync(dir).some((f) => f.startsWith(`${REGISTRY_FILE}.corrupt-`))).toBe(true);
  });

  it('treats a registry whose active space is missing as corrupt', () => {
    fs.writeFileSync(
      path.join(dir, REGISTRY_FILE),
      JSON.stringify({ version: 1, activeId: 'ghost', spaces: [] })
    );
    expect(new SpaceRegistry(dir).load().activeId).toBe(DEFAULT_SPACE_ID);
  });
});
