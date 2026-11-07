import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findThreadsForIssueKey, MAX_THREADS_PER_ISSUE } from './issue-threads.js';
import {
  CHANNEL_NAME,
  MESSAGE_TEXT_MARKER,
  OTHER_CHANNEL_ID,
  searchMatch,
  searchResponse,
  tsAt,
} from './__fixtures__/issue-threads.js';
import { CHANNEL_ID, DM_ID, EXAMPLE_TEAM, GROUP_DM_ID } from './__fixtures__/synthetic.js';

const TEAM_URL = EXAMPLE_TEAM.team_url;
const ISSUE_KEY = 'TAP-1234';

/** What a thread looks like once it has been sent as JSON: no keys left holding undefined. */
function onTheWire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function permalinkTo(channelId: string, ts: string): string {
  return `https://example-team.slack.com/archives/${channelId}/p${ts.replace('.', '')}`;
}

describe('findThreadsForIssueKey', () => {
  const searchMessages = vi.fn();
  const slack = { searchMessages };

  beforeEach(() => {
    searchMessages.mockReset();
  });

  function foundMatches(...matches: Array<Record<string, unknown>>) {
    searchMessages.mockResolvedValue(searchResponse(matches));
  }

  it('searches the quoted key outside direct messages, newest messages first', async () => {
    foundMatches();

    await findThreadsForIssueKey(slack, TEAM_URL, ISSUE_KEY);

    expect(searchMessages).toHaveBeenCalledTimes(1);
    expect(searchMessages).toHaveBeenCalledWith({
      query: '"TAP-1234" -is:dm',
      count: expect.any(Number),
      sort: 'timestamp',
      sort_dir: 'desc',
    });
  });

  it('returns no threads when nothing matches', async () => {
    foundMatches();

    expect(await findThreadsForIssueKey(slack, TEAM_URL, ISSUE_KEY)).toEqual([]);
  });

  it('links a top-level message as its own thread', async () => {
    foundMatches(searchMatch({ ts: tsAt(30), channelId: CHANNEL_ID }));

    const threads = await findThreadsForIssueKey(slack, TEAM_URL, ISSUE_KEY);

    expect(threads).toEqual([
      {
        permalink: permalinkTo(CHANNEL_ID, tsAt(30)),
        channel: CHANNEL_NAME,
        channelId: CHANNEL_ID,
        threadTs: tsAt(30),
        at: '2023-11-14T22:13:50.000Z',
      },
    ]);
  });

  it('links a reply through the thread root, with the time of the reply that matched', async () => {
    foundMatches(searchMatch({ ts: tsAt(50), threadTs: tsAt(10) }));

    const [thread] = await findThreadsForIssueKey(slack, TEAM_URL, ISSUE_KEY);

    expect(thread.permalink).toBe(permalinkTo(CHANNEL_ID, tsAt(10)));
    expect(thread.threadTs).toBe(tsAt(10));
    expect(thread.at).toBe('2023-11-14T22:14:10.000Z');
  });

  it('collapses several matches in one thread into one entry at the newest match', async () => {
    foundMatches(
      searchMatch({ ts: tsAt(50), threadTs: tsAt(10) }),
      searchMatch({ ts: tsAt(30), threadTs: tsAt(10) }),
      searchMatch({ ts: tsAt(10), threadTs: tsAt(10) }),
    );

    const threads = await findThreadsForIssueKey(slack, TEAM_URL, ISSUE_KEY);

    expect(threads).toHaveLength(1);
    expect(threads[0].at).toBe('2023-11-14T22:14:10.000Z');
  });

  it('keeps the same thread ts in two channels as two threads', async () => {
    foundMatches(
      searchMatch({ ts: tsAt(40), threadTs: tsAt(10), channelId: CHANNEL_ID }),
      searchMatch({ ts: tsAt(30), threadTs: tsAt(10), channelId: OTHER_CHANNEL_ID }),
    );

    const threads = await findThreadsForIssueKey(slack, TEAM_URL, ISSUE_KEY);

    expect(threads.map((thread) => thread.channelId)).toEqual([CHANNEL_ID, OTHER_CHANNEL_ID]);
  });

  it('orders threads by their newest matching message', async () => {
    foundMatches(
      searchMatch({ ts: tsAt(90), threadTs: tsAt(60) }),
      searchMatch({ ts: tsAt(80), threadTs: tsAt(20) }),
      searchMatch({ ts: tsAt(70), threadTs: tsAt(60) }),
    );

    const threads = await findThreadsForIssueKey(slack, TEAM_URL, ISSUE_KEY);

    expect(threads.map((thread) => thread.threadTs)).toEqual([tsAt(60), tsAt(20)]);
  });

  it(`keeps at most ${MAX_THREADS_PER_ISSUE} threads, the newest ones`, async () => {
    const matches = Array.from({ length: 8 }, (_, index) => searchMatch({ ts: tsAt(100 - index) }));
    foundMatches(...matches);

    const threads = await findThreadsForIssueKey(slack, TEAM_URL, ISSUE_KEY);

    expect(threads).toHaveLength(5);
    expect(threads.map((thread) => thread.threadTs)).toEqual([100, 99, 98, 97, 96].map(tsAt));
  });

  it('falls back to the message itself when its match has no permalink to name a thread', async () => {
    const { permalink: _permalink, ...withoutPermalink } = searchMatch({ ts: tsAt(30), threadTs: tsAt(10) });
    foundMatches(withoutPermalink);

    const [thread] = await findThreadsForIssueKey(slack, TEAM_URL, ISSUE_KEY);

    expect(thread.threadTs).toBe(tsAt(30));
  });

  describe('conversations that are not channels', () => {
    it('skips a direct message flagged as one', async () => {
      foundMatches(searchMatch({ ts: tsAt(30), channelId: OTHER_CHANNEL_ID, isIm: true }));

      expect(await findThreadsForIssueKey(slack, TEAM_URL, ISSUE_KEY)).toEqual([]);
    });

    it('skips a group direct message flagged as one', async () => {
      foundMatches(searchMatch({ ts: tsAt(30), channelId: OTHER_CHANNEL_ID, isMpim: true }));

      expect(await findThreadsForIssueKey(slack, TEAM_URL, ISSUE_KEY)).toEqual([]);
    });

    it('skips a direct message by its D id when the match carries no flags', async () => {
      foundMatches(searchMatch({ ts: tsAt(30), channelId: DM_ID }));

      expect(await findThreadsForIssueKey(slack, TEAM_URL, ISSUE_KEY)).toEqual([]);
    });

    it('keeps the channel threads found beside a direct message', async () => {
      foundMatches(
        searchMatch({ ts: tsAt(40), channelId: DM_ID, isIm: true }),
        searchMatch({ ts: tsAt(35), channelId: GROUP_DM_ID, isMpim: true }),
        searchMatch({ ts: tsAt(30), channelId: CHANNEL_ID, isIm: false, isMpim: false }),
      );

      const threads = await findThreadsForIssueKey(slack, TEAM_URL, ISSUE_KEY);

      expect(threads.map((thread) => thread.channelId)).toEqual([CHANNEL_ID]);
    });

    it('does not let a direct message use up one of the thread slots', async () => {
      const directMessages = Array.from({ length: 6 }, (_, index) =>
        searchMatch({ ts: tsAt(100 - index), channelId: DM_ID, isIm: true }),
      );
      foundMatches(...directMessages, searchMatch({ ts: tsAt(10) }));

      expect(await findThreadsForIssueKey(slack, TEAM_URL, ISSUE_KEY)).toHaveLength(1);
    });
  });

  it('skips bot messages', async () => {
    foundMatches(searchMatch({ ts: tsAt(40), bot: true }), searchMatch({ ts: tsAt(30) }));

    const threads = await findThreadsForIssueKey(slack, TEAM_URL, ISSUE_KEY);

    expect(threads.map((thread) => thread.threadTs)).toEqual([tsAt(30)]);
  });

  it('skips a match that names no channel', async () => {
    const { channel: _channel, ...withoutChannel } = searchMatch({ ts: tsAt(30) });
    foundMatches(withoutChannel);

    expect(await findThreadsForIssueKey(slack, TEAM_URL, ISSUE_KEY)).toEqual([]);
  });

  it('builds permalinks from a team url with or without a trailing slash', async () => {
    foundMatches(searchMatch({ ts: tsAt(30) }));

    const [withSlash] = await findThreadsForIssueKey(slack, 'https://example-team.slack.com/', ISSUE_KEY);
    const [withoutSlash] = await findThreadsForIssueKey(slack, 'https://example-team.slack.com', ISSUE_KEY);

    expect(withSlash.permalink).toBe(permalinkTo(CHANNEL_ID, tsAt(30)));
    expect(withoutSlash.permalink).toBe(withSlash.permalink);
  });

  it('returns links only, never message text', async () => {
    foundMatches(searchMatch({ ts: tsAt(30) }));

    const threads = await findThreadsForIssueKey(slack, TEAM_URL, ISSUE_KEY);

    expect(JSON.stringify(threads)).not.toContain(MESSAGE_TEXT_MARKER);
    expect(Object.keys(onTheWire(threads[0])).sort()).toEqual(['at', 'channel', 'channelId', 'permalink', 'threadTs']);
  });

  it('lets a Slack failure reach the caller', async () => {
    searchMessages.mockRejectedValue(Object.assign(new Error('Slack could not be reached.'), { code: 'unreachable' }));

    await expect(findThreadsForIssueKey(slack, TEAM_URL, ISSUE_KEY)).rejects.toMatchObject({ code: 'unreachable' });
  });
});
