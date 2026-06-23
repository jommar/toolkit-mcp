import axios, { AxiosInstance, isAxiosError } from 'axios';

const MAX_RETRIES = 3;
const MAX_BRANCH_SEARCH_CALLS = 20;
/** Regex for validating repo "owner/name" format. */
const REPO_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
/** Regex for validating Jira issue keys (e.g. TRIPS-1234). */
const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]{0,10}-\d{1,6}$/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PrInfo {
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  /** "owner/name" — e.g. "TransActComm/Portage-backend" */
  repo: string;
  author: string;
  createdAt: string;
  htmlUrl: string;
  reviewStatus: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | 'COMMENTED';
}

export type PrSearchResult = PrInfo;

export interface PrCreated {
  number: number;
  htmlUrl: string;
  state: string;
}

export interface BranchInfo {
  name: string;
  sha: string;
  protected: boolean;
}

export interface PullRequestDetail {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed' | 'merged';
  htmlUrl: string;
  repo: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  mergeable: boolean | null;
  mergedBy: string | null;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  changedFiles: number;
  additions: number;
  deletions: number;
}

export interface PullRequestReview {
  id: number;
  user: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'PENDING' | 'DISMISSED';
  body: string | null;
  submittedAt: string;
  commitId: string;
}

export interface CheckRun {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;
  htmlUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface PullRequestChecks {
  totalCount: number;
  checkRuns: CheckRun[];
}

export interface PrSearchOptions {
  query?: string;
  author?: string;
  repo?: string;
  state?: 'open' | 'closed' | 'all';
  perPage?: number;
  page?: number;
}

function getGhRepos(): string[] {
  const env = process.env.GH_REPOS?.trim();
  if (env) return env.split(',').map((s) => s.trim()).filter(Boolean);
  return ['TransActComm/TravelTracker', 'TransActComm/Portage-backend', 'TransActComm/Portage-frontend'];
}
const GH_REPOS = getGhRepos();

/**
 * Minimal client over the GitHub REST API for finding PRs related to Jira issues.
 * Auth is Bearer token from GH_TOKEN env var.
 */
export class GitHubClient {
  private readonly http: AxiosInstance;

  constructor() {
    const token = process.env.GH_TOKEN?.trim();
    if (!token) {
      throw new Error(
        'GH_TOKEN env var is required. Create one at https://github.com/settings/tokens and add it to .env',
      );
    }

    this.http = axios.create({
      baseURL: 'https://api.github.com',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
      timeout: 30_000,
      paramsSerializer: (params: Record<string, unknown>) => {
        return Object.entries(params)
          .map(([key, val]) => `${key}=${encodeURIComponent(String(val)).replace(/%2F/g, '/')}`)
          .join('&');
      },
    });
    this.installRetry();
  }

  /**
   * Retry transient failures: 429 (rate limit — honor Retry-After) and 5xx / timeouts,
   * with exponential backoff. Matches JiraClient retry pattern exactly.
   */
  private installRetry(): void {
    this.http.interceptors.response.use(undefined, async (error) => {
      const config: any = error.config;
      const status: number | undefined = error.response?.status;
      const retryable =
        status === 429 || (status !== undefined && status >= 500 && status < 600) || error.code === 'ECONNABORTED';
      if (!config || !retryable) throw error;

      config.__retryCount = (config.__retryCount ?? 0) + 1;
      if (config.__retryCount > MAX_RETRIES) throw error;

      const retryAfter = Number(error.response?.headers?.['retry-after']);
      const delayMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(500 * 2 ** (config.__retryCount - 1), 8000);
      await sleep(delayMs);
      return this.http(config);
    });
  }

