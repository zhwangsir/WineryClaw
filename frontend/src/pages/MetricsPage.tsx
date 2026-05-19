import { useState, useEffect } from "react";
import { Button, Card, Input, Empty } from "antd";
import { BarChartOutlined, SearchOutlined } from "@ant-design/icons";
import { PageShell } from "../components/common/PageShell";
import { metricsApi } from "../api/metrics";

export default function MetricsPage() {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
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
    <PageShell
      title="指标"
      subtitle="系统指标查询与监控"
      icon={<BarChartOutlined />}
    >
      <div style={{ display: "flex", gap: 12, marginBottom: 24 }}>
        <Input placeholder="指标名称（可选）" value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 300 }} />
        <Button type="primary" icon={<SearchOutlined />} onClick={fetchMetrics} loading={loading}>查询</Button>
      </div>

      {data && "error" in data ? (
        <Card style={{ borderRadius: 12, border: "1px solid var(--c-border)" }} bodyStyle={{ padding: 24 }}>
          <Empty description={String(data.error)} />
        </Card>
      ) : data ? (
        <Card style={{ borderRadius: 12, border: "1px solid var(--c-border)" }} bodyStyle={{ padding: 24 }}>
          <pre style={{ background: "var(--c-hover)", padding: 16, borderRadius: 8, fontSize: 12, overflow: "auto", maxHeight: 400 }}>
            {JSON.stringify(data, null, 2)}
          </pre>
        </Card>
      ) : (
        <Empty description="暂无指标数据" />
      )}
    </PageShell>
  );
}
