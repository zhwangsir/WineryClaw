/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import EcosystemPage from "./EcosystemPage";

const fetchResources = vi.fn();
const register = vi.fn();
const deleteResource = vi.fn();

function createMockStore(overrides: any = {}) {
  return {
    resources: [
      {
        id: "r1",
        name: "Res1",
        type: "agent",
        owner: "system",
        sharedWith: ["team"],
        createdAt: "2024-01-01T00:00:00Z",
      },
      { id: "r2", name: "Res2", type: "tool", owner: "user", sharedWith: [], createdAt: "2024-01-02T00:00:00Z" },
    ],
    loading: false,
    fetchResources,
    register,
    deleteResource,
    ...overrides,
  };
}

vi.mock("../stores/ecosystemStore", () => ({
  useEcosystemStore: vi.fn(() => createMockStore()),
}));

import { useEcosystemStore } from "../stores/ecosystemStore";

vi.mock("antd", async () => {
  const actual = await vi.importActual<typeof import("antd")>("antd");
  return {
    ...actual,
    Popconfirm: ({ children, onConfirm }: any) => (
      <div data-testid="popconfirm" onClick={onConfirm}>
        {children}
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

describe("EcosystemPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useEcosystemStore).mockImplementation(() => createMockStore() as any);
  });

  it("renders page shell", () => {
    render(
      <BrowserRouter>
        <EcosystemPage />
      </BrowserRouter>
    );
    expect(screen.getByText("生态")).toBeInTheDocument();
  });

  it("fetches resources on mount", () => {
    render(
      <BrowserRouter>
        <EcosystemPage />
      </BrowserRouter>
    );
    expect(fetchResources).toHaveBeenCalled();
  });

  it("renders resources table", () => {
    render(
      <BrowserRouter>
        <EcosystemPage />
      </BrowserRouter>
    );
    expect(screen.getByText("Res1")).toBeInTheDocument();
    expect(screen.getByText("Res2")).toBeInTheDocument();
    expect(screen.getByText("team")).toBeInTheDocument();
  });

  it("shows empty state when no resources", () => {
    vi.mocked(useEcosystemStore).mockImplementation(() => createMockStore({ resources: [] }) as any);
    render(
      <BrowserRouter>
        <EcosystemPage />
      </BrowserRouter>
    );
    expect(screen.getByText("暂无资源")).toBeInTheDocument();
  });

  it("opens register drawer and submits", async () => {
    register.mockResolvedValue(undefined);
    render(
      <BrowserRouter>
        <EcosystemPage />
      </BrowserRouter>
    );
    fireEvent.click(screen.getByText("注册资源"));
    expect(document.querySelector(".ant-drawer")).toBeTruthy();

    const nameInput = screen.getByPlaceholderText("资源名称");
    fireEvent.change(nameInput, { target: { value: "NewRes" } });

    const select = document.querySelector("select") as HTMLSelectElement;
    if (select) fireEvent.change(select, { target: { value: "agent" } });

    const submitBtn = document.querySelector('button[type="submit"]');
    expect(submitBtn).toBeTruthy();
    if (submitBtn) fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(register).toHaveBeenCalledWith(expect.objectContaining({ name: "NewRes", owner: "system" }));
    });
  });

  it("deletes resource on confirm", () => {
    render(
      <BrowserRouter>
        <EcosystemPage />
      </BrowserRouter>
    );
    const popconfirms = screen.getAllByTestId("popconfirm");
    if (popconfirms.length > 0) {
      fireEvent.click(popconfirms[0]);
      expect(deleteResource).toHaveBeenCalledWith("r1");
    }
  });

  it("submits register form without owner", async () => {
    register.mockResolvedValue(undefined);
    render(
      <BrowserRouter>
        <EcosystemPage />
      </BrowserRouter>
    );
    fireEvent.click(screen.getByText("注册资源"));

    const nameInput = screen.getByPlaceholderText("资源名称");
    fireEvent.change(nameInput, { target: { value: "NoOwner" } });

    const select = document.querySelector("select") as HTMLSelectElement;
    if (select) fireEvent.change(select, { target: { value: "agent" } });

    const submitBtn = document.querySelector('button[type="submit"]');
    expect(submitBtn).toBeTruthy();
    if (submitBtn) fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(register).toHaveBeenCalledWith(expect.objectContaining({ name: "NoOwner", owner: "system" }));
    });
  });
});
