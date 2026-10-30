import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline, Readable, Transform } from 'node:stream';

export interface UploadInspection {
  resolved_path: string;
  via_symlink: boolean;
  name: string;
  size: number;
  type: string;
  sha256: string;
}

export interface HashedStream {
  stream: Readable;
  sha256: Promise<string>;
}

const MAGIC_TYPES: ReadonlyArray<readonly [string, Buffer]> = [
  ['image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff])],
  ['image/gif', Buffer.from('GIF87a', 'latin1')],
  ['image/gif', Buffer.from('GIF89a', 'latin1')],
  ['application/pdf', Buffer.from('%PDF-', 'latin1')],
  ['application/zip', Buffer.from([0x50, 0x4b, 0x03, 0x04])],
];

export async function inspectUploadFile(file: string): Promise<UploadInspection> {
  const { resolved_path, via_symlink } = await resolveRegularFile(file);
  const { stream, sha256 } = await openHashedStream(resolved_path);
  const chunks: AsyncIterable<Buffer> = stream;
  const name = path.basename(file);
  let head: Buffer | undefined;
  let size = 0;
  for await (const chunk of chunks) {
    head ??= chunk;
    size += chunk.length;
  }
  return {
    resolved_path,
    via_symlink,
    name,
    size,
    type: sniffType(name, head ?? Buffer.alloc(0)),
    sha256: await sha256,
  };
}

export async function openHashedStream(file: string): Promise<HashedStream> {
  const digest = createHash('sha256');
  const hasher = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  const sha256 = new Promise<string>((resolve, reject) => {
    hasher.once('end', () => resolve(digest.digest('hex')));
    pipeline(createReadStream(file), hasher, (error) => {
      if (error) reject(error);
    });
  });
  // A caller may stop reading before awaiting the digest; the failure then surfaces through the stream.
  sha256.catch(() => undefined);
  return { stream: hasher, sha256 };
}

async function resolveRegularFile(file: string): Promise<{ resolved_path: string; via_symlink: boolean }> {
  if (!path.isAbsolute(file)) throw uploadRefusal('path_not_absolute', file, 'the path must be absolute');
  const resolved_path = await realpath(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw uploadRefusal('path_not_found', file, 'no file exists at this path');
    throw error;
  });
  if (!(await stat(resolved_path)).isFile()) {
    throw uploadRefusal('not_a_file', file, 'only regular files can be uploaded');
  }
  return { resolved_path, via_symlink: (await lstat(file)).isSymbolicLink() };
}

function sniffType(name: string, head: Buffer): string {
  const magic = MAGIC_TYPES.find(([, signature]) => head.subarray(0, signature.length).equals(signature));
  if (magic) return magic[0];
  if (name.toLowerCase().endsWith('.txt') || isUtf8(head)) return 'text/plain';
  return 'application/octet-stream';
}

function isUtf8(head: Buffer): boolean {
  try {
    // Streaming mode holds back a multibyte character that the sample cuts short.
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
    return true;
  } catch {
    return false;
  }
}

function uploadRefusal(code: string, file: string, rule: string): Error {
  return Object.assign(new Error(`${code}: ${file} (${rule})`), { code });
}
