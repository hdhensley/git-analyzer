import keytar from 'keytar';
import type { SCMProvider, Credentials } from '../../shared/types';

const SERVICE_NAME = 'git-analytics-dashboard';

export class SecureStorage {
  private getAccountName(provider: SCMProvider): string {
    return `${provider}-credentials`;
  }

  async setCredentials(provider: SCMProvider, credentials: Credentials): Promise<void> {
    const account = this.getAccountName(provider);
    const data = JSON.stringify({
      accessToken: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      expiresAt: credentials.expiresAt?.toISOString(),
      username: credentials.username,
    });
    await keytar.setPassword(SERVICE_NAME, account, data);
  }

  async getCredentials(provider: SCMProvider): Promise<Credentials | null> {
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
      };
    } catch {
      return null;
    }
  }

  async deleteCredentials(provider: SCMProvider): Promise<boolean> {
    const account = this.getAccountName(provider);
    return keytar.deletePassword(SERVICE_NAME, account);
  }

  async hasCredentials(provider: SCMProvider): Promise<boolean> {
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
