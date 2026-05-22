/**
 * Skill Hub Client — install/uninstall/search skills across one or more
 * configured registries.
 *
 * Transports supported out of the box:
 *   - file://<absolute-path>  (also bare absolute paths)
 *   - https://...
 *
 * On install, the skill manifest is written to:
 *   ~/.webrain/skills/installed/<skill-id>/skill.json
 *
 * SkillManager picks installed skills up at startup via _loadInstalledHubSkills().
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  readdirSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

import type { Skill } from "./skill-manager.js";
import type {
  SkillRegistry,
  SkillHubConfig,
  RegistryIndex,
  RegistryIndexSnapshot,
  SkillSearchResult,
  InstallResult,
} from "./skill-hub-types.js";

const WEBRAIN_DIR = join(homedir(), ".webrain");
const REGISTRIES_PATH = join(WEBRAIN_DIR, "registries.json");
const INSTALLED_DIR = join(WEBRAIN_DIR, "skills", "installed");

const DEFAULT_PRIORITY = 50;

/**
 * Resolve a registry url + relative path into a concrete URL usable by
 * fetchText. Handles `file://`, bare absolute paths, and `https://`.
 */
function resolveResource(registryUrl: string, relPath: string): string {
  const cleanRel = relPath.replace(/^\/+/, "");

  if (registryUrl.startsWith("file://")) {
    const base = fileURLToPath(registryUrl);
    return "file://" + join(base, cleanRel);
  }
  if (registryUrl.startsWith("/") || registryUrl.match(/^[A-Za-z]:/)) {
    // bare absolute path
    return "file://" + join(registryUrl, cleanRel);
  }
  if (registryUrl.startsWith("http://") || registryUrl.startsWith("https://")) {
    return registryUrl.replace(/\/+$/, "") + "/" + cleanRel;
  }
  // Best-effort: treat as relative filesystem path
  return "file://" + join(process.cwd(), registryUrl, cleanRel);
}

