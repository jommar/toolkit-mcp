import axios, { AxiosInstance, isAxiosError } from 'axios';
import { JiraConfig, loadConfig } from '../config.js';
import { DEV_FIELDS, SlimIssue, toSlimIssue, toSlimComment } from '../slim.js';
import { installRetry } from '../http-retry.js';

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
}

export interface JiraField {
  id: string;
  name: string;
  custom: boolean;
}

export interface JiraIssue {
  id: string;
  key: string;
  fields: Record<string, unknown>;
}

export interface SearchResult {
  issues: JiraIssue[];
  /** Cursor for the next page; absent/undefined when there are no more results. */
  nextPageToken?: string;
  /** True when this is the last page. */
  isLast?: boolean;
}

export interface JiraTransition {
  id: string;
  name: string;
}

export interface JiraComment {
  id: string;
  author?: { displayName?: string };
  body?: unknown;
  created?: string;
  updated?: string;
}

export interface IssueLinkType {
  id: string;
  name: string;
  inward: string;
  outward: string;
}

/**
 * Minimal typed client over the Jira Cloud REST API (v3).
 * Auth is HTTP Basic with <email>:<api-token>, per Atlassian Cloud.
 */
export class JiraClient {
  private readonly http: AxiosInstance;

  constructor(config: JiraConfig = loadConfig()) {
    this.http = axios.create({
      baseURL: `${config.baseUrl}/rest/api/3`,
      auth: { username: config.email, password: config.token },
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      timeout: 30_000,
    });
    installRetry(this.http);
  }

  /** Current authenticated user — the simplest way to verify credentials. */
  async whoami(): Promise<JiraUser> {
    const { data } = await this.http.get<JiraUser>('/myself');
    return data;
  }

  /** All fields on the instance — use to find custom field IDs (e.g. Story Points). */
  async getFields(): Promise<JiraField[]> {
    const { data } = await this.http.get<JiraField[]>('/field');
    return data.map((f) => ({ id: f.id, name: f.name, custom: f.custom ?? false }));
  }

  /** Fetch a single issue by key (e.g. "TRIPS-1267"). */
  async getIssue(key: string, fields?: string[]): Promise<JiraIssue> {
    const { data } = await this.http.get<JiraIssue>(`/issue/${encodeURIComponent(key)}`, {
      params: fields?.length ? { fields: fields.join(',') } : undefined,
    });
    return data;
  }

  /**
   * Fetch one issue requesting only the dev fields, flattened to the compact shape.
   * The embedded comment field paginates, so if it was truncated we fetch the full
   * comment thread separately — the team relies on comments, so none are dropped.
   */
  async getIssueSlim(key: string): Promise<SlimIssue> {
    const issue = await this.getIssue(key, [...DEV_FIELDS]);
    const slim = toSlimIssue(issue);
    const cf = (issue.fields as any).comment as { total?: number; comments?: unknown[] } | undefined;
    if (cf && (cf.total ?? 0) > (cf.comments?.length ?? 0)) {
      const all = await this.getComments(key);
      slim.comments = all.map(toSlimComment);
    }
    return slim;
  }

  /** Fetch every comment on an issue, following pagination (startAt/total). */
  async getComments(key: string): Promise<JiraComment[]> {
    const out: JiraComment[] = [];
    let startAt = 0;
    for (;;) {
      const { data } = await this.http.get<{ comments: JiraComment[]; total: number }>(
        `/issue/${encodeURIComponent(key)}/comment`,
        { params: { startAt, maxResults: 100 } },
      );
      out.push(...data.comments);
      startAt += data.comments.length;
      if (data.comments.length === 0 || startAt >= data.total) break;
    }
    return out;
  }

  /** JQL search returning compact dev-shaped issues (narrow fields + flattened). */
  async searchSlim(jql: string, opts: { maxResults?: number; nextPageToken?: string } = {}): Promise<SlimIssue[]> {
    const res = await this.search(jql, { ...opts, fields: [...DEV_FIELDS] });
    return res.issues.map((issue) => toSlimIssue(issue));
  }

