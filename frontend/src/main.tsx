import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ConfigProvider, theme as antdTheme } from "antd";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./styles/global.css";
import "./styles/inter-font.css";
import "./i18n";

/**
 * AntD theme sync (Round I4):
 * Mirror the Notion-style CSS tokens (`--c-accent`, radii, hairline borders)
 * so AntD components (Button/Tag/Input/Upload/Modal/…) feel native to the
 * rest of the app instead of shipping AntD's default electric-blue + 6px
 * radius style.
 *
 * Light vs dark is keyed off `document.documentElement.dataset.theme`, set
 * by the theme switcher. If neither is set we default to light.
 */
const isDark = typeof document !== "undefined" && document.documentElement.dataset.theme === "dark";

const notionTheme = {
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
    },
  },
};

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
      <ConfigProvider theme={notionTheme}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ConfigProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
