/**
 * WeBrain Sub Brain — 无安全限制版
 * 工具自注册 + Plugin SDK Hooks + Playwright + Docker Sandbox + Skills + MCP + CLI
 * Streaming + Multi-model + Heartbeat
 */

// ─── Startup banner (user-trial #6) ─────────────────────────────────────────
// Before this banner existed, `pnpm dev` showed only the literal `$ tsx watch
// src/main.ts` line then 30+ seconds of silence while module-init top-level
// awaits ran. Users couldn't tell if the system was starting or hung. A
// single banner line printed immediately after this module's first executable
// statement makes "starting" unambiguous. Printed with console.log not
// fastify.log because Fastify itself isn't instantiated yet.
const __startupStartedAt = Date.now();
console.log(
  `[webrain sub-brain] starting (node ${process.version}, pid ${process.pid}) — ` +
    "initializing modules…",
);

// ─── Fatal error capture (user-trial #7) ────────────────────────────────────
// tsx watch swallows top-level rejections silently — the dual-notFoundHandler
// bug spent 30 seconds appearing "hung" before manual `npx tsx` surfaced it.
// These handlers ensure ANY top-level crash gets a loud stderr write before
// process exit, even if tsx's own logger fails. We set up before any other
// import side-effect runs because the imports themselves can throw.
process.on("uncaughtException", (err) => {
  console.error("\n[webrain sub-brain] FATAL uncaughtException at startup:");
  console.error(err);
  console.error(
    "\nIf you saw nothing else from sub-brain before this line, the error " +
      "happened during module init (top-level await / import side-effect). " +
      "tsx watch sometimes swallows these — direct `npx tsx src/main.ts` " +
      "reproduces them cleanly.",
  );
  // Re-throw so node still exits with non-zero
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("\n[webrain sub-brain] FATAL unhandledRejection at startup:");
  console.error(reason);
  process.exit(1);
});

import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import staticPlugin from "@fastify/static";
import { spawn, ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join, resolve as pathResolve, sep as pathSep } from "path";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import { homedir } from "os";
import { pickPythonInterpreter } from "./main-brain-spawn.js";
import { ToolExecutor } from "./tools/tool-executor.js";
import { ChannelManager } from "./channels/channel-manager.js";
import { ChannelAutoReply } from "./channels/channel-auto-reply.js";
import { PersistentReplyQueue } from "./channels/persistent-reply-queue.js";
import { subBrainDB } from "./db/sub-brain-db.js";
import { PluginLoader } from "./plugins/plugin-loader.js";
import { EcosystemHub } from "./ecosystem/ecosystem-hub.js";
import { DokobotClient } from "./dokobot/dokobot-client.js";
import { ModelConfigManager } from "./config/model-config.js";
import { LayeredConfigManager } from "./config/layered-config.js";
import { IdentityManager } from "./identity/identity-manager.js";
import { AgentManager } from "./agent/agent-manager.js";
import { hookRegistry } from "./plugin-sdk/hooks.js";
import { PlaywrightBrowser } from "./browser/playwright-browser.js";
import { DockerSandbox } from "./sandbox/docker-sandbox.js";
import { SkillManager } from "./skills/skill-manager.js";
import { SkillHubClient } from "./skills/skill-hub-client.js";
import { MCPClient } from "./mcp/mcp-client.js";
import { WeBrainCLI } from "./cli/webrain-cli.js";
import { DEFAULT_SUB_BRAIN_PORT } from "./config/constants.js";

