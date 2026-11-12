import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export const DEFAULT_MCP_PORT = 39217;

/** App-wide (not per-space) settings for the built-in MCP server. The token lives in the keychain. */
export interface McpSettings {
  enabled: boolean;
  port: number;
}

export function newToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** Persists MCP settings as JSON in the app's userData directory. */
export class McpSettingsStore {
  private readonly file: string;

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, 'mcp-settings.json');
  }

  load(): McpSettings {
    let stored: Partial<McpSettings> = {};
    try {
      stored = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<McpSettings>;
    } catch {
      // Missing or unreadable file: fall back to defaults.
    }
    const port =
      Number.isInteger(stored.port) && stored.port! >= 1 && stored.port! <= 65535
        ? stored.port!
        : DEFAULT_MCP_PORT;
    return { enabled: stored.enabled === true, port };
  }

  save(settings: McpSettings): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(settings, null, 2));
  }
}
