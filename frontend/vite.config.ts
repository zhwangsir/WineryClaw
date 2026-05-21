import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Proxy target for both `vite dev` and `vite preview`.
// Defaults to localhost:3000 for local dev. In Docker, set VITE_PROXY_TARGET=http://sub-brain:3000.
const proxyTarget = process.env.VITE_PROXY_TARGET || "http://localhost:3000";

const proxyConfig = {
  "/api": { target: proxyTarget, changeOrigin: true },
  "/brain": { target: proxyTarget, changeOrigin: true },
  // Q14.7 (2026-05-21) — '/uploads' became a regex `^/uploads/.+`. The
  // bare '/uploads' path is the SPA route (UploadsPage); only
  // /uploads/<filename> is the sub-brain file-server endpoint
  // (uploads-routes.ts: GET /uploads/:name). With the old loose
  // '/uploads' key, the dev proxy forwarded the bare path too, so
  // sub-brain answered with the SPA fallback HTML but the asset
  // imports failed to resolve and the page rendered completely blank.
  "^/uploads/.+": { target: proxyTarget, changeOrigin: true },
  // Q14.5 (2026-05-21) — '/tools' removed for the same reason as
  // '/channels' / '/config': both the SPA and the sub-brain expose
  // it, and Vite's dev proxy matches first, so /tools loaded the raw
  // JSON instead of the React shell. The ToolsPage code calls
  // /api/tools (still proxied via the '/api' prefix), so removing the
  // bare '/tools' entry has no functional effect on data fetching.
  "/health": { target: proxyTarget, changeOrigin: true },
};

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          // react-syntax-highlighter 语言定义
          if (id.includes("react-syntax-highlighter/dist/esm/languages/")) return "syntax-highlighter-langs";
          // react-syntax-highlighter 核心 + 样式
          if (id.includes("react-syntax-highlighter")) return "syntax-highlighter";
          // Markdown 渲染生态
          if (id.includes("react-markdown") || id.includes("remark-gfm")) return "markdown";
          // i18n
          if (id.includes("i18next") || id.includes("react-i18next")) return "i18n";
          // React 生态核心 — 最底层，不依赖任何其他 chunk
          // 使用 /node_modules/<pkg>/ 精确匹配，防止 pnpm 路径中的 react@ / react-dom@ 误命中
          if (
            id.includes("/node_modules/react/") ||
            id.includes("/node_modules/react-dom/") ||
            id.includes("/node_modules/react-router-dom/") ||
            id.includes("/node_modules/react-router/") ||
            id.includes("/node_modules/react-is/") ||
            id.includes("/node_modules/scheduler/") ||
            id.includes("/node_modules/use-sync-external-store/")
          )
            return "react-core";
          // Ant Design 全家桶 — 只依赖 react-core
          if (id.includes("antd") || id.includes("@ant-design") || id.includes("/rc-") || id.includes("dayjs"))
            return "antd";
          // 动画库 — 只依赖 react-core
          if (id.includes("framer-motion")) return "motion";
          // 状态管理 + HTTP — 只依赖 react-core
          if (id.includes("zustand") || id.includes("axios")) return "state";
        },
      },
    },
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 8587,
    host: true,
    proxy: proxyConfig,
  },
  preview: {
    port: 8587,
    host: true,
    proxy: proxyConfig,
  },
});
