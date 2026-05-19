/**
 * LLM router health panel (M4a).
 *
 * Shows each configured endpoint's live status from `GET /brain/llm/stats`:
 * priority, healthy flag, success/failure counts, avg latency, last error.
 * "重新探测" forces a fresh out-of-band probe per row or all at once.
 */

import { useEffect, useState } from "react";
import { Card, Table, Tag, Button, Space, Tooltip, Empty, message, Alert } from "antd";
import { ReloadOutlined, CheckCircleOutlined, CloseCircleOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { llmApi, type LLMEndpointStats, type LLMStats } from "../../api/llm";

const STATUS_LABEL: Record<LLMStats["status"], string> = {
  healthy: "全部在线",
  degraded: "部分降级",
  down: "全部离线",
  unknown: "未初始化",
};

function formatRelative(epochSec: number | null): string {
  if (!epochSec) return "-";
  const diff = Date.now() / 1000 - epochSec;
  if (diff < 60) return `${Math.floor(diff)}s 前`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m 前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h 前`;
  return `${Math.floor(diff / 86400)}d 前`;
}

export default function LLMHealthPanel() {
  const [stats, setStats] = useState<LLMStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [recheckingName, setRecheckingName] = useState<string | null>(null);

  const fetchStats = async () => {
    setLoading(true);
    try {
      const data = await llmApi.stats();
      setStats(data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "加载失败";
      message.error(`LLM 状态获取失败: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchStats();
    // Re-poll every 15 seconds while the panel is mounted — cheap enough
    // since the endpoint is in-memory.
    const id = window.setInterval(() => {
      void fetchStats();
    }, 15000);
    return () => window.clearInterval(id);
  }, []);

  const handleRecheck = async (name?: string) => {
    setRecheckingName(name ?? "__all__");
    try {
      await llmApi.recheck(name);
      message.success(name ? `已重新探测 ${name}` : "已重新探测所有端点");
      await fetchStats();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "探测失败";
      message.error(msg);
    } finally {
      setRecheckingName(null);
    }
  };

  if (!stats) {
    return (
      <Card title="LLM 路由健康" loading={loading}>
        <Empty description="加载中..." />
      </Card>
    );
  }

  if (!stats.ok && stats.error) {
    return (
      <Card title="LLM 路由健康">
        <Alert message={stats.error} type="warning" showIcon />
      </Card>
    );
  }

  const statusColor = stats.status === "healthy" ? "success" : stats.status === "degraded" ? "warning" : "error";

  return (
    <Card
      title={
        <Space>
          <span>LLM 路由健康</span>
          <Tag color={statusColor}>
            {STATUS_LABEL[stats.status]} · {stats.healthy_count}/{stats.total_count}
          </Tag>
          {stats.monitor_running && (
            <Tooltip title="后台健康监视器正在运行(默认 60s 周期)">
              <Tag icon={<ThunderboltOutlined />} color="blue">
                监视中
              </Tag>
            </Tooltip>
          )}
        </Space>
      }
      extra={
        <Space>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => handleRecheck()}
            loading={recheckingName === "__all__"}
            size="small"
          >
            全部重新探测
          </Button>
        </Space>
      }
      style={{ marginTop: 16 }}
    >
      {stats.endpoints.length === 0 ? (
        <Empty description="未配置任何 LLM 端点" />
      ) : (
        <Table<LLMEndpointStats>
          dataSource={stats.endpoints}
          rowKey="name"
          pagination={false}
          size="small"
          columns={[
            {
              title: "端点",
              dataIndex: "name",
              render: (name: string, row) => (
                <Space direction="vertical" size={0}>
                  <span style={{ fontWeight: 500 }}>{name}</span>
                  <span style={{ fontSize: 11, color: "var(--c-text-3)", fontFamily: "monospace" }}>
                    {row.base_url}
                  </span>
                </Space>
              ),
            },
            {
              title: "模型",
              dataIndex: "model_id",
              render: (m: string) => <span style={{ fontFamily: "monospace", fontSize: 12 }}>{m}</span>,
            },
            {
              title: "Provider",
              dataIndex: "provider",
              width: 100,
              render: (p: string) => <Tag>{p}</Tag>,
            },
            {
              title: "优先级",
              dataIndex: "priority",
              width: 80,
              align: "center",
            },
            {
              title: "状态",
              dataIndex: "healthy",
              width: 90,
              render: (healthy: boolean) =>
                healthy ? (
                  <Tag icon={<CheckCircleOutlined />} color="success">
                    在线
                  </Tag>
                ) : (
                  <Tag icon={<CloseCircleOutlined />} color="error">
                    离线
                  </Tag>
                ),
            },
            {
              title: "成功 / 失败",
              key: "stats",
              width: 110,
              render: (_, r) => (
                <span style={{ fontSize: 12 }}>
                  <span style={{ color: "#15803d" }}>{r.success_count}</span>
                  {" / "}
                  <span style={{ color: r.failure_count > 0 ? "#b91c1c" : "var(--c-text-3)" }}>{r.failure_count}</span>
                </span>
              ),
            },
            {
              title: "平均延迟",
              dataIndex: "avg_latency_ms",
              width: 100,
              render: (v: number) => <span style={{ fontSize: 12 }}>{v > 0 ? `${v.toFixed(0)} ms` : "-"}</span>,
            },
            {
              title: "最近活动",
              key: "last_activity",
              width: 100,
              render: (_, r) => {
                const ts = r.last_success_at ?? r.last_failure_at;
                return <span style={{ fontSize: 11, color: "var(--c-text-3)" }}>{formatRelative(ts)}</span>;
              },
            },
            {
              title: "最近错误",
              dataIndex: "last_error",
              ellipsis: true,
              render: (e: string | null) =>
                e ? (
                  <Tooltip title={e}>
                    <span style={{ fontSize: 11, color: "#b91c1c" }}>{e}</span>
                  </Tooltip>
                ) : (
                  <span style={{ fontSize: 11, color: "var(--c-text-3)" }}>-</span>
                ),
            },
            {
              title: "",
              key: "action",
              width: 80,
              render: (_, r) => (
                <Button
                  size="small"
                  icon={<ReloadOutlined />}
                  loading={recheckingName === r.name}
                  onClick={() => handleRecheck(r.name)}
                >
                  探测
                </Button>
              ),
            },
          ]}
        />
      )}
    </Card>
  );
}
