/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { HeaderBar } from "./HeaderBar";

const navigate = vi.fn();
const toggleTheme = vi.fn();
const markNotificationRead = vi.fn();

const mockStore: any = {
  notifications: [
    { id: "n1", title: "Test Notif", message: "Hello", read: false },
    { id: "n2", title: "Read Notif", message: "Done", read: true },
  ],
  markNotificationRead,
  health: { status: "ok" },
  theme: "light",
  toggleTheme,
};

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => navigate,
  };
});

vi.mock("../../stores/systemStore", () => ({
  useSystemStore: () => mockStore,
}));

describe("HeaderBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.theme = "light";
    mockStore.health = { status: "ok" };
  });

  it("renders healthy status", () => {
    render(
      <MemoryRouter>
        <HeaderBar />
      </MemoryRouter>
    );
    expect(screen.getByText("系统正常运行")).toBeInTheDocument();
  });

  it("renders unhealthy status", () => {
    mockStore.health = { status: "error" };
    render(
      <MemoryRouter>
        <HeaderBar />
      </MemoryRouter>
    );
    expect(screen.getByText("系统异常")).toBeInTheDocument();
  });

  it("calls toggleTheme when theme button is clicked", () => {
    render(
      <MemoryRouter>
        <HeaderBar />
      </MemoryRouter>
    );
    const buttons = screen.getAllByRole("button");
    // theme toggle is the second button (after menu toggle)
    fireEvent.click(buttons[1]);
    expect(toggleTheme).toHaveBeenCalledTimes(1);
  });

  it("renders dark theme icon", () => {
    mockStore.theme = "dark";
    const { container } = render(
      <MemoryRouter>
        <HeaderBar />
      </MemoryRouter>
    );
    // SunOutlined rendered when theme is dark (data-icon="sun")
    expect(container.querySelector("[data-icon='sun']")).toBeTruthy();
  });

  it("calls onMenuClick when menu button is clicked", () => {
    const onMenuClick = vi.fn();
    render(
      <MemoryRouter>
        <HeaderBar onMenuClick={onMenuClick} />
      </MemoryRouter>
    );
    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[0]);
    expect(onMenuClick).toHaveBeenCalledTimes(1);
  });
});
