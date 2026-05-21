import { defineConfig } from "vitest/config";

/**
 * Root vitest config — drives ONLY the umbrella integration suite in `tests/`.
 * Frontend component tests have their own config at `frontend/vitest.config.ts`
 * (with jsdom + @vitejs/plugin-react + frontend's own setupFiles), and
 * sub-brain tests run through `sub-brain/package.json`'s vitest. Trying to
 * share setupFiles across these three suites used to pull `react` into the
 * root test run, which fails in CI because root never installs frontend deps.
 */
export default defineConfig({
  test: {
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.{test,spec}.{ts,tsx}"],
    testTimeout: 60000,
    hookTimeout: 30000,
    pool: "forks",
  },
});
