import { Card, Tabs } from "antd";
import {
  SettingOutlined,
  RobotOutlined,
  GlobalOutlined,
  InfoCircleOutlined,
  SafetyOutlined,
  AuditOutlined,
} from "@ant-design/icons";
import { PageShell } from "../components/common/PageShell";
import ModelConfigPanel from "../components/settings/ModelConfigPanel";
import GlobalConfigPanel from "../components/settings/GlobalConfigPanel";
import AboutPanel from "../components/settings/AboutPanel";
import LLMHealthPanel from "../components/settings/LLMHealthPanel";
import MCPInfoPanel from "../components/settings/MCPInfoPanel";
import ApiTokenPanel from "../components/settings/ApiTokenPanel";
// v2.32 (P1 #8): surface v2.16/v2.17/v2.29 backend features into UI.
import PrivacyPanel from "../components/settings/PrivacyPanel";
import NetworkLedgerPanel from "../components/settings/NetworkLedgerPanel";
import MCPAuditPanel from "../components/settings/MCPAuditPanel";

const tabLabel = (Icon: typeof SettingOutlined, text: string) => (
  <span
    style={{
      display: "flex",
      alignItems: "center",
      gap: 8,
      fontSize: 14,
      fontWeight: 400,
      color: "var(--c-text)",
    }}
  >
    <Icon />
    {text}
  </span>
);

export default function SettingsPage() {
  return (
    <PageShell title="设置" subtitle="系统配置与偏好管理" icon={<SettingOutlined />}>
      <Card
        style={{ borderRadius: 12, border: "1px solid var(--c-border)", boxShadow: "var(--shadow)" }}
        styles={{ body: { padding: "32px 32px 24px" } }}
      >
        <Tabs
          items={[
            {
              key: "model",
              label: tabLabel(RobotOutlined, "模型"),
              children: (
                <>
                  <ModelConfigPanel />
                  <LLMHealthPanel />
                  <MCPInfoPanel />
                </>
              ),
            },
            {
              key: "general",
              label: tabLabel(GlobalOutlined, "通用"),
              children: <GlobalConfigPanel />,
            },
            {
              key: "security",
              label: tabLabel(SafetyOutlined, "安全"),
              children: (
                <>
                  <ApiTokenPanel />
                  <PrivacyPanel />
                </>
              ),
            },
            {
              key: "audit",
              label: tabLabel(AuditOutlined, "审计"),
              children: (
                <>
                  <NetworkLedgerPanel />
                  <MCPAuditPanel />
                </>
              ),
            },
            {
              key: "about",
              label: tabLabel(InfoCircleOutlined, "关于"),
              children: <AboutPanel />,
            },
          ]}
        />
      </Card>
    </PageShell>
  );
}