  /**
   * Search every page of a JQL query, following `nextPageToken` until `isLast`.
   * `max` caps the total returned (safety valve for huge result sets).
   */
  async searchAll(jql: string, opts: { fields?: string[]; pageSize?: number; max?: number } = {}): Promise<JiraIssue[]> {
    const out: JiraIssue[] = [];
    let token: string | undefined;
    for (;;) {
      const res = await this.search(jql, { fields: opts.fields, maxResults: opts.pageSize ?? 100, nextPageToken: token });
      out.push(...res.issues);
      if (opts.max && out.length >= opts.max) return out.slice(0, opts.max);
      token = res.nextPageToken;
      if (res.isLast || !token || res.issues.length === 0) break;
    }
    return out;
  }

  /** searchAll returning compact dev-shaped issues. */
  async searchAllSlim(jql: string, opts: { pageSize?: number; max?: number } = {}): Promise<SlimIssue[]> {
    const issues = await this.searchAll(jql, { ...opts, fields: [...DEV_FIELDS] });
    return issues.map((issue) => toSlimIssue(issue));
  }

  /**
   * Search issues with JQL via the enhanced /search/jql endpoint (the legacy /search
   * was removed — Atlassian CHANGE-2046). Pagination is cursor-based: pass the returned
   * `nextPageToken` to fetch the next page; `isLast` signals the end.
   */
  async search(
    jql: string,
    opts: { fields?: string[]; maxResults?: number; nextPageToken?: string } = {},
  ): Promise<SearchResult> {
    const { data } = await this.http.post<SearchResult>('/search/jql', {
      jql,
      fields: opts.fields ?? ['summary', 'status', 'assignee'],
      maxResults: opts.maxResults ?? 50,
      ...(opts.nextPageToken ? { nextPageToken: opts.nextPageToken } : {}),
    });
    return data;
  }

  /** Create an issue. `fields` is the raw Jira fields object (projectKey/issueType are convenience args). */
  async createIssue(input: {
    projectKey: string;
    issueType: string;
    summary: string;
    description?: string;
    fields?: Record<string, unknown>;
  }): Promise<JiraIssue> {
    const fields: Record<string, unknown> = {
      project: { key: input.projectKey },
      issuetype: { name: input.issueType },
      summary: input.summary,
      ...(input.description ? { description: toAdf(input.description) } : {}),
      ...input.fields,
    };
    const { data } = await this.http.post<JiraIssue>('/issue', { fields });
    return data;
  }

  /** Update arbitrary fields on an issue. Returns nothing on success (204). */
  async updateIssue(key: string, fields: Record<string, unknown>): Promise<void> {
    await this.http.put(`/issue/${encodeURIComponent(key)}`, { fields });
  }

  /** Add a plain-text comment (wrapped in Atlassian Document Format). */
  async addComment(key: string, body: string): Promise<{ id: string }> {
    const { data } = await this.http.post<{ id: string }>(
      `/issue/${encodeURIComponent(key)}/comment`,
      { body: toAdf(body) },
    );
    return data;
  }

  /** Replace an existing comment's body (plain text, wrapped in Atlassian Document Format). */
  async updateComment(key: string, commentId: string, body: string): Promise<{ id: string }> {
    const { data } = await this.http.put<{ id: string }>(
      `/issue/${encodeURIComponent(key)}/comment/${encodeURIComponent(commentId)}`,
      { body: toAdf(body) },
    );
    return data;
  }

  /** Delete a comment by issue key and comment id. Returns nothing on success (204). */
  async deleteComment(key: string, commentId: string): Promise<void> {
    await this.http.delete(`/issue/${encodeURIComponent(key)}/comment/${encodeURIComponent(commentId)}`);
  }

  /** List the transitions available from the issue's current status. */
  async listTransitions(key: string): Promise<JiraTransition[]> {
    const { data } = await this.http.get<{ transitions: JiraTransition[] }>(
      `/issue/${encodeURIComponent(key)}/transitions`,
    );
    return data.transitions;
  }

