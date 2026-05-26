const SUB_URL = "http://127.0.0.1:3456";

async function healthCheck(url: string, retries = 3): Promise<unknown> {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (r.ok) return await r.json();
    } catch {
      // unreachable; retry
    }
    if (i < retries - 1) await new Promise((res) => setTimeout(res, 500));
  }
  return null;
}

/**
 * Strict-mode flag. When set, missing backend = hard fail (local dev with
 * services up should treat skip as a regression). Default mode: soft skip
 * when sub-brain or main-brain proxy is unreachable. CI's integration-test
 * job doesn't spawn the backend, so default-skip lets it pass on PRs while
 * `WEBRAIN_REQUIRE_BACKEND=1 pnpm test` keeps the strict local invariant.
 */
const REQUIRE_BACKEND = process.env.WEBRAIN_REQUIRE_BACKEND === "1";

beforeAll(async () => {
  // Skip backend health checks in jsdom environment (frontend unit tests).
  if (typeof window !== "undefined" && typeof window.document !== "undefined") {
    return;
  }

  const subHealth = (await healthCheck(`${SUB_URL}/health`)) as
    | { status?: string }
    | null;
  const mainProxy = subHealth
    ? ((await healthCheck(`${SUB_URL}/brain/health`)) as
        | { status?: string }
        | null)
    : null;

  const subOk = subHealth?.status === "ok";
  const mainOk = mainProxy?.status === "ok";

  if (subOk && mainOk) return; // happy path

  const reason = !subOk
    ? `Sub brain is not reachable at ${SUB_URL}`
    : `Main brain proxy is not reachable at ${SUB_URL}/brain/health`;

  if (REQUIRE_BACKEND) {
    throw new Error(reason);
  }

  // eslint-disable-next-line no-console
  console.warn(
    `[tests/setup] ${reason} — skipping. ` +
      `Set WEBRAIN_REQUIRE_BACKEND=1 to fail instead.`,
  );
  (
    globalThis as { __WEBRAIN_SKIP_INTEGRATION__?: boolean }
  ).__WEBRAIN_SKIP_INTEGRATION__ = true;
});

afterAll(async () => {
  // Global cleanup if needed
});
