import { z } from 'zod';
import { GitHubClient } from '../../services/index.js';
import type { PrInfo, PullRequestDetail, PullRequestReview, PullRequestChecks, PrReviewComment, PrReviewSubmitted } from '../../services/index.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { paginated, zodToJsonSchema } from '../helpers.js';

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------
export const githubGetPrsSchema = z.object({
  issueKey: z
    .string()
    .max(20)
    .regex(/^[A-Z][A-Z0-9]*-\d+$/i)
    .optional()
    .describe('Single issue key to search for (e.g., "TRIPS-1267").'),
  keys: z
    .array(z.string().max(20))
    .max(50)
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

export const githubCreatePrSchema = z.object({
  repo: z
    .string()
    .max(100)
    .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, 'Must be in "owner/name" format')
    .describe('Repository "owner/name" (e.g., "TransActComm/Portage-backend").'),
  title: z.string().max(255).describe('Pull request title.'),
  head: z.string().max(255).describe('Branch name with changes.'),
  base: z.string().max(255).describe('Target branch (e.g., "main", "ops/development").'),
  body: z.string().max(65536).optional().describe('Pull request body/description.'),
  draft: z.boolean().optional().default(false).describe('Create as draft PR.'),
});

export const githubAddPrCommentSchema = z.object({
  repo: z
    .string()
    .max(100)
    .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, 'Must be in "owner/name" format')
    .describe('Repository "owner/name" (e.g., "TransActComm/Portage-backend").'),
  prNumber: z.number().int().positive().describe('Pull request number.'),
  body: z.string().min(1).max(65536).describe('Comment body (Markdown supported).'),
});

export const githubListBranchesSchema = z.object({
  repo: z
    .string()
    .max(100)
    .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, 'Must be in "owner/name" format')
    .describe('Repository "owner/name" (e.g., "TransActComm/Portage-backend").'),
  limit: z.number().min(1).max(100).optional().default(20).describe('Maximum items per page (default 20).'),
  cursor: z.string().max(50).optional().describe('Opaque pagination token from a previous response.'),
});

export const githubGetPrDetailsSchema = z.object({
  repo: z
    .string()
    .max(100)
    .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, 'Must be in "owner/name" format')
    .describe('Repository "owner/name" (e.g., "TransActComm/Portage-backend").'),
  prNumber: z
    .number()
    .int()
    .positive()
    .describe('Pull request number.'),
});

export const githubGetPrReviewsSchema = z.object({
  repo: z
    .string()
    .max(100)
    .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, 'Must be in "owner/name" format')
    .describe('Repository "owner/name" (e.g., "TransActComm/Portage-backend").'),
  prNumber: z
    .number()
    .int()
    .positive()
    .describe('Pull request number.'),
});

export const githubGetPrCommentsSchema = z.object({
  repo: z
    .string()
    .max(100)
    .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, 'Must be in "owner/name" format')
    .describe('Repository "owner/name" (e.g., "TransActComm/Portage-backend").'),
  prNumber: z
    .number()
    .int()
    .positive()
    .describe('Pull request number.'),
  limit: z.number().min(1).max(100).optional().default(20).describe('Maximum items per page (default 20).'),
  cursor: z.string().max(50).optional().describe('Opaque pagination token from a previous response.'),
});

export const githubUpdatePrCommentSchema = z.object({
  repo: z
    .string()
    .max(100)
    .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, 'Must be in "owner/name" format')
    .describe('Repository "owner/name" (e.g., "TransActComm/Portage-backend").'),
  commentId: z
    .number()
    .int()
    .positive()
    .describe('Comment ID to update.'),
  body: z.string().min(1).max(65536).describe('Updated comment body (Markdown supported).'),
});

export const githubGetPrChecksSchema = z.object({
  repo: z
    .string()
    .max(100)
    .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, 'Must be in "owner/name" format')
    .describe('Repository "owner/name" (e.g., "TransActComm/Portage-backend").'),
  prNumber: z
    .number()
    .int()
    .positive()
    .describe('Pull request number.'),
});

export const githubUpdatePrSchema = z.object({
  repo: z
    .string()
    .max(100)
    .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, 'Must be in "owner/name" format')
    .describe('Repository "owner/name" (e.g., "TransActComm/Portage-backend").'),
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
}).refine(
  (data) => data.title || data.body || data.state || data.base || data.maintainerCanModify !== undefined,
  { message: 'At least one of title, body, state, base, or maintainerCanModify must be provided' },
);

export const githubSearchPrsSchema = z.object({
  query: z.string().max(200).optional().describe('Additional free-text search terms.'),
  author: z.string().max(100).optional().describe('GitHub username to filter by author.'),
  repo: z
    .string()
    .max(100)
    .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, 'Must be in "owner/name" format')
    .optional()
    .describe('Repository "owner/name" to filter by.'),
  state: z.enum(['open', 'closed', 'all']).optional().default('open').describe('Filter PRs by state (default "open").'),
  limit: z.number().min(1).max(100).optional().default(20).describe('Maximum items per page (default 20).'),
  cursor: z.string().max(50).optional().describe('Opaque pagination token.'),
}).refine(
  (data) => data.query || data.author || data.repo,
  { message: 'At least one of query, author, or repo must be provided' },
);