  /**
   * Move an issue to a new status by transition id (see listTransitions). Optionally
   * set fields (e.g. resolution) and/or add a comment as part of the same transition.
   */
  async transitionIssue(
    key: string,
    transitionId: string,
    opts: { comment?: string; fields?: Record<string, unknown> } = {},
  ): Promise<void> {
    const body: Record<string, unknown> = { transition: { id: transitionId } };
    if (opts.fields) body.fields = opts.fields;
    if (opts.comment) body.update = { comment: [{ add: { body: toAdf(opts.comment) } }] };
    await this.http.post(`/issue/${encodeURIComponent(key)}/transitions`, body);
  }

  /** Assign an issue to an accountId, or pass null to unassign. */
  async assignIssue(key: string, accountId: string | null): Promise<void> {
    await this.http.put(`/issue/${encodeURIComponent(key)}/assignee`, { accountId });
  }

  /** Assign an issue to the authenticated user; returns that user. */
  async assignToMe(key: string): Promise<JiraUser> {
    const me = await this.whoami();
    await this.assignIssue(key, me.accountId);
    return me;
  }

  /** Search for users by display name or email (uses GET /rest/api/3/user/search). */
  async searchUsers(query: string): Promise<JiraUser[]> {
    const { data } = await this.http.get<JiraUser[]>('/user/search', {
      params: { query },
    });
    return data;
  }

  /** List the available issue link types (name + inward/outward labels). */
  async listIssueLinkTypes(): Promise<IssueLinkType[]> {
    const { data } = await this.http.get<{ issueLinkTypes: IssueLinkType[] }>('/issueLinkType');
    return data.issueLinkTypes;
  }

  /**
   * Link two issues. `type` is a link type name (e.g. "Blocks", "Relates").
   * inwardKey is the "from" side, outwardKey the "to" side per the type's semantics
   * (e.g. type "Blocks": inward "is blocked by" outward — inwardKey blocks outwardKey).
   */
  async linkIssues(input: {
    type: string;
    inwardKey: string;
    outwardKey: string;
    comment?: string;
  }): Promise<void> {
    await this.http.post('/issueLink', {
      type: { name: input.type },
      inwardIssue: { key: input.inwardKey },
      outwardIssue: { key: input.outwardKey },
      ...(input.comment ? { comment: { body: toAdf(input.comment) } } : {}),
    });
  }

  /**
   * Download an attachment's content and return it as base64.
   * Steps: (1) fetch metadata (filename, mimeType), (2) download raw bytes.
   */
  async getAttachmentContent(
    attachmentId: string,
  ): Promise<{ id: string; filename: string; mimeType: string; size: number; contentBase64: string }> {
    // First get attachment metadata
    const { data: meta } = await this.http.get<{
      id: string;
      filename: string;
      mimeType: string;
      size: number;
    }>(`/attachment/${encodeURIComponent(attachmentId)}`);

    // Download the raw file bytes (follows redirect to CDN automatically)
    const response = await this.http.get<ArrayBuffer>(`/attachment/content/${encodeURIComponent(attachmentId)}`, {
      responseType: 'arraybuffer',
    });

    const raw = Buffer.from(response.data);
    return {
      id: meta.id,
      filename: meta.filename,
      mimeType: meta.mimeType,
      size: meta.size ?? raw.length,
      contentBase64: raw.toString('base64'),
    };
  }
}

/** Wrap a plain string as a minimal Atlassian Document Format (ADF) doc. */
function toAdf(text: string) {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

/** Turn an axios error into a concise, readable message (status + Jira error body). */
export function describeError(err: unknown): string {
  if (isAxiosError(err)) {
    const status = err.response?.status;
    const data = err.response?.data as { errorMessages?: string[]; errors?: Record<string, string> } | undefined;
    const detail =
      data?.errorMessages?.join('; ') ||
      (data?.errors && Object.entries(data.errors).map(([k, v]) => `${k}: ${v}`).join('; ')) ||
      err.message;
    return `Jira API error${status ? ` (${status})` : ''}: ${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}
