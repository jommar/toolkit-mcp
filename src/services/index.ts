export { JiraClient, describeError } from './jira/jira-client.js';
export { GitHubClient, describeGitHubError } from './github/github-client.js';
export { FigmaClient } from './figma/figma-client.js';
export { ConfluenceClient, describeConfluenceError, storageToText } from './confluence/confluence-client.js';
export type { JiraConfig, ConfluenceConfig } from './config.js';
export { loadConfig, loadConfluenceConfig } from './config.js';
export type {
  JiraUser,
  JiraIssue,
  SearchResult,
  JiraTransition,
  JiraComment,
  IssueLinkType,
} from './jira/jira-client.js';
export type { PrInfo, PrSearchResult, PrCreated, PrComment, BranchInfo, PullRequestDetail, PullRequestReview, CheckRun, PullRequestChecks, PrSearchOptions, PrReviewComment, CreateReviewCommentInput, PrReviewSubmitted, PrReviewEvent, SubmitPrReviewInput } from './github/github-client.js';
export type {
  FigmaUser,
  FigmaFileResponse,
  FigmaNodesResponse,
  FigmaImagesResponse,
  FigmaComment,
  FigmaStyle,
  FigmaVariablesResponse,
  FigmaVersion,
} from './figma/figma-client.js';
export type {
  ConfluenceUser,
  ConfluenceSpace,
  ConfluenceSearchResult,
  ConfluencePage,
  Paged,
} from './confluence/confluence-client.js';
export { DEV_FIELDS, toSlimIssue, toSlimComment, toSlimAttachment, adfToText } from './slim.js';
export type { SlimIssue, SlimComment, SlimAttachment } from './slim.js';
