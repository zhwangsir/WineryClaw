import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTemplateStore } from "./templateStore";

vi.mock("../api/templates", () => ({
  templatesApi: {
    list: vi.fn(),
    categories: vi.fn(),
    tags: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    instantiate: vi.fn(),
  },
}));

vi.mock("antd", () => ({
  message: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { templatesApi } from "../api/templates";
import { message } from "antd";

describe("templateStore", () => {
  beforeEach(() => {
    useTemplateStore.setState({ templates: [], categories: [], tags: [], loading: false, error: null });
    vi.clearAllMocks();
  });

  it("has correct initial state", () => {
    const state = useTemplateStore.getState();
    expect(state.templates).toEqual([]);
    expect(state.categories).toEqual([]);
  });

  it("fetchTemplates loads templates", async () => {
    vi.mocked(templatesApi.list).mockResolvedValue([{ id: "t1" }]);
    await useTemplateStore.getState().fetchTemplates();
    expect(useTemplateStore.getState().templates).toHaveLength(1);
    expect(useTemplateStore.getState().loading).toBe(false);
  });

  it("fetchTemplates with filters", async () => {
    vi.mocked(templatesApi.list).mockResolvedValue([{ id: "t1" }]);
    await useTemplateStore.getState().fetchTemplates("dev", "ai");
    expect(templatesApi.list).toHaveBeenCalledWith("dev", "ai");
  });

  it("fetchTemplates handles errors", async () => {
    vi.mocked(templatesApi.list).mockRejectedValue(new Error("fail"));
    await useTemplateStore.getState().fetchTemplates();
    expect(useTemplateStore.getState().loading).toBe(false);
  });

  it("fetch handles errors without message", async () => {
    vi.mocked(templatesApi.list).mockRejectedValue({});
    await useTemplateStore.getState().fetchTemplates();
    expect(message.error).toHaveBeenCalledWith("获取模板失败");
  });

  it("fetchCategories sets categories", async () => {
    vi.mocked(templatesApi.categories).mockResolvedValue(["dev", "ops"]);
    await useTemplateStore.getState().fetchCategories();
    expect(useTemplateStore.getState().categories).toEqual(["dev", "ops"]);
  });

  it("fetchCategories handles errors", async () => {
    vi.mocked(templatesApi.categories).mockRejectedValue(new Error("fail"));
    await useTemplateStore.getState().fetchCategories();
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("fetchCategories handles error without message", async () => {
    vi.mocked(templatesApi.categories).mockRejectedValue(new Error(""));
    await useTemplateStore.getState().fetchCategories();
    expect(message.error).toHaveBeenCalledWith("获取分类失败");
  });

  it("fetchTags sets tags", async () => {
    vi.mocked(templatesApi.tags).mockResolvedValue(["ai", "web"]);
    await useTemplateStore.getState().fetchTags();
    expect(useTemplateStore.getState().tags).toEqual(["ai", "web"]);
  });

  it("fetchTags handles errors", async () => {
    vi.mocked(templatesApi.tags).mockRejectedValue(new Error("fail"));
    await useTemplateStore.getState().fetchTags();
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("fetchTags handles error without message", async () => {
    vi.mocked(templatesApi.tags).mockRejectedValue(new Error(""));
    await useTemplateStore.getState().fetchTags();
    expect(message.error).toHaveBeenCalledWith("获取标签失败");
  });

  it("createTemplate succeeds and refetches", async () => {
    vi.mocked(templatesApi.create).mockResolvedValue(undefined);
    vi.mocked(templatesApi.list).mockResolvedValue([]);
    await useTemplateStore.getState().createTemplate({ name: "T1" });
    expect(message.success).toHaveBeenCalledWith("模板创建成功");
  });

  it("createTemplate handles errors", async () => {
    vi.mocked(templatesApi.create).mockRejectedValue(new Error("fail"));
    await useTemplateStore.getState().createTemplate({});
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("createTemplate handles error without message", async () => {
    vi.mocked(templatesApi.create).mockRejectedValue(new Error(""));
    await useTemplateStore.getState().createTemplate({});
    expect(message.error).toHaveBeenCalledWith("创建模板失败");
  });

  it("deleteTemplate succeeds and refetches", async () => {
    vi.mocked(templatesApi.delete).mockResolvedValue(undefined);
    vi.mocked(templatesApi.list).mockResolvedValue([]);
    await useTemplateStore.getState().deleteTemplate("t1");
    expect(message.success).toHaveBeenCalledWith("模板已删除");
  });

  it("deleteTemplate handles errors", async () => {
    vi.mocked(templatesApi.delete).mockRejectedValue(new Error("fail"));
    await useTemplateStore.getState().deleteTemplate("t1");
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("deleteTemplate handles error without message", async () => {
    vi.mocked(templatesApi.delete).mockRejectedValue(new Error(""));
    await useTemplateStore.getState().deleteTemplate("t1");
    expect(message.error).toHaveBeenCalledWith("删除模板失败");
  });

  it("instantiate returns agent on success", async () => {
    vi.mocked(templatesApi.instantiate).mockResolvedValue({ id: "a1", name: "Agent1" });
    const result = await useTemplateStore.getState().instantiate("t1", { name: "Agent1" });
    expect(result).toEqual({ id: "a1", name: "Agent1" });
    expect(message.success).toHaveBeenCalledWith('智能体 "Agent1" 创建成功');
  });

  it("instantiate handles errors", async () => {
    vi.mocked(templatesApi.instantiate).mockRejectedValue(new Error("fail"));
    const result = await useTemplateStore.getState().instantiate("t1", { name: "Agent1" });
    expect(result).toBeUndefined();
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("instantiate handles error without message", async () => {
    vi.mocked(templatesApi.instantiate).mockRejectedValue(new Error(""));
    const result = await useTemplateStore.getState().instantiate("t1", { name: "Agent1" });
    expect(result).toBeUndefined();
    expect(message.error).toHaveBeenCalledWith("实例化失败");
  });
});
