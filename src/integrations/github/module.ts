import { z } from 'zod';
import { GitHubClient, JiraClient, ISSUE_KEY_PATTERN } from '../../services/index.js';
import type { PrInfo, PullRequestDetail, PullRequestReview, PullRequestChecks, PrReviewComment, PrReviewSubmitted } from '../../services/index.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { paginated, zodToJsonSchema } from '../helpers.js';

// ---------------------------------------------------------------------------
// Shared field schemas
// ---------------------------------------------------------------------------
const repoField = z
  .string()
  .max(100)
  .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, 'Must be in "owner/name" format')
  .describe('Repository "owner/name" (e.g., "TransActComm/Portage-backend").');

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------
export const githubGetPrsSchema = z.object({
  issueKey: z
    .string()
    .max(20)
    .regex(ISSUE_KEY_PATTERN)
    .optional()
    .describe('Single issue key to search for (e.g., "TRIPS-1267").'),
  keys: z
    .array(z.string().max(20))
    .max(20)
    .optional()
    .describe('Multiple issue keys for batched search.'),
  state: z
    .enum(['open', 'closed', 'all'])
    .optional()
    .default('open')
    .describe('Filter PRs by state (default "open").'),
  limit: z.number().min(1).max(100).optional().default(20).describe('Maximum items per page (default 20).'),
  cursor: z.string().max(50).optional().describe('Opaque pagination token from a previous response.'),
  searchBranches: z
    .boolean()
    .optional()
    .default(false)
    .describe('Also search by branch name for the given issue key.'),
});

export const githubGetCopilotUnresolvedPrsSchema = z.object({
  repo: repoField,
  prNumbers: z.array(z.number().int().positive().max(2147483647)).optional().describe('Omit for the authenticated user\'s PRs, [] for all authors, or list PR numbers for any author/state (duplicates ignored).'),
  state: z.enum(['open', 'closed', 'all']).optional().default('open').describe('Discovery state: open (default), closed including merged, or all; ignored for explicit PR numbers.'),
  limit: z.number().int().min(1).max(100).optional().default(20).describe('Maximum candidate PRs scanned per call (default 20, max 100); all unresolved Copilot originating comment bodies are collected per matching PR.'),
  cursor: z.string().regex(/^[A-Za-z0-9_-]+$/).optional().describe('Opaque continuation token; keep repo, selection, discovery state, limit and authenticated user unchanged.'),
});

export const githubGetCodeReviewReadySchema = z.object({
  status: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .default('Ready For Code Review')
    .describe('Jira status to search for tickets in (default "Ready For Code Review").'),
  project: z
    .string()
    .min(1)
    .max(20)
    .optional()
    .default('TRIPS')
    .describe('Jira project key to search (default "TRIPS").'),
  assignee: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .default('currentUser()')
    .describe('Jira assignee filter — JQL expression (default "currentUser()").'),
  prState: z
    .enum(['open', 'all'])
    .optional()
    .default('open')
    .describe('Filter PRs by state (default "open").'),
});

export const githubCreatePrSchema = z.object({
  repo: repoField,
  title: z.string().max(255).describe('Pull request title.'),
  head: z.string().max(255).describe('Branch name with changes.'),
  base: z.string().max(255).describe('Target branch (e.g., "main", "ops/development").'),
  body: z.string().max(65536).optional().describe('Pull request body/description.'),
  draft: z.boolean().optional().default(false).describe('Create as draft PR.'),
});

export const githubAddPrCommentSchema = z.object({
  repo: repoField,
  prNumber: z.number().int().positive().describe('Pull request number.'),
  body: z.string().min(1).max(65536).describe('Comment body (Markdown supported).'),
});

export const githubListBranchesSchema = z.object({
  repo: repoField,
  limit: z.number().min(1).max(100).optional().default(20).describe('Maximum items per page (default 20).'),
  cursor: z.string().max(50).optional().describe('Opaque pagination token from a previous response.'),
});

export const githubGetPrDetailsSchema = z.object({
  repo: repoField,
  prNumber: z
    .number()
    .int()
    .positive()
    .describe('Pull request number.'),
});

export const githubGetPrReviewsSchema = z.object({
  repo: repoField,
  prNumber: z
    .number()
    .int()
    .positive()
    .describe('Pull request number.'),
});

export const githubGetPrCommentsSchema = z.object({
  repo: repoField,
  prNumber: z
    .number()
    .int()
    .positive()
    .describe('Pull request number.'),
  limit: z.number().min(1).max(100).optional().default(20).describe('Maximum items per page (default 20).'),
  cursor: z.string().max(50).optional().describe('Opaque pagination token from a previous response.'),
});

export const githubUpdatePrCommentSchema = z.object({
  repo: repoField,
  commentId: z
    .number()
    .int()
    .positive()
    .describe('Comment ID to update.'),
  body: z.string().min(1).max(65536).describe('Updated comment body (Markdown supported).'),
});

