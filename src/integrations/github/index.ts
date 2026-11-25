import { ProtocolError, ProtocolErrorCode, ResourceNotFoundError } from '@modelcontextprotocol/server';
import { GitHubClient, JiraClient, ISSUE_KEY_PATTERN } from '../../services/index.js';
import { IntegrationModule, ResourceDescriptor, ResourceHandlerFn, ToolHandlerFn, ToolDescriptor } from '../index.js';
import {
  githubResourceDescriptors,
  githubGetCopilotUnresolvedPrsHandler,
  githubGetPrsHandler,
  githubGetCodeReviewReadyHandler,
  githubCreatePrHandler,
  githubAddPrCommentHandler,
  githubGetPrCommentsHandler,
  githubUpdatePrCommentHandler,
  githubListBranchesHandler,
  githubGetPrDetailsHandler,
  githubGetPrReviewsHandler,
  githubGetPrChecksHandler,
  githubSearchPrsHandler,
  githubUpdatePrHandler,
  githubCreatePrReviewCommentHandler,
  githubGetPrReviewCommentsHandler,
  githubUpdatePrReviewCommentHandler,
  githubDeletePrReviewCommentHandler,
  githubSubmitPrReviewHandler,
  githubGetPrFilesHandler,
  githubGetPrCommitsHandler,
  githubGetFileContentsHandler,
  githubGetPrReviewThreadsHandler,
  githubResolveReviewThreadHandler,
  githubUnresolveReviewThreadHandler,
  githubDeletePrIssueCommentHandler,
  githubMergePrHandler,
  githubRequestPrReviewersHandler,
  githubUpdatePrLabelsHandler,
  githubUpdatePrAssigneesHandler,
  githubDismissPrReviewHandler,
  githubToolDescriptors,
} from './module.js';

export class GitHubModule implements IntegrationModule<{ github: GitHubClient; jira?: JiraClient }> {
  readonly id = 'github';

  needsEnv(): boolean {
    return !!process.env.GH_TOKEN;
  }

  createToolHandlers(clients: { github: GitHubClient; jira?: JiraClient }): Record<string, ToolHandlerFn> {
    return {
      github_get_copilot_unresolved_prs: githubGetCopilotUnresolvedPrsHandler(clients),
      github_get_code_review_ready: githubGetCodeReviewReadyHandler(clients),
      github_get_prs: githubGetPrsHandler(clients),
      github_create_pr: githubCreatePrHandler(clients),
      github_add_pr_comment: githubAddPrCommentHandler(clients),
      github_get_pr_comments: githubGetPrCommentsHandler(clients),
      github_update_pr_comment: githubUpdatePrCommentHandler(clients),
      github_list_branches: githubListBranchesHandler(clients),
      github_get_pr_details: githubGetPrDetailsHandler(clients),
      github_get_pr_reviews: githubGetPrReviewsHandler(clients),
      github_get_pr_checks: githubGetPrChecksHandler(clients),
      github_search_prs: githubSearchPrsHandler(clients),
      github_update_pr: githubUpdatePrHandler(clients),
      github_create_pr_review_comment: githubCreatePrReviewCommentHandler(clients),
      github_get_pr_review_comments: githubGetPrReviewCommentsHandler(clients),
      github_update_pr_review_comment: githubUpdatePrReviewCommentHandler(clients),
      github_delete_pr_review_comment: githubDeletePrReviewCommentHandler(clients),
      github_submit_pr_review: githubSubmitPrReviewHandler(clients),
      github_get_pr_files: githubGetPrFilesHandler(clients),
      github_get_pr_commits: githubGetPrCommitsHandler(clients),
      github_get_file_contents: githubGetFileContentsHandler(clients),
      github_get_pr_review_threads: githubGetPrReviewThreadsHandler(clients),
      github_resolve_review_thread: githubResolveReviewThreadHandler(clients),
      github_unresolve_review_thread: githubUnresolveReviewThreadHandler(clients),
      github_delete_pr_issue_comment: githubDeletePrIssueCommentHandler(clients),
      github_merge_pr: githubMergePrHandler(clients),
      github_request_pr_reviewers: githubRequestPrReviewersHandler(clients),
      github_update_pr_labels: githubUpdatePrLabelsHandler(clients),
      github_update_pr_assignees: githubUpdatePrAssigneesHandler(clients),
      github_dismiss_pr_review: githubDismissPrReviewHandler(clients),
    };
  }

  getToolDescriptors(): ToolDescriptor[] {
    return githubToolDescriptors;
  }

  getResourceDescriptors(): ResourceDescriptor[] {
    return githubResourceDescriptors;
  }

  getResourceHandler(clients: { github: GitHubClient }): ResourceHandlerFn {
    return async (uri: string) => {
      if (uri.startsWith('github://prs/')) {
        const issueKey = uri.slice('github://prs/'.length);
        if (!issueKey) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Missing issue key');
        if (!ISSUE_KEY_PATTERN.test(issueKey)) {
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid issue key format: "${issueKey}"`);
        }
        const prs = await clients.github.searchPrs(issueKey);
        return {
          contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(prs) }],
        };
      }

      throw new ResourceNotFoundError(uri);
    };
  }
}
