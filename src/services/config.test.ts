import { describe, it, expect, vi } from 'vitest';

// Mock dotenv to prevent side effects and so we can verify C4 fix
const dotenvConfigMock = vi.fn();
vi.mock('dotenv', () => ({
  config: dotenvConfigMock,
}));

describe('loadConfig', () => {
  it('throws when all env vars are missing', async () => {
    delete process.env.JIRA_BASE_URL;
    delete process.env.JIRA_EMAIL;
    delete process.env.JIRA_TOKEN;

    const { loadConfig } = await import('./config.js');
    expect(() => loadConfig()).toThrow('Missing required env var(s): JIRA_BASE_URL, JIRA_EMAIL, JIRA_TOKEN');
  });

  it('throws when JIRA_BASE_URL is missing', async () => {
    process.env.JIRA_EMAIL = 'test@example.com';
    process.env.JIRA_TOKEN = 'test-token';
    delete process.env.JIRA_BASE_URL;

    const { loadConfig } = await import('./config.js');
    expect(() => loadConfig()).toThrow('JIRA_BASE_URL');
  });

  it('throws when JIRA_EMAIL is missing', async () => {
    process.env.JIRA_BASE_URL = 'https://test.atlassian.net';
    delete process.env.JIRA_EMAIL;
    process.env.JIRA_TOKEN = 'test-token';

    const { loadConfig } = await import('./config.js');
    expect(() => loadConfig()).toThrow('JIRA_EMAIL');
  });

  it('throws when JIRA_TOKEN is missing', async () => {
    process.env.JIRA_BASE_URL = 'https://test.atlassian.net';
    process.env.JIRA_EMAIL = 'test@example.com';
    delete process.env.JIRA_TOKEN;

    const { loadConfig } = await import('./config.js');
    expect(() => loadConfig()).toThrow('JIRA_TOKEN');
  });

  it('returns config when all vars are present', async () => {
    process.env.JIRA_BASE_URL = 'https://test.atlassian.net';
    process.env.JIRA_EMAIL = 'test@example.com';
    process.env.JIRA_TOKEN = 'secret-token';

    const { loadConfig } = await import('./config.js');
    const config = loadConfig();

    expect(config.baseUrl).toBe('https://test.atlassian.net');
    expect(config.email).toBe('test@example.com');
    expect(config.token).toBe('secret-token');
  });

  it('strips trailing slashes from baseUrl', async () => {
    process.env.JIRA_BASE_URL = 'https://test.atlassian.net///';
    process.env.JIRA_EMAIL = 'test@example.com';
    process.env.JIRA_TOKEN = 'token';

    const { loadConfig } = await import('./config.js');
    const config = loadConfig();

    expect(config.baseUrl).toBe('https://test.atlassian.net');
  });

  it('trims whitespace from env vars', async () => {
    process.env.JIRA_BASE_URL = '  https://test.atlassian.net  ';
    process.env.JIRA_EMAIL = '  test@example.com  ';
    process.env.JIRA_TOKEN = '  token  ';

    const { loadConfig } = await import('./config.js');
    const config = loadConfig();

    expect(config.baseUrl).toBe('https://test.atlassian.net');
    expect(config.email).toBe('test@example.com');
    expect(config.token).toBe('token');
  });
});

describe('loadConfluenceConfig', () => {
  it('falls back to JIRA_* vars when CONFLUENCE_* are not set', async () => {
    process.env.JIRA_BASE_URL = 'https://test.atlassian.net';
    process.env.JIRA_EMAIL = 'jira@example.com';
    process.env.JIRA_TOKEN = 'jira-token';
    delete process.env.CONFLUENCE_BASE_URL;
    delete process.env.CONFLUENCE_EMAIL;
    delete process.env.CONFLUENCE_TOKEN;

    const { loadConfluenceConfig } = await import('./config.js');
    const config = loadConfluenceConfig();

    expect(config.baseUrl).toBe('https://test.atlassian.net/wiki');
    expect(config.email).toBe('jira@example.com');
    expect(config.token).toBe('jira-token');
  });

  it('uses CONFLUENCE_* vars when set', async () => {
    process.env.CONFLUENCE_BASE_URL = 'https://confluence.atlassian.net';
    process.env.CONFLUENCE_EMAIL = 'confluence@example.com';
    process.env.CONFLUENCE_TOKEN = 'confluence-token';

    const { loadConfluenceConfig } = await import('./config.js');
    const config = loadConfluenceConfig();

    expect(config.baseUrl).toBe('https://confluence.atlassian.net/wiki');
    expect(config.email).toBe('confluence@example.com');
    expect(config.token).toBe('confluence-token');
  });

  it('normalizes base URL to end in /wiki', async () => {
    delete process.env.CONFLUENCE_BASE_URL;
    delete process.env.CONFLUENCE_EMAIL;
    delete process.env.CONFLUENCE_TOKEN;
    process.env.JIRA_BASE_URL = 'https://test.atlassian.net';
    process.env.JIRA_EMAIL = 'a@b.com';
    process.env.JIRA_TOKEN = 'tok';

    const { loadConfluenceConfig } = await import('./config.js');
    const config = loadConfluenceConfig();

    expect(config.baseUrl).toBe('https://test.atlassian.net/wiki');
  });

  it('does not double /wiki when already present', async () => {
    delete process.env.CONFLUENCE_BASE_URL;
    delete process.env.CONFLUENCE_EMAIL;
    delete process.env.CONFLUENCE_TOKEN;
    process.env.JIRA_BASE_URL = 'https://test.atlassian.net/wiki';
    process.env.JIRA_EMAIL = 'a@b.com';
    process.env.JIRA_TOKEN = 'tok';

    const { loadConfluenceConfig } = await import('./config.js');
    const config = loadConfluenceConfig();

    expect(config.baseUrl).toBe('https://test.atlassian.net/wiki');
    expect(config.baseUrl).not.toBe('https://test.atlassian.net/wiki/wiki');
  });

  it('throws when all fallback sources are missing', async () => {
    delete process.env.CONFLUENCE_BASE_URL;
    delete process.env.JIRA_BASE_URL;
    delete process.env.CONFLUENCE_EMAIL;
    delete process.env.JIRA_EMAIL;
    delete process.env.CONFLUENCE_TOKEN;
    delete process.env.JIRA_TOKEN;

    const { loadConfluenceConfig } = await import('./config.js');
    expect(() => loadConfluenceConfig()).toThrow('CONFLUENCE_BASE_URL or JIRA_BASE_URL');
  });
});

describe('dotenv behavior', () => {
  it('calls dotenv config() with override: true', async () => {
    const callArgs = dotenvConfigMock.mock.calls[0]?.[0];
    expect(callArgs).toBeDefined();
    expect(callArgs!.override).toBe(true);
  });
});
