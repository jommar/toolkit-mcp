import { describe, it, expect } from 'vitest';

import { modules } from './index.js';
import type { ToolAnnotations, ToolDescriptor } from './index.js';

describe('Module Registry', () => {
  it('exports exactly 6 modules', () => {
    expect(modules).toHaveLength(6);
  });

  it('all modules have correct ids', () => {
    const ids = modules.map((m) => m.id).sort();
    expect(ids).toEqual(['confluence', 'figma', 'github', 'jenkins', 'jira', 'slack']);
  });

  it('each module implements IntegrationModule interface', () => {
    for (const mod of modules) {
      expect(mod).toHaveProperty('id');
      expect(typeof mod.id).toBe('string');
      expect(typeof mod.needsEnv).toBe('function');
      expect(typeof mod.createToolHandlers).toBe('function');
      expect(typeof mod.getToolDescriptors).toBe('function');
    }
  });

  it('each module returns valid needsEnv result', () => {
    for (const mod of modules) {
      // needsEnv returns a boolean regardless of env state
      const result = mod.needsEnv();
      expect(typeof result).toBe('boolean');
    }
  });

  it('each module returns a handler for every descriptor from createToolHandlers/getToolDescriptors', () => {
    for (const mod of modules) {
      const handlers = mod.createToolHandlers({ [mod.id]: {} });
      expect(typeof handlers).toBe('object');
      expect(Object.keys(handlers).length).toBeGreaterThan(0);

      const descriptors = mod.getToolDescriptors();
      expect(Array.isArray(descriptors)).toBe(true);
      expect(descriptors.length).toBeGreaterThan(0);

      for (const d of descriptors) {
        expect(d).toHaveProperty('name');
        expect(d).toHaveProperty('title');
        expect(d).toHaveProperty('description');
        expect(d).toHaveProperty('inputSchema');
        expect(d).toHaveProperty('annotations');
        expect(typeof handlers[d.name], `${mod.id}: handler for ${d.name}`).toBe('function');
      }
    }
  });

  it('JiraModule serves resources and prompts', () => {
    const jiraMod = modules.find((m) => m.id === 'jira')!;
    expect(typeof jiraMod.getResourceHandler).toBe('function');
    expect(typeof jiraMod.getResourceDescriptors).toBe('function');
    expect(typeof jiraMod.getPromptHandler).toBe('function');
    expect(typeof jiraMod.getPromptDescriptors).toBe('function');
  });

  it('GitHubModule serves resources but not prompts', () => {
    const githubMod = modules.find((m) => m.id === 'github')!;
    expect(typeof githubMod.getResourceHandler).toBe('function');
    expect(typeof githubMod.getResourceDescriptors).toBe('function');
    expect(githubMod.getPromptHandler).toBeUndefined();
    expect(githubMod.getPromptDescriptors).toBeUndefined();
  });

  it.each(['figma', 'confluence', 'jenkins', 'slack'])('%s module serves no resources or prompts', (id) => {
    const mod = modules.find((m) => m.id === id)!;
    expect(mod.getResourceHandler).toBeUndefined();
    expect(mod.getResourceDescriptors).toBeUndefined();
    expect(mod.getPromptHandler).toBeUndefined();
    expect(mod.getPromptDescriptors).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The reviewed per-tool annotation table. It is the single owner of per-tool hint values: other suites
// check only that hints are present, or compare the published hints with the descriptors.
// ---------------------------------------------------------------------------

/** Read-only: never destructive, idempotent, open world unless the tool calls no outside service. */
const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const READ_ONLY_LOCAL: ToolAnnotations = { ...READ_ONLY, openWorldHint: false };
/** Write, additive (table B). */
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
/** Write, idempotent (table B). */
const WRITE_IDEMPOTENT: ToolAnnotations = { ...WRITE, idempotentHint: true };
/** Destructive, idempotent (table C: overwrite in place, delete or revoke). */
const DESTRUCTIVE_IDEMPOTENT: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
/** Destructive, not idempotent (table C: new version per call, irreversible). */
const DESTRUCTIVE: ToolAnnotations = { ...DESTRUCTIVE_IDEMPOTENT, idempotentHint: false };

const EXPECTED_ANNOTATIONS: Record<string, ToolAnnotations> = {
  mcp_get_health: READ_ONLY_LOCAL,

  // Jira (18)
  jira_whoami: READ_ONLY,
  jira_get_issues: READ_ONLY,
  jira_get_attachment: READ_ONLY,
  jira_get_comments: READ_ONLY,
  jira_get_changelogs: READ_ONLY,
  jira_list_transitions: READ_ONLY,
  jira_list_issue_link_types: READ_ONLY,
  jira_search_users: READ_ONLY,
  jira_list_fields: READ_ONLY,
  jira_list_components: READ_ONLY,
  jira_create_issue: WRITE,
  jira_add_comment: WRITE,
  jira_link_issues: WRITE,
  jira_transition_issue: WRITE,
  jira_assign_issue: WRITE_IDEMPOTENT,
  jira_update_issue: DESTRUCTIVE_IDEMPOTENT,
  jira_update_comment: DESTRUCTIVE_IDEMPOTENT,
  jira_delete_comment: DESTRUCTIVE_IDEMPOTENT,

  // GitHub (30)
  github_get_copilot_unresolved_prs: READ_ONLY,
  github_get_code_review_ready: READ_ONLY,
  github_get_prs: READ_ONLY,
  github_get_pr_comments: READ_ONLY,
  github_list_branches: READ_ONLY,
  github_get_pr_details: READ_ONLY,
  github_get_pr_reviews: READ_ONLY,
  github_get_pr_checks: READ_ONLY,
  github_search_prs: READ_ONLY,
  github_get_pr_review_comments: READ_ONLY,
  github_get_pr_files: READ_ONLY,
  github_get_pr_commits: READ_ONLY,
  github_get_file_contents: READ_ONLY,
  github_get_pr_review_threads: READ_ONLY,
  github_create_pr: WRITE,
  github_add_pr_comment: WRITE,
  github_create_pr_review_comment: WRITE,
  github_submit_pr_review: WRITE,
  github_request_pr_reviewers: WRITE_IDEMPOTENT,
  github_update_pr_assignees: WRITE_IDEMPOTENT,
  github_resolve_review_thread: WRITE_IDEMPOTENT,
  github_unresolve_review_thread: WRITE_IDEMPOTENT,
  github_update_pr: DESTRUCTIVE_IDEMPOTENT,
  github_update_pr_comment: DESTRUCTIVE_IDEMPOTENT,
  github_update_pr_review_comment: DESTRUCTIVE_IDEMPOTENT,
  github_update_pr_labels: DESTRUCTIVE_IDEMPOTENT,
  github_delete_pr_review_comment: DESTRUCTIVE_IDEMPOTENT,
  github_delete_pr_issue_comment: DESTRUCTIVE_IDEMPOTENT,
  github_dismiss_pr_review: DESTRUCTIVE_IDEMPOTENT,
  github_merge_pr: DESTRUCTIVE,

  // Figma (9)
  figma_get_me: READ_ONLY,
  figma_get_file: READ_ONLY,
  figma_get_nodes: READ_ONLY,
  figma_get_images: READ_ONLY,
  figma_get_comments: READ_ONLY,
  figma_get_styles: READ_ONLY,
  figma_get_variables: READ_ONLY,
  figma_get_versions: READ_ONLY,
  figma_post_comment: WRITE,

  // Confluence (6)
  confluence_search: READ_ONLY,
  confluence_get_page: READ_ONLY,
  confluence_list_spaces: READ_ONLY,
  confluence_whoami: READ_ONLY,
  confluence_create_page: WRITE,
  confluence_update_page: DESTRUCTIVE,

  // Jenkins (5)
  jenkins_get_jobs: READ_ONLY,
  jenkins_get_builds: READ_ONLY,
  jenkins_get_build: READ_ONLY,
  jenkins_get_console: READ_ONLY,
  jenkins_healthcheck: READ_ONLY,

  // Slack (11)
  slack_get_status: READ_ONLY,
  slack_search_messages: READ_ONLY,
  slack_get_messages: READ_ONLY,
  slack_get_threads: READ_ONLY,
  slack_get_channels: READ_ONLY,
  slack_get_users: READ_ONLY,
  // slack_prepare_write and slack_download_file call Slack (the write preview carries text other
  // people wrote), so both are open world.
  slack_prepare_write: READ_ONLY,
  slack_login: WRITE,
  slack_confirm_write: WRITE_IDEMPOTENT,
  slack_download_file: DESTRUCTIVE_IDEMPOTENT,
  slack_logout: DESTRUCTIVE_IDEMPOTENT,
};

// Loaded per test so a broken mcp-health.ts fails the health checks, not the whole registry suite.
async function healthDescriptor(): Promise<ToolDescriptor | undefined> {
  const health = await import('../mcp-health.js');
  return Object.values(health).find(
    (value): value is ToolDescriptor => !!value && typeof value === 'object' && (value as ToolDescriptor).name === 'mcp_get_health',
  );
}

describe('tool annotations', () => {
  const descriptors = async (): Promise<ToolDescriptor[]> => [
    (await healthDescriptor())!,
    ...modules.flatMap((m) => m.getToolDescriptors()),
  ];

  it('the table covers 80 tools: 49 read-only, 17 non-destructive writes, 14 destructive', () => {
    const values = Object.values(EXPECTED_ANNOTATIONS);
    expect(values).toHaveLength(80);
    expect(values.filter((a) => a.readOnlyHint)).toHaveLength(49);
    expect(values.filter((a) => !a.readOnlyHint && !a.destructiveHint)).toHaveLength(17);
    expect(values.filter((a) => a.destructiveHint)).toHaveLength(14);
  });

  it('mcp-health exports the health descriptor', async () => {
    expect(await healthDescriptor()).toBeDefined();
  });

  it('every descriptor (health plus the six modules) is in the table, and the table has no extra tool', async () => {
    const names = (await descriptors()).map((d) => d.name);
    expect(names.filter((n) => !(n in EXPECTED_ANNOTATIONS))).toEqual([]);
    expect(Object.keys(EXPECTED_ANNOTATIONS).filter((n) => !names.includes(n))).toEqual([]);
  });

  it('every descriptor carries exactly the reviewed hints', async () => {
    const mismatches = (await descriptors())
      .filter((d) => d.name in EXPECTED_ANNOTATIONS)
      .filter((d) => JSON.stringify(sortKeys(d.annotations)) !== JSON.stringify(sortKeys(EXPECTED_ANNOTATIONS[d.name])))
      .map((d) => `${d.name}: got ${JSON.stringify(d.annotations)}, want ${JSON.stringify(EXPECTED_ANNOTATIONS[d.name])}`);
    expect(mismatches).toEqual([]);
  });

  it('every descriptor has a non-empty title', async () => {
    const untitled = (await descriptors())
      .filter((d) => typeof d.title !== 'string' || !d.title.trim())
      .map((d) => d.name);
    expect(untitled).toEqual([]);
  });
});

function sortKeys(value: object | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)));
}
