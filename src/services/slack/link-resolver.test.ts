import { describe, it, expect } from 'vitest';
import { matchesWorkspace, resolveLink } from './link-resolver.js';
import {
  archiveLink,
  CHANNEL_ID,
  DM_ID,
  EXAMPLE_TEAM,
  FILE_ID,
  GROUP_DM_ID,
  OTHER_TEAM,
  REPLY_TS,
  REPLY_TS_PERMALINK_SEGMENT,
  ROOT_TS,
  ROOT_TS_PERMALINK_SEGMENT,
  tokenRecord,
  USER_ID,
} from './__fixtures__/synthetic.js';

const workspaces = [EXAMPLE_TEAM, OTHER_TEAM] as const;

function resolvedLink(url: string) {
  const result = resolveLink(url);
  if (!result.ok) throw new Error(`expected ${url} to resolve, got ${result.error.code}`);
  return result.link;
}

describe('resolveLink', () => {
  describe.each(workspaces)('the four user-shown shapes in $team_domain', (workspace) => {
    const domain = workspace.team_domain;

    it('resolves a DM link to a conversation', () => {
      expect(resolvedLink(archiveLink(domain, DM_ID))).toMatchObject({
        kind: 'conversation',
        team_domain: domain,
        channel_id: DM_ID,
      });
    });

    it('resolves a channel link to a conversation', () => {
      expect(resolvedLink(archiveLink(domain, CHANNEL_ID))).toMatchObject({
        kind: 'conversation',
        team_domain: domain,
        channel_id: CHANNEL_ID,
      });
    });

    it('resolves a top-level message link to the channel and the dotted ts', () => {
      const link = resolvedLink(archiveLink(domain, CHANNEL_ID, ROOT_TS_PERMALINK_SEGMENT));

      expect(link).toMatchObject({ kind: 'message', team_domain: domain, channel_id: CHANNEL_ID, ts: ROOT_TS });
      expect(link.thread_ts).toBeUndefined();
    });

    it('resolves a reply link so its thread_ts equals the top-level message link ts', () => {
      const topLevel = resolvedLink(archiveLink(domain, CHANNEL_ID, ROOT_TS_PERMALINK_SEGMENT));
      const reply = resolvedLink(
        archiveLink(domain, CHANNEL_ID, REPLY_TS_PERMALINK_SEGMENT, `thread_ts=${ROOT_TS}&cid=${CHANNEL_ID}`),
      );

      expect(reply).toMatchObject({ kind: 'message', channel_id: CHANNEL_ID, ts: REPLY_TS });
      expect(reply.thread_ts).toBe(topLevel.ts);
    });
  });

  describe('the other shapes', () => {
    it('resolves a group DM link', () => {
      expect(resolvedLink(archiveLink('example-team', GROUP_DM_ID))).toMatchObject({
        kind: 'conversation',
        channel_id: GROUP_DM_ID,
      });
    });

    it('resolves a message in a DM', () => {
      expect(resolvedLink(archiveLink('example-team', DM_ID, ROOT_TS_PERMALINK_SEGMENT))).toMatchObject({
        kind: 'message',
        channel_id: DM_ID,
        ts: ROOT_TS,
      });
    });

    it('resolves a web-client channel link to a conversation with the team id and ignores trailing segments', () => {
      expect(
        resolvedLink(`https://app.slack.com/client/${EXAMPLE_TEAM.team_id}/${CHANNEL_ID}/details/members`),
      ).toMatchObject({
        kind: 'conversation',
        team_id: EXAMPLE_TEAM.team_id,
        channel_id: CHANNEL_ID,
      });
    });

    it('resolves a web-client thread link to the root message with the team id', () => {
      expect(
        resolvedLink(`https://app.slack.com/client/${OTHER_TEAM.team_id}/${CHANNEL_ID}/thread/${CHANNEL_ID}-${ROOT_TS}`),
      ).toMatchObject({
        kind: 'message',
        team_id: OTHER_TEAM.team_id,
        channel_id: CHANNEL_ID,
        ts: ROOT_TS,
      });
    });

    it('resolves a user profile link', () => {
      expect(resolvedLink(`https://example-team.slack.com/team/${USER_ID}`)).toMatchObject({
        kind: 'user',
        team_domain: 'example-team',
        user_id: USER_ID,
      });
    });

    it('resolves a file link', () => {
      expect(resolvedLink(`https://example-team.slack.com/files/${USER_ID}/${FILE_ID}/name.txt`)).toMatchObject({
        kind: 'file',
        team_domain: 'example-team',
        file_id: FILE_ID,
      });
    });

    it('takes the first label of an Enterprise Grid host as the domain', () => {
      expect(
        resolvedLink(`https://example-team.enterprise.slack.com/archives/${CHANNEL_ID}/${ROOT_TS_PERMALINK_SEGMENT}`),
      ).toMatchObject({ kind: 'message', team_domain: 'example-team', channel_id: CHANNEL_ID, ts: ROOT_TS });
    });
  });

  describe.each([
    ['an empty string', ''],
    ['plain text', 'not a url'],
    ['a foreign host', `https://example.com/archives/${CHANNEL_ID}`],
    ['a custom scheme', `slack://channel?team=${EXAMPLE_TEAM.team_id}&id=${CHANNEL_ID}`],
    ['a lookalike host that only starts with a Slack domain', `https://example-team.slack.com.attacker.example/archives/${CHANNEL_ID}`],
    ['a workspace root with no path', 'https://example-team.slack.com/'],
    ['an archives path with no id', 'https://example-team.slack.com/archives'],
  ])('%s', (_label, input) => {
    it('reports unrecognized_link instead of throwing', () => {
      expect(() => resolveLink(input)).not.toThrow();
      const result = resolveLink(input);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('unrecognized_link');
    });
  });
});

