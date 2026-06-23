import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: [
        'src/mcp-server.ts',
        'src/mcp-config.ts',
        'src/mcp-health.ts',
        'src/integrations/**/*.ts',
        'src/services/**/*.ts',
      ],
    },
  },
});
