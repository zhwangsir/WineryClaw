import { useState, useEffect } from "react";
import { Card, Tag, Empty } from "antd";
import { ApiOutlined } from "@ant-design/icons";
import { PageShell } from "../components/common/PageShell";
import { hooksApi } from "../api/hooks";

const hookDescriptions: Record<string, string> = {
  pre_tool_call: "工具调用前钩子",
  post_tool_call: "工具调用后钩子",
  pre_llm_call: "LLM 调用前钩子",
  post_llm_call: "LLM 调用后钩子",
  on_session_start: "会话开始时钩子",
  on_session_end: "会话结束时钩子",
  on_startup: "系统启动时钩子",
  on_shutdown: "系统关闭时钩子",
};

export default function HooksPage() {
  const [hooks, setHooks] = useState<string[]>([]);

  useEffect(() => {
    hooksApi.registry().then(setHooks).catch(() => setHooks([]));
  }, []);

  return (
    <PageShell
      title="Hooks"
      subtitle="Plugin SDK Hook 注册表"
      icon={<ApiOutlined />}
    >
      {hooks.length === 0 ? (
        <Empty description="暂无 Hook 注册信息" />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
          {hooks.map((h) => (
            <Card
              key={h}
              size="small"
              style={{ borderRadius: 12, border: "1px solid var(--c-border)" }}
              styles={{ body: { padding: 20 } }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <Tag color="blue" style={{ fontSize: 11, margin: 0 }}>{h}</Tag>
              </div>
              <div style={{ fontSize: 12, color: "var(--c-text-2)" }}>
                {hookDescriptions[h] || "自定义钩子"}
              </div>
            </Card>
          ))}
        </div>
      )}
    </PageShell>
  );
}
