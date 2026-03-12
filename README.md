# Git Analytics Dashboard

Cross-platform Electron desktop app for visualizing git activity across GitHub, Bitbucket, and local repositories.

## Features

- **Multi-source imports** — GitHub, Bitbucket (cloud), and local git repositories
- **Authentication** — Personal Access Tokens / App Passwords (recommended) or OAuth
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

### Personal Access Tokens (recommended)

No server-side configuration needed — works out of the box.

- **GitHub**: Create a token at [github.com/settings/tokens](https://github.com/settings/tokens) with `repo` and `read:user` scopes
- **Bitbucket**: Create an app password at [bitbucket.org/account/settings/app-passwords](https://bitbucket.org/account/settings/app-passwords) with Repository Read and Account Read permissions. Requires your Bitbucket username.

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
| `npm run dev` | Start dev mode (main + renderer) |
| `npm run build` | Build main + renderer |
| `npm start` | Launch built Electron app |
| `npm test` | Run tests |
| `npm run lint` | Lint TypeScript |
| `npm run format` | Format with Prettier |
| `npm run package` | Package for current OS |

## License

MIT
