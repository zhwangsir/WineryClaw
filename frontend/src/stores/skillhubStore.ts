import { create } from "zustand";
import { message } from "antd";
import { skillhubApi } from "../api/skillhub";
import type { SkillhubItem, Skill, SkillRegistry, ImprovementCandidate } from "../api/skillhub";

interface SkillhubState {
  // marketplace
  skills: SkillhubItem[];
  loading: boolean;

  // installed
  installed: Skill[];
  installedLoading: boolean;

  // registries
  registries: SkillRegistry[];
  registriesLoading: boolean;

  // improvements (self-learning candidates)
  candidates: ImprovementCandidate[];
  candidatesLoading: boolean;

  // drafts (auto-discovered)
  drafts: Skill[];
  draftsLoading: boolean;

  // --- marketplace actions ---
  fetchSkills: () => Promise<void>;
  search: (q: string) => Promise<void>;
  install: (slug: string, registry?: string) => Promise<void>;
  uninstall: (slug: string) => Promise<void>;

  // --- installed actions ---
  fetchInstalled: () => Promise<void>;

  // --- registries actions ---
  fetchRegistries: () => Promise<void>;
  addRegistry: (reg: SkillRegistry) => Promise<boolean>;
  removeRegistry: (name: string) => Promise<boolean>;
  /** v2.39 — partial update; used by UI switch to toggle enabled. */
  updateRegistry: (name: string, patch: { enabled?: boolean; priority?: number; url?: string }) => Promise<boolean>;
  refresh: (name?: string) => Promise<void>;

  // --- improvements actions ---
  fetchCandidates: () => Promise<void>;
  improve: (skillId: string, code: string, reason: string) => Promise<boolean>;

  // --- drafts actions ---
  fetchDrafts: () => Promise<void>;
  promoteDraft: (draftId: string) => Promise<boolean>;
}

/** Normalize an unknown error into a string for UI display. */
function errMsg(e: unknown, fallback: string): string {
  if (e instanceof Error) return e.message || fallback;
  if (typeof e === "string") return e;
  return fallback;
}

