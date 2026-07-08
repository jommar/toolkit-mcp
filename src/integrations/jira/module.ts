import { z } from 'zod';
import { JiraClient, toSlimIssue } from '../../services/index.js';
import type { SlimIssue, SearchResult, JiraIssue } from '../../services/index.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { paginated, zodToJsonSchema } from '../helpers.js';

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------
export const jiraWhoamiSchema = z.object({}).describe('Empty — no parameters required.');

export const jiraGetIssuesSchema = z.object({
  key: z
    .string()
    .max(20)
    .optional()
    .describe('Issue key (e.g., "TRIPS-1267") for a single issue.'),
  jql: z
    .string()
    .max(4096)
    .optional()
    .describe('JQL query string for searching issues.'),
  limit: z.number().optional().default(20).describe('Maximum items per page (default 20).'),
  cursor: z.string().optional().describe('Opaque pagination token from a previous response.'),
  fields: z.array(z.string()).optional().describe('Subset of fields to return (e.g., ["key","status"]).'),
});

export const jiraCreateIssueSchema = z.object({
  projectKey: z.string().max(20).describe('Project key (e.g., "TRIPS").'),
  issueType: z
    .string()
    .max(50)
    .describe('Issue type name (e.g., "Bug", "Task").'),
  summary: z.string().max(255).describe('Issue summary / title.'),
  description: z
    .string()
    .max(65536)
    .optional()
    .describe('Plain-text description.'),
  fields: z
    .record(z.unknown())
    .optional()
    .describe(
      'Additional Jira fields to set. SECURITY: accepts arbitrary key-value pairs; validate inputs before passing user-supplied data.',
    ),
});

export const jiraUpdateIssueSchema = z.object({
  key: z.string().max(20).describe('Issue key to update.'),
  fields: z
    .record(z.unknown())
    .describe(
      'Fields to update (e.g., {"summary": "New title"}). SECURITY: accepts arbitrary key-value pairs; validate inputs before passing user-supplied data.',
    ),
});

export const jiraTransitionIssueSchema = z
  .object({
    key: z.string().max(20).describe('Issue key to transition.'),
    transitionId: z
      .string()
      .max(20)
      .optional()
      .describe('Transition ID from listTransitions.'),
    transitionName: z
      .string()
      .max(100)
      .optional()
      .describe('Transition name (e.g., "In Progress").'),
    comment: z.string().max(65536).optional().describe('Optional comment to add during transition.'),
  })
  .refine((data) => data.transitionId || data.transitionName, {
    message: 'Provide either transitionId or transitionName',
  });

export const jiraAssignIssueSchema = z.object({
  key: z.string().max(20).describe('Issue key to assign.'),
  assignee: z
    .string()
    .max(256)
    .optional()
    .default('me')
    .describe('AccountId, "me", or "none" (default "me").'),
});

export const jiraAddCommentSchema = z.object({
  key: z.string().max(20).describe('Issue key to comment on.'),
  body: z.string().max(65536).describe('Comment body (plain text).'),
});

export const jiraUpdateCommentSchema = z.object({
  key: z.string().max(20).describe('Issue key the comment belongs to.'),
  commentId: z.string().max(30).describe('ID of the comment to update.'),
  body: z.string().max(65536).describe('New comment body (plain text) — replaces the existing content.'),
});

export const jiraLinkIssuesSchema = z.object({
  inwardKey: z.string().max(20).describe('The inward ("from") issue key.'),
  outwardKey: z.string().max(20).describe('The outward ("to") issue key.'),
  type: z.string().max(100).describe('Link type name (e.g., "Blocks", "Relates").'),
  comment: z.string().max(65536).optional().describe('Optional comment for the link.'),
});

export const jiraGetAttachmentSchema = z.object({
  attachmentId: z
    .string()
    .max(20)
    .describe('Attachment ID (e.g., "39824") from the attachment list returned in jira_get_issues.'),
  issueKey: z
    .string()
    .max(20)
    .optional()
    .describe('Issue key for context (e.g., "TRIPS-1260").'),
});

// ---------------------------------------------------------------------------
// Inferred types for prompt schemas
// ---------------------------------------------------------------------------
export const jiraCreateIssuePromptSchema = z.object({
  projectKey: z.string().min(1).max(20).describe('Project key.'),
  issueType: z.string().min(1).max(50).describe('Issue type.'),
  summary: z.string().min(1).max(255).describe('Issue summary.'),
  description: z.string().max(65536).optional().describe('Issue description.'),
  priority: z.string().max(50).optional().describe('Issue priority.'),
  labels: z.array(z.string().max(100)).optional().describe('Issue labels.'),
});

export const jiraTriageIssuePromptSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(20)
    .regex(/^[A-Z][A-Z0-9]*-\d+$/, 'Invalid issue key format')
    .describe('Issue key to triage.'),
});

// ---------------------------------------------------------------------------
// Handler Factories
// ---------------------------------------------------------------------------
type ToolHandler<T = unknown> = (
  clients: { jira: JiraClient },
) => (args: T) => Promise<{
  content: (
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
    | { type: 'audio'; data: string; mimeType: string }
  )[];
}>;

export const jiraWhoamiHandler: ToolHandler<z.infer<typeof jiraWhoamiSchema>> =
  (_clients) => async (_args) => {
    const user = await _clients.jira.whoami();
    return { content: [{ type: 'text', text: JSON.stringify(user) }] };
  };

export const jiraGetIssuesHandler: ToolHandler<z.infer<typeof jiraGetIssuesSchema>> =
  (_clients) => async (args) => {
    const { key, jql, limit, cursor, fields } = args;

    if (key) {
      if (fields) {
        const issue = await _clients.jira.getIssue(key, fields);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(paginated([issue])),
            },
          ],
        };
      }
      const issue = await _clients.jira.getIssueSlim(key);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(paginated([issue])),
          },
        ],
      };
    }

    if (jql) {
      const searchOpts: { maxResults: number; nextPageToken?: string; fields?: string[] } = {
        maxResults: limit,
        nextPageToken: cursor,
      };
      if (fields) {
        searchOpts.fields = fields;
      }
      const result: SearchResult = await _clients.jira.search(jql, searchOpts);
      const items: SlimIssue[] = result.issues.map(toSlimIssue);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(paginated(items, result.nextPageToken)),
          },
        ],
      };
    }

    throw new McpError(ErrorCode.InvalidParams, 'Provide either key or jql');
  };

export const jiraCreateIssueHandler: ToolHandler<z.infer<typeof jiraCreateIssueSchema>> =
  (_clients) => async (args) => {
    const { projectKey, issueType, summary, description, fields } = args;
    const issue = await _clients.jira.createIssue({
      projectKey,
      issueType,
      summary,
      description,
      fields,
    });
    return { content: [{ type: 'text', text: JSON.stringify(issue) }] };
  };

export const jiraUpdateIssueHandler: ToolHandler<z.infer<typeof jiraUpdateIssueSchema>> =
  (_clients) => async (args) => {
    await _clients.jira.updateIssue(args.key, args.fields);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, key: args.key }) }] };
  };

export const jiraTransitionIssueHandler: ToolHandler<z.infer<typeof jiraTransitionIssueSchema>> =
  (_clients) => async (args) => {
    let transitionId = args.transitionId;

    if (!transitionId && args.transitionName) {
      const transitions = await _clients.jira.listTransitions(args.key);
      const match = transitions.find(
        (t) => t.name.toLowerCase() === args.transitionName!.toLowerCase(),
      );
      if (!match) {
        const available = transitions.map((t) => t.name).join(', ');
        throw new McpError(
          ErrorCode.InvalidParams,
          `Transition "${args.transitionName}" not found. Available: ${available}`,
        );
      }
      transitionId = match.id;
    }

    // transitionId is guaranteed by refiner, but keep fallback for safety
    if (!transitionId) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Provide either transitionId or transitionName',
      );
    }

    await _clients.jira.transitionIssue(args.key, transitionId, {
      comment: args.comment,
    });
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, key: args.key, transitionId }) }] };
  };

export const jiraAssignIssueHandler: ToolHandler<z.infer<typeof jiraAssignIssueSchema>> =
  (_clients) => async (args) => {
    const { key, assignee } = args;

    if (assignee === 'me') {
      const user = await _clients.jira.assignToMe(key);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, key, assignee: user.displayName }) }] };
    }

    if (assignee === 'none') {
      await _clients.jira.assignIssue(key, null);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, key, assignee: null }) }] };
    }

    await _clients.jira.assignIssue(key, assignee!);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, key, assignee }) }] };
  };

