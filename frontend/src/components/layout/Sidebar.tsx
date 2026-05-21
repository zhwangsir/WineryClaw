import { useMemo, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  MessageOutlined,
  TeamOutlined,
  ToolOutlined,
  BookOutlined,
  ApartmentOutlined,
  ClockCircleOutlined,
  DashboardOutlined,
  SettingOutlined,
  GlobalOutlined,
  HistoryOutlined,
  AppstoreOutlined,
  ThunderboltOutlined,
  FileTextOutlined,
  BranchesOutlined,
  SafetyOutlined,
  ApiOutlined,
  UserOutlined,
  CloudOutlined,
  RobotOutlined,
  CheckCircleOutlined,
  SendOutlined,
  CodeOutlined,
  AppstoreAddOutlined,
  FileOutlined,
  BarChartOutlined,
  HomeOutlined,
  CaretDownOutlined,
  CaretRightOutlined,
} from "@ant-design/icons";

/**
 * Sidebar groups (Round I4 — replaces the flat 30-item menu).
 *
 * Five collapsible sections + a "返回用户端" anchor on top. Groups are
 * remembered via localStorage so users keep their preferred shape between
 * sessions. The active item's group auto-expands on every render.
 */
type MenuLeaf = { key: string; icon: React.ReactNode; label: string };
type MenuGroup = { id: string; title: string; items: MenuLeaf[] };

const ROOT_LINK: MenuLeaf = { key: "/", icon: <HomeOutlined />, label: "← 返回用户端" };

const MENU_GROUPS: MenuGroup[] = [
  {
    id: "core",
    title: "核心",
    items: [
      { key: "/dashboard", icon: <DashboardOutlined />, label: "仪表板" },
      { key: "/chat", icon: <MessageOutlined />, label: "对话" },
      { key: "/memory", icon: <HistoryOutlined />, label: "记忆" },
      { key: "/wiki", icon: <BookOutlined />, label: "知识库" },
      { key: "/kg", icon: <ApartmentOutlined />, label: "知识图谱" },
      { key: "/rag", icon: <FileOutlined />, label: "RAG 检索" },
    ],
  },
  {
    id: "agents",
    title: "智能体",
    items: [
      { key: "/agents", icon: <TeamOutlined />, label: "智能体" },
      { key: "/skills", icon: <ThunderboltOutlined />, label: "技能" },
      { key: "/skillhub", icon: <AppstoreAddOutlined />, label: "Skillhub" },
      { key: "/tools", icon: <ToolOutlined />, label: "工具" },
      { key: "/plugins", icon: <AppstoreOutlined />, label: "插件" },
    ],
  },
  {
    id: "channels",
    title: "通道",
    items: [
      { key: "/channels", icon: <GlobalOutlined />, label: "通道" },
      { key: "/dokobot", icon: <RobotOutlined />, label: "Dokobot" },
      { key: "/browser", icon: <GlobalOutlined />, label: "浏览器" },
      { key: "/uploads", icon: <FileTextOutlined />, label: "上传" },
    ],
  },
  {
    id: "system",
    title: "系统",
    items: [
      { key: "/mcp", icon: <ApiOutlined />, label: "MCP" },
      { key: "/sandbox", icon: <SafetyOutlined />, label: "沙箱" },
      { key: "/hooks", icon: <ApiOutlined />, label: "Hooks" },
      { key: "/cron", icon: <ClockCircleOutlined />, label: "定时任务" },
      { key: "/identity", icon: <UserOutlined />, label: "身份" },
      { key: "/metrics", icon: <BarChartOutlined />, label: "指标" },
      { key: "/config", icon: <SettingOutlined />, label: "配置" },
      { key: "/settings", icon: <SettingOutlined />, label: "设置" },
    ],
  },
  {
    id: "experimental",
    title: "实验",
    items: [
      { key: "/workflows", icon: <BranchesOutlined />, label: "工作流" },
      { key: "/templates", icon: <FileTextOutlined />, label: "模板" },
      { key: "/a2a", icon: <SendOutlined />, label: "A2A" },
      { key: "/proposals", icon: <CheckCircleOutlined />, label: "提案" },
      { key: "/cli", icon: <CodeOutlined />, label: "CLI" },
      { key: "/ecosystem", icon: <CloudOutlined />, label: "生态" },
    ],
  },
];

const COLLAPSED_GROUPS_KEY = "webrain.sidebar.collapsedGroups";

function loadCollapsedGroups(): Set<string> {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(COLLAPSED_GROUPS_KEY) : null;
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function saveCollapsedGroups(set: Set<string>) {
  try {
    localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...set]));
  } catch {
    /* localStorage disabled — ignore */
  }
}

interface SidebarProps {
  onNavigate?: () => void;
}