  /**
   * Search all configured repos for open PRs whose title or body
   * references the given issue key. Returns results sorted by repo then PR number.
   *
   * @param issueKey - Jira issue key to search for
   * @param maxResults - Optional cap on total results across all repos
   */
  async searchPrs(
    issueKey: string,
    maxResults?: number,
    prState?: 'open' | 'closed' | 'all',
  ): Promise<PrSearchResult[]> {
    if (!ISSUE_KEY_PATTERN.test(issueKey)) {
      throw new Error(`Invalid issue key format: "${issueKey}"`);
    }
    const _state = prState ?? 'open';
    const settled = await Promise.allSettled(
      GH_REPOS.map(async (repo) => {
        try {
          const stateFilter = _state === 'all' ? '' : `state:${_state}`;
          const q = ['type:pr', stateFilter, `repo:${repo}`, issueKey].filter(Boolean).join(' ');
          const result = await this.fetchAllPages<any>('/search/issues', {
            q,
            per_page: 100,
          });
          return this.parseItems(result.items);
        } catch (err) {
          console.error(`Warning: search failed for ${repo}`);
          return [];
        }
      }),
    );

    const flat = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    let deduped = this.deduplicate(flat).sort((a, b) => {
      if (a.repo < b.repo) return -1;
      if (a.repo > b.repo) return 1;
      return a.number - b.number;
    });

    // Apply maxResults cap before fetching review status
    if (maxResults !== undefined && maxResults > 0) {
      deduped = deduped.slice(0, maxResults);
    }

    // Fetch review status for each PR in parallel
    const statuses = await Promise.allSettled(
      deduped.map(async (pr) => {
        const reviewStatus = await this.getReviewStatus(pr.repo, pr.number);
        return { htmlUrl: pr.htmlUrl, reviewStatus };
      }),
    );

    const statusMap = new Map<string, PrInfo['reviewStatus']>();
    for (const result of statuses) {
      if (result.status === 'fulfilled') {
        statusMap.set(result.value.htmlUrl, result.value.reviewStatus);
      }
    }

    return deduped.map((pr) => ({
      ...pr,
      reviewStatus: statusMap.get(pr.htmlUrl) ?? 'REVIEW_REQUIRED',
    }));
  }

