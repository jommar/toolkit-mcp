import { GitHubClient, ISSUE_KEY_PATTERN } from '../../services/index.js';
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
  githubUpdatePrHandler,
  githubUpdatePrSchema,
  githubCreatePrReviewCommentHandler,
  githubCreatePrReviewCommentSchema,
  githubGetPrReviewCommentsHandler,
  githubGetPrReviewCommentsSchema,
  githubUpdatePrReviewCommentHandler,
  githubUpdatePrReviewCommentSchema,
  githubDeletePrReviewCommentHandler,
  githubDeletePrReviewCommentSchema,
  githubSubmitPrReviewHandler,
  githubSubmitPrReviewSchema,
  githubGetPrFilesHandler,
  githubGetPrFilesSchema,
  githubGetPrCommitsHandler,
  githubGetPrCommitsSchema,
  githubGetFileContentsHandler,
  githubGetFileContentsSchema,
  githubGetPrReviewThreadsHandler,
  githubGetPrReviewThreadsSchema,
  githubResolveReviewThreadHandler,
  githubResolveReviewThreadSchema,
  githubUnresolveReviewThreadHandler,
  githubUnresolveReviewThreadSchema,
  githubDeletePrIssueCommentHandler,
  githubDeletePrIssueCommentSchema,
  githubMergePrHandler,
  githubMergePrSchema,
  githubRequestPrReviewersHandler,
  githubRequestPrReviewersSchema,
  githubUpdatePrLabelsHandler,
  githubUpdatePrLabelsSchema,
  githubUpdatePrAssigneesHandler,
  githubUpdatePrAssigneesSchema,
  githubDismissPrReviewHandler,
  githubDismissPrReviewSchema,
  githubToolDescriptors,
} from './module.js';

export class GitHubModule implements IntegrationModule<{ github: GitHubClient }> {
  readonly id = 'github';

  getResourcePrefix(): string {
    return 'github://';
  }

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
      github_update_pr: async (args) => {
        const parsed = githubUpdatePrSchema.parse(args);
        return await githubUpdatePrHandler(clients)(parsed);
      },
      github_create_pr_review_comment: async (args) => {
        const parsed = githubCreatePrReviewCommentSchema.parse(args);
        return await githubCreatePrReviewCommentHandler(clients)(parsed);
      },
      github_get_pr_review_comments: async (args) => {
        const parsed = githubGetPrReviewCommentsSchema.parse(args);
        return await githubGetPrReviewCommentsHandler(clients)(parsed);
      },
      github_update_pr_review_comment: async (args) => {
        const parsed = githubUpdatePrReviewCommentSchema.parse(args);
        return await githubUpdatePrReviewCommentHandler(clients)(parsed);
      },
      github_delete_pr_review_comment: async (args) => {
        const parsed = githubDeletePrReviewCommentSchema.parse(args);
        return await githubDeletePrReviewCommentHandler(clients)(parsed);
      },
      github_submit_pr_review: async (args) => {
        const parsed = githubSubmitPrReviewSchema.parse(args);
        return await githubSubmitPrReviewHandler(clients)(parsed);
      },
      github_get_pr_files: async (args) => {
        const parsed = githubGetPrFilesSchema.parse(args);
        return await githubGetPrFilesHandler(clients)(parsed);
      },
      github_get_pr_commits: async (args) => {
        const parsed = githubGetPrCommitsSchema.parse(args);
        return await githubGetPrCommitsHandler(clients)(parsed);
      },
      github_get_file_contents: async (args) => {
        const parsed = githubGetFileContentsSchema.parse(args);
        return await githubGetFileContentsHandler(clients)(parsed);
      },
      github_get_pr_review_threads: async (args) => {
        const parsed = githubGetPrReviewThreadsSchema.parse(args);
        return await githubGetPrReviewThreadsHandler(clients)(parsed);
      },
      github_resolve_review_thread: async (args) => {
        const parsed = githubResolveReviewThreadSchema.parse(args);
        return await githubResolveReviewThreadHandler(clients)(parsed);
      },
      github_unresolve_review_thread: async (args) => {
        const parsed = githubUnresolveReviewThreadSchema.parse(args);
        return await githubUnresolveReviewThreadHandler(clients)(parsed);
      },
      github_delete_pr_issue_comment: async (args) => {
        const parsed = githubDeletePrIssueCommentSchema.parse(args);
        return await githubDeletePrIssueCommentHandler(clients)(parsed);
      },
      github_merge_pr: async (args) => {
        const parsed = githubMergePrSchema.parse(args);
        return await githubMergePrHandler(clients)(parsed);
      },
      github_request_pr_reviewers: async (args) => {
        const parsed = githubRequestPrReviewersSchema.parse(args);
        return await githubRequestPrReviewersHandler(clients)(parsed);
      },
      github_update_pr_labels: async (args) => {
        const parsed = githubUpdatePrLabelsSchema.parse(args);
        return await githubUpdatePrLabelsHandler(clients)(parsed);
      },
      github_update_pr_assignees: async (args) => {
        const parsed = githubUpdatePrAssigneesSchema.parse(args);
        return await githubUpdatePrAssigneesHandler(clients)(parsed);
      },
      github_dismiss_pr_review: async (args) => {
        const parsed = githubDismissPrReviewSchema.parse(args);
        return await githubDismissPrReviewHandler(clients)(parsed);
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