export const useSkillhubStore = create<SkillhubState>((set, get) => ({
  // marketplace
  skills: [],
  loading: false,

  // installed
  installed: [],
  installedLoading: false,

  // registries
  registries: [],
  registriesLoading: false,

  // candidates
  candidates: [],
  candidatesLoading: false,

  // drafts
  drafts: [],
  draftsLoading: false,

  // ---- marketplace ----

  fetchSkills: async () => {
    set({ loading: true });
    try {
      const skills = await skillhubApi.list();
      set({ skills, loading: false });
    } catch (e: unknown) {
      set({ loading: false });
      message.error(errMsg(e, "获取技能列表失败"));
    }
  },

  search: async (q) => {
    set({ loading: true });
    try {
      const skills = await skillhubApi.search(q);
      set({ skills, loading: false });
    } catch (e: unknown) {
      set({ loading: false });
      message.error(errMsg(e, "搜索失败"));
    }
  },

  install: async (slug, registry) => {
    try {
      const result = await skillhubApi.install(slug, registry);
      if (result.ok) {
        message.success(`技能 "${slug}" 安装成功`);
        await get().fetchSkills();
        await get().fetchInstalled();
      } else {
        message.error(result.error || "安装失败");
      }
    } catch (e: unknown) {
      message.error(errMsg(e, "安装失败"));
    }
  },

  uninstall: async (slug) => {
    try {
      const result = await skillhubApi.uninstall(slug);
      if (result.ok) {
        message.success(`技能 "${slug}" 已卸载`);
        await get().fetchSkills();
        await get().fetchInstalled();
      } else {
        message.error(result.error || "卸载失败");
      }
    } catch (e: unknown) {
      message.error(errMsg(e, "卸载失败"));
    }
  },

  // ---- installed ----

  fetchInstalled: async () => {
    set({ installedLoading: true });
    try {
      const installed = await skillhubApi.listInstalled();
      set({ installed, installedLoading: false });
    } catch (e: unknown) {
      set({ installedLoading: false });
      message.error(errMsg(e, "获取已安装技能失败"));
    }
  },

  // ---- registries ----

  fetchRegistries: async () => {
    set({ registriesLoading: true });
    try {
      const registries = await skillhubApi.listRegistries();
      set({ registries, registriesLoading: false });
    } catch (e: unknown) {
      set({ registriesLoading: false });
      message.error(errMsg(e, "获取 registry 列表失败"));
    }
  },

  addRegistry: async (reg) => {
    try {
      const result = await skillhubApi.addRegistry(reg);
      if (result.ok) {
        message.success(`Registry "${reg.name}" 已添加`);
        await get().fetchRegistries();
        return true;
      }
      message.error(result.error || "添加 registry 失败");
      return false;
    } catch (e: unknown) {
      message.error(errMsg(e, "添加 registry 失败"));
      return false;
    }
  },

  removeRegistry: async (name) => {
    try {
      const result = await skillhubApi.removeRegistry(name);
      if (result.ok) {
        message.success(`Registry "${name}" 已移除`);
        await get().fetchRegistries();
        return true;
      }
      message.error(result.error || "移除 registry 失败");
      return false;
    } catch (e: unknown) {
      message.error(errMsg(e, "移除 registry 失败"));
      return false;
    }
  },

  /**
   * v2.39: partial update for a registry. Used by the SkillhubPage
   * UI switch to flip seed entries from `enabled: false` to
   * `enabled: true` (or vice versa). Optimistic in the UI sense
   * (re-fetches on success) — keep that pattern aligned with
   * addRegistry / removeRegistry.
   */
  updateRegistry: async (name: string, patch: { enabled?: boolean; priority?: number; url?: string }) => {
    try {
      const result = await skillhubApi.updateRegistry(name, patch);
      if (result.ok) {
        // Build a concise success line so the user can see what changed.
        const parts: string[] = [];
        if (typeof patch.enabled === "boolean") parts.push(patch.enabled ? "已启用" : "已停用");
        if (typeof patch.priority === "number") parts.push(`priority=${patch.priority}`);
        if (typeof patch.url === "string") parts.push("URL 已更新");
        message.success(`Registry "${name}" ${parts.join(", ") || "已更新"}`);
        await get().fetchRegistries();
        return true;
      }
      message.error(result.error || "更新 registry 失败");
      return false;
    } catch (e: unknown) {
      message.error(errMsg(e, "更新 registry 失败"));
      return false;
    }
  },

  refresh: async (name) => {
    set({ loading: true });
    try {
      const result = await skillhubApi.refresh(name);
      const errorCount = Object.keys(result.errors || {}).length;
      if (errorCount > 0) {
        message.warning(`刷新完成:${result.refreshed.length} 个成功,${errorCount} 个失败`);
      } else {
        message.success(`已刷新 ${result.refreshed.length} 个 registry`);
      }
      await get().fetchSkills();
      set({ loading: false });
    } catch (e: unknown) {
      set({ loading: false });
      message.error(errMsg(e, "刷新失败"));
    }
  },

  // ---- improvements ----

  fetchCandidates: async () => {
    set({ candidatesLoading: true });
    try {
      const candidates = await skillhubApi.listCandidates();
      set({ candidates, candidatesLoading: false });
    } catch (e: unknown) {
      set({ candidatesLoading: false });
      message.error(errMsg(e, "获取改进候选失败"));
    }
  },

  improve: async (skillId, code, reason) => {
    try {
      const result = await skillhubApi.improve(skillId, code, reason);
      if (result.ok) {
        message.success(`技能 "${skillId}" 已生成改进版 ${result.fork?.id}`);
        await get().fetchCandidates();
        return true;
      }
      message.error(result.error || "改进失败");
      return false;
    } catch (e: unknown) {
      message.error(errMsg(e, "改进失败"));
      return false;
    }
  },

  // ---- drafts ----

  fetchDrafts: async () => {
    set({ draftsLoading: true });
    try {
      const drafts = await skillhubApi.listDrafts();
      set({ drafts, draftsLoading: false });
    } catch (e: unknown) {
      set({ draftsLoading: false });
      message.error(errMsg(e, "获取草稿失败"));
    }
  },

  promoteDraft: async (draftId) => {
    try {
      const result = await skillhubApi.promoteDraft(draftId);
      if (result.ok) {
        message.success(`草稿已晋升为 ${result.skill?.id}`);
        await get().fetchDrafts();
        await get().fetchInstalled();
        return true;
      }
      message.error(result.error || "晋升失败");
      return false;
    } catch (e: unknown) {
      message.error(errMsg(e, "晋升失败"));
      return false;
    }
  },
}));
