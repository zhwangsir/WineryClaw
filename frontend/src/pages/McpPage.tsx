import { useState, useEffect } from "react";
import { Button, Card, Drawer, Form, Input, Tag, Empty, Table } from "antd";
import { ApiOutlined, PlusOutlined, LinkOutlined, ToolOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { PageShell } from "../components/common/PageShell";
import { useMcpStore } from "../stores/mcpStore";

export default function McpPage() {
  const { servers, tools, loading, fetchServers, fetchTools, connect } = useMcpStore();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchServers();
    fetchTools();
  }, [fetchServers, fetchTools]);

  const handleConnect = async (values: { name: string; url: string }) => {
    await connect({ name: values.name, url: values.url });
    setDrawerOpen(false);
    form.resetFields();
  };

  return (
    <PageShell
      title="MCP"
      subtitle="Model Context Protocol 服务器与工具管理"
      icon={<ApiOutlined />}
      actions={
        <Button type="primary" icon={<PlusOutlined />} style={{ height: 40 }} onClick={() => setDrawerOpen(true)}>
          连接服务器
        </Button>
      }
    >
      {/* Servers */}
      <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 16, color: "var(--c-text)", display: "flex", alignItems: "center", gap: 8 }}>
        <LinkOutlined /> MCP 服务器
      </div>
      {servers.length === 0 ? (
        <Empty description="暂无 MCP 服务器" style={{ marginBottom: 32 }} />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16, marginBottom: 32 }}>
          {servers.map((s) => (
            <Card
              key={s.name}
              size="small"
              style={{ borderRadius: 12, border: "1px solid var(--c-border)" }}
              styles={{ body: { padding: 20 } }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 14, color: "var(--c-text)" }}>{s.name}</span>
                <Tag color={s.connected ? "success" : "default"} style={{ fontSize: 11 }}>
                  {s.connected ? "已连接" : "未连接"}
                </Tag>
              </div>
              {s.url && <div style={{ fontSize: 12, color: "var(--c-text-3)" }}>{s.url}</div>}
              {s.tools && s.tools.length > 0 && (
                <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {s.tools.map((t) => (
                    <Tag key={t} style={{ fontSize: 10, margin: 0 }}><ToolOutlined style={{ marginRight: 2 }} />{t}</Tag>
                  ))}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* Tools */}
      <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 16, color: "var(--c-text)", display: "flex", alignItems: "center", gap: 8 }}>
        <ThunderboltOutlined /> 可用工具
      </div>
      {tools.length === 0 ? (
        <Empty description="暂无 MCP 工具" />
      ) : (
        <Table
          dataSource={tools}
          rowKey="name"
          size="small"
          loading={loading}
          pagination={{ pageSize: 10 }}
          columns={[
            { title: "名称", dataIndex: "name", render: (v: string) => <span style={{ fontWeight: 500, fontSize: 13 }}>{v}</span> },
            { title: "服务器", dataIndex: "server", render: (v: string) => <Tag style={{ fontSize: 11 }}>{v}</Tag> },
            { title: "描述", dataIndex: "description", render: (v: string) => <span style={{ fontSize: 12, color: "var(--c-text-2)" }}>{v || "—"}</span> },
          ]}
        />
      )}

      {/* Connect Drawer */}
      <Drawer
        title={<span style={{ fontWeight: 600, fontSize: 16, color: "var(--c-text)" }}>连接 MCP 服务器</span>}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={420}
      >
        <Form form={form} layout="vertical" onFinish={handleConnect}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: "请输入服务器名称" }]}>
            <Input placeholder="例如: filesystem" />
          </Form.Item>
          <Form.Item name="url" label="URL" rules={[{ required: true, message: "请输入服务器 URL" }]}>
            <Input placeholder="例如: http://localhost:3001/sse" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" block icon={<LinkOutlined />}>连接</Button>
          </Form.Item>
        </Form>
      </Drawer>
    </PageShell>
  );
}
