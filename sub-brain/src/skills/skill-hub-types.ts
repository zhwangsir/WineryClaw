/**
 * Skill Hub data model.
 *
 * Designed to be adapter-friendly so different registries (file://, https://,
 * agentskills.io, GitHub raw, npm) can serve the same shape.
 */

/**
 * One registry source. Multiple registries can be configured; install
 * search order is by descending `priority`.
 */
export interface SkillRegistry {
  /** Human-readable id; used in CLI and to dedupe configs. */
  name: string;
  /**
   * Base URL of the registry. Supported transports:
   *   - file:///abs/path/to/registry  (or bare absolute path / relative path)
   *   - https://example.com/skills
   *
   * The registry is expected to serve an `index.json` at its root.
   */
  url: string;
  enabled: boolean;
  /** Higher = checked first. Default 50. */
  priority?: number;
}

export interface SkillHubConfig {
  registries: SkillRegistry[];
}

/** One entry in a registry's index.json. */
export interface RegistrySkillEntry {
  id: string;
  name: string;
  description?: string;
  version: string;
  /** Path (relative to registry root) where the skill.json manifest lives. */
  path: string;
  tags?: string[];
  /** Optional sha256 of the skill.json for tamper-detection. */
  checksum?: string;
}

export interface RegistryIndex {
  registry_name: string;
  version: string;          // index spec version, not skill version
  skills: RegistrySkillEntry[];
  /** Optional fields the registry may include but we don't require. */
  description?: string;
  homepage?: string;
}

/**
 * A snapshot of one fetched registry index plus metadata about the fetch.
 * Kept in-memory; can be persisted later if needed.
 */
export interface RegistryIndexSnapshot {
  registry: SkillRegistry;
  index: RegistryIndex;
  fetchedAt: string;
}

/** Result of a search across all enabled registries. */
export interface SkillSearchResult {
  entry: RegistrySkillEntry;
  registry: SkillRegistry;
}

/** Result of install/uninstall operations. */
export interface InstallResult {
  ok: boolean;
  skillId?: string;
  source?: string;       // registry name
  error?: string;
}
