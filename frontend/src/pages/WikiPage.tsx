import { useState, useEffect } from "react";
import { useDebounce } from "../hooks/useDebounce";
import {
  Input,
  Button,
  List,
  Modal,
  Form,
  Tag,
  Statistic,
  Row,
  Col,
  Card,
  Popconfirm,
  Empty,
  Skeleton,
  Tabs,
} from "antd";
import {
  BookOutlined,
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  FileTextOutlined,
  TagsOutlined,
  LinkOutlined,
  EyeOutlined,
} from "@ant-design/icons";
import { PageShell } from "../components/common/PageShell";
import { useWikiStore } from "../stores/wikiStore";
import MarkdownRenderer from "../components/common/MarkdownRenderer";

export default function WikiPage() {
  const {
    notes,
    searchResults,
    stats,
    loading,
    query,
    fetchNotes,
    search,
    createNote,
    updateNote,
    deleteNote,
    fetchStats,
  } = useWikiStore();

  const [modalOpen, setModalOpen] = useState(false);
  const [editingNote, setEditingNote] = useState<any>(null);
  const [form] = Form.useForm();
  const [searchQ, setSearchQ] = useState("");
  const [previewContent, setPreviewContent] = useState("");
  const [activeTab, setActiveTab] = useState("edit");
  const debouncedSearch = useDebounce(searchQ, 400);

  useEffect(() => {
    fetchNotes();
    fetchStats();
  }, [fetchNotes, fetchStats]);

  useEffect(() => {
    if (debouncedSearch.trim()) {
      search(debouncedSearch);
    }
  }, [debouncedSearch, search]);

  const displayNotes = query ? searchResults : notes;

  const openCreate = () => {
    setEditingNote(null);
    form.resetFields();
    setPreviewContent("");
    setActiveTab("edit");
    setModalOpen(true);
    setTimeout(() => {
      const input = document.querySelector(".wiki-modal-input input") as HTMLElement;
      input?.focus();
    }, 100);
  };

  const openEdit = (note: any) => {
    setEditingNote(note);
    form.setFieldsValue({ title: note.title, content: note.content });
    setPreviewContent(note.content || "");
    setActiveTab("edit");
    setModalOpen(true);
  };

  const handleSave = async () => {
    const values = await form.validateFields();
    if (editingNote) {
      await updateNote(editingNote.id, values);
    } else {
      await createNote(values);
    }
    setModalOpen(false);
    form.resetFields();
  };

  const handleSearch = (v: string) => {
    setSearchQ(v);
    if (!v.trim()) {
      fetchNotes();
    }
  };

  const handleContentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setPreviewContent(e.target.value);
  };

  const isSearching = !!debouncedSearch.trim() && loading;

  return (
    <PageShell title="知识库" subtitle="Wiki 笔记管理" icon={<BookOutlined />}>
      {/* Stats */}
      <Row gutter={[24, 24]} style={{ marginBottom: 32 }}>
        <Col xs={12} md={6}>
          <Card
            style={{ borderRadius: 12, border: "1px solid var(--c-border)", boxShadow: "var(--shadow)" }}
            styles={{ body: { padding: 32 } }}
          >
            <Statistic
              title="笔记数"
              value={stats?.note_count || notes.length}
              prefix={<FileTextOutlined style={{ color: "var(--c-text-2)" }} />}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card
            style={{ borderRadius: 12, border: "1px solid var(--c-border)", boxShadow: "var(--shadow)" }}
            styles={{ body: { padding: 32 } }}
          >
            <Statistic
              title="标签数"
              value={stats?.tag_count || 0}
              prefix={<TagsOutlined style={{ color: "var(--c-text-2)" }} />}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card
            style={{ borderRadius: 12, border: "1px solid var(--c-border)", boxShadow: "var(--shadow)" }}
            styles={{ body: { padding: 32 } }}
          >
            <Statistic
              title="链接数"
              value={stats?.link_count || 0}
              prefix={<LinkOutlined style={{ color: "var(--c-text-2)" }} />}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card
            style={{ borderRadius: 12, border: "1px solid var(--c-border)", boxShadow: "var(--shadow)" }}
            styles={{ body: { padding: 32 } }}
          >
            <Statistic title="总字数" value={stats?.total_words || 0} />
          </Card>
        </Col>
      </Row>

      {/* Toolbar */}
      <div style={{ display: "flex", gap: 12, marginBottom: 32, flexWrap: "wrap" }}>
        <Input.Search
          placeholder="搜索笔记..."
          value={searchQ}
          onChange={(e) => handleSearch(e.target.value)}
          style={{ width: 320 }}
          allowClear
          loading={isSearching}
        />
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} style={{ height: 40, fontWeight: 600 }}>
          新建笔记
        </Button>
      </div>

      {/* Notes list */}
      {loading && notes.length === 0 ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 24 }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              style={{
                padding: 24,
                borderRadius: 12,
                border: "1px solid var(--c-border)",
                background: "var(--c-card)",
              }}
            >
              <Skeleton active paragraph={{ rows: 3 }} title={{ width: "60%" }} />
            </div>
          ))}
        </div>
      ) : displayNotes.length === 0 ? (
        <Empty
          description={
            <span style={{ color: "var(--c-text-3)", fontSize: 14, fontWeight: 300 }}>
              {query ? "无搜索结果" : "暂无笔记"}
            </span>
          }
        />
      ) : (
        <List
          grid={{ gutter: 24, xs: 1, sm: 1, md: 2, lg: 3 }}
          dataSource={displayNotes}
          renderItem={(note) => (
            <List.Item>
              <Card
                style={{ borderRadius: 12, border: "1px solid var(--c-border)", boxShadow: "var(--shadow)" }}
                title={<span style={{ fontWeight: 600, fontSize: 15, color: "var(--c-text)" }}>{note.title}</span>}
                styles={{ header: { padding: "20px 24px", borderBottom: "1px solid var(--c-border)" }, body: { padding: 24 } }}
                actions={[
                  <Button
                    key="edit"
                    type="text"
                    size="small"
                    icon={<EditOutlined />}
                    onClick={() => openEdit(note)}
                    style={{ color: "var(--c-text-2)" }}
                  />,
                  <Popconfirm key="delete" title="确认删除此笔记？" onConfirm={() => deleteNote(note.id)}>
                    <Button type="text" size="small" icon={<DeleteOutlined />} style={{ color: "var(--c-text-3)" }} />
                  </Popconfirm>,
                ]}
              >
                <div
                  style={{
                    color: "var(--c-text-2)",
                    fontSize: 13,
                    fontWeight: 300,
                    lineHeight: 1.6,
                    minHeight: 60,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    display: "-webkit-box",
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: "vertical",
                  }}
                >
                  {note.content}
                </div>
                <div style={{ marginTop: 12 }}>
                  {(note.tags || []).map((t: string) => (
                    <Tag
                      key={t}
                      style={{
                        fontSize: 11,
                        fontWeight: 300,
                        background: "var(--c-hover)",
                        border: "1px solid var(--c-border)",
                        color: "var(--c-text-2)",
                        borderRadius: 8,
                      }}
                    >
                      {t}
                    </Tag>
                  ))}
                </div>
              </Card>
            </List.Item>
          )}
        />
      )}

      {/* Modal with edit + preview tabs */}
      <Modal
        open={modalOpen}
        title={
          <span style={{ fontWeight: 600, fontSize: 16, color: "var(--c-text)" }}>
            {editingNote ? "编辑笔记" : "新建笔记"}
          </span>
        }
        onCancel={() => setModalOpen(false)}
        onOk={handleSave}
        okText="保存"
        width={800}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item label="标题" name="title" rules={[{ required: true, message: "请输入标题" }]}>
            <Input placeholder="笔记标题" className="wiki-modal-input" />
          </Form.Item>
          <Tabs
            activeKey={activeTab}
            onChange={setActiveTab}
            items={[
              {
                key: "edit",
                label: (
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <EditOutlined /> 编辑
                  </span>
                ),
                children: (
                  <Form.Item
                    name="content"
                    rules={[{ required: true, message: "请输入内容" }]}
                    style={{ marginBottom: 0 }}
                  >
                    <Input.TextArea
                      rows={14}
                      placeholder="支持 Markdown 语法..."
                      onChange={handleContentChange}
                      style={{ fontFamily: '"JetBrains Mono", "Fira Code", monospace', fontSize: 13, lineHeight: 1.7 }}
                    />
                  </Form.Item>
                ),
              },
              {
                key: "preview",
                label: (
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <EyeOutlined /> 预览
                  </span>
                ),
                children: (
                  <div
                    style={{
                      minHeight: 320,
                      maxHeight: 400,
                      overflow: "auto",
                      padding: 16,
                      borderRadius: 8,
                      border: "1px solid var(--c-border)",
                      background: "var(--c-page)",
                    }}
                  >
                    {previewContent ? (
                      <MarkdownRenderer content={previewContent} />
                    ) : (
                      <span style={{ color: "var(--c-text-3)", fontSize: 13 }}>开始输入 Markdown 内容以预览...</span>
                    )}
                  </div>
                ),
              },
            ]}
          />
        </Form>
      </Modal>
    </PageShell>
  );
}
