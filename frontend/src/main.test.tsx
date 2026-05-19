/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const renderFn = vi.fn();
const createRootFn = vi.fn(() => ({ render: renderFn }));

vi.mock("react-dom/client", () => ({
  default: { createRoot: createRootFn },
  createRoot: createRootFn,
}));

vi.mock("react-router-dom", () => ({
  BrowserRouter: ({ children }: any) => <div data-testid="router">{children}</div>,
}));

vi.mock("./App", () => ({
  default: () => <div data-testid="app">App</div>,
}));

vi.mock("./components/ErrorBoundary", () => ({
  default: ({ children }: any) => <div data-testid="error-boundary">{children}</div>,
}));

vi.mock("./i18n", () => ({}));

describe("main.tsx", () => {
  let rootEl: HTMLDivElement;
  let loadCallbacks: Array<(event: Event) => void> = [];

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    rootEl = document.createElement("div");
    rootEl.id = "root";
    document.body.appendChild(rootEl);
    loadCallbacks = [];
    vi.spyOn(window, "addEventListener").mockImplementation((event, cb: any) => {
      if (event === "load") {
        loadCallbacks.push(cb);
      }
    });
  });

  afterEach(() => {
    if (rootEl.parentNode) {
      rootEl.parentNode.removeChild(rootEl);
    }
    vi.restoreAllMocks();
  });

  it("creates root and renders App", async () => {
    await import("./main");
    expect(createRootFn).toHaveBeenCalledWith(rootEl);
    expect(renderFn).toHaveBeenCalled();
    const rendered = renderFn.mock.calls[0][0];
    expect(rendered).toBeDefined();
  });

  it("registers service worker when supported", async () => {
    const unregister = vi.fn().mockResolvedValue(undefined);
    const getRegistrations = vi.fn().mockResolvedValue([{ unregister }]);
    const register = vi.fn().mockResolvedValue(undefined);
    (globalThis.navigator as any).serviceWorker = {
      getRegistrations,
      register,
    };

    await import("./main");
    expect(loadCallbacks.length).toBeGreaterThan(0);
    loadCallbacks.forEach((cb) => cb(new Event("load")));

    await vi.waitFor(() => {
      expect(getRegistrations).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(unregister).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(register).toHaveBeenCalledWith("/sw.js");
    });
  });

  it("does not throw when service worker is not supported", async () => {
    delete (globalThis.navigator as any).serviceWorker;
    await expect(import("./main")).resolves.toBeDefined();
  });
});
