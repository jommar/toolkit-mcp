import './__fixtures__/tools/home-sandbox.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { slackConfirmWriteHandler, slackPrepareWriteHandler } from './write-tools.js';
import { WriteGate } from './write-gate.js';
import { createClock } from './__fixtures__/tools/clock.js';
import { createToolContext } from './__fixtures__/tools/context.js';
import { parseResult } from './__fixtures__/tools/assertions.js';
import { removeSandbox, resetSandbox, seedToken } from './__fixtures__/tools/home-sandbox.js';
import { slackFailure } from './__fixtures__/tools/fake-slack.js';
import { CHANNEL_ONE, EXAMPLE_TEAM, channelLink } from './__fixtures__/tools/ids.js';
import {
  HELLO_CONTENT,
  SECOND_CONTENT,
  createUploadWorkdir,
} from './__fixtures__/tools/upload-fixtures.js';
import { createWriteFakeSlack } from './__fixtures__/tools/write-fixtures.js';

const destination = channelLink(EXAMPLE_TEAM, CHANNEL_ONE);
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

function uploadItem(filePath: string) {
  return { action: 'upload', destination, path: filePath };
}

describe('slack_prepare_write and slack_confirm_write: batches of uploads', () => {
  beforeEach(() => {
    resetSandbox();
    seedToken();
  });

  afterAll(() => {
    workdir.remove();
    removeSandbox();
  });

  it('reports upload_rejected with the step and Slack code for one item while the others succeed', async () => {
    const { slack, prepare, confirm } = setUp();
    const paths = [
      workdir.file('batch-one.txt', HELLO_CONTENT),
      workdir.file('batch-two.txt', SECOND_CONTENT),
      workdir.file('batch-three.txt', HELLO_CONTENT),
    ];
    const preview = parseResult(await prepare({ items: paths.map(uploadItem) }));
    let requests = 0;
    slack.client.getUploadUrl.mockImplementation(async () => {
      requests += 1;
      if (requests === 2) {
        throw slackFailure('slack_error', { slack_code: 'file_upload_size_restricted' });
      }
      return {
        ok: true,
        upload_url: `https://upload.example.invalid/batch-${requests}`,
        file_id: `F0EXAMPLE0${requests}`,
      };
    });

    const confirmed = parseResult(await confirm({ confirmation_token: preview.confirmation_token }));

    expect(confirmed.results.map((result: { status: string }) => result.status)).toEqual([
      'ok',
      'error',
      'ok',
    ]);
    expect(confirmed.results[1].error.code).toBe('upload_rejected');
    expect(confirmed.results[1].error.step).toBe('get_upload_url');
    expect(confirmed.results[1].error.slack_code).toBe('file_upload_size_restricted');
    expect(confirmed.results[0].file_id).toBe('F0EXAMPLE01');
    expect(confirmed.results[2].file_id).toBe('F0EXAMPLE03');
    expect(slack.client.completeUpload).toHaveBeenCalledTimes(2);
  });

  it('puts ten uploads behind a single confirmation token', async () => {
    const { prepare } = setUp();
    const items = Array.from({ length: 10 }, (_, index) =>
      uploadItem(workdir.file(`ten-${index}.txt`, HELLO_CONTENT)),
    );

    const preview = parseResult(await prepare({ items }));

    expect(preview.items).toHaveLength(10);
    expect(typeof preview.confirmation_token).toBe('string');
    expect(JSON.stringify(preview).match(/confirmation_token/g)).toHaveLength(1);
    for (const item of preview.items) {
      expect(item.error).toBeUndefined();
    }
  });

  it('refuses a directory with not_a_file and issues no token even beside a valid file', async () => {
    const { prepare } = setUp();
    const validFile = workdir.file('beside-directory.txt', HELLO_CONTENT);
    const directory = workdir.subdir('a-directory');

    const preview = parseResult(await prepare({ items: [uploadItem(validFile), uploadItem(directory)] }));

    expect(preview.items[0].error).toBeUndefined();
    expect(preview.items[1].error.code).toBe('not_a_file');
    expect(preview.confirmation_token).toBeUndefined();
  });
});
