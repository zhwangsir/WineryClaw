import { useState, useEffect } from "react";
import { Button, Card, Drawer, Form, Input, Table, Tag, Empty } from "antd";
import { SendOutlined, PlusOutlined } from "@ant-design/icons";
import { PageShell } from "../components/common/PageShell";
import { useA2aStore } from "../stores/a2aStore";

const statusColors: Record<string, string> = {
  pending: "var(--c-text-3)",
  in_progress: "var(--c-accent)",
  completed: "var(--c-success)",
  failed: "var(--c-error)",
  cancelled: "var(--c-text-3)",
};

export default function A2aPage() {
  const { tasks, loading, fetchTasks, sendTask } = useA2aStore();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  const handleSend = async (values: { senderId: string; receiverId: string; type: string }) => {
    await sendTask(values.senderId, values.receiverId, values.type);
    setDrawerOpen(false);
    form.resetFields();
  };

  return (
    <PageShell
      title="A2A"
      subtitle="Agent-to-Agent 任务协作"
      icon={<SendOutlined />}
      actions={
        <Button type="primary" icon={<PlusOutlined />} style={{ height: 40 }} onClick={() => setDrawerOpen(true)}>
          发送任务
        </Button>
      }
    >
      {tasks.length === 0 ? (
        <Empty description="暂无 A2A 任务" />
      ) : (
        <Card style={{ borderRadius: 12, border: "1px solid var(--c-border)" }} styles={{ body: { padding: 24 } }}>
          <Table
            dataSource={tasks}
            rowKey="taskId"
            loading={loading}
            pagination={{ pageSize: 10 }}
            columns={[
              { title: "Task ID", dataIndex: "taskId", render: (v: string) => <span style={{ fontSize: 12, fontFamily: "monospace" }}>{v.slice(0, 16)}...</span> },
              { title: "Agent", dataIndex: "agentId", render: (v: string) => <span style={{ fontSize: 12, color: "var(--c-text-3)" }}>{v}</span> },
              { title: "类型", dataIndex: "type", render: (v: string) => <Tag style={{ fontSize: 11 }}>{v}</Tag> },
              { title: "状态", dataIndex: "status", render: (v: string) => (
                <Tag style={{ color: statusColors[v] || "var(--c-text-3)", border: "none", background: "var(--c-hover)", fontSize: 12 }}>{v}</Tag>
              )},
              { title: "创建时间", dataIndex: "createdAt", render: (v: string) => <span style={{ fontSize: 12, color: "var(--c-text-3)" }}>{new Date(v).toLocaleString("zh-CN")}</span> },
            ]}
          />
        </Card>
      )}

      <Drawer
        title={<span style={{ fontWeight: 600, fontSize: 16, color: "var(--c-text)" }}>发送 A2A 任务</span>}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={420}
      >
        <Form form={form} layout="vertical" onFinish={handleSend}>
          <Form.Item name="senderId" label="发送方 ID" rules={[{ required: true }]}>
            <Input placeholder="发送 Agent ID" />
          </Form.Item>
          <Form.Item name="receiverId" label="接收方 ID" rules={[{ required: true }]}>
            <Input placeholder="接收 Agent ID" />
          </Form.Item>
          <Form.Item name="type" label="任务类型" rules={[{ required: true }]}>
            <Input placeholder="例如: delegate, request" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" block>发送</Button>
          </Form.Item>
        </Form>
      </Drawer>
    </PageShell>
  );
}
