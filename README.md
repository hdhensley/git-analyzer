# Git Analytics Dashboard

Cross-platform Electron desktop app for visualizing git activity across GitHub, Bitbucket, and local repositories.

## Features

- **Multi-source imports** — GitHub, Bitbucket (cloud), and local git repositories
- **Authentication** — Personal Access Tokens (GitHub) / scoped API tokens (Bitbucket), recommended, or OAuth
- **Contribution graph** — GitHub-style heatmap with per-contributor filtering
- **Commits per user** — breakdown by author across all imported repos
- **Repository commit summary** — compare activity across repos
- **Message summary** — commit message analysis
- **Filters** — date range, repository, and branch filtering
- **Local repo scanning** — recursively discover git repos in a directory
- **Rate limit handling** — automatic retry with exponential backoff for API calls
- **Secure credential storage** — uses OS keychain via keytar

## Tech Stack

- Electron 28
- React 18 + TypeScript
- Vite (renderer bundling)
- better-sqlite3 (local database)
- keytar (OS keychain)
- electron-builder (packaging)

## Installation (Linux)

Download and install the latest release with:

```bash
curl -fsSL https://raw.githubusercontent.com/hdhensley/git-analyzer/main/install.sh | bash
```

This will install the AppImage to `~/.local/bin/git-analytics-dashboard` if that directory is in your PATH, otherwise to `/usr/local/bin/git-analytics-dashboard` (requires sudo).

To update, run the same command — it overwrites the existing binary.

## Getting Started

### Prerequisites

- Node.js 20+
- npm
- Git (for local repository imports)

### Install

```bash
git clone <repo-url>
cd git-analytics-dashboard
npm install
```

### Configure (optional)

Copy the example env file if you want OAuth support. PAT/App Password auth works without any env configuration.

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `GITHUB_CLIENT_ID` | GitHub OAuth App client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App client secret |
| `BITBUCKET_CLIENT_ID` | Bitbucket OAuth consumer key |
| `BITBUCKET_CLIENT_SECRET` | Bitbucket OAuth consumer secret |

### Development

```bash
npm run dev
```

This starts the TypeScript compiler for the main process and Vite dev server for the renderer concurrently.

### Build

```bash
npm run build
npm start
```

### Package

```bash
npm run package:mac
npm run package:win
npm run package:linux
```

Outputs go to the `release/` directory.

## Authentication

### Access Tokens (recommended)

No server-side configuration needed — works out of the box.

- **GitHub**: Create a token at [github.com/settings/tokens](https://github.com/settings/tokens) with `repo` and `read:user` scopes
- **Bitbucket**: Create a scoped API token at [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens) with the `read:repository:bitbucket` and `read:account` scopes. Connecting requires three things:
  - your **Atlassian account email** (used as the Basic auth username)
  - the **API token**
  - your **workspace ID** — the slug in your repository URLs, e.g. `my-team` in `bitbucket.org/my-team/some-repo`

  Scoped API tokens are workspace-scoped and cannot enumerate workspaces or use account-level endpoints, so the workspace ID must be supplied explicitly. (Legacy app passwords are deprecated by Atlassian.)

### OAuth

Requires `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` or `BITBUCKET_CLIENT_ID`/`BITBUCKET_CLIENT_SECRET` in `.env`. The OAuth tab is disabled in the UI when credentials aren't configured.

## Cloud Import Limits

- Maximum 2,000 commits per repository
- Maximum 1 year of history
- Whichever limit is reached first

## Releases

Pushing a tag matching `v*` triggers a GitHub Actions workflow that builds and packages for macOS (dmg, zip), Windows (exe, zip), and Linux (AppImage, deb), then creates a GitHub Release with all artifacts.

```bash
git tag v1.0.0
git push origin v1.0.0
```

## Project Structure

```
src/
  main/           # Electron main process
    services/     # Database, auth, git, local-git, secure-storage
  renderer/       # React UI
    components/   # Auth, dashboard, filters, repositories, widgets
    hooks/        # useElectronAPI
  shared/         # Types shared between main and renderer
```

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start dev mode (main + renderer + Electron) |
| `npm run build` | Build main + renderer |
| `npm start` | Launch built Electron app |
| `npm test` | Run tests |
| `npm run lint` | Lint TypeScript |
| `npm run format` | Format with Prettier |
| `npm run package` | Package for current OS |

## License

MIT
