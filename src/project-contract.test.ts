/**
 * Dependency, source and docs contract for the SDK v2 move (`he` and `@types/he` stay, because the
 * Confluence service imports `he`).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { listSourceFiles } from './__fixtures__/source-files.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const pkg = JSON.parse(read('package.json')) as {
  version: string;
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

/** Every source file under src/ except this contract test, which names the forbidden strings itself. */
const SOURCES = listSourceFiles(path.join(ROOT, 'src')).filter((file) => file !== SELF);
const rel = (file: string) => path.relative(ROOT, file);
const isTestOrFixture = (file: string) => /\.test\.ts$/.test(file) || file.split(path.sep).includes('__fixtures__');

/** Files whose import statements name `pkg` (or a subpath of it). */
function importersOf(pkgName: string, files: string[]): string[] {
  const pattern = new RegExp(`(?:from\\s+|import\\s*\\(\\s*|import\\s+|require\\s*\\(\\s*)['"]${pkgName.replace('/', '\\/')}(?:/[^'"]*)?['"]`);
  return files.filter((file) => pattern.test(readFileSync(file, 'latin1'))).map(rel);
}

describe('dependencies', () => {
  it('pins @modelcontextprotocol/server 2.4.0 and zod 4.6.7 exactly', () => {
    expect(pkg.dependencies?.['@modelcontextprotocol/server']).toBe('2.4.0');
    expect(pkg.dependencies?.zod).toBe('4.6.7');
  });

  it('pins the test client @modelcontextprotocol/client 2.4.0 as a devDependency only', () => {
    expect(pkg.devDependencies?.['@modelcontextprotocol/client']).toBe('2.4.0');
    expect(pkg.dependencies).not.toHaveProperty('@modelcontextprotocol/client');
  });

  it('drops the v1 SDK package', () => {
    expect(allDeps).not.toHaveProperty('@modelcontextprotocol/sdk');
  });

  it('declares engines.node >=24 and .nvmrc 26.13.1', () => {
    expect(pkg.engines?.node).toBe('>=24');
    expect(read('.nvmrc').trim()).toBe('26.13.1');
  });

  it('makes npm refuse an unsupported Node: .npmrc sets engine-strict=true', () => {
    expect(existsSync(path.join(ROOT, '.npmrc'))).toBe(true);
    expect(read('.npmrc')).toMatch(/^engine-strict=true$/m);
  });
});

describe('source imports', () => {
  it('no file under src/ imports @modelcontextprotocol/sdk or @modelcontextprotocol/core', () => {
    expect(importersOf('@modelcontextprotocol/sdk', SOURCES)).toEqual([]);
    expect(importersOf('@modelcontextprotocol/core', SOURCES)).toEqual([]);
  });

  it('only tests and __fixtures__ import @modelcontextprotocol/client', () => {
    const production = SOURCES.filter((file) => !isTestOrFixture(file));
    expect(importersOf('@modelcontextprotocol/client', production)).toEqual([]);
  });

  it('src/services/** imports nothing from @modelcontextprotocol/*', () => {
    const services = SOURCES.filter((file) => rel(file).startsWith(`src${path.sep}services${path.sep}`));
    expect(services.length).toBeGreaterThan(0);
    const offenders = services
      .filter((file) => /['"]@modelcontextprotocol\//.test(readFileSync(file, 'latin1')))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});

describe('removed names', () => {
  const DOCS = ['README.md', 'CLAUDE.md', '.env.example'].filter((doc) => existsSync(path.join(ROOT, doc)));

  // Test files are excluded: they name these to prove they are gone (e.g. MCP_TRANSPORT set and ignored).
  it.each(['zodToJsonSchema', 'MCP_TRANSPORT', 'MCP_PORT'])('%s appears in no non-test source or doc (CHANGELOG excepted)', (name) => {
    const hits = [
      ...SOURCES.filter((file) => !/\.test\.ts$/.test(file)).filter((file) => readFileSync(file, 'latin1').includes(name)).map(rel),
      ...DOCS.filter((doc) => read(doc).includes(name)),
    ];
    expect(hits).toEqual([]);
  });
});

describe('changelog', () => {
  it('has a heading for the package.json version', () => {
    const escaped = pkg.version.replace(/\./g, '\\.');
    expect(read('CHANGELOG.md')).toMatch(new RegExp(`^## \\[${escaped}\\]`, 'm'));
  });
});
