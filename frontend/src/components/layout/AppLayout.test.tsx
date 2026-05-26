import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AppLayout } from "./AppLayout";

vi.mock("../../stores/systemStore", () => ({
  useSystemStore: () => ({
    fetchHealth: vi.fn(),
    startInsightPolling: vi.fn(),
    stopInsightPolling: vi.fn(),
  }),
}));

vi.mock("./Sidebar", () => ({
  Sidebar: ({ onNavigate }: { onNavigate: () => void }) => (
    <aside data-testid="sidebar">
      <button onClick={onNavigate}>Navigate</button>
    </aside>
  ),
}));

vi.mock("./HeaderBar", () => ({
  HeaderBar: ({ onMenuClick }: { onMenuClick: () => void }) => (
    <header data-testid="headerbar">
      <button onClick={onMenuClick}>Menu</button>
    </header>
  ),
}));

describe("AppLayout", () => {
  it("renders children and sidebar", () => {
    render(
      <AppLayout>
        <div data-testid="child">content</div>
      </AppLayout>
    );
    expect(screen.getByTestId("child")).toHaveTextContent("content");
    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("headerbar")).toBeInTheDocument();
  });

  it("opens and closes mobile sidebar", () => {
    render(
      <AppLayout>
        <div>content</div>
      </AppLayout>
    );
    // Open mobile sidebar via header menu
    fireEvent.click(screen.getByText("Menu"));
    expect(document.querySelector(".sidebar-mobile-overlay")).toBeInTheDocument();

    // Close via overlay click
    fireEvent.click(document.querySelector(".sidebar-mobile-overlay")!);
    expect(document.querySelector(".sidebar-mobile-overlay")).not.toBeInTheDocument();
  });
});
