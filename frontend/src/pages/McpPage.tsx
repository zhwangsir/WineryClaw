import { useState, useEffect } from "react";
import { Button, Card, Drawer, Form, Input, Tag, Empty, Table, Tabs, Modal, message } from "antd";
import {
  ApiOutlined,
  PlusOutlined,
  LinkOutlined,
  ToolOutlined,
  ThunderboltOutlined,
  AppstoreOutlined,
  DownloadOutlined,
  CheckCircleOutlined,
} from "@ant-design/icons";
import { PageShell } from "../components/common/PageShell";
import { useMcpStore } from "../stores/mcpStore";
import { mcpApi, type McpCatalogEntry } from "../api/mcp";

const CATEGORY_LABELS: Record<string, string> = {
  files: "文件",
  dev: "开发",
  data: "数据库",
  web: "网络",
  ai: "AI",
  system: "系统",
};

const CATEGORY_COLORS: Record<string, string> = {
  files: "blue",
  dev: "purple",
  data: "cyan",
  web: "green",
  ai: "magenta",
  system: "gold",
};

export default function McpPage() {
  const { servers, tools, loading, fetchServers, fetchTools, connect } = useMcpStore();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form] = Form.useForm();

  // Catalog state — builtin MCP servers the user can install with one click.
  const [catalog, setCatalog] = useState<McpCatalogEntry[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [installEntry, setInstallEntry] = useState<McpCatalogEntry | null>(null);
  const [installEnv, setInstallEnv] = useState<Record<string, string>>({});
  const [installPathArg, setInstallPathArg] = useState("");
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    fetchServers();
    fetchTools();
    setCatalogLoading(true);
    mcpApi
      .listCatalog()
      .then((list) => setCatalog(list))
      .catch((err) => message.error(`Catalog fetch failed: ${err?.message || String(err)}`))
      .finally(() => setCatalogLoading(false));
  }, [fetchServers, fetchTools]);

  const handleConnect = async (values: { name: string; url: string }) => {
    await connect({ name: values.name, url: values.url });
    setDrawerOpen(false);
    form.resetFields();
  };

  const installedIds = new Set(servers.map((s) => s.name));

  const openInstallModal = (entry: McpCatalogEntry) => {
    setInstallEntry(entry);
    setInstallEnv({});
    setInstallPathArg("");
  };

  const handleInstall = async () => {
    if (!installEntry) return;
    setInstalling(true);
    try {
      const result = await mcpApi.installFromCatalog(installEntry.id, {
        env: installEnv,
        pathArg: installPathArg || undefined,
      });
      if (result.ok) {
        message.success(`已连接 ${installEntry.name}${result.tools ? ` (${result.tools.length} 工具)` : ""}`);
        setInstallEntry(null);
        await fetchServers();
        await fetchTools();
      } else {
        message.error(result.error || "Install failed");
      }
    } catch (err) {
      message.error(`Install error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setInstalling(false);
    }
  };

  const catalogByCategory = catalog.reduce<Record<string, McpCatalogEntry[]>>((acc, e) => {
    (acc[e.category] ||= []).push(e);
    return acc;
  }, {});

  return (
    <PageShell
      title="MCP"
      subtitle="Model Context Protocol 服务器与工具管理 · 14 个内置可一键安装"
      icon={<ApiOutlined />}
      actions={
        <Button type="primary" icon={<PlusOutlined />} style={{ height: 40 }} onClick={() => setDrawerOpen(true)}>
          手动连接
        </Button>
      }
    >
      <Tabs
        defaultActiveKey="catalog"
        items={[
          {
            key: "catalog",
            label: (
              <span>
                <AppstoreOutlined /> 内置市场 ({catalog.length})
              </span>
            ),
            children: catalogLoading ? (
              <div style={{ padding: 32, textAlign: "center", color: "var(--c-text-3)" }}>加载中...</div>
            ) : (
              <div>
                {Object.entries(catalogByCategory).map(([cat, entries]) => (
                  <div key={cat} style={{ marginBottom: 24 }}>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        color: "var(--c-text-2)",
                        marginBottom: 12,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      <Tag color={CATEGORY_COLORS[cat]} style={{ margin: 0 }}>
                        {CATEGORY_LABELS[cat] || cat}
                      </Tag>
                      <span>{entries.length} 个</span>
                    </div>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
                        gap: 12,
                      }}
                    >
                      {entries.map((entry) => {
                        const installed = installedIds.has(entry.id);
                        return (
                          <Card
                            key={entry.id}
                            size="small"
                            style={{
                              borderRadius: 8,
                              border: "1px solid var(--c-border)",
                              opacity: installed ? 0.7 : 1,
                            }}
                            styles={{ body: { padding: 14 } }}
                          >
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
                                  {entry.name}
                                </div>
                                <div
                                  style={{
                                    fontSize: 12,
                                    color: "var(--c-text-2)",
                                    marginBottom: 8,
                                    lineHeight: 1.5,
                                  }}
                                >
                                  {entry.description}
                                </div>
                                <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 4 }}>
                                  {entry.sizeEstimateMb && (
                                    <Tag style={{ fontSize: 10, margin: 0 }}>~{entry.sizeEstimateMb} MB</Tag>
                                  )}
                                  {entry.requiredEnv && entry.requiredEnv.length > 0 && (
                                    <Tag color="orange" style={{ fontSize: 10, margin: 0 }}>
                                      需要 {entry.requiredEnv.length} 个密钥
                                    </Tag>
                                  )}
                                </div>
                              </div>
                              {installed ? (
                                <Tag color="success" icon={<CheckCircleOutlined />} style={{ margin: 0 }}>
                                  已安装
                                </Tag>
                              ) : (
                                <Button
                                  size="small"
                                  type="primary"
                                  icon={<DownloadOutlined />}
                                  onClick={() => openInstallModal(entry)}
                                >
                                  安装
                                </Button>
                              )}
                            </div>
                          </Card>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            ),
          },
          {
            key: "servers",
            label: (
              <span>
                <LinkOutlined /> 已安装 ({servers.length})
              </span>
            ),
            children:
              servers.length === 0 ? (
                <Empty description="暂无 MCP 服务器 · 去内置市场安装" style={{ marginTop: 48 }} />
              ) : (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
                    gap: 16,
                  }}
                >
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
                            <Tag key={t} style={{ fontSize: 10, margin: 0 }}>
                              <ToolOutlined style={{ marginRight: 2 }} />
                              {t}
                            </Tag>
                          ))}
                        </div>
                      )}
                    </Card>
                  ))}
                </div>
              ),
          },
          {
            key: "tools",
            label: (
              <span>
                <ThunderboltOutlined /> 工具 ({tools.length})
              </span>
            ),
            children:
              tools.length === 0 ? (
                <Empty description="暂无 MCP 工具" />
              ) : (
                <Table
                  dataSource={tools}
                  rowKey="name"
                  size="small"
                  loading={loading}
                  pagination={{ pageSize: 10 }}
                  columns={[
                    {
                      title: "名称",
                      dataIndex: "name",
                      render: (v: string) => <span style={{ fontWeight: 500, fontSize: 13 }}>{v}</span>,
                    },
                    { title: "服务器", dataIndex: "server", render: (v: string) => <Tag style={{ fontSize: 11 }}>{v}</Tag> },
                    {
                      title: "描述",
                      dataIndex: "description",
                      render: (v: string) => <span style={{ fontSize: 12, color: "var(--c-text-2)" }}>{v || "—"}</span>,
                    },
                  ]}
                />
              ),
          },
        ]}
      />

      {/* Manual connect drawer */}
      <Drawer
        title={<span style={{ fontWeight: 600, fontSize: 16, color: "var(--c-text)" }}>手动连接 MCP 服务器</span>}
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
            <Button type="primary" htmlType="submit" block icon={<LinkOutlined />}>
              连接
            </Button>
          </Form.Item>
        </Form>
      </Drawer>

      {/* Install modal — env vars + optional path arg */}
      <Modal
        title={installEntry ? `安装 ${installEntry.name}` : "安装"}
        open={!!installEntry}
        onCancel={() => setInstallEntry(null)}
        onOk={handleInstall}
        okText="开始安装"
        cancelText="取消"
        confirmLoading={installing}
        width={520}
      >
        {installEntry && (
          <div>
            <div style={{ marginBottom: 12, color: "var(--c-text-2)" }}>{installEntry.description}</div>
            <div style={{ fontSize: 12, color: "var(--c-text-3)", marginBottom: 16 }}>
              <code style={{ background: "var(--c-bg-2)", padding: "2px 6px", borderRadius: 4 }}>
                {installEntry.command} {installEntry.args.join(" ")}
              </code>
            </div>
            {installEntry.pathArgHint && (
              <Form.Item label="路径 / 连接串" extra={installEntry.pathArgHint}>
                <Input
                  value={installPathArg}
                  onChange={(e) => setInstallPathArg(e.target.value)}
                  placeholder={installEntry.pathArgHint}
                />
              </Form.Item>
            )}
            {installEntry.requiredEnv && installEntry.requiredEnv.length > 0 && (
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>必要环境变量</div>
                {installEntry.requiredEnv.map((key) => (
                  <Form.Item key={key} label={key}>
                    <Input.Password
                      value={installEnv[key] || ""}
                      onChange={(e) => setInstallEnv((s) => ({ ...s, [key]: e.target.value }))}
                      placeholder={`输入 ${key}`}
                    />
                  </Form.Item>
                ))}
              </div>
            )}
            {installEntry.sizeEstimateMb && installEntry.sizeEstimateMb > 100 && (
              <div style={{ fontSize: 12, color: "#f59e0b", marginTop: 8 }}>
                ⚠️ 首次安装需下载约 {installEntry.sizeEstimateMb} MB
              </div>
            )}
          </div>
        )}
      </Modal>
    </PageShell>
  );
}
