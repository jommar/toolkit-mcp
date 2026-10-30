import './__fixtures__/tools/home-sandbox.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { slackConfirmWriteHandler, slackPrepareWriteHandler } from './write-tools.js';
import { WriteGate } from './write-gate.js';
import { createClock } from './__fixtures__/tools/clock.js';
import { createToolContext } from './__fixtures__/tools/context.js';
import { expectInvalidParams, expectSlackError, parseResult } from './__fixtures__/tools/assertions.js';
import { removeSandbox, resetSandbox, seedToken } from './__fixtures__/tools/home-sandbox.js';
import { WRITE_METHOD_NAMES, slackFailure } from './__fixtures__/tools/fake-slack.js';
import {
  CHANNEL_ONE,
  DM_ONE,
  EXAMPLE_TEAM,
  OTHER_TEAM,
  USER_PARTNER,
  channelLink,
  messageLink,
  tsFor,
} from './__fixtures__/tools/ids.js';
import { HELLO_CONTENT, createUploadWorkdir } from './__fixtures__/tools/upload-fixtures.js';
import {
  HIGH_POST_OFFSET,
  PARTNER_NAME,
  ROOM_NAME,
  ROOT_TS,
  createWriteFakeSlack,
  deferred,
  postItem,
  settleMicrotasksAndTimers,
} from './__fixtures__/tools/write-fixtures.js';

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

describe('slack_prepare_write and slack_confirm_write: posting by id or link', () => {
  beforeEach(() => {
    resetSandbox();
    seedToken();
  });

  afterAll(() => {
    removeSandbox();
  });

  it('turns a message link into a reply in that message thread', async () => {
    const { slack, prepare, confirm } = setUp();
    const preview = parseResult(
      await prepare({
        items: [
          {
            action: 'post',
            destination: messageLink(EXAMPLE_TEAM, CHANNEL_ONE, ROOT_TS),
            text: 'reply text',
          },
        ],
      }),
    );

    expect(preview.items[0].destination.thread_root.ts).toBe(ROOT_TS);
    expect(typeof preview.confirmation_token).toBe('string');

    await confirm({ confirmation_token: preview.confirmation_token });

    expect(slack.client.postMessage).toHaveBeenCalledTimes(1);
    expect(slack.client.postMessage.mock.calls[0][0]).toMatchObject({
      channel: CHANNEL_ONE,
      thread_ts: ROOT_TS,
    });
  });

  it('shows the participants of a direct message in the preview', async () => {
    const { prepare } = setUp();
    const preview = parseResult(
      await prepare({
        items: [
          { action: 'post', destination: channelLink(EXAMPLE_TEAM, DM_ONE), text: 'reply text' },
        ],
      }),
    );

    const destination = preview.items[0].destination;
    expect(destination.type).toBe('im');
    expect(destination.participants).toEqual(
      expect.arrayContaining([{ user_id: USER_PARTNER, display_name: PARTNER_NAME }]),
    );
  });

  it('refuses an id destination that has no expected_destination', async () => {
    const { slack, prepare } = setUp();

    await expectInvalidParams(() =>
      prepare({ items: [{ action: 'post', destination: CHANNEL_ONE, text: 'reply text' }] }),
    );

    expect(slack.client.postMessage).not.toHaveBeenCalled();
  });

  it('reports target_mismatch and issues no token when the expected destination differs', async () => {
    const { slack, prepare } = setUp();
    const preview = parseResult(
      await prepare({ items: [postItem({ expectedDestination: 'some-other-room' })] }),
    );

    expect(preview.items[0].error.code).toBe('target_mismatch');
    expect(preview.confirmation_token).toBeUndefined();
    expect(slack.client.postMessage).not.toHaveBeenCalled();
  });

  it('rejects eleven items with batch_too_large before any upstream call', async () => {
    const { slack, prepare } = setUp();
    const items = Array.from({ length: 11 }, (_, index) => postItem({ text: `reply number ${index}` }));

    await expectSlackError(() => prepare({ items }), 'batch_too_large');

    expect(slack.calls).toHaveLength(0);
  });

  it('sends confirmed items one at a time, in input order, with link_names off', async () => {
    const { slack, prepare, confirm } = setUp();
    const preview = parseResult(
      await prepare({
        items: [0, 1, 2].map((index) => postItem({ text: `reply number ${index}` })),
      }),
    );
    const firstSend = deferred<void>();
    const order: string[] = [];
    slack.client.postMessage
      .mockImplementationOnce(async (params) => {
        order.push('start-1');
        await firstSend.promise;
        order.push('end-1');
        return { ok: true, channel: params.channel, ts: tsFor(HIGH_POST_OFFSET + 1) };
      })
      .mockImplementationOnce(async (params) => {
        order.push('start-2');
        return { ok: true, channel: params.channel, ts: tsFor(HIGH_POST_OFFSET + 2) };
      })
      .mockImplementationOnce(async (params) => {
        order.push('start-3');
        return { ok: true, channel: params.channel, ts: tsFor(HIGH_POST_OFFSET + 3) };
      });

    const confirming = confirm({ confirmation_token: preview.confirmation_token });
    await settleMicrotasksAndTimers();
    expect(slack.client.postMessage).toHaveBeenCalledTimes(1);

    firstSend.resolve();
    await confirming;

    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'start-3']);
    const sent = slack.client.postMessage.mock.calls.map(([params]) => params);
    expect(sent.map((params) => params.text)).toEqual([
      'reply number 0',
      'reply number 1',
      'reply number 2',
    ]);
    for (const params of sent) {
      expect(params).toMatchObject({ channel: CHANNEL_ONE, link_names: false });
    }
  });

  it('gives each sent item its own permalink and carries on after a failed item', async () => {
    const { slack, prepare, confirm } = setUp();
    const preview = parseResult(
      await prepare({
        items: [0, 1, 2].map((index) => postItem({ text: `reply number ${index}` })),
      }),
    );
    let attempts = 0;
    slack.client.postMessage.mockImplementation(async (params) => {
      attempts += 1;
      if (attempts === 2) throw slackFailure('slack_error', { slack_code: 'not_in_channel' });
      return { ok: true, channel: params.channel, ts: tsFor(HIGH_POST_OFFSET + attempts) };
    });

    const confirmed = parseResult(await confirm({ confirmation_token: preview.confirmation_token }));

    expect(slack.client.postMessage).toHaveBeenCalledTimes(3);
    expect(confirmed.results.map((result: { status: string }) => result.status)).toEqual([
      'ok',
      'error',
      'ok',
    ]);
    expect(confirmed.results[0].permalink).toBe(
      'https://example-team.slack.com/archives/C0EXAMPLE01/p1700002001000100',
    );
    expect(confirmed.results[2].permalink).toBe(
      'https://example-team.slack.com/archives/C0EXAMPLE01/p1700002003000100',
    );
    expect(confirmed.results[1].error.code).toBe('slack_error');
    expect(JSON.stringify(confirmed.results[1].error)).toContain('not_in_channel');
    expect(confirmed.results[0].channel_id).toBe(CHANNEL_ONE);
  });
});

