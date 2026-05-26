#!/usr/bin/env node
/**
 * Umbrella vitest preflight (v2.20).
 *
 * The integration suite under tests/ talks to a live sub-brain at :3000 and
 * main-brain via /brain/*. CI's integration-test job intentionally doesn't
 * spawn the backend stack (see ci.yml comment) — without this wrapper every
 * suite ECONNREFUSED'd and CI reported a red check despite `continue-on-error`.
 *
 * Behavior:
 *   - Probe sub-brain /health with a short timeout.
 *   - Backend up        → exec `vitest run`, propagate its exit code.
 *   - Backend down + WEBRAIN_REQUIRE_BACKEND=1 → exit 1 (loud failure).
 *   - Backend down + WEBRAIN_REQUIRE_BACKEND≠1 → exit 0 with a console.warn.
 *
 * Local devs running with services up still get the full suite with real
 * pass/fail signal. CI in soft mode reports a green check whose log lines
 * explain why no tests ran.
 */
import { spawnSync } from "node:child_process";

const SUB_URL = process.env.WEBRAIN_SUB_BRAIN_URL || "http://127.0.0.1:3000";
const REQUIRE_BACKEND = process.env.WEBRAIN_REQUIRE_BACKEND === "1";

let backendUp = false;
try {
  const r = await fetch(`${SUB_URL}/health`, { signal: AbortSignal.timeout(3000) });
  backendUp = r.ok;
} catch {
  backendUp = false;
}

if (!backendUp) {
  if (REQUIRE_BACKEND) {
    console.error(
      `[preflight] Sub brain unreachable at ${SUB_URL} — failing per WEBRAIN_REQUIRE_BACKEND=1.`
    );
    process.exit(1);
  }
  console.warn(
    `[preflight] Sub brain unreachable at ${SUB_URL}; skipping integration suite (soft mode).`
  );
  console.warn(
    `[preflight] To require the backend locally:  WEBRAIN_REQUIRE_BACKEND=1 pnpm test`
  );
  process.exit(0);
}

const result = spawnSync("npx", ["vitest", "run"], { stdio: "inherit", shell: false });
process.exit(result.status ?? 1);
