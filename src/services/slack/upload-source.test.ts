import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectUploadFile, openHashedStream } from './upload-source.js';
import { deterministicBytes, oneShotSha256 } from './__fixtures__/bytes.js';
import { settle } from './__fixtures__/settle.js';
import { FILE_BYTES_SENTINEL } from './__fixtures__/synthetic.js';

const MULTI_CHUNK_SIZE = 2_621_440;

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'slack-mcp-upload-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  fs.rmSync(workDir, { recursive: true, force: true });
});

function writeFixture(name: string, contents: Buffer | string): string {
  const target = path.join(workDir, name);
  fs.writeFileSync(target, contents);
  return target;
}

async function watchWholeFileReads() {
  const handle = await fsPromises.open(writeFixture('probe.txt', 'probe'), 'r');
  const handlePrototype = Object.getPrototypeOf(handle);
  await handle.close();
  const pathReaders = [vi.spyOn(fs, 'readFileSync'), vi.spyOn(fs, 'readFile'), vi.spyOn(fsPromises, 'readFile')];
  const handleReader = vi.spyOn(handlePrototype, 'readFile');
  syncBuiltinESMExports();
  return {
    callsOnFixtureFiles: () =>
      pathReaders
        .flatMap((spy) => spy.mock.calls)
        .filter(([target]) => typeof target === 'string' && target.startsWith(workDir)),
    handleReads: () => handleReader.mock.calls,
  };
}

async function collect(stream: Readable): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return chunks;
}

