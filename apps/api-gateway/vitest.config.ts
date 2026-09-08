import { defineConfig } from 'vitest/config';

// No test files yet — `vitest run` must not fail the pipeline for a workspace
// that simply has nothing to test. First tests land with the Phase 3 service
// buildout; this keeps `npm test` and CI green in the meantime (BUILD_PLAN 0.8).
export default defineConfig({
  test: {
    passWithNoTests: true,
  },
});