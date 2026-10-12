import { useState, useEffect } from 'react';
import { useElectronAPI } from '../../hooks';
import type { SnykStatus } from '../../../shared/types';
import './AuthStatus.css';

interface SnykConnectionProps {
  onStatusChange?: (status: SnykStatus) => void;
}

const SNYK_TOKEN_HELP_URL =
  'https://docs.snyk.io/snyk-api/authentication-for-api/revoking-and-regenerating-api-tokens';

/**
 * Connection card for the Snyk security integration. Lives in the dashboard's
 * "Connect" area alongside GitHub and Bitbucket. Collects a Snyk API token and
 * an optional organization ID so the Repository Health widget can show critical
 * and high issue counts per repository.
 */
export function SnykConnection({ onStatusChange }: SnykConnectionProps) {
  const api = useElectronAPI();
  const [status, setStatus] = useState<SnykStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState('');
  const [orgIdInput, setOrgIdInput] = useState('');

  const fetchStatus = async () => {
    if (!api) return;
    try {
      setLoading(true);
      setError(null);
      const result = await api.snyk.getStatus();
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
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const handleConnect = async () => {
    if (!api) return;
    if (!tokenInput.trim()) {
      setError('Please enter a Snyk API token.');
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const result = await api.snyk.connect(tokenInput.trim(), orgIdInput.trim() || undefined);
      if (result.success) {
        setTokenInput('');
        setOrgIdInput('');
        await fetchStatus();
      } else {
        setError(result.error || 'Connection failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = async () => {
    if (!api) return;
    if (!confirm('Disconnect from Snyk?')) return;
    try {
      setLoading(true);
      setError(null);
      await api.snyk.disconnect();
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Disconnect failed');
    } finally {
      setLoading(false);
    }
  };

  if (!api) {
    return (
      <div className="auth-status auth-status--disconnected">
        <div className="auth-status__info">
          <span className="auth-status__provider">Snyk</span>
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
        <span className="auth-status__provider">Snyk</span>
        <span className="auth-status__state">Loading...</span>
      </div>
    );
  }

  if (status?.connected) {
    return (
      <div className="auth-status auth-status--connected">
        <div className="auth-status__info">
          <span className="auth-status__provider">Snyk</span>
          <span className="auth-status__username">
            Connected as {status.username}
            {status.orgName ? ` · ${status.orgName}` : ''}
          </span>
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
        <span className="auth-status__provider">Snyk</span>
        <span className="auth-status__state">Not connected</span>
      </div>

      <div className="auth-status__token-form">
        <input
          type="password"
          className="auth-status__input"
          placeholder="Snyk API Token"
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
          disabled={loading}
          aria-label="Snyk API Token"
        />
        <input
          type="text"
          className="auth-status__input"
          placeholder="Organization ID (optional)"
          value={orgIdInput}
          onChange={(e) => setOrgIdInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
          disabled={loading}
          aria-label="Snyk Organization ID"
        />
        <div className="auth-status__token-actions">
          <button
            type="button"
            className="auth-status__btn auth-status__btn--connect"
            onClick={handleConnect}
            disabled={loading || !tokenInput.trim()}
          >
            {loading ? 'Connecting...' : 'Connect'}
          </button>
          <a
            href={SNYK_TOKEN_HELP_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="auth-status__help-link"
            onClick={(e) => {
              e.preventDefault();
              window.open(SNYK_TOKEN_HELP_URL, '_blank');
            }}
          >
            Find your Snyk API token ↗
          </a>
        </div>
        <div className="auth-status__permissions">
          <span className="auth-status__permissions-label">About this connection:</span>
          <ul className="auth-status__permissions-list">
            <li>Uses a Snyk API token (service account or personal)</li>
            <li>Leave Organization ID blank to use the token&apos;s first org</li>
            <li>Surfaces critical and high issue counts in Repository Health</li>
          </ul>
        </div>
      </div>

      {error && <div className="auth-status__error">{error}</div>}
    </div>
  );
}
