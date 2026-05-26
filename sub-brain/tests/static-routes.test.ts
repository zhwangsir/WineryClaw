/**
 * Regression test for the dual-notFoundHandler boot crash discovered during
 * the 2026-05-20 user trial.
 *
 * Symptom: sub-brain started silently, never bound port 3000, no log lines
 * past "tsx watch src/main.ts". Direct `tsx src/main.ts` revealed:
 *   Error: Not found handler already set for Fastify instance with prefix: '/'
 *
 * Root cause: `registerStatic()` calls `app.setNotFoundHandler(...)` when
 * the frontend dist directory exists, and `main.ts` then calls it again.
 * Fastify allows only ONE per prefix; the second throws.
 *
 * Fix: `main.ts` now skips its generic 404 handler when registerStatic
 * returned a non-undefined value (meaning it already set one).
 *
 * This test plants a fake frontend dist with index.html, registers static,
 * then attempts to register a second notFoundHandler — and verifies that
 * the registration throws (proving we still need the guard in main.ts).
 */

import Fastify from "fastify";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { registerStatic } from "../src/server/static.js";

describe("registerStatic + notFoundHandler interaction", () => {
  let tmpDir: string;
  let distDir: string;

  beforeEach(() => {
    tmpDir = `/tmp/webrain-test-static-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Mirror the production layout: registerStatic looks for `../../frontend/dist`
    // relative to the dirname passed in. We pass dirname = `<tmpDir>/sub-brain/src`
    // and create the dist at `<tmpDir>/frontend/dist`.
    distDir = join(tmpDir, "frontend", "dist");
    mkdirSync(distDir, { recursive: true });
    mkdirSync(join(tmpDir, "sub-brain", "src"), { recursive: true });
    writeFileSync(join(distDir, "index.html"), "<html><body>test</body></html>");
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("returns the dist path when frontend/dist exists", async () => {
    const app = Fastify();
    const fakeMainDirname = join(tmpDir, "sub-brain", "src");
    const result = registerStatic(app, fakeMainDirname);
    expect(result).toBeTruthy();
    expect(result).toContain("dist");
    await app.close();
  });

  it("returns undefined when no frontend/dist found", async () => {
    const app = Fastify();
    const result = registerStatic(app, "/nonexistent/path/that/does/not/exist");
    expect(result).toBeUndefined();
    await app.close();
  });

  it("CRITICAL: registerStatic with dist DOES set notFoundHandler — second registration must throw", async () => {
    // This is the invariant that caused the user-trial bug. If Fastify ever
    // becomes lenient about double notFoundHandler registration, this test
    // will fail and we'll know we can drop the guard in main.ts. Until then
    // the guard is load-bearing.
    const app = Fastify();
    const fakeMainDirname = join(tmpDir, "sub-brain", "src");
    registerStatic(app, fakeMainDirname);
    // Now try to register again — must throw
    expect(() => {
      app.setNotFoundHandler(() => { /* noop */ });
    }).toThrow(/Not found handler already set/);
    await app.close();
  });

  it("when dist is missing, second handler CAN be registered (main.ts fallback path)", async () => {
    const app = Fastify();
    registerStatic(app, "/nonexistent/path");
    // No static handler was registered → main.ts is free to set its own
    expect(() => {
      app.setNotFoundHandler(() => { /* noop */ });
    }).not.toThrow();
    await app.close();
  });
});
