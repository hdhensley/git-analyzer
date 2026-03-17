import { useState, useEffect } from 'react';
import { useElectronAPI } from '../../hooks';
import type { SCMProvider, AuthStatus as AuthStatusType } from '../../../shared/types';
import './AuthStatus.css';

interface AuthStatusProps {
  provider: SCMProvider;
  onStatusChange?: (status: AuthStatusType) => void;
}

type AuthMode = 'oauth' | 'token';

export function AuthStatus({ provider, onStatusChange }: AuthStatusProps) {
  const api = useElectronAPI();
  const [status, setStatus] = useState<AuthStatusType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>('token');
  const [tokenInput, setTokenInput] = useState('');
  const [oauthAvailable, setOauthAvailable] = useState(false);

  const fetchStatus = async () => {
    if (!api) return;
    try {
      setLoading(true);
      setError(null);
      const result = await api.auth.getStatus(provider);
      setStatus(result);
      onStatusChange?.(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get status');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (api) {
      fetchStatus();
      api.auth.isOAuthConfigured(provider).then(setOauthAvailable);
    }
  }, [provider, api]);

  const handleConnect = async () => {
    if (!api) return;
    try {
      setLoading(true);
      setError(null);
      const result = await api.auth.authenticate(provider);
      if (result.success) {
        await fetchStatus();
      } else {
        setError(result.error || 'Authentication failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  const handleTokenSubmit = async () => {
    if (!api) return;
    if (!tokenInput.trim()) {
      setError(provider === 'github' ? 'Please enter a personal access token.' : 'Please enter an API token.');
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const result = await api.auth.authenticateWithToken(
        provider,
        tokenInput.trim()
      );
      if (result.success) {
        setTokenInput('');
        await fetchStatus();
      } else {
        setError(result.error || 'Authentication failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = async () => {
    if (!api) return;
    if (!confirm(`Disconnect from ${provider}?`)) return;
    try {
      setLoading(true);
      setError(null);
      await api.auth.disconnect(provider);
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Disconnect failed');
    } finally {
      setLoading(false);
    }
  };

  const providerName = provider === 'github' ? 'GitHub' : 'Bitbucket';
  const tokenLabel = provider === 'github' ? 'Personal Access Token' : 'API Token';
  const tokenHelpUrl = provider === 'github'
    ? 'https://github.com/settings/tokens'
    : 'https://bitbucket.org/account/settings/app-passwords/new';

  if (!api) {
    return (
      <div className="auth-status auth-status--disconnected">
        <div className="auth-status__info">
          <span className="auth-status__provider">{providerName}</span>
          <span className="auth-status__state">Waiting for connection...</span>
        </div>
        <div className="auth-status__actions">
          <button
            type="button"
            className="auth-status__btn auth-status__btn--connect"
            onClick={() => window.location.reload()}
            title="Reload to retry connection"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (loading && !status) {
    return (
      <div className="auth-status auth-status--loading">
        <span className="auth-status__provider">{providerName}</span>
        <span className="auth-status__state">Loading...</span>
      </div>
    );
  }

  if (status?.connected) {
    return (
      <div className="auth-status auth-status--connected">
        <div className="auth-status__info">
          <span className="auth-status__provider">{providerName}</span>
          <span className="auth-status__username">Connected as {status.username}</span>
        </div>
        <div className="auth-status__actions">
          <button
            type="button"
            className="auth-status__btn auth-status__btn--disconnect"
            onClick={handleDisconnect}
            disabled={loading}
          >
            Disconnect
          </button>
        </div>
        {error && <div className="auth-status__error">{error}</div>}
      </div>
    );
  }

  return (
    <div className="auth-status auth-status--disconnected">
      <div className="auth-status__info">
        <span className="auth-status__provider">{providerName}</span>
        <span className="auth-status__state">Not connected</span>
      </div>

      <div className="auth-status__mode-tabs">
        <button
          type="button"
          className={`auth-status__tab ${authMode === 'token' ? 'auth-status__tab--active' : ''}`}
          onClick={() => { setAuthMode('token'); setError(null); }}
        >
          {tokenLabel}
        </button>
        <button
          type="button"
          className={`auth-status__tab ${authMode === 'oauth' ? 'auth-status__tab--active' : ''}`}
          onClick={() => { setAuthMode('oauth'); setError(null); }}
          disabled={!oauthAvailable}
          title={!oauthAvailable ? 'OAuth not configured — set client ID and secret in .env' : ''}
        >
          OAuth{!oauthAvailable ? ' (not configured)' : ''}
        </button>
      </div>

      {authMode === 'token' ? (
        <div className="auth-status__token-form">
          <input
            type="password"
            className="auth-status__input"
            placeholder={tokenLabel}
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleTokenSubmit()}
            disabled={loading}
            aria-label={tokenLabel}
          />
          <div className="auth-status__token-actions">
            <button
              type="button"
              className="auth-status__btn auth-status__btn--connect"
              onClick={handleTokenSubmit}
              disabled={loading || !tokenInput.trim()}
            >
              {loading ? 'Connecting...' : 'Connect'}
            </button>
            <a
              href={tokenHelpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="auth-status__help-link"
              onClick={(e) => { e.preventDefault(); window.open(tokenHelpUrl, '_blank'); }}
            >
              Create {tokenLabel} ↗
            </a>
          </div>
          <div className="auth-status__permissions">
            <span className="auth-status__permissions-label">Required permissions:</span>
            {provider === 'github' ? (
              <ul className="auth-status__permissions-list">
                <li><code>repo</code> — read access to repositories and commit history</li>
              </ul>
            ) : (
              <ul className="auth-status__permissions-list">
                <li><code>Repositories: Read</code> — list and read repository data</li>
                <li><code>Account: Read</code> — verify account identity</li>
              </ul>
            )}
          </div>
        </div>
      ) : (
        <div className="auth-status__oauth-section">
          <button
            type="button"
            className="auth-status__btn auth-status__btn--connect"
            onClick={handleConnect}
            disabled={loading}
          >
            {loading ? 'Connecting...' : `Connect with ${providerName}`}
          </button>
          <span className="auth-status__oauth-note">Requires OAuth app configuration</span>
        </div>
      )}

      {error && <div className="auth-status__error">{error}</div>}
    </div>
  );
}
