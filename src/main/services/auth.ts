import { BrowserWindow, shell } from 'electron';
import { getSecureStorage } from './secure-storage';
import { getDatabase } from './database';
import type { SCMProvider, AuthResult, AuthStatus, Credentials } from '../../shared/types';

// OAuth configuration - these should be set via environment variables or config
const OAUTH_CONFIG = {
  github: {
    clientId: process.env.GITHUB_CLIENT_ID || '',
    clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scope: 'repo read:user',
    redirectUri: 'git-analytics://oauth/callback',
  },
  bitbucket: {
    clientId: process.env.BITBUCKET_CLIENT_ID || '',
    clientSecret: process.env.BITBUCKET_CLIENT_SECRET || '',
    authUrl: 'https://bitbucket.org/site/oauth2/authorize',
    tokenUrl: 'https://bitbucket.org/site/oauth2/access_token',
    scope: 'repository account',
    redirectUri: 'git-analytics://oauth/callback',
  },
};

const BITBUCKET_BASIC_TOKEN_PREFIX = 'bb_basic:';
const BITBUCKET_BASIC_USER_TOKEN_PREFIX = 'bb_basic_user:';

export class AuthService {
  private secureStorage = getSecureStorage();
  private db = getDatabase();

  async authenticate(provider: SCMProvider): Promise<AuthResult> {
    const config = OAUTH_CONFIG[provider];

    if (!config.clientId) {
      return {
        success: false,
        provider,
        error: `OAuth not configured for ${provider}. Please set ${provider.toUpperCase()}_CLIENT_ID environment variable.`,
      };
    }

    try {
      const code = await this.openOAuthWindow(provider);
      if (!code) {
        return { success: false, provider, error: 'Authorization was denied or cancelled.' };
      }

      const tokens = await this.exchangeCodeForToken(provider, code);
      const username = await this.fetchUsername(provider, tokens.accessToken);

      const credentials: Credentials = {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000) : undefined,
        username,
      };

      await this.secureStorage.setCredentials(provider, credentials);
      this.db.saveProvider(provider, username);

      return { success: true, provider, username };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error occurred';
      return { success: false, provider, error: message };
    }
  }
  isOAuthConfigured(provider: SCMProvider): boolean {
    const config = OAUTH_CONFIG[provider];
    return !!(config.clientId && config.clientSecret);
  }

  async authenticateWithToken(
    provider: SCMProvider,
    token: string,
    username?: string
  ): Promise<AuthResult> {
    try {
      // Both GitHub PATs and Bitbucket API tokens use Bearer auth
      const normalizedToken = token.replace(/^Bearer\s+/i, '').trim();
      let resolvedUsername: string;

      if (provider === 'bitbucket') {
        const parsedBitbucketInput = this.parseBitbucketTokenInput(normalizedToken);

        const {
          valid,
          resolvedUsername: bitbucketUsername,
          useBasicAuth,
          basicAuthUsername,
          errorMessage,
        } = await this.validateBitbucketToken(
          parsedBitbucketInput.token,
          username || parsedBitbucketInput.username
        );

        if (!valid) {
          return {
            success: false,
            provider,
            error:
              errorMessage ||
              'Invalid API token. If this is a scoped API token, ensure it has Bitbucket scopes and not Atlassian-only scopes.',
          };
        }

        resolvedUsername = bitbucketUsername;

        const credentials: Credentials = {
          accessToken: useBasicAuth
            ? basicAuthUsername
              ? `${BITBUCKET_BASIC_USER_TOKEN_PREFIX}${Buffer.from(`${basicAuthUsername}:${parsedBitbucketInput.token}`).toString('base64')}`
              : `${BITBUCKET_BASIC_TOKEN_PREFIX}${parsedBitbucketInput.token}`
            : parsedBitbucketInput.token,
          username: resolvedUsername,
        };

        await this.secureStorage.setCredentials(provider, credentials);
        this.db.saveProvider(provider, resolvedUsername);

        return { success: true, provider, username: resolvedUsername };
      } else {
        // GitHub: validate PAT with Bearer auth
        const response = await fetch('https://api.github.com/user', {
          headers: {
            Authorization: `Bearer ${normalizedToken}`,
            Accept: 'application/vnd.github.v3+json',
          },
        });
        if (!response.ok) {
          return { success: false, provider, error: 'Invalid personal access token.' };
        }
        const data = (await response.json()) as { login: string };
        resolvedUsername = data.login;

        const credentials: Credentials = {
          accessToken: normalizedToken,
          username: resolvedUsername,
        };

        await this.secureStorage.setCredentials(provider, credentials);
        this.db.saveProvider(provider, resolvedUsername);

        return { success: true, provider, username: resolvedUsername };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error occurred';
      return { success: false, provider, error: message };
    }
  }

  private async openOAuthWindow(provider: SCMProvider): Promise<string | null> {
    const config = OAUTH_CONFIG[provider];
    const state = Math.random().toString(36).substring(2);

    const authUrl = new URL(config.authUrl);
    authUrl.searchParams.set('client_id', config.clientId);
    authUrl.searchParams.set('redirect_uri', config.redirectUri);
    authUrl.searchParams.set('scope', config.scope);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('response_type', 'code');

    return new Promise((resolve) => {
      const authWindow = new BrowserWindow({
        width: 800,
        height: 600,
        show: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
        },
      });

      authWindow.webContents.on('will-redirect', (_event, url) => {
        this.handleOAuthCallback(url, state, resolve, authWindow);
      });

      authWindow.webContents.on('will-navigate', (_event, url) => {
        this.handleOAuthCallback(url, state, resolve, authWindow);
      });

      authWindow.on('closed', () => {
        resolve(null);
      });

      authWindow.loadURL(authUrl.toString());
    });
  }

  private handleOAuthCallback(
    url: string,
    expectedState: string,
    resolve: (code: string | null) => void,
    window: BrowserWindow
  ): void {
    if (!url.startsWith('git-analytics://oauth/callback')) {
      return;
    }

    const urlObj = new URL(url);
    const code = urlObj.searchParams.get('code');
    const state = urlObj.searchParams.get('state');
    const error = urlObj.searchParams.get('error');

    if (error) {
      resolve(null);
      window.close();
      return;
    }

    if (state !== expectedState) {
      resolve(null);
      window.close();
      return;
    }

    resolve(code);
    window.close();
  }

  private async exchangeCodeForToken(
    provider: SCMProvider,
    code: string
  ): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }> {
    const config = OAUTH_CONFIG[provider];

    const params = new URLSearchParams({
      code,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };

    if (provider === 'bitbucket') {
      // Bitbucket requires Basic Auth with client_id:client_secret
      headers['Authorization'] =
        'Basic ' + Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
    } else {
      // GitHub accepts credentials in the body
      params.set('client_id', config.clientId);
      params.set('client_secret', config.clientSecret);
    }

    const response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers,
      body: params.toString(),
    });

    if (!response.ok) {
      throw new Error(`Token exchange failed: ${response.statusText}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };

    if (data.error) {
      throw new Error(data.error_description || data.error);
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    };
  }

  private async fetchUsername(provider: SCMProvider, accessToken: string): Promise<string> {
    const url =
      provider === 'github' ? 'https://api.github.com/user' : 'https://api.bitbucket.org/2.0/user';

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch user info: ${response.statusText}`);
    }

    const data = (await response.json()) as { login?: string; username?: string };
    return provider === 'github' ? data.login! : data.username!;
  }

  async getStatus(provider: SCMProvider): Promise<AuthStatus> {
    const credentials = await this.secureStorage.getCredentials(provider);

    if (!credentials) {
      return { connected: false, provider };
    }

    return {
      connected: true,
      provider,
      username: credentials.username,
    };
  }

  async disconnect(provider: SCMProvider): Promise<void> {
    await this.secureStorage.deleteCredentials(provider);
    this.db.deleteProvider(provider);
  }

  async validateToken(provider: SCMProvider): Promise<boolean> {
    const credentials = await this.secureStorage.getCredentials(provider);

    if (!credentials) {
      return false;
    }

    // Check if token is expired
    if (credentials.expiresAt && credentials.expiresAt < new Date()) {
      // Try to refresh if we have a refresh token
      if (credentials.refreshToken) {
        try {
          await this.refreshToken(provider, credentials.refreshToken);
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }

    // Validate by making a test API call
    try {
      if (provider === 'bitbucket') {
        const { valid } = await this.validateBitbucketToken(
          credentials.accessToken,
          credentials.username
        );
        if (!valid) {
          return false;
        }
      } else {
        await this.fetchUsername(provider, credentials.accessToken);
      }
      this.db.updateProviderValidation(provider);
      return true;
    } catch {
      return false;
    }
  }

  private async validateBitbucketToken(
    token: string,
    fallbackUsername?: string
  ): Promise<{
    valid: boolean;
    resolvedUsername: string;
    useBasicAuth: boolean;
    basicAuthUsername?: string;
    errorMessage?: string;
  }> {
    const parsedStoredToken = this.parseStoredBitbucketToken(token);
    const rawToken = parsedStoredToken.token;
    const providedBasicUsername = fallbackUsername?.trim() || parsedStoredToken.basicAuthUsername;

    const authCandidates: Array<{
      useBasicAuth: boolean;
      authHeader: string;
      basicAuthUsername?: string;
      label: string;
    }> = [
      { useBasicAuth: false, authHeader: `Bearer ${rawToken}`, label: 'bearer' },
      {
        useBasicAuth: true,
        authHeader: `Basic ${Buffer.from(`x-token-auth:${rawToken}`).toString('base64')}`,
        label: 'basic x-token-auth',
      },
    ];

    if (providedBasicUsername) {
      authCandidates.unshift({
        useBasicAuth: true,
        authHeader: `Basic ${Buffer.from(`${providedBasicUsername}:${rawToken}`).toString('base64')}`,
        basicAuthUsername: providedBasicUsername,
        label: 'basic email',
      });
    }

    let lastFailure: string | undefined;

    for (const candidate of authCandidates) {
      const userResponse = await fetch('https://api.bitbucket.org/2.0/user', {
        headers: {
          Authorization: candidate.authHeader,
          Accept: 'application/json',
        },
      });

      if (userResponse.ok) {
        const data = (await userResponse.json()) as {
          display_name?: string;
          username?: string;
          nickname?: string;
        };

        return {
          valid: true,
          resolvedUsername:
            data.nickname ||
            data.username ||
            data.display_name ||
            fallbackUsername?.trim() ||
            'bitbucket-token',
          useBasicAuth: candidate.useBasicAuth,
          basicAuthUsername: candidate.basicAuthUsername,
        };
      }

      // Some scoped tokens can fail on /user; verify via repository listing instead.
      const repoResponse = await fetch(
        'https://api.bitbucket.org/2.0/repositories?role=member&pagelen=1',
        {
          headers: {
            Authorization: candidate.authHeader,
            Accept: 'application/json',
          },
        }
      );

      if (repoResponse.ok) {
        return {
          valid: true,
          resolvedUsername: fallbackUsername?.trim() || 'bitbucket-token',
          useBasicAuth: candidate.useBasicAuth,
          basicAuthUsername: candidate.basicAuthUsername,
        };
      }

      lastFailure = `Bitbucket rejected token (${candidate.label} auth): /user ${userResponse.status}, /repositories ${repoResponse.status}.`;
    }

    return {
      valid: false,
      resolvedUsername: fallbackUsername?.trim() || 'bitbucket-token',
      useBasicAuth: false,
      errorMessage: lastFailure,
    };
  }

  private parseBitbucketTokenInput(input: string): { token: string; username?: string } {
    const value = input.trim();
    const firstColonIndex = value.indexOf(':');

    if (
      firstColonIndex > 0 &&
      firstColonIndex < value.length - 1 &&
      value.includes('@')
    ) {
      const possibleUsername = value.slice(0, firstColonIndex).trim();
      const possibleToken = value.slice(firstColonIndex + 1).trim();
      if (possibleUsername && possibleToken) {
        return { token: possibleToken, username: possibleUsername };
      }
    }

    return { token: value };
  }

  private parseStoredBitbucketToken(input: string): { token: string; basicAuthUsername?: string } {
    if (input.startsWith(BITBUCKET_BASIC_USER_TOKEN_PREFIX)) {
      const encoded = input.slice(BITBUCKET_BASIC_USER_TOKEN_PREFIX.length);
      try {
        const decoded = Buffer.from(encoded, 'base64').toString('utf8');
        const separatorIndex = decoded.indexOf(':');
        if (separatorIndex > 0 && separatorIndex < decoded.length - 1) {
          return {
            basicAuthUsername: decoded.slice(0, separatorIndex),
            token: decoded.slice(separatorIndex + 1),
          };
        }
      } catch {
        return { token: input };
      }
    }

    if (input.startsWith(BITBUCKET_BASIC_TOKEN_PREFIX)) {
      return { token: input.slice(BITBUCKET_BASIC_TOKEN_PREFIX.length) };
    }

    return { token: input };
  }

  private async refreshToken(provider: SCMProvider, refreshToken: string): Promise<void> {
    const config = OAUTH_CONFIG[provider];

    const params = new URLSearchParams({
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };

    if (provider === 'bitbucket') {
      headers['Authorization'] =
        'Basic ' + Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
    } else {
      params.set('client_id', config.clientId);
      params.set('client_secret', config.clientSecret);
    }

    const response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers,
      body: params.toString(),
    });

    if (!response.ok) {
      throw new Error('Token refresh failed');
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };
    const credentials = await this.secureStorage.getCredentials(provider);

    if (credentials) {
      const updated: Credentials = {
        ...credentials,
        accessToken: data.access_token,
        refreshToken: data.refresh_token || refreshToken,
        expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : undefined,
      };
      await this.secureStorage.setCredentials(provider, updated);
    }
  }

  async getCredentials(provider: SCMProvider): Promise<Credentials | null> {
    return this.secureStorage.getCredentials(provider);
  }

  /**
   * Returns the appropriate Authorization header value for the provider.
   * Handles both OAuth (Bearer) and app password (Basic) auth for Bitbucket.
   */
  async getAuthHeader(provider: SCMProvider): Promise<string | null> {
    const credentials = await this.secureStorage.getCredentials(provider);
    if (!credentials) return null;

    if (provider === 'bitbucket') {
      if (credentials.accessToken.startsWith(BITBUCKET_BASIC_USER_TOKEN_PREFIX)) {
        const encoded = credentials.accessToken.slice(BITBUCKET_BASIC_USER_TOKEN_PREFIX.length);
        return `Basic ${encoded}`;
      }

      if (credentials.accessToken.startsWith(BITBUCKET_BASIC_TOKEN_PREFIX)) {
        const rawToken = credentials.accessToken.slice(BITBUCKET_BASIC_TOKEN_PREFIX.length);
        return `Basic ${Buffer.from(`x-token-auth:${rawToken}`).toString('base64')}`;
      }
    }

    return `Bearer ${credentials.accessToken}`;
  }
}

// Singleton instance
let authInstance: AuthService | null = null;

export function getAuthService(): AuthService {
  if (!authInstance) {
    authInstance = new AuthService();
  }
  return authInstance;
}
