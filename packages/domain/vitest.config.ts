import { defineConfig } from 'vitest/config';

// fees.test.ts / gate2.test.ts migrate real Postgres schemas in beforeAll;
// the 10s default hook timeout flakes under turbo's parallel load.
export default defineConfig({
  test: {
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
