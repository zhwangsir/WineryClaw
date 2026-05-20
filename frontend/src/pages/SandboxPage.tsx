import { useState, useEffect } from "react";
import { Button, Card, Input, Tag, Empty, Table, Statistic, Row, Col, Switch, Modal, Popconfirm } from "antd";
import {
  SafetyOutlined,
  PlayCircleOutlined,
  CodeOutlined,
  ClearOutlined,
  PlusOutlined,
  DeleteOutlined,
  GlobalOutlined,
} from "@ant-design/icons";
import { PageShell } from "../components/common/PageShell";
import { useSandboxStore } from "../stores/sandboxStore";

export default function SandboxPage() {
  const {
    available,
    stats,
    logs,
    workspaces,
    defaultImage,
    fetchStatus,
    fetchStats,
    fetchAudit,
    fetchWorkspaces,
    execute,
    executePython,
    createWorkspace,
    execInWorkspace,
    removeWorkspace,
  } = useSandboxStore();

  const [command, setCommand] = useState("");
  const [pythonCode, setPythonCode] = useState("print('Hello from sandbox')");
  const [execResult, setExecResult] = useState<{ stdout: string; stderr: string; exitCode: number } | null>(null);
  const [execLoading, setExecLoading] = useState(false);

  // Workspace UI state (Round J1)
  const [createOpen, setCreateOpen] = useState(false);
  const [newWsId, setNewWsId] = useState("");
  const [newWsNetwork, setNewWsNetwork] = useState(false);
  const [wsCommand, setWsCommand] = useState<Record<string, string>>({});
  const [wsResult, setWsResult] = useState<
    Record<string, { ok: boolean; output: string; exitCode: number; error?: string }>
  >({});
  const [wsLoading, setWsLoading] = useState<Record<string, boolean>>({});

  useEffect(() => {
    fetchStatus();
    fetchStats();
    fetchAudit(undefined, 50);
    fetchWorkspaces();
  }, [fetchStatus, fetchStats, fetchAudit, fetchWorkspaces]);

  const handleCreateWorkspace = async () => {
    const id = newWsId.trim();
    if (!id) return;
    const ok = await createWorkspace(id, { network: newWsNetwork });
    if (ok) {
      setCreateOpen(false);
      setNewWsId("");
      setNewWsNetwork(false);
    }
  };

  const handleWorkspaceExec = async (workspaceId: string) => {
    const cmd = (wsCommand[workspaceId] ?? "").trim();
    if (!cmd) return;
    setWsLoading((p) => ({ ...p, [workspaceId]: true }));
    const res = await execInWorkspace(workspaceId, cmd);
    setWsLoading((p) => ({ ...p, [workspaceId]: false }));
    if (res) setWsResult((p) => ({ ...p, [workspaceId]: res }));
  };

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
    <PageShell title="沙箱" subtitle="Docker 沙箱执行环境与审计日志" icon={<SafetyOutlined />}>
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
        {Object.entries(stats).map(([key, value]) => {
          // Round Q7.3 — translate raw API keys (totalPolicies, etc.) to
          // readable Chinese labels. Falls back to title-cased key if a
          // new field shows up that we haven't mapped yet.
          const LABELS: Record<string, string> = {
            totalPolicies: "策略总数",
            activeSessions: "活跃会话",
            totalAuditLogs: "审计日志",
            blockedActions: "已阻止操作",
            // Defensive aliases — backend has shipped both camelCase and
            // lowercased variants over time; treat both the same.
            TOTALPOLICIES: "策略总数",
            ACTIVESESSIONS: "活跃会话",
            TOTALAUDITLOGS: "审计日志",
            BLOCKEDACTIONS: "已阻止操作",
          };
          const niceTitle =
            LABELS[key] ??
            // Title-case fallback: split camelCase / underscores into words
            key
              .replace(/([a-z])([A-Z])/g, "$1 $2")
              .replace(/_/g, " ")
              .replace(/\b\w/g, (c) => c.toUpperCase());
          return (
            <Col xs={12} md={6} key={key}>
              <Card style={{ borderRadius: 12, border: "1px solid var(--c-border)" }} bodyStyle={{ padding: 24 }}>
                <Statistic title={niceTitle} value={value} />
              </Card>
            </Col>
          );
        })}
      </Row>

      {/* Execution */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(400px, 1fr))",
          gap: 24,
          marginBottom: 32,
        }}
      >
        <Card
          title={
            <span style={{ fontWeight: 600, color: "var(--c-text)" }}>
              <CodeOutlined style={{ marginRight: 8 }} />
              Shell 命令
            </span>
          }
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
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            onClick={handleExecute}
            loading={execLoading}
            disabled={!available}
          >
            执行
          </Button>
        </Card>

        <Card
          title={
            <span style={{ fontWeight: 600, color: "var(--c-text)" }}>
              <CodeOutlined style={{ marginRight: 8 }} />
              Python 代码
            </span>
          }
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
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            onClick={handleExecutePython}
            loading={execLoading}
            disabled={!available}
          >
            执行
          </Button>
        </Card>
      </div>

      {/* Workspaces (Round J1) — persistent stateful containers */}
      <Card
        title={
          <span style={{ fontWeight: 600, color: "var(--c-text)" }}>
            <SafetyOutlined style={{ marginRight: 8 }} />
            持久工作区
            <Tag style={{ marginLeft: 10, fontSize: 11, fontWeight: 400 }} color="processing">
              J1
            </Tag>
          </span>
        }
        style={{ marginBottom: 32, borderRadius: 12, border: "1px solid var(--c-border)" }}
        bodyStyle={{ padding: 24 }}
        extra={
          <Button
            type="primary"
            size="small"
            icon={<PlusOutlined />}
            onClick={() => setCreateOpen(true)}
            disabled={!available}
          >
            新建工作区
          </Button>
        }
      >
        <p style={{ color: "var(--c-text-3)", fontSize: 12, marginTop: 0, marginBottom: 8 }}>
          长寿命容器 + 持久挂载 (<code>~/.webrain/workspaces/&lt;id&gt;/</code>)。文件、`apt-get install`、`pip install`
          会跨调用保留。可选放开网络。
        </p>
        {defaultImage && (
          <p style={{ fontSize: 12, marginTop: 0, marginBottom: 16 }}>
            {defaultImage === "webrain-workspace:latest" ? (
              <span style={{ color: "var(--c-text-2)" }}>
                默认镜像:<code>{defaultImage}</code>
                <Tag color="success" style={{ marginLeft: 8, fontSize: 11 }}>
                  已就绪
                </Tag>
              </span>
            ) : (
              <span style={{ color: "var(--c-text-3)" }}>
                默认镜像:<code>{defaultImage}</code> (回退) ·{" "}
                <span style={{ color: "var(--c-text-2)" }}>
                  跑 <code>./sub-brain/docker/workspace/build.sh</code> 构建 ubuntu 镜像可解锁 apt-get / pip / ffmpeg
                </span>
              </span>
            )}
          </p>
        )}

        {workspaces.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无工作区" />
        ) : (
          <div style={{ display: "grid", gap: 16 }}>
            {workspaces.map((ws) => {
              const result = wsResult[ws.workspaceId];
              return (
                <Card
                  key={ws.workspaceId}
                  size="small"
                  style={{ background: "var(--c-card)", border: "1px solid var(--c-border-light)" }}
                  bodyStyle={{ padding: 16 }}
                >
                  <div
                    style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}
                  >
                    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                      <span style={{ fontWeight: 600, fontFamily: "monospace" }}>{ws.workspaceId}</span>
                      <Tag style={{ fontSize: 11 }}>{ws.image}</Tag>
                      <Tag style={{ fontSize: 11 }}>
                        {ws.memory} / {ws.cpus} CPU
                      </Tag>
                      {ws.network ? (
                        <Tag color="warning" icon={<GlobalOutlined />} style={{ fontSize: 11 }}>
                          联网
                        </Tag>
                      ) : (
                        <Tag style={{ fontSize: 11 }}>无网络</Tag>
                      )}
                    </div>
                    <Popconfirm
                      title={`删除工作区 ${ws.workspaceId}?`}
                      description="容器会被销毁,但 host 目录文件保留。"
                      okText="删除"
                      okType="danger"
                      cancelText="取消"
                      onConfirm={() => removeWorkspace(ws.workspaceId)}
                    >
                      <Button size="small" type="text" icon={<DeleteOutlined />} danger>
                        删除
                      </Button>
                    </Popconfirm>
                  </div>
                  <div style={{ display: "flex", gap: 8, marginBottom: result ? 12 : 0 }}>
                    <Input
                      placeholder="ls / pip install / apt update && apt install -y curl …"
                      value={wsCommand[ws.workspaceId] ?? ""}
                      onChange={(e) => setWsCommand((p) => ({ ...p, [ws.workspaceId]: e.target.value }))}
                      onPressEnter={() => handleWorkspaceExec(ws.workspaceId)}
                      style={{ fontFamily: "monospace", fontSize: 13 }}
                    />
                    <Button
                      type="primary"
                      icon={<PlayCircleOutlined />}
                      loading={wsLoading[ws.workspaceId]}
                      onClick={() => handleWorkspaceExec(ws.workspaceId)}
                    >
                      执行
                    </Button>
                  </div>
                  {result && (
                    <pre
                      style={{
                        background: result.exitCode === 0 ? "var(--c-hover)" : "#fff1f0",
                        color: result.exitCode === 0 ? "var(--c-text)" : "#cf1322",
                        padding: 10,
                        borderRadius: 6,
                        fontSize: 12,
                        margin: 0,
                        overflow: "auto",
                        maxHeight: 200,
                      }}
                    >
                      {result.output || result.error || "(no output)"}
                      {result.exitCode !== 0 ? `\n[exit ${result.exitCode}]` : ""}
                    </pre>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </Card>

      {/* Create-workspace modal */}
      <Modal
        title="新建持久工作区"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={handleCreateWorkspace}
        okText="创建"
        cancelText="取消"
        okButtonProps={{ disabled: !newWsId.trim() }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <div style={{ fontSize: 13, marginBottom: 6, color: "var(--c-text-2)" }}>工作区 ID</div>
            <Input
              autoFocus
              placeholder="字母数字/-/_,最多 64 字符,例如 dev-001"
              value={newWsId}
              onChange={(e) => setNewWsId(e.target.value)}
              maxLength={64}
            />
            <div style={{ fontSize: 11, color: "var(--c-text-3)", marginTop: 4 }}>
              容器名将是 <code>webrain-ws-{newWsId || "&lt;id&gt;"}</code>,host 目录{" "}
              <code>~/.webrain/workspaces/{newWsId || "&lt;id&gt;"}/</code>
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 13, color: "var(--c-text-2)" }}>允许访问网络</div>
              <div style={{ fontSize: 11, color: "var(--c-text-3)" }}>
                关闭 = <code>--network none</code> (推荐) · 开启 = 可 curl / apt-get
              </div>
            </div>
            <Switch checked={newWsNetwork} onChange={setNewWsNetwork} />
          </div>
        </div>
      </Modal>

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
            <pre
              style={{
                background: "var(--c-hover)",
                padding: 12,
                borderRadius: 8,
                fontSize: 12,
                overflow: "auto",
                maxHeight: 200,
              }}
            >
              {execResult.stdout}
            </pre>
          )}
          {execResult.stderr && (
            <pre
              style={{
                background: "#fff1f0",
                padding: 12,
                borderRadius: 8,
                fontSize: 12,
                color: "#cf1322",
                overflow: "auto",
                maxHeight: 200,
                marginTop: 8,
              }}
            >
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
          <Button size="small" icon={<ClearOutlined />} onClick={() => fetchAudit(undefined, 50)}>
            刷新
          </Button>
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
              {
                title: "Agent",
                dataIndex: "agentId",
                render: (v: string) => <span style={{ fontSize: 12, fontFamily: "monospace" }}>{v}</span>,
              },
              { title: "操作", dataIndex: "action", render: (v: string) => <Tag style={{ fontSize: 11 }}>{v}</Tag> },
              {
                title: "时间",
                dataIndex: "timestamp",
                render: (v: string) => (
                  <span style={{ fontSize: 12, color: "var(--c-text-3)" }}>{new Date(v).toLocaleString("zh-CN")}</span>
                ),
              },
            ]}
          />
        )}
      </Card>
    </PageShell>
  );
}
