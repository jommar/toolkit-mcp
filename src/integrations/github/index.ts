import { GitHubClient } from '../../services/index.js';
import { IntegrationModule, ToolHandlerFn, ToolDescriptor } from '../index.js';
import {
  githubGetPrsHandler,
  githubGetPrsSchema,
  githubCreatePrHandler,
  githubCreatePrSchema,
  githubAddPrCommentHandler,
  githubAddPrCommentSchema,
  githubGetPrCommentsHandler,
  githubGetPrCommentsSchema,
  githubUpdatePrCommentHandler,
  githubUpdatePrCommentSchema,
  githubListBranchesHandler,
  githubListBranchesSchema,
  githubGetPrDetailsHandler,
  githubGetPrDetailsSchema,
  githubGetPrReviewsHandler,
  githubGetPrReviewsSchema,
  githubGetPrChecksHandler,
  githubGetPrChecksSchema,
  githubSearchPrsHandler,
  githubSearchPrsSchema,
  githubToolDescriptors,
} from './module.js';

const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/;

export class GitHubModule implements IntegrationModule<{ github: GitHubClient }> {
  readonly id = 'github';

  needsEnv(): boolean {
    return !!process.env.GH_TOKEN;
  }

  createToolHandlers(clients: { github: GitHubClient }): Record<string, ToolHandlerFn> {
    return {
      github_get_prs: async (args) => {
        const parsed = githubGetPrsSchema.parse(args);
        return await githubGetPrsHandler(clients)(parsed);
      },
      github_create_pr: async (args) => {
        const parsed = githubCreatePrSchema.parse(args);
        return await githubCreatePrHandler(clients)(parsed);
      },
      github_add_pr_comment: async (args) => {
        const parsed = githubAddPrCommentSchema.parse(args);
        return await githubAddPrCommentHandler(clients)(parsed);
      },
      github_get_pr_comments: async (args) => {
        const parsed = githubGetPrCommentsSchema.parse(args);
        return await githubGetPrCommentsHandler(clients)(parsed);
      },
      github_update_pr_comment: async (args) => {
        const parsed = githubUpdatePrCommentSchema.parse(args);
        return await githubUpdatePrCommentHandler(clients)(parsed);
      },
      github_list_branches: async (args) => {
        const parsed = githubListBranchesSchema.parse(args);
        return await githubListBranchesHandler(clients)(parsed);
      },
      github_get_pr_details: async (args) => {
        const parsed = githubGetPrDetailsSchema.parse(args);
        return await githubGetPrDetailsHandler(clients)(parsed);
      },
      github_get_pr_reviews: async (args) => {
        const parsed = githubGetPrReviewsSchema.parse(args);
        return await githubGetPrReviewsHandler(clients)(parsed);
      },
      github_get_pr_checks: async (args) => {
        const parsed = githubGetPrChecksSchema.parse(args);
        return await githubGetPrChecksHandler(clients)(parsed);
      },
      github_search_prs: async (args) => {
        const parsed = githubSearchPrsSchema.parse(args);
        return await githubSearchPrsHandler(clients)(parsed);
      },
    };
  }

  getToolDescriptors(): ToolDescriptor[] {
    return githubToolDescriptors;
  }

  getResourceHandler(clients: { github: GitHubClient }) {
    return async (uri: string) => {
      if (uri.startsWith('github://prs/')) {
        const issueKey = uri.slice('github://prs/'.length);
        if (!issueKey) throw new Error('Missing issue key');
        if (!ISSUE_KEY_PATTERN.test(issueKey)) {
          throw new Error(`Invalid issue key format: "${issueKey}"`);
        }
        const prs = await clients.github.searchPrs(issueKey);
        return {
          contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(prs) }],
        };
      }

      throw new Error(`Unknown resource: ${uri}`);
    };
  }
}
