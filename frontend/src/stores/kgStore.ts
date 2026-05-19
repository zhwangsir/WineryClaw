import { create } from "zustand";
import { message } from "antd";
import { kgApi } from "../api/kg";
import type { KgEntity } from "../api/types";
import { createOptimisticDelete } from "./utils";

interface KgState {
  entities: KgEntity[];
  selectedEntity: KgEntity | null;
  entityRelations: Array<{ target: string; relation: string; confidence?: number }>;
  relations: Array<{ id: string; source: string; target: string; type: string; confidence: number }>;
  stats: Record<string, number>;
  loading: boolean;
  error: Error | null;

  fetchEntities: () => Promise<void>;
  fetchRelations: () => Promise<void>;
  fetchStats: () => Promise<void>;
  selectEntity: (id: string) => void;
  search: (query: string) => Promise<void>;
  addEntity: (entity: Omit<KgEntity, "id">) => Promise<void>;
  addRelation: (relation: { source: string; target: string; type: string; confidence?: number }) => Promise<void>;
  deleteEntity: (id: string) => Promise<void>;
  deleteRelation: (id: string) => Promise<void>;
}

export const useKgStore = create<KgState>((set, get) => ({
  entities: [],
  selectedEntity: null,
  entityRelations: [],
  relations: [],
  stats: {},
  loading: false,
  error: null,

  fetchEntities: async () => {
    if (get().loading) return;

    set({ loading: true, error: null });
    try {
      const list = await kgApi.listEntities();
      set({ entities: list, loading: false, error: null });
    } catch (e: any) {
      message.error(e.message || "获取实体失败");
      set({ loading: false, error: e });
    }
  },

  fetchRelations: async () => {
    if (get().loading) return;

    set({ loading: true, error: null });
    try {
      const entities = await kgApi.listEntities();
      const relations: KgState["relations"] = [];
      for (const e of entities) {
        const detail = await kgApi.getEntity(e.id);
        if (detail.relations) {
          detail.relations.forEach((r: any, idx: number) => {
            relations.push({
              id: `${e.id}-${idx}`,
              source: e.id,
              target: r.target_id || r.target || "",
              type: r.type || r.relation || "",
              confidence: r.confidence ?? 1.0,
            });
          });
        }
      }
      set({ relations, loading: false, error: null });
    } catch (e: any) {
      message.error(e.message || "获取关系失败");
      set({ loading: false, error: e });
    }
  },

  fetchStats: async () => {
    try {
      const data = await kgApi.stats();
      set({ stats: data as Record<string, number> });
    } catch (e: any) {
      console.error("[kgStore] fetchStats failed:", e.message);
      set({ loading: false, error: e });
    }
  },

  selectEntity: (id) => {
    const entity = get().entities.find((e) => e.id === id) || null;
    set({ selectedEntity: entity });
  },

  search: async (query) => {
    set({ loading: true, error: null });
    try {
      const results = await kgApi.search(query);
      set({ entities: results as KgEntity[], loading: false, error: null });
    } catch (e: any) {
      message.error(e.message || "搜索失败");
      set({ loading: false, error: e });
    }
  },

  addEntity: async (entity) => {
    try {
      await kgApi.addEntity(entity);
      message.success("实体已添加");
      await get().fetchEntities();
    } catch (e: any) {
      message.error(e.message || "添加实体失败");
    }
  },

  addRelation: async (relation) => {
    try {
      await kgApi.addRelation({
        source_id: relation.source,
        target_id: relation.target,
        type: relation.type,
        confidence: relation.confidence ?? 1.0,
      });
      message.success("关系已添加");
      await get().fetchRelations();
      await get().fetchEntities();
    } catch (e: any) {
      message.error(e.message || "添加关系失败");
    }
  },

  deleteEntity: createOptimisticDelete<KgEntity>(
    get,
    set,
    "entities",
    kgApi.deleteEntity,
    {
      successMsg: "实体已删除",
      errorMsg: "删除实体失败",
      extraUpdate: (id) => ({
        selectedEntity: get().selectedEntity?.id === id ? null : get().selectedEntity,
      }),
      onSuccess: () => get().fetchRelations(),
    }
  ),

  deleteRelation: createOptimisticDelete<{ id: string }>(
    get,
    set,
    "relations",
    kgApi.deleteRelation,
    { successMsg: "关系已删除", errorMsg: "删除关系失败", onSuccess: () => get().fetchRelations() }
  ),
}));
