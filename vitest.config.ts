import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The suite runs 60+ files in parallel; on small CI runners a worker can
    // be starved long enough for a fast in-memory test to blow vitest's 5s
    // default. Tests that verify timeout behavior use their own short
    // internal timeouts, so raising these only removes load-induced flakes.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
