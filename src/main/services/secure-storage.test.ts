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

import { SecureStorage } from './secure-storage';

describe('SecureStorage namespaces', () => {
  beforeEach(() => store.clear());

  it('uses the legacy un-prefixed account name without a namespace', async () => {
    await new SecureStorage().setCredentials('github', { accessToken: 't', username: 'u' });
    expect([...store.keys()]).toEqual(['github-credentials']);
  });

  it('prefixes account names with the namespace', async () => {
    await new SecureStorage('sp_1').setCredentials('snyk', { accessToken: 't', username: 'u' });
    expect([...store.keys()]).toEqual(['sp_1:snyk-credentials']);
  });

  it('isolates credentials between namespaces and the legacy keys', async () => {
    await new SecureStorage().setCredentials('github', { accessToken: 'legacy', username: 'u' });
    await new SecureStorage('sp_1').setCredentials('github', { accessToken: 'work', username: 'u' });

    expect((await new SecureStorage().getCredentials('github'))?.accessToken).toBe('legacy');
    expect((await new SecureStorage('sp_1').getCredentials('github'))?.accessToken).toBe('work');
    expect(await new SecureStorage('sp_2').getCredentials('github')).toBeNull();
  });

  it('deleteAllCredentials only removes its own namespace', async () => {
    const legacy = new SecureStorage();
    const work = new SecureStorage('sp_1');
    await legacy.setCredentials('github', { accessToken: 'a', username: 'u' });
    await work.setCredentials('github', { accessToken: 'b', username: 'u' });
    await work.setCredentials('bitbucket', { accessToken: 'c', username: 'u' });
    await work.setCredentials('snyk', { accessToken: 'd', username: 'u' });

    await work.deleteAllCredentials();
    expect([...store.keys()]).toEqual(['github-credentials']);
  });
});
