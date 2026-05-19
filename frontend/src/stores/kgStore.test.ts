import { describe, it, expect, vi, beforeEach } from "vitest";
import { useKgStore } from "./kgStore";

vi.mock("../api/kg", () => ({
  kgApi: {
    listEntities: vi.fn(),
    getEntity: vi.fn(),
    addEntity: vi.fn(),
    addRelation: vi.fn(),
    deleteEntity: vi.fn(),
    deleteRelation: vi.fn(),
    search: vi.fn(),
    stats: vi.fn(),
  },
}));

vi.mock("antd", () => ({
  message: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { kgApi } from "../api/kg";
import { message } from "antd";

describe("kgStore", () => {
  beforeEach(() => {
    useKgStore.setState({
      entities: [],
      selectedEntity: null,
      entityRelations: [],
      relations: [],
      stats: {},
      loading: false,
      error: null,
    });
    vi.clearAllMocks();
  });

  it("has correct initial state", () => {
    const state = useKgStore.getState();
    expect(state.entities).toEqual([]);
    expect(state.selectedEntity).toBeNull();
  });

  it("fetchEntities loads entities", async () => {
    vi.mocked(kgApi.listEntities).mockResolvedValue([{ id: "e1", name: "Entity1" }]);
    await useKgStore.getState().fetchEntities();
    expect(useKgStore.getState().entities).toHaveLength(1);
    expect(useKgStore.getState().loading).toBe(false);
  });

  it("fetchEntities skips when loading", async () => {
    useKgStore.setState({ loading: true });
    await useKgStore.getState().fetchEntities();
    expect(kgApi.listEntities).not.toHaveBeenCalled();
  });

  it("fetchEntities handles errors", async () => {
    vi.mocked(kgApi.listEntities).mockRejectedValue(new Error("fail"));
    await useKgStore.getState().fetchEntities();
    expect(useKgStore.getState().loading).toBe(false);
  });

  it("fetch handles errors without message", async () => {
    vi.mocked(kgApi.listEntities).mockRejectedValue({});
    await useKgStore.getState().fetchEntities();
    expect(message.error).toHaveBeenCalledWith("获取实体失败");
  });

  it("fetchRelations builds relation list", async () => {
    vi.mocked(kgApi.listEntities).mockResolvedValue([{ id: "e1", name: "E1" }]);
    vi.mocked(kgApi.getEntity).mockResolvedValue({
      relations: [{ target_id: "e2", type: "related", confidence: 0.9 }],
    });
    await useKgStore.getState().fetchRelations();
    expect(useKgStore.getState().relations).toHaveLength(1);
    expect(useKgStore.getState().relations[0].target).toBe("e2");
  });

  it("fetchRelations handles entity without relations", async () => {
    vi.mocked(kgApi.listEntities).mockResolvedValue([{ id: "e1", name: "E1" }]);
    vi.mocked(kgApi.getEntity).mockResolvedValue({});
    await useKgStore.getState().fetchRelations();
    expect(useKgStore.getState().relations).toHaveLength(0);
  });

  it("fetchRelations falls back relation fields", async () => {
    vi.mocked(kgApi.listEntities).mockResolvedValue([{ id: "e1", name: "E1" }]);
    vi.mocked(kgApi.getEntity).mockResolvedValue({
      relations: [{ target: "e2", relation: "linked" }],
    });
    await useKgStore.getState().fetchRelations();
    expect(useKgStore.getState().relations[0].target).toBe("e2");
    expect(useKgStore.getState().relations[0].type).toBe("linked");
  });

  it("fetchRelations falls back to empty strings", async () => {
    vi.mocked(kgApi.listEntities).mockResolvedValue([{ id: "e1", name: "E1" }]);
    vi.mocked(kgApi.getEntity).mockResolvedValue({
      relations: [{}],
    });
    await useKgStore.getState().fetchRelations();
    expect(useKgStore.getState().relations[0].target).toBe("");
    expect(useKgStore.getState().relations[0].type).toBe("");
  });

  it("fetchRelations handles error without message", async () => {
    vi.mocked(kgApi.listEntities).mockRejectedValue(new Error(""));
    await useKgStore.getState().fetchRelations();
    expect(message.error).toHaveBeenCalledWith("获取关系失败");
  });

  it("fetchRelations handles errors", async () => {
    vi.mocked(kgApi.listEntities).mockRejectedValue(new Error("fail"));
    await useKgStore.getState().fetchRelations();
    expect(useKgStore.getState().loading).toBe(false);
  });

  it("fetchStats sets stats", async () => {
    vi.mocked(kgApi.stats).mockResolvedValue({ count: 5 });
    await useKgStore.getState().fetchStats();
    expect(useKgStore.getState().stats).toEqual({ count: 5 });
  });

  it("fetchStats handles errors", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(kgApi.stats).mockRejectedValue(new Error("fail"));
    await useKgStore.getState().fetchStats();
    expect(useKgStore.getState().loading).toBe(false);
    consoleSpy.mockRestore();
  });

  it("selectEntity sets selected", () => {
    useKgStore.setState({ entities: [{ id: "e1", name: "E1" }] });
    useKgStore.getState().selectEntity("e1");
    expect(useKgStore.getState().selectedEntity).toEqual({ id: "e1", name: "E1" });
  });

  it("selectEntity returns null when not found", () => {
    useKgStore.setState({ entities: [{ id: "e1", name: "E1" }] });
    useKgStore.getState().selectEntity("e2");
    expect(useKgStore.getState().selectedEntity).toBeNull();
  });

  it("search sets results", async () => {
    vi.mocked(kgApi.search).mockResolvedValue([{ id: "e1", name: "Result" }]);
    await useKgStore.getState().search("q");
    expect(useKgStore.getState().entities).toHaveLength(1);
  });

  it("search handles errors", async () => {
    vi.mocked(kgApi.search).mockRejectedValue(new Error("fail"));
    await useKgStore.getState().search("q");
    expect(useKgStore.getState().loading).toBe(false);
  });

  it("search handles error without message", async () => {
    vi.mocked(kgApi.search).mockRejectedValue(new Error(""));
    await useKgStore.getState().search("q");
    expect(message.error).toHaveBeenCalledWith("搜索失败");
  });

  it("addEntity succeeds and refetches", async () => {
    vi.mocked(kgApi.addEntity).mockResolvedValue(undefined);
    vi.mocked(kgApi.listEntities).mockResolvedValue([]);
    await useKgStore.getState().addEntity({ name: "E1" } as any);
    expect(message.success).toHaveBeenCalledWith("实体已添加");
  });

  it("addEntity handles errors", async () => {
    vi.mocked(kgApi.addEntity).mockRejectedValue(new Error("fail"));
    await useKgStore.getState().addEntity({} as any);
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("addEntity handles error without message", async () => {
    vi.mocked(kgApi.addEntity).mockRejectedValue(new Error(""));
    await useKgStore.getState().addEntity({} as any);
    expect(message.error).toHaveBeenCalledWith("添加实体失败");
  });

  it("addRelation succeeds and refetches", async () => {
    vi.mocked(kgApi.addRelation).mockResolvedValue(undefined);
    vi.mocked(kgApi.listEntities).mockResolvedValue([]);
    await useKgStore.getState().addRelation({ source: "e1", target: "e2", type: "related" });
    expect(message.success).toHaveBeenCalledWith("关系已添加");
  });

  it("addRelation handles errors", async () => {
    vi.mocked(kgApi.addRelation).mockRejectedValue(new Error("fail"));
    await useKgStore.getState().addRelation({ source: "", target: "", type: "" });
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("addRelation handles error without message", async () => {
    vi.mocked(kgApi.addRelation).mockRejectedValue(new Error(""));
    await useKgStore.getState().addRelation({ source: "", target: "", type: "" });
    expect(message.error).toHaveBeenCalledWith("添加关系失败");
  });

  it("deleteEntity removes item optimistically", async () => {
    useKgStore.setState({ entities: [{ id: "e1" }, { id: "e2" }] });
    vi.mocked(kgApi.deleteEntity).mockResolvedValue(undefined);
    await useKgStore.getState().deleteEntity("e1");
    expect(useKgStore.getState().entities).toHaveLength(1);
  });

  it("deleteEntity clears selected if matching", async () => {
    useKgStore.setState({ entities: [{ id: "e1" }], selectedEntity: { id: "e1" } as any });
    vi.mocked(kgApi.deleteEntity).mockResolvedValue(undefined);
    await useKgStore.getState().deleteEntity("e1");
    expect(useKgStore.getState().selectedEntity).toBeNull();
  });

  it("deleteEntity rolls back on error", async () => {
    useKgStore.setState({ entities: [{ id: "e1" }] });
    vi.mocked(kgApi.deleteEntity).mockRejectedValue(new Error("fail"));
    await useKgStore.getState().deleteEntity("e1");
    expect(useKgStore.getState().entities).toHaveLength(1);
  });

  it("deleteRelation removes item optimistically", async () => {
    useKgStore.setState({ relations: [{ id: "r1" } as any] });
    vi.mocked(kgApi.deleteRelation).mockResolvedValue(undefined);
    await useKgStore.getState().deleteRelation("r1");
    expect(useKgStore.getState().relations).toHaveLength(0);
  });

  it("deleteRelation rolls back on error", async () => {
    useKgStore.setState({ relations: [{ id: "r1" } as any] });
    vi.mocked(kgApi.deleteRelation).mockRejectedValue(new Error("fail"));
    await useKgStore.getState().deleteRelation("r1");
    expect(useKgStore.getState().relations).toHaveLength(1);
  });
});