describe('matchesWorkspace', () => {
  const exampleToken = tokenRecord();
  const otherToken = tokenRecord({
    team_id: OTHER_TEAM.team_id,
    team_domain: OTHER_TEAM.team_domain,
    team_url: OTHER_TEAM.team_url,
  });

  it('accepts a link of the connected workspace by domain', () => {
    expect(matchesWorkspace(resolvedLink(archiveLink('example-team', CHANNEL_ID)), exampleToken)).toEqual({ ok: true });
  });

  it('accepts an Enterprise Grid link of the connected workspace', () => {
    const link = resolvedLink(`https://example-team.enterprise.slack.com/archives/${CHANNEL_ID}`);

    expect(matchesWorkspace(link, exampleToken)).toEqual({ ok: true });
  });

  it('accepts a web-client link carrying the connected team id', () => {
    const link = resolvedLink(`https://app.slack.com/client/${EXAMPLE_TEAM.team_id}/${CHANNEL_ID}`);

    expect(matchesWorkspace(link, exampleToken)).toEqual({ ok: true });
  });

  it('rejects another workspace link and names the connected workspace', () => {
    const result = matchesWorkspace(resolvedLink(archiveLink('other-team', CHANNEL_ID)), exampleToken);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('wrong_workspace');
      expect(result.error.message).toContain('example-team');
    }
  });

  it('rejects a web-client link carrying another team id', () => {
    const link = resolvedLink(`https://app.slack.com/client/${OTHER_TEAM.team_id}/${CHANNEL_ID}`);

    const result = matchesWorkspace(link, exampleToken);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('wrong_workspace');
  });

  it('compares with the stored team, so the same links swap verdicts when the other workspace is connected', () => {
    const exampleLink = resolvedLink(archiveLink('example-team', CHANNEL_ID));
    const otherLink = resolvedLink(archiveLink('other-team', CHANNEL_ID));

    expect(matchesWorkspace(otherLink, otherToken)).toEqual({ ok: true });
    const rejected = matchesWorkspace(exampleLink, otherToken);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('wrong_workspace');
      expect(rejected.error.message).toContain('other-team');
    }
  });
});
