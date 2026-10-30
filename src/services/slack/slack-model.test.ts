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
        at: '2023-11-14T22:13:20.000Z',
        permalink: 'https://example-team.slack.com/archives/C0EXAMPLE01/p1700000000000100',
      });
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
