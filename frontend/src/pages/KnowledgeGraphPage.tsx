import { useState, useEffect, useMemo } from "react";
import { Input, Button, List, Tag, Empty, Spin, Card, Statistic, Row, Col, Drawer, Form, Select, Slider, message, Modal } from "antd";
import {
  ShareAltOutlined,
  DatabaseOutlined,
  NodeIndexOutlined,
  ApartmentOutlined,
  PlusOutlined,
  LinkOutlined,
  DeleteOutlined,
  ExclamationCircleOutlined,
} from "@ant-design/icons";
import { PageShell } from "../components/common/PageShell";
import { useKgStore } from "../stores/kgStore";
import type { KgEntity } from "../api/types";

const typeColors: Record<string, string> = {
  concept: "var(--c-text)",
  person: "var(--c-text-2)",
  organization: "var(--c-text-2)",
  location: "var(--c-text-2)",
  event: "var(--c-text-2)",
  unknown: "var(--c-text-3)",
};

const entityTypes = [
  { value: "concept", label: "概念" },
  { value: "person", label: "人物" },
  { value: "organization", label: "组织" },
  { value: "location", label: "地点" },
  { value: "event", label: "事件" },
  { value: "product", label: "产品" },
  { value: "technology", label: "技术" },
];

const relationTypes = [
  { value: "related_to", label: "相关" },
  { value: "part_of", label: "属于" },
  { value: "created_by", label: "创建者" },
  { value: "located_in", label: "位于" },
  { value: "works_for", label: "工作于" },
  { value: "friend_of", label: "朋友" },
  { value: "uses", label: "使用" },
];

