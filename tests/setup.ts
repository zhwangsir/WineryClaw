const SUB_URL = "http://127.0.0.1:3456";

async function healthCheck(url: string, retries = 3): Promise<any> {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (r.ok) return await r.json();
    } catch {}
    if (i < retries - 1) await new Promise((res) => setTimeout(res, 500));
  }
  return null;
}

beforeAll(async () => {
  // Skip backend health checks in jsdom environment (frontend unit tests)
  if (typeof window !== "undefined" && typeof window.document !== "undefined") {
    return;
  }

  // Verify sub-brain is reachable; main-brain is proxied via /brain/*
  const subHealth = await healthCheck(`${SUB_URL}/health`);
  if (!subHealth || subHealth.status !== "ok") {
    throw new Error(`Sub brain is not reachable at ${SUB_URL}`);
  }

  // Verify main-brain proxy works (UDS or TCP behind /brain/*)
  const mainProxy = await healthCheck(`${SUB_URL}/brain/health`);
  if (!mainProxy || mainProxy.status !== "ok") {
    throw new Error(`Main brain proxy is not reachable at ${SUB_URL}/brain/health`);
  }
});

afterAll(async () => {
  // Global cleanup if needed
});
