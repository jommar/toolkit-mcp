import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadSkills } from '@modelcontextprotocol/server/ext/skills/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { modules } from './integrations/index.js';
import { healthDescriptor } from './mcp-health.js';
import { loadServedSkills, SKILLS_ROOT } from './mcp-skills.js';

const SKILL_DIR = path.join(SKILLS_ROOT, 'toolkit-mcp');
const SKILL_FILES = [
  'SKILL.md',
  'references/confluence.md',
  'references/github.md',
  'references/jenkins-figma.md',
  'references/jira.md',
  'references/server.md',
  'references/slack.md',
];
/** Words in the guide shaped like a tool name that are not tools. */
const NOT_TOOLS = new Set(['slack_connect']);
const TOOL_NAME = /\b(?:jira|github|confluence|jenkins|figma|slack|mcp)_[a-z0-9]+(?:_[a-z0-9]+)*\b/g;

const descriptors = () => [healthDescriptor, ...modules.flatMap((m) => m.getToolDescriptors())];
const registeredTools = () => [healthDescriptor.name, ...modules.flatMap((m) => m.getToolDescriptors().map((d) => d.name))];
const guideText = () => SKILL_FILES.map((file) => readFileSync(path.join(SKILL_DIR, file), 'utf8')).join('\n');
const logger = () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn() });

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the served skill catalog', () => {
  it('builds under strict checks and serves only skill://toolkit-mcp/SKILL.md', async () => {
    const catalog = await loadSkills(SKILLS_ROOT, { strict: true });

    expect(catalog.entries.map((skill) => skill.uri)).toEqual(['skill://toolkit-mcp/SKILL.md']);
  });

  it('publishes every file of the skill folder, and the file list here names them all', async () => {
    const [skill] = (await loadSkills(SKILLS_ROOT, { strict: true })).entries;
    const onDisk = readdirSync(SKILL_DIR, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(SKILL_DIR, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
      .sort();

    expect(onDisk).toEqual(SKILL_FILES);
    expect(Array.isArray(skill!.resources)).toBe(true);
    const resources = skill!.resources as Array<{ uri: string }>;
    expect(resources.map((r) => r.uri).sort()).toEqual(SKILL_FILES.map((file) => `skill://toolkit-mcp/${file}`).sort());
  });
});

describe('the guide matches the registered tools', () => {
  it('names every registered tool', () => {
    const named = new Set(guideText().match(TOOL_NAME));

    expect(registeredTools().filter((tool) => !named.has(tool))).toEqual([]);
  });

  it('names no tool the server does not register', () => {
    const registered = new Set(registeredTools());
    const unknown = [...new Set(guideText().match(TOOL_NAME))].filter((name) => !registered.has(name) && !NOT_TOOLS.has(name));

    expect(unknown).toEqual([]);
  });

  it('gives every tool a table row in references/ that names each of its top-level parameters', () => {
    const rows = SKILL_FILES.filter((file) => file.startsWith('references/'))
      .flatMap((file) => readFileSync(path.join(SKILL_DIR, file), 'utf8').split('\n'))
      .filter((line) => line.startsWith('| `'));
    const gaps = descriptors().flatMap((descriptor) => {
      const row = rows.find((line) => line.startsWith(`| \`${descriptor.name}\` |`));
      if (!row) return [`${descriptor.name}: no table row`];
      return Object.keys(descriptor.inputSchema.shape)
        .filter((param) => !new RegExp(`\`${param}\\b`).test(row))
        .map((param) => `${descriptor.name}: ${param}`);
    });

    expect(gaps).toEqual([]);
  });
});

describe('loadServedSkills', () => {
  it('logs the count and returns the catalog', async () => {
    const log = logger();

    const skills = await loadServedSkills(log);

    expect(skills).toBeDefined();
    expect(log.info).toHaveBeenCalledWith('Skills served: 1');
    expect(log.error).not.toHaveBeenCalled();
  });

  it('logs a skill problem and skips that skill', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'toolkit-skills-'));
    temps.push(root);
    mkdirSync(path.join(root, 'broken'));
    writeFileSync(path.join(root, 'broken', 'SKILL.md'), 'no frontmatter\n');
    const log = logger();

    const skills = await loadServedSkills(log, root);

    expect(skills).toBeDefined();
    expect(log.info).toHaveBeenCalledWith('Skills served: 0');
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/^Skill .*broken/));
  });

  it('serves no skills when the folder cannot be read', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'toolkit-skills-'));
    temps.push(root);
    const log = logger();

    const skills = await loadServedSkills(log, path.join(root, 'missing'));

    expect(skills).toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/^Failed to load skills: /));
  });
});