export const jiraAddCommentHandler: ToolHandler<z.infer<typeof jiraAddCommentSchema>> =
  (_clients) => async (args) => {
    const comment = await _clients.jira.addComment(args.key, args.body);
    return { content: [{ type: 'text', text: JSON.stringify(comment) }] };
  };

export const jiraUpdateCommentHandler: ToolHandler<z.infer<typeof jiraUpdateCommentSchema>> =
  (_clients) => async (args) => {
    const comment = await _clients.jira.updateComment(args.key, args.commentId, args.body);
    return { content: [{ type: 'text', text: JSON.stringify(comment) }] };
  };

export const jiraGetAttachmentHandler: ToolHandler<z.infer<typeof jiraGetAttachmentSchema>> =
  (_clients) => async (args) => {
    const result = await _clients.jira.getAttachmentContent(args.attachmentId);

    // For images, return native MCP image content so clients render directly.
    if (result.mimeType.startsWith('image/')) {
      return {
        content: [
          { type: 'image', data: result.contentBase64, mimeType: result.mimeType },
          {
            type: 'text',
            text: JSON.stringify({
              id: result.id,
              filename: result.filename,
              mimeType: result.mimeType,
              size: result.size,
              issueKey: args.issueKey ?? null,
            }),
          },
        ],
      };
    }

    // For non-image attachments, return metadata as text. LLM can decide
    // how to handle the file (text previews, save to disk via shell, etc.).
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            id: result.id,
            filename: result.filename,
            mimeType: result.mimeType,
            size: result.size,
            issueKey: args.issueKey ?? null,
            contentBase64: result.contentBase64,
          }),
        },
      ],
    };
  };

export const jiraLinkIssuesHandler: ToolHandler<z.infer<typeof jiraLinkIssuesSchema>> =
  (_clients) => async (args) => {
    const { inwardKey, outwardKey, type, comment } = args;

    // Validate link type exists
    const linkTypes = await _clients.jira.listIssueLinkTypes();
    const match = linkTypes.find((lt) => lt.name.toLowerCase() === type.toLowerCase());
    if (!match) {
      const available = linkTypes.map((lt) => lt.name).join(', ');
      throw new McpError(
        ErrorCode.InvalidParams,
        `Link type "${type}" not found. Available: ${available}`,
      );
    }

    await _clients.jira.linkIssues({
      type: match.name,
      inwardKey,
      outwardKey,
      comment,
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            type: match.name,
            inwardKey,
            outwardKey,
          }),
        },
      ],
    };
  };

/** All tool descriptors for the ListToolsRequestSchema response. */
export const jiraToolDescriptors = [
  {
    name: 'jira_whoami',
    description: 'Return the authenticated Jira user profile.',
    inputSchema: zodToJsonSchema(jiraWhoamiSchema),
  },
  {
    name: 'jira_get_issues',
    description: 'Fetch one or more Jira issues. Pass `key` for a single issue, or `jql` to search.',
    inputSchema: zodToJsonSchema(jiraGetIssuesSchema),
  },
  {
    name: 'jira_create_issue',
    description: 'Create a new Jira issue in a project.',
    inputSchema: zodToJsonSchema(jiraCreateIssueSchema),
  },
  {
    name: 'jira_update_issue',
    description: 'Update fields on an existing Jira issue.',
    inputSchema: zodToJsonSchema(jiraUpdateIssueSchema),
  },
  {
    name: 'jira_transition_issue',
    description: 'Transition a Jira issue to a new status.',
    inputSchema: zodToJsonSchema(jiraTransitionIssueSchema),
  },
  {
    name: 'jira_assign_issue',
    description: 'Assign a Jira issue to a user or unassign it.',
    inputSchema: zodToJsonSchema(jiraAssignIssueSchema),
  },
  {
    name: 'jira_add_comment',
    description: 'Add a comment to a Jira issue.',
    inputSchema: zodToJsonSchema(jiraAddCommentSchema),
  },
  {
    name: 'jira_update_comment',
    description: 'Update an existing comment on a Jira issue.',
    inputSchema: zodToJsonSchema(jiraUpdateCommentSchema),
  },
  {
    name: 'jira_link_issues',
    description: 'Link two Jira issues together.',
    inputSchema: zodToJsonSchema(jiraLinkIssuesSchema),
  },
  {
    name: 'jira_get_attachment',
    description: 'Download a Jira attachment by ID and return it as base64 + data URI.',
    inputSchema: zodToJsonSchema(jiraGetAttachmentSchema),
  },
];
