import type { Stats } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import type { SlackPaths } from './credential-store.js';

export interface AppConfig {
  client_id: string;
}

const GROUP_OR_WORLD_MODE_BITS = 0o077;
const SETUP_DOC = 'docs/slack.md';

/** Returns only the client id: PKCE needs no secret, so a secret the user left in the file is never read onward. */
export async function readAppConfig(paths: SlackPaths): Promise<AppConfig> {
  const [dirStats, fileStats] = await Promise.all([lstatIfPresent(paths.dir), lstatIfPresent(paths.appFile)]);
  if (!isPrivate(dirStats, 'directory') || !isPrivate(fileStats, 'file')) throw notConfigured(paths);

  const clientId = parseClientId(await readFile(paths.appFile, 'utf8'));
  if (clientId === undefined) throw notConfigured(paths);
  return { client_id: clientId };
}

function isPrivate(stats: Stats | undefined, kind: 'directory' | 'file'): boolean {
  if (!stats) return false;
  const isExpectedKind = kind === 'directory' ? stats.isDirectory() : stats.isFile();
  return isExpectedKind && (stats.mode & GROUP_OR_WORLD_MODE_BITS) === 0;
}

function parseClientId(contents: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    // The parser's message quotes the input, which here can hold the client secret.
    return undefined;
  }
  const clientId = (parsed as Partial<AppConfig> | null)?.client_id;
  return typeof clientId === 'string' && clientId.length > 0 ? clientId : undefined;
}

function notConfigured(paths: SlackPaths): Error {
  const nextStep =
    `Write {"client_id": "<your app's client id>"} to ${paths.appFile} with mode 600 inside a mode 700 directory. ` +
    `See ${SETUP_DOC}.`;
  return Object.assign(new Error(`The Slack app is not configured. ${nextStep}`), {
    code: 'app_not_configured',
    next_step: nextStep,
  });
}

async function lstatIfPresent(target: string): Promise<Stats | undefined> {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
