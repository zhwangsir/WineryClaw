import { useEffect, useState, useCallback } from "react";
import { Layout } from "antd";
import { useSystemStore } from "../../stores/systemStore";
import { Sidebar } from "./Sidebar";
import { HeaderBar } from "./HeaderBar";

const { Content } = Layout;

interface AppLayoutProps {
  children: React.ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const { fetchHealth, startInsightPolling, stopInsightPolling } = useSystemStore();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    fetchHealth();
    const i = setInterval(fetchHealth, 30000);
    return () => clearInterval(i);
  }, [fetchHealth]);

  // S6: 启动主动洞察轮询（挂载时启动，卸载时停止）
  useEffect(() => {
    startInsightPolling();
    return () => stopInsightPolling();
  }, [startInsightPolling, stopInsightPolling]);

  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  return (
    <Layout style={{ minHeight: "100vh", background: "var(--c-page)" }}>
      {/* Desktop sidebar */}
      <div className="sidebar-desktop">
        <Sidebar onNavigate={closeSidebar} />
      </div>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <>
          <div
            className="sidebar-mobile-overlay"
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.5)",
              zIndex: 99,
              animation: "fadeIn 200ms ease",
            }}
            onClick={closeSidebar}
          />
          <div
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              bottom: 0,
              zIndex: 100,
              animation: "slideIn 200ms ease",
            }}
          >
            <Sidebar onNavigate={closeSidebar} />
          </div>
        </>
      )}

      <Layout className="layout-content" style={{ marginLeft: 240 }}>
        <HeaderBar onMenuClick={() => setSidebarOpen(true)} />
        <Content
          className="page-content"
          style={{
            padding: 48,
            minHeight: "calc(100vh - 64px)",
            background: "var(--c-page)",
          }}
        >
          {children}
        </Content>
      </Layout>

      <style>{`
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes slideIn { from { transform: translateX(-100%); } to { transform: translateX(0); } }
      `}</style>
    </Layout>
  );
}
