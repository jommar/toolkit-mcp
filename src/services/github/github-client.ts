import axios, { AxiosInstance, isAxiosError } from 'axios';
import { installRetry } from '../http-retry.js';

const MAX_BRANCH_SEARCH_CALLS = 20;
/** Regex for validating repo "owner/name" format. */
const REPO_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
/** Regex for validating Jira issue keys (e.g. TRIPS-1234). */
export const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]{0,10}-\d{1,6}$/i;

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

export interface PrComment {
  id: number;
  htmlUrl: string;
  body: string;
  user: string;
  createdAt: string;
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
  draft: boolean;
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
  requestedReviewers: string[];
  requestedTeams: string[];
  labels: string[];
  assignees: string[];
}

export interface PullRequestReview {
  id: number;
  user: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'PENDING' | 'DISMISSED';
  body: string | null;
  submittedAt: string;
  commitId: string;
}

export interface PrReviewComment {
  id: number;
  path: string;
  line: number;
  startLine: number | null;
  body: string;
  commitId: string;
  side: 'LEFT' | 'RIGHT';
  startSide: 'LEFT' | 'RIGHT' | null;
  author: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  inReplyToId: number | null;
  originalLine: number | null;
  originalStartLine: number | null;
}

export interface CreateReviewCommentInput {
  path: string;
  body: string;
  commitId?: string;
  line: number;
  startLine?: number;
  side?: 'LEFT' | 'RIGHT';
  startSide?: 'LEFT' | 'RIGHT';
  inReplyTo?: number;
}

export interface PrReviewSubmitted {
  id: number;
  state: string;
  body: string | null;
  commitId: string;
  htmlUrl: string;
}

export type PrReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

export interface SubmitPrReviewInput {
  body?: string;
  event: PrReviewEvent;
  comments?: CreateReviewCommentInput[];
  commitId?: string;
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

export interface PrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previous_filename?: string;
  truncated?: boolean;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line?: number;
  originalLine?: number;
}

export interface MergeResult {
  merged: boolean;
  message: string;
  sha: string;
}

export interface PrSearchOptions {
  query?: string;
  author?: string;
  repo?: string;
  state?: 'open' | 'closed' | 'all';
  perPage?: number;
  page?: number;
  label?: string;
  reviewRequested?: string;
  base?: string;
}

/**
 * Minimal client over the GitHub REST API for finding PRs related to Jira issues.
 * Auth is Bearer token from GH_TOKEN env var.
 */
export class GitHubClient {
  private readonly http: AxiosInstance;
  private readonly ghRepos: string[];

  constructor() {
    const token = process.env.GH_TOKEN?.trim();
    if (!token) {
      throw new Error(
        'GH_TOKEN env var is required. Create one at https://github.com/settings/tokens and add it to .env',
      );
    }

    // GH_REPOS evaluated at construction time, not module load time
    const env = process.env.GH_REPOS?.trim();
    this.ghRepos = env ? env.split(',').map((s) => s.trim()).filter(Boolean) : ['TransActComm/TravelTracker', 'TransActComm/Portage-backend', 'TransActComm/Portage-frontend'];

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
    installRetry(this.http);
  }

  private assertRepo(repo: string): void {
    if (!REPO_PATTERN.test(repo)) {
      throw new Error(`Invalid repo format: "${repo}". Must be in "owner/name" format.`);
    }
    const segments = repo.split('/');
    for (const seg of segments) {
      if (seg === '.' || seg === '..') {
        throw new Error(`Invalid repo format: "${repo}". Must be in "owner/name" format.`);
      }
    }
  }

  private deriveState(state: string, mergedAt: unknown): PullRequestDetail['state'] {
    return (state === 'closed' && mergedAt ? 'merged' : state) as PullRequestDetail['state'];
  }

