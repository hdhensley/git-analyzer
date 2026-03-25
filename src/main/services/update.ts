import https from 'https';
import fs from 'fs/promises';
import path from 'path';
import { app, dialog, shell } from 'electron';
import type { UpdateCheckResult } from '../../shared/types';

const GITHUB_REPO = 'hdhensley/git-analyzer';
const GITHUB_RELEASES_LATEST = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const UPDATE_CHECK_STATE_FILE = 'update-check-state.json';
const STARTUP_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface LatestRelease {
  tag_name?: string;
  html_url?: string;
}

interface UpdateCheckState {
  lastCheckedAt: number;
}

function normalizeVersion(version: string): string {
  return String(version).trim().replace(/^v/i, '');
}

function isNewerVersion(latest: string, current: string): boolean {
  const latestParts = normalizeVersion(latest)
    .split('.')
    .map((segment) => Number(segment) || 0);
  const currentParts = normalizeVersion(current)
    .split('.')
    .map((segment) => Number(segment) || 0);

  const maxLength = Math.max(latestParts.length, currentParts.length);

  for (let i = 0; i < maxLength; i += 1) {
    const latestValue = latestParts[i] ?? 0;
    const currentValue = currentParts[i] ?? 0;
    if (latestValue > currentValue) return true;
    if (latestValue < currentValue) return false;
  }

  return false;
}

function fetchLatestRelease(): Promise<LatestRelease> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      GITHUB_RELEASES_LATEST,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `${app.getName()}/${app.getVersion()}`,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];

        response.on('data', (chunk) => {
          chunks.push(Buffer.from(chunk));
        });

        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            reject(
              new Error(`GitHub API responded with status ${response.statusCode ?? 'unknown'}`)
            );
            return;
          }

          try {
            const parsed = JSON.parse(body) as LatestRelease;
            resolve(parsed);
          } catch {
            reject(new Error('Failed to parse GitHub releases response'));
          }
        });
      }
    );

    request.on('error', (error) => reject(error));
  });
}

function getUpdateCheckStatePath(): string {
  return path.join(app.getPath('userData'), UPDATE_CHECK_STATE_FILE);
}

async function readUpdateCheckState(): Promise<UpdateCheckState | null> {
  try {
    const filePath = getUpdateCheckStatePath();
    const content = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(content) as Partial<UpdateCheckState>;

    if (typeof parsed.lastCheckedAt !== 'number' || !Number.isFinite(parsed.lastCheckedAt)) {
      return null;
    }

    return { lastCheckedAt: parsed.lastCheckedAt };
  } catch {
    return null;
  }
}

async function writeUpdateCheckState(state: UpdateCheckState): Promise<void> {
  const filePath = getUpdateCheckStatePath();
  await fs.writeFile(filePath, JSON.stringify(state), 'utf8');
}

export class UpdateService {
  async checkForStartupUpdates(): Promise<UpdateCheckResult> {
    if (!app.isPackaged) {
      return {
        status: 'skipped',
        currentVersion: app.getVersion(),
        message: 'Update checks are skipped in development mode.',
      };
    }

    const existingState = await readUpdateCheckState();
    const now = Date.now();

    if (existingState && now - existingState.lastCheckedAt < STARTUP_CHECK_INTERVAL_MS) {
      return {
        status: 'skipped',
        currentVersion: app.getVersion(),
        message: 'Startup update check skipped (checked within last 24 hours).',
      };
    }

    const result = await this.checkForUpdates(false);

    try {
      await writeUpdateCheckState({ lastCheckedAt: now });
    } catch (error) {
      console.error('Failed to persist update check state:', error);
    }

    return result;
  }

  async checkForUpdates(showNoUpdateDialog = false): Promise<UpdateCheckResult> {
    if (!app.isPackaged) {
      return {
        status: 'skipped',
        currentVersion: app.getVersion(),
        message: 'Update checks are skipped in development mode.',
      };
    }

    const currentVersion = normalizeVersion(app.getVersion());

    try {
      const latestRelease = await fetchLatestRelease();
      const latestVersion = normalizeVersion(latestRelease.tag_name ?? '');
      const releaseUrl = latestRelease.html_url ?? `https://github.com/${GITHUB_REPO}/releases`;

      if (!latestVersion) {
        return {
          status: 'error',
          currentVersion,
          message: 'Latest release version was missing from GitHub response.',
        };
      }

      if (isNewerVersion(latestVersion, currentVersion)) {
        const response = await dialog.showMessageBox({
          type: 'info',
          title: 'Update Available',
          message: `Version ${latestVersion} is available.`,
          detail: `You are currently running ${currentVersion}.`,
          buttons: ['Update now', 'Later'],
          defaultId: 0,
          cancelId: 1,
        });

        if (response.response === 0) {
          await shell.openExternal(releaseUrl);
        }

        return {
          status: 'update-available',
          currentVersion,
          latestVersion,
          releaseUrl,
          prompted: true,
        };
      }

      if (showNoUpdateDialog) {
        await dialog.showMessageBox({
          type: 'info',
          title: 'You are up to date',
          message: `You are running the latest version (${currentVersion}).`,
          buttons: ['OK'],
        });
      }

      return {
        status: 'up-to-date',
        currentVersion,
        latestVersion,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown update check error';

      if (showNoUpdateDialog) {
        await dialog.showMessageBox({
          type: 'error',
          title: 'Update check failed',
          message: 'Could not check for updates right now.',
          detail: message,
          buttons: ['OK'],
        });
      }

      return {
        status: 'error',
        currentVersion,
        message,
      };
    }
  }
}

let updateService: UpdateService | null = null;

export function getUpdateService(): UpdateService {
  if (!updateService) {
    updateService = new UpdateService();
  }
  return updateService;
}
