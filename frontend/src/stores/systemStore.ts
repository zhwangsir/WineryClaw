import { create } from "zustand";
import { systemApi } from "../api/system";
import { configApi } from "../api/config";
import { StorageAdapter } from "../utils/storage";
import type { SystemHealth, Notification, ModelHealth } from "../api/types";

const THEME_KEY = "webrain-theme";
const STALE_MS = 30000;
// 主动洞察轮询间隔（毫秒）。每 10 分钟检查一次，不影响性能。
const INSIGHT_POLL_MS = 10 * 60 * 1000;

interface SystemState {
  health: SystemHealth | null;
  modelHealth: ModelHealth | null;
  loading: boolean;
  error: Error | null;
  theme: "light" | "dark";
  lastHealthUpdate: number;
  notifications: Notification[];
  _insightPollTimer: ReturnType<typeof setInterval> | null;

  fetchHealth: () => Promise<void>;
  fetchModelHealth: () => Promise<void>;
  setTheme: (t: "light" | "dark") => void;
  toggleTheme: () => void;
  markNotificationRead: (id: string) => void;
  startInsightPolling: () => void;
  stopInsightPolling: () => void;
  fetchProactiveInsights: () => Promise<void>;
}

function getInitialTheme(): "light" | "dark" {
  return StorageAdapter.get<"light" | "dark">(THEME_KEY, "dark");
}

export const useSystemStore = create<SystemState>((set, get) => ({
  health: null,
  modelHealth: null,
  loading: false,
  error: null,
  theme: getInitialTheme(),
  lastHealthUpdate: 0,
  notifications: [],
  _insightPollTimer: null,

  fetchHealth: async () => {
    const now = Date.now();
    if (get().loading) return;
    if (now - get().lastHealthUpdate < STALE_MS && get().health) return;

    set({ loading: true, error: null });
    try {
      const hb = await systemApi.health();
      set({ health: hb, loading: false, error: null, lastHealthUpdate: now });
    } catch (e: any) {
      console.error("[systemStore] fetchHealth failed:", e.message);
      set({ loading: false, error: e });
    }
  },

  fetchModelHealth: async () => {
    const now = Date.now();
    if (get().loading) return;
    if (now - get().lastHealthUpdate < STALE_MS && get().modelHealth) return;

    set({ loading: true, error: null });
    try {
      const mb = await configApi.health();
      set({ modelHealth: mb as unknown as ModelHealth, loading: false, error: null, lastHealthUpdate: now });
    } catch (e: any) {
      console.error("[systemStore] fetchModelHealth failed:", e.message);
      set({ loading: false, error: e });
    }
  },

  setTheme: (t) => {
    StorageAdapter.set(THEME_KEY, t);
    document.documentElement.setAttribute("data-theme", t);
    set({ theme: t });
  },

  toggleTheme: () => {
    const next = get().theme === "dark" ? "light" : "dark";
    get().setTheme(next);
  },

  markNotificationRead: (id) => {
    set((s) => ({
      notifications: s.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)),
    }));
    // 同步通知到后端（S6 洞察）
    systemApi.markInsightRead(id).catch(() => {/* 非关键，静默失败 */});
  },

  // S6: 主动洞察轮询 — 从 Dreaming 引擎获取新洞察并推入 notifications
  fetchProactiveInsights: async () => {
    try {
      const res = await systemApi.proactiveInsights();
      const incoming = res.insights ?? [];
      if (!incoming.length) return;

      set((s) => {
        const existingIds = new Set(s.notifications.map((n) => n.id));
        const newOnes: Notification[] = incoming
          .filter((i) => !i.read && !existingIds.has(i.id))
          .map((i) => ({
            id: i.id,
            type: (i.type as Notification["type"]) ?? "info",
            title: i.title,
            message: i.content,
            read: false,
            createdAt: i.createdAt,
          }));
        if (!newOnes.length) return s;
        return { notifications: [...newOnes, ...s.notifications].slice(0, 50) };
      });
    } catch {
      // 洞察轮询失败静默处理，不影响主功能
    }
  },

  startInsightPolling: () => {
    if (get()._insightPollTimer) return; // 已在运行
    // 立即拉一次，然后按间隔轮询
    get().fetchProactiveInsights();
    // 使用 () => get().fetchProactiveInsights() 避免捕获旧引用（防御性模式）
    const timer = setInterval(() => get().fetchProactiveInsights(), INSIGHT_POLL_MS);
    set({ _insightPollTimer: timer });
  },

  stopInsightPolling: () => {
    const { _insightPollTimer } = get();
    if (_insightPollTimer) {
      clearInterval(_insightPollTimer);
      set({ _insightPollTimer: null });
    }
  },
}));
