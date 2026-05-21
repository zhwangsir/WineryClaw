import { useEffect } from "react";
import { Row, Col, Card, List, Skeleton, Button } from "antd";
import { TeamOutlined, ToolOutlined, GlobalOutlined, RobotOutlined, ReloadOutlined, SafetyOutlined } from "@ant-design/icons";
import { useSystemStore } from "../stores/systemStore";
import { useAgentStore } from "../stores/agentStore";
import { useToolStore } from "../stores/toolStore";
import { useChannelStore } from "../stores/channelStore";
import { PageShell } from "../components/common/PageShell";
import { StatusBadge } from "../components/common/StatusBadge";
import { Loading } from "../components/common/Loading";

export default function DashboardPage() {
  const { health, modelHealth, fetchHealth } = useSystemStore();
  const { agents, fetchAgents } = useAgentStore();
  const { tools, fetchTools } = useToolStore();
  const { channels, fetchChannels } = useChannelStore();

  useEffect(() => {
    fetchHealth();
    fetchAgents();
    fetchTools();
    fetchChannels();
  }, [fetchHealth, fetchAgents, fetchTools, fetchChannels]);

  if (!health) return <Loading />;

  const modules = health.modules || {};
  const moduleList = Object.entries(modules).map(([name, active]) => ({ name, active: active as boolean }));
  const endpointEntries = Object.entries(modelHealth?.endpoints || {}) as [string, any][];
  const healthyEndpoints = endpointEntries.filter(([, e]) => e.healthy);
  const totalEndpoints = endpointEntries.length;

  const sandboxAvailable = modules.sandbox as boolean;
  const statCards = [
    { title: "智能体", value: agents.length, icon: <TeamOutlined /> },
    { title: "工具", value: tools.length, icon: <ToolOutlined /> },
    { title: "通道", value: channels.length, icon: <GlobalOutlined /> },
    { title: "模型端点", value: `${healthyEndpoints.length}/${totalEndpoints}`, icon: <RobotOutlined />, accent: true },
    { title: "沙箱", value: sandboxAvailable ? "就绪" : "未就绪", icon: <SafetyOutlined />, accent: sandboxAvailable },
  ];

  const handleRefresh = () => {
    fetchHealth();
    fetchAgents();
    fetchTools();
    fetchChannels();
  };

  return (
    <PageShell
      title="仪表板"
      subtitle="系统概览与实时监控"
      icon={<GlobalOutlined />}
      actions={
        <Button icon={<ReloadOutlined />} onClick={handleRefresh} style={{ height: 36 }}>
          刷新
        </Button>
      }
    >
      {/* Stats */}
      <Row gutter={[24, 24]} style={{ marginBottom: 32 }}>
        {statCards.map((s) => (
          <Col xs={24} sm={12} lg={6} key={s.title}>
            <Card
              style={{
                borderRadius: 12,
                border: "1px solid var(--c-border)",
                boxShadow: "var(--shadow)",
                transition: "box-shadow 200ms",
                cursor: "default",
              }}
              styles={{ body: { padding: 32 } }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.boxShadow = "var(--shadow-hover)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.boxShadow = "var(--shadow)";
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 12,
                    background: "var(--c-hover)",
                    border: "1px solid var(--c-border)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 18,
                    color: s.accent ? "var(--c-accent)" : "var(--c-text)",
                  }}
                >
                  {s.icon}
                </div>
                <div>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 300,
                      color: "var(--c-text-2)",
                      letterSpacing: "0.5px",
                      textTransform: "uppercase",
                      marginBottom: 4,
                    }}
                  >
                    {s.title}
                  </div>
                  <div
                    style={{
                      fontSize: 28,
                      fontWeight: 600,
                      color: "var(--c-text)",
                      lineHeight: 1.2,
                      fontFamily: '"Inter", sans-serif',
                    }}
                  >
                    {s.value}
                  </div>
                </div>
              </div>
            </Card>
          </Col>
        ))}
      </Row>

      <Row gutter={[24, 24]}>
        {/* Module Health */}
        <Col xs={24} lg={12}>
          <Card
            title="模块健康状态"
            style={{ borderRadius: 12, border: "1px solid var(--c-border)", boxShadow: "var(--shadow)" }}
            styles={{ header: {
              fontWeight: 600,
              fontSize: 15,
              color: "var(--c-text)",
              padding: "20px 32px",
              minHeight: 64,
              borderBottom: "1px solid var(--c-border-light)",
            }, body: { padding: "16px 32px" } }}
          >
            {moduleList.length === 0 ? (
              <div style={{ padding: "40px 0", textAlign: "center" }}>
                <Skeleton active paragraph={{ rows: 4 }} title={false} />
              </div>
            ) : (
              <List
                dataSource={moduleList}
                renderItem={(m) => (
                  <List.Item style={{ padding: "10px 0", borderBottom: "1px solid var(--c-border-light)" }}>
                    <div
                      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}
                    >
                      <span
                        style={{
                          color: "var(--c-text)",
                          fontSize: 14,
                          fontWeight: 400,
                          fontFamily: '"Inter", sans-serif',
                        }}
                      >
                        {m.name}
                      </span>
                      <StatusBadge status={m.active ? "ok" : "down"} />
                    </div>
                  </List.Item>
                )}
              />
            )}
          </Card>
        </Col>

        {/* Model Endpoints */}
        <Col xs={24} lg={12}>
          <Card
            title="模型端点"
            style={{ borderRadius: 12, border: "1px solid var(--c-border)", boxShadow: "var(--shadow)" }}
            styles={{ header: {
              fontWeight: 600,
              fontSize: 15,
              color: "var(--c-text)",
              padding: "20px 32px",
              minHeight: 64,
              borderBottom: "1px solid var(--c-border-light)",
            }, body: { padding: "24px 32px" } }}
          >
            {totalEndpoints === 0 ? (
              <div
                style={{
                  color: "var(--c-text-3)",
                  padding: "40px 0",
                  textAlign: "center",
                  fontSize: 14,
                  fontWeight: 300,
                  fontFamily: '"Inter", sans-serif',
                }}
              >
                未配置模型端点
              </div>
            ) : (
              <List
                dataSource={endpointEntries.map(([name, info]: [string, any]) => ({ name, ...info }))}
                renderItem={(ep: any) => (
                  <List.Item style={{ padding: "10px 0", borderBottom: "1px solid var(--c-border-light)" }}>
                    <div
                      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}
                    >
                      <div>
                        <div
                          style={{
                            fontSize: 14,
                            fontWeight: 400,
                            color: "var(--c-text)",
                            fontFamily: '"Inter", sans-serif',
                          }}
                        >
                          {ep.name}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--c-text-3)", fontWeight: 300, marginTop: 2 }}>
                          {ep.model_id}
                        </div>
                      </div>
                      <StatusBadge status={ep.healthy ? "healthy" : "down"} />
                    </div>
                  </List.Item>
                )}
              />
            )}
          </Card>
        </Col>
      </Row>
    </PageShell>
  );
}
