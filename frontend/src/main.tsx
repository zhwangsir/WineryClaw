import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, MemoryRouter } from "react-router-dom";
import { ConfigProvider, theme as antdTheme } from "antd";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { useIsDark } from "./hooks/useTheme";
import "./styles/global.css";
import "./styles/inter-font.css";
import "./i18n";

/**
 * AntD theme sync (Round I4 + Q10 reactive update):
 * Mirror the Notion-style CSS tokens (`--c-accent`, radii, hairline borders)
 * so AntD components (Button/Tag/Input/Upload/Modal/…) feel native to the
 * rest of the app.
 *
 * Q10 fix — `isDark` was a module-level const captured once at import,
 * so when the user toggled the theme button (Sun/Moon) the AntD
 * algorithm stuck on its initial value. Visible symptom: light mode
 * showed light text on light bg because dark-mode tokens (e.g.
 * #e6e6e3 text) leaked in via the unchanged AntD provider while the
 * CSS vars in global.css correctly flipped to light values. Solution:
 * read isDark reactively via the existing useIsDark() Zustand hook
 * and wrap ConfigProvider in a small component so the theme object
 * recomputes on theme change.
 */
function buildNotionTheme(isDark: boolean) {
  return {
    algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: isDark ? "#5b8def" : "#2383e2",
      colorInfo: isDark ? "#5b8def" : "#2383e2",
      colorText: isDark ? "#e6e6e3" : "#37352f",
      colorTextSecondary: isDark ? "rgba(255, 255, 255, 0.7)" : "rgba(55, 53, 47, 0.65)",
      colorBorder: isDark ? "rgba(255, 255, 255, 0.16)" : "rgba(55, 53, 47, 0.16)",
      colorBorderSecondary: isDark ? "rgba(255, 255, 255, 0.09)" : "rgba(55, 53, 47, 0.09)",
      colorBgContainer: isDark ? "#191919" : "#ffffff",
      colorBgElevated: isDark ? "#202020" : "#ffffff",
      colorBgLayout: isDark ? "#191919" : "#ffffff",
      borderRadius: 6,
      borderRadiusLG: 8,
      borderRadiusSM: 4,
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif',
      fontSize: 14,
      controlHeight: 32,
      wireframe: false,
    },
    components: {
      Button: {
        controlHeight: 32,
        paddingContentHorizontal: 12,
      },
      Tag: {
        borderRadiusSM: 4,
      },
      Modal: {
        borderRadiusLG: 10,
        // Round Q1.1 fix — dark-mode modal body was indistinguishable
        // from the page background (both ~#191919). Force a slightly
        // elevated surface + visible border so users can see the panel.
        contentBg: isDark ? "#262626" : "#ffffff",
        headerBg: isDark ? "#262626" : "#ffffff",
        footerBg: isDark ? "#262626" : "#ffffff",
        // Mask was already semi-transparent; bump it a touch in dark mode
        // so the visual hierarchy "page → mask → modal" reads clearly.
        colorBgMask: isDark ? "rgba(0, 0, 0, 0.55)" : "rgba(0, 0, 0, 0.45)",
      },
      Drawer: {
        // Round Q9.1 — same dark-mode contrast issue Modal had: the
        // session-history drawer rendered with bg ~#202020 against page
        // ~#191919, so the panel was visually nearly invisible. AntD v5
        // Drawer uses `colorBgElevated` for the content panel BUT the
        // global `colorBgContainer` token also bleeds in for header/body.
        // Set both to be safe.
        colorBgElevated: isDark ? "#2a2a2a" : "#ffffff",
        colorBgMask: isDark ? "rgba(0, 0, 0, 0.55)" : "rgba(0, 0, 0, 0.45)",
      },
    },
  } as const;
}

/** Wrapper component so the theme object re-derives on every isDark change. */
function ReactiveConfigProvider({ children }: { children: React.ReactNode }) {
  const isDark = useIsDark();
  return <ConfigProvider theme={buildNotionTheme(isDark)}>{children}</ConfigProvider>;
}

// Tauri desktop shell detection — use MemoryRouter (no browser history API)
const isTauri = typeof window !== "undefined" && !!(window as any).__TAURI__;
if (isTauri) {
  console.log("[webrain] Running in Tauri desktop shell");
}
const Router = isTauri ? MemoryRouter : BrowserRouter;

// Register Service Worker for PWA
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .getRegistrations()
      .then((regs) => {
        for (const reg of regs) {
          reg.unregister().then(() => {
            /* old SW unregistered */
          });
        }
      })
      .finally(() => {
        navigator.serviceWorker.register("/sw.js").catch(() => {});
      });
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ReactiveConfigProvider>
        <Router>
          <App />
        </Router>
      </ReactiveConfigProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
