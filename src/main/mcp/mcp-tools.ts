import type { DatabaseService } from '../services/database';
import type { DateRangePreset } from '../../shared/types';

/** What the tools need from the app. Resolved per request so space switches are honoured. */
export interface McpContext {
  db: Pick<
    DatabaseService,
    'getImportedRepositories' | 'getPreferences' | 'getRepoActivity' | 'queryReadOnly'
  >;
  space: { id: string; name: string };
  now?: () => Date;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(args: Record<string, unknown>, ctx: McpContext): unknown;
}

/** Thrown for bad arguments; surfaced to the model as a tool error, not a protocol error. */
export class ToolInputError extends Error {}

export const SCHEMA_RESOURCE_URI = 'gitbrowser://schema';

export const SCHEMA_DOC = `Git Analyzer database (SQLite). Dates are ISO-8601 UTC strings, so they sort and compare as text.

repositories(id TEXT PK, name, owner, provider /* github|bitbucket|local */, default_branch, url,
             imported_at, last_sync_at, local_path, is_available /* 0|1 */, parent_folder)

commits(id INTEGER PK, repository_id -> repositories.id, hash, author_name, author_email,
        commit_date, message, branch)   -- UNIQUE(repository_id, hash)

Only these two tables are reachable through the query tool. Credentials, provider connections
and cached third-party results are intentionally not exposed.`;

const PRESET_DAYS: Record<Exclude<DateRangePreset, 'custom'>, number> = {
  last7days: 7,
  last30days: 30,
  last90days: 90,
  lastYear: 365,
};

const DEFAULT_COMMIT_LIMIT = 100;
const MAX_COMMIT_LIMIT = 500;
const MAX_MESSAGE_CHARS = 1000;

// Tables and SQLite internals the free-form query tool must not touch.
const BLOCKED_SQL = /providers|space_settings|snyk_cache|sqlite_|pragma|load_extension|attach/i;

// ---- argument helpers -------------------------------------------------------

function optString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new ToolInputError(`"${key}" must be a string`);
  return v;
}

function optBool(args: Record<string, unknown>, key: string): boolean {
  const v = args[key];
  if (v === undefined || v === null) return false;
  if (typeof v !== 'boolean') throw new ToolInputError(`"${key}" must be a boolean`);
  return v;
}

function optInt(args: Record<string, unknown>, key: string, def: number, max: number): number {
  const v = args[key];
  if (v === undefined || v === null) return def;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new ToolInputError(`"${key}" must be a positive integer`);
  }
  return Math.min(v, max);
}

function optStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new ToolInputError(`"${key}" must be an array of strings`);
  }
  return v as string[];
}

function parseDate(value: string | undefined, key: string, endOfDay: boolean): string | undefined {
  if (!value) return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const text = dateOnly ? `${value}${endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z'}` : value;
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) throw new ToolInputError(`"${key}" is not a valid ISO date`);
  return new Date(ms).toISOString();
}

// ---- selection --------------------------------------------------------------

interface ResolvedSelection {
  repositoryIds: string[];
  dateRange: { preset: string | null; start: string; end: string } | null;
}

function resolveSelection(ctx: McpContext): ResolvedSelection {
  const prefs = ctx.db.getPreferences();
  const now = (ctx.now ?? (() => new Date()))();
  let dateRange: ResolvedSelection['dateRange'] = null;
  if (prefs.dateRangePreset && prefs.dateRangePreset !== 'custom') {
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    const start = new Date(now);
    start.setDate(start.getDate() - (PRESET_DAYS[prefs.dateRangePreset] ?? 30));
    start.setHours(0, 0, 0, 0);
    dateRange = { preset: prefs.dateRangePreset, start: start.toISOString(), end: end.toISOString() };
  } else if (prefs.customDateRange) {
    dateRange = {
      preset: 'custom',
      start: new Date(prefs.customDateRange.start).toISOString(),
      end: new Date(prefs.customDateRange.end).toISOString(),
    };
  }
  return { repositoryIds: prefs.selectedRepositoryIds, dateRange };
}

// ---- shared commit filter ---------------------------------------------------

