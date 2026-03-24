import { getAuthService } from './auth';
import type {
  SCMProvider,
  Repository,
  RepositoryPage,
  Commit,
  CommitData,
  RepositorySource,
} from '../../shared/types';

const PAGE_SIZE = 100;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;
const MAX_CLOUD_COMMITS = 2000;
const MAX_CLOUD_AGE_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

export type FetchProgressCallback = (info: {
  currentPage?: number;
  commitsSoFar?: number;
  rateLimitRetrySeconds?: number;
}) => void;

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  onProgress?: FetchProgressCallback,
  retries = MAX_RETRIES
): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch(url, options);

    if (response.status === 429) {
      if (attempt === retries) {
        throw new Error('Rate limited by API after multiple retries');
      }
      const retryAfter = response.headers.get('Retry-After');
      const delaySec = retryAfter
        ? parseInt(retryAfter, 10)
        : Math.ceil((BASE_DELAY_MS * Math.pow(2, attempt)) / 1000);
      onProgress?.({ rateLimitRetrySeconds: delaySec });
      await new Promise((resolve) => setTimeout(resolve, delaySec * 1000));
      continue;
    }

    return response;
  }

  throw new Error('Unexpected retry loop exit');
}

export class GitService {
  private authService = getAuthService();

  private normalizeBitbucketBranchName(branch: string | undefined): string | undefined {
    if (!branch) return undefined;
    const trimmed = branch.trim();
    if (!trimmed) return undefined;
    return trimmed.replace(/^refs\/heads\//, '');
  }

  private buildBitbucketCommitsUrl(repo: Repository, branch?: string): string {
    const encodedOwner = encodeURIComponent(repo.owner);
    const encodedRepo = encodeURIComponent(repo.name);
    const baseUrl = `https://api.bitbucket.org/2.0/repositories/${encodedOwner}/${encodedRepo}/commits`;

    if (branch) {
      return `${baseUrl}/${encodeURIComponent(branch)}?pagelen=100`;
    }

    return `${baseUrl}?pagelen=100`;
  }

  async listRepositories(provider: SCMProvider, page: number = 1): Promise<RepositoryPage> {
    const authHeader = await this.authService.getAuthHeader(provider);

    if (!authHeader) {
      throw new Error(`Not authenticated with ${provider}`);
    }

    if (provider === 'github') {
      return this.listGitHubRepositories(authHeader, page);
    } else {
      return this.listBitbucketRepositories(authHeader, page);
    }
  }

  private async listGitHubRepositories(authHeader: string, page: number): Promise<RepositoryPage> {
    const url = new URL('https://api.github.com/user/repos');
    url.searchParams.set('per_page', PAGE_SIZE.toString());
    url.searchParams.set('page', page.toString());
    url.searchParams.set('sort', 'updated');
    url.searchParams.set('direction', 'desc');

    const response = await fetchWithRetry(url.toString(), {
      headers: {
        Authorization: authHeader,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch repositories: ${response.statusText}`);
    }

    type GitHubRepo = {
      id: number;
      name: string;
      owner: { login: string };
      default_branch: string;
      html_url: string;
    };

    const repos = (await response.json()) as GitHubRepo[];
    const linkHeader = response.headers.get('Link');
    const hasNextPage = linkHeader?.includes('rel="next"') ?? false;

    const repositories: Repository[] = repos.map((repo) => ({
      id: `github-${repo.id}`,
      name: repo.name,
      owner: repo.owner.login,
      provider: 'github' as const,
      defaultBranch: repo.default_branch,
      url: repo.html_url,
      parentFolder: repo.owner.login,
    }));

    return {
      repositories,
      totalCount: repositories.length + (hasNextPage ? PAGE_SIZE : 0),
      hasNextPage,
      nextPage: hasNextPage ? page + 1 : undefined,
    };
  }

  private async listBitbucketRepositories(
    authHeader: string,
    page: number
  ): Promise<RepositoryPage> {
    const allRepositories: Repository[] = [];
    let nextUrl: string | null = (() => {
      const url = new URL('https://api.bitbucket.org/2.0/repositories');
      url.searchParams.set('role', 'member');
      url.searchParams.set('pagelen', PAGE_SIZE.toString());
      url.searchParams.set('page', page.toString());
      return url.toString();
    })();

    type BitbucketRepo = {
      uuid: string;
      slug: string;
      name: string;
      owner: { nickname?: string; username?: string; display_name?: string };
      workspace?: { slug: string; name?: string };
      mainbranch?: { name: string };
      links: { html: { href: string } };
      project?: { name: string };
      full_name?: string;
    };

    while (nextUrl) {
      const response = await fetchWithRetry(nextUrl, {
        headers: {
          Authorization: authHeader,
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch repositories: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        values: BitbucketRepo[];
        next?: string;
        size?: number;
      };

      for (const repo of data.values) {
        // Bitbucket API v2: use workspace.slug for API calls (owner.username is deprecated)
        // full_name is "workspace/repo-slug" which is the most reliable identifier
        const ownerSlug =
          repo.workspace?.slug ||
          repo.full_name?.split('/')[0] ||
          repo.owner?.nickname ||
          repo.owner?.username ||
          repo.owner?.display_name ||
          'unknown';

        allRepositories.push({
          id: `bitbucket-${repo.uuid}`,
          name: repo.slug || repo.name,
          owner: ownerSlug,
          provider: 'bitbucket' as const,
          defaultBranch: repo.mainbranch?.name || 'main',
          url: repo.links.html.href,
          parentFolder: repo.project?.name,
        });
      }

      nextUrl = data.next || null;
    }

    return {
      repositories: allRepositories,
      totalCount: allRepositories.length,
      hasNextPage: false,
      nextPage: undefined,
    };
  }

  async fetchGitLog(
    repo: Repository,
    onProgress?: FetchProgressCallback
  ): Promise<{ commits: CommitData[]; repository: Repository; fetchedAt: Date }> {
    if (repo.provider === 'local') {
      throw new Error('Local repositories should be handled by LocalGitService');
    }

    const authHeader = await this.authService.getAuthHeader(repo.provider as SCMProvider);

    if (!authHeader) {
      throw new Error(`Not authenticated with ${repo.provider}`);
    }

    let commits: CommitData[];
    if (repo.provider === 'github') {
      commits = await this.fetchGitHubCommits(authHeader, repo, onProgress);
    } else {
      commits = await this.fetchBitbucketCommits(authHeader, repo, onProgress);
    }

    return { commits, repository: repo, fetchedAt: new Date() };
  }

  private async fetchGitHubCommits(
    authHeader: string,
    repo: Repository,
    onProgress?: FetchProgressCallback
  ): Promise<CommitData[]> {
    const allCommits: CommitData[] = [];
    let page = 1;
    const perPage = 100;
    const oneYearAgo = new Date(Date.now() - MAX_CLOUD_AGE_MS);

    type GitHubCommit = {
      sha: string;
      commit: {
        author: { name: string; email: string; date: string };
        message: string;
      };
    };

    while (true) {
      onProgress?.({ currentPage: page, commitsSoFar: allCommits.length });

      const url = new URL(`https://api.github.com/repos/${repo.owner}/${repo.name}/commits`);
      url.searchParams.set('per_page', perPage.toString());
      url.searchParams.set('page', page.toString());
      url.searchParams.set('sha', repo.defaultBranch);
      url.searchParams.set('since', oneYearAgo.toISOString());

      const response = await fetchWithRetry(
        url.toString(),
        {
          headers: {
            Authorization: authHeader,
            Accept: 'application/vnd.github.v3+json',
          },
        },
        onProgress
      );

      if (!response.ok) {
        if (response.status === 409) {
          // Empty repository
          return [];
        }
        throw new Error(`Failed to fetch commits: ${response.statusText}`);
      }

      const commits = (await response.json()) as GitHubCommit[];

      if (commits.length === 0) break;

      for (const commit of commits) {
        allCommits.push({
          hash: commit.sha,
          authorName: commit.commit.author.name,
          authorEmail: commit.commit.author.email,
          date: new Date(commit.commit.author.date),
          message: commit.commit.message,
          branch: repo.defaultBranch,
        });
        if (allCommits.length >= MAX_CLOUD_COMMITS) break;
      }

      if (allCommits.length >= MAX_CLOUD_COMMITS) break;
      if (commits.length < perPage) break;
      page++;
    }

    return allCommits;
  }

  private async fetchBitbucketCommits(
    authHeader: string,
    repo: Repository,
    onProgress?: FetchProgressCallback
  ): Promise<CommitData[]> {
    const allCommits: CommitData[] = [];
    const normalizedBranch = this.normalizeBitbucketBranchName(repo.defaultBranch);
    let nextUrl: string | null = this.buildBitbucketCommitsUrl(repo, normalizedBranch);
    let usedDefaultBranchFallback = false;
    let page = 1;
    const oneYearAgo = new Date(Date.now() - MAX_CLOUD_AGE_MS);

    while (nextUrl) {
      onProgress?.({ currentPage: page, commitsSoFar: allCommits.length });

      const response: Response = await fetchWithRetry(
        nextUrl,
        {
          headers: {
            Authorization: authHeader,
            Accept: 'application/json',
          },
        },
        onProgress
      );

      if (!response.ok) {
        if (
          !usedDefaultBranchFallback &&
          (response.status === 400 || response.status === 404 || response.status === 409)
        ) {
          nextUrl = this.buildBitbucketCommitsUrl(repo);
          usedDefaultBranchFallback = true;
          page = 1;
          continue;
        }
        throw new Error(`Failed to fetch commits: ${response.statusText}`);
      }

      type BitbucketCommitResponse = {
        values: Array<{
          hash: string;
          author: { user?: { display_name: string; email: string }; raw: string };
          date: string;
          message: string;
        }>;
        next?: string;
      };

      const data = (await response.json()) as BitbucketCommitResponse;

      // Some repositories report an unusable default branch. If the first page is empty,
      // retry once without a branch selector to let Bitbucket resolve it.
      if (
        !usedDefaultBranchFallback &&
        page === 1 &&
        data.values.length === 0 &&
        normalizedBranch
      ) {
        nextUrl = this.buildBitbucketCommitsUrl(repo);
        usedDefaultBranchFallback = true;
        continue;
      }

      let hitLimit = false;

      for (const commit of data.values) {
        const commitDate = new Date(commit.date);
        if (commitDate < oneYearAgo) {
          hitLimit = true;
          break;
        }
        allCommits.push({
          hash: commit.hash,
          authorName:
            commit.author.user?.display_name ||
            commit.author.raw?.split('<')[0].trim() ||
            'Unknown',
          authorEmail: commit.author.user?.email || commit.author.raw?.match(/<(.+)>/)?.[1] || '',
          date: commitDate,
          message: commit.message,
          branch: repo.defaultBranch,
        });
        if (allCommits.length >= MAX_CLOUD_COMMITS) {
          hitLimit = true;
          break;
        }
      }

      if (hitLimit) break;
      nextUrl = data.next || null;
      page++;
    }

    return allCommits;
  }

  async fetchNewCommits(
    repo: Repository,
    since: Date
  ): Promise<{ commits: CommitData[]; repository: Repository; fetchedAt: Date }> {
    if (repo.provider === 'local') {
      throw new Error('Local repositories should be handled by LocalGitService');
    }

    const authHeader = await this.authService.getAuthHeader(repo.provider as SCMProvider);

    if (!authHeader) {
      throw new Error(`Not authenticated with ${repo.provider}`);
    }

    let commits: CommitData[];
    if (repo.provider === 'github') {
      commits = await this.fetchGitHubCommitsSince(authHeader, repo, since);
    } else {
      commits = await this.fetchBitbucketCommitsSince(authHeader, repo, since);
    }

    return { commits, repository: repo, fetchedAt: new Date() };
  }

  private async fetchGitHubCommitsSince(
    authHeader: string,
    repo: Repository,
    since: Date
  ): Promise<CommitData[]> {
    const allCommits: CommitData[] = [];
    let page = 1;
    const perPage = 100;

    type GitHubCommit = {
      sha: string;
      commit: {
        author: { name: string; email: string; date: string };
        message: string;
      };
    };

    while (true) {
      const url = new URL(`https://api.github.com/repos/${repo.owner}/${repo.name}/commits`);
      url.searchParams.set('per_page', perPage.toString());
      url.searchParams.set('page', page.toString());
      url.searchParams.set('sha', repo.defaultBranch);
      url.searchParams.set('since', since.toISOString());

      const response = await fetchWithRetry(url.toString(), {
        headers: {
          Authorization: authHeader,
          Accept: 'application/vnd.github.v3+json',
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch commits: ${response.statusText}`);
      }

      const commits = (await response.json()) as GitHubCommit[];

      if (commits.length === 0) break;

      for (const commit of commits) {
        allCommits.push({
          hash: commit.sha,
          authorName: commit.commit.author.name,
          authorEmail: commit.commit.author.email,
          date: new Date(commit.commit.author.date),
          message: commit.commit.message,
          branch: repo.defaultBranch,
        });
      }

      if (commits.length < perPage) break;
      page++;
    }

    return allCommits;
  }

  private async fetchBitbucketCommitsSince(
    authHeader: string,
    repo: Repository,
    since: Date
  ): Promise<CommitData[]> {
    const allCommits: CommitData[] = [];
    const normalizedBranch = this.normalizeBitbucketBranchName(repo.defaultBranch);
    let nextUrl: string | null = this.buildBitbucketCommitsUrl(repo, normalizedBranch);
    let usedDefaultBranchFallback = false;
    let page = 1;

    type BitbucketCommitResponse = {
      values: Array<{
        hash: string;
        author: { user?: { display_name: string; email: string }; raw: string };
        date: string;
        message: string;
      }>;
      next?: string;
    };

    while (nextUrl) {
      const response: Response = await fetchWithRetry(nextUrl, {
        headers: {
          Authorization: authHeader,
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        if (
          !usedDefaultBranchFallback &&
          (response.status === 400 || response.status === 404 || response.status === 409)
        ) {
          nextUrl = this.buildBitbucketCommitsUrl(repo);
          usedDefaultBranchFallback = true;
          page = 1;
          continue;
        }
        throw new Error(`Failed to fetch commits: ${response.statusText}`);
      }

      const data = (await response.json()) as BitbucketCommitResponse;

      if (
        !usedDefaultBranchFallback &&
        page === 1 &&
        data.values.length === 0 &&
        normalizedBranch
      ) {
        nextUrl = this.buildBitbucketCommitsUrl(repo);
        usedDefaultBranchFallback = true;
        continue;
      }

      let foundOlder = false;

      for (const commit of data.values) {
        const commitDate = new Date(commit.date);
        if (commitDate <= since) {
          foundOlder = true;
          break;
        }

        allCommits.push({
          hash: commit.hash,
          authorName:
            commit.author.user?.display_name ||
            commit.author.raw?.split('<')[0].trim() ||
            'Unknown',
          authorEmail: commit.author.user?.email || commit.author.raw?.match(/<(.+)>/)?.[1] || '',
          date: commitDate,
          message: commit.message,
          branch: repo.defaultBranch,
        });
      }

      if (foundOlder) break;
      nextUrl = data.next || null;
      page++;
    }

    return allCommits;
  }
}

// Singleton instance
let gitInstance: GitService | null = null;

export function getGitService(): GitService {
  if (!gitInstance) {
    gitInstance = new GitService();
  }
  return gitInstance;
}