export function Sidebar({ onNavigate }: SidebarProps) {
  const navigate = useNavigate();
  const location = useLocation();

  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsedGroups());

  // Auto-expand the group containing the active route so the user never
  // sees a collapsed group hiding what they just clicked.
  const activeGroupId = useMemo(() => {
    const g = MENU_GROUPS.find((grp) => grp.items.some((it) => it.key === location.pathname));
    return g?.id;
  }, [location.pathname]);

  const isCollapsed = (groupId: string): boolean => {
    if (groupId === activeGroupId) return false;
    return collapsed.has(groupId);
  };

  const toggleGroup = (groupId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      saveCollapsedGroups(next);
      return next;
    });
  };

  const handleClick = (key: string) => {
    navigate(key);
    onNavigate?.();
  };

  const renderLeaf = (item: MenuLeaf, opts: { indent?: boolean } = {}) => {
    const active = location.pathname === item.key;
    return (
      <button
        key={item.key}
        onClick={() => handleClick(item.key)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: opts.indent ? "0 12px 0 24px" : "0 12px",
          height: 32,
          borderRadius: 6,
          border: "none",
          background: active ? "var(--c-hover)" : "transparent",
          color: active ? "var(--c-accent)" : "var(--c-text-2)",
          fontSize: 13.5,
          fontWeight: active ? 600 : 400,
          fontFamily: "inherit",
          cursor: "pointer",
          transition: "color 150ms, background 150ms",
          marginBottom: 1,
          position: "relative",
          textAlign: "left",
        }}
        onMouseEnter={(e) => {
          if (!active) {
            e.currentTarget.style.color = "var(--c-text)";
            e.currentTarget.style.background = "var(--c-hover)";
          }
        }}
        onMouseLeave={(e) => {
          if (!active) {
            e.currentTarget.style.color = "var(--c-text-2)";
            e.currentTarget.style.background = "transparent";
          }
        }}
      >
        {active && (
          <span
            style={{
              position: "absolute",
              left: 0,
              top: "50%",
              transform: "translateY(-50%)",
              width: 3,
              height: 16,
              borderRadius: "0 2px 2px 0",
              background: "var(--c-accent)",
            }}
          />
        )}
        <span style={{ fontSize: 15, opacity: active ? 1 : 0.7, display: "inline-flex", width: 16 }}>{item.icon}</span>
        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.label}</span>
      </button>
    );
  };

  return (
    <aside
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        bottom: 0,
        width: 240,
        zIndex: 100,
        background: "var(--c-card)",
        borderRight: "1px solid var(--c-border)",
        display: "flex",
        flexDirection: "column",
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Helvetica Neue", Arial, sans-serif',
      }}
    >
      {/* Logo */}
      <div
        style={{
          padding: "20px 20px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          borderBottom: "1px solid var(--c-border-light)",
        }}
      >
        <div
          style={{
            width: 28,
            height: 28,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {/* Brand mark — same /logo.svg as favicon / manifest / Tauri tray.
              No gradient wrapper: the multi-color mascot speaks for itself. */}
          <img
            src="/logo.svg"
            width={28}
            height={28}
            alt="WeBrain"
            style={{ display: "block" }}
          />
        </div>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--c-text)",
              lineHeight: 1.2,
              letterSpacing: "-0.01em",
            }}
          >
            WeBrain
          </div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 400,
              color: "var(--c-text-3)",
              lineHeight: 1.4,
              marginTop: 1,
            }}
          >
            管理端
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav style={{ flex: 1, padding: "12px 8px", overflowY: "auto" }}>
        {/* Top-level: back to user mode */}
        <div style={{ marginBottom: 10, paddingBottom: 10, borderBottom: "1px dashed var(--c-border-light)" }}>
          {renderLeaf(ROOT_LINK)}
        </div>

        {MENU_GROUPS.map((group) => {
          const collapsedNow = isCollapsed(group.id);
          return (
            <div key={group.id} style={{ marginBottom: 8 }}>
              <button
                type="button"
                onClick={() => toggleGroup(group.id)}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 10px",
                  height: 26,
                  border: "none",
                  background: "transparent",
                  color: "var(--c-text-3)",
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  fontFamily: "inherit",
                  cursor: "pointer",
                  textAlign: "left",
                  borderRadius: 4,
                  transition: "color 150ms",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.color = "var(--c-text-2)")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "var(--c-text-3)")}
                aria-expanded={!collapsedNow}
              >
                <span style={{ fontSize: 10, opacity: 0.7 }}>
                  {collapsedNow ? <CaretRightOutlined /> : <CaretDownOutlined />}
                </span>
                <span>{group.title}</span>
              </button>
              {!collapsedNow && (
                <div style={{ marginTop: 2 }}>{group.items.map((it) => renderLeaf(it, { indent: true }))}</div>
              )}
            </div>
          );
        })}
      </nav>

      {/* Footer */}
      <div
        style={{
          padding: "14px 20px",
          borderTop: "1px solid var(--c-border-light)",
          fontSize: 11,
          fontWeight: 400,
          color: "var(--c-text-3)",
          letterSpacing: "0.02em",
        }}
      >
        v1.0.2
      </div>
    </aside>
  );
}
