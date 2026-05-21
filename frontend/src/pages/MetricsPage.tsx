import { useState, useEffect } from "react";
import { Button, Card, Input, Empty } from "antd";
import { BarChartOutlined, SearchOutlined } from "@ant-design/icons";
import { PageShell } from "../components/common/PageShell";
import { metricsApi } from "../api/metrics";

export default function MetricsPage() {
  // Q14.6 (2026-05-21) — runtime shape isn't actually guaranteed to be an
  // object. sub-brain doesn't expose /api/metrics/query (the
  // matching endpoint is the Prometheus text exposition at /metrics);
  // unknown routes return the SPA fallback HTML with 200 OK, so axios
  // resolves with `data = "<!DOCTYPE html>..."` (a string). Treating
  // that as Record<string, unknown> made `"error" in data` throw a
  // TypeError and trip the error boundary. Type as unknown so the
  // render path is forced to narrow explicitly.
  const [data, setData] = useState<unknown>(null);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);

  const fetchMetrics = async () => {
    setLoading(true);
    try {
      const res = await metricsApi.query(name || undefined);
      setData(res);
    } catch (e: any) {
      setData({ error: e.message || "查询失败" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMetrics();
  }, []);

  return (
    <PageShell title="指标" subtitle="系统指标查询与监控" icon={<BarChartOutlined />}>
      <div style={{ display: "flex", gap: 12, marginBottom: 24 }}>
        <Input
          placeholder="指标名称（可选）"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ maxWidth: 300 }}
        />
        <Button type="primary" icon={<SearchOutlined />} onClick={fetchMetrics} loading={loading}>
          查询
        </Button>
      </div>

      {data && typeof data === "object" && "error" in data ? (
        <Card style={{ borderRadius: 12, border: "1px solid var(--c-border)" }} bodyStyle={{ padding: 24 }}>
          <Empty description={String((data as { error: unknown }).error)} />
        </Card>
      ) : data && typeof data === "object" ? (
        <Card style={{ borderRadius: 12, border: "1px solid var(--c-border)" }} bodyStyle={{ padding: 24 }}>
          <pre
            style={{
              background: "var(--c-hover)",
              padding: 16,
              borderRadius: 8,
              fontSize: 12,
              overflow: "auto",
              maxHeight: 400,
            }}
          >
            {JSON.stringify(data, null, 2)}
          </pre>
        </Card>
      ) : data ? (
        // Defensive: response was a string / unexpected primitive — likely the
        // SPA HTML fallback when the endpoint doesn't exist on sub-brain.
        <Card style={{ borderRadius: 12, border: "1px solid var(--c-border)" }} bodyStyle={{ padding: 24 }}>
          <Empty description="指标接口暂未实现 — 后端只暴露 Prometheus 文本指标 (/metrics)，结构化查询接口待补。" />
        </Card>
      ) : (
        <Empty description="暂无指标数据" />
      )}
    </PageShell>
  );
}