export const githubGetPrChecksSchema = z.object({
  repo: repoField,
  prNumber: z
    .number()
    .int()
    .positive()
    .describe('Pull request number.'),
});

export const githubGetPrReviewThreadsSchema = z.object({
  repo: repoField,
  prNumber: z.number().int().positive().describe('Pull request number.'),
});

export const githubResolveReviewThreadSchema = z.object({
  repo: repoField,
  threadId: z.string().min(1).max(64).describe('GraphQL node ID of the review thread to resolve.'),
});

export const githubUnresolveReviewThreadSchema = z.object({
  repo: repoField,
  threadId: z.string().min(1).max(64).describe('GraphQL node ID of the review thread to unresolve.'),
});

export const githubDeletePrIssueCommentSchema = z.object({
  repo: repoField,
  commentId: z.number().int().positive().describe('Issue comment ID to delete.'),
});

export const githubMergePrSchema = z.object({
  repo: repoField,
  prNumber: z.number().int().positive().describe('Pull request number.'),
  mergeMethod: z.enum(['merge', 'squash', 'rebase']).optional().default('merge').describe('Merge method: merge, squash, or rebase.'),
  sha: z.string().max(64).optional().describe('SHA of the head commit to ensure the PR hasn\'t been updated.'),
});

export const githubRequestPrReviewersSchema = z.object({
  repo: repoField,
  prNumber: z.number().int().positive().describe('Pull request number.'),
  reviewers: z.array(z.string().min(1).max(100)).min(1).max(50).describe('GitHub usernames to request review from (max 50).'),
  teamReviewers: z.array(z.string().min(1).max(100)).max(10).optional().describe('Team slugs to request review from (max 10).'),
});

export const githubUpdatePrLabelsSchema = z.object({
  repo: repoField,
  prNumber: z.number().int().positive().describe('Pull request number.'),
  labels: z.array(z.string().min(1).max(100)).describe('Labels to set on the PR (replaces all existing labels).'),
});

export const githubUpdatePrAssigneesSchema = z.object({
  repo: repoField,
  prNumber: z.number().int().positive().describe('Pull request number.'),
  assignees: z.array(z.string().min(1).max(100)).describe('Usernames to assign to the PR (adds to existing assignees).'),
});

export const githubDismissPrReviewSchema = z.object({
  repo: repoField,
  prNumber: z.number().int().positive().describe('Pull request number.'),
  reviewId: z.number().int().positive().describe('Review ID to dismiss.'),
  message: z.string().min(1).max(65536).describe('Reason for the dismissal (visible in timeline).'),
});

export const githubGetPrFilesSchema = z.object({
  repo: repoField,
  prNumber: z.number().int().positive().describe('Pull request number.'),
  limit: z.number().min(1).max(100).optional().default(20).describe('Maximum items per page (default 20).'),
  cursor: z.string().max(50).optional().describe('Opaque pagination token from a previous response.'),
});

export const githubGetPrCommitsSchema = z.object({
  repo: repoField,
  prNumber: z.number().int().positive().describe('Pull request number.'),
  limit: z.number().min(1).max(100).optional().default(20).describe('Maximum items per page (default 20).'),
  cursor: z.string().max(50).optional().describe('Opaque pagination token from a previous response.'),
});

export const githubGetFileContentsSchema = z.object({
  repo: repoField,
  path: z.string().min(1).max(1024).describe('File path relative to repo root (e.g., "src/file.ts").'),
  ref: z.string().max(255).optional().describe('Branch or commit SHA (defaults to the repo\'s default branch).'),
});

export const githubUpdatePrSchema = z.object({
  repo: repoField,
  prNumber: z
    .number()
    .int()
    .positive()
    .describe('Pull request number.'),
  title: z.string().max(255).optional().describe('New pull request title.'),
  body: z.string().min(1).max(65536).optional().describe('New pull request body (Markdown supported).'),
  state: z.enum(['open', 'closed']).optional().describe('New state for the PR.'),
  base: z.string().max(255).optional().describe('New base branch for the PR.'),
  maintainerCanModify: z
    .boolean()
    .optional()
    .describe('Whether maintainers can modify the PR.'),
  draft: z
    .boolean()
    .optional()
    .describe('Set true to convert the PR to a draft, false to mark it ready for review.'),
}).refine(
  (data) =>
    data.title ||
    data.body ||
    data.state ||
    data.base ||
    data.maintainerCanModify !== undefined ||
    data.draft !== undefined,
  { message: 'At least one of title, body, state, base, maintainerCanModify, or draft must be provided' },
);

