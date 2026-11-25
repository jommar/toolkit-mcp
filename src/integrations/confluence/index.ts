import { ConfluenceClient } from '../../services/index.js';
import { IntegrationModule, ToolHandlerFn, ToolDescriptor } from '../index.js';
import {
  confluenceSearchHandler,
  confluenceGetPageHandler,
  confluenceListSpacesHandler,
  confluenceCreatePageHandler,
  confluenceUpdatePageHandler,
  confluenceWhoamiHandler,
  confluenceToolDescriptors,
} from './module.js';

export class ConfluenceModule implements IntegrationModule<{ confluence: ConfluenceClient }> {
  readonly id = 'confluence';

  /** Confluence Cloud reuses the Atlassian (Jira) credentials unless CONFLUENCE_* overrides are set. */
  needsEnv(): boolean {
    const base = process.env.CONFLUENCE_BASE_URL || process.env.JIRA_BASE_URL;
    const email = process.env.CONFLUENCE_EMAIL || process.env.JIRA_EMAIL;
    const token = process.env.CONFLUENCE_TOKEN || process.env.JIRA_TOKEN;
    return !!(base && email && token);
  }

  createToolHandlers(clients: { confluence: ConfluenceClient }): Record<string, ToolHandlerFn> {
    return {
      confluence_search: confluenceSearchHandler(clients),
      confluence_get_page: confluenceGetPageHandler(clients),
      confluence_list_spaces: confluenceListSpacesHandler(clients),
      confluence_create_page: confluenceCreatePageHandler(clients),
      confluence_update_page: confluenceUpdatePageHandler(clients),
      confluence_whoami: confluenceWhoamiHandler(clients),
    };
  }

  getToolDescriptors(): ToolDescriptor[] {
    return confluenceToolDescriptors;
  }
}
