import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

import { SkillHubClient } from "../src/skills/skill-hub-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_REGISTRY = resolve(__dirname, "fixtures/skill-registry");

const WEBRAIN_DIR = join(homedir(), ".webrain");
const REGISTRIES_PATH = join(WEBRAIN_DIR, "registries.json");
const INSTALLED_DIR = join(WEBRAIN_DIR, "skills", "installed");

const TEST_REGISTRY_NAME = "test-hub-registry";
const ECHO_ID = "test-skill-echo";
const GREET_ID = "test-skill-greet";

/** Snapshot current registries.json so the user's real config is preserved. */
function snapshotRegistries(): string | null {
  if (!existsSync(REGISTRIES_PATH)) return null;
  return readFileSync(REGISTRIES_PATH, "utf-8");
}

function restoreRegistries(snapshot: string | null) {
  if (snapshot === null) {
    if (existsSync(REGISTRIES_PATH)) {
      try { rmSync(REGISTRIES_PATH, { force: true }); } catch {}
    }
  } else {
    if (!existsSync(WEBRAIN_DIR)) mkdirSync(WEBRAIN_DIR, { recursive: true });
    writeFileSync(REGISTRIES_PATH, snapshot);
  }
}

function wipeTestInstalls() {
  for (const id of [ECHO_ID, GREET_ID]) {
    const dir = join(INSTALLED_DIR, id);
    if (existsSync(dir)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }
}

describe("SkillHubClient", () => {
  let snapshot: string | null = null;
  let client: SkillHubClient;

  beforeEach(() => {
    snapshot = snapshotRegistries();
    if (!existsSync(WEBRAIN_DIR)) mkdirSync(WEBRAIN_DIR, { recursive: true });
    writeFileSync(
      REGISTRIES_PATH,
      JSON.stringify({
        registries: [
          {
            name: TEST_REGISTRY_NAME,
            url: "file://" + FIXTURE_REGISTRY,
            enabled: true,
            priority: 100,
          },
        ],
      })
    );
    wipeTestInstalls();
    client = new SkillHubClient();
  });

  afterEach(() => {
    wipeTestInstalls();
    restoreRegistries(snapshot);
  });

  it("loads the configured registry from registries.json", () => {
    const regs = client.listRegistries();
    expect(regs).toHaveLength(1);
    expect(regs[0].name).toBe(TEST_REGISTRY_NAME);
  });

  it("v2.35: missing registries.json seeds default registries (disabled, low priority)", () => {
    // Delete the file the beforeEach hook just wrote, so this test
    // exercises the empty-state code path.
    if (existsSync(REGISTRIES_PATH)) rmSync(REGISTRIES_PATH, { force: true });

    const fresh = new SkillHubClient();
    const regs = fresh.listRegistries();
    expect(regs.length).toBeGreaterThanOrEqual(2);
    // All seeded registries must be disabled by default — no surprise
    // network requests on first launch.
    for (const r of regs) {
      expect(r.enabled).toBe(false);
    }
    // The file was persisted so a second SkillHubClient sees the same seed.
    expect(existsSync(REGISTRIES_PATH)).toBe(true);
    const persisted = JSON.parse(readFileSync(REGISTRIES_PATH, "utf-8"));
    expect(persisted.registries.length).toBe(regs.length);
    // Seed names must be stable so docs / scripts can reference them.
    const names = regs.map((r) => r.name).sort();
    expect(names).toContain("webrain-community");
    expect(names).toContain("local-bundled");
  });

  it("addRegistry persists to disk and rejects duplicates", () => {
    const r1 = client.addRegistry({ name: "another", url: "https://example.com", enabled: true });
    expect(r1.ok).toBe(true);
    expect(client.listRegistries()).toHaveLength(2);

    const dup = client.addRegistry({ name: "another", url: "https://example.com", enabled: true });
    expect(dup.ok).toBe(false);
    expect(dup.error).toContain("already exists");
  });

  it("removeRegistry succeeds for existing, fails for missing", () => {
    const ok = client.removeRegistry(TEST_REGISTRY_NAME);
    expect(ok.ok).toBe(true);
    expect(client.listRegistries()).toHaveLength(0);

    const miss = client.removeRegistry("nope");
    expect(miss.ok).toBe(false);
  });

  it("refreshIndex pulls index.json from a file:// registry", async () => {
    const res = await client.refreshIndex();
    expect(res.refreshed).toEqual([TEST_REGISTRY_NAME]);
    expect(res.errors).toEqual({});
  });

  it("refreshIndex reports errors for a bad URL but does not throw", async () => {
    client.addRegistry({ name: "broken", url: "file:///definitely/not/here", enabled: true });
    const res = await client.refreshIndex();
    expect(res.refreshed).toEqual([TEST_REGISTRY_NAME]);
    expect(res.errors).toHaveProperty("broken");
  });

  it("search returns entries matching id, name, description, or tags", async () => {
    await client.refreshIndex();

    expect(client.search("echo").some((r) => r.entry.id === ECHO_ID)).toBe(true);
    expect(client.search("greet").some((r) => r.entry.id === GREET_ID)).toBe(true);
    expect(client.search("greeting").some((r) => r.entry.id === GREET_ID)).toBe(true);
    expect(client.search("definitely-no-match")).toEqual([]);
  });

  it("findEntry locates a skill by id", async () => {
    await client.refreshIndex();
    const hit = client.findEntry(ECHO_ID);
    expect(hit).toBeDefined();
    expect(hit!.entry.id).toBe(ECHO_ID);
    expect(hit!.registry.name).toBe(TEST_REGISTRY_NAME);
  });

  it("install copies the manifest and stamps hub provenance", async () => {
    await client.refreshIndex();
    const res = await client.install(ECHO_ID);
    expect(res.ok).toBe(true);
    expect(res.skillId).toBe(ECHO_ID);
    expect(res.source).toBe(TEST_REGISTRY_NAME);

    const dst = join(INSTALLED_DIR, ECHO_ID, "skill.json");
    expect(existsSync(dst)).toBe(true);
    const installed = JSON.parse(readFileSync(dst, "utf-8"));
    expect(installed.id).toBe(ECHO_ID);
    expect(installed.source).toBe("hub");
    expect(installed.hubRegistry).toBe(TEST_REGISTRY_NAME);
    expect(installed.updatedAt).not.toBe("2026-05-13T00:00:00.000Z");
  });

  it("install auto-refreshes indices when nothing is cached yet", async () => {
    const res = await client.install(GREET_ID);
    expect(res.ok).toBe(true);
    expect(res.skillId).toBe(GREET_ID);
  });

  it("install fails when the skill id is not in any registry", async () => {
    await client.refreshIndex();
    const res = await client.install("not-a-real-skill");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not found in any registry");
  });

  it("install with explicit registryName restricts the lookup", async () => {
    await client.refreshIndex();
    const ok = await client.install(ECHO_ID, TEST_REGISTRY_NAME);
    expect(ok.ok).toBe(true);

    wipeTestInstalls();
    const miss = await client.install(ECHO_ID, "nonexistent-registry");
    expect(miss.ok).toBe(false);
  });

  it("uninstall removes the installed directory", async () => {
    await client.refreshIndex();
    await client.install(ECHO_ID);
    expect(existsSync(join(INSTALLED_DIR, ECHO_ID))).toBe(true);

    const res = client.uninstall(ECHO_ID);
    expect(res.ok).toBe(true);
    expect(existsSync(join(INSTALLED_DIR, ECHO_ID))).toBe(false);
  });

  it("uninstall fails cleanly when not installed", () => {
    const res = client.uninstall("never-installed-id");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Not installed");
  });

  it("listInstalled enumerates currently-installed skills", async () => {
    await client.refreshIndex();
    await client.install(ECHO_ID);
    await client.install(GREET_ID);
    const installed = client.listInstalled();
    const ids = installed.map((s) => s.id);
    expect(ids).toContain(ECHO_ID);
    expect(ids).toContain(GREET_ID);
  });
});
