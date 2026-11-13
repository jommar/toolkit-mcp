import { JiraIssue, JiraUser, JiraTransition, IssueLinkType } from './jira/jira-client.js';

/**
 * The narrow set of issue fields worth fetching for day-to-day dev work.
 * Passed to the Jira API as the `fields` param so the server only returns these
 * (smaller payload), then flattened by toSlimIssue (smaller still).
 */
export const DEV_FIELDS = [
  'summary',
  'status',
  'issuetype',
  'assignee',
  'reporter',
  'priority',
  'labels',
  'created',
  'updated',
  'parent',
  'subtasks',
  'description',
  'comment',
  'attachment',
] as const;

export interface SlimComment {
  id: string;
  author: string | null;
  created: string | null;
  body: string | null;
}

/** What a comment write returns: ids, timestamps, author name and a browse link, never the body. */
export interface CommentAck {
  id: string;
  key: string;
  created: string | null;
  updated: string | null;
  author: string | null;
  url: string;
}

/** Download and thumbnail URLs are left out: `jira_get_attachment` fetches by `id`. */
export interface SlimAttachment {
  id: string;
  filename: string;
  author: string | null;
  created: string | null;
  size: number;
  mimeType: string;
}

/** A comment as `jira_get_comments` lists it: SlimComment plus `updated`, `parentId` on thread replies and the raw ADF `bodyAdf` only when asked for. */
export interface ListedComment extends SlimComment {
  updated: string | null;
  parentId?: string;
  bodyAdf?: unknown;
}

export interface SlimIssue {
  key: string;
  summary: string;
  status: string | null;
  type: string | null;
  assignee: string | null;
  reporter: string | null;
  priority: string | null;
  labels: string[];
  created: string | null;
  updated: string | null;
  parent: string | null;
  subtasks: string[];
  description: string | null;
  comments: SlimComment[];
  attachments: SlimAttachment[];
  /** Requested custom fields, keyed by their Jira field ID (e.g. story points). Absent unless asked for. */
  custom?: Record<string, unknown>;
  /** Raw ADF document exactly as Jira returned it. Absent unless asked for and the issue has a description. */
  descriptionAdf?: unknown;
}

export interface SlimIssueOptions {
  adf?: boolean;
}

/** Flatten a raw Jira issue into the compact dev shape (drops nulls/links/avatars/ADF unless `adf` is set). */
export function toSlimIssue(issue: JiraIssue, customIds?: string[], options: SlimIssueOptions = {}): SlimIssue {
  const f = issue.fields as Record<string, any>;
  const entries = (customIds ?? [])
    .map((id) => [id, f[id]] as const)
    .filter(([, v]) => v != null)
    .map(([id, v]) => [id, stripLinkBoilerplate(v)] as const);
  const slim: SlimIssue = {
    key: issue.key,
    summary: f.summary ?? '',
    status: f.status?.name ?? null,
    type: f.issuetype?.name ?? null,
    assignee: f.assignee?.displayName ?? null,
    reporter: f.reporter?.displayName ?? null,
    priority: f.priority?.name ?? null,
    labels: f.labels ?? [],
    created: f.created ?? null,
    updated: f.updated ?? null,
    parent: f.parent?.key ?? null,
    subtasks: Array.isArray(f.subtasks) ? f.subtasks.map((s: any) => s.key) : [],
    description: adfToText(f.description),
    comments: Array.isArray(f.comment?.comments) ? f.comment.comments.map(toSlimComment).reverse() : [],
    attachments: Array.isArray(f.attachment) ? f.attachment.map(toSlimAttachment) : [],
    custom: entries.length ? Object.fromEntries(entries) : undefined,
  };
  if (options.adf && f.description != null) slim.descriptionAdf = f.description;
  return slim;
}

/** Flatten a raw Jira comment into the compact shape (author/created/text body). */
export function toSlimComment(c: any): SlimComment {
  return {
    id: c?.id ?? '',
    author: c?.author?.displayName ?? null,
    created: c?.created ?? null,
    body: adfToText(c?.body),
  };
}

/** Flatten a raw Jira comment for `jira_get_comments`: the slim shape plus `updated` and `parentId` (no accountId, email, avatars or `self` URLs). */
export function toListedComment(c: any, options: SlimIssueOptions = {}): ListedComment {
  const listed: ListedComment = { ...toSlimComment(c), updated: c?.updated ?? null };
  if (c?.parentId != null) listed.parentId = String(c.parentId);
  if (options.adf && c?.body != null) listed.bodyAdf = c.body;
  return listed;
}

/** Reduce the raw comment Jira returns from a create/update to a CommentAck (no body, email, accountId, avatars or `self` URLs). */
export function toCommentAck(c: any, key: string, baseUrl: string): CommentAck {
  const id = c?.id ?? '';
  return {
    id,
    key,
    created: c?.created ?? null,
    updated: c?.updated ?? null,
    author: c?.author?.displayName ?? null,
    url: `${baseUrl}/browse/${encodeURIComponent(key)}?focusedCommentId=${encodeURIComponent(id)}`,
  };
}

/** Flatten a raw Jira attachment into the compact shape. */
export function toSlimAttachment(a: any): SlimAttachment {
  return {
    id: a.id,
    filename: a.filename,
    author: a?.author?.displayName ?? null,
    created: a?.created ?? null,
    size: a.size ?? 0,
    mimeType: a.mimeType ?? '',
  };
}

/** Reduce a raw Jira user to `{accountId, displayName}`; `active` and `emailAddress` only when Jira returned them (no avatars, `self`, locale or time zone). */
export function toSlimUser(u: any, options: { details?: boolean } = {}): JiraUser {
  const user: JiraUser = { accountId: u?.accountId ?? '', displayName: u?.displayName ?? '' };
  if (!options.details) return user;
  if (u?.active != null) user.active = u.active;
  if (u?.emailAddress) user.emailAddress = u.emailAddress;
  return user;
}

/** Reduce a raw Jira transition to `{id, name, to}`, where `to` is the destination status name (no icons, flags or `self`). */
export function toSlimTransition(t: any): JiraTransition {
  return { id: t?.id ?? '', name: t?.name ?? '', to: t?.to?.name ?? null };
}

/** Reduce a raw Jira issue link type to `{id, name, inward, outward}` (no `self`). */
export function toSlimLinkType(t: any): IssueLinkType {
  return { id: t?.id ?? '', name: t?.name ?? '', inward: t?.inward ?? '', outward: t?.outward ?? '' };
}

/** Drop the `self` and `avatarUrls` URL keys, at any depth, from a raw custom-field value; everything else is kept as Jira returned it. */
function stripLinkBoilerplate(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripLinkBoilerplate);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => k !== 'self' && k !== 'avatarUrls')
      .map(([k, v]) => [k, stripLinkBoilerplate(v)]),
  );
}

/**
 * Extract plain text from an Atlassian Document Format (ADF) node.
 * Returns null for empty/missing content. Joins block-level nodes with newlines.
 */
export function adfToText(node: unknown): string | null {
  if (node == null) return null;
  if (typeof node === 'string') return node;
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.text) return n.text;
  if (!Array.isArray(n.content)) return null;

  const parts = n.content.map(adfToText).filter((p): p is string => p != null);
  if (parts.length === 0) return null;

  // Inline containers (paragraph/heading) hold text runs — join with nothing.
  // Everything else (doc, lists, blockquote) holds block children — one line each.
  const inline = new Set(['paragraph', 'heading']);
  const sep = inline.has(n.type ?? '') ? '' : '\n';
  const text = parts.join(sep);
  return text.trim() || null;
}
