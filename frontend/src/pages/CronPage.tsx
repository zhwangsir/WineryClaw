import { useState, useEffect } from "react";
import {
  Table,
  Button,
  Tag,
  Modal,
  Form,
  Input,
  InputNumber,
  Switch,
  Select,
  Empty,
  Spin,
  Card,
  Statistic,
  Row,
  Col,
  Drawer,
  Popconfirm,
} from "antd";
import {
  ClockCircleOutlined,
  PlusOutlined,
  PlayCircleOutlined,
  PauseCircleOutlined,
  DeleteOutlined,
  HistoryOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
} from "@ant-design/icons";
import { PageShell } from "../components/common/PageShell";
import { useCronStore } from "../stores/cronStore";

export default function CronPage() {
  const { jobs, runs, stats, loading, fetchJobs, createJob, enableJob, disableJob, deleteJob, fetchRuns, fetchStats } =
    useCronStore();

  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm();
  const [runsDrawerOpen, setRunsDrawerOpen] = useState(false);

  useEffect(() => {
    fetchJobs();
    fetchStats();
  }, [fetchJobs, fetchStats]);

  const handleCreate = async () => {
    const values = await form.validateFields();
    await createJob(values);
    setModalOpen(false);
    form.resetFields();
  };

  const openRuns = async () => {
    await fetchRuns();
    setRunsDrawerOpen(true);
  };

  const columns = [
    {
      title: "名称",
      dataIndex: "name",
      width: 180,
      render: (v: string) => <span style={{ fontWeight: 600, color: "var(--c-text)" }}>{v}</span>,
    },
    {
      title: "Cron 表达式",
      dataIndex: "cron_expr",
      render: (v: string) => (
        <code
          style={{
            fontSize: 12,
            background: "var(--c-hover)",
            padding: "3px 8px",
            borderRadius: 6,
            border: "1px solid var(--c-border)",
            color: "var(--c-text-2)",
          }}
        >
          {v}
        </code>
      ),
    },
    {
      title: "任务类型",
      dataIndex: "task_type",
      width: 120,
      render: (v: string) => <span style={{ color: "var(--c-text-2)", fontSize: 13 }}>{v}</span>,
    },
    {
      title: "状态",
      dataIndex: "enabled",
      width: 80,
      render: (v: boolean) => (
        <Tag
          style={{
            background: v ? "var(--c-success)" : "transparent",
            color: v ? "#ffffff" : "var(--c-text-3)",
            border: v ? "none" : "1px solid var(--c-border)",
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 400,
          }}
        >
          {v ? "启用" : "禁用"}
        </Tag>
      ),
    },
    {
      title: "最后运行",
      dataIndex: "last_run",
      width: 160,
      render: (v?: string) => (
        <span style={{ color: "var(--c-text-3)", fontSize: 13, fontWeight: 300 }}>
          {v ? new Date(v).toLocaleString() : "—"}
        </span>
      ),
    },
    {
      title: "下次运行",
      dataIndex: "next_run",
      width: 160,
      render: (v?: string) => (
        <span style={{ color: "var(--c-text-3)", fontSize: 13, fontWeight: 300 }}>
          {v ? new Date(v).toLocaleString() : "—"}
        </span>
      ),
    },
    {
      title: "运行次数",
      dataIndex: "run_count",
      width: 90,
      align: "center" as const,
      render: (v: number) => <span style={{ fontWeight: 600, color: "var(--c-text)" }}>{v}</span>,
    },
    {
      title: "操作",
      width: 120,
      align: "center" as const,
      render: (_: any, record: any) => (
        <div style={{ display: "flex", gap: 4, justifyContent: "center" }}>
          {record.enabled ? (
            <Button
              type="text"
              size="small"
              icon={<PauseCircleOutlined />}
              onClick={() => disableJob(record.id)}
              style={{ color: "var(--c-text-3)" }}
            />
          ) : (
            <Button
              type="text"
              size="small"
              icon={<PlayCircleOutlined />}
              onClick={() => enableJob(record.id)}
              style={{ color: "var(--c-accent)" }}
            />
          )}
          <Popconfirm
            title="确认删除任务"
            description={`删除任务 "${record.name}"？此操作不可撤销。`}
            onConfirm={() => deleteJob(record.id)}
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true, size: "small" }}
            icon={<ExclamationCircleOutlined style={{ color: "var(--c-error)" }} />}
          >
            <Button type="text" size="small" icon={<DeleteOutlined />} style={{ color: "var(--c-text-3)" }} />
          </Popconfirm>
        </div>
      ),
    },
  ];

  return (
    <PageShell title="定时任务" subtitle="Cron 任务调度管理" icon={<ClockCircleOutlined />}>
      {/* Stats */}
      <Row gutter={[24, 24]} style={{ marginBottom: 48 }}>
        <Col xs={12} md={6}>
          <Card
            style={{ borderRadius: 12, border: "1px solid var(--c-border)", boxShadow: "var(--shadow)" }}
            styles={{ body: { padding: 32 } }}
          >
            <Statistic
              title="任务数"
              value={stats?.total_jobs || jobs.length}
              prefix={<ClockCircleOutlined style={{ color: "var(--c-text-2)" }} />}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card
            style={{ borderRadius: 12, border: "1px solid var(--c-border)", boxShadow: "var(--shadow)" }}
            styles={{ body: { padding: 32 } }}
          >
            <Statistic
              title="启用中"
              value={stats?.enabled_jobs || jobs.filter((j) => j.enabled).length}
              prefix={<CheckCircleOutlined style={{ color: "var(--c-text-2)" }} />}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card
            style={{ borderRadius: 12, border: "1px solid var(--c-border)", boxShadow: "var(--shadow)" }}
            styles={{ body: { padding: 32 } }}
          >
            <Statistic
              title="总运行次数"
              value={stats?.total_runs || runs.length}
              prefix={<HistoryOutlined style={{ color: "var(--c-text-2)" }} />}
            />
          </Card>
        </Col>
      </Row>

      {/* Toolbar */}
      <div style={{ display: "flex", gap: 12, marginBottom: 32 }}>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setModalOpen(true)}
          style={{ height: 40, fontWeight: 600 }}
        >
          新建任务
        </Button>
        <Button icon={<HistoryOutlined />} onClick={openRuns} style={{ height: 40 }}>
          运行历史
        </Button>
      </div>

      {/* Jobs table */}
      {loading && jobs.length === 0 ? (
        <div style={{ textAlign: "center", padding: 80 }}>
          <Spin size="large" />
        </div>
      ) : jobs.length === 0 ? (
        <Empty
          description={<span style={{ color: "var(--c-text-3)", fontSize: 14, fontWeight: 300 }}>暂无定时任务</span>}
        />
      ) : (
        <Table size="small" rowKey="id" columns={columns} dataSource={jobs} pagination={{ pageSize: 10 }} />
      )}

      {/* Create Modal */}
      <Modal
        open={modalOpen}
        title={<span style={{ fontWeight: 600, fontSize: 16, color: "var(--c-text)" }}>新建定时任务</span>}
        onCancel={() => setModalOpen(false)}
        onOk={handleCreate}
        okText="创建"
        width={560}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item label="名称" name="name" rules={[{ required: true }]}>
            <Input placeholder="例如: 每日数据备份" />
          </Form.Item>
          <Form.Item label="Cron 表达式" name="cron_expr" rules={[{ required: true }]}>
            <Input placeholder="0 0 * * * (每天零点)" />
          </Form.Item>
          <Form.Item label="任务类型" name="task_type" rules={[{ required: true }]}>
            <Select
              placeholder="选择任务类型"
              options={[
                { label: "Shell 命令", value: "shell" },
                { label: "HTTP 请求", value: "http" },
                { label: "Python 脚本", value: "python" },
                { label: "记忆归档", value: "archive" },
              ]}
            />
          </Form.Item>
          <Form.Item label="任务参数 (JSON)" name="task_params">
            <Input.TextArea rows={3} placeholder='{"command": "echo hello"}' />
          </Form.Item>
          <Form.Item label="最大重试次数" name="max_retries" initialValue={3}>
            <InputNumber min={0} max={10} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="启用" name="enabled" valuePropName="checked" initialValue={true}>
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      {/* Runs Drawer */}
      <Drawer
        title={<span style={{ fontWeight: 600, fontSize: 16, color: "var(--c-text)" }}>运行历史</span>}
        open={runsDrawerOpen}
        onClose={() => setRunsDrawerOpen(false)}
        width={520}
      >
        {runs.length === 0 ? (
          <Empty
            description={<span style={{ color: "var(--c-text-3)", fontSize: 14, fontWeight: 300 }}>暂无运行记录</span>}
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {runs.map((run: any, i: number) => (
              <div
                key={i}
                style={{
                  padding: 16,
                  borderRadius: 10,
                  background: "var(--c-card)",
                  border: "1px solid var(--c-border)",
                  boxShadow: "var(--shadow)",
                }}
              >
                <div
                  style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, alignItems: "center" }}
                >
                  <Tag
                    style={{
                      background: run.status === "success" ? "var(--c-success)" : "var(--c-error)",
                      color: "#ffffff",
                      border: "none",
                      borderRadius: 6,
                      fontSize: 12,
                      fontWeight: 400,
                    }}
                  >
                    {run.status || "unknown"}
                  </Tag>
                  <span style={{ fontSize: 12, color: "var(--c-text-3)", fontWeight: 300 }}>
                    {run.started_at ? new Date(run.started_at).toLocaleString() : "—"}
                  </span>
                </div>
                <div style={{ fontSize: 13, color: "var(--c-text)", fontWeight: 400 }}>
                  {run.job_name || run.job_id}
                </div>
                {run.output && (
                  <div
                    style={{
                      marginTop: 6,
                      fontSize: 12,
                      color: "var(--c-text-2)",
                      fontWeight: 300,
                      fontFamily: "monospace",
                      lineHeight: 1.5,
                    }}
                  >
                    {String(run.output).slice(0, 200)}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Drawer>
    </PageShell>
  );
}