const FILTER_PROPERTIES = {
  repository_ids: {
    type: 'array',
    items: { type: 'string' },
    description: 'Limit to these repository ids (see list_repositories). Omit for all repositories.',
  },
  selected_only: {
    type: 'boolean',
    description: 'Limit to the repositories currently selected in the app (see get_selection).',
  },
  since: { type: 'string', description: 'Inclusive start, ISO date or datetime (e.g. 2025-01-31).' },
  until: { type: 'string', description: 'Inclusive end, ISO date or datetime.' },
  author_email: { type: 'string', description: 'Only commits by this exact author email.' },
};

function buildFilter(args: Record<string, unknown>, ctx: McpContext): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  let ids = optStringArray(args, 'repository_ids');
  if (optBool(args, 'selected_only')) {
    const selected = resolveSelection(ctx).repositoryIds;
    ids = ids ? ids.filter((id) => selected.includes(id)) : selected;
    // An empty selection must match nothing rather than everything.
    if (ids.length === 0) return { where: '0', params: [] };
  }
  if (ids) {
    if (ids.length === 0) return { where: '0', params: [] };
    clauses.push(`c.repository_id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }
  const since = parseDate(optString(args, 'since'), 'since', false);
  if (since) {
    clauses.push('c.commit_date >= ?');
    params.push(since);
  }
  const until = parseDate(optString(args, 'until'), 'until', true);
  if (until) {
    clauses.push('c.commit_date <= ?');
    params.push(until);
  }
  const email = optString(args, 'author_email');
  if (email) {
    clauses.push('c.author_email = ?');
    params.push(email);
  }
  return { where: clauses.length ? clauses.join(' AND ') : '1', params };
}

// ---- tools ------------------------------------------------------------------

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'get_active_space',
    description:
      'Returns the Git Analyzer space (isolated workspace with its own database) that all other tools read from.',
    inputSchema: { type: 'object', properties: {} },
    handler: (_args, ctx) => ({ id: ctx.space.id, name: ctx.space.name }),
  },
  {
    name: 'list_repositories',
    description:
      'Lists every imported repository with its id, provider, default branch, commit count and last sync time.',
    inputSchema: { type: 'object', properties: {} },
    handler: (_args, ctx) =>
      ctx.db.getImportedRepositories().map((r) => ({
        id: r.id,
        name: r.name,
        owner: r.owner,
        provider: r.provider,
        defaultBranch: r.defaultBranch,
        url: r.url,
        parentFolder: r.parentFolder ?? null,
        commitCount: r.commitCount,
        lastSyncAt: new Date(r.lastSyncAt).toISOString(),
        isAvailable: r.isAvailable ?? true,
      })),
  },
  {
    name: 'get_selection',
    description:
      'Returns what the user currently has selected in the app: the chosen repositories and the active date range. Use this to summarize "what I am looking at".',
    inputSchema: { type: 'object', properties: {} },
    handler: (_args, ctx) => {
      const selection = resolveSelection(ctx);
      const byId = new Map(ctx.db.getImportedRepositories().map((r) => [r.id, r]));
      return {
        space: ctx.space.name,
        repositories: selection.repositoryIds.map((id) => ({
          id,
          name: byId.get(id)?.name ?? null,
        })),
        dateRange: selection.dateRange,
      };
    },
  },
  {
    name: 'get_repository_activity',
    description:
      'All-time activity per repository: total commits, first and last commit dates, and distinct author counts.',
    inputSchema: {
      type: 'object',
      properties: {
        repository_ids: FILTER_PROPERTIES.repository_ids,
        selected_only: FILTER_PROPERTIES.selected_only,
      },
    },
    handler: (args, ctx) => {
      let ids = optStringArray(args, 'repository_ids') ?? ctx.db.getImportedRepositories().map((r) => r.id);
      if (optBool(args, 'selected_only')) {
        const selected = resolveSelection(ctx).repositoryIds;
        ids = ids.filter((id) => selected.includes(id));
      }
      const names = new Map(ctx.db.getImportedRepositories().map((r) => [r.id, r.name]));
      return ctx.db
        .getRepoActivity(ids)
        .map((a) => ({ ...a, repositoryName: names.get(a.repositoryId) ?? null }));
    },
  },
  {
    name: 'get_commits',
    description: `Returns commits, newest first. Defaults to ${DEFAULT_COMMIT_LIMIT} rows (max ${MAX_COMMIT_LIMIT}); the response reports the total match count so you can tell if it was truncated.`,
    inputSchema: {
      type: 'object',
      properties: {
        ...FILTER_PROPERTIES,
        limit: { type: 'integer', minimum: 1, maximum: MAX_COMMIT_LIMIT },
      },
    },
    handler: (args, ctx) => {
      const limit = optInt(args, 'limit', DEFAULT_COMMIT_LIMIT, MAX_COMMIT_LIMIT);
      const { where, params } = buildFilter(args, ctx);
      const { rows } = ctx.db.queryReadOnly(
        `SELECT c.hash, c.repository_id AS repositoryId, r.name AS repositoryName,
                c.author_name AS authorName, c.author_email AS authorEmail,
                c.commit_date AS date, c.branch, c.message
           FROM commits c JOIN repositories r ON r.id = c.repository_id
          WHERE ${where}
          ORDER BY c.commit_date DESC
          LIMIT ?`,
        [...params, limit],
        limit
      );
      const total = ctx.db.queryReadOnly(
        `SELECT COUNT(*) AS n FROM commits c WHERE ${where}`,
        params,
        1
      ).rows[0]?.n as number;
      return {
        totalMatching: total,
        returned: rows.length,
        commits: rows.map((row) => ({
          ...row,
          message: String(row.message).slice(0, MAX_MESSAGE_CHARS),
        })),
      };
    },
  },
  {
    name: 'get_author_stats',
    description:
      'Commit counts per author (grouped by email) with first/last commit dates and number of repositories touched, most active first.',
    inputSchema: {
      type: 'object',
      properties: { ...FILTER_PROPERTIES, limit: { type: 'integer', minimum: 1, maximum: 200 } },
    },
    handler: (args, ctx) => {
      const limit = optInt(args, 'limit', 20, 200);
      const { where, params } = buildFilter(args, ctx);
      return ctx.db.queryReadOnly(
        `SELECT c.author_email AS authorEmail, MAX(c.author_name) AS authorName,
                COUNT(*) AS commits, COUNT(DISTINCT c.repository_id) AS repositories,
                MIN(c.commit_date) AS firstCommit, MAX(c.commit_date) AS lastCommit
           FROM commits c
          WHERE ${where}
          GROUP BY c.author_email
          ORDER BY commits DESC
          LIMIT ?`,
        [...params, limit],
        limit
      ).rows;
    },
  },
  {
    name: 'get_commit_activity',
    description: 'Commit counts bucketed over time (day, week or month), oldest first, for trend summaries.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILTER_PROPERTIES,
        granularity: { type: 'string', enum: ['day', 'week', 'month'], default: 'week' },
      },
    },
    handler: (args, ctx) => {
      const granularity = optString(args, 'granularity') ?? 'week';
      const formats: Record<string, string> = { day: '%Y-%m-%d', week: '%Y-W%W', month: '%Y-%m' };
      const format = formats[granularity];
      if (!format) throw new ToolInputError('"granularity" must be day, week or month');
      const { where, params } = buildFilter(args, ctx);
      return ctx.db.queryReadOnly(
        `SELECT strftime('${format}', c.commit_date) AS period, COUNT(*) AS commits,
                COUNT(DISTINCT c.author_email) AS authors
           FROM commits c
          WHERE ${where}
          GROUP BY period
          ORDER BY period`,
        params,
        5000
      ).rows;
    },
  },
  {
    name: 'query',
    description: `Runs a single read-only SELECT (or WITH ... SELECT) against the repositories and commits tables. Use it for questions the other tools cannot answer. Read the ${SCHEMA_RESOURCE_URI} resource for the schema. Results are capped at 1000 rows.`,
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string' },
        max_rows: { type: 'integer', minimum: 1, maximum: 1000, default: 200 },
      },
      required: ['sql'],
    },
    handler: (args, ctx) => {
      const raw = optString(args, 'sql');
      if (!raw) throw new ToolInputError('"sql" is required');
      const sql = raw.trim().replace(/;+\s*$/, '');
      if (!/^(select|with)\b/i.test(sql)) {
        throw new ToolInputError('Only SELECT statements are allowed');
      }
      if (BLOCKED_SQL.test(sql)) {
        throw new ToolInputError(
          'Query references a table or feature that is not exposed. Only repositories and commits are available.'
        );
      }
      const maxRows = optInt(args, 'max_rows', 200, 1000);
      try {
        const { rows, truncated } = ctx.db.queryReadOnly(sql, [], maxRows);
        return { rowCount: rows.length, truncated, rows };
      } catch (error) {
        throw new ToolInputError(error instanceof Error ? error.message : String(error));
      }
    },
  },
];
