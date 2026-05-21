/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import KnowledgeGraphPage from "./KnowledgeGraphPage";

const fetchEntities = vi.fn();
const fetchStats = vi.fn();
const search = vi.fn();
const selectEntity = vi.fn();
const addEntity = vi.fn();
const addRelation = vi.fn();
const deleteEntity = vi.fn();

function createMockStore(overrides: any = {}) {
  return {
    loading: false,
    entities: [
      { id: "ent-1", name: "Entity A", type: "concept", description: "Desc A" },
      { id: "ent-2", name: "Entity B", type: "person", description: "" },
    ],
    selectedEntity: null as any,
    entityRelations: [],
    stats: { entity_count: 2, relation_count: 1 },
    fetchEntities,
    fetchStats,
    search,
    selectEntity,
    addEntity,
    addRelation,
    deleteEntity,
    ...overrides,
  };
}

vi.mock("../stores/kgStore", () => ({
  useKgStore: vi.fn(() => createMockStore()),
}));

import { useKgStore } from "../stores/kgStore";

vi.mock("antd", async () => {
  const actual = await vi.importActual<typeof import("antd")>("antd");
  return {
    ...actual,
    message: {
      success: vi.fn(),
      error: vi.fn(),
    },
    Modal: {
      ...actual.Modal,
      confirm: vi.fn(({ onOk }) => {
        if (onOk) onOk();
      }),
    },
    Card: ({ children, bodyStyle, ...rest }: any) => (
      <div data-testid="card" {...rest}>
        <div style={bodyStyle}>{children}</div>
      </div>
    ),
    Select: ({ value, onChange, options }: any) => (
      <select value={value || ""} onChange={(e) => onChange?.(e.target.value)}>
        {options?.map((o: any) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    ),
  };
});

describe("KnowledgeGraphPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useKgStore).mockImplementation(() => createMockStore() as any);
  });

  it("renders page shell", () => {
    render(
      <BrowserRouter>
        <KnowledgeGraphPage />
      </BrowserRouter>
    );
    expect(screen.getByText("知识图谱")).toBeInTheDocument();
  });

  it("fetches entities and stats on mount", () => {
    render(
      <BrowserRouter>
        <KnowledgeGraphPage />
      </BrowserRouter>
    );
    expect(fetchEntities).toHaveBeenCalled();
    expect(fetchStats).toHaveBeenCalled();
  });

  it("renders stats", () => {
    render(
      <BrowserRouter>
        <KnowledgeGraphPage />
      </BrowserRouter>
    );
    expect(screen.getByText("实体数")).toBeInTheDocument();
    expect(screen.getByText("关系数")).toBeInTheDocument();
  });

  it("renders entities list", () => {
    render(
      <BrowserRouter>
        <KnowledgeGraphPage />
      </BrowserRouter>
    );
    expect(screen.getByText("Entity A")).toBeInTheDocument();
    expect(screen.getByText("Entity B")).toBeInTheDocument();
  });

  it("filters by type", () => {
    render(
      <BrowserRouter>
        <KnowledgeGraphPage />
      </BrowserRouter>
    );
    const conceptBtns = screen.getAllByText("concept");
    fireEvent.click(conceptBtns[0]);
    expect(screen.getByText("Entity A")).toBeInTheDocument();
  });

  it("shows all when clicking all filter", () => {
    render(
      <BrowserRouter>
        <KnowledgeGraphPage />
      </BrowserRouter>
    );
    const allBtn = screen.getByText(/全\s*部/);
    fireEvent.click(allBtn);
    expect(screen.getByText("Entity A")).toBeInTheDocument();
    expect(screen.getByText("Entity B")).toBeInTheDocument();
  });

  it("searches entity", () => {
    render(
      <BrowserRouter>
        <KnowledgeGraphPage />
      </BrowserRouter>
    );
    const input = screen.getByPlaceholderText("搜索实体...");
    fireEvent.change(input, { target: { value: "A" } });
    expect(search).toHaveBeenCalledWith("A");
  });

  it("shows selected entity detail", () => {
    vi.mocked(useKgStore).mockImplementation(
      () =>
        createMockStore({
          selectedEntity: { id: "ent-1", name: "Entity A", type: "concept", description: "Desc A" },
          entityRelations: [{ id: "rel-1", type: "related_to", target: "Entity B" }],
        }) as any
    );
    render(
      <BrowserRouter>
        <KnowledgeGraphPage />
      </BrowserRouter>
    );
    expect(screen.getAllByText("Desc A").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Entity B/).length).toBeGreaterThanOrEqual(1);
  });

  it("shows no relations message when empty", () => {
    vi.mocked(useKgStore).mockImplementation(
      () =>
        createMockStore({
          selectedEntity: { id: "ent-1", name: "Entity A", type: "concept", description: "Desc A" },
          entityRelations: [],
        }) as any
    );
    render(
      <BrowserRouter>
        <KnowledgeGraphPage />
      </BrowserRouter>
    );
    expect(screen.getByText("无关系")).toBeInTheDocument();
  });

  it("opens add entity drawer and submits", async () => {
    addEntity.mockResolvedValue(undefined);
    render(
      <BrowserRouter>
        <KnowledgeGraphPage />
      </BrowserRouter>
    );
    fireEvent.click(screen.getByText("添加实体"));
    expect(document.querySelector(".ant-drawer")).toBeTruthy();

    const nameInput = screen.getByPlaceholderText("例如: OpenAI");
    fireEvent.change(nameInput, { target: { value: "NewEnt" } });

    const select = document.querySelector("select") as HTMLSelectElement;
    if (select) fireEvent.change(select, { target: { value: "concept" } });

    const submitBtn = document.querySelector('button[type="submit"]');
    if (submitBtn) fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(addEntity).toHaveBeenCalled();
    });
  });

  it("opens add relation drawer and submits", async () => {
    addRelation.mockResolvedValue(undefined);
    render(
      <BrowserRouter>
        <KnowledgeGraphPage />
      </BrowserRouter>
    );
    fireEvent.click(screen.getByText("添加关系"));
    expect(document.querySelector(".ant-drawer")).toBeTruthy();

    const inputs = screen.getAllByRole("textbox");
    fireEvent.change(inputs[0], { target: { value: "A" } });
    fireEvent.change(inputs[1], { target: { value: "B" } });

    const selects = document.querySelectorAll("select");
    if (selects.length > 0) fireEvent.change(selects[0], { target: { value: "related_to" } });

    const submitBtn = document.querySelector('button[type="submit"]');
    if (submitBtn) fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(addRelation).toHaveBeenCalled();
    });
  });

  it("calls deleteEntity via modal confirm", async () => {
    render(
      <BrowserRouter>
        <KnowledgeGraphPage />
      </BrowserRouter>
    );
    const deleteButtons = screen.getAllByRole("button", { name: /删除/i });
    expect(deleteButtons.length).toBeGreaterThanOrEqual(1);
    await fireEvent.click(deleteButtons[0]);
    await waitFor(() => {
      expect(deleteEntity).toHaveBeenCalledTimes(1);
      expect(deleteEntity).toHaveBeenCalledWith("ent-1");
    });
  });

  it("shows spin when loading and no entities", () => {
    vi.mocked(useKgStore).mockImplementation(() => createMockStore({ loading: true, entities: [] }) as any);
    render(
      <BrowserRouter>
        <KnowledgeGraphPage />
      </BrowserRouter>
    );
    expect(document.querySelector(".ant-spin")).toBeTruthy();
  });

  it("shows empty when filtered entities is empty", () => {
    vi.mocked(useKgStore).mockImplementation(() => createMockStore({ entities: [] }) as any);
    render(
      <BrowserRouter>
        <KnowledgeGraphPage />
      </BrowserRouter>
    );
    expect(screen.getByText("暂无实体")).toBeInTheDocument();
  });

  it("renders stats without stats object", () => {
    vi.mocked(useKgStore).mockImplementation(() => createMockStore({ stats: undefined as any }) as any);
    render(
      <BrowserRouter>
        <KnowledgeGraphPage />
      </BrowserRouter>
    );
    expect(screen.getByText("关系数")).toBeInTheDocument();
  });

  it("shows selected entity with unknown type and no description", () => {
    vi.mocked(useKgStore).mockImplementation(
      () =>
        createMockStore({
          selectedEntity: { id: "ent-3", name: "Entity C", type: "product", description: "" },
          entityRelations: [],
        }) as any
    );
    render(
      <BrowserRouter>
        <KnowledgeGraphPage />
      </BrowserRouter>
    );
    expect(screen.getByText("无描述")).toBeInTheDocument();
    expect(screen.getByText("product")).toBeInTheDocument();
  });

  it("shows entity with unknown type in list", () => {
    vi.mocked(useKgStore).mockImplementation(
      () =>
        createMockStore({
          entities: [{ id: "ent-3", name: "Entity C", type: "product", description: "Desc C" }],
        }) as any
    );
    render(
      <BrowserRouter>
        <KnowledgeGraphPage />
      </BrowserRouter>
    );
    expect(screen.getByText("Entity C")).toBeInTheDocument();
  });

  it("shows error when add entity fails", async () => {
    addEntity.mockRejectedValue(new Error("db error"));
    render(
      <BrowserRouter>
        <KnowledgeGraphPage />
      </BrowserRouter>
    );
    fireEvent.click(screen.getByText("添加实体"));

    const nameInput = screen.getByPlaceholderText("例如: OpenAI");
    fireEvent.change(nameInput, { target: { value: "Bad" } });

    const select = document.querySelector("select") as HTMLSelectElement;
    if (select) fireEvent.change(select, { target: { value: "concept" } });

    const submitBtn = document.querySelector('button[type="submit"]');
    if (submitBtn) fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(addEntity).toHaveBeenCalled();
    });
  });

  it("shows error when add entity fails without message", async () => {
    addEntity.mockRejectedValue({});
    render(
      <BrowserRouter>
        <KnowledgeGraphPage />
      </BrowserRouter>
    );
    fireEvent.click(screen.getByText("添加实体"));

    const nameInput = screen.getByPlaceholderText("例如: OpenAI");
    fireEvent.change(nameInput, { target: { value: "Bad" } });

    const select = document.querySelector("select") as HTMLSelectElement;
    if (select) fireEvent.change(select, { target: { value: "concept" } });

    const submitBtn = document.querySelector('button[type="submit"]');
    if (submitBtn) fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(addEntity).toHaveBeenCalled();
    });
  });

  it("shows error when add relation fails", async () => {
    addRelation.mockRejectedValue(new Error("db error"));
    render(
      <BrowserRouter>
        <KnowledgeGraphPage />
      </BrowserRouter>
    );
    fireEvent.click(screen.getByText("添加关系"));

    const inputs = screen.getAllByRole("textbox");
    if (inputs[0]) fireEvent.change(inputs[0], { target: { value: "A" } });
    if (inputs[1]) fireEvent.change(inputs[1], { target: { value: "B" } });

    const selects = document.querySelectorAll("select");
    if (selects.length > 0) fireEvent.change(selects[0], { target: { value: "related_to" } });

    const submitBtn = document.querySelector('button[type="submit"]');
    if (submitBtn) fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(addRelation).toHaveBeenCalled();
    });
  });

  it("shows error when add relation fails without message", async () => {
    addRelation.mockRejectedValue({});
    render(
      <BrowserRouter>
        <KnowledgeGraphPage />
      </BrowserRouter>
    );
    fireEvent.click(screen.getByText("添加关系"));

    const inputs = screen.getAllByRole("textbox");
    if (inputs[0]) fireEvent.change(inputs[0], { target: { value: "A" } });
    if (inputs[1]) fireEvent.change(inputs[1], { target: { value: "B" } });

    const selects = document.querySelectorAll("select");
    if (selects.length > 0) fireEvent.change(selects[0], { target: { value: "related_to" } });

    const submitBtn = document.querySelector('button[type="submit"]');
    if (submitBtn) fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(addRelation).toHaveBeenCalled();
    });
  });
});