export default function KnowledgeGraphPage() {
  const { entities, selectedEntity, entityRelations, stats, loading, fetchEntities, selectEntity, search, fetchStats, addEntity, addRelation, deleteEntity } =
    useKgStore();

  const [query, setQuery] = useState("");
  const [selectedType, setSelectedType] = useState<string>("");

  const [entityDrawerOpen, setEntityDrawerOpen] = useState(false);
  const [relationDrawerOpen, setRelationDrawerOpen] = useState(false);
  const [entityForm] = Form.useForm();
  const [relationForm] = Form.useForm();
  const [submitLoading, setSubmitLoading] = useState(false);

  useEffect(() => {
    fetchEntities();
    fetchStats();
  }, [fetchEntities, fetchStats]);

  const filtered = useMemo<KgEntity[]>(() => {
    return selectedType ? entities.filter((e: KgEntity) => e.type === selectedType) : entities;
  }, [entities, selectedType]);

  const types = useMemo<string[]>(() => {
    const set = new Set(entities.map((e: KgEntity) => e.type));
    return Array.from(set);
  }, [entities]);

  const handleSearch = (v: string) => {
    setQuery(v);
    if (v.trim()) search(v);
  };

  const handleAddEntity = async (values: { name: string; type: string; description: string }) => {
    setSubmitLoading(true);
    try {
      await addEntity({ name: values.name, type: values.type, description: values.description || "", mentionCount: 0 });
      message.success("实体添加成功");
      setEntityDrawerOpen(false);
      entityForm.resetFields();
      await fetchEntities();
      await fetchStats();
    } catch (err: any) {
      message.error(err?.message || "添加失败");
    } finally {
      setSubmitLoading(false);
    }
  };

  const handleAddRelation = async (values: { source: string; target: string; type: string; confidence: number }) => {
    setSubmitLoading(true);
    try {
      await addRelation({
        source: values.source,
        target: values.target,
        type: values.type,
        confidence: values.confidence,
      });
      message.success("关系添加成功");
      setRelationDrawerOpen(false);
      relationForm.resetFields();
    } catch (err: any) {
      message.error(err?.message || "添加失败");
    } finally {
      setSubmitLoading(false);
    }
  };

  return (
    <PageShell title="知识图谱" subtitle="实体关系可视化与管理" icon={<ShareAltOutlined />}>
      {/* Stats */}
      <Row gutter={[24, 24]} style={{ marginBottom: 48 }}>
        <Col xs={12} md={6}>
          <Card
            style={{ borderRadius: 12, border: "1px solid var(--c-border)", boxShadow: "var(--shadow)" }}
            styles={{ body: { padding: 32 } }}
          >
            <Statistic
              title="实体数"
              value={stats?.entity_count || entities.length}
              prefix={<DatabaseOutlined style={{ color: "var(--c-text-2)" }} />}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card
            style={{ borderRadius: 12, border: "1px solid var(--c-border)", boxShadow: "var(--shadow)" }}
            styles={{ body: { padding: 32 } }}
          >
            <Statistic
              title="关系数"
              value={stats?.relation_count || 0}
              prefix={<NodeIndexOutlined style={{ color: "var(--c-text-2)" }} />}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card
            style={{ borderRadius: 12, border: "1px solid var(--c-border)", boxShadow: "var(--shadow)" }}
            styles={{ body: { padding: 32 } }}
          >
            <Statistic
              title="实体类型"
              value={types.length}
              prefix={<ApartmentOutlined style={{ color: "var(--c-text-2)" }} />}
            />
          </Card>
        </Col>
      </Row>

      {/* Toolbar */}
      <div style={{ display: "flex", gap: 12, marginBottom: 32, flexWrap: "wrap", alignItems: "center" }}>
        <Input.Search
          placeholder="搜索实体..."
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
          style={{ width: 320 }}
          allowClear
        />
        <div style={{ display: "flex", gap: 8 }}>
          <Button
            size="small"
            type={selectedType === "" ? "primary" : "default"}
            onClick={() => setSelectedType("")}
            style={{ height: 32, fontWeight: selectedType === "" ? 600 : 400 }}
          >
            全部
          </Button>
          {types.map((t: string) => (
            <Button
              key={t}
              size="small"
              type={selectedType === t ? "primary" : "default"}
              onClick={() => setSelectedType(t)}
              style={{ height: 32, fontWeight: selectedType === t ? 600 : 400 }}
            >
              {t}
            </Button>
          ))}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <Button icon={<PlusOutlined />} onClick={() => setEntityDrawerOpen(true)}>
            添加实体
          </Button>
          <Button icon={<LinkOutlined />} onClick={() => setRelationDrawerOpen(true)}>
            添加关系
          </Button>
        </div>
      </div>

      {/* Selected entity detail */}
      {selectedEntity && (
        <Card
          style={{
            marginBottom: 32,
            borderRadius: 12,
            border: "1px solid var(--c-border)",
            boxShadow: "var(--shadow)",
          }}
          styles={{ body: { padding: 32 } }}
        >
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
            <div>
              <Tag
                style={{
                  background: "var(--c-hover)",
                  border: "1px solid var(--c-border)",
                  color: typeColors[selectedEntity.type] || "var(--c-text-2)",
                  fontSize: 12,
                  fontWeight: 300,
                  borderRadius: 8,
                }}
              >
                {selectedEntity.type}
              </Tag>
              <div
                style={{
                  marginTop: 10,
                  color: "var(--c-text-2)",
                  fontSize: 14,
                  fontWeight: 300,
                  lineHeight: 1.6,
                  maxWidth: 400,
                }}
              >
                {selectedEntity.description || "无描述"}
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 12, color: "var(--c-text)" }}>关系</div>
              {entityRelations.length === 0 ? (
                <div style={{ color: "var(--c-text-3)", fontSize: 13, fontWeight: 300 }}>无关系</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {entityRelations.map((r: { id?: string; relation?: string; target?: string; type?: string }) => (
                    <div
                      key={r.id}
                      style={{
                        fontSize: 13,
                        padding: "8px 12px",
                        borderRadius: 8,
                        background: "var(--c-hover)",
                        border: "1px solid var(--c-border)",
                      }}
                    >
                      <Tag
                        style={{
                          fontSize: 11,
                          background: "transparent",
                          border: "none",
                          padding: 0,
                          color: "var(--c-text-2)",
                        }}
                      >
                        {r.type}
                      </Tag>
                      <span style={{ color: "var(--c-text-3)" }}> → {r.target}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* Entities list */}
      {loading && entities.length === 0 ? (
        <div style={{ textAlign: "center", padding: 80 }}>
          <Spin size="large" />
        </div>
      ) : filtered.length === 0 ? (
        <Empty
          description={<span style={{ color: "var(--c-text-3)", fontSize: 14, fontWeight: 300 }}>暂无实体</span>}
        />
      ) : (
        <List
          grid={{ gutter: 24, xs: 1, sm: 2, md: 3, lg: 4 }}
          dataSource={filtered}
          renderItem={(e: KgEntity) => (
            <List.Item>
              <Card
                size="small"
                hoverable
                onClick={() => selectEntity(e.id)}
                style={{
                  borderRadius: 12,
                  border: "1px solid var(--c-border)",
                  boxShadow: "var(--shadow)",
                  borderLeft: `3px solid ${typeColors[e.type] || "var(--c-text-3)"}`,
                  cursor: "pointer",
                }}
                styles={{ body: { padding: 24 } }}
              >
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6, color: "var(--c-text)" }}>{e.name}</div>
                <Tag
                  style={{
                    background: "var(--c-hover)",
                    border: "1px solid var(--c-border)",
                    color: "var(--c-text-2)",
                    fontSize: 11,
                    fontWeight: 300,
                    borderRadius: 8,
                  }}
                >
                  {e.type}
                </Tag>
                <div
                  style={{
                    marginTop: 8,
                    color: "var(--c-text-3)",
                    fontSize: 12,
                    fontWeight: 300,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {e.description || "—"}
                </div>
                <div style={{ marginTop: 8, display: "flex", justifyContent: "flex-end" }}>
                  <Button
                    type="text"
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      Modal.confirm({
                        title: "确认删除",
                        icon: <ExclamationCircleOutlined />,
                        content: `确定要删除实体 "${e.name}" 吗？相关关系也会被删除。`,
                        okText: "删除",
                        okType: "danger",
                        cancelText: "取消",
                        onOk: () => deleteEntity(e.id),
                      });
                    }}
                  >
                    删除
                  </Button>
                </div>
              </Card>
            </List.Item>
          )}
        />
      )}

      {/* Add Entity Drawer */}
      <Drawer
        title={<span style={{ fontWeight: 600, fontSize: 16, color: "var(--c-text)" }}>添加实体</span>}
        open={entityDrawerOpen}
        onClose={() => setEntityDrawerOpen(false)}
        width={420}
      >
        <Form form={entityForm} layout="vertical" onFinish={handleAddEntity}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: "请输入实体名称" }]}>
            <Input placeholder="例如: OpenAI" />
          </Form.Item>
          <Form.Item name="type" label="类型" rules={[{ required: true, message: "请选择实体类型" }]}>
            <Select placeholder="选择类型" options={entityTypes} />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={3} placeholder="实体的描述信息..." />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={submitLoading} block>
              添加
            </Button>
          </Form.Item>
        </Form>
      </Drawer>

      {/* Add Relation Drawer */}
      <Drawer
        title={<span style={{ fontWeight: 600, fontSize: 16, color: "var(--c-text)" }}>添加关系</span>}
        open={relationDrawerOpen}
        onClose={() => setRelationDrawerOpen(false)}
        width={420}
      >
        <Form form={relationForm} layout="vertical" onFinish={handleAddRelation}>
          <Form.Item name="source" label="源实体" rules={[{ required: true, message: "请输入源实体名称" }]}>
            <Input placeholder="源实体名称" />
          </Form.Item>
          <Form.Item name="target" label="目标实体" rules={[{ required: true, message: "请输入目标实体名称" }]}>
            <Input placeholder="目标实体名称" />
          </Form.Item>
          <Form.Item name="type" label="关系类型" rules={[{ required: true, message: "请选择关系类型" }]}>
            <Select placeholder="选择关系类型" options={relationTypes} />
          </Form.Item>
          <Form.Item name="confidence" label="置信度" initialValue={0.8}>
            <Slider min={0} max={1} step={0.05} marks={{ 0: "0", 0.5: "0.5", 1: "1" }} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={submitLoading} block>
              添加
            </Button>
          </Form.Item>
        </Form>
      </Drawer>
    </PageShell>
  );
}
