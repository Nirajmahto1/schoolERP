import { defineConfig } from 'vitest/config';

// Suites here migrate real Postgres schemas per test; under turbo's parallel
// load a 10s default hook timeout flakes (observed in CI-shaped runs). Give
// hooks the same 60s budget identity-service uses.
export default defineConfig({
  test: {
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
