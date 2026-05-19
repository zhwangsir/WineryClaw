import { create } from "zustand";
import { systemApi } from "../api/system";
import { configApi } from "../api/config";
import { StorageAdapter } from "../utils/storage";
import type { SystemHealth, Notification, ModelHealth } from "../api/types";

const THEME_KEY = "webrain-theme";
const STALE_MS = 30000;

interface SystemState {
  health: SystemHealth | null;
  modelHealth: ModelHealth | null;
  loading: boolean;
  error: Error | null;
  theme: "light" | "dark";
  lastHealthUpdate: number;
  notifications: Notification[];

  fetchHealth: () => Promise<void>;
  fetchModelHealth: () => Promise<void>;
  setTheme: (t: "light" | "dark") => void;
  toggleTheme: () => void;
  markNotificationRead: (id: string) => void;
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
  },
}));
