import { defineConfig } from 'vitest/config';

// The route suite creates a real Postgres schema and applies migrations in
// beforeAll — the 10s default hook timeout flakes under parallel load.
export default defineConfig({
  test: {
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