const PORT = parseInt(process.env.WEBRAIN_SUB_BRAIN_PORT || String(DEFAULT_SUB_BRAIN_PORT), 10);
const MAIN_BRAIN_PORT = parseInt(process.env.WEBRAIN_MAIN_BRAIN_PORT || "18790", 10);
const MAIN_BRAIN_UDS = process.env.WEBRAIN_MAIN_BRAIN_UDS || "/tmp/webrain-main.sock";
// Transport selection (v2.19 fix — previously inverted):
//   WEBRAIN_MAIN_BRAIN_PORT  set → force TCP (test/docker/multi-host deploys)
//   WEBRAIN_MAIN_BRAIN_UDS   set → force UDS at the given path
//   neither set              → UDS at the default `/tmp/webrain-main.sock`
// Pre-fix bug: setting WEBRAIN_MAIN_BRAIN_UDS *disabled* UDS (truthy → !UDS = false),
// so the proxy went to TCP :18790 and ECONNREFUSED'd. Confirmed in real-user test.
const USE_UDS = !process.env.WEBRAIN_MAIN_BRAIN_PORT;
const MAIN_BRAIN_URL = USE_UDS ? "http://localhost" : `http://127.0.0.1:${MAIN_BRAIN_PORT}`;
const EMBEDDED = process.env.WEBRAIN_EMBEDDED === "1";
const __dirname = dirname(fileURLToPath(import.meta.url));

function mainBrainAxiosConfig(): any {
  return USE_UDS ? { socketPath: MAIN_BRAIN_UDS } : {};
}

const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase() as "fatal" | "error" | "warn" | "info" | "debug" | "trace";
// v2.38: bodyLimit must exceed REQUIRED_FASTIFY_BODY_LIMIT from uploads-routes,
// otherwise the RAG drag-drop dropzone (advertised up to 50 MB after decode)
// is unreachable — Fastify's default 1 MB caps would silently reject any
// file >~750 KB binary as 413 Payload Too Large. Bug found 2026-05-22.
// We import the constant statically to keep the contract in sync.
import { REQUIRED_FASTIFY_BODY_LIMIT } from "./server/uploads-routes.js";
const app = Fastify({ logger: { level: LOG_LEVEL }, bodyLimit: REQUIRED_FASTIFY_BODY_LIMIT });
await app.register(cors, { origin: true, credentials: true });
await app.register(websocket);

import { registerAuth } from "./server/auth.js";
import { registerStatic } from "./server/static.js";
import { registerMetrics } from "./server/metrics.js";
import { registerSkillhubRoutes } from "./server/skillhub-routes.js";
import { registerHealthRoutes } from "./server/health-routes.js";
import { registerA2ARoutes } from "./server/a2a-routes.js";
import { registerCLIRoutes } from "./server/cli-routes.js";
import { registerDokobotRoutes } from "./server/dokobot-routes.js";
import { registerMCPRoutes } from "./server/mcp-routes.js";
import { registerHooksRoutes } from "./server/hooks-routes.js";
import { registerIdentityRoutes } from "./server/identity-routes.js";
import { registerEcosystemRoutes } from "./server/ecosystem-routes.js";
import { registerProposalsRoutes } from "./server/proposals-routes.js";
import { registerToolsRoutes } from "./server/tools-routes.js";
import { registerBrowserRoutes } from "./server/browser-routes.js";
import { registerUploadsRoutes } from "./server/uploads-routes.js";
import { registerSkillsRoutes } from "./server/skills-routes.js";
import { registerTemplatesRoutes } from "./server/templates-routes.js";
import { registerWorkflowsRoutes } from "./server/workflows-routes.js";
import { registerPluginsRoutes } from "./server/plugins-routes.js";
import { registerSandboxRoutes } from "./server/sandbox-routes.js";
import { registerChannelsRoutes } from "./server/channels-routes.js";
import { registerConfigRoutes } from "./server/config-routes.js";
import { registerAgentsRoutes } from "./server/agents-routes.js";
import { registerWsRoutes, WebSocketHub } from "./server/ws-routes.js";
registerAuth(app);
const frontendDist = registerStatic(app, __dirname);
registerMetrics(app);

