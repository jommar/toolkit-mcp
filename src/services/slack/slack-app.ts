const HISTORY_SCOPES = ['channels:history', 'groups:history', 'im:history', 'mpim:history'] as const;
const READ_SCOPES = ['channels:read', 'groups:read', 'im:read', 'mpim:read'] as const;

// Each tool's user-token scopes; the manifest must request exactly their union.
export const TOOL_SCOPES = {
  slack_login: [],
  slack_logout: [],
  slack_get_status: [],
  slack_search_messages: ['search:read'],
  slack_get_messages: HISTORY_SCOPES,
  slack_get_threads: HISTORY_SCOPES,
  slack_get_channels: [...READ_SCOPES, 'search:read'],
  slack_get_users: ['users:read', 'users:read.email'],
  slack_prepare_write: [...HISTORY_SCOPES, ...READ_SCOPES, 'users:read'],
  slack_confirm_write: ['chat:write', 'reactions:write', 'files:write'],
} as const;

// Registered in the Slack app manifest as its redirect URL; changing the port means updating the app.
export const OAUTH_CALLBACK_PORT = 53682;
export const OAUTH_CALLBACK_PATH = '/slack/oauth/callback';
export const OAUTH_REDIRECT_URL = `http://localhost:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`;
