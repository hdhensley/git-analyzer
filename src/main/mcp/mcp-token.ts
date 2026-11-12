import keytar from 'keytar';
import { newToken } from './mcp-settings';

const SERVICE_NAME = 'git-analytics-dashboard';
const ACCOUNT = 'mcp-token';

/** Keeps the MCP bearer token in the OS keychain, alongside the app's other secrets. */
export class McpTokenStore {
  /** Returns the stored token, creating and saving one on first use. */
  async getOrCreate(): Promise<string> {
    const existing = await keytar.getPassword(SERVICE_NAME, ACCOUNT);
    if (existing && existing.length >= 32) return existing;
    return this.regenerate();
  }

  async regenerate(): Promise<string> {
    const token = newToken();
    await keytar.setPassword(SERVICE_NAME, ACCOUNT, token);
    return token;
  }
}