// ===== Trace ID =====
app.addHook("onRequest", async (request, reply) => {
  const traceId = request.headers["x-trace-id"] as string || `trace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  (request as any).traceId = traceId;
  reply.header("x-trace-id", traceId);
});

// Round O2 — auth lives in server/auth.ts (`registerAuth(app)` called
// earlier). The inline N2 hook was removed: it duplicated the existing
// system, used a different env var (WEBRAIN_API_TOKEN vs the canonical
// WEBRAIN_API_KEY), and had path-normalization bypass bugs. auth.ts now
// honors both env names and includes the path-canonicalization defense.

// ===== /api prefix compat (frontend uses /api/channels, sub-brain serves /channels) =====
//
// ORDERING NOTE (Round P review): this hook MUST run AFTER registerAuth
// (called above). Auth canonicalizes via `request.url` (unrewritten) and
// strips `/api/` itself in its own canonicalPath helper, so the two are
// consistent today. If you ever move registerAuth below this rewriter,
// auth will see the already-rewritten path and its internal /api strip
// becomes a no-op — the auth/routing path views will diverge and
// /api/sandbox could become reachable without credentials when
// auth is enabled. Keep registerAuth above; if you can't, also
// remove the `/api/` strip from auth.ts canonicalPath.
// Frontend api/*.ts wrappers consistently call `/api/<resource>` to avoid
// SPA route collisions on `/channels` and `/config`. But sub-brain serves
// those at `/channels` and `/config` directly (only skillhub uses the `/api`
// prefix natively). Without this rewrite, every non-skillhub `/api/*`
// request hits Fastify's 404, and the frontend's axios layer crashes
// trying to read JSON from an HTML 404 page.
app.addHook("onRequest", async (request) => {
  const url = request.raw.url || "";
  if (url.startsWith("/api/") && !url.startsWith("/api/skillhub")) {
    request.raw.url = url.replace(/^\/api/, "");
  }
});

app.addHook("onResponse", async (request, reply) => {
  const traceId = (request as any).traceId || "-";
  app.log.info({ traceId, method: request.method, url: request.url, statusCode: reply.statusCode, responseTime: reply.elapsedTime }, "request completed");
});

// ===== Global Error Handler =====
// Catches all unhandled exceptions from any route, prevents stack trace leakage
app.setErrorHandler((error, request, reply) => {
  const traceId = (request as any).traceId || "-";
  const statusCode = error.statusCode || 500;

  // Log full error internally
  app.log.error({ traceId, err: error.message, stack: error.stack, url: request.url, method: request.method }, "unhandled error");

  // Never leak stack traces to client
  const clientMessage = statusCode >= 500
    ? "Internal server error"
    : (error.message || "Request failed");

  reply.status(statusCode).send({ ok: false, error: clientMessage, traceId });
});

// ===== Not Found Handler =====
// Only register this fallback if registerStatic didn't already set its own
// (it does, with SPA-style index.html serving, when frontend dist is present).
// Without this guard, Fastify throws "Not found handler already set for
// Fastify instance with prefix: '/'" at startup — a hard crash that left the
// sub-brain process alive but not listening on any port. Discovered during
// real-user trial 2026-05-20; see PROJECT_STATE §user-trial.
if (!frontendDist) {
  app.setNotFoundHandler((request, reply) => {
    const traceId = (request as any).traceId || "-";
    app.log.warn({ traceId, url: request.url, method: request.method }, "route not found");
    reply.status(404).send({ ok: false, error: "Not found", traceId });
  });
}

const wsHub = new WebSocketHub();

const browser = new PlaywrightBrowser();

const state = {
  toolExecutor: new ToolExecutor(),
  channelManager: new ChannelManager(),
  pluginLoader: new PluginLoader(),
  ecosystemHub: new EcosystemHub(),
  dokobot: new DokobotClient(browser),
  modelConfig: new ModelConfigManager(),
  layeredConfig: new LayeredConfigManager(),
  identityManager: new IdentityManager(),
  agentManager: new AgentManager({
    mainBrainUrl: MAIN_BRAIN_URL,
    subBrainUrl: `http://127.0.0.1:${PORT}`,
  }),
  browser,
  dockerSandbox: new DockerSandbox(),
  skillManager: new SkillManager(),
  skillHubClient: new SkillHubClient(),
  mcpClient: new MCPClient(),
  cli: new WeBrainCLI({ subBrainUrl: `http://127.0.0.1:${PORT}`, mainBrainUrl: MAIN_BRAIN_URL }),
};

// Bootstrap starter skill registry (vision-gap #1, 2026-05-21):
// Ship a non-empty Skillhub Marketplace out of the box. The repo carries
// 8 production-quality starter skills under
// `<sub-brain>/skills/starter-registry/`. Seed only if the user hasn't
// added a registry with this name themselves — idempotent. Removal via
// the Skillhub UI is honoured (we don't re-seed on every boot).
{
  const STARTER_NAME = "webrain-starters";
  const existing = state.skillHubClient.listRegistries();
  if (!existing.some((r) => r.name === STARTER_NAME)) {
    // Resolve the registry directory relative to this file's location so
    // it works in both `pnpm dev` (src/) and a built `dist/` layout. The
    // tsc layout mirrors src/, so going up two levels lands us at
    // sub-brain/, and the registry lives at sub-brain/skills/...
    const candidatePaths = [
      pathResolve(__dirname, "../skills/starter-registry"),
      pathResolve(__dirname, "../../skills/starter-registry"),
    ];
    const starterPath = candidatePaths.find((p) => existsSync(join(p, "index.json")));
    if (starterPath) {
      const add = state.skillHubClient.addRegistry({
        name: STARTER_NAME,
        url: "file://" + starterPath,
        enabled: true,
        priority: 100,
      });
      if (add.ok) {
        app.log.info(`[skillhub] seeded starter registry at ${starterPath}`);
      } else {
        app.log.warn(`[skillhub] starter registry seed skipped: ${add.error}`);
      }
    } else {
      app.log.warn("[skillhub] starter registry index.json not found in any candidate path");
    }
  }
}

await state.toolExecutor.initialize();
await state.channelManager.initialize();
state.channelManager.setBroadcastHandler((msg: unknown) => wsHub.broadcast(msg));

// M5: wire channel auto-reply — inbound messages on auto_reply-enabled
// channels are forwarded to main-brain /chat and the reply is sent
// back through the same channel.
const replyQueue = new PersistentReplyQueue(subBrainDB.getDb());
const channelAutoReply = new ChannelAutoReply({
  channelManager: state.channelManager,
  chatFn: async ({ message, session_id, agent_id }) => {
    const axios = (await import("axios")).default;
    const resp = await axios.post(
      `${MAIN_BRAIN_URL}/chat`,
      { message, session_id, agent_id, tools_enabled: false },
      USE_UDS
        ? { socketPath: MAIN_BRAIN_UDS, timeout: 120000 }
        : { timeout: 120000 },
    );
    return { reply: resp.data?.reply ?? "" };
  },
  queue: replyQueue,
});
channelAutoReply.startWorker(5000);
state.channelManager.setInboundHandler(channelAutoReply.handleInbound);
await Promise.all([
  state.pluginLoader.initialize(),
  state.ecosystemHub.initialize(),
  hookRegistry.runStartup(),
]);

const dockerAvailable = state.dockerSandbox.isAvailable();
// User-trial #9: friendly one-liner instead of the raw ChildProcess error
// dump that used to spam stderr when docker wasn't installed.
if (dockerAvailable) {
  app.log.info("[docker] Sandbox available — execute_shell can run in containers");
} else {
  app.log.info("[docker] Sandbox disabled (docker not on PATH) — fallback to host shell");
}

// ===== Start Main Brain (Python) as child process =====
let mainBrainProc: ChildProcess | null = null;

function startMainBrain(): Promise<void> {
  return new Promise((resolve, reject) => {
    const mainBrainPaths = [
      pathResolve(__dirname, "./main-brain/main_brain.py"),
      pathResolve(__dirname, "../main-brain/main_brain.py"),
    ];
    const mainBrainScript = mainBrainPaths.find((p) => existsSync(p));
    if (!mainBrainScript) {
      app.log.warn("[main-brain] main_brain.py not found. Main brain will not be started.");
      resolve();
      return;
    }

    const mainBrainDir = pathResolve(mainBrainScript, "..");
    const pick = pickPythonInterpreter(mainBrainDir, process.env);
    const pythonCmd = pick.path;
    if (pick.diagnostic === "venv") {
      app.log.info(`[main-brain] Using venv interpreter: ${pythonCmd}`);
    } else if (pick.diagnostic === "env") {
      app.log.info(`[main-brain] Using interpreter from WEBRAIN_PYTHON env: ${pythonCmd}`);
    } else {
      app.log.warn(
        "[main-brain] No venv found at sub-brain/main-brain/venv/bin/python3. " +
        "Falling back to system `python3`. If main-brain crashes with " +
        "ModuleNotFoundError, follow README to create the venv: " +
        "`cd sub-brain/main-brain && python3 -m venv venv && " +
        "./venv/bin/pip install -r requirements.txt`"
      );
    }
    // Clean up stale UDS socket
    try { if (USE_UDS) unlinkSync(MAIN_BRAIN_UDS); } catch (err) { console.error("[main] Error:", err); console.error("[cleanup] Error:", err); }
    const args = USE_UDS
      ? [mainBrainScript, "--uds", MAIN_BRAIN_UDS]
      : [mainBrainScript, "--host", "127.0.0.1", "--port", String(MAIN_BRAIN_PORT)];
    mainBrainProc = spawn(pythonCmd, args, {
      stdio: "inherit",
      env: { ...process.env, WEBRAIN_EMBEDDED: "1", WEBRAIN_SUB_BRAIN_URL: "http://127.0.0.1:3456" },
    });

    mainBrainProc.on("error", (err) => {
      app.log.error(`[main-brain] Failed to start: ${err.message}`);
      reject(err);
    });

    // Wait a moment for main brain to start
    setTimeout(() => {
      app.log.info("[main-brain] Spawned as child process");
      resolve();
    }, 3000);
  });
}

function stopMainBrain(): void {
  if (mainBrainProc && !mainBrainProc.killed) {
    mainBrainProc.kill("SIGTERM");
    setTimeout(() => {
      if (mainBrainProc && !mainBrainProc.killed) {
        mainBrainProc.kill("SIGKILL");
      }
    }, 5000);
  }
}

process.on("SIGINT", () => {
  app.log.info("[shutdown] SIGINT received, stopping services...");
  stopMainBrain();
  app.close().then(() => process.exit(0));
});

process.on("SIGTERM", () => {
  app.log.info("[shutdown] SIGTERM received, stopping services...");
  stopMainBrain();
  app.close().then(() => process.exit(0));
});

app.log.info("[sub-brain] Running without security restrictions.");

// ========== Health ==========
// Health endpoints (/health, /health/models) — see server/health-routes.ts.
registerHealthRoutes(app, {
  dockerAvailable,
  mainBrainUrl: MAIN_BRAIN_URL,
  mainBrainAxiosConfig,
});

// ========== File Upload ==========
const UPLOADS_DIR = join(homedir(), ".webrain", "uploads");
registerUploadsRoutes(app, { uploadsDir: UPLOADS_DIR });

// ========== Config (Model + Layered) ==========
registerConfigRoutes(app, {
  modelConfig: state.modelConfig,
  layeredConfig: state.layeredConfig,
  mainBrainUrl: MAIN_BRAIN_URL,
  mainBrainAxiosConfig,
});

// ========== Tools ==========
registerToolsRoutes(app, { toolExecutor: state.toolExecutor });

// ========== Channels ==========
registerChannelsRoutes(app, { channelManager: state.channelManager });

// ========== Plugins ==========
registerPluginsRoutes(app, { pluginLoader: state.pluginLoader });

// ========== Ecosystem ==========
registerEcosystemRoutes(app, { ecosystemHub: state.ecosystemHub });

// Dokobot routes — see server/dokobot-routes.ts.
registerDokobotRoutes(app, { dokobot: state.dokobot });

// ========== Browser ==========
registerBrowserRoutes(app, { browser: state.browser });

// ========== Sandbox ==========
// All 10 /sandbox/* routes (Docker exec + agent policy) live in one module.
registerSandboxRoutes(app, {
  dockerSandbox: state.dockerSandbox,
  agentManager: state.agentManager,
});

// ========== Skills ==========
registerSkillsRoutes(app, { skillManager: state.skillManager });

// MCP routes — see server/mcp-routes.ts.
registerMCPRoutes(app, { mcpClient: state.mcpClient });

// v2.12 — Cross-process plugin-hook bridge for main-brain LLM/session events.
registerHooksRoutes(app, { hookRegistry });

// CLI routes — see server/cli-routes.ts.
registerCLIRoutes(app, { cli: state.cli });

// ========== Hooks ==========
// Returns each hook type + whether a real call site invokes it ("wired")
// or it's API-surface-only ("unwired"). See plugin-sdk/hooks.ts HOOK_STATUS.
import { HOOK_STATUS } from "./plugin-sdk/hooks.js";
app.get("/hooks/registry", async () => ({
  hooks: Object.keys(HOOK_STATUS),
  status: HOOK_STATUS,
  wired: Object.entries(HOOK_STATUS)
    .filter(([, s]) => s === "wired")
    .map(([k]) => k),
  unwired: Object.entries(HOOK_STATUS)
    .filter(([, s]) => s === "unwired")
    .map(([k]) => k),
}));

// ========== Identity ==========
registerIdentityRoutes(app, { identityManager: state.identityManager });

// ========== Agents (CRUD + tasks + harness + collaboration) ==========
registerAgentsRoutes(app, { agentManager: state.agentManager });

// ========== Consensus / Voting ==========
registerProposalsRoutes(app, { agentManager: state.agentManager });

// ========== Agent Templates ==========
registerTemplatesRoutes(app, { agentManager: state.agentManager });

// ========== Workflows ==========
registerWorkflowsRoutes(app, { agentManager: state.agentManager });

// (Sandbox policy routes consolidated into registerSandboxRoutes above.)

// (Agent stats consolidated into registerAgentsRoutes above.)

// Note: memory delete + KG entity/relation delete + chat streaming + metrics query
// are all served by main-brain via the /brain/* proxy (see registerBrainProxy below).
// Frontend uses /brain/memory/:id, /brain/chat/stream, /brain/metrics/query, etc.


// ========== Skillhub ==========
// HTTP surface over SkillHubClient + SkillManager. See server/skillhub-routes.ts.
registerSkillhubRoutes(app, {
  skillHubClient: state.skillHubClient,
  skillManager: state.skillManager,
});

// A2A routes — see server/a2a-routes.ts.
registerA2ARoutes(app, { agentManager: state.agentManager });

// ========== WebSocket ==========
registerWsRoutes(app, { hub: wsHub, toolExecutor: state.toolExecutor });

import { registerBrainProxy } from "./server/proxy.js";
registerBrainProxy(app, MAIN_BRAIN_URL, USE_UDS, MAIN_BRAIN_UDS);

// Start main brain before listening (if not explicitly disabled)
if (process.env.WEBRAIN_NO_MAIN_BRAIN !== "1") {
  try {
    await startMainBrain();
  } catch (err: any) {
    app.log.error(`[main-brain] Startup failed: ${err.message}`);
  }
}

await app.listen({ port: PORT, host: "0.0.0.0" });
app.log.info(`Sub Brain running on http://0.0.0.0:${PORT}`);
if (frontendDist) {
  app.log.info(`UI available at http://localhost:${PORT}`);
}
// Final ready-banner — pairs with the "starting…" line printed at the very
// top of this module. Lets users immediately tell when boot is complete and
// how long it took. console.log not app.log so it shows even if the Fastify
// logger is configured to a higher level for some reason.
const __startupMs = Date.now() - __startupStartedAt;
console.log(
  `[webrain sub-brain] ready on :${PORT} (${(__startupMs / 1000).toFixed(1)}s startup)`,
);