  /**
   * Batched PR search for multiple issue keys (max 20). Splits keys into chunks
   * of max 4 to stay under GitHub's 5-operator limit per query, runs multiple
   * queries in parallel, deduplicates results, then groups by matching key.
   *
   * Keys beyond 20 are logged as a warning and skipped.
   */
  async findPrsForIssueKeys(
    keys: string[],
    prState?: 'open' | 'closed' | 'all',
  ): Promise<Map<string, PrSearchResult[]>> {
    const allKeys = keys.slice(0, 20);
    if (keys.length > 20) {
      console.error(`Warning: --with-prs supports up to 20 keys; ${keys.length - 20} key(s) skipped.`);
    }

    if (allKeys.length === 0) return new Map();

    // Validate each key
    for (const key of allKeys) {
      if (!ISSUE_KEY_PATTERN.test(key)) {
        throw new Error(`Invalid issue key format: "${key}"`);
      }
    }

    // Sanitize keys by stripping potentially dangerous characters
    const sanitizedKeys = allKeys.map((k) => k.replace(/[()":]/g, ''));

    // Split into chunks of 4 to stay under GitHub's 5-operator limit
    const CHUNK_SIZE = 4;
    const chunks: string[][] = [];
    for (let i = 0; i < sanitizedKeys.length; i += CHUNK_SIZE) {
      chunks.push(sanitizedKeys.slice(i, i + CHUNK_SIZE));
    }

    const _state = prState ?? 'open';
    const stateFilter = _state === 'all' ? '' : `state:${_state}`;

    const settled = await Promise.allSettled(
      chunks.map(async (chunk) => {
        const query = [`(${chunk.join(' OR ')})`, 'type:pr', stateFilter, 'org:TransActComm']
          .filter(Boolean)
          .join(' ');
        const result = await this.fetchAllPages<any>('/search/issues', {
          q: query,
          per_page: 100,
        });
        return { items: result.items, keys: chunk };
      }),
    );

    const allItems: any[] = [];
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        allItems.push(...result.value.items);
      }
    }

    // Deduplicate by htmlUrl (same PR could match multiple chunks)
    const seen = new Set<string>();
    const uniqueItems: any[] = [];
    for (const item of allItems) {
      if (!seen.has(item.html_url)) {
        seen.add(item.html_url);
        uniqueItems.push(item);
      }
    }

    const grouped = new Map<string, PrSearchResult[]>();
    for (const item of uniqueItems) {
      const titleUpper = (item.title ?? '').toUpperCase();
      const bodyUpper = (item.body ?? '').toUpperCase();
      for (const key of allKeys) {
        if (titleUpper.includes(key.toUpperCase()) || bodyUpper.includes(key.toUpperCase())) {
          const pr = this.parseItems([item])[0];
          const existing = grouped.get(key) ?? [];
          existing.push(pr);
          grouped.set(key, existing);
        }
      }
    }

    for (const [, prs] of grouped) {
      prs.sort((a, b) => {
        if (a.repo < b.repo) return -1;
        if (a.repo > b.repo) return 1;
        return a.number - b.number;
      });
    }

    // Fetch review status for each unique PR in parallel
    const uniquePrMap = new Map<string, { repo: string; number: number }>();
    for (const [, prs] of grouped) {
      for (const pr of prs) {
        if (!uniquePrMap.has(pr.htmlUrl)) {
          uniquePrMap.set(pr.htmlUrl, { repo: pr.repo, number: pr.number });
        }
      }
    }

    const statuses = await Promise.allSettled(
      [...uniquePrMap.entries()].map(async ([htmlUrl, { repo, number }]) => {
        const reviewStatus = await this.getReviewStatus(repo, number);
        return { htmlUrl, reviewStatus };
      }),
    );

    const statusMap = new Map<string, PrInfo['reviewStatus']>();
    for (const result of statuses) {
      if (result.status === 'fulfilled') {
        statusMap.set(result.value.htmlUrl, result.value.reviewStatus);
      }
    }

    for (const [, prs] of grouped) {
      for (const pr of prs) {
        pr.reviewStatus = statusMap.get(pr.htmlUrl) ?? 'REVIEW_REQUIRED';
      }
    }

    return grouped;
  }

  private parseItems(items: any[]): PrSearchResult[] {
    return items.map((item) => ({
      number: item.number,
      title: item.title,
      state: item.state === 'closed' && item.pull_request?.merged_at ? 'merged' : item.state,
      repo: this.extractRepo(item.repository_url),
      author: item.user?.login ?? 'unknown',
      createdAt: item.created_at,
      htmlUrl: item.html_url,
      reviewStatus: 'REVIEW_REQUIRED',
    }));
  }

  /** Extract "owner/name" from a GitHub API repository URL. */
  private extractRepo(url: string): string {
    return url.replace('https://api.github.com/repos/', '');
  }

  /**
   * Follow GitHub's Link header pagination (rel="next") to fetch all pages.
   * Capped at `maxPages` (default 5) to prevent runaway requests.
   * Returns concatenated items from all pages.
   */
  private async fetchAllPages<T>(
    url: string,
    params: Record<string, unknown>,
    maxPages: number = 5,
  ): Promise<{ items: T[]; linkHeader?: string }> {
    const allItems: T[] = [];
    let nextUrl: string | undefined = url;
    let currentParams = { ...params };
    let pages = 0;

    while (nextUrl && pages < maxPages) {
      const response = await this.http.get<{ total_count?: number; items: T[] }>(nextUrl, {
        params: nextUrl === url ? currentParams : undefined, // params only on first request
      });
      allItems.push(...(response.data.items ?? []));
      pages++;

      // Parse Link header for next page
      const linkHeader = response.headers?.['link'] as string | undefined;
      nextUrl = this.parseNextLink(linkHeader);
    }

    return { items: allItems };
  }

  /**
   * Parse GitHub's Link header for rel="next" URL.
   * Returns the URL string or undefined if no next page.
   * Link format: `<https://api.github.com/search/issues?page=2>; rel="next", <https://...>; rel="last"`
   */
  private parseNextLink(linkHeader: string | undefined): string | undefined {
    if (!linkHeader) return undefined;
    const match = linkHeader.match(/<([^>]+)>\s*;\s*rel="next"/);
    return match?.[1] ?? undefined;
  }

  /**
   * Create a pull request on GitHub.
   */
  async createPullRequest(input: {
    repo: string;
    title: string;
    head: string;
    base: string;
    body?: string;
    draft?: boolean;
    maintainerCanModify?: boolean;
  }): Promise<PrCreated> {
    if (!REPO_PATTERN.test(input.repo)) {
      throw new Error(`Invalid repo format: "${input.repo}". Must be in "owner/name" format.`);
    }
    const { data } = await this.http.post<any>(`/repos/${input.repo}/pulls`, {
      title: input.title,
      head: input.head,
      base: input.base,
      body: input.body,
      draft: input.draft ?? false,
      maintainer_can_modify: input.maintainerCanModify ?? true,
    });
    return {
      number: data.number,
      htmlUrl: data.html_url,
      state: data.state,
    };
  }

  /**
   * List branches for a repository.
   */
  async listBranches(
    repo: string,
    opts?: { perPage?: number; page?: number },
  ): Promise<BranchInfo[]> {
    if (!REPO_PATTERN.test(repo)) {
      throw new Error(`Invalid repo format: "${repo}". Must be in "owner/name" format.`);
    }
    const { data } = await this.http.get<any[]>(`/repos/${repo}/branches`, {
      params: { per_page: opts?.perPage ?? 100, page: opts?.page ?? 1 },
    });
    return data.map((b: any) => ({
      name: b.name,
      sha: b.commit?.sha ?? '',
      protected: b.protected ?? false,
    }));
  }

  /**
   * Search for PRs by matching issue key in branch names.
   * Lists git refs/heads for each repo, filters branches containing the issue key,
   * then checks for open PRs from those branches.
   */
  /**
   * Cache of git refs per repo to avoid re-fetching for repeated keys.
   * Keyed by repo name, stores the branch ref array.
   */
  private readonly branchRefsCache = new Map<string, any[]>();

  async searchPrsByBranchName(
    issueKey: string,
    prState?: 'open' | 'closed' | 'all',
  ): Promise<Map<string, PrSearchResult[]>> {
    if (!ISSUE_KEY_PATTERN.test(issueKey)) {
      throw new Error(`Invalid issue key format: "${issueKey}"`);
    }

    const results = new Map<string, PrSearchResult[]>();
    let apiCallsMade = 0;

    for (const repo of GH_REPOS) {
      if (!REPO_PATTERN.test(repo)) {
        console.error(`Warning: invalid repo format "${repo}" — skipping`);
        continue;
      }

      try {
        // Fetch git refs (from cache if available)
        let refsData: any[];
        if (this.branchRefsCache.has(repo)) {
          refsData = this.branchRefsCache.get(repo)!;
        } else {
          if (apiCallsMade >= MAX_BRANCH_SEARCH_CALLS) break;
          let page = 1;
          refsData = [];
          while (apiCallsMade < MAX_BRANCH_SEARCH_CALLS) {
            const response = await this.http.get<any[]>(`/repos/${repo}/git/refs/heads`, {
              params: { per_page: 100, page },
            });
            apiCallsMade++;
            if (response.data.length === 0) break;
            refsData.push(...response.data);
            page++;
          }
          this.branchRefsCache.set(repo, refsData);
        }

        // Filter branches containing issue key (case-insensitive)
        const matchingBranches = refsData.filter((ref: any) =>
          ref.ref?.toUpperCase().includes(issueKey.toUpperCase()),
        );

        if (matchingBranches.length === 0) continue;

        const owner = repo.split('/')[0];

        // Check all matching branches concurrently
        const branchResults = await Promise.allSettled(
          matchingBranches.map(async (branch) => {
            if (apiCallsMade >= MAX_BRANCH_SEARCH_CALLS) return [];

            const branchName = branch.ref.replace('refs/heads/', '');

            const effectiveState = prState ?? 'open';
            const params: Record<string, unknown> = { head: `${owner}:${branchName}` };
            if (effectiveState !== 'all') {
              params.state = effectiveState;
            }

            const prResponse = await this.http.get<any[]>(`/repos/${repo}/pulls`, {
              params,
            });
            apiCallsMade++;

            return prResponse.data.map((pr: any) => this.parseItems([pr])[0]);
          }),
        );

        for (const result of branchResults) {
          if (result.status === 'fulfilled') {
            for (const parsed of result.value) {
              const existing = results.get(issueKey) ?? [];
              existing.push(parsed);
              results.set(issueKey, existing);
            }
          }
        }
      } catch (err) {
        console.error(`Warning: branch search failed for ${repo}`);
      }
    }

    // Attach review status
    for (const [, prs] of results) {
      const statuses = await Promise.allSettled(
        prs.map(async (pr) => {
          const rs = await this.getReviewStatus(pr.repo, pr.number);
          return { htmlUrl: pr.htmlUrl, reviewStatus: rs };
        }),
      );
      const statusMap = new Map<string, PrInfo['reviewStatus']>();
      for (const s of statuses) {
        if (s.status === 'fulfilled') statusMap.set(s.value.htmlUrl, s.value.reviewStatus);
      }
      for (const pr of prs) {
        pr.reviewStatus = statusMap.get(pr.htmlUrl) ?? 'REVIEW_REQUIRED';
      }
    }

    return results;
  }

  async getPullRequest(repo: string, prNumber: number): Promise<PullRequestDetail> {
    if (!REPO_PATTERN.test(repo)) {
      throw new Error(`Invalid repo format: "${repo}". Must be in "owner/name" format.`);
    }
    const { data } = await this.http.get<any>(`/repos/${repo}/pulls/${prNumber}`);
    const state: PullRequestDetail['state'] =
      data.state === 'closed' && data.merged_at ? 'merged' : data.state;
    return {
      number: data.number,
      title: data.title,
      body: data.body ?? null,
      state,
      htmlUrl: data.html_url,
      repo,
      author: data.user?.login ?? 'unknown',
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      closedAt: data.closed_at ?? null,
      mergedAt: data.merged_at ?? null,
      mergeable: data.mergeable ?? null,
      mergedBy: data.merged_by?.login ?? null,
      baseBranch: data.base?.ref ?? '',
      headBranch: data.head?.ref ?? '',
      headSha: data.head?.sha ?? '',
      changedFiles: data.changed_files ?? 0,
      additions: data.additions ?? 0,
      deletions: data.deletions ?? 0,
    };
  }

  async getPullRequestReviews(repo: string, prNumber: number): Promise<PullRequestReview[]> {
    if (!REPO_PATTERN.test(repo)) {
      throw new Error(`Invalid repo format: "${repo}". Must be in "owner/name" format.`);
    }
    const { data } = await this.http.get<any[]>(`/repos/${repo}/pulls/${prNumber}/reviews`);
    return data.map((review: any) => ({
      id: review.id,
      user: review.user?.login ?? 'unknown',
      state: review.state,
      body: review.body ?? null,
      submittedAt: review.submitted_at,
      commitId: review.commit_id,
    }));
  }

  async getPullRequestChecks(repo: string, prNumber: number): Promise<PullRequestChecks> {
    const prDetail = await this.getPullRequest(repo, prNumber);
    const allCheckRuns: any[] = [];
    let nextUrl: string | undefined = `/repos/${repo}/commits/${prDetail.headSha}/check-runs`;
    let pages = 0;
    const maxPages = 5;

    while (nextUrl && pages < maxPages) {
      const response = await this.http.get<any>(nextUrl, {
        params: pages === 0 ? { per_page: 100 } : undefined,
      });
      allCheckRuns.push(...(response.data.check_runs ?? []));
      pages++;
      const linkHeader = response.headers?.['link'] as string | undefined;
      nextUrl = this.parseNextLink(linkHeader);
    }

    return {
      totalCount: allCheckRuns.length,
      checkRuns: allCheckRuns.map((cr: any) => ({
        name: cr.name,
        status: cr.status,
        conclusion: cr.conclusion ?? null,
        htmlUrl: cr.html_url ?? null,
        startedAt: cr.started_at ?? null,
        completedAt: cr.completed_at ?? null,
      })),
    };
  }

  async searchPullRequestsByQuery(opts: PrSearchOptions): Promise<PrSearchResult[]> {
    if (!opts.query && !opts.author && !opts.repo) {
      throw new Error('At least one of query, author, or repo must be provided');
    }
    if (opts.repo && !REPO_PATTERN.test(opts.repo)) {
      throw new Error(`Invalid repo format: "${opts.repo}". Must be in "owner/name" format.`);
    }
    const parts: string[] = ['type:pr'];
    if (opts.state && opts.state !== 'all') {
      parts.push(`state:${opts.state}`);
    }
    if (opts.repo) {
      parts.push(`repo:${opts.repo}`);
    }
    if (opts.author) {
      parts.push(`author:${opts.author}`);
    }
    if (opts.query) {
      parts.push(`"${opts.query.replace(/"/g, '')}"`);
    }
    const q = parts.join(' ');
    const { data } = await this.http.get<{ items: any[] }>('/search/issues', {
      params: { q, per_page: opts.perPage ?? 20, page: opts.page ?? 1 },
    });
    return this.parseItems(data.items ?? []);
  }

  private async getReviewStatus(repo: string, prNumber: number): Promise<PrInfo['reviewStatus']> {
    const reviews = await this.getPullRequestReviews(repo, prNumber);
    // Determine status: APPROVED beats everything, CHANGES_REQUESTED beats COMMENTED
    let hasChangesRequested = false;
    let hasCommented = false;
    for (const review of reviews) {
      if (review.state === 'APPROVED') return 'APPROVED';
      if (review.state === 'CHANGES_REQUESTED') hasChangesRequested = true;
      if (review.state === 'COMMENTED') hasCommented = true;
    }
    if (hasChangesRequested) return 'CHANGES_REQUESTED';
    if (hasCommented) return 'COMMENTED';
    return 'REVIEW_REQUIRED';
  }

  /** Deduplicate by html_url (same PR can't appear in two repos). */
  private deduplicate(items: PrSearchResult[]): PrSearchResult[] {
    const seen = new Set<string>();
    return items.filter((item) => {
      if (seen.has(item.htmlUrl)) return false;
      seen.add(item.htmlUrl);
      return true;
    });
  }
}

/** Turn a GitHub axios error into a concise readable message. */
export function describeGitHubError(err: unknown): string {
  if (isAxiosError(err)) {
    const status = err.response?.status;
    const data = err.response?.data as { message?: string; errors?: Array<{ message: string }> } | undefined;
    let detail = data?.message || err.message;
    if (data?.errors && data.errors.length > 0) {
      const extra = data.errors.map((e) => e.message).join('; ');
      detail += `: ${extra}`;
    }
    return `GitHub API error${status ? ` (${status})` : ''}: ${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}
