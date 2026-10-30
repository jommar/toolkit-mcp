export interface FixtureTeam {
  readonly id: string;
  readonly domain: string;
  readonly url: string;
}

export const EXAMPLE_TEAM: FixtureTeam = {
  id: 'T0EXAMPLE1',
  domain: 'example-team',
  url: 'https://example-team.slack.com',
};

export const OTHER_TEAM: FixtureTeam = {
  id: 'T0EXAMPLE2',
  domain: 'other-team',
  url: 'https://other-team.slack.com',
};

export const CHANNEL_ONE = 'C0EXAMPLE01';
export const CHANNEL_TWO = 'C0EXAMPLE02';
export const CHANNEL_THREE = 'C0EXAMPLE03';
export const DM_ONE = 'D0EXAMPLE01';
export const USER_ME = 'U0EXAMPLE01';
export const USER_PARTNER = 'U0EXAMPLE05';
export const USER_THIRD = 'U0EXAMPLE07';
export const BOT_ONE = 'B0EXAMPLE01';
export const FILE_ONE = 'F0EXAMPLE01';

export const MESSAGE_TEXT_MARKER = 'FIXTURE-MESSAGE-TEXT';
export const EMAIL_SENTINEL_ADDRESS = 'email-sentinel@example.invalid';

const BASE_EPOCH_SECONDS = 1_700_000_000;

/** A synthetic Slack ts, `n` seconds after the fixture epoch. */
export function tsFor(n: number): string {
  return `${BASE_EPOCH_SECONDS + n}.000100`;
}

/** The sixteen-digit `p` segment Slack puts in permalinks. */
export function permalinkSegment(ts: string): string {
  return `p${ts.replace('.', '')}`;
}

export function channelLink(team: FixtureTeam, conversationId: string): string {
  return `${team.url}/archives/${conversationId}`;
}

export function messageLink(team: FixtureTeam, conversationId: string, ts: string): string {
  return `${channelLink(team, conversationId)}/${permalinkSegment(ts)}`;
}

export function replyLink(
  team: FixtureTeam,
  conversationId: string,
  replyTs: string,
  rootTs: string,
): string {
  return `${messageLink(team, conversationId, replyTs)}?thread_ts=${rootTs}&cid=${conversationId}`;
}

export function clientThreadLink(team: FixtureTeam, conversationId: string, rootTs: string): string {
  return `https://app.slack.com/client/${team.id}/${conversationId}/thread/${conversationId}-${rootTs}`;
}

export function userLink(team: FixtureTeam, userId: string): string {
  return `${team.url}/team/${userId}`;
}

export function fileLink(team: FixtureTeam, userId: string, fileId: string): string {
  return `${team.url}/files/${userId}/${fileId}/name.txt`;
}
