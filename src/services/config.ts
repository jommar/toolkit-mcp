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
