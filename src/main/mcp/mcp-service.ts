import type { SpaceManager } from '../spaces/space-manager';
import { McpHttpServer } from './mcp-server';
import { McpSettingsStore, type McpSettings } from './mcp-settings';
import { McpTokenStore } from './mcp-token';

/** Owns the MCP server's lifecycle and persisted settings. */
export class McpService {
  private readonly store: McpSettingsStore;
  private settings: McpSettings;
  private server: McpHttpServer | null = null;
  private readonly tokens = new McpTokenStore();

  constructor(
    userDataDir: string,
    private readonly spaces: SpaceManager
  ) {
    this.store = new McpSettingsStore(userDataDir);
    this.settings = this.store.load();
  }

  get enabled(): boolean {
    return this.server?.running ?? false;
  }

  get url(): string {
    return `http://127.0.0.1:${this.settings.port}/mcp`;
  }

  /** Client config in the common `mcpServers` + url/headers shape. */
  async connectionConfig(): Promise<string> {
    const token = await this.tokens.getOrCreate();
    return JSON.stringify(
      {
        mcpServers: {
          'git-analyzer': {
            url: this.url,
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      },
      null,
      2
    );
  }

  /** Starts the server if the user left it enabled. Failures are logged, not thrown. */
  async startIfEnabled(): Promise<void> {
    if (!this.settings.enabled) return;
    try {
      await this.start();
    } catch (error) {
      console.error('MCP server failed to start:', error);
    }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled) {
      await this.start();
      this.persist({ enabled: true });
    } else {
      await this.stop();
      this.persist({ enabled: false });
    }
  }

  /** Issues a new token and drops the old one immediately. */
  async regenerateToken(): Promise<void> {
    const wasRunning = this.enabled;
    await this.stop();
    await this.tokens.regenerate();
    if (wasRunning) await this.start();
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    await server?.stop();
  }

  private async start(): Promise<void> {
    if (this.server?.running) return;
    const server = new McpHttpServer({
      port: this.settings.port,
      token: await this.tokens.getOrCreate(),
      context: () => {
        const space = this.spaces.active();
        return { db: space.db, space: { id: space.id, name: space.name } };
      },
    });
    await server.start();
    this.server = server;
  }

  private persist(patch: Partial<McpSettings>): void {
    this.settings = { ...this.settings, ...patch };
    this.store.save(this.settings);
  }
}