const workspaceWorkdir = createUploadWorkdir();
const SECOND_LOGIN_TOKEN = ['xoxp', 'synthetic', 'second', 'login'].join('-');
const SECOND_LOGIN_SAVED_AT = '2031-01-01T00:05:00.000Z';

function everyKindOfWrite() {
  return [
    postItem(),
    { action: 'react', message: { channel: CHANNEL_ONE, ts: ROOT_TS }, expected_destination: ROOM_NAME, emoji: 'eyes' },
    {
      action: 'upload',
      destination: CHANNEL_ONE,
      expected_destination: ROOM_NAME,
      path: workspaceWorkdir.file('workspace-note.txt', HELLO_CONTENT),
    },
  ];
}

describe('slack_confirm_write: previewed writes stay with the workspace they were previewed in', () => {
  beforeEach(() => {
    resetSandbox();
    seedToken();
  });

  afterAll(() => {
    workspaceWorkdir.remove();
    removeSandbox();
  });

  it('fails every item with workspace_changed and calls no write or upload method when the stored token now belongs to another workspace', async () => {
    const { slack, prepare, confirm } = setUp();
    const preview = parseResult(await prepare({ items: everyKindOfWrite() }));
    expect(typeof preview.confirmation_token).toBe('string');
    seedToken({ team: OTHER_TEAM });

    const confirmed = parseResult(await confirm({ confirmation_token: preview.confirmation_token }));

    expect(confirmed.results.map((result: { status: string }) => result.status)).toEqual(['error', 'error', 'error']);
    expect(confirmed.results.map((result: { error: { code: string } }) => result.error.code)).toEqual([
      'workspace_changed',
      'workspace_changed',
      'workspace_changed',
    ]);
    for (const result of confirmed.results) {
      expect(result.error.message.length).toBeGreaterThan(0);
    }
    for (const method of WRITE_METHOD_NAMES) {
      expect(slack.client[method], method).not.toHaveBeenCalled();
    }
  });

  it('still sends every item when the workspace is the same and only the stored login was renewed', async () => {
    const { slack, prepare, confirm } = setUp();
    const preview = parseResult(await prepare({ items: everyKindOfWrite() }));
    seedToken({ accessToken: SECOND_LOGIN_TOKEN, savedAt: SECOND_LOGIN_SAVED_AT });

    const confirmed = parseResult(await confirm({ confirmation_token: preview.confirmation_token }));

    expect(confirmed.results.map((result: { status: string }) => result.status)).toEqual(['ok', 'ok', 'ok']);
    expect(slack.client.postMessage).toHaveBeenCalledTimes(1);
    expect(slack.client.addReaction).toHaveBeenCalledTimes(1);
    expect(slack.client.completeUpload).toHaveBeenCalledTimes(1);
  });
});
