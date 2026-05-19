import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ChatSidebar from "./ChatSidebar";

vi.mock("../../hooks/useTheme", () => ({
  useIsDark: () => false,
}));

describe("ChatSidebar", () => {
  const baseProps = {
    sessions: [],
    currentSessionId: "",
    onSelectSession: vi.fn(),
    onNewSession: vi.fn(),
    onDeleteSession: vi.fn(),
  };

  it("renders empty state", () => {
    render(<ChatSidebar {...baseProps} />);
    expect(screen.getByText("暂无历史对话")).toBeInTheDocument();
  });

  it("calls onNewSession when clicking new chat button", () => {
    render(<ChatSidebar {...baseProps} />);
    fireEvent.click(screen.getByText("新对话"));
    expect(baseProps.onNewSession).toHaveBeenCalled();
  });

  it("renders sorted sessions", () => {
    const sessions = [
      { id: "s1", title: "Older", updatedAt: "2024-01-01T00:00:00Z" },
      { id: "s2", title: "Newer", updatedAt: "2024-06-01T00:00:00Z" },
    ];
    render(<ChatSidebar {...baseProps} sessions={sessions} currentSessionId="s2" />);
    expect(screen.getByText("Newer")).toBeInTheDocument();
    expect(screen.getByText("Older")).toBeInTheDocument();
  });

  it("calls onSelectSession when clicking a session", () => {
    const sessions = [{ id: "s1", title: "Test", updatedAt: new Date().toISOString() }];
    render(<ChatSidebar {...baseProps} sessions={sessions} />);
    fireEvent.click(screen.getByText("Test"));
    expect(baseProps.onSelectSession).toHaveBeenCalledWith("s1");
  });

  it("calls onDeleteSession via Popconfirm", () => {
    const sessions = [{ id: "s1", title: "Test", updatedAt: new Date().toISOString() }];
    render(<ChatSidebar {...baseProps} sessions={sessions} currentSessionId="s1" />);
    // Hover to show delete button
    const sessionEl = screen.getByText("Test").closest("div")?.parentElement?.parentElement as HTMLElement;
    fireEvent.mouseEnter(sessionEl);
    const deleteBtn = document.querySelector("[data-icon='delete']")?.closest("button") as HTMLElement;
    expect(deleteBtn).toBeTruthy();
    fireEvent.click(deleteBtn);
    // Popconfirm confirm
    const confirmBtn = document.querySelector(".ant-popconfirm-buttons button:last-child") as HTMLElement;
    if (confirmBtn) fireEvent.click(confirmBtn);
    expect(baseProps.onDeleteSession).toHaveBeenCalledWith("s1");
  });
});