export const githubSearchPrsSchema = z.object({
  query: z.string().max(200).optional().describe('Additional free-text search terms.'),
  author: z.string().max(100).optional().describe('GitHub username to filter by author.'),
  repo: repoField.optional().describe('Repository "owner/name" to filter by.'),
  state: z.enum(['open', 'closed', 'all']).optional().default('open').describe('Filter PRs by state (default "open").'),
  limit: z.number().min(1).max(100).optional().default(20).describe('Maximum items per page (default 20).'),
  cursor: z.string().max(50).optional().describe('Opaque pagination token.'),
  label: z.string().max(100).optional().describe('Filter by label name.'),
  reviewRequested: z.string().max(100).optional().describe('Filter by username of requested reviewer.'),
  base: z.string().max(100).optional().describe('Filter by base branch name.'),
}).refine(
  (data) => data.query || data.author || data.repo || data.label || data.reviewRequested || data.base,
  { message: 'At least one of query, author, repo, label, reviewRequested, or base must be provided' },
);

export const githubCreatePrReviewCommentSchema = z.object({
  repo: repoField,
  prNumber: z.number().int().positive().describe('Pull request number.'),
  path: z
    .string()
    .min(1)
    .max(1024)
    .optional()
    .describe('File path relative to repo root (e.g., "src/file.ts"). Required unless `inReplyTo` is set.'),
  body: z.string().min(1).max(65536).describe('Comment body (Markdown supported).'),
  commitId: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('SHA of the commit being commented on. Required unless `inReplyTo` is set.'),
  line: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Line number in the diff (or end line for multi-line comments). Required unless `inReplyTo` is set.'),
  inReplyTo: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'ID of an existing review comment to reply to. When set, the comment is posted as a reply ' +
      'in that thread and `path`, `commitId`, `line`, `startLine`, `side`, and `startSide` are ignored.',
    ),
  startLine: z.number().int().positive().optional().describe('Start line for multi-line comments (must be less than `line`).'),
  side: z.enum(['LEFT', 'RIGHT']).optional().default('RIGHT').describe('Which side of the diff: "LEFT" (base) or "RIGHT" (head).'),
  startSide: z.enum(['LEFT', 'RIGHT']).optional().describe('Start side for multi-line comments (defaults to the value of `side`).'),
  suggestedReplacement: z.string().max(65536).optional().describe(
    'If provided, wraps the comment as a GitHub suggested change. ' +
    'The replacement code is formatted inside a ```suggestion code fence, ' +
    'and GitHub renders it with an "Apply suggestion" button.',
  ),
}).refine(
  (data) => {
    if (data.inReplyTo !== undefined) {
      return true;
    }
    return data.path !== undefined && data.commitId !== undefined && data.line !== undefined;
  },
  { message: 'path, commitId, and line are required unless inReplyTo is provided' },
).refine(
  (data) => {
    if (data.startLine !== undefined && data.line !== undefined && data.startLine >= data.line) {
      return false;
    }
    return true;
  },
  { message: 'startLine must be less than line for multi-line comments' },
).refine(
  (data) => {
    if (data.startSide !== undefined && data.startLine === undefined) {
      return false;
    }
    return true;
  },
  { message: 'startSide requires startLine to be provided' },
);

export const githubGetPrReviewCommentsSchema = z.object({
  repo: repoField,
  prNumber: z.number().int().positive().describe('Pull request number.'),
  limit: z.number().min(1).max(100).optional().default(20).describe('Maximum items per page (default 20).'),
  cursor: z.string().max(50).optional().describe('Opaque pagination token from a previous response.'),
});

export const githubUpdatePrReviewCommentSchema = z.object({
  repo: repoField,
  commentId: z.number().int().positive().describe('Review comment ID to update.'),
  body: z.string().min(1).max(65536).describe('Updated comment body (Markdown supported).'),
});

export const githubDeletePrReviewCommentSchema = z.object({
  repo: repoField,
  commentId: z.number().int().positive().describe('Review comment ID to delete.'),
});

const reviewCommentInputSchema = z.object({
  path: z.string().min(1).max(1024).describe('File path relative to repo root.'),
  body: z.string().min(1).max(65536).describe('Inline comment body.'),
  line: z.number().int().positive().describe('Line number (or end line for multi-line).'),
  startLine: z.number().int().positive().optional().describe('Start line for multi-line.'),
  side: z.enum(['LEFT', 'RIGHT']).optional().describe('Diff side ("LEFT" for base, "RIGHT" for head).'),
  startSide: z.enum(['LEFT', 'RIGHT']).optional().describe('Start side for multi-line.'),
});

