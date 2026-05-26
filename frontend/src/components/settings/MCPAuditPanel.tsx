/**
 * MCPAuditPanel — v2.32 (P1 #8).
 *
 * UI surface for v2.29's MCP invocation audit ledger
 * (~/.webrain/mcp_audit.jsonl). Shows every MCP `tools/call`: tool / scope /
 * success / latency / args summary (redacted) / result preview / bearer
 * hash. Read-only audit view + filter dropdowns.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card, Select, Space, Statistic, Table, Tag, Tooltip, message } from "antd";
import { ApiOutlined, ReloadOutlined } from "@ant-design/icons";
import { api } from "../../api/client";

interface AuditEntry {
  ts: string;
  tool: string;
  scope: string;
  success: boolean;
  latency_ms: number | null;
  args_summary: Record<string, unknown>;
  result_preview: string | null;
  error: string | null;
  bearer_id: string | null;
  request_id: string | null;
}

interface Stats {
  total: number;
  by_tool: Record<string, number>;
  by_scope: Record<string, number>;
  success: number;
  failure: number;
}

interface AuditResponse {
  count: number;
  entries: AuditEntry[];
  path?: string;
  stats: Stats;
  error?: string;
}

export default function MCPAuditPanel() {
  const [data, setData] = useState<AuditResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [toolFilter, setToolFilter] = useState<string | undefined>(undefined);
  const [scopeFilter, setScopeFilter] = useState<string | undefined>(undefined);
  const [successFilter, setSuccessFilter] = useState<"all" | "true" | "false">("all");

  const refresh = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ limit: "50" });
    if (toolFilter) params.set("tool", toolFilter);
    if (scopeFilter) params.set("scope", scopeFilter);
    if (successFilter !== "all") params.set("success", successFilter);
    try {
      const res = await api.get<AuditResponse>(`/brain/audit/mcp_ledger?${params}`);
      setData(res);
    } catch (e) {
      message.error(`无法获取 MCP 审计: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [toolFilter, scopeFilter, successFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toolOptions = useMemo(() => {
    if (!data?.stats?.by_tool) return [];
    return Object.keys(data.stats.by_tool).sort();
  }, [data]);

  return (
    <Card
      title={
        <Space>
          <ApiOutlined />
          <span>MCP 调用审计</span>
          {data && (
            <Tag>
              总计 {data.stats.total} 条 · 成功 {data.stats.success} · 失败 {data.stats.failure}
            </Tag>
          )}
        </Space>
      }
      extra={
        <Tooltip title="刷新">
          <Button type="text" icon={<ReloadOutlined />} loading={loading} onClick={refresh} />
        </Tooltip>
      }
      style={{ borderRadius: 12, marginBottom: 16 }}
    >
      <p style={{ marginTop: 0, color: "var(--c-text-2)" }}>
        每次 MCP <code>tools/call</code> 调用都会记录在 <code>{data?.path ?? "~/.webrain/mcp_audit.jsonl"}</code>。
        bearer token 显示为 sha256:&lt;前12位&gt;,永不存储原始 token;参数仅 记录键 + 长度,避免泄露敏感 payload。
      </p>

      {data && (
        <Space size="middle" style={{ marginBottom: 12 }}>
          <Statistic title="工具种类" value={Object.keys(data.stats.by_tool).length} />
          <Statistic
            title="成功率"
            suffix="%"
            value={data.stats.total > 0 ? Math.round((data.stats.success / data.stats.total) * 100) : 0}
          />
        </Space>
      )}

      <Space style={{ marginBottom: 12, flexWrap: "wrap" }}>
        <Select
          placeholder="按工具过滤"
          allowClear
          style={{ width: 200 }}
          value={toolFilter}
          onChange={setToolFilter}
          options={toolOptions.map((t) => ({ value: t, label: t }))}
        />
        <Select
          placeholder="按 scope"
          allowClear
          style={{ width: 140 }}
          value={scopeFilter}
          onChange={setScopeFilter}
          options={[
            { value: "read", label: "read" },
            { value: "write", label: "write" },
          ]}
        />
        <Select
          style={{ width: 140 }}
          value={successFilter}
          onChange={(v) => setSuccessFilter(v)}
          options={[
            { value: "all", label: "全部" },
            { value: "true", label: "仅成功" },
            { value: "false", label: "仅失败" },
          ]}
        />
      </Space>

      <Table<AuditEntry>
        dataSource={data?.entries ?? []}
        rowKey={(r) => `${r.ts}-${r.tool}-${r.latency_ms ?? 0}`}
        size="small"
        loading={loading}
        pagination={{ pageSize: 10 }}
        scroll={{ x: 900 }}
        columns={[
          {
            title: "时间",
            dataIndex: "ts",
            width: 150,
            render: (v: string) => (
              <span style={{ fontSize: 11, color: "var(--c-text-3)" }}>
                {new Date(v).toLocaleString("zh-CN", { hour12: false })}
              </span>
            ),
          },
          {
            title: "工具",
            dataIndex: "tool",
            width: 140,
            render: (v: string, r) => <Tag color={r.success ? "blue" : "red"}>{v}</Tag>,
          },
          {
            title: "scope",
            dataIndex: "scope",
            width: 70,
            render: (v: string) => <Tag color={v === "write" ? "orange" : "default"}>{v}</Tag>,
          },
          {
            title: "状态",
            dataIndex: "success",
            width: 70,
            render: (v: boolean) => (v ? <Tag color="success">成功</Tag> : <Tag color="error">失败</Tag>),
          },
          {
            title: "延迟",
            dataIndex: "latency_ms",
            width: 80,
            render: (v: number | null) =>
              v == null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`,
          },
          {
            title: "bearer",
            dataIndex: "bearer_id",
            width: 130,
            render: (v: string | null) =>
              v ? <code style={{ fontSize: 11 }}>{v}</code> : <span style={{ color: "var(--c-text-3)" }}>—</span>,
          },
          {
            title: "参数 / 错误",
            render: (_: unknown, r) =>
              r.error ? (
                <Tooltip title={r.error}>
                  <span style={{ fontSize: 11, color: "#b91c1c" }}>{r.error.split(":")[0]}</span>
                </Tooltip>
              ) : (
                <Tooltip title={JSON.stringify(r.args_summary, null, 2)}>
                  <code
                    style={{
                      fontSize: 11,
                      color: "var(--c-text-2)",
                      maxWidth: 240,
                      display: "inline-block",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      verticalAlign: "bottom",
                    }}
                  >
                    {JSON.stringify(r.args_summary)}
                  </code>
                </Tooltip>
              ),
          },
        ]}
      />
    </Card>
  );
}
