/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Sidebar } from "./Sidebar";

const navigate = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => navigate,
  };
});

describe("Sidebar", () => {
  it("renders logo and app name", () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>
    );
    expect(screen.getByText("WeBrain")).toBeInTheDocument();
    // Round I4: subtitle changed from "AI Assistant" to "管理端" — sidebar
    // is now explicitly the admin shell, with `/` going to UserHomePage.
    expect(screen.getByText("管理端")).toBeInTheDocument();
  });

  it("renders navigation menu items", () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>
    );
    expect(screen.getByText("仪表板")).toBeInTheDocument();
    expect(screen.getByText("对话")).toBeInTheDocument();
    expect(screen.getByText("设置")).toBeInTheDocument();
  });

  it("calls navigate when a menu item is clicked", () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByText("对话"));
    expect(navigate).toHaveBeenCalledWith("/chat");
  });

  it("calls onNavigate callback when provided", () => {
    const onNavigate = vi.fn();
    render(
      <MemoryRouter>
        <Sidebar onNavigate={onNavigate} />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByText("对话"));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("renders version in footer", () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>
    );
    expect(screen.getByText("v1.0.2")).toBeInTheDocument();
  });

  it("applies hover styles on mouse enter and leave", () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>
    );
    const btn = screen.getByText("对话").closest("button") as HTMLElement;
    expect(btn).toBeTruthy();
    fireEvent.mouseEnter(btn);
    expect(btn.style.color).toBe("var(--c-text)");
    fireEvent.mouseLeave(btn);
    expect(btn.style.color).toBe("var(--c-text-2)");
  });
});