export const githubSubmitPrReviewSchema = z.object({
  repo: repoField,
  prNumber: z.number().int().positive().describe('Pull request number.'),
  event: z
    .enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT'])
    .describe('Review action: APPROVE, REQUEST_CHANGES, or COMMENT.'),
  body: z.string().max(65536).optional().describe('Review summary body (Markdown supported).'),
  commitId: z.string().max(64).optional().describe('Optional SHA to pin the review to a specific commit.'),
  comments: z
    .array(reviewCommentInputSchema)
    .max(50)
    .optional()
    .describe('Optional inline comments to include in this review. Max 50 comments.'),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse an opaque page-number cursor, rejecting NaN/negative/zero. Defaults to 1. */
function parsePageCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 1;
  const trimmed = cursor.trim();
  const n = parseInt(trimmed, 10);
  if (String(n) !== trimmed || n < 1) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid cursor: "${cursor}". Must be a positive integer.`);
  }
  return n;
}

/** Parse an offset-based cursor, rejecting NaN/negative. Defaults to 0. */
function parseOffsetCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const trimmed = cursor.trim();
  const n = parseInt(trimmed, 10);
  if (String(n) !== trimmed || n < 0) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid cursor: "${cursor}". Must be a non-negative integer.`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Handler Factories
// ---------------------------------------------------------------------------
type ToolHandler<T = unknown> = (
  clients: { github: GitHubClient; jira?: JiraClient },
) => (args: T) => Promise<{
  content: { type: 'text'; text: string }[];
}>;

export const githubGetPrsHandler: ToolHandler<z.infer<typeof githubGetPrsSchema>> =
  (_clients) => async (args) => {
    const { issueKey, keys, searchBranches, state = 'open', cursor } = args;
    const limit = args.limit ?? 20;

    if (keys && keys.length > 0) {
      const grouped = await _clients.github.findPrsForIssueKeys(keys, state);
      const allPrs: PrInfo[] = [];
      for (const [, prs] of grouped) {
        allPrs.push(...prs);
      }

      // Optionally merge branch-name results for each key
      if (searchBranches) {
        for (const key of keys) {
          const branchPrs = await _clients.github.searchPrsByBranchName(key, state);
          const branchItems = branchPrs.get(key) ?? [];
          for (const pr of branchItems) {
            if (!allPrs.some((p) => p.htmlUrl === pr.htmlUrl)) {
              allPrs.push(pr);
            }
          }
        }
      }

      const offset = parseOffsetCursor(cursor);
      const sliced = allPrs.slice(offset, offset + limit);
      const hasMore = allPrs.length > offset + limit;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(paginated(sliced, hasMore ? String(offset + limit) : undefined)),
          },
        ],
      };
    }

    if (issueKey) {
      const offset = parseOffsetCursor(cursor);
      const maxResults = cursor ? offset + limit : limit;
      let prs = await _clients.github.searchPrs(issueKey, maxResults, state);

      // Optionally merge branch-name results
      if (searchBranches) {
        const branchPrs = await _clients.github.searchPrsByBranchName(issueKey, state);
        const branchItems = branchPrs.get(issueKey) ?? [];
        for (const pr of branchItems) {
          if (!prs.some((p) => p.htmlUrl === pr.htmlUrl)) {
            prs.push(pr);
          }
        }
      }

      const sliced = prs.slice(offset, offset + limit);
      const hasMore = prs.length > offset + limit;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(paginated(sliced, hasMore ? String(offset + limit) : undefined)),
          },
        ],
      };
    }

    throw new McpError(ErrorCode.InvalidParams, 'Provide either issueKey or keys');
  };

export const githubGetCopilotUnresolvedPrsHandler: ToolHandler<z.infer<typeof githubGetCopilotUnresolvedPrsSchema>> =
  (clients) => async (args) => {
    const result = await clients.github.getCopilotUnresolvedPrs(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  };

export const githubGetCodeReviewReadyHandler: ToolHandler<z.infer<typeof githubGetCodeReviewReadySchema>> =
  (clients) => async (args) => {
    const {
      status = 'Ready For Code Review',
      project = 'TRIPS',
      assignee = 'currentUser()',
      prState = 'open',
    } = args;
    if (!clients.jira) {
      throw new McpError(
        ErrorCode.InternalError,
        'Jira integration not configured — JIRA_BASE_URL, JIRA_EMAIL, and JIRA_TOKEN are required.',
      );
    }
    const jql = `project = ${project} AND assignee = ${assignee} AND status = '${status.replace(/'/g, "\\'")}'`;
    const issues = await clients.jira.searchAllSlim(jql);
    if (issues.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              tickets: [],
              summary: `No tickets found in status "${status}" assigned to ${assignee} in ${project}.`,
            }),
          },
        ],
      };
    }
    const prsByKey = await clients.github.findPrsForIssueKeys(
      issues.map((issue) => issue.key),
      prState,
    );
    const tickets = await Promise.all(
      issues.map(async (issue) => {
        const prs = prsByKey.get(issue.key) ?? [];
        const settled = await Promise.allSettled(
          prs.map((pr) => clients.github.isPrApprovedByHuman(pr.repo, pr.number, pr.author)),
        );
        const prReports = prs.map((pr, i) => ({
          repo: pr.repo,
          prNumber: pr.number,
          title: pr.title,
          state: pr.state,
          htmlUrl: pr.htmlUrl,
          approved: settled[i].status === 'fulfilled' ? settled[i].value : false,
          approvalCheckFailed: settled[i].status === 'rejected',
        }));
        return {
          key: issue.key,
          summary: issue.summary,
          allApproved: prReports.length > 0 && prReports.every((pr) => pr.approved && !pr.approvalCheckFailed),
          prs: prReports,
        };
      }),
    );
    const ready = tickets.filter((ticket) => ticket.allApproved);
    const withPrs = tickets.filter((ticket) => ticket.prs.length > 0);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            tickets,
            summary: `${ready.length} of ${withPrs.length} tickets with PRs have every PR approved by a human.`,
          }),
        },
      ],
    };
  };

