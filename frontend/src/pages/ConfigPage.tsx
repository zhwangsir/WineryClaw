import { useState, useEffect } from "react";
import { Button, Card, Drawer, Form, Input, Table, Tag, Empty, Modal } from "antd";
import { SettingOutlined, PlusOutlined, ApartmentOutlined, DeleteOutlined, ExclamationCircleOutlined } from "@ant-design/icons";
import { PageShell } from "../components/common/PageShell";
import { useConfigStore } from "../stores/configStore";

export default function ConfigPage() {
  const { workspaces, agents, loading, fetchWorkspaces, createWorkspace, fetchWorkspaceAgents, deleteWorkspace } = useConfigStore();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedWorkspace, setSelectedWorkspace] = useState("");
  const [form] = Form.useForm();

  useEffect(() => {
    fetchWorkspaces();
  }, [fetchWorkspaces]);

  const handleCreate = async (values: { name: string; description: string }) => {
    await createWorkspace({ name: values.name, description: values.description });
    setDrawerOpen(false);
    form.resetFields();
  };

  const openAgents = async (id: string) => {
    setSelectedWorkspace(id);
    await fetchWorkspaceAgents(id);
  };

  return (
    <PageShell
      title="配置"
      subtitle="工作空间与代理配置管理"
      icon={<SettingOutlined />}
      actions={
        <Button type="primary" icon={<PlusOutlined />} style={{ height: 40 }} onClick={() => setDrawerOpen(true)}>
          新建工作空间
        </Button>
      }
    >
      {workspaces.length === 0 ? (
        <Empty description="暂无工作空间" />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <Card
            title={<span style={{ fontWeight: 600, color: "var(--c-text)" }}><ApartmentOutlined style={{ marginRight: 8 }} />工作空间</span>}
            style={{ borderRadius: 12, border: "1px solid var(--c-border)" }}
            bodyStyle={{ padding: 24 }}
          >
            <Table
              dataSource={workspaces}
              rowKey="id"
              loading={loading}
              pagination={false}
              columns={[
                { title: "ID", dataIndex: "id", render: (v: string) => <span style={{ fontSize: 12, fontFamily: "monospace" }}>{v.slice(0, 12)}...</span> },
                { title: "名称", dataIndex: "name", render: (v: string) => <span style={{ fontWeight: 500 }}>{v}</span> },
                { title: "描述", dataIndex: "description", render: (v: string) => <span style={{ fontSize: 12, color: "var(--c-text-2)" }}>{v || "—"}</span> },
                { title: "创建时间", dataIndex: "createdAt", render: (v: string) => <span style={{ fontSize: 12, color: "var(--c-text-3)" }}>{new Date(v).toLocaleString("zh-CN")}</span> },
                {
                  title: "操作",
                  key: "action",
                  render: (_: unknown, record: { id: string; name: string }) => (
                    <div style={{ display: "flex", gap: 8 }}>
                      <Button size="small" onClick={() => openAgents(record.id)}>查看代理</Button>
                      <Button
                        type="text"
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={() => {
                          Modal.confirm({
                            title: "确认删除",
                            icon: <ExclamationCircleOutlined />,
                            content: `确定要删除工作空间 "${record.name}" 吗？`,
                            okText: "删除",
                            okType: "danger",
                            cancelText: "取消",
                            onOk: () => deleteWorkspace(record.id),
                          });
                        }}
                      >
                        删除
                      </Button>
                    </div>
                  ),
                },
              ]}
            />
          </Card>

          {selectedWorkspace && agents.length > 0 && (
            <Card
              title={<span style={{ fontWeight: 600, color: "var(--c-text)" }}>代理配置</span>}
              style={{ borderRadius: 12, border: "1px solid var(--c-border)" }}
              bodyStyle={{ padding: 24 }}
            >
              <Table
                dataSource={agents}
                rowKey="id"
                size="small"
                pagination={false}
                columns={[
                  { title: "ID", dataIndex: "id", render: (v: string) => <span style={{ fontSize: 12, fontFamily: "monospace" }}>{v.slice(0, 12)}...</span> },
                  { title: "名称", dataIndex: "name", render: (v: string) => <span style={{ fontWeight: 500 }}>{v}</span> },
                  { title: "工作空间", dataIndex: "workspaceId", render: (v: string) => <Tag style={{ fontSize: 11 }}>{v}</Tag> },
                ]}
              />
            </Card>
          )}
        </div>
      )}

      <Drawer
        title={<span style={{ fontWeight: 600, fontSize: 16, color: "var(--c-text)" }}>新建工作空间</span>}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={420}
      >
        <Form form={form} layout="vertical" onFinish={handleCreate}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: "请输入名称" }]}>
            <Input placeholder="工作空间名称" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={2} placeholder="描述..." />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" block>创建</Button>
          </Form.Item>
        </Form>
      </Drawer>
    </PageShell>
  );
}
