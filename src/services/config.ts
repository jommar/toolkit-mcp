import { config } from 'dotenv';
config({ override: true });

export interface JiraConfig {
  baseUrl: string;
  email: string;
  token: string;
}

/**
 * Read and validate Jira connection settings from the environment (.env).
 * Throws with an actionable message if anything required is missing.
 */
export function loadConfig(): JiraConfig {
  const baseUrl = process.env.JIRA_BASE_URL?.trim();
  const email = process.env.JIRA_EMAIL?.trim();
  const token = process.env.JIRA_TOKEN?.trim();

  const missing: string[] = [];
  if (!baseUrl) missing.push('JIRA_BASE_URL');
  if (!email) missing.push('JIRA_EMAIL');
  if (!token) missing.push('JIRA_TOKEN');
  if (missing.length) {
    throw new Error(
      `Missing required env var(s): ${missing.join(', ')}. ` +
        `See .env.example — Atlassian Cloud uses Basic auth (<email>:<api-token>).`,
    );
  }

  return {
    baseUrl: baseUrl!.replace(/\/+$/, ''),
    email: email!,
    token: token!,
  };
}

export interface ConfluenceConfig {
  /** Confluence root, always ending in `/wiki` (e.g. https://site.atlassian.net/wiki). */
  baseUrl: string;
  email: string;
  token: string;
}

/**
 * Read Confluence connection settings. Confluence Cloud shares Atlassian account
 * credentials with Jira, so this falls back to the JIRA_* vars unless CONFLUENCE_*
 * overrides are set. The base URL is normalized to always end in `/wiki`, accepting
 * either the bare site or a `.../wiki` value.
 */
export function loadConfluenceConfig(): ConfluenceConfig {
  const rawBase = (process.env.CONFLUENCE_BASE_URL ?? process.env.JIRA_BASE_URL)?.trim();
  const email = (process.env.CONFLUENCE_EMAIL ?? process.env.JIRA_EMAIL)?.trim();
  const token = (process.env.CONFLUENCE_TOKEN ?? process.env.JIRA_TOKEN)?.trim();

  const missing: string[] = [];
  if (!rawBase) missing.push('CONFLUENCE_BASE_URL or JIRA_BASE_URL');
  if (!email) missing.push('CONFLUENCE_EMAIL or JIRA_EMAIL');
  if (!token) missing.push('CONFLUENCE_TOKEN or JIRA_TOKEN');
  if (missing.length) {
    throw new Error(
      `Missing required env var(s): ${missing.join(', ')}. ` +
        `Confluence Cloud reuses your Atlassian (Jira) credentials — see .env.example.`,
    );
  }

  const baseUrl = rawBase!.replace(/\/+$/, '').replace(/\/wiki$/i, '') + '/wiki';
  return { baseUrl, email: email!, token: token! };
}