export const githubCreatePrHandler: ToolHandler<z.infer<typeof githubCreatePrSchema>> =
  (_clients) => async (args) => {
    const pr = await _clients.github.createPullRequest({
      repo: args.repo,
      title: args.title,
      head: args.head,
      base: args.base,
      body: args.body,
      draft: args.draft,
    });
    return { content: [{ type: 'text', text: JSON.stringify(pr) }] };
  };

export const githubAddPrCommentHandler: ToolHandler<z.infer<typeof githubAddPrCommentSchema>> =
  (_clients) => async (args) => {
    const comment = await _clients.github.addPrComment({
      repo: args.repo,
      prNumber: args.prNumber,
      body: args.body,
    });
    return { content: [{ type: 'text', text: JSON.stringify(comment) }] };
  };

export const githubGetPrCommentsHandler: ToolHandler<z.infer<typeof githubGetPrCommentsSchema>> =
  (_clients) => async (args) => {
    const limit = args.limit ?? 20;
    const page = parsePageCursor(args.cursor);
    const comments = await _clients.github.getPrComments(args.repo, args.prNumber, {
      perPage: limit + 1,
      page,
    });
    const hasMore = comments.length > limit;
    if (hasMore) comments.pop();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(paginated(comments, hasMore ? String(page + 1) : undefined)),
        },
      ],
    };
  };

export const githubUpdatePrCommentHandler: ToolHandler<z.infer<typeof githubUpdatePrCommentSchema>> =
  (_clients) => async (args) => {
    const comment = await _clients.github.updatePrComment(args.repo, args.commentId, args.body);
    return { content: [{ type: 'text', text: JSON.stringify(comment) }] };
  };

export const githubListBranchesHandler: ToolHandler<z.infer<typeof githubListBranchesSchema>> =
  (_clients) => async (args) => {
    const limit = args.limit ?? 20;
    const page = parsePageCursor(args.cursor);
    const branches = await _clients.github.listBranches(args.repo, {
      perPage: limit + 1,
      page,
    });
    const hasMore = branches.length > limit;
    if (hasMore) branches.pop();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(paginated(branches, hasMore ? String(page + 1) : undefined)),
        },
      ],
    };
  };

export const githubGetPrDetailsHandler: ToolHandler<z.infer<typeof githubGetPrDetailsSchema>> =
  (_clients) => async (args) => {
    const detail = await _clients.github.getPullRequest(args.repo, args.prNumber);
    return { content: [{ type: 'text', text: JSON.stringify(detail) }] };
  };

export const githubGetPrReviewsHandler: ToolHandler<z.infer<typeof githubGetPrReviewsSchema>> =
  (_clients) => async (args) => {
    const reviews = await _clients.github.getPullRequestReviews(args.repo, args.prNumber);
    return { content: [{ type: 'text', text: JSON.stringify(reviews) }] };
  };

export const githubGetPrChecksHandler: ToolHandler<z.infer<typeof githubGetPrChecksSchema>> =
  (_clients) => async (args) => {
    const checks = await _clients.github.getPullRequestChecks(args.repo, args.prNumber);
    return { content: [{ type: 'text', text: JSON.stringify(checks) }] };
  };

export const githubGetPrFilesHandler: ToolHandler<z.infer<typeof githubGetPrFilesSchema>> =
  (_clients) => async (args) => {
    const limit = args.limit ?? 20;
    const page = parsePageCursor(args.cursor);
    const files = await _clients.github.getPrFiles(args.repo, args.prNumber, {
      perPage: limit + 1,
      page,
    });
    const hasMore = files.length > limit;
    if (hasMore) files.pop();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(paginated(files, hasMore ? String(page + 1) : undefined)),
        },
      ],
    };
  };

