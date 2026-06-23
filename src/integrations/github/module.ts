import { z } from 'zod';
import { GitHubClient } from '../../services/index.js';
import type { PrInfo, PullRequestDetail, PullRequestReview, PullRequestChecks } from '../../services/index.js';
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
];
