import { ProtocolError, ProtocolErrorCode, ResourceNotFoundError } from '@modelcontextprotocol/server';
import { JiraClient, ISSUE_KEY_PATTERN } from '../../services/index.js';
import {
  IntegrationModule,
  PromptDescriptor,
  PromptHandlerFn,
  ResourceDescriptor,
  ResourceHandlerFn,
  ToolDescriptor,
  ToolHandlerFn,
} from '../index.js';
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
  jiraGetCommentsHandler,
  jiraGetChangelogsHandler,
  jiraListTransitionsHandler,
  jiraListIssueLinkTypesHandler,
  jiraSearchUsersHandler,
  jiraListFieldsHandler,
  jiraListComponentsHandler,
  jiraDeleteCommentHandler,
  jiraCreateIssuePromptSchema,
  jiraTriageIssuePromptSchema,
  jiraToolDescriptors,
  jiraResourceDescriptors,
  jiraPromptDescriptors,
  type JiraToolClients,
} from './module.js';

export class JiraModule implements IntegrationModule<JiraToolClients> {
  readonly id = 'jira';

  needsEnv(): boolean {
    return !!(process.env.JIRA_BASE_URL && process.env.JIRA_EMAIL && process.env.JIRA_TOKEN);
  }

  createToolHandlers(clients: JiraToolClients): Record<string, ToolHandlerFn> {
    return {
      jira_whoami: jiraWhoamiHandler(clients),
      jira_get_issues: jiraGetIssuesHandler(clients),
      jira_create_issue: jiraCreateIssueHandler(clients),
      jira_update_issue: jiraUpdateIssueHandler(clients),
      jira_transition_issue: jiraTransitionIssueHandler(clients),
      jira_assign_issue: jiraAssignIssueHandler(clients),
      jira_add_comment: jiraAddCommentHandler(clients),
      jira_update_comment: jiraUpdateCommentHandler(clients),
      jira_link_issues: jiraLinkIssuesHandler(clients),
      jira_get_attachment: jiraGetAttachmentHandler(clients),
      jira_get_comments: jiraGetCommentsHandler(clients),
      jira_get_changelogs: jiraGetChangelogsHandler(clients),
      jira_list_transitions: jiraListTransitionsHandler(clients),
      jira_list_issue_link_types: jiraListIssueLinkTypesHandler(clients),
      jira_search_users: jiraSearchUsersHandler(clients),
      jira_list_fields: jiraListFieldsHandler(clients),
      jira_list_components: jiraListComponentsHandler(clients),
      jira_delete_comment: jiraDeleteCommentHandler(clients),
    };
  }

  getToolDescriptors(): ToolDescriptor[] {
    return jiraToolDescriptors;
  }

  getResourceDescriptors(): ResourceDescriptor[] {
    return jiraResourceDescriptors;
  }

  getResourceHandler(clients: { jira: JiraClient }): ResourceHandlerFn {
    return async (uri: string) => {
      if (uri.startsWith('jira://issue/')) {
        const key = uri.slice('jira://issue/'.length);
        if (!key) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Missing issue key');
        if (!ISSUE_KEY_PATTERN.test(key)) {
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid issue key format: "${key}"`);
        }
        const issue = await clients.jira.getIssueSlim(key);
        return {
          contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(issue) }],
        };
      }

      if (uri.startsWith('jira://search/')) {
        const jql = decodeURIComponent(uri.slice('jira://search/'.length));
        if (!jql) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Missing JQL query');
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

      throw new ResourceNotFoundError(uri);
    };
  }

  getPromptDescriptors(): PromptDescriptor[] {
    return jiraPromptDescriptors;
  }

  getPromptHandler(clients: { jira: JiraClient }): PromptHandlerFn {
    return async (name: string, args: Record<string, unknown> | undefined) => {
      if (name === 'create-issue') {
        const parsed = jiraCreateIssuePromptSchema.parse(args ?? {});

        const labels = (parsed.labels ?? '').split(',').map((label) => label.trim()).filter(Boolean);
        let hints = '';
        if (parsed.priority) hints += `\n- Priority: ${parsed.priority}`;
        if (labels.length) hints += `\n- Labels: ${labels.join(', ')}`;
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
