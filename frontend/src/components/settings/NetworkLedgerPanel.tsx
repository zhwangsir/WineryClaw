/**
 * NetworkLedgerPanel — v2.32 (P1 #8).
 *
 * UI surface for v2.16's network audit ledger (~/.webrain/network_ledger.jsonl).
 * Shows every outbound LLM HTTP call: endpoint / model / success / latency /
 * payload sizes / error. Read-only — purely user-visible audit.
 */
import { useCallback, useEffect, useState } from "react";
import { Button, Card, Space, Table, Tag, Tooltip, message } from "antd";
import { CloudOutlined, ReloadOutlined } from "@ant-design/icons";
import { api } from "../../api/client";

interface LedgerEntry {
  ts: string;
  event: string;
  endpoint: string;
  base_url: string;
  model: string;
  success: boolean;
  latency_ms: number | null;
  request_bytes: number | null;
  response_bytes: number | null;
  error: string | null;
}

interface LedgerResponse {
  count: number;
  total: number;
  entries: LedgerEntry[];
  path?: string;
  error?: string;
}

function fmtBytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fmtMs(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(2)} s`;
  return `${Math.round(n)} ms`;
}

export default function NetworkLedgerPanel() {
  const [data, setData] = useState<LedgerResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<LedgerResponse>("/brain/audit/network_ledger?limit=50");
      setData(res);
    } catch (e) {
      message.error(`无法获取网络审计: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const total = data?.total ?? 0;
  const successCount = data?.entries.filter((e) => e.success).length ?? 0;
  const failureCount = (data?.entries.length ?? 0) - successCount;

  return (
    <Card
      title={
        <Space>
          <CloudOutlined />
          <span>网络出站审计</span>
          {data && (
            <Tag>
              {data.entries.length} 条 / 总计 {total}
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
        所有外发 LLM HTTP 请求都会记录在 <code>{data?.path ?? "~/.webrain/network_ledger.jsonl"}</code>。 当前展示最近
        50 条:成功 {successCount} / 失败 {failureCount}。
      </p>

      <Table<LedgerEntry>
        dataSource={data?.entries ?? []}
        rowKey={(r) => `${r.ts}-${r.endpoint}-${r.latency_ms ?? 0}`}
        size="small"
        loading={loading}
        pagination={{ pageSize: 10 }}
        scroll={{ x: 800 }}
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
            title: "Endpoint",
            dataIndex: "endpoint",
            width: 120,
            render: (v: string, r) => (
              <Tooltip title={r.base_url}>
                <Tag color={r.success ? "blue" : "red"}>{v}</Tag>
              </Tooltip>
            ),
          },
          {
            title: "模型",
            dataIndex: "model",
            width: 200,
            render: (v: string) => <code style={{ fontSize: 11 }}>{v}</code>,
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
            render: (v: number | null) => fmtMs(v),
          },
          {
            title: "req / resp",
            width: 130,
            render: (_: unknown, r) => (
              <span style={{ fontSize: 12, color: "var(--c-text-2)" }}>
                {fmtBytes(r.request_bytes)} / {fmtBytes(r.response_bytes)}
              </span>
            ),
          },
          {
            title: "错误",
            dataIndex: "error",
            render: (v: string | null) =>
              v ? (
                <Tooltip title={v}>
                  <span
                    style={{
                      fontSize: 11,
                      color: "#b91c1c",
                      maxWidth: 240,
                      display: "inline-block",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      verticalAlign: "bottom",
                    }}
                  >
                    {v.split(":")[0]}
                  </span>
                </Tooltip>
              ) : (
                <span style={{ color: "var(--c-text-3)" }}>—</span>
              ),
          },
        ]}
      />
    </Card>
  );
}
