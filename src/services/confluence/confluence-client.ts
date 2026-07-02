import axios, { AxiosInstance, isAxiosError } from 'axios';
import he from 'he';
import { ConfluenceConfig, loadConfluenceConfig } from '../config.js';

const MAX_RETRIES = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ConfluenceUser {
  accountId: string;
  displayName: string;
  email?: string;
}

export interface ConfluenceSpace {
  id: string;
  key: string;
  name: string;
  type: string;
  url?: string;
}

export interface ConfluenceSearchResult {
  id: string;
  title: string;
  type: string;
  spaceKey?: string;
  spaceName?: string;
  excerpt?: string;
  url?: string;
  lastModified?: string;
}

export interface ConfluencePage {
  id: string;
  title: string;
  type: string;
  status?: string;
  spaceKey?: string;
  spaceName?: string;
  version?: number;
  url?: string;
  /** Body rendered to plain text (storage XHTML stripped) for token economy. */
  body?: string;
  /** Raw Confluence storage-format XHTML — only present when explicitly requested. */
  bodyStorage?: string;
}

export interface Paged<T> {
  results: T[];
  start: number;
  limit: number;
  size: number;
  totalSize?: number;
  hasMore: boolean;
}

/**
 * Minimal typed client over the Confluence Cloud REST API (v1, under /wiki/rest/api).
 * Auth is HTTP Basic with <email>:<api-token> — the same Atlassian Cloud credentials
 * as Jira. v1 is used throughout because CQL search has no v2 equivalent and v1 accepts
 * a space key directly (no numeric space-id resolution).
 */
export class ConfluenceClient {
  private readonly http: AxiosInstance;
  /** Confluence root (e.g. https://site.atlassian.net/wiki) — for resolving relative _links.webui. */
  private readonly siteBase: string;

  constructor(config: ConfluenceConfig = loadConfluenceConfig()) {
    this.siteBase = config.baseUrl;
    this.http = axios.create({
      baseURL: `${config.baseUrl}/rest/api`,
      auth: { username: config.email, password: config.token },
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      timeout: 30_000,
    });
    this.installRetry();
  }

  /** Retry transient failures: 429 (honor Retry-After) and 5xx / timeouts, with backoff. */
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

  private absoluteUrl(webui?: string): string | undefined {
    if (!webui) return undefined;
    return webui.startsWith('http') ? webui : `${this.siteBase}${webui}`;
  }

  /** Current authenticated user — the simplest way to verify credentials. */
  async whoami(): Promise<ConfluenceUser> {
    const { data } = await this.http.get<any>('/user/current');
    return { accountId: data.accountId, displayName: data.displayName, email: data.email };
  }

  /**
   * Search content with a CQL query (e.g. `type = page AND text ~ "approval"`).
   * Pagination is offset-based (start/limit); `hasMore` reflects the presence of a next link.
   */
  async search(cql: string, opts: { limit?: number; start?: number } = {}): Promise<Paged<ConfluenceSearchResult>> {
    const { data } = await this.http.get<any>('/search', {
      params: { cql, limit: opts.limit ?? 25, start: opts.start ?? 0 },
    });
    const results: ConfluenceSearchResult[] = (data.results ?? []).map((r: any) => this.toSearchResult(r));
    return {
      results,
      start: data.start ?? opts.start ?? 0,
      limit: data.limit ?? opts.limit ?? 25,
      size: data.size ?? results.length,
      totalSize: data.totalSize,
      hasMore: !!data._links?.next,
    };
  }

  private toSearchResult(r: any): ConfluenceSearchResult {
    const content = r.content ?? {};
    return {
      id: content.id ?? r.id,
      title: r.title ?? content.title,
      type: content.type ?? r.entityType ?? 'unknown',
      spaceKey: spaceKeyFromDisplayUrl(r.resultGlobalContainer?.displayUrl),
      spaceName: r.resultGlobalContainer?.title,
      excerpt: cleanExcerpt(r.excerpt),
      url: this.absoluteUrl(r.url ?? content._links?.webui),
      lastModified: r.lastModified,
    };
  }