/** Single fetch primitive: returns text body, throws on non-2xx or fs error. */
async function fetchText(url: string): Promise<string> {
  if (url.startsWith("file://")) {
    const path = fileURLToPath(url);
    return readFileSync(path, "utf-8");
  }
  if (url.startsWith("http://") || url.startsWith("https://")) {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${url}`);
    }
    return res.text();
  }
  throw new Error(`Unsupported URL scheme: ${url}`);
}

export class SkillHubClient {
  private config: SkillHubConfig;
  /** In-memory cache of refreshed registry indices, keyed by registry name. */
  private indices = new Map<string, RegistryIndexSnapshot>();

  constructor() {
    this.config = this._loadConfig();
  }

  // --------------------------------------------------------------------------
  // Config
  // --------------------------------------------------------------------------

  /**
   * v2.35 (P1 #9): on first launch the user's `~/.webrain/registries.json`
   * doesn't exist, and SkillhubPage shows "尚未配置任何 registry" empty
   * state — confusing because they don't know what URL to type.
   *
   * Seed a tiny default list when the file is missing. The seed lives at
   * the *bottom* of the priority so any user-added registry overrides it
   * — this is purely "starter content so the page isn't empty".
   *
   * The seed entries are `enabled: false` by default so we don't make
   * any network requests until the user explicitly turns them on. They
   * appear in the UI as visible-but-inactive choices.
   */
  private _seedDefaults(): SkillHubConfig {
    return {
      registries: [
        {
          name: "webrain-community",
          url: "https://github.com/zhwangsir/webrain-skills/raw/main/index.json",
          enabled: false,
          priority: 50,
        },
        {
          name: "local-bundled",
          // file:// URL pointing at sub-brain's bundled builtins. Loaded
          // lazily when enabled — no network round-trip.
          url: "file://./skills/builtins/index.json",
          enabled: false,
          priority: 100,
        },
      ],
    };
  }

  private _loadConfig(): SkillHubConfig {
    if (!existsSync(REGISTRIES_PATH)) {
      // v2.35: seed defaults so the page isn't empty on first launch.
      const seed = this._seedDefaults();
      try {
        if (!existsSync(WEBRAIN_DIR)) mkdirSync(WEBRAIN_DIR, { recursive: true });
        writeFileSync(REGISTRIES_PATH, JSON.stringify(seed, null, 2));
        console.log(
          `[skillhub] Seeded ${seed.registries.length} default registries at ${REGISTRIES_PATH}`
        );
      } catch (err) {
        console.warn("[skillhub] Could not persist seed registries:", err);
      }
      return seed;
    }
    try {
      const raw = readFileSync(REGISTRIES_PATH, "utf-8");
      const parsed = JSON.parse(raw) as SkillHubConfig;
      return { registries: Array.isArray(parsed.registries) ? parsed.registries : [] };
    } catch (err) {
      console.warn("[skillhub] Failed to read registries.json:", err);
      return { registries: [] };
    }
  }

  private _saveConfig(): void {
    if (!existsSync(WEBRAIN_DIR)) mkdirSync(WEBRAIN_DIR, { recursive: true });
    writeFileSync(REGISTRIES_PATH, JSON.stringify(this.config, null, 2));
  }

  listRegistries(): SkillRegistry[] {
    return [...this.config.registries];
  }

  addRegistry(reg: SkillRegistry): { ok: boolean; error?: string } {
    if (this.config.registries.some((r) => r.name === reg.name)) {
      return { ok: false, error: `Registry already exists: ${reg.name}` };
    }
    this.config.registries.push({
      name: reg.name,
      url: reg.url,
      enabled: reg.enabled ?? true,
      priority: reg.priority ?? DEFAULT_PRIORITY,
    });
    this._saveConfig();
    return { ok: true };
  }

  removeRegistry(name: string): { ok: boolean; error?: string } {
    const before = this.config.registries.length;
    this.config.registries = this.config.registries.filter((r) => r.name !== name);
    if (this.config.registries.length === before) {
      return { ok: false, error: `Registry not found: ${name}` };
    }
    this.indices.delete(name);
    this._saveConfig();
    return { ok: true };
  }

  // --------------------------------------------------------------------------
  // Discovery
  // --------------------------------------------------------------------------

  /** Fetch index.json from one registry (or all if name omitted). */
  async refreshIndex(name?: string): Promise<{ refreshed: string[]; errors: Record<string, string> }> {
    const targets = name
      ? this.config.registries.filter((r) => r.name === name)
      : this.config.registries.filter((r) => r.enabled);

    const refreshed: string[] = [];
    const errors: Record<string, string> = {};

    for (const reg of targets) {
      try {
        const url = resolveResource(reg.url, "index.json");
        const text = await fetchText(url);
        const index = JSON.parse(text) as RegistryIndex;
        if (!Array.isArray(index.skills)) {
          throw new Error("index.json: missing skills[]");
        }
        this.indices.set(reg.name, {
          registry: reg,
          index,
          fetchedAt: new Date().toISOString(),
        });
        refreshed.push(reg.name);
      } catch (err: any) {
        errors[reg.name] = err.message ?? String(err);
      }
    }
    return { refreshed, errors };
  }

  /** Search cached indices (call refreshIndex first if you want fresh data). */
  search(query: string): SkillSearchResult[] {
    const q = query.toLowerCase();
    const out: SkillSearchResult[] = [];

    const sorted = [...this.config.registries].sort(
      (a, b) => (b.priority ?? DEFAULT_PRIORITY) - (a.priority ?? DEFAULT_PRIORITY)
    );
    for (const reg of sorted) {
      const snap = this.indices.get(reg.name);
      if (!snap) continue;
      for (const entry of snap.index.skills) {
        if (
          entry.id.toLowerCase().includes(q) ||
          entry.name.toLowerCase().includes(q) ||
          (entry.description ?? "").toLowerCase().includes(q) ||
          (entry.tags ?? []).some((t) => t.toLowerCase().includes(q))
        ) {
          out.push({ entry, registry: reg });
        }
      }
    }
    return out;
  }

  /** Find the first registry that lists a given skill id. */
  findEntry(skillId: string, registryName?: string): SkillSearchResult | undefined {
    const sorted = [...this.config.registries].sort(
      (a, b) => (b.priority ?? DEFAULT_PRIORITY) - (a.priority ?? DEFAULT_PRIORITY)
    );
    for (const reg of sorted) {
      if (registryName && reg.name !== registryName) continue;
      const snap = this.indices.get(reg.name);
      if (!snap) continue;
      const entry = snap.index.skills.find((e) => e.id === skillId);
      if (entry) return { entry, registry: reg };
    }
    return undefined;
  }

  // --------------------------------------------------------------------------
  // Install / Uninstall
  // --------------------------------------------------------------------------

  /**
   * Install a skill from its registry. Auto-refreshes indices if not cached.
   * Writes the resolved skill manifest to:
   *   ~/.webrain/skills/installed/<id>/skill.json
   */
  async install(skillId: string, registryName?: string): Promise<InstallResult> {
    for (const reg of this.config.registries.filter((r) => r.enabled)) {
      if (!this.indices.has(reg.name)) {
        await this.refreshIndex(reg.name).catch(() => undefined);
      }
    }

    const found = this.findEntry(skillId, registryName);
    if (!found) {
      return { ok: false, error: `Skill not found in any registry: ${skillId}` };
    }

    const manifestUrl = resolveResource(found.registry.url, found.entry.path);
    let manifestText: string;
    try {
      manifestText = await fetchText(manifestUrl);
    } catch (err: any) {
      return { ok: false, error: `Failed to fetch skill manifest: ${err.message ?? err}` };
    }

    let skill: Skill;
    try {
      skill = JSON.parse(manifestText) as Skill;
    } catch (err: any) {
      return { ok: false, error: `Skill manifest is not valid JSON: ${err.message ?? err}` };
    }
    if (!skill.id || !skill.code || !skill.language) {
      return { ok: false, error: "Skill manifest missing required fields (id/code/language)" };
    }

    skill.source = "hub";
    skill.hubRegistry = found.registry.name;
    if (!skill.createdAt) skill.createdAt = new Date().toISOString();
    skill.updatedAt = new Date().toISOString();

    const dir = join(INSTALLED_DIR, skill.id);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "skill.json"), JSON.stringify(skill, null, 2));

    return { ok: true, skillId: skill.id, source: found.registry.name };
  }

  uninstall(skillId: string): InstallResult {
    const dir = join(INSTALLED_DIR, skillId);
    if (!existsSync(dir)) {
      return { ok: false, error: `Not installed: ${skillId}` };
    }
    try {
      rmSync(dir, { recursive: true, force: true });
      return { ok: true, skillId };
    } catch (err: any) {
      return { ok: false, error: err.message ?? String(err) };
    }
  }

  listInstalled(): Skill[] {
    if (!existsSync(INSTALLED_DIR)) return [];
    const out: Skill[] = [];
    for (const id of readdirSync(INSTALLED_DIR)) {
      const p = join(INSTALLED_DIR, id, "skill.json");
      if (!existsSync(p)) continue;
      try {
        out.push(JSON.parse(readFileSync(p, "utf-8")));
      } catch {
        /* skip corrupt */
      }
    }
    return out;
  }
}
