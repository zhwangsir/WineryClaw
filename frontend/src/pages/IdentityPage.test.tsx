/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import IdentityPage from "./IdentityPage";
import { useIdentityStore } from "../stores/identityStore";

const fetchUsers = vi.fn();
const createUser = vi.fn().mockResolvedValue(undefined);
const deleteUser = vi.fn().mockResolvedValue(undefined);

const defaultMock = {
  loading: false,
  data: null,
  users: [
    { id: "user-1", name: "Test User", role: "user", workspaces: ["ws-1"], createdAt: "2024-01-01T00:00:00Z" },
    { id: "user-2", name: "Admin User", role: "admin", workspaces: [], createdAt: "2024-01-02T00:00:00Z" },
  ],
  workspaces: [],
  fetchUsers,
  createUser,
  deleteUser,
};

vi.mock("../stores/identityStore", () => ({
  useIdentityStore: vi.fn(() => defaultMock),
}));

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
  };
});

describe("IdentityPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useIdentityStore).mockReturnValue({ ...defaultMock, users: [...defaultMock.users] });
  });

  const renderPage = () =>
    render(
      <BrowserRouter>
        <IdentityPage />
      </BrowserRouter>
    );

  it("renders page shell", () => {
    renderPage();
    expect(screen.getByText("身份")).toBeInTheDocument();
  });

  it("calls fetchUsers on mount", () => {
    renderPage();
    expect(fetchUsers).toHaveBeenCalled();
  });

  it("shows empty state when no users", () => {
    vi.mocked(useIdentityStore).mockReturnValue({ ...defaultMock, users: [] });
    renderPage();
    expect(screen.getByText("暂无用户")).toBeInTheDocument();
  });

  it("renders users with role tags", () => {
    renderPage();
    expect(screen.getByText("Test User")).toBeInTheDocument();
    expect(screen.getByText("Admin User")).toBeInTheDocument();
    expect(screen.getByText("user")).toBeInTheDocument();
    expect(screen.getByText("admin")).toBeInTheDocument();
  });

  it("renders workspace tags", () => {
    renderPage();
    expect(screen.getByText("ws-1")).toBeInTheDocument();
  });

  it("opens create drawer and submits", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /新建用户/i }));
    expect(document.querySelector(".ant-drawer")).toBeInTheDocument();

    const nameInput = screen.getByPlaceholderText("用户名称") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "NewUser" } });

    const roleSelect = document.querySelector(".ant-select-selection-search-input") as HTMLInputElement;
    if (roleSelect) {
      fireEvent.mouseDown(roleSelect);
      const option = document.querySelector(".ant-select-item-option-content") as HTMLElement;
      if (option) fireEvent.click(option);
    }

    const wsInput = document.querySelectorAll("input")[2] as HTMLInputElement;
    if (wsInput) fireEvent.change(wsInput, { target: { value: "default, dev" } });

    const submitBtn = document.querySelector('.ant-drawer button[type="submit"]') as HTMLButtonElement;
    if (submitBtn) fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(createUser).toHaveBeenCalledWith(
        expect.objectContaining({ name: "NewUser", workspaces: ["default", "dev"] })
      );
    });
  });

  it("creates user without workspaces", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /新建用户/i }));

    const nameInput = screen.getByPlaceholderText("用户名称") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "NoWsUser" } });

    const roleSelect = document.querySelector(".ant-select-selection-search-input") as HTMLInputElement;
    if (roleSelect) {
      fireEvent.mouseDown(roleSelect);
      const option = document.querySelector(".ant-select-item-option-content") as HTMLElement;
      if (option) fireEvent.click(option);
    }

    const submitBtn = document.querySelector('.ant-drawer button[type="submit"]') as HTMLButtonElement;
    if (submitBtn) fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(createUser).toHaveBeenCalledWith(expect.objectContaining({ name: "NoWsUser", workspaces: [] }));
    });
  });

  it("renders guest role tag", () => {
    vi.mocked(useIdentityStore).mockReturnValue({
      ...defaultMock,
      users: [{ id: "u3", name: "Guest", role: "guest", workspaces: [], createdAt: "2024-01-03T00:00:00Z" }],
    });
    renderPage();
    expect(screen.getByText("Guest")).toBeInTheDocument();
    expect(screen.getByText("guest")).toBeInTheDocument();
  });

  it("shows validation error when name is empty", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /新建用户/i }));

    const submitBtn = document.querySelector('.ant-drawer button[type="submit"]') as HTMLButtonElement;
    if (submitBtn) fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(createUser).not.toHaveBeenCalled();
    });
  });

  it("opens confirmation modal and calls deleteUser", async () => {
    renderPage();
    const deleteButtons = screen.getAllByRole("button", { name: /删除/i });
    fireEvent.click(deleteButtons[0]);
    await waitFor(() => {
      expect(deleteUser).toHaveBeenCalledTimes(1);
      expect(deleteUser).toHaveBeenCalledWith("user-1");
    });
  });
});
