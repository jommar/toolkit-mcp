export const TOKEN_SENTINEL = ['xoxp', 'synthetic', 'sentinel'].join('-');
export const CLIENT_SECRET_SENTINEL = 'CLIENT-SECRET-SENTINEL';
export const AUTH_CODE_SENTINEL = 'AUTH-CODE-SENTINEL';
export const FILE_BYTES_SENTINEL = 'FILE-BYTES-SENTINEL';

export const MESSAGE_BODY_SENTINEL = 'MESSAGE-BODY-SENTINEL';
export const REAL_NAME_SENTINEL = 'REAL-NAME-SENTINEL';
export const TITLE_SENTINEL = 'TITLE-SENTINEL';
export const PHONE_SENTINEL = 'PHONE-SENTINEL-0100';
export const FIXTURE_EMAIL = 'email-sentinel@example.invalid';
export const FIXTURE_EMAIL_SELF = 'email-sentinel-self@example.invalid';
export const FIXTURE_EMAIL_DOMAIN = 'example.invalid';

export const CLIENT_ID = 'EXAMPLE-CLIENT-ID';

export const ALL_USER_SCOPES = [
  'search:read',
  'channels:history',
  'groups:history',
  'im:history',
  'mpim:history',
  'channels:read',
  'groups:read',
  'im:read',
  'mpim:read',
  'users:read',
  'users:read.email',
  'chat:write',
  'reactions:write',
  'files:write',
] as const;

export const EXAMPLE = {
  teamId: 'T0EXAMPLE1',
  otherTeamId: 'T0EXAMPLE2',
  teamDomain: 'example-team',
  otherTeamDomain: 'other-team',
  teamHost: 'example-team.slack.com',
  teamUrl: 'https://example-team.slack.com/',
  channelId: 'C0EXAMPLE01',
  channelName: 'example-channel',
  dmId: 'D0EXAMPLE01',
  meId: 'U0EXAMPLE01',
  meHandle: 'example-user',
  peerId: 'U0EXAMPLE02',
  peerHandle: 'example-peer',
  missingUserId: 'U0EXAMPLE99',
  fileId: 'F0EXAMPLE01',
  rootTs: '1700000000.000100',
  replyTs: '1700000000.000200',
  laterTs: '1700000000.000300',
  postedTs: '1700000000.000900',
  uploadUrl: 'https://example-team.slack.com/v1/EXAMPLE-UPLOAD',
} as const;

export const TOOL_NAMES = [
  'slack_login',
  'slack_logout',
  'slack_get_status',
  'slack_search_messages',
  'slack_get_messages',
  'slack_get_threads',
  'slack_get_channels',
  'slack_get_users',
  'slack_prepare_write',
  'slack_confirm_write',
] as const;

export function tsToLinkSegment(ts: string): string {
  return `p${ts.replace('.', '')}`;
}

export function channelLink(channelId: string = EXAMPLE.channelId): string {
  return `https://${EXAMPLE.teamHost}/archives/${channelId}`;
}

export function messageLink(channelId: string, ts: string): string {
  return `${channelLink(channelId)}/${tsToLinkSegment(ts)}`;
}
