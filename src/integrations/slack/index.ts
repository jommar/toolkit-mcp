import os from 'node:os';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SlackClient } from '../../services/slack/slack-client.js';
import { createSlackLogin } from '../../services/slack/slack-oauth.js';
import { slackPaths } from '../../services/slack/credential-store.js';
import type { IntegrationModule, ToolDescriptor, ToolHandlerFn } from '../index.js';
import {
  slackToolDescriptors,
  slackLoginSchema,
  slackLogoutSchema,
  slackGetStatusSchema,
  slackSearchMessagesSchema,
  slackGetMessagesSchema,
  slackGetThreadsSchema,
  slackGetChannelsSchema,
  slackGetUsersSchema,
  slackDownloadFileSchema,
} from './module.js';
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

type TextResult = { content: { type: 'text'; text: string }[] };

// Every Slack handler returns text content only; the registry's ToolHandlerFn is narrower than the SDK's CallToolResult.
function asTextResult<A>(handler: (args: A) => Promise<CallToolResult>): (args: A) => Promise<TextResult> {
  return async (args) => (await handler(args)) as TextResult;
}

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

    const login = asTextResult(slackLoginHandler(session));
    const logout = asTextResult(slackLogoutHandler(session));
    const status = asTextResult(slackGetStatusHandler(session));
    const search = asTextResult(slackSearchMessagesHandler(reads));
    const messages = asTextResult(slackGetMessagesHandler(reads));
    const threads = asTextResult(slackGetThreadsHandler(reads));
    const channels = asTextResult(slackGetChannelsHandler(reads));
    const users = asTextResult(slackGetUsersHandler(reads));
    const download = asTextResult(slackDownloadFileHandler(reads));
    const prepareWrite = slackPrepareWriteHandler(writes);
    const confirmWrite = slackConfirmWriteHandler(writes);

    return {
      slack_login: async (args) => login(slackLoginSchema.parse(args)),
      slack_logout: async (args) => logout(slackLogoutSchema.parse(args)),
      slack_get_status: async (args) => status(slackGetStatusSchema.parse(args)),
      slack_search_messages: async (args) => search(slackSearchMessagesSchema.parse(args)),
      slack_get_messages: async (args) => messages(slackGetMessagesSchema.parse(args)),
      slack_get_threads: async (args) => threads(slackGetThreadsSchema.parse(args)),
      slack_get_channels: async (args) => channels(slackGetChannelsSchema.parse(args)),
      slack_get_users: async (args) => users(slackGetUsersSchema.parse(args)),
      slack_download_file: async (args) => download(slackDownloadFileSchema.parse(args)),
      slack_prepare_write: prepareWrite,
      slack_confirm_write: confirmWrite,
    };
  }

  getToolDescriptors(): ToolDescriptor[] {
    return slackToolDescriptors;
  }
}
