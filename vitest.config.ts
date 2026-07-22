import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // 'server-only' throws outside a React Server environment; stub it so
      // unit tests can exercise src/server modules.
      'server-only': path.resolve(__dirname, 'tests/stubs/server-only.ts'),
    },
  },
  test: {
    include: ['__tests__/**/*.test.ts', 'tests/characterization/**/*.test.ts'],
    environment: 'node',
  },
});
