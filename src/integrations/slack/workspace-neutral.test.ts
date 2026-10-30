import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  findDeniedNames,
  findHostViolations,
  findIdViolations,
  readDenyEntries,
  type Finding,
} from './__fixtures__/wiring/neutrality-scan.js';

const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SOURCE_DIRECTORIES = ['src/integrations/slack', 'src/services/slack'];
const SHIPPED_FILES = ['README.md', 'docs/slack.md', 'docs/slack-app-manifest.json', '.env.example', 'CHANGELOG.md'];

const SLACK_DOMAIN = ['slack', 'com'].join('.');

function leakyHost(...labels: string[]): string {
  return [...labels, SLACK_DOMAIN].join('.');
}

function leakyId(prefix: string): string {
  return `${prefix}01LEAKY0001`;
}

function moduleSourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return moduleSourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

function scannedFiles(): string[] {
  return [
    ...SOURCE_DIRECTORIES.flatMap((directory) => moduleSourceFiles(resolve(PROJECT_ROOT, directory))),
    ...SHIPPED_FILES.map((file) => resolve(PROJECT_ROOT, file)),
  ].filter((file) => existsSync(file));
}

function locations(find: (text: string) => Finding[], files: string[]): string[] {
  return files.flatMap((file) =>
    find(readFileSync(file, 'utf8')).map((finding) => `${relative(PROJECT_ROOT, file)}:${finding.line}`),
  );
}

describe('the scanned file set', () => {
  it('holds the module source and every shipped file', () => {
    const scanned = scannedFiles().map((file) => relative(PROJECT_ROOT, file));

    for (const shipped of SHIPPED_FILES) expect(scanned).toContain(shipped);
    expect(scanned).toContain('src/integrations/slack/index.ts');
    expect(scanned).toContain('src/services/slack/slack-client.ts');
    expect(scanned).toContain('src/services/slack/slack-app.ts');
  });

  it('holds the README', () => {
    expect(scannedFiles().map((file) => relative(PROJECT_ROOT, file))).toContain('README.md');
  });

  it('holds the fixtures of both module directories', () => {
    const scanned = scannedFiles().map((file) => relative(PROJECT_ROOT, file));

    expect(scanned).toContain('src/integrations/slack/__fixtures__/wiring/sentinels.ts');
    expect(scanned).toContain('src/services/slack/__fixtures__/loopback.ts');
  });

  it('holds the test files of both module directories, this one included', () => {
    const scanned = scannedFiles().map((file) => relative(PROJECT_ROOT, file));

    expect(scanned).toContain('src/integrations/slack/write-gate.test.ts');
    expect(scanned).toContain('src/services/slack/slack-app.test.ts');
    expect(scanned).toContain('src/integrations/slack/workspace-neutral.test.ts');
  });

  it('catches a leak planted in a fixture and in a test file of a directory tree', () => {
    const directory = mkdtempSync(join(tmpdir(), 'slack-tree-'));
    mkdirSync(join(directory, '__fixtures__', 'nested'), { recursive: true });
    const leak = `const host = 'https://${leakyHost('leaky-team')}/archives/C0EXAMPLE01';\n`;
    writeFileSync(join(directory, '__fixtures__', 'nested', 'planted.ts'), leak);
    writeFileSync(join(directory, 'planted.test.ts'), leak);
    writeFileSync(join(directory, 'clean.ts'), 'export const clean = 1;\n');

    const files = moduleSourceFiles(directory);
    const leaking = files
      .filter((file) => findHostViolations(readFileSync(file, 'utf8')).length > 0)
      .map((file) => relative(directory, file))
      .sort();
    rmSync(directory, { recursive: true, force: true });

    expect(leaking).toEqual([join('__fixtures__', 'nested', 'planted.ts'), 'planted.test.ts']);
  });
});

describe('workspace neutrality of the module', () => {
  it('names no workspace host beyond the generic hosts and the two placeholders', () => {
    expect(locations(findHostViolations, scannedFiles())).toEqual([]);
  });

  it('holds no Slack-id-shaped word without the fixture marker', () => {
    expect(locations(findIdViolations, scannedFiles())).toEqual([]);
  });

  it('holds no entry of the optional local deny file', () => {
    const entries = readDenyEntries(process.env.SLACK_NEUTRALITY_DENY_FILE);

    expect(locations((text) => findDeniedNames(text, entries), scannedFiles())).toEqual([]);
  });
});

describe('the scan itself', () => {
  it('flags a workspace host that is neither generic nor a placeholder', () => {
    const text = [
      `visit https://${leakyHost('leaky-team')}/archives/C0EXAMPLE01`,
      `or https://${leakyHost('leaky-team', 'enterprise')}/archives/C0EXAMPLE01`,
    ].join('\n');

    expect(findHostViolations(text)).toEqual([{ line: 1 }, { line: 2 }]);
  });

  it('passes the generic hosts and the placeholders', () => {
    const text = [
      'https://slack.com/api/auth.test',
      'https://api.slack.com/apps',
      'https://app.slack.com/client/T0EXAMPLE1/C0EXAMPLE01',
      'https://example-team.slack.com/archives/C0EXAMPLE01',
      'https://other-team.enterprise.slack.com/archives/D0EXAMPLE01',
    ].join('\n');

    expect(findHostViolations(text)).toEqual([]);
  });

  it('flags Slack-id-shaped words without the marker and passes marked ones and ordinary words', () => {
    const unmarked = ['C', 'D', 'U', 'T', 'G'].map(leakyId).join(' ');
    const marked = 'C0EXAMPLE01 D0EXAMPLE01 U0EXAMPLE01 T0EXAMPLE2 F0EXAMPLE01 G0EXAMPLE01';
    const ordinary = 'CHANGELOG README_V2 FIGMA_TOKEN TOKEN_ROTATION UTF8';

    expect(findIdViolations(unmarked)).toHaveLength(5);
    expect(findIdViolations(marked)).toEqual([]);
    expect(findIdViolations(ordinary)).toEqual([]);
  });

  it('flags unmarked Enterprise organisation and user group ids and passes marked ones', () => {
    const unmarked = [leakyId('E'), leakyId('S')].join(' ');
    const marked = 'E0EXAMPLE01 S0EXAMPLE01';

    expect(findIdViolations(unmarked)).toHaveLength(2);
    expect(findIdViolations(marked)).toEqual([]);
  });

  it('reads deny entries from a file, ignoring blanks and comments, and finds them case-insensitively', () => {
    const directory = mkdtempSync(join(tmpdir(), 'slack-deny-'));
    const denyFile = join(directory, 'deny.txt');
    writeFileSync(denyFile, '# names to keep out\n\nLeaky-Team\n  other-name  \n');

    const entries = readDenyEntries(denyFile);
    rmSync(directory, { recursive: true, force: true });

    expect(entries).toEqual(['Leaky-Team', 'other-name']);
    expect(findDeniedNames('a line\nmentions LEAKY-TEAM here', entries)).toEqual([{ line: 2 }]);
    expect(findDeniedNames('nothing to see', entries)).toEqual([]);
  });

  it('reads no deny entries when no file is named', () => {
    expect(readDenyEntries(undefined)).toEqual([]);
  });
});
