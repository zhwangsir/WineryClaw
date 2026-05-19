import { useState, useMemo, useEffect } from "react";
import { useDebounce } from "../hooks/useDebounce";
import { Switch, Input, Segmented, Skeleton } from "antd";
import {
  ToolOutlined,
  PlayCircleOutlined,
  GlobalOutlined,
  FolderOutlined,
  CodeOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import { PageShell } from "../components/common/PageShell";
import { useToolStore } from "../stores/toolStore";
import { EmptyState } from "../components/common/EmptyState";
import ToolExecutorModal from "../components/tools/ToolExecutorModal";

const categoryMeta: Record<string, { label: string; icon: React.ReactNode }> = {
  system: { label: "系统", icon: <SettingOutlined /> },
  filesystem: { label: "文件", icon: <FolderOutlined /> },
  network: { label: "网络", icon: <GlobalOutlined /> },
  code: { label: "代码", icon: <CodeOutlined /> },
  utility: { label: "实用", icon: <ToolOutlined /> },
  web: { label: "Web", icon: <GlobalOutlined /> },
  browser: { label: "Browser", icon: <GlobalOutlined /> },
  media: { label: "Media", icon: <ToolOutlined /> },
};

export default function ToolsPage() {
  const { tools, loading, fetchTools, toggleTool } = useToolStore();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [execTool, setExecTool] = useState<string | null>(null);

  useEffect(() => {
    fetchTools();
  }, [fetchTools]);

  const categories = useMemo(() => {
    const set = new Set(tools.map((t) => t.category));
    return Array.from(set);
  }, [tools]);

  const filtered = useMemo(() => {
    return tools.filter((t) => {
      const matchSearch =
        !debouncedSearch ||
        t.name.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
        t.description.toLowerCase().includes(debouncedSearch.toLowerCase());
      const matchCat = categoryFilter === "all" || t.category === categoryFilter;
      return matchSearch && matchCat;
    });
  }, [tools, debouncedSearch, categoryFilter]);

  const grouped = useMemo(() => {
    const map = new Map<string, typeof tools>();
    for (const t of filtered) {
      const list = map.get(t.category) || [];
      list.push(t);
      map.set(t.category, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  const activeExec = execTool ? tools.find((t) => t.id === execTool) : null;

  return (
    <PageShell title="工具" subtitle={`${tools.length} 个内置工具就绪`} icon={<ToolOutlined />}>
      {/* Toolbar */}
      <div style={{ display: "flex", gap: 16, marginBottom: 32, flexWrap: "wrap", alignItems: "center" }}>
        <Input.Search
          placeholder="搜索工具..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 280 }}
          allowClear
        />
        <Segmented
          value={categoryFilter}
          onChange={(v) => setCategoryFilter(v as string)}
          options={[
            { label: "全部", value: "all" },
            ...categories.map((c) => {
              const meta = categoryMeta[c] || { label: c, icon: <ToolOutlined /> };
              return {
                label: (
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    {meta.icon}
                    {meta.label}
                  </span>
                ),
                value: c,
              };
            }),
          ]}
        />
      </div>

      {loading && tools.length === 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 48 }}>
          {Array.from({ length: 3 }).map((_, gi) => (
            <div key={gi}>
              <Skeleton.Input active style={{ width: 120, marginBottom: 20 }} />
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 16 }}>
                {Array.from({ length: 3 }).map((_, i) => (
                  <div
                    key={i}
                    style={{
                      padding: 24,
                      borderRadius: 12,
                      border: "1px solid var(--c-border)",
                      background: "var(--c-card)",
                    }}
                  >
                    <Skeleton active paragraph={{ rows: 2 }} title={{ width: "40%" }} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : tools.length === 0 ? (
        <EmptyState description="暂无工具" />
      ) : filtered.length === 0 ? (
        <EmptyState description="没有匹配的工具" />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 48 }}>
          {grouped.map(([cat, list]) => {
            const meta = categoryMeta[cat] || { label: cat, icon: <ToolOutlined /> };
            return (
              <div key={cat}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
                  <span style={{ color: "var(--c-text-2)", fontSize: 15 }}>{meta.icon}</span>
                  <span
                    style={{ fontWeight: 600, fontSize: 15, color: "var(--c-text)", fontFamily: '"Inter", sans-serif' }}
                  >
                    {meta.label}
                  </span>
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 300,
                      color: "var(--c-text-3)",
                      background: "var(--c-hover)",
                      padding: "2px 8px",
                      borderRadius: 8,
                      border: "1px solid var(--c-border)",
                    }}
                  >
                    {list.length}
                  </span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 16 }}>
                  {list.map((t: typeof tools[0]) => (
                    <div
                      key={t.id}
                      style={{
                        padding: 24,
                        borderRadius: 12,
                        border: "1px solid var(--c-border)",
                        background: "var(--c-card)",
                        boxShadow: "var(--shadow)",
                        display: "flex",
                        flexDirection: "column",
                        gap: 10,
                        transition: "box-shadow 200ms",
                      }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLElement).style.boxShadow = "var(--shadow-hover)";
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLElement).style.boxShadow = "var(--shadow)";
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                        <div
                          style={{
                            fontWeight: 600,
                            fontSize: 15,
                            color: "var(--c-text)",
                            fontFamily: '"Inter", sans-serif',
                          }}
                        >
                          {t.name}
                        </div>
                        <Switch size="small" checked={t.enabled} onChange={(v) => toggleTool(t.id, v)} />
                      </div>
                      <div
                        style={{ color: "var(--c-text-2)", fontSize: 13, fontWeight: 300, lineHeight: 1.6, flex: 1 }}
                      >
                        {t.description}
                      </div>
                      <div
                        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}
                      >
                        <span
                          style={{
                            fontSize: 11,
                            padding: "3px 10px",
                            borderRadius: 8,
                            background: "var(--c-hover)",
                            border: "1px solid var(--c-border)",
                            color: "var(--c-text-2)",
                            fontWeight: 300,
                          }}
                        >
                          {meta.label}
                        </span>
                        <span
                          style={{
                            fontSize: 12,
                            color: "var(--c-accent)",
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            gap: 4,
                            fontWeight: 400,
                          }}
                          onClick={() => setExecTool(t.id)}
                        >
                          <PlayCircleOutlined /> 测试
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {activeExec && (
        <ToolExecutorModal
          toolName={activeExec.name}
          toolDescription={activeExec.description}
          open={!!execTool}
          onClose={() => setExecTool(null)}
        />
      )}
    </PageShell>
  );
}
