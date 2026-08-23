// The payment webhook suite. Deliberately NOT part of `npm test`.
//
// It talks to the real staging backend and the real Paystack test API, writes
// payment rows, and needs two secrets that only exist in a developer's
// .env.local. Putting it in the default run would make `npm test` fail for
// anyone without those keys, and make CI depend on a third-party sandbox.
//
// Run it explicitly:  npm run test:payments
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["e2e-payments/**/*.{test,spec}.ts"],
    // A webhook round trip plus two student-auth calls is comfortably slower
    // than the 5s default, and a flaky timeout in a money suite teaches people
    // to ignore it.
    testTimeout: 45_000,
    hookTimeout: 45_000,
    // These share one staging student and clean up after themselves, so they
    // must not race each other.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