describe('inspectUploadFile', () => {
  describe('refusals', () => {
    it('refuses a relative path with path_not_absolute and names the path given', async () => {
      const outcome = await settle(() => inspectUploadFile('relative/notes.txt'));

      expect(outcome.threw).toBe(true);
      expect(outcome.error).toMatchObject({ code: 'path_not_absolute' });
      expect(outcome.error.message).toContain('relative/notes.txt');
    });

    it('refuses a missing file with path_not_found and names the path', async () => {
      const missing = path.join(workDir, 'missing.txt');

      const outcome = await settle(() => inspectUploadFile(missing));

      expect(outcome.error).toMatchObject({ code: 'path_not_found' });
      expect(outcome.error.message).toContain(missing);
    });

    it('refuses a directory with not_a_file and names the path', async () => {
      const directory = path.join(workDir, 'folder');
      fs.mkdirSync(directory);

      const outcome = await settle(() => inspectUploadFile(directory));

      expect(outcome.error).toMatchObject({ code: 'not_a_file' });
      expect(outcome.error.message).toContain(directory);
    });

    it('refuses a symlink that points at a directory with not_a_file', async () => {
      const directory = path.join(workDir, 'folder');
      fs.mkdirSync(directory);
      const link = path.join(workDir, 'folder-link');
      fs.symlinkSync(directory, link);

      const outcome = await settle(() => inspectUploadFile(link));

      expect(outcome.error).toMatchObject({ code: 'not_a_file' });
    });

    it('refuses a socket, which is not a regular file, with not_a_file', async () => {
      const socketPath = path.join(workDir, 's.sock');
      const server = net.createServer();
      await new Promise<void>((ready) => server.listen(socketPath, ready));
      try {
        const outcome = await settle(() => inspectUploadFile(socketPath));

        expect(outcome.error).toMatchObject({ code: 'not_a_file' });
      } finally {
        await new Promise<void>((closed) => server.close(() => closed()));
      }
    });

    it('refuses a character device with not_a_file', async () => {
      const outcome = await settle(() => inspectUploadFile('/dev/null'));

      expect(outcome.error).toMatchObject({ code: 'not_a_file' });
    });

    it('never puts file bytes in a refusal', async () => {
      writeFixture('secret.txt', FILE_BYTES_SENTINEL);
      const directory = path.join(workDir, 'folder');
      fs.mkdirSync(directory);
      const refusals = await Promise.all([
        settle(() => inspectUploadFile('secret.txt')),
        settle(() => inspectUploadFile(path.join(workDir, 'missing.txt'))),
        settle(() => inspectUploadFile(directory)),
      ]);

      for (const refusal of refusals) {
        expect(refusal.threw).toBe(true);
        expect(`${refusal.error.message} ${JSON.stringify(refusal.error)}`).not.toContain(FILE_BYTES_SENTINEL);
      }
    });
  });

  describe('accepted files', () => {
    it('returns the resolved path, name, size, type and sha256 of a text file with no content', async () => {
      const contents = `${FILE_BYTES_SENTINEL}\nsecond line\n`;
      const file = writeFixture('report.txt', contents);

      const inspected = await inspectUploadFile(file);

      expect(inspected).toEqual({
        resolved_path: file,
        via_symlink: false,
        name: 'report.txt',
        size: Buffer.byteLength(contents),
        type: 'text/plain',
        sha256: oneShotSha256(Buffer.from(contents)),
      });
      expect(JSON.stringify(inspected)).not.toContain(FILE_BYTES_SENTINEL);
    });

    it('accepts a symlink, showing the resolved path and via_symlink', async () => {
      const contents = 'linked fixture contents';
      const target = writeFixture('notes.txt', contents);
      fs.mkdirSync(path.join(workDir, 'links'));
      const link = path.join(workDir, 'links', 'notes.txt');
      fs.symlinkSync(target, link);

      const inspected = await inspectUploadFile(link);

      expect(inspected).toMatchObject({
        resolved_path: target,
        via_symlink: true,
        name: 'notes.txt',
        size: Buffer.byteLength(contents),
        sha256: oneShotSha256(Buffer.from(contents)),
      });
    });

    it('hashes a multi-chunk binary file to the one-shot reference hash and sizes it exactly', async () => {
      const bytes = deterministicBytes(MULTI_CHUNK_SIZE);
      const file = writeFixture('dump.dat', bytes);
      const referenceHash = oneShotSha256(bytes);

      const inspected = await inspectUploadFile(file);

      expect(inspected).toMatchObject({
        size: MULTI_CHUNK_SIZE,
        type: 'application/octet-stream',
        sha256: referenceHash,
      });
    });

    it.each([
      ['image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])],
      ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])],
      ['image/gif', Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1')],
      ['application/pdf', Buffer.from('%PDF-1.7\n%fixture\n', 'latin1')],
      ['application/zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00])],
    ])('sniffs %s from the first bytes regardless of the file name', async (expectedType, head) => {
      const file = writeFixture('blob.dat', head);

      const inspected = await inspectUploadFile(file);

      expect(inspected.type).toBe(expectedType);
    });
  });

  describe('memory', () => {
    it('reads by stream and never calls a whole-file read API', async () => {
      const file = writeFixture('dump.dat', deterministicBytes(MULTI_CHUNK_SIZE));
      const watch = await watchWholeFileReads();

      await inspectUploadFile(file);

      expect(watch.callsOnFixtureFiles()).toEqual([]);
      expect(watch.handleReads()).toEqual([]);
    });
  });
});

describe('openHashedStream', () => {
  it('streams every byte unchanged in several chunks and reports the one-shot reference hash', async () => {
    const bytes = deterministicBytes(MULTI_CHUNK_SIZE);
    const file = writeFixture('dump.dat', bytes);
    const referenceHash = oneShotSha256(bytes);

    const opened = await openHashedStream(file);
    const chunks = await collect(opened.stream);

    expect(chunks.length).toBeGreaterThan(1);
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
    expect(await opened.sha256).toBe(referenceHash);
  });

  it('never calls a whole-file read API', async () => {
    const file = writeFixture('dump.dat', deterministicBytes(MULTI_CHUNK_SIZE));
    const watch = await watchWholeFileReads();

    const opened = await openHashedStream(file);
    await collect(opened.stream);
    await opened.sha256;

    expect(watch.callsOnFixtureFiles()).toEqual([]);
    expect(watch.handleReads()).toEqual([]);
  });
});