export const githubGetPrCommitsHandler: ToolHandler<z.infer<typeof githubGetPrCommitsSchema>> =
  (_clients) => async (args) => {
    const limit = args.limit ?? 20;
    const page = parsePageCursor(args.cursor);
    const commits = await _clients.github.getPrCommits(args.repo, args.prNumber, {
      perPage: limit + 1,
      page,
    });
    const hasMore = commits.length > limit;
    if (hasMore) commits.pop();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(paginated(commits, hasMore ? String(page + 1) : undefined)),
        },
      ],
    };
  };

export const githubGetFileContentsHandler: ToolHandler<z.infer<typeof githubGetFileContentsSchema>> =
  (_clients) => async (args) => {
    const result = await _clients.github.getFileContents(args.repo, args.path, args.ref);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result),
        },
      ],
    };
  };

export const githubUpdatePrHandler: ToolHandler<z.infer<typeof githubUpdatePrSchema>> =
  (_clients) => async (args) => {
    const hasFieldUpdate =
      args.title !== undefined ||
      args.body !== undefined ||
      args.state !== undefined ||
      args.base !== undefined ||
      args.maintainerCanModify !== undefined;
    let detail;
    if (hasFieldUpdate) {
      detail = await _clients.github.updatePullRequest(args.repo, args.prNumber, {
        title: args.title,
        body: args.body,
        state: args.state,
        base: args.base,
        maintainerCanModify: args.maintainerCanModify,
      });
    }
    if (args.draft !== undefined) {
      detail = await _clients.github.setPullRequestDraft(args.repo, args.prNumber, args.draft);
    }
    return { content: [{ type: 'text', text: JSON.stringify(detail) }] };
  };

export const githubSearchPrsHandler: ToolHandler<z.infer<typeof githubSearchPrsSchema>> =
  (_clients) => async (args) => {
    const limit = args.limit ?? 20;
    const page = parsePageCursor(args.cursor);
    const prs = await _clients.github.searchPullRequestsByQuery({
      query: args.query,
      author: args.author,
      repo: args.repo,
      state: args.state,
      perPage: limit + 1,
      page,
      label: args.label,
      reviewRequested: args.reviewRequested,
      base: args.base,
    });
    const hasMore = prs.length > limit;
    if (hasMore) prs.pop();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(paginated(prs, hasMore ? String(page + 1) : undefined)),
        },
      ],
    };
  };

export const githubCreatePrReviewCommentHandler: ToolHandler<z.infer<typeof githubCreatePrReviewCommentSchema>> =
  (_clients) => async (args) => {
    let body = args.body;
    if (args.suggestedReplacement) {
      const suggestionBlock = '```suggestion\n' + args.suggestedReplacement + '\n```';
      body = body ? body + '\n\n' + suggestionBlock : suggestionBlock;
    }
    const comment = args.inReplyTo !== undefined
      ? await _clients.github.replyToPrReviewComment(args.repo, args.prNumber, args.inReplyTo, body)
      : await _clients.github.createPrReviewComment(args.repo, args.prNumber, {
        body,
        path: args.path!,
        commitId: args.commitId,
        line: args.line!,
        startLine: args.startLine,
        side: args.side,
        startSide: args.startSide,
      });
    return { content: [{ type: 'text', text: JSON.stringify(comment) }] };
  };

export const githubGetPrReviewCommentsHandler: ToolHandler<z.infer<typeof githubGetPrReviewCommentsSchema>> =
  (_clients) => async (args) => {
    const limit = args.limit ?? 20;
    const page = parsePageCursor(args.cursor);
    const comments = await _clients.github.getPrReviewComments(args.repo, args.prNumber, {
      perPage: limit + 1,
      page,
    });
    const hasMore = comments.length > limit;
    if (hasMore) comments.pop();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(paginated(comments, hasMore ? String(page + 1) : undefined)),
        },
      ],
    };
  };

export const githubUpdatePrReviewCommentHandler: ToolHandler<z.infer<typeof githubUpdatePrReviewCommentSchema>> =
  (_clients) => async (args) => {
    const comment = await _clients.github.updatePrReviewComment(args.repo, args.commentId, args.body);
    return { content: [{ type: 'text', text: JSON.stringify(comment) }] };
  };

export const githubDeletePrReviewCommentHandler: ToolHandler<z.infer<typeof githubDeletePrReviewCommentSchema>> =
  (_clients) => async (args) => {
    await _clients.github.deletePrReviewComment(args.repo, args.commentId);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'Review comment deleted' }) }] };
  };

export const githubSubmitPrReviewHandler: ToolHandler<z.infer<typeof githubSubmitPrReviewSchema>> =
  (_clients) => async (args) => {
    const result = await _clients.github.submitPrReview(args.repo, args.prNumber, {
      body: args.body,
      event: args.event,
      comments: args.comments,
      commitId: args.commitId,
    });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  };

export const githubGetPrReviewThreadsHandler: ToolHandler<z.infer<typeof githubGetPrReviewThreadsSchema>> =
  (_clients) => async (args) => {
    const threads = await _clients.github.getReviewThreads(args.repo, args.prNumber);
    return { content: [{ type: 'text', text: JSON.stringify(threads) }] };
  };

