import { createRequire } from 'node:module';

// Resolves from both src/ and dist/: each sits one level below the package root.
const pkg = createRequire(import.meta.url)('../package.json') as {
  name: string;
  version: string;
  engines: { node: string };
};

/** Server name and version, read once from package.json: the single source for server info and mcp_get_health. */
export const SERVER_INFO = { name: pkg.name, version: pkg.version };

/** The `engines.node` range from the same read, e.g. `>=24`: the minimum Node the server refuses to start below. */
export const NODE_ENGINES = pkg.engines.node;
