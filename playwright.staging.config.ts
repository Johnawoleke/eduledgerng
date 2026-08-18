import { defineConfig, devices } from "@playwright/test";

// NON-HERMETIC suite. Runs the real app against the STAGING Supabase project,
// with no mocking — the opposite of playwright.config.ts, which intercepts every
// network call.
//
// It exists because the hermetic suite cannot see the class of bug that has
// actually been shipping. Six bugs were found during the ledger work; four were
// invisible to typecheck, unit tests AND the hermetic e2e, and only appeared
// when a real dashboard talked to a real database:
//
//   - a paid-total guard that read legacy payment rows as unpaid
//   - a setState that was never called, so a whole section rendered empty
//   - two labels that contradicted the numbers beside them
//
// Deliberately NOT part of `npm test` or CI: it needs credentials, mutates
// nothing but depends on staging being up, and network flakiness must never
// block a merge. Run it before a release, or when touching the dashboards:
//
//   npm run test:staging
//
// Requires .env.local pointing at staging (which is the default for local dev).
export default defineConfig({
  testDir: "./e2e-staging",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,          // shares one staging dataset
  workers: 1,
  retries: 1,                    // tolerate a single network blip, not a failure
  reporter: [["list"]],
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:8080",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:8080",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
