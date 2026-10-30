import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export interface SlackPaths {
  dir: string;
  tokenFile: string;
  appFile: string;
}

export interface TokenRecord {
  access_token: string;
  scopes: string[];
  team_id: string;
  team_domain: string;
  team_url: string;
  user_id: string;
  saved_at: string;
}

export function slackPaths(home: string): SlackPaths {
  const dir = path.join(home, '.config', 'slack', 'toolkit-mcp');
  return { dir, tokenFile: path.join(dir, 'token.json'), appFile: path.join(dir, 'app.json') };
}

export async function readToken(paths: SlackPaths): Promise<TokenRecord | null> {
  await refuseSymlinkedPath(paths.tokenFile);
  let contents: string;
  try {
    contents = await readFile(paths.tokenFile, 'utf8');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  return parseRecord(contents);
}

export async function writeToken(paths: SlackPaths, record: TokenRecord): Promise<void> {
  await refuseSymlinkedPath(paths.tokenFile);
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  const staged = `${paths.tokenFile}.${randomUUID()}.tmp`;
  try {
    const handle = await open(staged, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(staged, paths.tokenFile);
  } catch (error) {
    await rm(staged, { force: true });
    throw error;
  }
}

export async function removeToken(paths: SlackPaths): Promise<void> {
  await refuseSymlinkedPath(paths.tokenFile);
  await rm(paths.tokenFile, { force: true });
}

// A symlinked token file or directory could send the token to a file another user can read or write.
async function refuseSymlinkedPath(target: string): Promise<void> {
  let current = target;
  for (;;) {
    if ((await lstatIfPresent(current))?.isSymbolicLink()) {
      throw Object.assign(new Error(`Refusing a symbolic link in the Slack credential store: ${current}`), {
        code: 'symlink_refused',
      });
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function lstatIfPresent(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function parseRecord(contents: string): TokenRecord {
  try {
    return JSON.parse(contents) as TokenRecord;
  } catch {
    // The parser's own message quotes the input, which here would be the token.
    throw Object.assign(new Error('The Slack token file is not valid JSON'), { code: 'token_unreadable' });
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
