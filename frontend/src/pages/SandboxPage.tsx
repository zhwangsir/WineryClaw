import { useState, useEffect } from "react";
import { Button, Card, Input, Tag, Empty, Table, Statistic, Row, Col } from "antd";
import { SafetyOutlined, PlayCircleOutlined, CodeOutlined, ClearOutlined } from "@ant-design/icons";
import { PageShell } from "../components/common/PageShell";
import { useSandboxStore } from "../stores/sandboxStore";

export default function SandboxPage() {
  const { available, stats, logs, fetchStatus, fetchStats, fetchAudit, execute, executePython } =
    useSandboxStore();

  const [command, setCommand] = useState("");
  const [pythonCode, setPythonCode] = useState("print('Hello from sandbox')");
  const [execResult, setExecResult] = useState<{ stdout: string; stderr: string; exitCode: number } | null>(null);
  const [execLoading, setExecLoading] = useState(false);

  useEffect(() => {
    fetchStatus();
    fetchStats();
    fetchAudit(undefined, 50);
  }, [fetchStatus, fetchStats, fetchAudit]);

  const handleExecute = async () => {
    if (!command.trim()) return;
    setExecLoading(true);
    const res = await execute(command);
    if (res) setExecResult(res);
    setExecLoading(false);
  };

  const handleExecutePython = async () => {
    if (!pythonCode.trim()) return;
    setExecLoading(true);
    const res = await executePython(pythonCode);
    if (res) setExecResult(res);
    setExecLoading(false);
  };

  return (
    <PageShell
      title="沙箱"
      subtitle="Docker 沙箱执行环境与审计日志"
      icon={<SafetyOutlined />}
    >
      {/* Status */}
      <Row gutter={[24, 24]} style={{ marginBottom: 32 }}>
        <Col xs={12} md={6}>
          <Card style={{ borderRadius: 12, border: "1px solid var(--c-border)" }} bodyStyle={{ padding: 24 }}>
            <Statistic
              title="沙箱状态"
              value={available ? "可用" : "不可用"}
              valueStyle={{ color: available ? "var(--c-success)" : "var(--c-error)", fontSize: 18 }}
            />
          </Card>
        </Col>
        {Object.entries(stats).map(([key, value]) => (
          <Col xs={12} md={6} key={key}>
            <Card style={{ borderRadius: 12, border: "1px solid var(--c-border)" }} bodyStyle={{ padding: 24 }}>
              <Statistic title={key} value={value} />
            </Card>
          </Col>
        ))}
      </Row>

      {/* Execution */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(400px, 1fr))", gap: 24, marginBottom: 32 }}>
        <Card
          title={<span style={{ fontWeight: 600, color: "var(--c-text)" }}><CodeOutlined style={{ marginRight: 8 }} />Shell 命令</span>}
          style={{ borderRadius: 12, border: "1px solid var(--c-border)" }}
          bodyStyle={{ padding: 24 }}
        >
          <Input.TextArea
            rows={3}
            placeholder="输入 shell 命令..."
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            style={{ marginBottom: 12 }}
          />
          <Button type="primary" icon={<PlayCircleOutlined />} onClick={handleExecute} loading={execLoading} disabled={!available}>
            执行
          </Button>
        </Card>

        <Card
          title={<span style={{ fontWeight: 600, color: "var(--c-text)" }}><CodeOutlined style={{ marginRight: 8 }} />Python 代码</span>}
          style={{ borderRadius: 12, border: "1px solid var(--c-border)" }}
          bodyStyle={{ padding: 24 }}
        >
          <Input.TextArea
            rows={3}
            placeholder="输入 Python 代码..."
            value={pythonCode}
            onChange={(e) => setPythonCode(e.target.value)}
            style={{ marginBottom: 12, fontFamily: "monospace" }}
          />
          <Button type="primary" icon={<PlayCircleOutlined />} onClick={handleExecutePython} loading={execLoading} disabled={!available}>
            执行
          </Button>
        </Card>
      </div>

      {/* Result */}
      {execResult && (
        <Card
          style={{ marginBottom: 32, borderRadius: 12, border: "1px solid var(--c-border)" }}
          bodyStyle={{ padding: 24 }}
          title={
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontWeight: 600, color: "var(--c-text)" }}>执行结果</span>
              <Tag color={execResult.exitCode === 0 ? "success" : "error"}>Exit: {execResult.exitCode}</Tag>
            </div>
          }
        >
          {execResult.stdout && (
            <pre style={{ background: "var(--c-hover)", padding: 12, borderRadius: 8, fontSize: 12, overflow: "auto", maxHeight: 200 }}>
              {execResult.stdout}
            </pre>
          )}
          {execResult.stderr && (
            <pre style={{ background: "#fff1f0", padding: 12, borderRadius: 8, fontSize: 12, color: "#cf1322", overflow: "auto", maxHeight: 200, marginTop: 8 }}>
              {execResult.stderr}
            </pre>
          )}
        </Card>
      )}

      {/* Audit logs */}
      <Card
        title={<span style={{ fontWeight: 600, color: "var(--c-text)" }}>审计日志</span>}
        style={{ borderRadius: 12, border: "1px solid var(--c-border)" }}
        bodyStyle={{ padding: 24 }}
        extra={
          <Button size="small" icon={<ClearOutlined />} onClick={() => fetchAudit(undefined, 50)}>刷新</Button>
        }
      >
        {logs.length === 0 ? (
          <Empty description="暂无审计日志" />
        ) : (
          <Table
            dataSource={logs}
            rowKey={(r, i) => `${r.agentId}-${r.timestamp}-${i}`}
            size="small"
            pagination={{ pageSize: 10 }}
            columns={[
              { title: "Agent", dataIndex: "agentId", render: (v: string) => <span style={{ fontSize: 12, fontFamily: "monospace" }}>{v}</span> },
              { title: "操作", dataIndex: "action", render: (v: string) => <Tag style={{ fontSize: 11 }}>{v}</Tag> },
              { title: "时间", dataIndex: "timestamp", render: (v: string) => <span style={{ fontSize: 12, color: "var(--c-text-3)" }}>{new Date(v).toLocaleString("zh-CN")}</span> },
            ]}
          />
        )}
      </Card>
    </PageShell>
  );
}
