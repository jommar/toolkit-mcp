/**
 * Tool annotation hint presets have one shared home (`register.ts`), and every integration imports them
 * instead of defining its own hint constants. Per-tool hint values are pinned only by the per-tool table
 * in `index.test.ts`; this suite only scans integration sources for local hint sets.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { listSourceFiles } from '../__fixtures__/source-files.js';
import { modules } from './index.js';

const INTEGRATIONS = fileURLToPath(new URL('.', import.meta.url));

const integrationDirs = readdirSync(INTEGRATIONS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('__'))
  .map((entry) => entry.name);

/** Every non-test .ts file under an integration directory, fixtures excluded, relative to src/integrations. */
const files = integrationDirs
  .flatMap((dir) => listSourceFiles(path.join(INTEGRATIONS, dir)))
  .map((file) => path.relative(INTEGRATIONS, file))
  .filter((rel) => rel.endsWith('.ts') && !rel.endsWith('.test.ts'))
  .filter((rel) => !path.dirname(rel).split(path.sep).some((segment) => segment.startsWith('__')));

describe('annotation hint presets', () => {
  it('scans one directory per registered integration module', () => {
    expect([...integrationDirs].sort()).toEqual(modules.map((m) => m.id).sort());
  });

  it.each(files)('%s defines no hint set of its own', (file) => {
    const source = readFileSync(path.join(INTEGRATIONS, file), 'utf8');
    // A preset may be spread and one hint overridden; restating readOnlyHint means a local set.
    expect(source.match(/^.*\breadOnlyHint\s*:.*$/gm) ?? []).toEqual([]);
    expect(source.match(/^\s*(?:export\s+)?const\s+\w*HINTS\w*\b.*=.*$/gm) ?? []).toEqual([]);
  });
});
