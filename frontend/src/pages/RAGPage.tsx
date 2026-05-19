import { useState, useEffect } from "react";
import {
  Card,
  Input,
  Button,
  Table,
  Statistic,
  Row,
  Col,
  Space,
  Tag,
  Empty,
  Tooltip,
  Popconfirm,
  Form,
  Modal,
  InputNumber,
} from "antd";
import {
  FileSearchOutlined,
  PlusOutlined,
  DeleteOutlined,
  ReloadOutlined,
  FolderAddOutlined,
  PlayCircleOutlined,
  StopOutlined,
} from "@ant-design/icons";
import { PageShell } from "../components/common/PageShell";
import { useRagStore } from "../stores/ragStore";

export default function RAGPage() {
  const {
    stats,
    statsLoading,
    fetchStats,
    watcherStatus,
    fetchWatcherStatus,
    queryResults,
    queryLoading,
    lastQuery,
    query,
    indexFile,
    indexDir,
    removeFile,
    startWatcher,
    stopWatcher,
  } = useRagStore();

  const [q, setQ] = useState("");
  const [k, setK] = useState(5);
  const [indexFilePath, setIndexFilePath] = useState("");
  const [indexDirState, setIndexDirState] = useState({ open: false, path: "", glob: "**/*.md" });
  const [watcherState, setWatcherState] = useState({ open: false, paths: "", glob: "**/*.md", debounce_ms: 500 });

  useEffect(() => {
    fetchStats();
    fetchWatcherStatus();
  }, [fetchStats, fetchWatcherStatus]);

  return (
    <PageShell title="RAG" subtitle="文档检索 · 增量索引 · 自动监听文件变更" icon={<FileSearchOutlined />}>
      {/* Stats row */}
      <Row gutter={16} style={{ marginBottom: 24 }}>
        <Col span={6}>
          <Card>
            <Statistic title="已索引文档" value={stats?.docs_count ?? 0} loading={statsLoading} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="Chunks 总数" value={stats?.chunks_count ?? 0} loading={statsLoading} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="Embedding 维度" value={stats?.embedding_dim ?? 0} loading={statsLoading} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="Watcher 状态"
              value={watcherStatus.running ? "运行中" : "已停止"}
              valueStyle={{ color: watcherStatus.running ? "#52c41a" : "#999", fontSize: 18 }}
            />
            {watcherStatus.running && watcherStatus.watching && (
              <div style={{ fontSize: 11, color: "var(--c-text-3)", marginTop: 4 }}>
                监听 {watcherStatus.watching.length} 个目录
              </div>
            )}
          </Card>
        </Col>
      </Row>

      {/* Index controls */}
      <Card title="索引操作" style={{ marginBottom: 24 }}>
        <Space wrap>
          <Input
            placeholder="文件绝对路径 (e.g. /Users/x/notes/foo.md)"
            value={indexFilePath}
            onChange={(e) => setIndexFilePath(e.target.value)}
            style={{ width: 480 }}
            onPressEnter={async () => {
              if (indexFilePath.trim()) {
                await indexFile(indexFilePath.trim());
                setIndexFilePath("");
              }
            }}
          />
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={async () => {
              if (indexFilePath.trim()) {
                await indexFile(indexFilePath.trim());
                setIndexFilePath("");
              }
            }}
          >
            索引单文件
          </Button>
          <Button icon={<FolderAddOutlined />} onClick={() => setIndexDirState({ ...indexDirState, open: true })}>
            批量索引目录
          </Button>
          <Tooltip title="刷新统计">
            <Button icon={<ReloadOutlined />} onClick={fetchStats} loading={statsLoading} />
          </Tooltip>
          {watcherStatus.running ? (
            <Popconfirm title="停止 watcher?" onConfirm={stopWatcher} okText="停止" cancelText="取消">
              <Button icon={<StopOutlined />} danger>
                停止 Watcher
              </Button>
            </Popconfirm>
          ) : (
            <Button
              icon={<PlayCircleOutlined />}
              type="primary"
              onClick={() => setWatcherState({ ...watcherState, open: true })}
            >
              启动 Watcher
            </Button>
          )}
        </Space>
      </Card>

      {/* Query box */}
      <Card title="检索" style={{ marginBottom: 24 }}>
        <Space>
          <Input.Search
            placeholder="输入查询..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onSearch={() => query(q, k)}
            style={{ width: 480 }}
            enterButton="检索"
            loading={queryLoading}
          />
          <Tooltip title="返回前 k 个结果">
            <InputNumber value={k} onChange={(v) => setK(v ?? 5)} min={1} max={20} addonBefore="k" />
          </Tooltip>
        </Space>

        {lastQuery && (
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 12, color: "var(--c-text-3)", marginBottom: 8 }}>
              对 "{lastQuery}" 的检索结果({queryResults.length}):
            </div>
            {queryResults.length === 0 ? (
              <Empty description="未找到相关内容" />
            ) : (
              <Space direction="vertical" style={{ width: "100%" }}>
                {queryResults.map((c, i) => (
                  <Card key={`${c.doc_path}-${c.chunk_idx}`} size="small">
                    <Space direction="vertical" size={4} style={{ width: "100%" }}>
                      <Space>
                        <Tag color="blue">#{i + 1}</Tag>
                        <Tag>score: {c.score.toFixed(3)}</Tag>
                        <span style={{ fontSize: 11, color: "var(--c-text-3)", fontFamily: "monospace" }}>
                          {c.doc_path} #{c.chunk_idx}
                        </span>
                      </Space>
                      <pre style={{ margin: 0, fontSize: 12, whiteSpace: "pre-wrap", color: "var(--c-text-2)" }}>
                        {c.text}
                      </pre>
                    </Space>
                  </Card>
                ))}
              </Space>
            )}
          </div>
        )}
      </Card>

      {/* Documents table */}
      <Card title={`已索引文档 (${stats?.docs_count ?? 0})`}>
        {!stats || stats.documents.length === 0 ? (
          <Empty description="尚未索引任何文档" />
        ) : (
          <Table
            dataSource={stats.documents.map(([path, chunks_count]) => ({ path, chunks_count }))}
            rowKey="path"
            pagination={{ pageSize: 15 }}
            columns={[
              {
                title: "路径",
                dataIndex: "path",
                render: (v: string) => <span style={{ fontSize: 12, fontFamily: "monospace" }}>{v}</span>,
              },
              {
                title: "Chunks",
                dataIndex: "chunks_count",
                width: 120,
                render: (v: number) => <Tag>{v}</Tag>,
              },
              {
                title: "操作",
                key: "action",
                width: 100,
                render: (_: unknown, record: { path: string }) => (
                  <Popconfirm
                    title={`从索引中移除?`}
                    onConfirm={() => removeFile(record.path)}
                    okText="移除"
                    cancelText="取消"
                  >
                    <Button size="small" danger icon={<DeleteOutlined />}>
                      移除
                    </Button>
                  </Popconfirm>
                ),
              },
            ]}
          />
        )}
      </Card>

      {/* Index directory modal */}
      <Modal
        title="批量索引目录"
        open={indexDirState.open}
        onCancel={() => setIndexDirState({ ...indexDirState, open: false })}
        onOk={async () => {
          if (indexDirState.path.trim()) {
            await indexDir(indexDirState.path.trim(), indexDirState.glob);
            setIndexDirState({ ...indexDirState, open: false, path: "" });
          }
        }}
        okText="开始索引"
        cancelText="取消"
      >
        <Form layout="vertical">
          <Form.Item label="目录绝对路径" required>
            <Input
              value={indexDirState.path}
              onChange={(e) => setIndexDirState({ ...indexDirState, path: e.target.value })}
              placeholder="/Users/x/notes"
            />
          </Form.Item>
          <Form.Item label="文件 glob 模式" extra="**/*.md = 递归所有 .md 文件;  **/* = 全部">
            <Input
              value={indexDirState.glob}
              onChange={(e) => setIndexDirState({ ...indexDirState, glob: e.target.value })}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* Start watcher modal */}
      <Modal
        title="启动文件监听器"
        open={watcherState.open}
        onCancel={() => setWatcherState({ ...watcherState, open: false })}
        onOk={async () => {
          const paths = watcherState.paths
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean);
          if (paths.length === 0) return;
          const ok = await startWatcher(paths, watcherState.glob, watcherState.debounce_ms);
          if (ok) setWatcherState({ ...watcherState, open: false });
        }}
        okText="启动"
        cancelText="取消"
      >
        <Form layout="vertical">
          <Form.Item
            label="监听目录"
            required
            extra="多个目录用逗号分隔。建议监听 ~/Documents/notes 之类的个人笔记目录"
          >
            <Input.TextArea
              value={watcherState.paths}
              onChange={(e) => setWatcherState({ ...watcherState, paths: e.target.value })}
              placeholder="/Users/x/notes, /Users/x/docs"
              rows={3}
            />
          </Form.Item>
          <Form.Item label="文件 glob 模式">
            <Input
              value={watcherState.glob}
              onChange={(e) => setWatcherState({ ...watcherState, glob: e.target.value })}
            />
          </Form.Item>
          <Form.Item label="防抖延迟 (ms)" extra="编辑器频繁保存时,多次事件合并成一次索引">
            <InputNumber
              value={watcherState.debounce_ms}
              onChange={(v) => setWatcherState({ ...watcherState, debounce_ms: v ?? 500 })}
              min={50}
              max={5000}
              style={{ width: "100%" }}
            />
          </Form.Item>
        </Form>
      </Modal>
    </PageShell>
  );
}
