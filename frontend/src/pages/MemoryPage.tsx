import { useState, useEffect, useMemo } from "react";
import {
  Input,
  Empty,
  Skeleton,
  Button,
  Drawer,
  Form,
  Select,
  message,
  Tabs,
  Tag,
  Tooltip,
  Badge,
  Popconfirm,
  Segmented,
  Card,
} from "antd";
import {
  HistoryOutlined,
  PlusOutlined,
  WarningOutlined,
  ThunderboltOutlined,
  ReloadOutlined,
  CheckCircleOutlined,
  StopOutlined,
} from "@ant-design/icons";
import { PageShell } from "../components/common/PageShell";
import { useMemoryStore } from "../stores/memoryStore";
import { useDebounce } from "../hooks/useDebounce";
import type { Memory } from "../api/types";

type LevelFilter = "all" | "L1" | "L2" | "L3" | "L4";

const memoryLevels = [
  { value: "L1", label: "L1 工作记忆" },
  { value: "L2", label: "L2 短期记忆" },
  { value: "L3", label: "L3 长期记忆" },
  { value: "L4", label: "L4 情景记忆" },
];

const LEVEL_COLOR: Record<string, string> = {
  L1: "default",
  L2: "blue",
  L3: "purple",
  L4: "gold",
};

const PROVENANCE_LABEL: Record<string, string> = {
  chat: "对话",
  consolidation_l1_l2: "L1→L2 合并",
  fact_extraction_l2_l3: "L2→L3 抽取",
  promotion_l3_l4: "L3→L4 晋升",
  "channel:tg": "Telegram",
  "channel:discord": "Discord",
};

