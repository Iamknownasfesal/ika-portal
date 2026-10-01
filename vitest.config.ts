import { defineConfig } from 'vitest/config';

// Unit suites (no local chains). E2E: `pnpm test:e2e` (vitest.e2e.config.ts).
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    server: { deps: { inline: [/@ika\.xyz/] } },
  },
});
