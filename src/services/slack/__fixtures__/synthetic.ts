export const EXAMPLE_TEAM = {
  team_id: 'T0EXAMPLE1',
  team_domain: 'example-team',
  team_url: 'https://example-team.slack.com/',
  user_id: 'U0EXAMPLE01',
} as const;

export const OTHER_TEAM = {
  team_id: 'T0EXAMPLE2',
  team_domain: 'other-team',
  team_url: 'https://other-team.slack.com/',
  user_id: 'U0EXAMPLE02',
} as const;

export const CHANNEL_ID = 'C0EXAMPLE01';
export const DM_ID = 'D0EXAMPLE01';
export const GROUP_DM_ID = 'G0EXAMPLE01';
export const USER_ID = 'U0EXAMPLE01';
export const FILE_ID = 'F0EXAMPLE01';

export const ROOT_TS = '1700000000.000100';
export const REPLY_TS = '1700000000.000200';
export const ROOT_TS_PERMALINK_SEGMENT = 'p1700000000000100';
export const REPLY_TS_PERMALINK_SEGMENT = 'p1700000000000200';

export const TOKEN_SENTINEL = ['xox', 'p-synthetic-sentinel'].join('');
export const CAPTURED_TOKEN_SENTINEL = ['xox', 'c-captured-sentinel'].join('');
export const CAPTURED_COOKIE_SENTINEL = ['xox', 'd-captured-sentinel'].join('');
export const CLIENT_SECRET_SENTINEL = 'CLIENT-SECRET-SENTINEL';
export const AUTH_CODE_SENTINEL = 'AUTH-CODE-SENTINEL';
export const FILE_BYTES_SENTINEL = 'FILE-BYTES-SENTINEL';
export const CLIENT_ID_FIXTURE = '0000000000.fixture-client-id';

export const DASHBOARD_SESSION_SENTINEL = 'dashboard-session-sentinel';

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
  'files:read',
  'files:write',
] as const;

export interface TokenRecordFixture {
  access_token: string;
  scopes: string[];
  team_id: string;
  team_domain: string;
  team_url: string;
  user_id: string;
  saved_at: string;
  cookie?: string;
}

export function tokenRecord(overrides: Partial<TokenRecordFixture> = {}): TokenRecordFixture {
  return {
    access_token: TOKEN_SENTINEL,
    scopes: ['search:read', 'channels:history'],
    team_id: EXAMPLE_TEAM.team_id,
    team_domain: EXAMPLE_TEAM.team_domain,
    team_url: EXAMPLE_TEAM.team_url,
    user_id: EXAMPLE_TEAM.user_id,
    saved_at: '2026-10-30T12:00:00.000Z',
    ...overrides,
  };
}

/** The shape dev-dashboard writes: the Slack web client's own xoxc token and d cookie. */
export function capturedSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token: CAPTURED_TOKEN_SENTINEL,
    cookie: CAPTURED_COOKIE_SENTINEL,
    teamId: EXAMPLE_TEAM.team_id,
    teamDomain: EXAMPLE_TEAM.team_domain,
    savedAt: '2026-10-30T12:00:00.000Z',
    ...overrides,
  };
}

export function archiveLink(domain: string, channelId: string, permalinkSegment?: string, query?: string): string {
  const base = `https://${domain}.slack.com/archives/${channelId}`;
  const withMessage = permalinkSegment ? `${base}/${permalinkSegment}` : base;
  return query ? `${withMessage}?${query}` : withMessage;
}
