/**
 * Skill Hub frontend API client — mirrors sub-brain's 13 /api/skillhub/* endpoints.
 *
 * 4 surfaces:
 *   - Marketplace (list/search/install/uninstall)
 *   - Registries  (CRUD + refresh)
 *   - Improvements (candidates → manual improve)
 *   - Drafts (list → promote)
 */

import { api } from "./client";

// -----------------------------------------------------------------------------
// Adapted marketplace shape (sub-brain's adaptHubItem output)
// -----------------------------------------------------------------------------

export interface SkillhubItem {
  name: string;
  slug: string;
  description?: string;
  version?: string;
  author?: string;
  installed?: boolean;
}

// -----------------------------------------------------------------------------
// Full Skill record (matches sub-brain's Skill interface)
// -----------------------------------------------------------------------------

export interface FailureMode {
  signature: string;
  count: number;
  lastSeen: string;
  examples: string[];
}

export interface AutoImproveConfig {
  enabled: boolean;
  thresholdUses: number;
  thresholdFailureRate: number;
}

export type SkillSource = "built-in" | "user" | "agent-auto" | "hub";

export interface Skill {
  id: string;
  name: string;
  description: string;
  triggerPatterns: string[];
  code: string;
  language: "python" | "javascript" | "typescript";
  usageCount: number;
  successRate: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  tags: string[];

  failureModes?: FailureMode[];
  lastRefinedAt?: string;
  forkOf?: string;
  autoImprove?: AutoImproveConfig;
  source?: SkillSource;
  hubRegistry?: string;
}

// -----------------------------------------------------------------------------
// Registry
// -----------------------------------------------------------------------------

export interface SkillRegistry {
  name: string;
  url: string;
  enabled: boolean;
  priority?: number;
}

export interface RefreshResult {
  refreshed: string[];
  errors: Record<string, string>;
}

// -----------------------------------------------------------------------------
// Improvement
// -----------------------------------------------------------------------------

export interface ImprovementCandidate {
  skill: Skill;
  primaryFailureMode: FailureMode;
  reason: string;
}

export interface ImproveResult {
  ok: boolean;
  fork?: Skill;
  error?: string;
}

// -----------------------------------------------------------------------------
// Result envelopes
// -----------------------------------------------------------------------------

export interface InstallResult {
  ok: boolean;
  skillId?: string;
  source?: string;
  error?: string;
}

export interface PromoteResult {
  ok: boolean;
  skill?: Skill;
  error?: string;
}

// -----------------------------------------------------------------------------
// Client
// -----------------------------------------------------------------------------

export const skillhubApi = {
  // ---- Marketplace ----

  list: () => api.get<{ skills: SkillhubItem[] }>("/api/skillhub/list").then((r) => r.skills),

  search: (q: string) =>
    api.get<{ skills: SkillhubItem[] }>(`/api/skillhub/search?q=${encodeURIComponent(q)}`).then((r) => r.skills),

  install: (slug: string, registry?: string) => api.post<InstallResult>("/api/skillhub/install", { slug, registry }),

  uninstall: (slug: string) => api.post<InstallResult>("/api/skillhub/uninstall", { slug }),

  listInstalled: () => api.get<{ skills: Skill[] }>("/api/skillhub/installed").then((r) => r.skills),

  // ---- Registries ----

  listRegistries: () => api.get<{ registries: SkillRegistry[] }>("/api/skillhub/registries").then((r) => r.registries),

  addRegistry: (reg: SkillRegistry) => api.post<{ ok: boolean; error?: string }>("/api/skillhub/registries", reg),

  /**
   * v2.39: partial update for an existing registry. Use this to flip
   * v2.35 seed entries from `enabled: false` to `enabled: true`
   * (or vice versa) — addRegistry refuses duplicates by design.
   * Omitted fields are preserved server-side.
   */
  updateRegistry: (name: string, patch: { enabled?: boolean; priority?: number; url?: string }) =>
    api.patch<{ ok: boolean; error?: string }>(`/api/skillhub/registries/${encodeURIComponent(name)}`, patch),

  removeRegistry: (name: string) =>
    api.delete<{ ok: boolean; error?: string }>(`/api/skillhub/registries/${encodeURIComponent(name)}`),

  refresh: (name?: string) => api.post<RefreshResult>("/api/skillhub/refresh", name ? { name } : {}),

  // ---- Improvements ----

  listCandidates: () =>
    api.get<{ candidates: ImprovementCandidate[] }>("/api/skillhub/candidates").then((r) => r.candidates),

  improve: (skillId: string, code: string, reason: string) =>
    api.post<ImproveResult>("/api/skillhub/improve", { skillId, code, reason }),

  // ---- Drafts ----

  listDrafts: () => api.get<{ drafts: Skill[] }>("/api/skillhub/drafts").then((r) => r.drafts),

  promoteDraft: (draftId: string) =>
    api.post<PromoteResult>(`/api/skillhub/drafts/${encodeURIComponent(draftId)}/promote`, {}),
};
