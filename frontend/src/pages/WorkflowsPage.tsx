import { useState, useEffect } from "react";
import { Button, Card, Drawer, Form, Input, Tag, Empty, message, Popconfirm, Table } from "antd";
import {
  PlusOutlined,
  DeleteOutlined,
  PlayCircleOutlined,
  BranchesOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ClockCircleOutlined,
} from "@ant-design/icons";
import { PageShell } from "../components/common/PageShell";
import { useWorkflowStore } from "../stores/workflowStore";
import type { WorkflowDef } from "../api/types";

const statusColors: Record<string, string> = {
  pending: "var(--c-text-3)",
  running: "var(--c-accent)",
  completed: "var(--c-success)",
  failed: "var(--c-error)",
  cancelled: "var(--c-text-3)",
};

const statusIcons: Record<string, React.ReactNode> = {
  pending: <ClockCircleOutlined />,
  running: <ClockCircleOutlined />,
  completed: <CheckCircleOutlined />,
  failed: <CloseCircleOutlined />,
  cancelled: <CloseCircleOutlined />,
};

export default function WorkflowsPage() {
  const { workflows, runs, fetchWorkflows, createWorkflow, deleteWorkflow, runWorkflow, fetchRuns } =
    useWorkflowStore();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [runDrawerOpen, setRunDrawerOpen] = useState(false);
  const [selectedWorkflow, setSelectedWorkflow] = useState<WorkflowDef | null>(null);
  const [form] = Form.useForm();
  const [runForm] = Form.useForm();

  useEffect(() => {
    fetchWorkflows();
  }, [fetchWorkflows]);

  const handleCreate = async (values: Partial<WorkflowDef>) => {
    await createWorkflow({ ...values, nodes: [], edges: [] });
    setDrawerOpen(false);
    form.resetFields();
  };

  const openRun = (w: WorkflowDef) => {
    setSelectedWorkflow(w);
    setRunDrawerOpen(true);
    runForm.resetFields();
    fetchRuns(w.id);
  };

  const handleRun = async (values: { inputs: string }) => {
    if (!selectedWorkflow) return;
    let inputs: Record<string, unknown>;
    try {
      inputs = values.inputs ? JSON.parse(values.inputs) : {};
    } catch {
      message.error("输入必须是有效的 JSON");
      return;
    }
    await runWorkflow(selectedWorkflow.id, inputs);
    setRunDrawerOpen(false);
  };

  return (
    <PageShell
      title="工作流"
      subtitle="可视化工作流编排与执行"
      icon={<BranchesOutlined />}
      actions={
        <Button type="primary" icon={<PlusOutlined />} style={{ height: 40 }} onClick={() => setDrawerOpen(true)}>
          新建工作流
        </Button>
      }
    >
      {workflows.length === 0 ? (
        <Empty description={<span style={{ color: "var(--c-text-3)" }}>暂无工作流</span>} />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 20 }}>
          {workflows.map((w) => (
            <Card
              key={w.id}
              style={{ borderRadius: 12, border: "1px solid var(--c-border)", boxShadow: "var(--shadow)" }}
              styles={{
                body: { padding: 24 },
                header: { padding: "16px 20px", borderBottom: "1px solid var(--c-border)" },
              }}
              title={<span style={{ fontWeight: 600, fontSize: 15, color: "var(--c-text)" }}>{w.name}</span>}
              actions={[
                <Button
                  key="run"
                  type="text"
                  size="small"
                  icon={<PlayCircleOutlined />}
                  style={{ color: "var(--c-accent)" }}
                  onClick={() => openRun(w)}
                >
                  运行
                </Button>,
                <Popconfirm
                  key="delete"
                  title="确认删除"
                  description={`删除工作流 "${w.name}"？`}
                  onConfirm={() => deleteWorkflow(w.id)}
                  okText="删除"
                  cancelText="取消"
                >
                  <Button type="text" size="small" danger icon={<DeleteOutlined />}>
                    删除
                  </Button>
                </Popconfirm>,
              ]}
            >
              <div style={{ fontSize: 13, color: "var(--c-text-2)", marginBottom: 12, minHeight: 20 }}>
                {w.description || "无描述"}
              </div>
              <div style={{ display: "flex", gap: 12, fontSize: 12, color: "var(--c-text-3)" }}>
                <span>节点: {w.nodes?.length || 0}</span>
                <span>边: {w.edges?.length || 0}</span>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Create Drawer */}
      <Drawer
        title={<span style={{ fontWeight: 600, fontSize: 16, color: "var(--c-text)" }}>新建工作流</span>}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={480}
      >
        <Form form={form} layout="vertical" onFinish={handleCreate}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: "请输入工作流名称" }]}>
            <Input placeholder="工作流名称" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={2} placeholder="工作流描述..." />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" block>
              创建
            </Button>
          </Form.Item>
        </Form>
      </Drawer>

      {/* Run Drawer */}
      <Drawer
        title={
          <span style={{ fontWeight: 600, fontSize: 16, color: "var(--c-text)" }}>运行: {selectedWorkflow?.name}</span>
        }
        open={runDrawerOpen}
        onClose={() => setRunDrawerOpen(false)}
        width={560}
      >
        <Form form={runForm} layout="vertical" onFinish={handleRun}>
          <Form.Item name="inputs" label="输入参数 (JSON)" initialValue="{}">
            <Input.TextArea rows={4} placeholder='{"key": "value"}' />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" icon={<PlayCircleOutlined />} block>
              运行
            </Button>
          </Form.Item>
        </Form>

        {runs.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 12, color: "var(--c-text)" }}>历史运行</div>
            <Table
              dataSource={runs}
              rowKey="runId"
              size="small"
              pagination={false}
              columns={[
                {
                  title: "Run ID",
                  dataIndex: "runId",
                  render: (v: string) => (
                    <span style={{ fontSize: 12, fontFamily: "monospace" }}>{v.slice(0, 12)}...</span>
                  ),
                },
                {
                  title: "状态",
                  dataIndex: "status",
                  render: (v: string) => (
                    <Tag
                      style={{
                        color: statusColors[v] || "var(--c-text-3)",
                        border: "none",
                        background: "var(--c-hover)",
                        fontSize: 12,
                      }}
                    >
                      {statusIcons[v]} {v}
                    </Tag>
                  ),
                },
                {
                  title: "开始时间",
                  dataIndex: "startedAt",
                  render: (v: string) => (
                    <span style={{ fontSize: 12, color: "var(--c-text-3)" }}>
                      {new Date(v).toLocaleString("zh-CN")}
                    </span>
                  ),
                },
              ]}
            />
          </div>
        )}
      </Drawer>
    </PageShell>
  );
}
