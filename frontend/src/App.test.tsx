import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock useLocation to control which mode App renders. The
// implementation must be settable per-test so we can hit both user
// mode (`/`) and admin mode (any other path).
let mockPathname = "/dashboard";

vi.mock("react-router-dom", () => ({
  Routes: ({ children }: any) => <div data-testid="routes">{children}</div>,
  Route: ({ path }: any) => <div data-testid={`route-${path.replace(/\//g, "-") || "root"}`} />,
  useLocation: () => ({ pathname: mockPathname }),
  useNavigate: () => vi.fn(),
}));

import App from "./App";

vi.mock("./components/layout/AppLayout", () => ({
  AppLayout: ({ children }: any) => <div data-testid="applayout">{children}</div>,
}));

vi.mock("./components/common/ErrorBoundary", () => ({
  ErrorBoundary: ({ children }: any) => <div data-testid="errorboundary">{children}</div>,
}));

vi.mock("./components/common/GlobalProgress", () => ({
  GlobalProgressBar: () => <div data-testid="globalprogress" />,
}));

vi.mock("./components/common/Loading", () => ({
  Loading: () => <div data-testid="loading" />,
}));

vi.mock("./stores/systemStore", () => ({
  useSystemStore: () => ({
    fetchHealth: vi.fn(),
    fetchModelHealth: vi.fn(),
  }),
}));

vi.mock("./stores/agentStore", () => ({
  useAgentStore: () => ({ fetchAgents: vi.fn() }),
}));

vi.mock("./stores/toolStore", () => ({
  useToolStore: () => ({ fetchTools: vi.fn() }),
}));

vi.mock("./stores/channelStore", () => ({
  useChannelStore: () => ({ fetchChannels: vi.fn() }),
}));

vi.mock("./stores/chatStore", () => ({
  useChatStore: () => ({ init: vi.fn() }),
}));

describe("App", () => {
  it("admin mode (/dashboard) renders the AppLayout shell and routes", () => {
    mockPathname = "/dashboard";
    render(<App />);
    expect(screen.getByTestId("errorboundary")).toBeInTheDocument();
    expect(screen.getByTestId("globalprogress")).toBeInTheDocument();
    expect(screen.getByTestId("applayout")).toBeInTheDocument();
    expect(screen.getByTestId("routes")).toBeInTheDocument();
  });

  it("admin mode renders multiple route placeholders", () => {
    mockPathname = "/dashboard";
    render(<App />);
    const routes = screen.getByTestId("routes");
    expect(routes).toBeInTheDocument();
    expect(routes.children.length).toBeGreaterThan(0);
  });

  // Round I1: `/` switched from admin-Dashboard to user-mode (UserHomePage).
  // User mode renders WITHOUT AppLayout — that's the point of the split.
  it("user mode (/) does NOT render the admin AppLayout", () => {
    mockPathname = "/";
    render(<App />);
    expect(screen.getByTestId("errorboundary")).toBeInTheDocument();
    expect(screen.getByTestId("globalprogress")).toBeInTheDocument();
    expect(screen.queryByTestId("applayout")).not.toBeInTheDocument();
    expect(screen.getByTestId("routes")).toBeInTheDocument();
  });
});