export const githubResolveReviewThreadHandler: ToolHandler<z.infer<typeof githubResolveReviewThreadSchema>> =
  (_clients) => async (args) => {
    const result = await _clients.github.resolveReviewThread(args.repo, args.threadId);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  };

export const githubUnresolveReviewThreadHandler: ToolHandler<z.infer<typeof githubUnresolveReviewThreadSchema>> =
  (_clients) => async (args) => {
    const result = await _clients.github.unresolveReviewThread(args.repo, args.threadId);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  };

export const githubDeletePrIssueCommentHandler: ToolHandler<z.infer<typeof githubDeletePrIssueCommentSchema>> =
  (_clients) => async (args) => {
    await _clients.github.deletePrComment(args.repo, args.commentId);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'Issue comment deleted' }) }] };
  };

export const githubMergePrHandler: ToolHandler<z.infer<typeof githubMergePrSchema>> =
  (_clients) => async (args) => {
    const result = await _clients.github.mergePr(args.repo, args.prNumber, {
      mergeMethod: args.mergeMethod ?? 'merge',
      sha: args.sha,
    });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  };

export const githubRequestPrReviewersHandler: ToolHandler<z.infer<typeof githubRequestPrReviewersSchema>> =
  (_clients) => async (args) => {
    const result = await _clients.github.requestReviewers(args.repo, args.prNumber, args.reviewers, args.teamReviewers);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  };

export const githubUpdatePrLabelsHandler: ToolHandler<z.infer<typeof githubUpdatePrLabelsSchema>> =
  (_clients) => async (args) => {
    const labels = await _clients.github.updateLabels(args.repo, args.prNumber, args.labels);
    return { content: [{ type: 'text', text: JSON.stringify(labels) }] };
  };

export const githubUpdatePrAssigneesHandler: ToolHandler<z.infer<typeof githubUpdatePrAssigneesSchema>> =
  (_clients) => async (args) => {
    const assignees = await _clients.github.updateAssignees(args.repo, args.prNumber, args.assignees);
    return { content: [{ type: 'text', text: JSON.stringify(assignees) }] };
  };

export const githubDismissPrReviewHandler: ToolHandler<z.infer<typeof githubDismissPrReviewSchema>> =
  (_clients) => async (args) => {
    const result = await _clients.github.dismissPrReview(args.repo, args.prNumber, args.reviewId, args.message);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  };

const copilotUnresolvedPrsInputSchema = zodToJsonSchema(githubGetCopilotUnresolvedPrsSchema);
const copilotUnresolvedPrsProperties = copilotUnresolvedPrsInputSchema.properties as Record<string, Record<string, unknown>>;
Object.assign(copilotUnresolvedPrsProperties.prNumbers, {
  items: { type: 'integer', exclusiveMinimum: 0, maximum: 2147483647 },
});
Object.assign(copilotUnresolvedPrsProperties.limit, { type: 'integer', minimum: 1, maximum: 100 });
Object.assign(copilotUnresolvedPrsProperties.cursor, { pattern: '^[A-Za-z0-9_-]+$' });

