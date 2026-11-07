import { describe, it, expect } from 'vitest';
import { buildPermalink, shapeMessage, slackTsToIso, toSlackTs } from './slack-model.js';
import { CHANNEL_ID, EXAMPLE_TEAM, ROOT_TS, USER_ID } from './__fixtures__/synthetic.js';

describe('slack model', () => {
  describe('slackTsToIso', () => {
    it('renders a Slack ts as an ISO 8601 UTC instant', () => {
      expect(slackTsToIso('1700000000.123000')).toBe('2023-11-14T22:13:20.123Z');
    });

    it('renders a whole-second ts with zero milliseconds', () => {
      expect(slackTsToIso('1700000000.000000')).toBe('2023-11-14T22:13:20.000Z');
    });
  });

  describe('toSlackTs', () => {
    it('keeps a Slack ts unchanged', () => {
      expect(toSlackTs('1700000000.123000')).toBe('1700000000.123000');
    });

    it('converts an ISO instant with Z to a Slack ts', () => {
      expect(toSlackTs('2023-11-14T22:13:20.123Z')).toBe('1700000000.123000');
    });

    it('converts an ISO instant with a positive offset to the same Slack ts', () => {
      expect(toSlackTs('2023-11-14T23:13:20.123+01:00')).toBe('1700000000.123000');
    });

    it('converts an ISO instant with a negative offset to the same Slack ts', () => {
      expect(toSlackTs('2023-11-14T17:13:20.123-05:00')).toBe('1700000000.123000');
    });

    it.each(['not-a-time', 'yesterday', '', '2023-13-45T99:99:99Z', '12:00'])('rejects garbage input %j', (garbage) => {
      expect(() => toSlackTs(garbage)).toThrow();
    });
  });

  describe('buildPermalink', () => {
    it('builds the canonical archive link from the stored team url, channel and ts', () => {
      expect(buildPermalink({ teamUrl: EXAMPLE_TEAM.team_url, channelId: CHANNEL_ID, ts: ROOT_TS })).toBe(
        'https://example-team.slack.com/archives/C0EXAMPLE01/p1700000000000100',
      );
    });

    it('does not double the slash when the team url has no trailing slash', () => {
      expect(
        buildPermalink({ teamUrl: 'https://other-team.slack.com', channelId: 'D0EXAMPLE01', ts: '1700000000.000200' }),
      ).toBe('https://other-team.slack.com/archives/D0EXAMPLE01/p1700000000000200');
    });
  });

  describe('shapeMessage', () => {
    const rootMessage = {
      ts: ROOT_TS,
      thread_ts: ROOT_TS,
      reply_count: 2,
      user: USER_ID,
      text: 'hello from the fixture',
    };
    const context = { channelId: CHANNEL_ID, teamUrl: EXAMPLE_TEAM.team_url };

    it('returns the stable default keys with an ISO UTC time and a permalink', () => {
      expect(shapeMessage(rootMessage, context)).toEqual({
        channel_id: 'C0EXAMPLE01',
        ts: '1700000000.000100',
        thread_ts: '1700000000.000100',
        is_top_level: true,
        reply_count: 2,
        author_id: 'U0EXAMPLE01',
        is_bot: false,
        hasAttachments: false,
        at: '2023-11-14T22:13:20.000Z',
        permalink: 'https://example-team.slack.com/archives/C0EXAMPLE01/p1700000000000100',
      });
    });

    it('returns default file metadata and hasAttachments independently of requested fields', () => {
      const raw = {
        ...rootMessage,
        subtype: 'file_share',
        files: [
          { id: 'F0EXAMPLE01', name: 'EXAMPLE-notes.txt', size: 0, mimetype: 'text/plain' },
          { id: 'F0EXAMPLE02' },
        ],
      };
      for (const fields of [undefined, [], ['text']]) {
        const shaped = shapeMessage(raw, { ...context, fields });
        expect(shaped).toMatchObject({
          hasAttachments: true,
          attachments: [
            { file_id: 'F0EXAMPLE01', name: 'EXAMPLE-notes.txt', size: 0, type: 'text/plain' },
            { file_id: 'F0EXAMPLE02' },
          ],
        });
        for (const key of ['files', 'mrkdwn', 'author_name', 'email']) expect(shaped).not.toHaveProperty(key);
        if (fields?.includes('text')) expect(shaped.text).toBe('hello from the fixture');
        else expect(shaped).not.toHaveProperty('text');
      }
    });

    it('returns false without files including unfurl-only messages and preserves previous default values', () => {
      for (const extra of [{}, { files: [] }, { attachments: [{ title: 'EXAMPLE-unfurl', text: 'EXAMPLE-preview' }] }]) {
        const raw = { ...rootMessage, ...extra };
        expect(shapeMessage(raw, context)).toEqual({
          channel_id: 'C0EXAMPLE01',
          ts: '1700000000.000100',
          thread_ts: '1700000000.000100',
          is_top_level: true,
          reply_count: 2,
          author_id: 'U0EXAMPLE01',
          is_bot: false,
          hasAttachments: false,
          at: '2023-11-14T22:13:20.000Z',
          permalink: 'https://example-team.slack.com/archives/C0EXAMPLE01/p1700000000000100',
        });
      }
    });

    it('keeps sparse metadata and file presence separate from usable IDs', () => {
      const cases = [
        {
          files: [
            null, false, 1, 'EXAMPLE-primitive', [],
            { id: 'F0EXAMPLE01', name: '', size: -1, mimetype: 12, title: 'EXAMPLE-no-fallback' },
            { id: 'F0EXAMPLE02', name: 12, size: 0, mimetype: '' },
            { id: 'F0EXAMPLE03', size: 1.5 },
            { id: 'F0EXAMPLE04', size: Number.MAX_SAFE_INTEGER + 1 },
            { id: 'F0EXAMPLE05', name: 'EXAMPLE-safe.txt', size: 12, mimetype: 'text/plain' },
            { id: 'not-a-file' }, { id: 'f0example01' }, { id: 12 }, {},
          ],
          hasAttachments: true,
          attachments: [
            { file_id: 'F0EXAMPLE01' },
            { file_id: 'F0EXAMPLE02', size: 0 },
            { file_id: 'F0EXAMPLE03' },
            { file_id: 'F0EXAMPLE04' },
            { file_id: 'F0EXAMPLE05', name: 'EXAMPLE-safe.txt', size: 12, type: 'text/plain' },
          ],
        },
        { files: [{}, { id: 'F' }, { id: 'F0EXAMPLE_01' }], hasAttachments: true },
        { files: null, hasAttachments: false },
        { files: 'EXAMPLE-not-a-list', hasAttachments: false },
        { files: { id: 'F0EXAMPLE01' }, hasAttachments: false },
        { files: [null, false, 1, 'EXAMPLE-primitive', []], hasAttachments: false },
      ];
      for (const fixture of cases) {
        const raw = { ...rootMessage, files: fixture.files };
        const shaped = shapeMessage(raw, context);
        expect(shaped).toMatchObject({ ts: ROOT_TS, hasAttachments: fixture.hasAttachments });
        if ('attachments' in fixture) expect(shaped).toHaveProperty('attachments', fixture.attachments);
        else expect(shaped).not.toHaveProperty('attachments');
        expect(shaped).not.toHaveProperty('files');
      }
    });

    it('omits the text key when fields is omitted', () => {
      const shaped = shapeMessage(rootMessage, context);

      expect(Object.keys(shaped)).not.toContain('text');
    });

    it('omits the text key when fields names only other keys', () => {
      const shaped = shapeMessage(rootMessage, { ...context, fields: ['reactions'] });

      expect(Object.keys(shaped)).not.toContain('text');
    });

    it('includes the text key when fields asks for it', () => {
      const shaped = shapeMessage(rootMessage, { ...context, fields: ['text'] });

      expect(shaped.text).toBe('hello from the fixture');
    });

    it('marks a reply as not top level and keeps its root thread_ts', () => {
      const shaped = shapeMessage(
        { ts: '1700000000.000200', thread_ts: ROOT_TS, user: USER_ID, text: 'reply' },
        context,
      );

      expect(shaped).toMatchObject({
        ts: '1700000000.000200',
        thread_ts: ROOT_TS,
        is_top_level: false,
        at: '2023-11-14T22:13:20.000Z',
      });
    });

    it('flags a bot message', () => {
      const shaped = shapeMessage({ ts: ROOT_TS, bot_id: 'B0EXAMPLE01', text: 'automated' }, context);

      expect(shaped.is_bot).toBe(true);
    });
  });
});
