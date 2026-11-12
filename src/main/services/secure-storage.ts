import keytar from 'keytar';
import type { SCMProvider, Credentials } from '../../shared/types';

const SERVICE_NAME = 'git-analytics-dashboard';

// Credentials can be stored for any SCM provider plus the Snyk security
// integration. Snyk is not an SCM provider, so the storage key is widened
// here rather than polluting the SCMProvider union.
export type CredentialKey = SCMProvider | 'snyk';

export class SecureStorage {
  /**
   * @param namespace Optional prefix that isolates this instance's keychain
   *   entries (used to give each space its own credentials). When omitted the
   *   account names are the legacy, un-prefixed ones.
   */
  constructor(private readonly namespace?: string) {}

  private getAccountName(provider: CredentialKey): string {
    const base = `${provider}-credentials`;
    return this.namespace ? `${this.namespace}:${base}` : base;
  }

  async setCredentials(provider: CredentialKey, credentials: Credentials): Promise<void> {
    const account = this.getAccountName(provider);
    const data = JSON.stringify({
      accessToken: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      expiresAt: credentials.expiresAt?.toISOString(),
      username: credentials.username,
      bitbucketWorkspaces: credentials.bitbucketWorkspaces,
      snykOrgId: credentials.snykOrgId,
      snykOrgName: credentials.snykOrgName,
    });
    await keytar.setPassword(SERVICE_NAME, account, data);
  }

  async getCredentials(provider: CredentialKey): Promise<Credentials | null> {
    const account = this.getAccountName(provider);
    const data = await keytar.getPassword(SERVICE_NAME, account);

    if (!data) {
      return null;
    }

    try {
      const parsed = JSON.parse(data);
      return {
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken,
        expiresAt: parsed.expiresAt ? new Date(parsed.expiresAt) : undefined,
        username: parsed.username,
        bitbucketWorkspaces: parsed.bitbucketWorkspaces,
        snykOrgId: parsed.snykOrgId,
        snykOrgName: parsed.snykOrgName,
      };
    } catch {
      return null;
    }
  }

  async deleteCredentials(provider: CredentialKey): Promise<boolean> {
    const account = this.getAccountName(provider);
    return keytar.deletePassword(SERVICE_NAME, account);
  }

  /** Removes the stored credentials for every provider in this namespace. */
  async deleteAllCredentials(): Promise<void> {
    for (const key of ['github', 'bitbucket', 'snyk'] as CredentialKey[]) {
      await this.deleteCredentials(key);
    }
  }

  async hasCredentials(provider: CredentialKey): Promise<boolean> {
    const credentials = await this.getCredentials(provider);
    return credentials !== null;
  }
}
