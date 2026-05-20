/**
 * Docker sandbox unit tests.
 *
 * Most of the logic only runs when `docker` is on PATH. On dev machines
 * without Docker installed (the common case here), `isAvailable()` returns
 * false and the workspace methods short-circuit. These tests cover both
 * the validation layer (workspaceId regex) and the "Docker unavailable"
 * fallthrough — they do NOT require a real Docker daemon.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { DockerSandbox } from "../src/sandbox/docker-sandbox.js";

describe("DockerSandbox workspaces", () => {
  let sandbox: DockerSandbox;

  beforeEach(() => {
    sandbox = new DockerSandbox();
    // Force the "not available" path so we don't accidentally shell out
    // to docker even if it happens to be installed. The tests below cover
    // validation + error reporting only; integration with real Docker is
    // exercised by the smoke layer.
    // @ts-expect-error — private static, accessed via class for test override
    DockerSandbox._cachedAvailability = false;
  });

  it("listWorkspaces() starts empty", () => {
    expect(sandbox.listWorkspaces()).toEqual([]);
  });

  it("rejects invalid workspaceId in ensureWorkspace", async () => {
    const r = await sandbox.ensureWorkspace("bad id with spaces");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Invalid workspaceId/);
  });

  it("rejects path-traversal-style workspaceId", async () => {
    const r = await sandbox.ensureWorkspace("../escape");
    expect(r.ok).toBe(false);
  });

  it("rejects empty workspaceId", async () => {
    const r = await sandbox.ensureWorkspace("");
    expect(r.ok).toBe(false);
  });

  it("rejects oversized workspaceId (>64 chars)", async () => {
    const r = await sandbox.ensureWorkspace("a".repeat(65));
    expect(r.ok).toBe(false);
  });

  it("accepts alphanumeric + hyphen + underscore", async () => {
    // With Docker unavailable, validation still passes, but the docker
    // run fails so we get a different error. Either way: NOT "Invalid
    // workspaceId".
    const r = await sandbox.ensureWorkspace("agent_42-dev");
    expect(r.error).not.toMatch(/Invalid workspaceId/);
  });

  it("ensureWorkspace returns Docker-unavailable error when no docker", async () => {
    const r = await sandbox.ensureWorkspace("ok");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Docker not available");
  });

  it("execInWorkspace returns Docker-unavailable error when no docker", async () => {
    const r = await sandbox.execInWorkspace("ok", "echo hi");
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(-1);
    expect(r.error).toBe("Docker not available");
  });

  it("execInWorkspace rejects invalid workspaceId before docker check", async () => {
    const r = await sandbox.execInWorkspace("bad..id", "echo hi");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Invalid workspaceId/);
  });

  it("removeWorkspace is idempotent — succeeds even if workspace doesn't exist", async () => {
    const r = await sandbox.removeWorkspace("nonexistent");
    expect(r.ok).toBe(true);
  });

  it("removeWorkspace rejects invalid workspaceId", async () => {
    const r = await sandbox.removeWorkspace("bad id");
    expect(r.ok).toBe(false);
  });
});
