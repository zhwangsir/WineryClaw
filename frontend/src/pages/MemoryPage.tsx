import { useState, useEffect } from "react";
import { Input, Empty, Skeleton, Button, Drawer, Form, Select, message } from "antd";
import { HistoryOutlined, PlusOutlined } from "@ant-design/icons";
import { PageShell } from "../components/common/PageShell";
import { useMemoryStore } from "../stores/memoryStore";
import { useDebounce } from "../hooks/useDebounce";

const memoryLevels = [
  { value: "L1", label: "L1 工作记忆" },
  { value: "L2", label: "L2 短期记忆" },
  { value: "L3", label: "L3 长期记忆" },
  { value: "L4", label: "L4 情景记忆" },
];

export default function MemoryPage() {
  const { memories, search, fetchMemories, loading, store } = useMemoryStore();
  const [q, setQ] = useState("");
  const debouncedQ = useDebounce(q, 400);

  const [storeOpen, setStoreOpen] = useState(false);
  const [storeForm] = Form.useForm();
  const [storeLoading, setStoreLoading] = useState(false);

  useEffect(() => {
    fetchMemories();
  }, [fetchMemories]);

  useEffect(() => {
    if (debouncedQ.trim()) {
      search(debouncedQ);
    } else {
      fetchMemories();
    }
  }, [debouncedQ, search, fetchMemories]);

  const handleStore = async (values: { content: string; source: string; level: string }) => {
    setStoreLoading(true);
    try {
      await store({ content: values.content, source: values.source || "manual", level: (values.level || "L3") as "L1" | "L2" | "L3" | "L4" });
      message.success("记忆存储成功");
      setStoreOpen(false);
      storeForm.resetFields();
      await fetchMemories();
    } catch (err: any) {
      message.error(err?.message || "存储失败");
    } finally {
      setStoreLoading(false);
    }
  };

  return (
    <PageShell
      title="记忆"
      subtitle="搜索与管理分层记忆"
      icon={<HistoryOutlined />}
      loading={loading && memories.length === 0}
    >
      <div style={{ display: "flex", gap: 12, marginBottom: 32, flexWrap: "wrap" }}>
        <Input.Search
          placeholder="搜索记忆..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          loading={loading && !!q}
          style={{ maxWidth: 480, flex: 1 }}
          allowClear
        />
        <Button type="primary" icon={<PlusOutlined />} style={{ height: 40 }} onClick={() => setStoreOpen(true)}>
          存储记忆
        </Button>
      </div>

      {loading && memories.length === 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              style={{
                padding: 24,
                borderRadius: 12,
                border: "1px solid var(--c-border)",
                background: "var(--c-card)",
              }}
            >
              <Skeleton active paragraph={{ rows: 2 }} title={false} />
            </div>
          ))}
        </div>
      ) : memories.length === 0 ? (
        <Empty
          description={
            <span style={{ color: "var(--c-text-3)", fontSize: 14, fontWeight: 300 }}>
              {q ? "无搜索结果" : "暂无记忆"}
            </span>
          }
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {memories.map((m: { id: string; level: string; source: string; content: string; vectorScore?: number }) => (
            <div
              key={m.id}
              style={{
                padding: 24,
                borderRadius: 12,
                border: "1px solid var(--c-border)",
                background: "var(--c-card)",
                boxShadow: "var(--shadow)",
                transition: "box-shadow 200ms",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.boxShadow = "var(--shadow-hover)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.boxShadow = "var(--shadow)";
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 300,
                  color: "var(--c-text-3)",
                  marginBottom: 6,
                  letterSpacing: "0.3px",
                }}
              >
                [{m.level}] {m.source}
              </div>
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 400,
                  color: "var(--c-text)",
                  lineHeight: 1.7,
                  fontFamily: '"Inter", sans-serif',
                }}
              >
                {m.content}
              </div>
              {m.vectorScore !== undefined && (
                <div style={{ fontSize: 12, fontWeight: 300, color: "var(--c-accent)", marginTop: 8 }}>
                  相似度: {(m.vectorScore * 100).toFixed(1)}%
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <Drawer
        title={<span style={{ fontWeight: 600, fontSize: 16, color: "var(--c-text)" }}>存储记忆</span>}
        open={storeOpen}
        onClose={() => setStoreOpen(false)}
        width={480}
      >
        <Form form={storeForm} layout="vertical" onFinish={handleStore}>
          <Form.Item
            name="content"
            label="内容"
            rules={[{ required: true, message: "请输入记忆内容" }]}
          >
            <Input.TextArea rows={4} placeholder="输入要存储的记忆内容..." />
          </Form.Item>
          <Form.Item name="source" label="来源" initialValue="manual">
            <Input placeholder="记忆来源标识" />
          </Form.Item>
          <Form.Item name="level" label="层级" initialValue="L3">
            <Select options={memoryLevels} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={storeLoading} block>
              存储
            </Button>
          </Form.Item>
        </Form>
      </Drawer>
    </PageShell>
  );
}
