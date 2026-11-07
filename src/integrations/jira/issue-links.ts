import { describeGitHubError } from '../../services/index.js';
import type { GitHubClient, PrInfo, SlackClient } from '../../services/index.js';
import { findThreadsForIssueKey, type IssueThread } from '../../services/slack/issue-threads.js';

// The GitHub cap mirrors the one inside GitHubClient.findPrsForIssueKeys, which skips keys beyond it.
const GITHUB_ISSUE_LIMIT = 20;
// Slack costs one search call per issue, so it looks at fewer issues than GitHub's single batched search.
const SLACK_ISSUE_LIMIT = 10;
const SLACK_NOT_CONNECTED_CODE = 'not_connected';
const SOURCE_LABEL: Record<LinkSource, string> = { github: 'GitHub', slack: 'Slack' };
const GITHUB_INACTIVE_MESSAGE = 'GitHub integration is not active (GH_TOKEN not set)';
const SLACK_INACTIVE_MESSAGE =
  'Slack integration is not active (SLACK_ENABLED not true or no session; run slack_login)';

export interface IssueLinkFlags {
  includeGithubPrs?: boolean;
  includeSlackThreads?: boolean;
}

export interface IssueLinkClients {
  github?: GitHubClient;
  slack?: SlackClient;
}

export type LinkSource = 'github' | 'slack';

export interface LinkWarning {
  source: LinkSource;
  message: string;
}

export interface PullRequestLink {
  number: number;
  title: string;
  state: PrInfo['state'];
  repo: string;
  htmlUrl: string;
  reviewStatus: PrInfo['reviewStatus'];
}

/** The links found for each issue key looked up; a key that was not looked up has no entry. */
interface Lookup<L> {
  linksByKey: Map<string, L[]>;
  warnings: LinkWarning[];
}

/**
 * Adds `pullRequests` and `slackThreads` to each issue whose flag is set. An empty array means the lookup ran
 * and found nothing; no key means it did not run, so a warning says why. A failing lookup never fails the call.
 */
export async function attachIssueLinks<T extends { key: string }>(
  issues: T[],
  flags: IssueLinkFlags,
  clients: IssueLinkClients,
): Promise<{
  items: Array<T & { pullRequests?: PullRequestLink[]; slackThreads?: IssueThread[] }>;
  warnings: LinkWarning[];
}> {
  if (!flags.includeGithubPrs && !flags.includeSlackThreads) return { items: issues, warnings: [] };

  const keys = issues.map((issue) => issue.key);
  const [pullRequests, slackThreads] = await Promise.all([
    flags.includeGithubPrs ? findPullRequests(clients.github, keys) : skipped<PullRequestLink>(),
    flags.includeSlackThreads ? findSlackThreads(clients.slack, keys) : skipped<IssueThread>(),
  ]);
  return {
    items: issues.map((issue) => ({
      ...issue,
      pullRequests: pullRequests.linksByKey.get(issue.key),
      slackThreads: slackThreads.linksByKey.get(issue.key),
    })),
    warnings: [...pullRequests.warnings, ...slackThreads.warnings],
  };
}

function skipped<L>(): Lookup<L> {
  return { linksByKey: new Map(), warnings: [] };
}

function unavailable<L>(source: LinkSource, message: string): Lookup<L> {
  return { linksByKey: new Map(), warnings: [{ source, message }] };
}

function limitWarnings(source: LinkSource, limit: number, total: number): LinkWarning[] {
  if (total <= limit) return [];
  return [{ source, message: `${SOURCE_LABEL[source]} lookup was limited to the first ${limit} of ${total} issues.` }];
}

async function findPullRequests(github: GitHubClient | undefined, keys: string[]): Promise<Lookup<PullRequestLink>> {
  if (!github) return unavailable('github', GITHUB_INACTIVE_MESSAGE);
  const lookedUp = keys.slice(0, GITHUB_ISSUE_LIMIT);
  try {
    const found = await github.findPrsForIssueKeys(lookedUp, 'all');
    return {
      linksByKey: new Map(lookedUp.map((key) => [key, (found.get(key) ?? []).map(toPullRequestLink)])),
      warnings: limitWarnings('github', GITHUB_ISSUE_LIMIT, keys.length),
    };
  } catch (error) {
    return unavailable('github', `GitHub lookup failed: ${describeGitHubError(error)}`);
  }
}

function toPullRequestLink({ number, title, state, repo, htmlUrl, reviewStatus }: PrInfo): PullRequestLink {
  return { number, title, state, repo, htmlUrl, reviewStatus };
}

async function findSlackThreads(slack: SlackClient | undefined, keys: string[]): Promise<Lookup<IssueThread>> {
  if (!slack) return unavailable('slack', SLACK_INACTIVE_MESSAGE);
  const lookedUp = keys.slice(0, SLACK_ISSUE_LIMIT);
  let teamUrl: string;
  try {
    teamUrl = await slack.teamUrl();
  } catch (error) {
    const reason = isNotConnected(error) ? SLACK_INACTIVE_MESSAGE : `Slack lookup failed: ${messageOf(error)}`;
    return unavailable('slack', reason);
  }
  const { linksByKey, warnings } = await searchThreads(slack, teamUrl, lookedUp);
  return { linksByKey, warnings: [...warnings, ...limitWarnings('slack', SLACK_ISSUE_LIMIT, keys.length)] };
}

// One search per issue, run together; an issue whose search failed gets no entry and shares a warning with
// the other issues that failed the same way.
async function searchThreads(slack: SlackClient, teamUrl: string, keys: string[]): Promise<Lookup<IssueThread>> {
  const settled = await Promise.allSettled(keys.map((key) => findThreadsForIssueKey(slack, teamUrl, key)));
  const linksByKey = new Map<string, IssueThread[]>();
  const failedKeysByMessage = new Map<string, string[]>();
  settled.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled') {
      linksByKey.set(keys[index], outcome.value);
      return;
    }
    const message = messageOf(outcome.reason);
    failedKeysByMessage.set(message, [...(failedKeysByMessage.get(message) ?? []), keys[index]]);
  });
  const warnings = [...failedKeysByMessage].map(([message, failedKeys]): LinkWarning => ({
    source: 'slack',
    message: `Slack lookup failed for ${failedKeys.join(', ')}: ${message}`,
  }));
  return { linksByKey, warnings };
}

function isNotConnected(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === SLACK_NOT_CONNECTED_CODE;
}

// SlackClient errors carry their own safe message; the request, which holds the token, stays out of it.
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
