import os from 'node:os';
import type { SlackClient } from '../../services/slack/slack-client.js';
import { createSlackLogin } from '../../services/slack/slack-oauth.js';
import { slackPaths } from '../../services/slack/credential-store.js';
import type { IntegrationModule, ToolDescriptor, ToolHandlerFn } from '../index.js';
import { slackToolDescriptors } from './module.js';
import { slackDownloadFileHandler } from './download-tools.js';
import {
  slackGetChannelsHandler,
  slackGetMessagesHandler,
  slackGetThreadsHandler,
  slackGetUsersHandler,
  slackSearchMessagesHandler,
} from './read-tools.js';
import { slackConfirmWriteHandler, slackPrepareWriteHandler, type FrozenWrite } from './write-tools.js';
import { slackGetStatusHandler, slackLoginHandler, slackLogoutHandler } from './session-tools.js';
import { WriteGate } from './write-gate.js';

export class SlackModule implements IntegrationModule<{ slack: SlackClient }> {
  readonly id = 'slack';

  needsEnv(): boolean {
    return process.env.SLACK_ENABLED === 'true';
  }

  createToolHandlers(clients: { slack: SlackClient }): Record<string, ToolHandlerFn> {
    const oauth = createSlackLogin({ paths: slackPaths(os.homedir()) });
    // Looked up per call, so a clock replaced after these handlers are built is still honored.
    const now = () => Date.now();
    const session = { slack: clients.slack, oauth, now };
    const reads = { slack: clients.slack, oauth, now };
    const writes = { slack: clients.slack, gate: new WriteGate<FrozenWrite>() };

    return {
      slack_login: slackLoginHandler(session),
      slack_logout: slackLogoutHandler(session),
      slack_get_status: slackGetStatusHandler(session),
      slack_search_messages: slackSearchMessagesHandler(reads),
      slack_get_messages: slackGetMessagesHandler(reads),
      slack_get_threads: slackGetThreadsHandler(reads),
      slack_get_channels: slackGetChannelsHandler(reads),
      slack_get_users: slackGetUsersHandler(reads),
      slack_download_file: slackDownloadFileHandler(reads),
      slack_prepare_write: slackPrepareWriteHandler(writes),
      slack_confirm_write: slackConfirmWriteHandler(writes),
    };
  }

  getToolDescriptors(): ToolDescriptor[] {
    return slackToolDescriptors;
  }
}
