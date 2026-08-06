import { ConfluenceClient } from '../../services/index.js';
import { IntegrationModule, ToolHandlerFn, ToolDescriptor } from '../index.js';
import {
  confluenceSearchHandler,
  confluenceSearchSchema,
  confluenceGetPageHandler,
  confluenceGetPageSchema,
  confluenceListSpacesHandler,
  confluenceListSpacesSchema,
  confluenceCreatePageHandler,
  confluenceCreatePageSchema,
  confluenceUpdatePageHandler,
  confluenceUpdatePageSchema,
  confluenceWhoamiHandler,
  confluenceWhoamiSchema,
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
      confluence_search: async (args) => {
        const parsed = confluenceSearchSchema.parse(args);
        return await confluenceSearchHandler(clients)(parsed);
      },
      confluence_get_page: async (args) => {
        const parsed = confluenceGetPageSchema.parse(args);
        return await confluenceGetPageHandler(clients)(parsed);
      },
      confluence_list_spaces: async (args) => {
        const parsed = confluenceListSpacesSchema.parse(args);
        return await confluenceListSpacesHandler(clients)(parsed);
      },
      confluence_create_page: async (args) => {
        const parsed = confluenceCreatePageSchema.parse(args);
        return await confluenceCreatePageHandler(clients)(parsed);
      },
      confluence_update_page: async (args) => {
        const parsed = confluenceUpdatePageSchema.parse(args);
        return await confluenceUpdatePageHandler(clients)(parsed);
      },
      confluence_whoami: async (args) => {
        const parsed = confluenceWhoamiSchema.parse(args);
        return await confluenceWhoamiHandler(clients)(parsed);
      },
    };
  }

  getToolDescriptors(): ToolDescriptor[] {
    return confluenceToolDescriptors;
  }
}
