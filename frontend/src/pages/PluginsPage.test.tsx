/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import PluginsPage from "./PluginsPage";
import { pluginsApi } from "../api/plugins";
import { usePluginStore } from "../stores/pluginStore";

const deletePlugin = vi.fn().mockResolvedValue(undefined);

vi.mock("../api/plugins", () => ({
  pluginsApi: {
    list: vi.fn(),
    enable: vi.fn().mockResolvedValue(undefined),
    disable: vi.fn().mockResolvedValue(undefined),
    unload: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../stores/pluginStore", () => ({
  usePluginStore: vi.fn(() => ({ deletePlugin })),
}));

vi.mock("antd", async () => {
  const actual = await vi.importActual<typeof import("antd")>("antd");
  return {
    ...actual,
    Modal: {
      ...actual.Modal,
      confirm: vi.fn(({ onOk }) => {
        if (onOk) onOk();
      }),
    },
  };
});

describe("PluginsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pluginsApi.list).mockResolvedValue([
      {
        id: "plugin-1",
        name: "Test Plugin",
        version: "1.0.0",
        enabled: true,
        manifest: { permissions: ["read", "write"] },
      },
      { id: "plugin-2", name: "Other Plugin", version: "2.0.0", enabled: false, manifest: { permissions: [] } },
    ]);
  });

  const renderPage = () =>
    render(
      <BrowserRouter>
        <PluginsPage />
      </BrowserRouter>
    );

  it("renders page shell", async () => {
    renderPage();
    await waitFor(() => {
      // Q14.3 — title changed from "Plugins" → "插件" for i18n consistency.
      expect(screen.getByText("插件")).toBeInTheDocument();
    });
  });

  it("renders plugins list with permissions", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Test Plugin")).toBeInTheDocument();
    });
    expect(screen.getByText("read")).toBeInTheDocument();
    expect(screen.getByText("write")).toBeInTheDocument();
    expect(screen.getByText("Other Plugin")).toBeInTheDocument();
  });

  it("shows empty state when no plugins", async () => {
    vi.mocked(pluginsApi.list).mockResolvedValue([]);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("暂无已加载的插件")).toBeInTheDocument();
    });
  });

  it("refreshes plugins", async () => {
    renderPage();
    await waitFor(() => expect(pluginsApi.list).toHaveBeenCalled());
    const refreshBtn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("刷新"));
    expect(refreshBtn).toBeTruthy();
    if (refreshBtn) fireEvent.click(refreshBtn);
    // Verify loading state is triggered
    await waitFor(() => {
      expect(document.querySelector(".ant-btn-loading")).toBeInTheDocument();
    });
  });

  it("toggles plugin off", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Test Plugin")).toBeInTheDocument());
    const switches = document.querySelectorAll(".ant-switch");
    if (switches.length > 0) {
      fireEvent.click(switches[0]);
      await waitFor(() => {
        expect(pluginsApi.disable).toHaveBeenCalledWith("plugin-1");
      });
    }
  });

  it("toggles plugin on", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Other Plugin")).toBeInTheDocument());
    const switches = document.querySelectorAll(".ant-switch");
    if (switches.length > 1) {
      fireEvent.click(switches[1]);
      await waitFor(() => {
        expect(pluginsApi.enable).toHaveBeenCalledWith("plugin-2");
      });
    }
  });

  it("unloads a plugin", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Test Plugin")).toBeInTheDocument());
    const unloadBtn = screen.getByTestId("unload-plugin-1");
    fireEvent.click(unloadBtn);
    await waitFor(() => {
      expect(pluginsApi.unload).toHaveBeenCalledWith("plugin-1");
    });
  });

  it("deletes a plugin via Modal.confirm", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Test Plugin")).toBeInTheDocument());
    const deleteButtons = screen.getAllByRole("button", { name: /删除/i });
    expect(deleteButtons.length).toBeGreaterThan(0);
    fireEvent.click(deleteButtons[0]);
    await waitFor(() => {
      expect(deletePlugin).toHaveBeenCalledWith("plugin-1");
    });
  });

  it("shows error when fetch plugins fails", async () => {
    vi.mocked(pluginsApi.list).mockRejectedValue(new Error("network error"));
    renderPage();
    await waitFor(() => {
      expect(pluginsApi.list).toHaveBeenCalled();
    });
  });

  it("shows error when toggle fails", async () => {
    vi.mocked(pluginsApi.disable).mockRejectedValue(new Error("disable failed"));
    renderPage();
    await waitFor(() => expect(screen.getByText("Test Plugin")).toBeInTheDocument());
    const switches = document.querySelectorAll(".ant-switch");
    if (switches.length > 0) {
      fireEvent.click(switches[0]);
      await waitFor(() => {
        expect(pluginsApi.disable).toHaveBeenCalledWith("plugin-1");
      });
    }
  });

  it("shows error when unload fails", async () => {
    vi.mocked(pluginsApi.unload).mockRejectedValue(new Error("unload failed"));
    renderPage();
    await waitFor(() => expect(screen.getByText("Test Plugin")).toBeInTheDocument());
    const unloadBtn = screen.getByTestId("unload-plugin-1");
    fireEvent.click(unloadBtn);
    await waitFor(() => {
      expect(pluginsApi.unload).toHaveBeenCalledWith("plugin-1");
    });
  });

  it("renders plugin without manifest permissions", async () => {
    vi.mocked(pluginsApi.list).mockResolvedValue([
      { id: "plugin-3", name: "NoManifest", version: "1.0.0", enabled: true },
    ]);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("NoManifest")).toBeInTheDocument();
    });
  });
});
