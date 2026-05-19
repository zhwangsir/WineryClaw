import { useState, useEffect } from "react";
import { Button, Card, Drawer, Form, Input, Select, Tag, Empty, Tooltip, Popconfirm } from "antd";
import {
  FileTextOutlined,
  PlusOutlined,
  DeleteOutlined,
  CopyOutlined,
  TagsOutlined,
  FolderOutlined,
} from "@ant-design/icons";
import { PageShell } from "../components/common/PageShell";
import { useTemplateStore } from "../stores/templateStore";
import type { AgentTemplate } from "../api/types";

export default function TemplatesPage() {
  const { templates, categories, fetchTemplates, fetchCategories, fetchTags, createTemplate, deleteTemplate, instantiate } =
    useTemplateStore();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [instOpen, setInstOpen] = useState(false);
  const [instTemplate, setInstTemplate] = useState<AgentTemplate | null>(null);
  const [form] = Form.useForm();
  const [instForm] = Form.useForm();
  const [selectedCategory, setSelectedCategory] = useState<string>("");

  useEffect(() => {
    fetchTemplates();
    fetchCategories();
    fetchTags();
  }, [fetchTemplates, fetchCategories, fetchTags]);

  useEffect(() => {
    fetchTemplates(selectedCategory || undefined);
  }, [selectedCategory, fetchTemplates]);

  const handleCreate = async (values: Partial<AgentTemplate>) => {
    await createTemplate(values);
    setDrawerOpen(false);
    form.resetFields();
  };

  const handleInstantiate = async (values: { name: string }) => {
    if (!instTemplate) return;
    await instantiate(instTemplate.id, { name: values.name });
    setInstOpen(false);
    instForm.resetFields();
  };

  return (
    <PageShell
      title="模板"
      subtitle="智能体模板管理与实例化"
      icon={<FileTextOutlined />}
      actions={
        <Button type="primary" icon={<PlusOutlined />} style={{ height: 40 }} onClick={() => setDrawerOpen(true)}>
          新建模板
        </Button>
      }
    >
      {/* Category filter */}
      <div style={{ display: "flex", gap: 8, marginBottom: 24, flexWrap: "wrap" }}>
        <Button size="small" type={selectedCategory === "" ? "primary" : "default"} onClick={() => setSelectedCategory("")}>
          全部
        </Button>
        {categories.map((c) => (
          <Button key={c} size="small" type={selectedCategory === c ? "primary" : "default"} onClick={() => setSelectedCategory(c)}>
            {c}
          </Button>
        ))}
      </div>

      {templates.length === 0 ? (
        <Empty description={<span style={{ color: "var(--c-text-3)" }}>暂无模板</span>} />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 20 }}>
          {templates.map((t) => (
            <Card
              key={t.id}
              style={{ borderRadius: 12, border: "1px solid var(--c-border)", boxShadow: "var(--shadow)" }}
              bodyStyle={{ padding: 24 }}
              title={
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <FolderOutlined style={{ color: "var(--c-text-2)" }} />
                  <span style={{ fontWeight: 600, fontSize: 15, color: "var(--c-text)" }}>{t.name}</span>
                </div>
              }
              headStyle={{ padding: "16px 20px", borderBottom: "1px solid var(--c-border)" }}
              actions={[
                <Tooltip title="实例化">
                  <Button
                    type="text"
                    size="small"
                    icon={<CopyOutlined />}
                    style={{ color: "var(--c-accent)" }}
                    onClick={() => { setInstTemplate(t); setInstOpen(true); }}
                  >
                    实例化
                  </Button>
                </Tooltip>,
                <Popconfirm title="确认删除" description={`删除模板 "${t.name}"？`} onConfirm={() => deleteTemplate(t.id)} okText="删除" cancelText="取消">
                  <Button type="text" size="small" danger icon={<DeleteOutlined />}>删除</Button>
                </Popconfirm>,
              ]}
            >
              <div style={{ fontSize: 13, color: "var(--c-text-2)", marginBottom: 12, minHeight: 20 }}>
                {t.description || "无描述"}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                <Tag style={{ fontSize: 11, margin: 0 }}>{t.category}</Tag>
                {t.role && <Tag style={{ fontSize: 11, margin: 0 }}>{t.role}</Tag>}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {t.tags?.map((tag) => (
                  <Tag key={tag} style={{ fontSize: 10, margin: 0, background: "var(--c-hover)", border: "none" }}>
                    <TagsOutlined style={{ marginRight: 2 }} />{tag}
                  </Tag>
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Create Drawer */}
      <Drawer
        title={<span style={{ fontWeight: 600, fontSize: 16, color: "var(--c-text)" }}>新建模板</span>}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={480}
      >
        <Form form={form} layout="vertical" onFinish={handleCreate}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: "请输入模板名称" }]}>
            <Input placeholder="模板名称" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={2} placeholder="模板描述..." />
          </Form.Item>
          <Form.Item name="category" label="分类" rules={[{ required: true, message: "请输入分类" }]}>
            <Input placeholder="例如: development, support" />
          </Form.Item>
          <Form.Item name="role" label="角色">
            <Select placeholder="选择角色" options={[
              { value: "general", label: "通用助手" },
              { value: "developer", label: "开发工程师" },
              { value: "analyst", label: "数据分析师" },
              { value: "writer", label: "写作助手" },
              { value: "support", label: "客服" },
            ]} />
          </Form.Item>
          <Form.Item name="systemPrompt" label="系统提示词">
            <Input.TextArea rows={4} placeholder="定义智能体的系统提示词..." />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" block>创建</Button>
          </Form.Item>
        </Form>
      </Drawer>

      {/* Instantiate Drawer */}
      <Drawer
        title={<span style={{ fontWeight: 600, fontSize: 16, color: "var(--c-text)" }}>实例化模板: {instTemplate?.name}</span>}
        open={instOpen}
        onClose={() => setInstOpen(false)}
        width={420}
      >
        <Form form={instForm} layout="vertical" onFinish={handleInstantiate}>
          <Form.Item name="name" label="智能体名称" rules={[{ required: true, message: "请输入智能体名称" }]}>
            <Input placeholder="新智能体的名称" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" block icon={<CopyOutlined />}>实例化</Button>
          </Form.Item>
        </Form>
      </Drawer>
    </PageShell>
  );
}
