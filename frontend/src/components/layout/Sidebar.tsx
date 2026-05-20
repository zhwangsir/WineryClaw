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
} from "@ant-design/icons";

const menuItems = [
  { key: "/", icon: <HomeOutlined />, label: "← 返回用户端" },
  { key: "/dashboard", icon: <DashboardOutlined />, label: "仪表板" },
  { key: "/chat", icon: <MessageOutlined />, label: "对话" },
  { key: "/agents", icon: <TeamOutlined />, label: "智能体" },
  { key: "/tools", icon: <ToolOutlined />, label: "工具" },
  { key: "/plugins", icon: <AppstoreOutlined />, label: "插件" },
  { key: "/skills", icon: <ThunderboltOutlined />, label: "技能" },
  { key: "/memory", icon: <HistoryOutlined />, label: "记忆" },
  { key: "/wiki", icon: <BookOutlined />, label: "知识库" },
  { key: "/kg", icon: <ApartmentOutlined />, label: "知识图谱" },
  { key: "/channels", icon: <GlobalOutlined />, label: "通道" },
  { key: "/templates", icon: <FileTextOutlined />, label: "模板" },
  { key: "/workflows", icon: <BranchesOutlined />, label: "工作流" },
  { key: "/sandbox", icon: <SafetyOutlined />, label: "沙箱" },
  { key: "/mcp", icon: <ApiOutlined />, label: "MCP" },
  { key: "/browser", icon: <GlobalOutlined />, label: "浏览器" },
  { key: "/identity", icon: <UserOutlined />, label: "身份" },
  { key: "/ecosystem", icon: <CloudOutlined />, label: "生态" },
  { key: "/dokobot", icon: <RobotOutlined />, label: "Dokobot" },
  { key: "/proposals", icon: <CheckCircleOutlined />, label: "提案" },
  { key: "/a2a", icon: <SendOutlined />, label: "A2A" },
  { key: "/cli", icon: <CodeOutlined />, label: "CLI" },
  { key: "/skillhub", icon: <AppstoreAddOutlined />, label: "Skillhub" },
  { key: "/rag", icon: <FileTextOutlined />, label: "RAG 检索" },
  { key: "/config", icon: <SettingOutlined />, label: "配置" },
  { key: "/uploads", icon: <FileOutlined />, label: "上传" },
  { key: "/hooks", icon: <ApiOutlined />, label: "Hooks" },
  { key: "/metrics", icon: <BarChartOutlined />, label: "指标" },
  { key: "/cron", icon: <ClockCircleOutlined />, label: "定时任务" },
  { key: "/settings", icon: <SettingOutlined />, label: "设置" },
];

interface SidebarProps {
  onNavigate?: () => void;
}

export function Sidebar({ onNavigate }: SidebarProps) {
  const navigate = useNavigate();
  const location = useLocation();

  const handleClick = (key: string) => {
    navigate(key);
    onNavigate?.();
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
        fontFamily: '"Inter", sans-serif',
      }}
    >
      {/* Logo */}
      <div
        style={{
          padding: "28px 32px",
          display: "flex",
          alignItems: "center",
          gap: 12,
          borderBottom: "1px solid var(--c-border-light)",
        }}
      >
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            background: "var(--c-accent)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 13,
            fontWeight: 600,
            color: "var(--c-text-inv)",
            letterSpacing: "0.02em",
          }}
        >
          WB
        </div>
        <div>
          <div
            style={{
              fontSize: 15,
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
              fontWeight: 300,
              color: "var(--c-text-3)",
              lineHeight: 1.4,
              marginTop: 2,
            }}
          >
            AI Assistant
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav style={{ flex: 1, padding: "16px 12px", overflowY: "auto" }}>
        {menuItems.map((item) => {
          const active = location.pathname === item.key;
          return (
            <button
              key={item.key}
              onClick={() => handleClick(item.key)}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 14,
                padding: "0 16px",
                height: 40,
                borderRadius: 8,
                border: "none",
                background: active ? "var(--c-hover)" : "transparent",
                color: active ? "var(--c-accent)" : "var(--c-text-2)",
                fontSize: 14,
                fontWeight: active ? 600 : 400,
                fontFamily: '"Inter", sans-serif',
                cursor: "pointer",
                transition: "color 200ms, background 200ms",
                marginBottom: 2,
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
                    height: 20,
                    borderRadius: "0 2px 2px 0",
                    background: "var(--c-accent)",
                  }}
                />
              )}
              <span style={{ fontSize: 16, opacity: active ? 1 : 0.7 }}>{item.icon}</span>
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Footer */}
      <div
        style={{
          padding: "20px 32px",
          borderTop: "1px solid var(--c-border-light)",
          fontSize: 11,
          fontWeight: 300,
          color: "var(--c-text-3)",
          letterSpacing: "0.02em",
        }}
      >
        v1.0.2
      </div>
    </aside>
  );
}
