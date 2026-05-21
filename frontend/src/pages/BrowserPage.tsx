import { useState, useEffect } from "react";
import { Button, Card, Input, Empty, Table, Image } from "antd";
import { GlobalOutlined, CameraOutlined, HighlightOutlined, FormOutlined, PlayCircleOutlined, PlusOutlined } from "@ant-design/icons";
import { PageShell } from "../components/common/PageShell";
import { useBrowserStore } from "../stores/browserStore";

export default function BrowserPage() {
  const { sessions, fetchSessions, launch, newPage, navigate, click, type, screenshot } = useBrowserStore();

  const [activeSession, setActiveSession] = useState("");
  const [navUrl, setNavUrl] = useState("");
  const [selector, setSelector] = useState("");
  const [typeText, setTypeText] = useState("");
  const [screenshotUrl, setScreenshotUrl] = useState("");

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  const handleScreenshot = async () => {
    if (!activeSession) return;
    const url = await screenshot(activeSession);
    if (url) setScreenshotUrl(url);
  };

  const session = sessions.find((s) => s.id === activeSession);

  return (
    <PageShell
      title="浏览器"
      subtitle="Playwright 浏览器自动化控制"
      icon={<GlobalOutlined />}
      actions={
        <Button type="primary" icon={<PlayCircleOutlined />} style={{ height: 40 }} onClick={() => launch()}>
          启动浏览器
        </Button>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: 24 }}>
        {/* Left: Sessions + Controls */}
        <div>
          <Card
            title={<span style={{ fontWeight: 600, color: "var(--c-text)" }}>会话</span>}
            style={{ borderRadius: 12, border: "1px solid var(--c-border)", marginBottom: 24 }}
            styles={{ body: { padding: 20 } }}
            extra={
              <Button size="small" icon={<PlusOutlined />} onClick={() => newPage()}>新页面</Button>
            }
          >
            {sessions.length === 0 ? (
              <Empty description="暂无会话" />
            ) : (
              <Table
                dataSource={sessions}
                rowKey="id"
                size="small"
                pagination={false}
                rowClassName={(r) => (r.id === activeSession ? "active-row" : "")}
                onRow={(r) => ({ onClick: () => setActiveSession(r.id), style: { cursor: "pointer" } })}
                columns={[
                  { title: "ID", dataIndex: "id", render: (v: string) => <span style={{ fontSize: 12, fontFamily: "monospace" }}>{v.slice(0, 12)}...</span> },
                  { title: "标题", dataIndex: "title", render: (v: string) => <span style={{ fontSize: 13 }}>{v || "—"}</span> },
                  { title: "URL", dataIndex: "url", render: (v: string) => <span style={{ fontSize: 12, color: "var(--c-text-3)" }}>{v ? v.slice(0, 40) + (v.length > 40 ? "..." : "") : "—"}</span> },
                ]}
              />
            )}
          </Card>

          {session && (
            <Card
              title={<span style={{ fontWeight: 600, color: "var(--c-text)" }}>控制: {session.id.slice(0, 12)}...</span>}
              style={{ borderRadius: 12, border: "1px solid var(--c-border)" }}
              styles={{ body: { padding: 20 } }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", gap: 8 }}>
                  <Input placeholder="URL" value={navUrl} onChange={(e) => setNavUrl(e.target.value)} style={{ flex: 1 }} />
                  <Button icon={<GlobalOutlined />} onClick={() => { if (navUrl) navigate(session.id, navUrl); }}>导航</Button>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <Input placeholder="CSS Selector" value={selector} onChange={(e) => setSelector(e.target.value)} style={{ flex: 1 }} />
                  <Button icon={<HighlightOutlined />} onClick={() => { if (selector) click(session.id, selector); }}>点击</Button>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <Input placeholder="输入文本" value={typeText} onChange={(e) => setTypeText(e.target.value)} style={{ flex: 1 }} />
                  <Button icon={<FormOutlined />} onClick={() => { if (selector && typeText) type(session.id, selector, typeText); }}>输入</Button>
                </div>
                <Button icon={<CameraOutlined />} onClick={handleScreenshot}>截图</Button>
              </div>
            </Card>
          )}
        </div>

        {/* Right: Screenshot */}
        <div>
          <Card
            title={<span style={{ fontWeight: 600, color: "var(--c-text)" }}>截图</span>}
            style={{ borderRadius: 12, border: "1px solid var(--c-border)", height: "100%" }}
            styles={{ body: { padding: 20 } }}
          >
            {screenshotUrl ? (
              <Image src={screenshotUrl} alt="screenshot" style={{ borderRadius: 8, width: "100%" }} />
            ) : (
              <Empty description="暂无截图" />
            )}
          </Card>
        </div>
      </div>
    </PageShell>
  );
}