/** All tool descriptors for the ListToolsRequestSchema response. */
export const githubToolDescriptors = [
  {
    name: 'github_get_copilot_unresolved_prs',
    description: 'List PRs with full originating comment bodies from every unresolved Copilot-started review thread.',
    inputSchema: copilotUnresolvedPrsInputSchema,
  },
  {
    name: 'github_get_code_review_ready',
    description:
      'Fetch Jira tickets in a given status (default "Ready For Code Review") and report which have every PR approved by a human.',
    inputSchema: zodToJsonSchema(githubGetCodeReviewReadySchema),
  },
  {
    name: 'github_get_prs',
    description: 'Find pull requests for one or more issue keys.',
    inputSchema: zodToJsonSchema(githubGetPrsSchema),
  },
  {
    name: 'github_create_pr',
    description: 'Create a pull request on GitHub.',
    inputSchema: zodToJsonSchema(githubCreatePrSchema),
  },
  {
    name: 'github_add_pr_comment',
    description: 'Add an issue-level comment to a pull request.',
    inputSchema: zodToJsonSchema(githubAddPrCommentSchema),
  },
  {
    name: 'github_get_pr_comments',
    description: 'List issue-level (conversation) comments on a pull request.',
    inputSchema: zodToJsonSchema(githubGetPrCommentsSchema),
  },
  {
    name: 'github_update_pr_comment',
    description: 'Update an existing issue-level comment on a pull request by comment ID.',
    inputSchema: zodToJsonSchema(githubUpdatePrCommentSchema),
  },
  {
    name: 'github_list_branches',
    description: 'List branches for a repository.',
    inputSchema: zodToJsonSchema(githubListBranchesSchema),
  },
  {
    name: 'github_get_pr_details',
    description: 'Get full PR details (body, files changed, additions/deletions, mergeable state — may be null if still computing, base/head branches) by repo + PR number.',
    inputSchema: zodToJsonSchema(githubGetPrDetailsSchema),
  },
  {
    name: 'github_get_pr_reviews',
    description: 'Get PR review comments and review thread summaries.',
    inputSchema: zodToJsonSchema(githubGetPrReviewsSchema),
  },
  {
    name: 'github_get_pr_checks',
    description: 'Get PR status check / CI results (check-runs for the latest commit on the PR).',
    inputSchema: zodToJsonSchema(githubGetPrChecksSchema),
  },
  {
    name: 'github_search_prs',
    description: 'Flexible PR search by author, repo, state, or free-text query.',
    inputSchema: zodToJsonSchema(githubSearchPrsSchema),
  },
  {
    name: 'github_update_pr',
    description: 'Update an existing pull request (title, body, state, base branch, draft status, or maintainer settings).',
    inputSchema: zodToJsonSchema(githubUpdatePrSchema),
  },
  {
    name: 'github_create_pr_review_comment',
    description: 'Create an inline review comment on a pull request diff, reply to an existing one via `inReplyTo`, optionally with a suggested change.',
    inputSchema: zodToJsonSchema(githubCreatePrReviewCommentSchema),
  },
  {
    name: 'github_get_pr_review_comments',
    description: 'List inline review comments on a pull request diff.',
    inputSchema: zodToJsonSchema(githubGetPrReviewCommentsSchema),
  },
  {
    name: 'github_update_pr_review_comment',
    description: 'Update an existing inline review comment.',
    inputSchema: zodToJsonSchema(githubUpdatePrReviewCommentSchema),
  },
  {
    name: 'github_delete_pr_review_comment',
    description: 'Delete an inline review comment from a pull request.',
    inputSchema: zodToJsonSchema(githubDeletePrReviewCommentSchema),
  },
  {
    name: 'github_submit_pr_review',
    description: 'Submit a formal pull request review (APPROVE, REQUEST_CHANGES, or COMMENT), optionally with inline comments.',
    inputSchema: zodToJsonSchema(githubSubmitPrReviewSchema),
  },
  {
    name: 'github_get_pr_files',
    description: 'Get the list of files changed in a pull request, with patch text truncated at 2000 characters.',
    inputSchema: zodToJsonSchema(githubGetPrFilesSchema),
  },
  {
    name: 'github_get_pr_commits',
    description: 'Get the list of commits in a pull request, with author and SHA details.',
    inputSchema: zodToJsonSchema(githubGetPrCommitsSchema),
  },
  {
    name: 'github_get_file_contents',
    description: 'Get the contents of a file in a repository, base64-decoded up to 100KB.',
    inputSchema: zodToJsonSchema(githubGetFileContentsSchema),
  },
  {
    name: 'github_get_pr_review_threads',
    description: 'List all review threads on a pull request, with resolution and staleness info.',
    inputSchema: zodToJsonSchema(githubGetPrReviewThreadsSchema),
  },
  {
    name: 'github_resolve_review_thread',
    description: 'Resolve a review thread by its GraphQL node ID.',
    inputSchema: zodToJsonSchema(githubResolveReviewThreadSchema),
  },
  {
    name: 'github_unresolve_review_thread',
    description: 'Unresolve a review thread by its GraphQL node ID.',
    inputSchema: zodToJsonSchema(githubUnresolveReviewThreadSchema),
  },
  {
    name: 'github_delete_pr_issue_comment',
    description: 'Delete an issue-level comment on a pull request by comment ID.',
    inputSchema: zodToJsonSchema(githubDeletePrIssueCommentSchema),
  },
  {
    name: 'github_merge_pr',
    description: 'Merge a pull request with optional merge method and SHA guard.',
    inputSchema: zodToJsonSchema(githubMergePrSchema),
  },
  {
    name: 'github_request_pr_reviewers',
    description: 'Request reviewers on a pull request by username or team slug.',
    inputSchema: zodToJsonSchema(githubRequestPrReviewersSchema),
  },
  {
    name: 'github_update_pr_labels',
    description: 'Replace all labels on a pull request.',
    inputSchema: zodToJsonSchema(githubUpdatePrLabelsSchema),
  },
  {
    name: 'github_update_pr_assignees',
    description: 'Add assignees to a pull request.',
    inputSchema: zodToJsonSchema(githubUpdatePrAssigneesSchema),
  },
  {
    name: 'github_dismiss_pr_review',
    description: 'Dismiss a pull request review by ID with a reason.',
    inputSchema: zodToJsonSchema(githubDismissPrReviewSchema),
  },
];
