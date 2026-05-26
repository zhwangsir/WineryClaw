import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

/**
 * Optional bearer-token auth for the sub-brain API surface.
 *
 * Round O2 (2026-05-21) — hardened against path-normalization bypass after
 * code-review found:
 *   - `//tools` not caught by `startsWith("/tools")`
 *   - `/API/tools` slipped past case-sensitive `startsWith`
 *   - `/api/./chat`, `/api/../chat`, `%2Fchat` bypassed the prefix check
 *
 * The previous implementation also had a duplicate hook inline in
 * `main.ts` (added in N2) — that has been removed and consolidated here
 * to keep a single source of truth for the auth surface.
 *
 * Env vars (either is honored; checked at module load):
 *   - `WEBRAIN_API_KEY`   — canonical name (older)
 *   - `WEBRAIN_API_TOKEN` — alias (added by N2; kept for back-compat with
 *                          the docs / settings UI that reference it)
 *
 * Accepted credentials:
 *   - `Authorization: Bearer <token>`
 *   - `x-webrain-token: <token>` (for tools that can't set Authorization)
 *
 * Always-public paths (no token required):
 *   - `/health`, `/health/models`, `/metrics`
 *   - SPA root + static assets
 *   - Browser navigations (Accept includes text/html) — lets the page
 *     itself load so the user can enter the token via the UI
 */
export function registerAuth(app: FastifyInstance): void {
  const API_KEY = (process.env.WEBRAIN_API_KEY || process.env.WEBRAIN_API_TOKEN || "").trim();
  if (!API_KEY) return;

  app.log.info("[auth] API token authentication enabled");

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isProtected(request)) return;

    const supplied = readCredential(request);
    if (supplied && constantTimeEq(supplied, API_KEY)) return;

    reply
      .code(401)
      .header("www-authenticate", 'Bearer realm="webrain"')
      .send({
        // Both keys for back-compat: legacy callers pattern-match on
        // `error === "Unauthorized"`, newer ones read `ok === false`.
        ok: false,
        error: "Unauthorized",
        message: "Invalid or missing API key",
      });
  });
}

/** Canonicalize a request URL into a safe lower-cased pathname for prefix
 *  checks. Resolves `//`, percent-encoding, and `..`/`.` dot-segments —
 *  the three bypass vectors flagged by code-review. */
function canonicalPath(rawUrl: string): string {
  // Strip the query string before parsing.
  const [pathOnly] = rawUrl.split("?", 1);
  // Defensively collapse leading double slashes BEFORE the URL constructor —
  // `new URL("//tools", base)` is interpreted as protocol-relative (host=tools,
  // path=/), which collapses the path entirely and would slip past a prefix
  // check. Real request paths in Fastify can also start with `//`; canonicalize
  // them to single leading slash here.
  const slashCollapsed = pathOnly.replace(/^\/+/, "/").replace(/\/{2,}/g, "/");
  // Use the URL constructor against a dummy origin so it handles
  // percent-decoding + dot-segment resolution.
  let parsed: URL;
  try {
    parsed = new URL(slashCollapsed, "http://x");
  } catch {
    return slashCollapsed.toLowerCase();
  }
  // .pathname has resolved `..` / `.` and decoded most reserved chars.
  let p = parsed.pathname.replace(/\/{2,}/g, "/");
  // Strip the `/api` prefix here so callers don't have to repeat the
  // same logic — auth should treat `/api/tools` the same as `/tools`.
  // We do NOT strip for `/api/skillhub` because skillhub uses the prefix
  // natively (see main.ts comments).
  if (p.startsWith("/api/") && !p.startsWith("/api/skillhub")) {
    p = p.replace(/^\/api/, "") || "/";
  }
  return p.toLowerCase();
}

const PUBLIC_PATHS = new Set<string>(["/", "/health", "/health/models", "/metrics"]);
const PUBLIC_PREFIXES = ["/assets/", "/static/"];

/** Protected = matches the API surface (one of the known prefixes) AND not
 *  in the always-public list. Browser HTML navigations slip through. */
function isProtected(request: FastifyRequest): boolean {
  const accept = (request.headers.accept as string | undefined) || "";
  if (accept.includes("text/html")) return false;

  const path = canonicalPath(request.url || "");
  if (PUBLIC_PATHS.has(path)) return false;
  if (PUBLIC_PREFIXES.some((p) => path.startsWith(p))) return false;

  // Only guard the known API prefixes. Anything else (SPA bundle chunks,
  // favicon, etc.) is implicitly public to keep the page reachable.
  const PROTECTED_PREFIXES = [
    "/brain/",
    "/api/",          // /api/skillhub still falls here — that's correct, it should be auth'd too
    "/chat",
    "/agents",
    "/memory",
    "/tools",
    "/sandbox",
    "/config",
    "/skills",
    "/wiki",
    "/identity",
    "/plugins",
    "/cron",
    "/hooks",
    "/uploads",
    "/proposals",
    "/channels",
    "/rag",
    "/mcp",
    "/a2a",
    "/templates",
    "/workflows",
    "/dokobot",
    "/browser",
    "/ecosystem",
    "/cli",
    "/skillhub",
    "/metrics/",      // /metrics exact is public, but /metrics/<x> is protected
    "/llm",
    "/reasoning",
    "/plan",
  ];
  return PROTECTED_PREFIXES.some((p) => path === p.replace(/\/$/, "") || path.startsWith(p));
}

function readCredential(request: FastifyRequest): string {
  const auth = (request.headers.authorization as string | undefined) || "";
  const bearer = /^bearer\s+(.+)$/i.exec(auth);
  if (bearer) return bearer[1].trim();
  // Lenient back-compat: the legacy hook accepted a raw token without
  // the `Bearer ` prefix. Keep that behavior so tools/scripts that send
  // just the key keep working.
  if (auth && !/\s/.test(auth)) return auth.trim();
  const x = request.headers["x-webrain-token"];
  if (typeof x === "string" && x.trim()) return x.trim();
  return "";
}

/** Constant-time string compare to avoid the token timing oracle.
 *  Lengths leak (acceptable), per-byte comparison time does not. */
function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
