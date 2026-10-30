import { isSlackTs } from './slack-model.js';

export type LinkKind = 'conversation' | 'message' | 'user' | 'file';

export interface ResolvedLink {
  kind: LinkKind;
  team_id?: string;
  team_domain?: string;
  channel_id?: string;
  ts?: string;
  thread_ts?: string;
  user_id?: string;
  file_id?: string;
}

export type LinkResolution =
  | { ok: true; link: ResolvedLink }
  | { ok: false; error: { code: 'unrecognized_link'; message: string } };

export type WorkspaceCheck = { ok: true } | { ok: false; error: { code: 'wrong_workspace'; message: string } };

const UNRECOGNIZED_LINK_MESSAGE =
  'Not a Slack link this tool reads. Use a channel, DM or message link (https://<team>.slack.com/archives/...), ' +
  'a web-client link (https://app.slack.com/client/...), a user profile link, or a file link.';

const APP_HOST = 'app.slack.com';
const WORKSPACE_HOST_SUFFIX = '.slack.com';

const ARCHIVE_CONVERSATION = /^\/archives\/([CDG][A-Z0-9]+)$/;
const ARCHIVE_MESSAGE = /^\/archives\/([CDG][A-Z0-9]+)\/p(\d{10})(\d{6})$/;
const USER_PROFILE = /^\/team\/([UW][A-Z0-9]+)$/;
const FILE_LINK = /^\/files\/[UW][A-Z0-9]+\/(F[A-Z0-9]+)(?:\/[^/]*)?$/;
const WEB_CHANNEL = /^\/client\/([TE][A-Z0-9]+)\/([CDG][A-Z0-9]+)(?:\/.*)?$/;
const WEB_THREAD = /^\/client\/([TE][A-Z0-9]+)\/([CDG][A-Z0-9]+)\/thread\/\2-(\d{10}\.\d{6})(?:\/.*)?$/;
const WEB_THREAD_VIEW = /^\/client\/[^/]+\/[^/]+\/thread(?:\/|$)/;

export function resolveLink(url: string): LinkResolution {
  const link = parseSlackUrl(url);
  if (!link) return { ok: false, error: { code: 'unrecognized_link', message: UNRECOGNIZED_LINK_MESSAGE } };
  return { ok: true, link };
}

export function matchesWorkspace(link: ResolvedLink, token: { team_id: string; team_domain: string }): WorkspaceCheck {
  const belongsToToken =
    link.team_domain !== undefined ? link.team_domain === token.team_domain : link.team_id === token.team_id;
  if (belongsToToken) return { ok: true };

  return {
    ok: false,
    error: {
      code: 'wrong_workspace',
      message: `This link is from another workspace. The connected workspace is ${token.team_domain}.`,
    },
  };
}

function parseSlackUrl(url: string): ResolvedLink | null {
  const parsed = parseHttpsUrl(url);
  if (!parsed) return null;

  const path = parsed.pathname.replace(/\/+$/, '');
  if (parsed.hostname === APP_HOST) return parseWebClientPath(path);
  if (!parsed.hostname.endsWith(WORKSPACE_HOST_SUFFIX)) return null;

  const [teamDomain] = parsed.hostname.split('.');
  return parseWorkspacePath(teamDomain, path, parsed.searchParams);
}

function parseHttpsUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

function parseWorkspacePath(teamDomain: string, path: string, query: URLSearchParams): ResolvedLink | null {
  const message = ARCHIVE_MESSAGE.exec(path);
  if (message) {
    const threadTs = query.get('thread_ts') ?? '';
    return {
      kind: 'message',
      team_domain: teamDomain,
      channel_id: message[1],
      ts: `${message[2]}.${message[3]}`,
      thread_ts: isSlackTs(threadTs) ? threadTs : undefined,
    };
  }

  const conversation = ARCHIVE_CONVERSATION.exec(path);
  if (conversation) return { kind: 'conversation', team_domain: teamDomain, channel_id: conversation[1] };

  const user = USER_PROFILE.exec(path);
  if (user) return { kind: 'user', team_domain: teamDomain, user_id: user[1] };

  const file = FILE_LINK.exec(path);
  if (file) return { kind: 'file', team_domain: teamDomain, file_id: file[1] };

  return null;
}

function parseWebClientPath(path: string): ResolvedLink | null {
  const thread = WEB_THREAD.exec(path);
  if (thread) return { kind: 'message', team_id: thread[1], channel_id: thread[2], ts: thread[3] };

  const channel = WEB_CHANNEL.exec(path);
  if (!channel || WEB_THREAD_VIEW.test(path)) return null;
  return { kind: 'conversation', team_id: channel[1], channel_id: channel[2] };
}
