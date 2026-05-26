/**
 * Sandbox skill runtime tests.
 *
 * No Docker required — we inject a stub `DockerSandbox` and an explicit
 * `workspacesRoot` (tmp dir) so the runtime never touches the real
 * ~/.webrain/.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runSandboxSkill } from "../src/skills/runtime/run-sandbox-skill.js";
import type { DockerSandbox } from "../src/sandbox/docker-sandbox.js";

const RESULT_MARKER = "__WEBRAIN_SKILL_RESULT__:";

let workspacesRoot: string;

beforeEach(() => {
  workspacesRoot = join(
    tmpdir(),
    `webrain-sb-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(workspacesRoot, { recursive: true });
});

afterEach(() => {
  try {
    if (workspacesRoot.startsWith(tmpdir())) {
      rmSync(workspacesRoot, { recursive: true, force: true });
    }
  } catch {
    /* ignore */
  }
});

function makeFakeDocker(overrides: Partial<DockerSandbox> = {}): DockerSandbox {
  return {
    execInWorkspace: vi.fn(async () => ({
      ok: true,
      output: `some preamble\n${RESULT_MARKER}{"echo":"hi"}\n`,
      exitCode: 0,
    })),
    ...overrides,
  } as unknown as DockerSandbox;
}

describe("runSandboxSkill", () => {
  it("python: writes script + params and parses marker result", async () => {
    const docker = makeFakeDocker();
    const r = await runSandboxSkill({
      language: "python",
      code: "result = params['x'] * 2",
      params: { x: 21 },
      workspaceId: "test1",
      dockerSandbox: docker,
      workspacesRoot,
    });
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({ echo: "hi" });
    expect(docker.execInWorkspace).toHaveBeenCalledWith(
      "test1",
      expect.stringMatching(
        /^python3 \/workspace\/\.webrain-skill-[a-f0-9]+\.py \/workspace\/\.webrain-skill-[a-f0-9]+\.json$/,
      ),
      { timeoutMs: 30_000 },
    );
  });

  it("javascript: uses node runner + .mjs extension", async () => {
    const docker = makeFakeDocker();
    const r = await runSandboxSkill({
      language: "javascript",
      code: "let result = params.n + 1;",
      params: { n: 4 },
      workspaceId: "test2",
      dockerSandbox: docker,
      workspacesRoot,
    });
    expect(r.ok).toBe(true);
    expect(docker.execInWorkspace).toHaveBeenCalledWith(
      "test2",
      expect.stringMatching(/^node \/workspace\/\.webrain-skill-[a-f0-9]+\.mjs/),
      expect.anything(),
    );
  });

  it("falls back to raw stdout when no marker present", async () => {
    const docker = makeFakeDocker({
      execInWorkspace: vi.fn(async () => ({
        ok: true,
        output: "hello\nworld\n",
        exitCode: 0,
      })),
    });
    const r = await runSandboxSkill({
      language: "python",
      code: "print('hello\\nworld')",
      params: {},
      workspaceId: "test3",
      dockerSandbox: docker,
      workspacesRoot,
    });
    expect(r.ok).toBe(true);
    expect(r.result).toBe("hello\nworld");
  });

  it("propagates exec failure as ok=false with error message", async () => {
    const docker = makeFakeDocker({
      execInWorkspace: vi.fn(async () => ({
        ok: false,
        output: "",
        exitCode: 1,
        error: "boom",
      })),
    });
    const r = await runSandboxSkill({
      language: "python",
      code: "raise SystemExit(1)",
      params: {},
      workspaceId: "test4",
      dockerSandbox: docker,
      workspacesRoot,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("boom");
  });

  it("returns Docker-unavailable when execInWorkspace says so", async () => {
    const docker = makeFakeDocker({
      execInWorkspace: vi.fn(async () => ({
        ok: false,
        output: "",
        exitCode: -1,
        error: "Docker not available",
      })),
    });
    const r = await runSandboxSkill({
      language: "python",
      code: "x = 1",
      params: {},
      workspaceId: "test5",
      dockerSandbox: docker,
      workspacesRoot,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Docker not available");
  });

  it("flags timedOut when error message indicates timeout", async () => {
    const docker = makeFakeDocker({
      execInWorkspace: vi.fn(async () => ({
        ok: false,
        output: "",
        exitCode: 124,
        error: "command timed out after 100ms",
      })),
    });
    const r = await runSandboxSkill({
      language: "python",
      code: "while True: pass",
      params: {},
      workspaceId: "test6",
      dockerSandbox: docker,
      workspacesRoot,
      timeoutMs: 100,
    });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
  });

  it("cleans up temp script + params files after successful run", async () => {
    const docker = makeFakeDocker();
    await runSandboxSkill({
      language: "python",
      code: "result = 1",
      params: {},
      workspaceId: "cleanup-ws",
      dockerSandbox: docker,
      workspacesRoot,
    });
    const dir = join(workspacesRoot, "cleanup-ws");
    expect(existsSync(dir)).toBe(true);
    const remaining = readdirSync(dir).filter((f) => f.startsWith(".webrain-skill-"));
    expect(remaining).toEqual([]);
  });

  it("cleans up even if exec throws", async () => {
    const docker = makeFakeDocker({
      execInWorkspace: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await expect(
      runSandboxSkill({
        language: "python",
        code: "x=1",
        params: {},
        workspaceId: "cleanup2",
        dockerSandbox: docker,
        workspacesRoot,
      }),
    ).rejects.toThrow("boom");
    const dir = join(workspacesRoot, "cleanup2");
    expect(existsSync(dir)).toBe(true);
    const remaining = readdirSync(dir).filter((f) => f.startsWith(".webrain-skill-"));
    expect(remaining).toEqual([]);
  });

  it("writes the script + params files that the runner will read", async () => {
    let capturedScript: string | null = null;
    let capturedParams: string | null = null;

    const docker = makeFakeDocker({
      execInWorkspace: vi.fn(async (_workspaceId: string, command: string) => {
        // Extract the container script + params paths, translate to
        // host paths (drop the /workspace prefix), and slurp them
        // BEFORE the runtime's finally block unlinks them.
        const m = command.match(
          /(\/workspace\/\.webrain-skill-[a-f0-9]+\.py) (\/workspace\/\.webrain-skill-[a-f0-9]+\.json)/,
        );
        if (m) {
          const wsDir = join(workspacesRoot, "ws-capture");
          capturedScript = readFileSync(
            join(wsDir, m[1].replace("/workspace/", "")),
            "utf-8",
          );
          capturedParams = readFileSync(
            join(wsDir, m[2].replace("/workspace/", "")),
            "utf-8",
          );
        }
        return { ok: true, output: `${RESULT_MARKER}null\n`, exitCode: 0 };
      }) as unknown as DockerSandbox["execInWorkspace"],
    });

    await runSandboxSkill({
      language: "python",
      code: "x=1",
      params: { name: "tia", count: 42 },
      workspaceId: "ws-capture",
      dockerSandbox: docker,
      workspacesRoot,
    });

    expect(capturedScript).toContain("import json, sys");
    expect(capturedScript).toContain("x=1");
    expect(JSON.parse(capturedParams!)).toEqual({ name: "tia", count: 42 });
  });
});