  private mapPullRequestDetail(data: any, repo: string): PullRequestDetail {
    return {
      number: data.number,
      title: data.title,
      body: data.body ?? null,
      state: this.deriveState(data.state, data.merged_at),
      draft: data.draft ?? false,
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
      requestedReviewers: data.requested_reviewers?.map((r: any) => r.login) ?? [],
      requestedTeams: data.requested_teams?.map((t: any) => t.slug) ?? [],
      labels: data.labels?.map((l: any) => l.name) ?? [],
      assignees: data.assignees?.map((a: any) => a.login) ?? [],
    };
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const { data } = await this.http.post<any>('/graphql', { query, variables });
    if (Array.isArray(data?.errors) && data.errors.length > 0) {
      const messages = data.errors.map((e: any) => e.message).join('; ');
      throw new Error(`GitHub GraphQL error: ${messages}`);
    }
    return data.data as T;
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
      this.ghRepos.map(async (repo) => {
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
      console.error(`Warning: supports up to 20 keys; ${keys.length - 20} key(s) skipped.`);
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
      state: this.deriveState(item.state, item.pull_request?.merged_at),
      repo: this.extractRepo(item.repository_url),
      author: item.user?.login ?? 'unknown',
      createdAt: item.created_at,
      htmlUrl: item.html_url,
      reviewStatus: 'REVIEW_REQUIRED',
    }));
  }

  /** Parse pull request items from the `/pulls` endpoint (which lacks repository_url
   *  and has merged_at at top level, not inside pull_request). */
  private parsePulls(items: any[], repo: string): PrSearchResult[] {
    return items.map((item) => ({
      number: item.number,
      title: item.title,
      state: this.deriveState(item.state, item.merged_at),
      repo,
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
  ): Promise<{ items: T[]; linkHeader?: string; hasMore: boolean }> {
    const allItems: T[] = [];
    let nextUrl: string | undefined = url;
    let pages = 0;
    let lastLinkHeader: string | undefined;

    while (nextUrl && pages < maxPages) {
      const response = await this.http.get<{ total_count?: number; items: T[] }>(nextUrl, {
        params: nextUrl === url ? params : undefined, // params only on first request
      });
      allItems.push(...(response.data.items ?? []));
      pages++;

      lastLinkHeader = response.headers?.['link'] as string | undefined;
      nextUrl = this.parseNextLink(lastLinkHeader);
    }

    return { items: allItems, linkHeader: lastLinkHeader, hasMore: !!nextUrl };
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
    this.assertRepo(input.repo);
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
   * Add an issue-level comment to a pull request.
   * PR conversation comments use the issues comments endpoint — the PR number
   * is the issue number.
   */
  async addPrComment(input: { repo: string; prNumber: number; body: string }): Promise<PrComment> {
    this.assertRepo(input.repo);
    const { data } = await this.http.post<any>(`/repos/${input.repo}/issues/${input.prNumber}/comments`, {
      body: input.body,
    });
    return {
      id: data.id,
      htmlUrl: data.html_url,
      body: data.body,
      user: data.user?.login ?? 'unknown',
      createdAt: data.created_at,
    };
  }

  /**
   * List issue-level (conversation) comments on a pull request.
   * PRs are issues on GitHub, so this uses the issues comments endpoint.
   */
  async getPrComments(
    repo: string,
    prNumber: number,
    opts?: { perPage?: number; page?: number },
  ): Promise<PrComment[]> {
    this.assertRepo(repo);
    const { data } = await this.http.get<any[]>(`/repos/${repo}/issues/${prNumber}/comments`, {
      params: { per_page: opts?.perPage ?? 100, page: opts?.page ?? 1 },
    });
    return data.map((c: any) => ({
      id: c.id,
      htmlUrl: c.html_url,
      body: c.body ?? '',
      user: c.user?.login ?? 'unknown',
      createdAt: c.created_at,
    }));
  }

  /**
   * Update an existing issue-level comment on a pull request by comment ID.
   */
  async updatePrComment(repo: string, commentId: number, body: string): Promise<PrComment> {
    this.assertRepo(repo);
    const { data } = await this.http.patch<any>(`/repos/${repo}/issues/comments/${commentId}`, {
      body,
    });
    return {
      id: data.id,
      htmlUrl: data.html_url,
      body: data.body,
      user: data.user?.login ?? 'unknown',
      createdAt: data.created_at,
    };
  }

  /**
   * List branches for a repository.
   */
  async listBranches(
    repo: string,
    opts?: { perPage?: number; page?: number },
  ): Promise<BranchInfo[]> {
    this.assertRepo(repo);
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

    for (const repo of this.ghRepos) {
        this.assertRepo(repo);

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

            return prResponse.data.map((pr: any) => this.parsePulls([pr], repo)[0]);
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
    this.assertRepo(repo);
    const { data } = await this.http.get<any>(`/repos/${repo}/pulls/${prNumber}`);
    return this.mapPullRequestDetail(data, repo);
  }

  async getPrFiles(
    repo: string,
    prNumber: number,
    opts?: { perPage?: number; page?: number },
  ): Promise<PrFile[]> {
    this.assertRepo(repo);
    const { data } = await this.http.get<any[]>(`/repos/${repo}/pulls/${prNumber}/files`, {
      params: { per_page: opts?.perPage ?? 100, page: opts?.page ?? 1 },
    });
    return data.map((f: any) => {
      const file: PrFile = {
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
      };
      if (f.patch) {
        file.patch = f.patch.length > 2000 ? f.patch.slice(0, 2000) : f.patch;
        if (f.patch.length > 2000) {
          file.truncated = true;
        }
      }
      if (f.previous_filename) {
        file.previous_filename = f.previous_filename;
      }
      return file;
    });
  }

  async getPrCommits(
    repo: string,
    prNumber: number,
    opts?: { perPage?: number; page?: number },
  ): Promise<any[]> {
    this.assertRepo(repo);
    const { data } = await this.http.get<any[]>(`/repos/${repo}/pulls/${prNumber}/commits`, {
      params: { per_page: opts?.perPage ?? 100, page: opts?.page ?? 1 },
    });
    return data.map((c: any) => ({
      sha: c.sha,
      commit: {
        message: c.commit?.message ?? '',
        author: {
          name: c.commit?.author?.name ?? '',
          email: c.commit?.author?.email ?? '',
          date: c.commit?.author?.date ?? '',
        },
      },
      author: {
        login: c.author?.login ?? '',
      },
    }));
  }

  async getFileContents(repo: string, path: string, ref?: string): Promise<{
    path: string;
    content: string;
    encoding: string;
    size: number;
    sha?: string;
    truncated: boolean;
    message?: string;
  }> {
    this.assertRepo(repo);
    const params: Record<string, string> = {};
    if (ref) params.ref = ref;
    const { data } = await this.http.get<any>(`/repos/${repo}/contents/${path}`, { params });

    if (data.size > 100_000) {
      return {
        path: data.path,
        content: '',
        encoding: data.encoding,
        size: data.size,
        sha: data.sha,
        truncated: true,
        message: `File is ${data.size} bytes, exceeds the 100KB size limit. Request a specific ref or path instead.`,
      };
    }

    return {
      path: data.path,
      content: Buffer.from(data.content, 'base64').toString('utf-8'),
      encoding: data.encoding,
      size: data.size,
      sha: data.sha,
      truncated: false,
    };
  }

  async getPullRequestReviews(repo: string, prNumber: number): Promise<PullRequestReview[]> {
    this.assertRepo(repo);
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

  /**
   * True when the PR has an APPROVED review from a human other than the PR author.
   * Bot reviews (login ending in "[bot]") and the author's own approval never count.
   */
  async isPrApprovedByHuman(repo: string, prNumber: number, authorLogin: string): Promise<boolean> {
    const reviews = await this.getPullRequestReviews(repo, prNumber);
    return reviews.some(
      (review) =>
        review.state === 'APPROVED' &&
        !review.user.endsWith('[bot]') &&
        review.user !== authorLogin,
    );
  }

  async getPullRequestChecks(repo: string, prNumber: number): Promise<PullRequestChecks> {
    this.assertRepo(repo);
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

  async updatePullRequest(
    repo: string,
    prNumber: number,
    updates: {
      title?: string;
      body?: string;
      state?: 'open' | 'closed';
      base?: string;
      maintainerCanModify?: boolean;
    },
  ): Promise<PullRequestDetail> {
    this.assertRepo(repo);
    const hasUpdate =
      updates.title !== undefined ||
      updates.body !== undefined ||
      updates.state !== undefined ||
      updates.base !== undefined ||
      updates.maintainerCanModify !== undefined;
    if (!hasUpdate) {
      throw new Error('At least one of title, body, state, base, or maintainerCanModify must be provided');
    }
    const body: Record<string, unknown> = {};
    if (updates.title !== undefined) body.title = updates.title;
    if (updates.body !== undefined) body.body = updates.body;
    if (updates.state !== undefined) body.state = updates.state;
    if (updates.base !== undefined) body.base = updates.base;
    if (updates.maintainerCanModify !== undefined) body.maintainer_can_modify = updates.maintainerCanModify;

    const { data } = await this.http.patch<any>(`/repos/${repo}/pulls/${prNumber}`, body);
    return this.mapPullRequestDetail(data, repo);
  }

  /**
   * Toggle a PR between draft and ready-for-review. The REST API only accepts `draft`
   * at creation time, so this goes through the GraphQL mutations, which need the PR's
   * node id rather than its number.
   */
  async setPullRequestDraft(repo: string, prNumber: number, draft: boolean): Promise<PullRequestDetail> {
    this.assertRepo(repo);
    const { data: pr } = await this.http.get<any>(`/repos/${repo}/pulls/${prNumber}`);
    const nodeId: string | undefined = pr.node_id;
    if (!nodeId) {
      throw new Error(`Could not resolve node id for ${repo}#${prNumber}`);
    }
    const query = draft
      ? 'mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { isDraft } } }'
      : 'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }';
    await this.graphql(query, { id: nodeId });
    return this.getPullRequest(repo, prNumber);
  }

  /**
   * List review threads for a pull request via GraphQL.
   * Paginates through all threads (100 per page).
   */
  async getReviewThreads(repo: string, prNumber: number): Promise<ReviewThread[]> {
    this.assertRepo(repo);
    const [owner, name] = repo.split('/');
    const threads: ReviewThread[] = [];
    let cursor: string | null = null;

    do {
      const result: any = await this.graphql(
        `query($owner: String!, $name: String!, $prNumber: Int!, $cursor: String) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $prNumber) {
              reviewThreads(first: 100, after: $cursor) {
                nodes { id isResolved isOutdated path line originalLine }
                pageInfo { endCursor hasNextPage }
              }
            }
          }
        }`,
        { owner, name, prNumber, cursor },
      );
      const reviewThreads: any = result.repository.pullRequest.reviewThreads;
      for (const node of reviewThreads.nodes) {
        threads.push({
          id: node.id,
          isResolved: node.isResolved,
          isOutdated: node.isOutdated,
          path: node.path,
          line: node.line ?? undefined,
          originalLine: node.originalLine ?? undefined,
        });
      }
      cursor = reviewThreads.pageInfo.hasNextPage ? reviewThreads.pageInfo.endCursor : null;
    } while (cursor);

    return threads;
  }

  /**
   * Resolve a review thread by its GraphQL node ID.
   */
  async resolveReviewThread(repo: string, threadId: string): Promise<{ isResolved: boolean }> {
    this.assertRepo(repo);
    const result = await this.graphql<any>(
      'mutation($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } } }',
      { threadId },
    );
    return result.resolveReviewThread.thread;
  }

  /**
   * Unresolve a review thread by its GraphQL node ID.
   */
  async unresolveReviewThread(repo: string, threadId: string): Promise<{ isResolved: boolean }> {
    this.assertRepo(repo);
    const result = await this.graphql<any>(
      'mutation($threadId: ID!) { unresolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } } }',
      { threadId },
    );
    return result.unresolveReviewThread.thread;
  }

  /**
   * Delete an issue-level comment by its ID.
   */
  async deletePrComment(repo: string, commentId: number): Promise<void> {
    this.assertRepo(repo);
    await this.http.delete(`/repos/${repo}/issues/comments/${commentId}`);
  }

  /**
   * Merge a pull request using the merge API.
   * Surfaces 405 (not mergeable) and 409 (sha mismatch) clearly.
   */
  async mergePr(
    repo: string,
    prNumber: number,
    opts?: { mergeMethod?: 'merge' | 'squash' | 'rebase'; sha?: string },
  ): Promise<MergeResult> {
    this.assertRepo(repo);
    try {
      const body: Record<string, unknown> = { merge_method: opts?.mergeMethod ?? 'merge' };
      if (opts?.sha) body.sha = opts.sha;
      const { data } = await this.http.put<any>(`/repos/${repo}/pulls/${prNumber}/merge`, body);
      return { merged: data.merged, message: data.message, sha: data.sha };
    } catch (err) {
      if (isAxiosError(err)) {
        const status = err.response?.status;
        if (status === 405) {
          throw new Error(`PR #${prNumber} is not mergeable. It may have conflicts or require review.`);
        }
        if (status === 409) {
          throw new Error(`SHA mismatch for PR #${prNumber}. The branch has new commits; provide an updated SHA or omit it.`);
        }
      }
      throw err;
    }
  }

  /**
   * Request reviewers for a pull request.
   */
  async requestReviewers(
    repo: string,
    prNumber: number,
    reviewers: string[],
    teamReviewers?: string[],
  ): Promise<{ requestedReviewers: string[]; requestedTeams: string[] }> {
    this.assertRepo(repo);
    const body: Record<string, unknown> = { reviewers };
    if (teamReviewers) body.team_reviewers = teamReviewers;
    const { data } = await this.http.post<any>(`/repos/${repo}/pulls/${prNumber}/requested_reviewers`, body);
    return {
      requestedReviewers: data.requested_reviewers?.map((r: any) => r.login) ?? [],
      requestedTeams: data.requested_teams?.map((t: any) => t.slug) ?? [],
    };
  }

  /**
   * Remove requested reviewers from a pull request.
   */
  async removeReviewers(
    repo: string,
    prNumber: number,
    reviewers: string[],
    teamReviewers?: string[],
  ): Promise<{ requestedReviewers: string[]; requestedTeams: string[] }> {
    this.assertRepo(repo);
    const body: Record<string, unknown> = { reviewers };
    if (teamReviewers) body.team_reviewers = teamReviewers;
    const { data } = await this.http.delete<any>(`/repos/${repo}/pulls/${prNumber}/requested_reviewers`, {
      data: body,
    });
    return {
      requestedReviewers: data.requested_reviewers?.map((r: any) => r.login) ?? [],
      requestedTeams: data.requested_teams?.map((t: any) => t.slug) ?? [],
    };
  }

  /**
   * Replace all labels on an issue/PR.
   */
  async updateLabels(repo: string, prNumber: number, labels: string[]): Promise<string[]> {
    this.assertRepo(repo);
    const { data } = await this.http.put<any>(`/repos/${repo}/issues/${prNumber}/labels`, { labels });
    return data.map((l: any) => l.name);
  }

  /**
   * Add assignees to an issue/PR (POST endpoint adds to existing assignees).
   */
  async updateAssignees(repo: string, prNumber: number, assignees: string[]): Promise<string[]> {
    this.assertRepo(repo);
    const { data } = await this.http.post<any>(`/repos/${repo}/issues/${prNumber}/assignees`, { assignees });
    return data.assignees?.map((a: any) => a.login) ?? [];
  }

  /**
   * Dismiss a pull request review.
   */
  async dismissPrReview(repo: string, prNumber: number, reviewId: number, message: string): Promise<{ success: boolean; message: string }> {
    this.assertRepo(repo);
    await this.http.put<any>(`/repos/${repo}/pulls/${prNumber}/reviews/${reviewId}/dismissals`, { message });
    return { success: true, message: 'Review dismissed' };
  }

  async searchPullRequestsByQuery(opts: PrSearchOptions): Promise<PrSearchResult[]> {
    if (!opts.query && !opts.author && !opts.repo && !opts.label && !opts.reviewRequested && !opts.base) {
      throw new Error('At least one of query, author, repo, label, reviewRequested, or base must be provided');
    }
    if (opts.repo) this.assertRepo(opts.repo);
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
    if (opts.label) {
      parts.push(`label:${opts.label}`);
    }
    if (opts.reviewRequested) {
      parts.push(`review-requested:${opts.reviewRequested}`);
    }
    if (opts.base) {
      parts.push(`base:${opts.base}`);
    }
    const q = parts.join(' ');
    const { data } = await this.http.get<{ items: any[] }>('/search/issues', {
      params: { q, per_page: opts.perPage ?? 20, page: opts.page ?? 1 },
    });
    return this.parseItems(data.items ?? []);
  }

  async createPrReviewComment(
    repo: string,
    prNumber: number,
    input: CreateReviewCommentInput,
  ): Promise<PrReviewComment> {
    this.assertRepo(repo);
    const body: Record<string, unknown> = {
      body: input.body,
      commit_id: input.commitId,
      path: input.path,
      line: input.line,
    };
    if (input.startLine !== undefined) {
      body.start_line = input.startLine;
    }
    if (input.side !== undefined) {
      body.side = input.side;
    }
    if (input.startSide !== undefined) {
      body.start_side = input.startSide;
    }
    if (input.inReplyTo !== undefined) {
      body.in_reply_to = input.inReplyTo;
    }
    const { data } = await this.http.post<any>(`/repos/${repo}/pulls/${prNumber}/comments`, body);
    return mapToPrReviewComment(data);
  }

  /**
   * Reply to an existing inline review comment, keeping the reply in the same thread.
   * Unlike createPrReviewComment this needs no path/line/commit — the parent supplies them.
   */
  async replyToPrReviewComment(
    repo: string,
    prNumber: number,
    commentId: number,
    body: string,
  ): Promise<PrReviewComment> {
    this.assertRepo(repo);
    const { data } = await this.http.post<any>(
      `/repos/${repo}/pulls/${prNumber}/comments/${commentId}/replies`,
      { body },
    );
    return mapToPrReviewComment(data);
  }

  async getPrReviewComments(
    repo: string,
    prNumber: number,
    opts?: { perPage?: number; page?: number },
  ): Promise<PrReviewComment[]> {
    this.assertRepo(repo);
    const { data } = await this.http.get<any[]>(`/repos/${repo}/pulls/${prNumber}/comments`, {
      params: { per_page: opts?.perPage ?? 100, page: opts?.page ?? 1 },
    });
    return data.map(mapToPrReviewComment);
  }

  async updatePrReviewComment(
    repo: string,
    commentId: number,
    body: string,
  ): Promise<PrReviewComment> {
    this.assertRepo(repo);
    const { data } = await this.http.patch<any>(`/repos/${repo}/pulls/comments/${commentId}`, { body });
    return mapToPrReviewComment(data);
  }

  async deletePrReviewComment(repo: string, commentId: number): Promise<void> {
    this.assertRepo(repo);
    await this.http.delete(`/repos/${repo}/pulls/comments/${commentId}`);
  }

  async submitPrReview(
    repo: string,
    prNumber: number,
    input: SubmitPrReviewInput,
  ): Promise<PrReviewSubmitted> {
    this.assertRepo(repo);
    const body: Record<string, unknown> = {
      event: input.event,
    };
    if (input.body !== undefined) {
      body.body = input.body;
    }
    if (input.commitId !== undefined) {
      body.commit_id = input.commitId;
    }
    if (input.comments !== undefined && input.comments.length > 0) {
      body.comments = input.comments.map((c) => ({
        path: c.path,
        body: c.body,
        line: c.line,
        ...(c.commitId !== undefined ? { commit_id: c.commitId } : {}),
        ...(c.startLine !== undefined ? { start_line: c.startLine } : {}),
        ...(c.side !== undefined ? { side: c.side } : {}),
        ...(c.startSide !== undefined ? { start_side: c.startSide } : {}),
      }));
    }
    const { data } = await this.http.post<any>(`/repos/${repo}/pulls/${prNumber}/reviews`, body);
    return {
      id: data.id,
      state: data.state,
      body: data.body ?? null,
      commitId: data.commit_id,
      htmlUrl: data.html_url,
    };
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

function mapToPrReviewComment(data: any): PrReviewComment {
  return {
    id: data.id,
    path: data.path,
    line: data.line,
    startLine: data.start_line ?? null,
    body: data.body,
    commitId: data.commit_id,
    side: data.side ?? 'RIGHT',
    startSide: data.start_side ?? null,
    author: data.user?.login ?? 'unknown',
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    htmlUrl: data.html_url,
    inReplyToId: data.in_reply_to_id ?? null,
    originalLine: data.original_line ?? null,
    originalStartLine: data.original_start_line ?? null,
  };
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
