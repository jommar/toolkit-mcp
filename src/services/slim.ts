import { JiraIssue } from './jira/jira-client.js';

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
  author: string | null;
  created: string | null;
  body: string | null;
}

export interface SlimAttachment {
  id: string;
  filename: string;
  author: string | null;
  created: string | null;
  size: number;
  mimeType: string;
  content: string;
  thumbnail: string | null;
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
}

/** Flatten a raw Jira issue into the compact dev shape (drops nulls/links/avatars/ADF). */
export function toSlimIssue(issue: JiraIssue): SlimIssue {
  const f = issue.fields as Record<string, any>;
  return {
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
  };
}

/** Flatten a raw Jira comment into the compact shape (author/created/text body). */
export function toSlimComment(c: any): SlimComment {
  return {
    author: c?.author?.displayName ?? null,
    created: c?.created ?? null,
    body: adfToText(c?.body),
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
    content: a.content ?? '',
    thumbnail: a?.thumbnail ?? null,
  };
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
