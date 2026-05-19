import { useState, useEffect } from "react";
import { Button, Card, Drawer, Form, Input, Select, Table, Tag, Empty, Popconfirm } from "antd";
import { CloudOutlined, PlusOutlined, DeleteOutlined } from "@ant-design/icons";
import { PageShell } from "../components/common/PageShell";
import { useEcosystemStore } from "../stores/ecosystemStore";

const TYPE_OPTIONS = [
  { value: "agent", label: "智能体" },
  { value: "skill", label: "技能" },
  { value: "tool", label: "工具" },
  { value: "model", label: "模型" },
  { value: "dataset", label: "数据集" },
];

export default function EcosystemPage() {
  const { resources, loading, fetchResources, register, deleteResource } = useEcosystemStore();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchResources();
  }, [fetchResources]);

  const handleCreate = async (values: { name: string; type: string; owner: string }) => {
    await register({ name: values.name, type: values.type, owner: values.owner || "system" });
    setDrawerOpen(false);
    form.resetFields();
  };

  return (
    <PageShell
      title="生态"
      subtitle="资源共享与生态管理"
      icon={<CloudOutlined />}
      actions={
        <Button type="primary" icon={<PlusOutlined />} style={{ height: 40 }} onClick={() => setDrawerOpen(true)}>
          注册资源
        </Button>
      }
    >
      {resources.length === 0 ? (
        <Empty description="暂无资源" />
      ) : (
        <Card style={{ borderRadius: 12, border: "1px solid var(--c-border)" }} bodyStyle={{ padding: 24 }}>
          <Table
            dataSource={resources}
            rowKey="id"
            loading={loading}
            pagination={{ pageSize: 10 }}
            columns={[
              { title: "名称", dataIndex: "name", render: (v: string) => <span style={{ fontWeight: 500 }}>{v}</span> },
              { title: "类型", dataIndex: "type", render: (v: string) => <Tag style={{ fontSize: 11 }}>{v}</Tag> },
              { title: "所有者", dataIndex: "owner", render: (v: string) => <span style={{ fontSize: 12, color: "var(--c-text-3)" }}>{v}</span> },
              { title: "共享给", dataIndex: "sharedWith", render: (v: string[]) => (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {v?.map((s) => <Tag key={s} style={{ fontSize: 10, margin: 0 }}>{s}</Tag>)}
                </div>
              )},
              { title: "创建时间", dataIndex: "createdAt", render: (v: string) => <span style={{ fontSize: 12, color: "var(--c-text-3)" }}>{new Date(v).toLocaleString("zh-CN")}</span> },
              {
                title: "操作",
                key: "action",
                render: (_: unknown, record: { id: string; name: string }) => (
                  <Popconfirm title="确认删除" description={`删除资源 "${record.name}"？`} onConfirm={() => deleteResource(record.id)} okText="删除" cancelText="取消">
                    <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                ),
              },
            ]}
          />
        </Card>
      )}

      <Drawer
        title={<span style={{ fontWeight: 600, fontSize: 16, color: "var(--c-text)" }}>注册资源</span>}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={420}
      >
        <Form form={form} layout="vertical" onFinish={handleCreate}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: "请输入资源名称" }]}>
            <Input placeholder="资源名称" />
          </Form.Item>
          <Form.Item name="type" label="类型" rules={[{ required: true, message: "请选择类型" }]}>
            <Select placeholder="选择类型" options={TYPE_OPTIONS} />
          </Form.Item>
          <Form.Item name="owner" label="所有者" initialValue="system">
            <Input placeholder="所有者" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" block>注册</Button>
          </Form.Item>
        </Form>
      </Drawer>
    </PageShell>
  );
}
