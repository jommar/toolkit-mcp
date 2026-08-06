import axios, { AxiosInstance, isAxiosError } from 'axios';
import he from 'he';
import { ConfluenceConfig, loadConfluenceConfig } from '../config.js';
import { installRetry } from '../http-retry.js';

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
    installRetry(this.http);
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

  /** Create a page. `body` must already be storage-format XHTML (see `markdownToStorage`). */
  async createPage(input: { space: string; title: string; body: string; parentId?: string }): Promise<ConfluencePage> {
    const payload: Record<string, unknown> = {
      type: 'page',
      title: input.title,
      space: { key: input.space },
      body: { storage: { value: input.body, representation: 'storage' } },
      ...(input.parentId ? { ancestors: [{ id: input.parentId }] } : {}),
    };
    const { data } = await this.http.post<any>('/content', payload);
    return this.toPage(data);
  }

  /**
   * Update a page in place. Confluence requires the version number to be incremented on
   * every update, so the current version is fetched first and bumped automatically.
   */
  async updatePage(input: { pageId: string; body: string; title?: string }): Promise<ConfluencePage> {
    const current = await this.getPageById(input.pageId);
    const payload: Record<string, unknown> = {
      id: input.pageId,
      type: 'page',
      title: input.title ?? current.title,
      version: { number: (current.version ?? 0) + 1 },
      body: { storage: { value: input.body, representation: 'storage' } },
    };
    const { data } = await this.http.put<any>(`/content/${encodeURIComponent(input.pageId)}`, payload);
    return this.toPage(data);
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

/** Escape the characters that are special in XHTML text content. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Apply a deliberately small set of inline Markdown rules to already-HTML-escaped text:
 * inline code, links, bold, italic. Order matters — code spans are protected first so
 * their contents are never re-processed by the later rules.
 */
function inlineMarkdown(text: string): string {
  const codeSpans: string[] = [];
  let out = escapeHtml(text).replace(/`([^`]+)`/g, (_m, code: string) => {
    codeSpans.push(`<code>${code}</code>`);
    return ` ${codeSpans.length - 1} `;
  });
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => `<a href="${url}">${label}</a>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(/_([^_]+)_/g, '<em>$1</em>');
  out = out.replace(/ (\d+) /g, (_m, i: string) => codeSpans[Number(i)]);
  return out;
}

/** Split a `| a | b |` table row into trimmed cell strings. */
function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

/** A table separator row, e.g. `|---|:---:|---:|`. */
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/**
 * Convert a deliberately limited subset of Markdown to Confluence storage-format XHTML:
 * headings, paragraphs, unordered/ordered lists, pipe tables, fenced code blocks, and the
 * inline rules handled by `inlineMarkdown` (bold, italic, inline code, links). This is not
 * a general Markdown parser — anything outside this subset (nested lists, blockquotes,
 * images, HTML passthrough, etc.) is passed through as plain paragraph text.
 */
export function markdownToStorage(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i++;
      continue;
    }

    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1];
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      out.push(
        '<ac:structured-macro ac:name="code">' +
          (lang ? `<ac:parameter ac:name="language">${lang}</ac:parameter>` : '') +
          `<ac:plain-text-body><![CDATA[${codeLines.join('\n')}]]></ac:plain-text-body>` +
          '</ac:structured-macro>',
      );
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${inlineMarkdown(heading[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*\|/.test(line) && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1])) {
      const headerCells = splitTableRow(line);
      i += 2; // skip header + separator row
      const bodyRows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        bodyRows.push(splitTableRow(lines[i]));
        i++;
      }
      const headerHtml = `<tr>${headerCells.map((c) => `<th>${inlineMarkdown(c)}</th>`).join('')}</tr>`;
      const bodyHtml = bodyRows
        .map((row) => `<tr>${row.map((c) => `<td>${inlineMarkdown(c)}</td>`).join('')}</tr>`)
        .join('');
      out.push(`<table><tbody>${headerHtml}${bodyHtml}</tbody></table>`);
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      out.push(`<ul>${items.map((it) => `<li>${inlineMarkdown(it)}</li>`).join('')}</ul>`);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      out.push(`<ol>${items.map((it) => `<li>${inlineMarkdown(it)}</li>`).join('')}</ol>`);
      continue;
    }

    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^```/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^\s*\|/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    out.push(`<p>${inlineMarkdown(paraLines.join(' '))}</p>`);
  }

  return out.join('');
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
