import { defineConfig } from 'vitest/config';

// Several suites here spin up real Postgres schemas and databases
// (`prisma migrate deploy` per schema) in beforeAll. Under turbo's parallel
// load the 10s default hook timeout flakes; give hooks the same 60s budget
// exam-service and identity-service use.
export default defineConfig({
  test: {
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