  /** Fetch a page/content by its ID, including body (storage), version, and space. */
  async getPageById(id: string, opts: { includeStorage?: boolean } = {}): Promise<ConfluencePage> {
    const { data } = await this.http.get<any>(`/content/${encodeURIComponent(id)}`, {
      params: { expand: 'body.storage,version,space' },
    });
    return this.toPage(data, opts.includeStorage);
  }

  /** Fetch a single page by exact title within a space. Returns null if none matches. */
  async getPageByTitle(
    spaceKey: string,
    title: string,
    opts: { includeStorage?: boolean } = {},
  ): Promise<ConfluencePage | null> {
    const { data } = await this.http.get<any>('/content', {
      params: { spaceKey, title, expand: 'body.storage,version,space', limit: 1 },
    });
    const first = data.results?.[0];
    return first ? this.toPage(first, opts.includeStorage) : null;
  }

  private toPage(data: any, includeStorage?: boolean): ConfluencePage {
    const storage = data.body?.storage?.value as string | undefined;
    return {
      id: data.id,
      title: data.title,
      type: data.type,
      status: data.status,
      spaceKey: data.space?.key,
      spaceName: data.space?.name,
      version: data.version?.number,
      url: this.absoluteUrl(data._links?.webui),
      body: storage !== undefined ? storageToText(storage) : undefined,
      ...(includeStorage && storage !== undefined ? { bodyStorage: storage } : {}),
    };
  }

  /** List spaces (offset-based pagination). Optionally filter by type or specific keys. */
  async listSpaces(
    opts: { limit?: number; start?: number; type?: string; keys?: string[] } = {},
  ): Promise<Paged<ConfluenceSpace>> {
    const params: Record<string, unknown> = { limit: opts.limit ?? 25, start: opts.start ?? 0 };
    if (opts.type) params.type = opts.type;
    if (opts.keys?.length) params.spaceKey = opts.keys;
    const { data } = await this.http.get<any>('/space', { params });
    const results: ConfluenceSpace[] = (data.results ?? []).map((s: any) => ({
      id: String(s.id),
      key: s.key,
      name: s.name,
      type: s.type,
      url: this.absoluteUrl(s._links?.webui),
    }));
    return {
      results,
      start: data.start ?? opts.start ?? 0,
      limit: data.limit ?? opts.limit ?? 25,
      size: data.size ?? results.length,
      hasMore: !!data._links?.next,
    };
  }
}

/** `/spaces/STD` (or `/spaces/STD/...`) → "STD". */
function spaceKeyFromDisplayUrl(displayUrl?: string): string | undefined {
  if (!displayUrl) return undefined;
  const match = displayUrl.match(/\/spaces\/([^/]+)/);
  return match ? match[1] : undefined;
}

/** Confluence search excerpts wrap matches in @@@hl@@@…@@@endhl@@@ markers — strip, decode, collapse. */
function cleanExcerpt(excerpt?: string): string | undefined {
  if (!excerpt) return undefined;
  const cleaned = he.decode(excerpt.replace(/@@@(end)?hl@@@/g, '')).replace(/\s+/g, ' ').trim();
  return cleaned || undefined;
}

/** Strip Confluence storage-format XHTML to readable plain text (token economy). */
export function storageToText(html: string): string {
  if (!html) return '';
  const stripped = html
    .replace(/<ac:parameter\b[^>]*>[\s\S]*?<\/ac:parameter>/gi, '')
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|h[1-6]|li|tr|table|ul|ol|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return he
    .decode(stripped)
    .replace(/\u00A0/g, ' ') // he decodes &nbsp; to U+00A0; normalize to a plain space for text output
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/** Turn an axios error into a concise, readable message (status + Confluence error body). */
export function describeConfluenceError(err: unknown): string {
  if (isAxiosError(err)) {
    const status = err.response?.status;
    const data = err.response?.data as { message?: string } | undefined;
    const detail = data?.message || err.message;
    return `Confluence API error${status ? ` (${status})` : ''}: ${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}
