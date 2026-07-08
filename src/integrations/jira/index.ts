import { JiraClient } from '../../services/index.js';
import { IntegrationModule, ToolHandlerFn, ToolDescriptor } from '../index.js';
import {
  jiraWhoamiHandler,
  jiraGetIssuesHandler,
  jiraCreateIssueHandler,
  jiraUpdateIssueHandler,
  jiraTransitionIssueHandler,
  jiraAssignIssueHandler,
  jiraAddCommentHandler,
  jiraUpdateCommentHandler,
  jiraLinkIssuesHandler,
  jiraGetAttachmentHandler,
  jiraWhoamiSchema,
  jiraGetIssuesSchema,
  jiraCreateIssueSchema,
  jiraUpdateIssueSchema,
  jiraTransitionIssueSchema,
  jiraAssignIssueSchema,
  jiraAddCommentSchema,
  jiraUpdateCommentSchema,
  jiraLinkIssuesSchema,
  jiraGetAttachmentSchema,
  jiraCreateIssuePromptSchema,
  jiraTriageIssuePromptSchema,
  jiraToolDescriptors,
} from './module.js';

/** Restricted JQL keywords that are not allowed in resource URI queries. */
const RESTRICTED_JQL_KEYWORDS = [
  /delete/i,
  /update/i,
  /create/i,
  /insert/i,
  /drop/i,
  /alter/i,
  /exec/i,
  /admin/i,
];

function validateJql(jql: string): void {
  for (const pattern of RESTRICTED_JQL_KEYWORDS) {
    if (pattern.test(jql)) {
      throw new Error(`JQL contains restricted keyword: "${pattern.source}"`);
    }
  }
}

export class JiraModule implements IntegrationModule<{ jira: JiraClient }> {
  readonly id = 'jira';

  needsEnv(): boolean {
    return !!(process.env.JIRA_BASE_URL && process.env.JIRA_EMAIL && process.env.JIRA_TOKEN);
  }

  createToolHandlers(clients: { jira: JiraClient }): Record<string, ToolHandlerFn> {
    return {
      jira_whoami: async (args) => {
        const parsed = jiraWhoamiSchema.parse(args);
        return await jiraWhoamiHandler(clients)(parsed);
      },
      jira_get_issues: async (args) => {
        const parsed = jiraGetIssuesSchema.parse(args);
        return await jiraGetIssuesHandler(clients)(parsed);
      },
      jira_create_issue: async (args) => {
        const parsed = jiraCreateIssueSchema.parse(args);
        return await jiraCreateIssueHandler(clients)(parsed);
      },
      jira_update_issue: async (args) => {
        const parsed = jiraUpdateIssueSchema.parse(args);
        return await jiraUpdateIssueHandler(clients)(parsed);
      },
      jira_transition_issue: async (args) => {
        const parsed = jiraTransitionIssueSchema.parse(args);
        return await jiraTransitionIssueHandler(clients)(parsed);
      },
      jira_assign_issue: async (args) => {
        const parsed = jiraAssignIssueSchema.parse(args);
        return await jiraAssignIssueHandler(clients)(parsed);
      },
      jira_add_comment: async (args) => {
        const parsed = jiraAddCommentSchema.parse(args);
        return await jiraAddCommentHandler(clients)(parsed);
      },
      jira_update_comment: async (args) => {
        const parsed = jiraUpdateCommentSchema.parse(args);
        return await jiraUpdateCommentHandler(clients)(parsed);
      },
      jira_link_issues: async (args) => {
        const parsed = jiraLinkIssuesSchema.parse(args);
        return await jiraLinkIssuesHandler(clients)(parsed);
      },
      jira_get_attachment: async (args) => {
        const parsed = jiraGetAttachmentSchema.parse(args);
        return await jiraGetAttachmentHandler(clients)(parsed);
      },
    };
  }

  getToolDescriptors(): ToolDescriptor[] {
    return jiraToolDescriptors;
  }

  getResourceHandler(clients: { jira: JiraClient }) {
    return async (uri: string) => {
      if (uri.startsWith('jira://issue/')) {
        const key = uri.slice('jira://issue/'.length);
        if (!key) throw new Error('Missing issue key');
        const issue = await clients.jira.getIssueSlim(key);
        return {
          contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(issue) }],
        };
      }

      if (uri.startsWith('jira://search/')) {
        const jql = decodeURIComponent(uri.slice('jira://search/'.length));
        if (!jql) throw new Error('Missing JQL query');
        validateJql(jql);
        const issues = await clients.jira.searchSlim(jql, { maxResults: 20 });
        return {
          contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(issues) }],
        };
      }

      if (uri === 'jira://myself') {
        const user = await clients.jira.whoami();
        return {
          contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(user) }],
        };
      }

      throw new Error(`Unknown resource: ${uri}`);
    };
  }

  getPromptHandler(clients: { jira: JiraClient }) {
    return async (name: string, args: Record<string, unknown> | undefined) => {
      if (name === 'create-issue') {
        const parsed = jiraCreateIssuePromptSchema.parse(args ?? {});

        let hints = '';
        if (parsed.priority) hints += `\n- Priority: ${parsed.priority}`;
        if (parsed.labels?.length) hints += `\n- Labels: ${parsed.labels.join(', ')}`;
        if (parsed.description) hints += `\n- Description provided`;

        return {
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Create a Jira issue in project ${parsed.projectKey}:\n- Type: ${parsed.issueType}\n- Summary: ${parsed.summary}${hints}\n\nUse jira_create_issue to create this issue.`,
              },
            },
          ],
        };
      }

      if (name === 'triage-issue') {
        const parsed = jiraTriageIssuePromptSchema.parse(args ?? {});

        const issue = await clients.jira.getIssueSlim(parsed.key);
        const transitions = await clients.jira.listTransitions(parsed.key);

        const commentsText = issue.comments
          .map((c) => `  [${c.created}] ${c.author}: ${c.body}`)
          .join('\n');

        return {
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Triage analysis for ${parsed.key}:\n\nSummary: ${issue.summary}\nStatus: ${issue.status ?? 'unknown'}\nAssignee: ${issue.assignee ?? 'unassigned'}\nType: ${issue.type ?? 'unknown'}\nPriority: ${issue.priority ?? 'none'}\n\nDescription:\n${issue.description ?? '(no description)'}\n\nAvailable transitions:\n${transitions.map((t) => `  - ${t.name} (${t.id})`).join('\n')}\n\nComments:\n${commentsText || '(none)'}`,
              },
            },
          ],
        };
      }

      throw new Error(`Unknown prompt: ${name}`);
    };
  }
}
