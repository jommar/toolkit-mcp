import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { resolveDownloadTarget, saveDownload } from '../../services/slack/download-target.js';
import type { TokenRecord } from '../../services/slack/credential-store.js';
import { TOOL_SCOPES } from '../../services/slack/slack-app.js';
import type { SlackFile } from '../../services/slack/slack-client.js';
import { callError, connectedTeam, jsonResult, locate, type ReadToolContext } from './read-tools.js';

export interface DownloadFileArgs {
  file: string;
  path: string;
  overwrite?: boolean;
}

const [FILES_READ_SCOPE] = TOOL_SCOPES.slack_download_file;
const HOSTED_MODES: ReadonlySet<string | undefined> = new Set(['hosted', 'snippet']);
const UNKNOWN_TYPE = 'application/octet-stream';
const NOTHING_SAVED = 'Nothing was saved.';
const RELOGIN_STEP = 'Call slack_logout, then slack_login.';
const REAUTHORIZE_STEP =
  `Add ${FILES_READ_SCOPE} to the Slack app if it is missing there, call slack_logout, ` +
  'then slack_login and approve every scope.';
const BROWSER_SESSION_STEP =
  'This login is a browser session and Slack may not serve files to one: reconnect Slack in dev-dashboard in case ' +
  'it expired, then if it fails again call slack_logout and log in with the Slack app (point SLACK_SESSION_FILE ' +
  'at a missing path, restart, call slack_login).';
// Errors from the link check, the target check and the client that this tool reports under their own code;
// anything else, such as an fs error, is rethrown as it came so no raw Node code reaches a caller as a slack. code.
const REPORTED_CODES: ReadonlySet<string> = new Set([
  'unrecognized_link',
  'wrong_link_kind',
  'wrong_workspace',
  'path_not_absolute',
  'path_not_found',
  'not_a_file',
  'target_exists',
  'session_rejected',
  'rate_limited',
  'unreachable',
  'slack_error',
  'file_not_downloadable',
  'download_not_authorized',
  'download_failed',
]);

export function slackDownloadFileHandler(ctx: ReadToolContext) {
  return async (args: DownloadFileArgs): Promise<CallToolResult> => {
    const team = await connectedTeam(ctx);
    try {
      return jsonResult(await downloadFile(ctx, team, args));
    } catch (error) {
      throw reported(error, team);
    }
  };
}

async function downloadFile(ctx: ReadToolContext, team: TokenRecord, args: DownloadFileArgs) {
  // A browser session has no scope list, so only an app login can be known to lack the scope.
  if (team.scopes && !team.scopes.includes(FILES_READ_SCOPE)) {
    throw callError('scope_missing', `This login was not granted ${FILES_READ_SCOPE}.`, REAUTHORIZE_STEP);
  }
  // A file link always carries the file id, so this assertion cannot fail.
  const fileId = locate(args.file, ['file'], team).file_id!;
  const target = await resolveDownloadTarget(args.path, args.overwrite ?? false);
  const { file } = await ctx.slack.filesInfo({ file: fileId });
  const source = downloadableSource(file);
  const { body, contentType } = await ctx.slack.openFileDownload(source.url);
  if (isSignInPage(contentType, file.mimetype)) {
    body.destroy();
    throw callError(
      'download_not_authorized',
      'Slack answered a sign-in page where the file should be.',
      authorizationStep(team),
    );
  }
  const saved = await saveDownload(body, target, source.size);
  return {
    path: saved.path,
    name: saved.name,
    size: saved.size,
    type: file.mimetype ?? UNKNOWN_TYPE,
    sha256: saved.sha256,
  };
}

// Only files Slack stores itself are fetched: any other mode can name an address on a host Slack does not control.
function downloadableSource(file: SlackFile): { url: string; size: number } {
  const refuse = (reason: string) => callError('file_not_downloadable', reason, NOTHING_SAVED);
  if (file.is_deleted) throw refuse('The file was deleted.');
  if (file.is_tombstoned) throw refuse('The file is tombstoned: Slack no longer holds it.');
  if (file.is_external) throw refuse('The file is external, so Slack does not store it.');
  if (!HOSTED_MODES.has(file.mode)) {
    throw refuse(`Only hosted files and snippets can be downloaded, not a file of mode ${file.mode ?? 'unknown'}.`);
  }
  const { size } = file;
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
    throw refuse('Slack did not report the size of the file.');
  }
  const url = file.url_private_download || file.url_private;
  if (!url) throw refuse('Slack gave no download address for the file.');
  return { url, size };
}

function isSignInPage(contentType: string | undefined, mimetype: string | undefined): boolean {
  return isHtml(contentType) && !isHtml(mimetype);
}

function isHtml(type: string | undefined): boolean {
  return type?.toLowerCase().startsWith('text/html') ?? false;
}

function reported(error: unknown, team: TokenRecord): unknown {
  const { code, retry_after_s } = (error ?? {}) as { code?: unknown; retry_after_s?: unknown };
  if (typeof code !== 'string' || !REPORTED_CODES.has(code)) return error;
  return callError(code, (error as Error).message, nextStep(code, retry_after_s, team));
}

function nextStep(code: string, retryAfterSeconds: unknown, team: TokenRecord): string {
  switch (code) {
    case 'session_rejected':
      return RELOGIN_STEP;
    case 'rate_limited':
      return `Retry in ${String(retryAfterSeconds)} seconds.`;
    case 'target_exists':
      return 'Pick another path or set overwrite: true.';
    case 'download_not_authorized':
      return authorizationStep(team);
    default:
      return NOTHING_SAVED;
  }
}

function authorizationStep(team: TokenRecord): string {
  return team.cookie ? BROWSER_SESSION_STEP : REAUTHORIZE_STEP;
}