function formatRelativeTime(iso?: string): string {
  if (!iso) return "未访问";
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "—";
  const elapsedMs = Date.now() - ts;
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

function formatProvenance(p?: string): string {
  if (!p) return "—";
  return PROVENANCE_LABEL[p] ?? p;
}

// Importance is a 0-1 float; render as 3-color band so users can see
// "decayed" memories at a glance without staring at digits.
function importanceColor(importance?: number): string {
  if (importance == null) return "var(--c-text-3)";
  if (importance >= 0.7) return "#22c55e";
  if (importance >= 0.4) return "#eab308";
  return "#ef4444";
}

interface MemoryCardProps {
  mem: Memory;
  highlightId?: string;
}

function MemoryCard({ mem, highlightId }: MemoryCardProps) {
  const isCurrent = mem.is_current === undefined ? true : mem.is_current === 1;
  const inConflict = Boolean(mem.conflict_group);
  const importance = mem.effective_importance ?? mem.importance ?? 0;
  const isHighlight = highlightId === mem.id;

  return (
    <Card
      size="small"
      style={{
        marginBottom: 12,
        borderColor: isHighlight ? "var(--c-accent)" : "var(--c-border)",
        opacity: isCurrent ? 1 : 0.6,
        background: isHighlight ? "rgba(99,102,241,0.06)" : "var(--c-card)",
      }}
      styles={{ body: { padding: 16 } }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
            <Tag color={LEVEL_COLOR[mem.level] ?? "default"} style={{ margin: 0 }}>
              {mem.level}
            </Tag>
            {inConflict && (
              <Tooltip title={isCurrent ? "当前版本(冲突组中已被采用)" : "已被新版本替代(在冲突组中)"}>
                <Tag
                  icon={isCurrent ? <CheckCircleOutlined /> : <StopOutlined />}
                  color={isCurrent ? "orange" : "default"}
                  style={{ margin: 0 }}
                >
                  {isCurrent ? "冲突·当前" : "冲突·旧版"}
                </Tag>
              </Tooltip>
            )}
            {mem.superseded_by && (
              <Tooltip title={`已被合并到 ${mem.superseded_by.slice(0, 8)}…`}>
                <Tag style={{ margin: 0 }}>已合并</Tag>
              </Tooltip>
            )}
            <Tag style={{ margin: 0, background: "transparent" }}>{formatProvenance(mem.provenance_source)}</Tag>
            {mem.source && mem.source !== mem.provenance_source && (
              <span style={{ fontSize: 11, color: "var(--c-text-3)" }}>来源:{mem.source}</span>
            )}
          </div>
          <div
            style={{
              fontSize: 14,
              fontWeight: 400,
              color: "var(--c-text)",
              lineHeight: 1.7,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {mem.content}
          </div>
        </div>
        <div
          style={{
            minWidth: 140,
            display: "flex",
            flexDirection: "column",
            gap: 6,
            alignItems: "flex-end",
            fontSize: 12,
            color: "var(--c-text-3)",
          }}
        >
          <Tooltip
            title={
              mem.effective_importance != null && mem.importance != null && mem.effective_importance !== mem.importance
                ? `原始 ${mem.importance.toFixed(2)} → 衰减后 ${mem.effective_importance.toFixed(2)}`
                : "记忆重要度,随时间衰减,被检索时增强"
            }
          >
            <span>
              重要度:
              <span style={{ color: importanceColor(importance), marginLeft: 4, fontWeight: 500 }}>
                {importance.toFixed(2)}
              </span>
            </span>
          </Tooltip>
          <span>访问:{mem.access_count ?? 0} 次</span>
          <span>{formatRelativeTime(mem.last_accessed_at || mem.createdAt)}</span>
          {mem.vectorScore !== undefined && (
            <span style={{ color: "var(--c-accent)" }}>相似:{(mem.vectorScore * 100).toFixed(1)}%</span>
          )}
          {mem.final_score !== undefined && <span>综合:{mem.final_score.toFixed(3)}</span>}
        </div>
      </div>
    </Card>
  );
}

interface ConflictCardProps {
  group: import("../api/types").ConflictGroup;
  onMarkCurrent: (id: string) => void;
}

function ConflictCard({ group, onMarkCurrent }: ConflictCardProps) {
  return (
    <Card
      size="small"
      title={
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <WarningOutlined style={{ color: "#ef4444" }} />
          <span>冲突组 {group.conflict_group.slice(0, 12)}</span>
          <Tag>{group.memories.length} 个版本</Tag>
        </span>
      }
      style={{ marginBottom: 16 }}
      styles={{ body: { padding: 12 } }}
    >
      <div style={{ fontSize: 12, color: "var(--c-text-3)", marginBottom: 8 }}>
        这些记忆相互矛盾。默认按时间排序(新优先)采用为当前版本。点击「设为当前」可手动覆盖。
      </div>
      {group.memories.map((m) => {
        const isCurrent = m.id === group.current_id;
        return (
          <div
            key={m.id}
            style={{
              padding: 12,
              marginBottom: 8,
              borderRadius: 6,
              border: `1px solid ${isCurrent ? "var(--c-accent)" : "var(--c-border)"}`,
              background: isCurrent ? "rgba(99,102,241,0.05)" : "transparent",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                  <Tag color={isCurrent ? "orange" : "default"} style={{ margin: 0 }}>
                    {isCurrent ? "当前" : "旧版"}
                  </Tag>
                  <Tag style={{ margin: 0 }}>{m.level}</Tag>
                  <span style={{ fontSize: 11, color: "var(--c-text-3)" }}>{formatRelativeTime(m.createdAt)}</span>
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{m.content}</div>
              </div>
              {!isCurrent && (
                <Popconfirm
                  title="切换当前版本"
                  description="这会把当前版本切换到这一条,旧版仍可见但不会用作回答依据。"
                  okText="确认切换"
                  cancelText="取消"
                  onConfirm={() => onMarkCurrent(m.id)}
                >
                  <Button size="small">设为当前</Button>
                </Popconfirm>
              )}
            </div>
          </div>
        );
      })}
    </Card>
  );
}

export default function MemoryPage() {
  const {
    memories,
    conflicts,
    search,
    fetchMemories,
    fetchConflicts,
    loading,
    conflictsLoading,
    dreamingRunning,
    store,
    setLevelFilter,
    levelFilter,
    markCurrent,
    runDreaming,
  } = useMemoryStore();
  const [q, setQ] = useState("");
  const debouncedQ = useDebounce(q, 400);
  const [activeTab, setActiveTab] = useState<string>("memories");

  const [storeOpen, setStoreOpen] = useState(false);
  const [storeForm] = Form.useForm();
  const [storeLoading, setStoreLoading] = useState(false);

  useEffect(() => {
    fetchMemories();
    fetchConflicts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (debouncedQ.trim()) {
      search(debouncedQ);
    } else {
      fetchMemories();
    }
  }, [debouncedQ, search, fetchMemories]);

  // When the user clicks into the Conflicts tab, ensure the data is fresh
  useEffect(() => {
    if (activeTab === "conflicts") {
      fetchConflicts();
    }
  }, [activeTab, fetchConflicts]);

  const handleStore = async (values: { content: string; source: string; level: string }) => {
    setStoreLoading(true);
    try {
      await store({
        content: values.content,
        source: values.source || "manual",
        level: (values.level || "L3") as "L1" | "L2" | "L3" | "L4",
      });
      message.success("记忆存储成功");
      setStoreOpen(false);
      storeForm.resetFields();
      await fetchMemories();
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      message.error(e.message || "存储失败");
    } finally {
      setStoreLoading(false);
    }
  };

  const conflictsBadgeCount = useMemo(() => conflicts.length, [conflicts]);

  const levelCounts = useMemo(() => {
    const counts: Record<string, number> = { all: memories.length, L1: 0, L2: 0, L3: 0, L4: 0 };
    for (const m of memories) {
      counts[m.level] = (counts[m.level] ?? 0) + 1;
    }
    return counts;
  }, [memories]);

  return (
    <PageShell
      title="记忆"
      subtitle="分层记忆 · 衰减 · 冲突 · 来源追溯"
      icon={<HistoryOutlined />}
      loading={loading && memories.length === 0 && activeTab === "memories"}
    >
      <div style={{ display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap" }}>
        <Input.Search
          placeholder="语义搜索记忆 (FTS + 向量)..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          loading={loading && !!q}
          style={{ maxWidth: 480, flex: 1, minWidth: 240 }}
          allowClear
        />
        <Tooltip title="立即运行 Dreaming 周期:把安静的 L1 合并成 L2,从 L2 抽取 L3 事实">
          <Button icon={<ThunderboltOutlined />} onClick={() => runDreaming()} loading={dreamingRunning}>
            运行 Dreaming
          </Button>
        </Tooltip>
        <Button icon={<ReloadOutlined />} onClick={() => fetchMemories()} loading={loading}>
          刷新
        </Button>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setStoreOpen(true)}>
          存储记忆
        </Button>
      </div>

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: "memories",
            label: <span>记忆列表 ({memories.length})</span>,
            children: (
              <>
                <div style={{ marginBottom: 16 }}>
                  <Segmented
                    value={levelFilter}
                    onChange={(v) => setLevelFilter(v as LevelFilter)}
                    options={[
                      { label: `全部 (${levelCounts.all ?? 0})`, value: "all" },
                      { label: `L1 (${levelCounts.L1 ?? 0})`, value: "L1" },
                      { label: `L2 (${levelCounts.L2 ?? 0})`, value: "L2" },
                      { label: `L3 (${levelCounts.L3 ?? 0})`, value: "L3" },
                      { label: `L4 (${levelCounts.L4 ?? 0})`, value: "L4" },
                    ]}
                  />
                </div>
                {loading && memories.length === 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {Array.from({ length: 4 }).map((_, i) => (
                      <Card key={i} size="small" styles={{ body: { padding: 16 } }}>
                        <Skeleton active paragraph={{ rows: 2 }} title={false} />
                      </Card>
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
                  memories.map((m) => <MemoryCard key={m.id} mem={m} />)
                )}
              </>
            ),
          },
          {
            key: "conflicts",
            label: (
              <Badge count={conflictsBadgeCount} size="small" offset={[8, 0]}>
                <span>冲突</span>
              </Badge>
            ),
            children: (
              <>
                {conflictsLoading ? (
                  <Skeleton active />
                ) : conflicts.length === 0 ? (
                  <Empty
                    description={
                      <span style={{ color: "var(--c-text-3)", fontSize: 14, fontWeight: 300 }}>
                        无冲突记忆 — 系统中没有相互矛盾的 L3 事实
                      </span>
                    }
                  />
                ) : (
                  conflicts.map((g) => <ConflictCard key={g.conflict_group} group={g} onMarkCurrent={markCurrent} />)
                )}
              </>
            ),
          },
        ]}
      />

      <Drawer
        title={<span style={{ fontWeight: 600, fontSize: 16, color: "var(--c-text)" }}>存储记忆</span>}
        open={storeOpen}
        onClose={() => setStoreOpen(false)}
        width={480}
      >
        <Form form={storeForm} layout="vertical" onFinish={handleStore}>
          <Form.Item name="content" label="内容" rules={[{ required: true, message: "请输入记忆内容" }]}>
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
