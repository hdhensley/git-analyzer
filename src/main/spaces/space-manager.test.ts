import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SpaceManager, type SpaceContextFactory } from './space-manager';

describe('SpaceManager', () => {
  let dir: string;
  let opened: Array<{ id: string; dbPath?: string; ns?: string; closed: boolean }>;
  let factory: SpaceContextFactory;
  let cleaned: Array<string | undefined>;
  let manager: SpaceManager;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spaces-'));
    opened = [];
    cleaned = [];
    factory = ((info, options) => {
      const entry = { id: info.id, dbPath: options?.dbPath, ns: options?.credentialNamespace, closed: false };
      opened.push(entry);
      return { ...info, close: () => { entry.closed = true; } } as unknown as ReturnType<SpaceContextFactory>;
    }) as SpaceContextFactory;
    manager = new SpaceManager(dir, {
      factory,
      cleanCredentials: async (ns) => {
        cleaned.push(ns);
      },
      probeConnections: async (ns) => ({ github: ns === 'sp_x', bitbucket: false, snyk: ns === undefined }),
      copyDatabase: async (src, dest) => {
        fs.copyFileSync(src, dest);
      },
    });
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('opens the default space on the original database path with no credential namespace', () => {
    manager.active();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ id: 'default', dbPath: path.join(dir, 'git-analytics.db'), ns: undefined });
  });

  it('reuses the open context until a switch', () => {
    expect(manager.active()).toBe(manager.active());
    expect(opened).toHaveLength(1);
  });

  it('creates spaces with their own database folder and credential namespace', () => {
    const work = manager.create('Work');
    manager.switchTo(work.id);
    manager.active();
    const last = opened[opened.length - 1];
    expect(last.dbPath).toBe(path.join(dir, 'spaces', work.id, 'git-analytics.db'));
    expect(last.ns).toBe(work.id);
    expect(fs.existsSync(path.dirname(last.dbPath!))).toBe(true);
  });

  it('closes the old space on switch and persists the active space', () => {
    manager.active();
    const personal = manager.create('Personal');
    manager.switchTo(personal.id);
    expect(opened[0].closed).toBe(true);
    expect(new SpaceManager(dir, { factory }).getActive().id).toBe(personal.id);
  });

  it('refuses to switch or delete while work is in progress', () => {
    const personal = manager.create('Personal');
    const release = manager.beginBusy('a sync');
    expect(() => manager.switchTo(personal.id)).toThrow(/while a sync is in progress/);
    release();
    expect(() => manager.switchTo(personal.id)).not.toThrow();
  });

  it('validates names (blank, too long, duplicate)', () => {
    expect(() => manager.create('  ')).toThrow(/needs a name/);
    expect(() => manager.create('x'.repeat(41))).toThrow(/limited/);
    manager.create('Work');
    expect(() => manager.create('work')).toThrow(/already exists/);
  });

  it('renames a space', () => {
    const s = manager.create('Work');
    expect(manager.rename(s.id, 'Job', '#000').name).toBe('Job');
    expect(manager.list().find((x) => x.id === s.id)?.color).toBe('#000');
  });

  it('cannot delete the active space', async () => {
    await expect(manager.delete('default')).rejects.toThrow(/Switch to another space/);
  });

  it('deletes a space: database files, folder, credentials and registry entry', async () => {
    const s = manager.create('Scratch');
    const folder = path.join(dir, 'spaces', s.id);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'git-analytics.db'), 'x');
    fs.writeFileSync(path.join(folder, 'git-analytics.db-wal'), 'x');

    await manager.delete(s.id);
    expect(fs.existsSync(folder)).toBe(false);
    expect(cleaned).toEqual([s.id]);
    expect(manager.list().some((x) => x.id === s.id)).toBe(false);
  });

  it('deleting the legacy default space removes its files but never the userData folder', async () => {
    const other = manager.create('Other');
    manager.switchTo(other.id);
    fs.writeFileSync(path.join(dir, 'git-analytics.db'), 'x');
    fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'keep');

    await manager.delete('default');
    expect(fs.existsSync(path.join(dir, 'git-analytics.db'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'unrelated.txt'))).toBe(true);
    expect(cleaned).toEqual([undefined]);
  });

  it('throws for an unknown space id', () => {
    expect(() => manager.switchTo('nope')).toThrow(/Unknown space/);
  });

  it('reports which services are connected per space', async () => {
    const list = await manager.listWithConnections();
    // The default (legacy, un-namespaced) space is probed with an undefined namespace.
    expect(list.find((x) => x.id === 'default')?.connections).toEqual({ github: false, bitbucket: false, snyk: true });
  });

  it('duplicates a space by copying its database, without credentials', async () => {
    fs.writeFileSync(path.join(dir, 'git-analytics.db'), 'data');
    const copy = await manager.duplicate('default', 'Default copy');
    const copied = path.join(dir, 'spaces', copy.id, 'git-analytics.db');
    expect(fs.readFileSync(copied, 'utf-8')).toBe('data');
    expect(copy.active).toBe(false);
    // The copy gets its own credential namespace, so nothing is shared or copied.
    manager.switchTo(copy.id);
    manager.active();
    expect(opened[opened.length - 1].ns).toBe(copy.id);
    expect(cleaned).toEqual([]);
  });

  it('duplicating a space that was never opened yields an empty space', async () => {
    const copy = await manager.duplicate('default', 'Fresh');
    expect(fs.existsSync(path.join(dir, 'spaces', copy.id, 'git-analytics.db'))).toBe(false);
    expect(manager.list().some((x) => x.id === copy.id)).toBe(true);
  });

  it('rolls back a failed duplicate', async () => {
    fs.writeFileSync(path.join(dir, 'git-analytics.db'), 'data');
    const failing = new SpaceManager(dir, {
      factory,
      copyDatabase: async () => {
        throw new Error('disk full');
      },
    });
    await expect(failing.duplicate('default', 'Broken')).rejects.toThrow('disk full');
    expect(failing.list()).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, 'spaces'))).toBe(true);
    expect(fs.readdirSync(path.join(dir, 'spaces'))).toEqual([]);
  });

  it('exports a copy of the database and refuses when there is nothing to export', async () => {
    await expect(manager.exportTo('default', path.join(dir, 'out.db'))).rejects.toThrow(/no data/);
    fs.writeFileSync(path.join(dir, 'git-analytics.db'), 'data');
    await manager.exportTo('default', path.join(dir, 'out.db'));
    expect(fs.readFileSync(path.join(dir, 'out.db'), 'utf-8')).toBe('data');
  });
});
