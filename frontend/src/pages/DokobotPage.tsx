import { useState, useEffect } from "react";
import { Button, Card, Input, Tag, Image } from "antd";
import { RobotOutlined, GlobalOutlined, SearchOutlined, CameraOutlined } from "@ant-design/icons";
import { PageShell } from "../components/common/PageShell";
import { useDokobotStore } from "../stores/dokobotStore";

export default function DokobotPage() {
  const { available, fetchStatus, browse, search, screenshot } = useDokobotStore();

  const [url, setUrl] = useState("");
  const [query, setQuery] = useState("");
  const [screenshotUrl, setScreenshotUrl] = useState("");
  const [result, setResult] = useState<unknown>(null);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleBrowse = async () => {
    if (!url) return;
    const res = await browse(url);
    setResult(res);
  };

  const handleSearch = async () => {
    if (!query) return;
    const res = await search(query);
    setResult(res);
  };

  const handleScreenshot = async () => {
    if (!url) return;
    const dataUrl = await screenshot(url);
    if (dataUrl) setScreenshotUrl(dataUrl);
  };

  return (
    <PageShell
      title="Dokobot"
      subtitle="智能网页浏览与搜索代理"
      icon={<RobotOutlined />}
    >
      <Tag color={available ? "success" : "default"} style={{ marginBottom: 24, fontSize: 13 }}>
        {available ? "服务可用" : "服务不可用"}
      </Tag>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 24, marginBottom: 32 }}>
        <Card
          title={<span style={{ fontWeight: 600, color: "var(--c-text)" }}><GlobalOutlined style={{ marginRight: 8 }} />浏览网页</span>}
          style={{ borderRadius: 12, border: "1px solid var(--c-border)" }}
          bodyStyle={{ padding: 24 }}
        >
          <Input placeholder="URL" value={url} onChange={(e) => setUrl(e.target.value)} style={{ marginBottom: 12 }} />
          <Button type="primary" icon={<GlobalOutlined />} onClick={handleBrowse} disabled={!available}>浏览</Button>
        </Card>

        <Card
          title={<span style={{ fontWeight: 600, color: "var(--c-text)" }}><SearchOutlined style={{ marginRight: 8 }} />搜索</span>}
          style={{ borderRadius: 12, border: "1px solid var(--c-border)" }}
          bodyStyle={{ padding: 24 }}
        >
          <Input placeholder="搜索关键词" value={query} onChange={(e) => setQuery(e.target.value)} style={{ marginBottom: 12 }} />
          <Button type="primary" icon={<SearchOutlined />} onClick={handleSearch} disabled={!available}>搜索</Button>
        </Card>

        <Card
          title={<span style={{ fontWeight: 600, color: "var(--c-text)" }}><CameraOutlined style={{ marginRight: 8 }} />截图</span>}
          style={{ borderRadius: 12, border: "1px solid var(--c-border)" }}
          bodyStyle={{ padding: 24 }}
        >
          <Input placeholder="URL" value={url} onChange={(e) => setUrl(e.target.value)} style={{ marginBottom: 12 }} />
          <Button icon={<CameraOutlined />} onClick={handleScreenshot} disabled={!available}>截图</Button>
        </Card>
      </div>

      {screenshotUrl && (
        <Card style={{ marginBottom: 32, borderRadius: 12, border: "1px solid var(--c-border)" }} bodyStyle={{ padding: 24 }}>
          <Image src={screenshotUrl} alt="screenshot" style={{ borderRadius: 8, maxWidth: "100%" }} />
        </Card>
      )}

      {result !== null && (
        <Card
          title={<span style={{ fontWeight: 600, color: "var(--c-text)" }}>结果</span>}
          style={{ borderRadius: 12, border: "1px solid var(--c-border)" }}
          bodyStyle={{ padding: 24 }}
        >
          <pre style={{ background: "var(--c-hover)", padding: 16, borderRadius: 8, fontSize: 12, overflow: "auto", maxHeight: 400 }}>
            {JSON.stringify(result, null, 2)}
          </pre>
        </Card>
      )}
    </PageShell>
  );
}
