import { Card, Tabs } from "antd";
import { SettingOutlined, RobotOutlined, GlobalOutlined, InfoCircleOutlined } from "@ant-design/icons";
import { PageShell } from "../components/common/PageShell";
import ModelConfigPanel from "../components/settings/ModelConfigPanel";
import GlobalConfigPanel from "../components/settings/GlobalConfigPanel";
import AboutPanel from "../components/settings/AboutPanel";
import LLMHealthPanel from "../components/settings/LLMHealthPanel";
import MCPInfoPanel from "../components/settings/MCPInfoPanel";

export default function SettingsPage() {
  return (
    <PageShell title="设置" subtitle="系统配置与偏好管理" icon={<SettingOutlined />}>
      <Card
        style={{ borderRadius: 12, border: "1px solid var(--c-border)", boxShadow: "var(--shadow)" }}
        bodyStyle={{ padding: "32px 32px 24px" }}
      >
        <Tabs
          items={[
            {
              key: "model",
              label: (
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
                  <RobotOutlined />
                  模型
                </span>
              ),
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
              label: (
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
                  <GlobalOutlined />
                  通用
                </span>
              ),
              children: <GlobalConfigPanel />,
            },
            {
              key: "about",
              label: (
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
                  <InfoCircleOutlined />
                  关于
                </span>
              ),
              children: <AboutPanel />,
            },
          ]}
        />
      </Card>
    </PageShell>
  );
}
