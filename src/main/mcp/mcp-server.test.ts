import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { DatabaseService } from '../services/database';
import { McpHttpServer } from './mcp-server';
import { McpSettingsStore } from './mcp-settings';

const TOKEN = 'a'.repeat(64);

describe('McpHttpServer', () => {
  let tempDir: string;
  let db: DatabaseService;
  let server: McpHttpServer;
  let base: string;
  let spaceName: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
    db = new DatabaseService(path.join(tempDir, 'test.db'));
    spaceName = 'Work';
    db.saveRepository({
      id: 'r1', name: 'alpha', owner: 'me', provider: 'github', defaultBranch: 'main', url: 'u1',
    });
    db.saveRepository({
      id: 'r2', name: 'beta', owner: 'me', provider: 'github', defaultBranch: 'main', url: 'u2',
    });
    db.saveCommits('r1', [
      { hash: 'h1', authorName: 'Ann', authorEmail: 'ann@x.com', date: new Date('2025-01-10T10:00:00Z'), message: 'one' },
      { hash: 'h2', authorName: 'Bob', authorEmail: 'bob@x.com', date: new Date('2025-01-20T10:00:00Z'), message: 'two' },
      { hash: 'h3', authorName: 'Ann', authorEmail: 'ann@x.com', date: new Date('2025-02-05T10:00:00Z'), message: 'three' },
    ]);
    db.saveCommits('r2', [
      { hash: 'h4', authorName: 'Ann', authorEmail: 'ann@x.com', date: new Date('2025-02-06T10:00:00Z'), message: 'four' },
    ]);
    db.savePreferences({ selectedRepositoryIds: ['r1'], dateRangePreset: 'last30days' });
    server = new McpHttpServer({
      port: 0,
      token: TOKEN,
      context: () => ({ db, space: { id: 's1', name: spaceName }, now: () => new Date('2025-02-10T12:00:00Z') }),
    });
    await server.start();
    base = `http://127.0.0.1:${server.port}/mcp`;
  });

  afterEach(async () => {
    await server.stop();
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...headers },
      body: JSON.stringify(body),
    });

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const json = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    const text = json.result.content[0].text;
    return { isError: json.result.isError === true, text, value: json.result.isError ? null : JSON.parse(text) };
  };

  describe('transport and auth', () => {
    it('rejects requests without a valid bearer token', async () => {
      const none = await fetch(base, { method: 'POST', body: '{}' });
      const bad = await post({}, { Authorization: 'Bearer nope' });
      expect(none.status).toBe(401);
      expect(bad.status).toBe(401);
    });

    it('rejects non-local Host and Origin headers', async () => {
      const origin = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'https://evil.example' });
      expect(origin.status).toBe(403);
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port: server.port, path: '/mcp', method: 'POST', headers: { Host: 'evil.example', Authorization: `Bearer ${TOKEN}` } },
          (res) => resolve(res.statusCode ?? 0)
        );
        req.on('error', reject);
        req.end('{}');
      });
      expect(status).toBe(403);
    });

    it('only serves POST /mcp', async () => {
      const get = await fetch(base, { headers: { Authorization: `Bearer ${TOKEN}` } });
      expect(get.status).toBe(405);
      const other = await fetch(`http://127.0.0.1:${server.port}/other`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(other.status).toBe(404);
    });

    it('answers malformed JSON with a parse error', async () => {
      const res = await fetch(base, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: '{nope' });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32700);
    });

    it('negotiates the protocol version and returns 202 for notifications', async () => {
      const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
      const body = (await init.json()) as { result: { protocolVersion: string; capabilities: object } };
      expect(body.result.protocolVersion).toBe('2025-03-26');
      expect(body.result.capabilities).toHaveProperty('tools');

      const note = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
      expect(note.status).toBe(202);
    });

    it('returns method-not-found for unknown methods', async () => {
      const res = await post({ jsonrpc: '2.0', id: 7, method: 'nope' });
      const body = (await res.json()) as { id: number; error: { code: number } };
      expect(body.id).toBe(7);
      expect(body.error.code).toBe(-32601);
    });

    it('lists tools and the schema resource', async () => {
      const tools = (await (await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()) as {
        result: { tools: { name: string }[] };
      };
      expect(tools.result.tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(['get_selection', 'get_commits', 'query'])
      );
      const res = (await (
        await post({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'gitbrowser://schema' } })
      ).json()) as { result: { contents: { text: string }[] } };
      expect(res.result.contents[0].text).toContain('commits(');
    });
  });

  describe('tools', () => {
    it('reports the active space, following switches', async () => {
      expect((await call('get_active_space')).value).toEqual({ id: 's1', name: 'Work' });
      spaceName = 'Personal';
      expect((await call('get_active_space')).value.name).toBe('Personal');
    });

    it('lists repositories with commit counts', async () => {
      const { value } = await call('list_repositories');
      expect(value).toHaveLength(2);
      expect(value.find((r: { id: string }) => r.id === 'r1').commitCount).toBe(3);
    });

    it('returns the selection with a resolved date range', async () => {
      const { value } = await call('get_selection');
      expect(value.repositories).toEqual([{ id: 'r1', name: 'alpha' }]);
      expect(value.dateRange.preset).toBe('last30days');
      expect(new Date(value.dateRange.end).getTime()).toBeGreaterThan(new Date(value.dateRange.start).getTime());
    });

    it('filters commits by repository, date, author and selection', async () => {
      expect((await call('get_commits')).value.totalMatching).toBe(4);
      expect((await call('get_commits', { repository_ids: ['r2'] })).value.totalMatching).toBe(1);
      expect((await call('get_commits', { selected_only: true })).value.totalMatching).toBe(3);
      expect((await call('get_commits', { since: '2025-01-15', until: '2025-02-05' })).value.totalMatching).toBe(2);
      expect((await call('get_commits', { author_email: 'bob@x.com' })).value.commits[0].hash).toBe('h2');
    });

    it('honours limit, newest first, and reports the total', async () => {
      const { value } = await call('get_commits', { limit: 2 });
      expect(value.returned).toBe(2);
      expect(value.totalMatching).toBe(4);
      expect(value.commits.map((c: { hash: string }) => c.hash)).toEqual(['h4', 'h3']);
    });

    it('matches nothing when selected_only is used with an empty selection', async () => {
      db.savePreferences({ selectedRepositoryIds: [] });
      expect((await call('get_commits', { selected_only: true })).value.totalMatching).toBe(0);
    });

    it('computes author stats and activity buckets', async () => {
      const stats = (await call('get_author_stats')).value;
      expect(stats[0]).toMatchObject({ authorEmail: 'ann@x.com', commits: 3, repositories: 2 });
      const monthly = (await call('get_commit_activity', { granularity: 'month' })).value;
      expect(monthly).toEqual([
        { period: '2025-01', commits: 2, authors: 2 },
        { period: '2025-02', commits: 2, authors: 1 },
      ]);
    });

    it('reports bad arguments as tool errors', async () => {
      expect((await call('get_commits', { limit: 'x' })).isError).toBe(true);
      expect((await call('get_commits', { since: 'garbage' })).isError).toBe(true);
      expect((await call('get_commit_activity', { granularity: 'year' })).isError).toBe(true);
    });
  });

  describe('query tool', () => {
    it('runs read-only selects and caps rows', async () => {
      const ok = await call('query', { sql: 'SELECT COUNT(*) AS n FROM commits;' });
      expect(ok.value.rows).toEqual([{ n: 4 }]);
      const capped = await call('query', { sql: 'SELECT hash FROM commits', max_rows: 2 });
      expect(capped.value).toMatchObject({ rowCount: 2, truncated: true });
    });

    it.each([
      ['DELETE FROM commits'],
      ['SELECT 1; DELETE FROM commits'],
      ['WITH x AS (SELECT 1) DELETE FROM commits'],
      ['SELECT * FROM providers'],
      ['SELECT * FROM space_settings'],
      ['SELECT * FROM snyk_cache'],
      ['SELECT * FROM sqlite_master'],
      ['SELECT * FROM pragma_table_info("commits")'],
    ])('refuses %s', async (sql) => {
      expect((await call('query', { sql })).isError).toBe(true);
      expect(db.getCommitCount('r1')).toBe(3);
    });
  });
});

describe('McpSettingsStore', () => {
  it('defaults to disabled on the default port and round-trips changes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-settings-'));
    try {
      const store = new McpSettingsStore(dir);
      expect(store.load()).toEqual({ enabled: false, port: 39217 });
      store.save({ enabled: true, port: 40000 });
      expect(new McpSettingsStore(dir).load()).toEqual({ enabled: true, port: 40000 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
