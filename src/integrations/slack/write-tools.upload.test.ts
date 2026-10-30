import './__fixtures__/tools/home-sandbox.js';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { slackConfirmWriteHandler, slackPrepareWriteHandler } from './write-tools.js';
import { WriteGate } from './write-gate.js';
import { createClock } from './__fixtures__/tools/clock.js';
import { createToolContext } from './__fixtures__/tools/context.js';
import { parseResult } from './__fixtures__/tools/assertions.js';
import { removeSandbox, resetSandbox, seedToken } from './__fixtures__/tools/home-sandbox.js';
import { CHANNEL_ONE, EXAMPLE_TEAM, FILE_ONE, USER_PARTNER, messageLink } from './__fixtures__/tools/ids.js';
import {
  HELLO_CONTENT,
  HELLO_SHA256,
  HELLO_SIZE,
  SAME_SIZE_OTHER_CONTENT,
  createUploadWorkdir,
} from './__fixtures__/tools/upload-fixtures.js';
import { PARTNER_NAME, ROOT_TS, createWriteFakeSlack } from './__fixtures__/tools/write-fixtures.js';

const threadLink = messageLink(EXAMPLE_TEAM, CHANNEL_ONE, ROOT_TS);
const COMMENT = `please look <@${USER_PARTNER}>`;

const workdir = createUploadWorkdir();

function setUp() {
  const slack = createWriteFakeSlack();
  const clock = createClock();
  const gate = new WriteGate({ now: clock.now });
  const context = createToolContext({ slack, clock, gate });
  return {
    slack,
    prepare: slackPrepareWriteHandler(context),
    confirm: slackConfirmWriteHandler(context),
  };
}

function uploadItem(filePath: string, extra: Record<string, unknown> = {}) {
  return { action: 'upload', destination: threadLink, path: filePath, ...extra };
}

describe('slack_prepare_write and slack_confirm_write: uploading a file', () => {
  beforeEach(() => {
    resetSandbox();
    seedToken();
  });

  afterAll(() => {
    workdir.remove();
    removeSandbox();
  });

  it('previews the resolved path, fingerprint, thread and comment mentions of a file and of a symlink to it, with no content', async () => {
    const { prepare } = setUp();
    const target = workdir.file('preview-note.txt', HELLO_CONTENT);
    const link = workdir.link('preview-note-link.txt', target);

    const preview = parseResult(
      await prepare({ items: [uploadItem(target, { comment: COMMENT }), uploadItem(link)] }),
    );

    expect(typeof preview.confirmation_token).toBe('string');
    expect(preview.items[0].file).toEqual({
      resolved_path: target,
      via_symlink: false,
      name: 'preview-note.txt',
      size: HELLO_SIZE,
      type: 'text/plain',
      sha256: HELLO_SHA256,
    });
    expect(preview.items[1].file).toMatchObject({
      resolved_path: target,
      via_symlink: true,
      size: HELLO_SIZE,
      type: 'text/plain',
      sha256: HELLO_SHA256,
    });
    expect(preview.items[0].destination.thread_root.ts).toBe(ROOT_TS);
    expect(preview.items[1].destination.thread_root.ts).toBe(ROOT_TS);
    expect(preview.items[0].mentions).toEqual([
      { kind: 'user', id: USER_PARTNER, display_name: PARTNER_NAME },
    ]);
    expect(JSON.stringify(preview)).not.toContain('hello upload');
  });

  it('confirms by getting the upload URL, streaming the bytes and completing the upload into the thread', async () => {
    const { slack, prepare, confirm } = setUp();
    const target = workdir.file('confirm-note.txt', HELLO_CONTENT);
    const preview = parseResult(await prepare({ items: [uploadItem(target, { comment: COMMENT })] }));

    const confirmed = parseResult(await confirm({ confirmation_token: preview.confirmation_token }));

    const { getUploadUrl, sendUploadBytes, completeUpload } = slack.client;
    expect(getUploadUrl).toHaveBeenCalledTimes(1);
    expect(sendUploadBytes).toHaveBeenCalledTimes(1);
    expect(completeUpload).toHaveBeenCalledTimes(1);
    expect(getUploadUrl.mock.invocationCallOrder[0]).toBeLessThan(sendUploadBytes.mock.invocationCallOrder[0]);
    expect(sendUploadBytes.mock.invocationCallOrder[0]).toBeLessThan(completeUpload.mock.invocationCallOrder[0]);

    expect(getUploadUrl.mock.calls[0][0]).toEqual({ filename: 'confirm-note.txt', length: HELLO_SIZE });

    const [uploadUrl, body, contentLength] = sendUploadBytes.mock.calls[0];
    expect(uploadUrl).toBe('https://upload.example.invalid/fixture-1');
    expect(body).toBeInstanceOf(Readable);
    expect(contentLength).toBe(HELLO_SIZE);
    expect(slack.uploads[0].bytes.toString('utf8')).toBe(HELLO_CONTENT);

    expect(completeUpload.mock.calls[0][0]).toMatchObject({
      files: [{ id: FILE_ONE }],
      channel_id: CHANNEL_ONE,
      thread_ts: ROOT_TS,
      initial_comment: COMMENT,
    });
    expect(confirmed.results[0]).toMatchObject({
      status: 'ok',
      action: 'upload',
      channel_id: CHANNEL_ONE,
      file_id: FILE_ONE,
      permalink: 'https://example-team.slack.com/files/U0EXAMPLE01/F0EXAMPLE01/fixture-file',
    });
  });

  it('reports file_changed and makes no upstream call when the file size changed after the preview', async () => {
    const { slack, prepare, confirm } = setUp();
    const target = workdir.file('grown-note.txt', HELLO_CONTENT);
    const preview = parseResult(await prepare({ items: [uploadItem(target)] }));
    fs.appendFileSync(target, 'more bytes\n');

    const confirmed = parseResult(await confirm({ confirmation_token: preview.confirmation_token }));

    expect(confirmed.results[0].status).toBe('error');
    expect(confirmed.results[0].error.code).toBe('file_changed');
    expect(slack.client.getUploadUrl).not.toHaveBeenCalled();
    expect(slack.client.sendUploadBytes).not.toHaveBeenCalled();
    expect(slack.client.completeUpload).not.toHaveBeenCalled();
  });

  it('reports file_changed and never completes the upload when the same-size file has new content', async () => {
    const { slack, prepare, confirm } = setUp();
    const target = workdir.file('swapped-note.txt', HELLO_CONTENT);
    const preview = parseResult(await prepare({ items: [uploadItem(target)] }));
    fs.writeFileSync(target, SAME_SIZE_OTHER_CONTENT);

    const confirmed = parseResult(await confirm({ confirmation_token: preview.confirmation_token }));

    expect(confirmed.results[0].status).toBe('error');
    expect(confirmed.results[0].error.code).toBe('file_changed');
    expect(slack.client.completeUpload).not.toHaveBeenCalled();
  });
});
