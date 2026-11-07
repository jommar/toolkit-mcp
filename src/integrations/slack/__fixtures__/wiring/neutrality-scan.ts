import { readFileSync } from 'node:fs';

const GENERIC_HOSTS = new Set(['slack.com', 'api.slack.com', 'app.slack.com', 'files.slack.com', 'files-origin.slack.com']);
const PLACEHOLDER_HOST = /^(example-team|other-team)(\.enterprise)?\.slack\.com$/;
const HOST_PATTERN = /\b(?:[a-z0-9-]+\.)+slack\.com\b/gi;
const SLACK_ID_PATTERN = /\b(?=[A-Z0-9]*\d)[CDEGUWTFBS][A-Z0-9]{8,11}\b/g;
const FIXTURE_MARKER = 'EXAMPLE';

export interface Finding {
  line: number;
}

function findingsFor(text: string, pattern: RegExp, isViolation: (match: string) => boolean): Finding[] {
  const findings: Finding[] = [];
  text.split('\n').forEach((lineText, index) => {
    for (const match of lineText.matchAll(pattern)) {
      if (isViolation(match[0])) findings.push({ line: index + 1 });
    }
  });
  return findings;
}

export function findHostViolations(text: string): Finding[] {
  return findingsFor(text, HOST_PATTERN, (host) => {
    const lowered = host.toLowerCase();
    return !GENERIC_HOSTS.has(lowered) && !PLACEHOLDER_HOST.test(lowered);
  });
}

export function findIdViolations(text: string): Finding[] {
  return findingsFor(text, SLACK_ID_PATTERN, (word) => !word.includes(FIXTURE_MARKER));
}

export function readDenyEntries(denyFilePath: string | undefined): string[] {
  if (!denyFilePath) return [];
  return readFileSync(denyFilePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

export function findDeniedNames(text: string, entries: string[]): Finding[] {
  const findings: Finding[] = [];
  text.split('\n').forEach((lineText, index) => {
    const lowered = lineText.toLowerCase();
    if (entries.some((entry) => lowered.includes(entry.toLowerCase()))) findings.push({ line: index + 1 });
  });
  return findings;
}
