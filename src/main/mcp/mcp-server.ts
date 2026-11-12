import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import { MCP_TOOLS, SCHEMA_DOC, SCHEMA_RESOURCE_URI, ToolInputError, type McpContext } from './mcp-tools';

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY_BYTES = 1024 * 1024;
const SERVER_INFO = { name: 'git-analyzer', version: '1.0.0' };

type JsonRpcId = string | number | null;
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message);
  }
}

export interface McpServerOptions {
  host?: string;
  port: number;
  token: string;
  /** Resolved on every request so a space switch is picked up immediately. */
  context: () => McpContext;
}

/**
 * Minimal MCP server over Streamable HTTP in stateless, JSON-response mode.
 * It exposes the active space's data read-only and binds to loopback only.
 */
export class McpHttpServer {
  private server: http.Server | null = null;
  private readonly host: string;

  constructor(private readonly options: McpServerOptions) {
    this.host = options.host ?? '127.0.0.1';
  }

  get running(): boolean {
    return this.server !== null;
  }

  /** Port actually listening (differs from the requested one when 0 was asked for). */
  get port(): number {
    return this.server ? (this.server.address() as AddressInfo).port : this.options.port;
  }

  start(): Promise<void> {
    if (this.server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handle(req, res).catch(() => {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
      });
      server.once('error', reject);
      server.listen(this.options.port, this.host, () => {
        server.off('error', reject);
        this.server = server;
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  // ---- HTTP layer -----------------------------------------------------------

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Block DNS-rebinding: only loopback Host and Origin values are accepted.
    if (!this.isLocalHost(req.headers.host) || !this.isLocalOrigin(req.headers.origin)) {
      return this.send(res, 403, { error: 'Forbidden' });
    }
    if (!this.isAuthorized(req.headers.authorization)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return this.send(res, 401, { error: 'Unauthorized' });
    }
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/mcp') {
      return this.send(res, 404, { error: 'Not found' });
    }
    if (req.method !== 'POST') {
      // No server-initiated stream and no sessions to terminate.
      res.setHeader('Allow', 'POST');
      return this.send(res, 405, { error: 'Method not allowed' });
    }

    let body: unknown;
    try {
      body = JSON.parse(await this.readBody(req));
    } catch (error) {
      if (error instanceof RpcError && error.code === -32000) {
        return this.send(res, 413, rpcFailure(null, error.code, error.message));
      }
      return this.send(res, 400, rpcFailure(null, -32700, 'Parse error'));
    }

    const messages = Array.isArray(body) ? body : [body];
    if (messages.length === 0) {
      return this.send(res, 400, rpcFailure(null, -32600, 'Invalid Request'));
    }
    const responses = messages
      .map((m) => this.dispatch(m))
      .filter((r): r is Record<string, unknown> => r !== null);
    if (responses.length === 0) {
      res.writeHead(202);
      res.end();
      return;
    }
    this.send(res, 200, Array.isArray(body) ? responses : responses[0]);
  }

  private isLocalHost(host: string | undefined): boolean {
    if (!host) return false;
    const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
    return ['127.0.0.1', 'localhost', '[::1]'].includes(name);
  }

  private isLocalOrigin(origin: string | undefined): boolean {
    if (!origin) return true; // Non-browser clients send no Origin.
    try {
      return this.isLocalHost(new URL(origin).host);
    } catch {
      return false;
    }
  }

  private isAuthorized(header: string | undefined): boolean {
    const match = /^Bearer (.+)$/.exec(header ?? '');
    if (!match) return false;
    const a = Buffer.from(match[1]);
    const b = Buffer.from(this.options.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new RpcError(-32000, 'Request too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  private send(res: http.ServerResponse, status: number, payload: unknown): void {
    const text = JSON.stringify(payload);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(text),
    });
    res.end(text);
  }

  // ---- JSON-RPC layer -------------------------------------------------------

  /** Returns the response object, or null for notifications and client responses. */
  private dispatch(message: unknown): Record<string, unknown> | null {
    const req = message as Partial<JsonRpcRequest> | null;
    if (!req || typeof req !== 'object' || req.jsonrpc !== '2.0') {
      return rpcFailure(null, -32600, 'Invalid Request');
    }
    if (typeof req.method !== 'string') return null; // A response from the client; nothing to do.
    const isNotification = req.id === undefined;
    try {
      const result = this.route(req.method, req.params ?? {});
      return isNotification ? null : { jsonrpc: '2.0', id: req.id, result };
    } catch (error) {
      if (isNotification) return null;
      if (error instanceof RpcError) return rpcFailure(req.id ?? null, error.code, error.message);
      return rpcFailure(req.id ?? null, -32603, 'Internal error');
    }
  }

  private route(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        return {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: {}, resources: {} },
          serverInfo: SERVER_INFO,
          instructions:
            'Read-only access to a local git analytics database. Call get_selection to see what the user is viewing, list_repositories for ids, and the query tool for ad-hoc SQL.',
        };
      }
      case 'ping':
        return {};
      case 'tools/list':
        return {
          tools: MCP_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        };
      case 'tools/call':
        return this.callTool(params);
      case 'resources/list':
        return {
          resources: [
            {
              uri: SCHEMA_RESOURCE_URI,
              name: 'Database schema',
              description: 'Tables and columns reachable through the query tool',
              mimeType: 'text/plain',
            },
          ],
        };
      case 'resources/read':
        if (params.uri !== SCHEMA_RESOURCE_URI) throw new RpcError(-32002, 'Resource not found');
        return { contents: [{ uri: SCHEMA_RESOURCE_URI, mimeType: 'text/plain', text: SCHEMA_DOC }] };
      default:
        if (method.startsWith('notifications/')) return {};
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  }

  private callTool(params: Record<string, unknown>): unknown {
    const tool = MCP_TOOLS.find((t) => t.name === params.name);
    if (!tool) throw new RpcError(-32602, `Unknown tool: ${String(params.name)}`);
    const args = params.arguments ?? {};
    if (typeof args !== 'object' || Array.isArray(args)) {
      throw new RpcError(-32602, '"arguments" must be an object');
    }
    try {
      const value = tool.handler(args as Record<string, unknown>, this.options.context());
      return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
    } catch (error) {
      if (!(error instanceof ToolInputError)) {
        console.error(`MCP tool ${tool.name} failed:`, error);
      }
      const message = error instanceof ToolInputError ? error.message : 'Tool failed unexpectedly';
      return { isError: true, content: [{ type: 'text', text: message }] };
    }
  }
}

function rpcFailure(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
