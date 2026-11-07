import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, lstat, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileRefusal, hashingTransform, requireAbsolutePath } from './upload-source.js';

export interface DownloadTarget {
  /** The saved location: the directory resolved through any symlink, plus the file name asked for. */
  path: string;
  overwrite: boolean;
}

export interface SavedDownload {
  path: string;
  name: string;
  size: number;
  sha256: string;
}

const STAGED_FILE_MODE = 0o600;

/** Decides, before Slack is asked for anything, where the file would go and whether that place is free. */
export async function resolveDownloadTarget(file: string, overwrite: boolean): Promise<DownloadTarget> {
  requireAbsolutePath(file);
  const directory = await realpath(path.dirname(file)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      throw fileRefusal('path_not_found', file, 'the directory does not exist');
    }
    throw error;
  });
  if (!(await stat(directory)).isDirectory()) {
    throw fileRefusal('path_not_found', file, 'the directory part of this path is not a directory');
  }
  const target = path.join(directory, path.basename(file));
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing && !overwrite) throw fileRefusal('target_exists', file, 'a file already exists at this path');
  if (existing && !existing.isFile()) throw fileRefusal('not_a_file', file, 'only a regular file can be replaced');
  return { path: target, overwrite };
}

/**
 * Streams `body` into a staging file beside the target and moves it into place only once exactly `size` bytes
 * arrived, so a failed transfer leaves no file at the target and an existing one untouched.
 */
export async function saveDownload(body: Readable, target: DownloadTarget, size: number): Promise<SavedDownload> {
  const staged = path.join(path.dirname(target.path), `${randomUUID()}.part`);
  try {
    const { hasher, sha256 } = hashingTransform();
    const output = createWriteStream(staged, { flags: 'wx', mode: STAGED_FILE_MODE });
    await pipeline(body, sizeGuard(size), hasher, output);
    await moveIntoPlace(staged, target);
    return { path: target.path, name: path.basename(target.path), size, sha256: await sha256 };
  } catch (error) {
    throw downloadFailure(error, target.path);
  } finally {
    // After a hard-link commit this drops the staging name; after a failure it drops the partial file.
    await rm(staged, { force: true });
  }
}

// A rename replaces what is there; a hard link fails when something appeared at the target meanwhile.
async function moveIntoPlace(staged: string, target: DownloadTarget): Promise<void> {
  if (target.overwrite) {
    await resolveDownloadTarget(target.path, target.overwrite);
    // Another local writer can still change the target between this check and rename.
    await rename(staged, target.path);
    return;
  }
  await link(staged, target.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') {
      throw fileRefusal('target_exists', target.path, 'a file appeared at this path meanwhile');
    }
    throw error;
  });
}

// Fails the stream the moment more bytes arrive than Slack reported, or when it ends with fewer.
function sizeGuard(expected: number): Transform {
  let received = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      callback(received > expected ? sizeError('size_exceeded') : null, chunk);
    },
    flush(callback) {
      callback(received === expected ? null : sizeError('size_short'));
    },
  });
}

function sizeError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

// An error message from a stream or an axios request can hold a credential, so only its code is carried on.
function downloadFailure(error: unknown, target: string): Error {
  const { code } = (error ?? {}) as { code?: unknown };
  if (code === 'target_exists' || code === 'not_a_file') return error as Error;
  return fileRefusal('download_failed', target, `the transfer failed (${typeof code === 'string' ? code : 'unknown'})`);
}
