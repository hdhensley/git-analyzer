import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, string>();
vi.mock('keytar', () => ({
  default: {
    setPassword: async (_service: string, account: string, value: string) => {
      store.set(account, value);
    },
    getPassword: async (_service: string, account: string) => store.get(account) ?? null,
    deletePassword: async (_service: string, account: string) => store.delete(account),
  },
}));

import { McpTokenStore } from './mcp-token';

describe('McpTokenStore', () => {
  beforeEach(() => store.clear());

  it('creates a token on first use and then returns the same one', async () => {
    const first = await new McpTokenStore().getOrCreate();
    expect(first).toHaveLength(64);
    expect(await new McpTokenStore().getOrCreate()).toBe(first);
    expect([...store.keys()]).toEqual(['mcp-token']);
  });

  it('regenerate replaces the stored token', async () => {
    const tokens = new McpTokenStore();
    const first = await tokens.getOrCreate();
    const second = await tokens.regenerate();
    expect(second).not.toBe(first);
    expect(await tokens.getOrCreate()).toBe(second);
  });
});