export const githubCreatePrReviewCommentSchema = z.object({
  repo: z
    .string()
    .max(100)
    .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, 'Must be in "owner/name" format')
    .describe('Repository "owner/name" (e.g., "TransActComm/Portage-backend").'),
  prNumber: z.number().int().positive().describe('Pull request number.'),
  path: z.string().min(1).max(1024).describe('File path relative to repo root (e.g., "src/file.ts").'),
  body: z.string().min(1).max(65536).describe('Comment body (Markdown supported).'),
  commitId: z.string().min(1).max(64).describe('SHA of the commit being commented on.'),
  line: z.number().int().positive().describe('Line number in the diff (or end line for multi-line comments).'),
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
    if (data.startLine !== undefined && data.startLine >= data.line) {
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
  repo: z
    .string()
    .max(100)
    .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, 'Must be in "owner/name" format')
    .describe('Repository "owner/name" (e.g., "TransActComm/Portage-backend").'),
  prNumber: z.number().int().positive().describe('Pull request number.'),
  limit: z.number().min(1).max(100).optional().default(20).describe('Maximum items per page (default 20).'),
  cursor: z.string().max(50).optional().describe('Opaque pagination token from a previous response.'),
});

export const githubUpdatePrReviewCommentSchema = z.object({
  repo: z
    .string()
    .max(100)
    .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, 'Must be in "owner/name" format')
    .describe('Repository "owner/name" (e.g., "TransActComm/Portage-backend").'),
  commentId: z.number().int().positive().describe('Review comment ID to update.'),
  body: z.string().min(1).max(65536).describe('Updated comment body (Markdown supported).'),
});

export const githubDeletePrReviewCommentSchema = z.object({
  repo: z
    .string()
    .max(100)
    .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, 'Must be in "owner/name" format')
    .describe('Repository "owner/name" (e.g., "TransActComm/Portage-backend").'),
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
  repo: z
    .string()
    .max(100)
    .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, 'Must be in "owner/name" format')
    .describe('Repository "owner/name" (e.g., "TransActComm/Portage-backend").'),
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
// Handler Factories
// ---------------------------------------------------------------------------
type ToolHandler<T = unknown> = (
  clients: { github: GitHubClient },
) => (args: T) => Promise<{
  content: { type: 'text'; text: string }[];
}>;

export const githubGetPrsHandler: ToolHandler<z.infer<typeof githubGetPrsSchema>> =
  (_clients) => async (args) => {
    const { issueKey, keys, limit, searchBranches, state = 'open' } = args;

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

      const sliced = allPrs.slice(0, limit);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(paginated(sliced)),
          },
        ],
      };
    }

    if (issueKey) {
      let prs = await _clients.github.searchPrs(issueKey, undefined, state);

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

      const sliced = prs.slice(0, limit);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(paginated(sliced)),
          },
        ],
      };
    }

    throw new McpError(ErrorCode.InvalidParams, 'Provide either issueKey or keys');
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
    const page = args.cursor ? parseInt(args.cursor, 10) : 1;
    const comments = await _clients.github.getPrComments(args.repo, args.prNumber, {
      perPage: args.limit,
      page,
    });
    const hasMore = comments.length >= (args.limit ?? 20);
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
    const page = args.cursor ? parseInt(args.cursor, 10) : 1;
    const branches = await _clients.github.listBranches(args.repo, {
      perPage: args.limit,
      page,
    });
    const hasMore = branches.length >= (args.limit ?? 20);
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

export const githubUpdatePrHandler: ToolHandler<z.infer<typeof githubUpdatePrSchema>> =
  (_clients) => async (args) => {
    const detail = await _clients.github.updatePullRequest(args.repo, args.prNumber, {
      title: args.title,
      body: args.body,
      state: args.state,
      base: args.base,
      maintainerCanModify: args.maintainerCanModify,
    });
    return { content: [{ type: 'text', text: JSON.stringify(detail) }] };
  };

export const githubSearchPrsHandler: ToolHandler<z.infer<typeof githubSearchPrsSchema>> =
  (_clients) => async (args) => {
    const page = args.cursor ? parseInt(args.cursor, 10) : 1;
    const prs = await _clients.github.searchPullRequestsByQuery({
      query: args.query,
      author: args.author,
      repo: args.repo,
      state: args.state,
      perPage: args.limit,
      page,
    });
    const hasMore = prs.length >= (args.limit ?? 20);
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
    const comment = await _clients.github.createPrReviewComment(args.repo, args.prNumber, {
      body,
      path: args.path,
      commitId: args.commitId,
      line: args.line,
      startLine: args.startLine,
      side: args.side,
      startSide: args.startSide,
    });
    return { content: [{ type: 'text', text: JSON.stringify(comment) }] };
  };

export const githubGetPrReviewCommentsHandler: ToolHandler<z.infer<typeof githubGetPrReviewCommentsSchema>> =
  (_clients) => async (args) => {
    const page = args.cursor ? parseInt(args.cursor, 10) : 1;
    const comments = await _clients.github.getPrReviewComments(args.repo, args.prNumber, {
      perPage: args.limit,
      page,
    });
    const hasMore = comments.length >= (args.limit ?? 20);
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

/** All tool descriptors for the ListToolsRequestSchema response. */
export const githubToolDescriptors = [
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
    description: 'Flexible PR search by author, repo, state, or free-text query. Provide at least one of `query`, `author`, or `repo`.',
    inputSchema: zodToJsonSchema(githubSearchPrsSchema),
  },
  {
    name: 'github_update_pr',
    description: 'Update an existing pull request (title, body, state, base branch, or maintainer settings).',
    inputSchema: zodToJsonSchema(githubUpdatePrSchema),
  },
  {
    name: 'github_create_pr_review_comment',
    description: 'Create an inline review comment on a pull request diff, optionally with a suggested change.',
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
];
