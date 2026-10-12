import keytar from 'keytar';
import type { SCMProvider, Credentials } from '../../shared/types';

const SERVICE_NAME = 'git-analytics-dashboard';

// Credentials can be stored for any SCM provider plus the Snyk security
// integration. Snyk is not an SCM provider, so the storage key is widened
// here rather than polluting the SCMProvider union.
export type CredentialKey = SCMProvider | 'snyk';

export class SecureStorage {
  private getAccountName(provider: CredentialKey): string {
    return `${provider}-credentials`;
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

  async hasCredentials(provider: CredentialKey): Promise<boolean> {
    const credentials = await this.getCredentials(provider);
    return credentials !== null;
  }
}

// Singleton instance
let storageInstance: SecureStorage | null = null;

export function getSecureStorage(): SecureStorage {
  if (!storageInstance) {
    storageInstance = new SecureStorage();
  }
  return storageInstance;
}
