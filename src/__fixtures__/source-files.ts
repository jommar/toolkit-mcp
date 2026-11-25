/** Source-tree walking for the suites that scan the repo's own files (tests only). */
import { readdirSync } from 'node:fs';
import path from 'node:path';

/** Absolute paths of every .ts, .mts, .js and .mjs file under `dir`, recursively. */
export function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(full);
    return /\.(ts|mts|js|mjs)$/.test(entry.name) ? [full] : [];
  });
}
