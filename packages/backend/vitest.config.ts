import { defineConfig } from "vitest/config";

// convex-test integration tests run in the edge runtime and load the whole
// function surface via import.meta.glob. They live in `*.itest.ts` files so the
// `bun test` pure-helper suite (`*.test.ts`) and this suite never pick up each
// other's files.
export default defineConfig({
  test: {
    environment: "edge-runtime",
    include: ["convex/**/*.itest.ts"],
    server: { deps: { inline: ["convex-test"] } },
    // auth.ts imports @qali/env/server, which validates required deployment env
    // vars at import time. Tests only exercise DB logic (never createAuth), so
    // skip that validation instead of supplying real secrets.
    env: { SKIP_ENV_VALIDATION: "1" },
  },
});
