import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OAUTH_CALLBACK_PATH, OAUTH_CALLBACK_PORT, OAUTH_REDIRECT_URL, TOOL_SCOPES } from './slack-app.js';
import { ALL_USER_SCOPES } from './__fixtures__/synthetic.js';

const MANIFEST_URL = new URL('../../../docs/slack-app-manifest.json', import.meta.url);

const HISTORY_SCOPES = ['channels:history', 'groups:history', 'im:history', 'mpim:history'];
const READ_SCOPES = ['channels:read', 'groups:read', 'im:read', 'mpim:read'];
const GENERIC_SLACK_HOSTS = ['slack.com', 'api.slack.com', 'app.slack.com'];

const sorted = (values: readonly string[]) => [...values].sort();
const unionOfToolScopes = () => [...new Set(Object.values(TOOL_SCOPES).flat())];

function readManifest(): any {
  return JSON.parse(fs.readFileSync(MANIFEST_URL, 'utf8'));
}

function* walkManifest(node: unknown, keyPath: string[] = []): Generator<{ keyPath: string[]; value: unknown }> {
  if (node !== null && typeof node === 'object') {
    for (const [key, child] of Object.entries(node)) yield* walkManifest(child, [...keyPath, key]);
    return;
  }
  yield { keyPath, value: node };
}

describe('slack app definition', () => {
  describe('tool scopes', () => {
    it('unions to exactly the fifteen user scopes the spec lists, users:read.email included', () => {
      expect(sorted(unionOfToolScopes())).toEqual(sorted(ALL_USER_SCOPES));
      expect(unionOfToolScopes()).toContain('users:read.email');
    });

    it('asks for no scope on login, logout and status', () => {
      expect(TOOL_SCOPES.slack_login).toEqual([]);
      expect(TOOL_SCOPES.slack_logout).toEqual([]);
      expect(TOOL_SCOPES.slack_get_status).toEqual([]);
    });

    it('derives the read tools\' scopes from the methods they call', () => {
      expect(sorted(TOOL_SCOPES.slack_search_messages)).toEqual(['search:read']);
      expect(sorted(TOOL_SCOPES.slack_get_messages)).toEqual(sorted(HISTORY_SCOPES));
      expect(sorted(TOOL_SCOPES.slack_get_threads)).toEqual(sorted(HISTORY_SCOPES));
      expect(sorted(TOOL_SCOPES.slack_get_channels)).toEqual(sorted([...READ_SCOPES, 'search:read']));
      expect(sorted(TOOL_SCOPES.slack_get_users)).toEqual(['users:read', 'users:read.email']);
    });

    it('gives the confirm step the three write scopes', () => {
      expect(sorted(TOOL_SCOPES.slack_confirm_write)).toEqual(['chat:write', 'files:write', 'reactions:write']);
    });

    it('gives the download tool the files:read scope', () => {
      expect(TOOL_SCOPES.slack_download_file).toEqual(['files:read']);
    });
  });

  describe('redirect constants', () => {
    it('is the loopback localhost URL on the fixed port and callback path', () => {
      expect(OAUTH_CALLBACK_PATH).toBe('/slack/oauth/callback');
      expect(OAUTH_CALLBACK_PORT).toBeGreaterThanOrEqual(1024);
      expect(OAUTH_CALLBACK_PORT).toBeLessThanOrEqual(65535);
      expect(OAUTH_REDIRECT_URL).toBe(`http://localhost:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`);
    });
  });

  describe('manifest', () => {
    it('requests exactly the union of the per-tool user scopes, once each', () => {
      const manifestScopes: string[] = readManifest().oauth_config.scopes.user;

      expect(sorted(manifestScopes)).toEqual(sorted(unionOfToolScopes()));
      expect(sorted(manifestScopes)).toEqual(sorted(ALL_USER_SCOPES));
      expect(new Set(manifestScopes).size).toBe(manifestScopes.length);
    });

    it('lists the listener redirect URL and no other', () => {
      expect(readManifest().oauth_config.redirect_urls).toEqual([OAUTH_REDIRECT_URL]);
    });

    it('turns PKCE on and token rotation off', () => {
      const manifest = readManifest();

      expect(manifest.oauth_config.pkce_enabled).toBe(true);
      expect(manifest.settings.token_rotation_enabled).toBe(false);
    });

    it('has no bot user and no bot scopes', () => {
      const manifest = readManifest();

      expect(manifest.features?.bot_user).toBeUndefined();
      expect(manifest.oauth_config.scopes.bot ?? []).toEqual([]);
    });

    it('holds no workspace value: no team keys, no workspace hosts, no Slack ids', () => {
      const entries = [...walkManifest(readManifest())];
      const workspaceKeys = entries.filter(({ keyPath }) =>
        keyPath.some((key) => /^(team_id|team_domain|team_url|workspace|workspace_id)$/i.test(key)),
      );
      const strings = entries.map(({ value }) => value).filter((value): value is string => typeof value === 'string');
      const hostsOnSlack = strings.flatMap((value) => value.match(/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.slack\.com/gi) ?? []);
      const idShapedWords = strings.flatMap((value) => value.match(/\b[CDGTUWF][A-Z0-9]{8,}\b/g) ?? []);

      expect(workspaceKeys).toEqual([]);
      expect(hostsOnSlack.filter((host) => !GENERIC_SLACK_HOSTS.includes(host.toLowerCase()))).toEqual([]);
      expect(idShapedWords).toEqual([]);
    });
  });
});
