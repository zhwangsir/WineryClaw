import { useState, useEffect } from "react";
import { Button, Tag, Table, Drawer, Form, Input, Select, message, Statistic, Popconfirm, Space } from "antd";
import { ThunderboltOutlined, ReloadOutlined, PlusOutlined, EditOutlined, DeleteOutlined, PlayCircleOutlined } from "@ant-design/icons";
import { PageShell } from "../components/common/PageShell";
import { skillsApi, type Skill, type SkillStats } from "../api/skills";
import { EmptyState } from "../components/common/EmptyState";

const { TextArea } = Input;

export default function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [stats, setStats] = useState<SkillStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null);
  const [invokeModalOpen, setInvokeModalOpen] = useState(false);
  const [invokeSkillId, setInvokeSkillId] = useState<string>("");
  const [invokeParams, setInvokeParams] = useState("{}");
  const [invokeLoading, setInvokeLoading] = useState(false);
  const [invokeResult, setInvokeResult] = useState<string>("");
  const [form] = Form.useForm();

  const fetchData = async () => {
    setLoading(true);
    try {
      const [list, s] = await Promise.all([skillsApi.list(), skillsApi.stats()]);
      setSkills(list);
      setStats(s);
    } catch (e: any) {
      message.error("Failed to load skills: " + e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const openCreate = () => {
    setEditingSkill(null);
    form.resetFields();
    setDrawerOpen(true);
  };

  const openEdit = (skill: Skill) => {
    setEditingSkill(skill);
    form.setFieldsValue({
      name: skill.name,
      description: skill.description,
      language: skill.language,
      code: skill.code,
      triggerPatterns: skill.triggerPatterns.join(", "),
      tags: skill.tags.join(", "),
    });
    setDrawerOpen(true);
  };

  const handleSubmit = async (values: any) => {
    const payload = {
      name: values.name,
      description: values.description,
      code: values.code,
      language: values.language,
      triggerPatterns: values.triggerPatterns?.split(",").map((s: string) => s.trim()).filter(Boolean),
      tags: values.tags?.split(",").map((s: string) => s.trim()).filter(Boolean),
    };
    try {
      if (editingSkill) {
        await skillsApi.update(editingSkill.id, payload);
        message.success("Skill updated");
      } else {
        await skillsApi.create(payload as any);
        message.success("Skill created");
      }
      setDrawerOpen(false);
      form.resetFields();
      setEditingSkill(null);
      fetchData();
    } catch (e: any) {
      message.error(e.message);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await skillsApi.delete(id);
      message.success("Skill deleted");
      fetchData();
    } catch (e: any) {
      message.error(e.message);
    }
  };

  const openInvoke = (skill: Skill) => {
    setInvokeSkillId(skill.id);
    setInvokeParams("{}");
    setInvokeResult("");
    setInvokeModalOpen(true);
  };

  const handleInvoke = async () => {
    setInvokeLoading(true);
    try {
      let params = {};
      try { params = JSON.parse(invokeParams); } catch { /* ignore */ }
      const result = await skillsApi.invoke(invokeSkillId, params);
      setInvokeResult(JSON.stringify(result, null, 2));
    } catch (e: any) {
      setInvokeResult("Error: " + e.message);
    } finally {
      setInvokeLoading(false);
    }
  };

  const columns = [
    {
      title: "Name",
      dataIndex: "name",
      key: "name",
      render: (_: string, s: Skill) => (
        <div>
          <div style={{ fontWeight: 600 }}>{s.name}</div>
          <div style={{ fontSize: 12, color: "var(--c-text-3)" }}>{s.id}</div>
        </div>
      ),
    },
    {
      title: "Language",
      dataIndex: "language",
      key: "language",
      width: 100,
      render: (v: string) => <Tag>{v}</Tag>,
    },
    {
      title: "Usage",
      key: "usage",
      width: 120,
      render: (_: unknown, s: Skill) => (
        <div style={{ fontSize: 12 }}>
          <div>{s.usageCount} invocations</div>
          <div style={{ color: "var(--c-text-3)" }}>{(s.successRate * 100).toFixed(0)}% success</div>
        </div>
      ),
    },
    {
      title: "Triggers",
      key: "triggers",
      render: (_: unknown, s: Skill) => {
        // Q14.4 (2026-05-21) — `__never-match__` is an internal sentinel
        // meaning "no auto-trigger, only explicit /skills run". Don't
        // leak it into the UI as a literal Tag — render an em-dash if
        // it's the only pattern, otherwise filter just the sentinel out.
        const visible = s.triggerPatterns.filter((t) => t !== "__never-match__");
        if (visible.length === 0) {
          return <span style={{ fontSize: 12, color: "var(--c-text-3)" }}>—</span>;
        }
        return (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {visible.map((t) => (
              <Tag key={t}>{t}</Tag>
            ))}
          </div>
        );
      },
    },
    {
      title: "Actions",
      key: "actions",
      width: 160,
      render: (_: unknown, s: Skill) => (
        <Space>
          <Button size="small" icon={<PlayCircleOutlined />} onClick={() => openInvoke(s)}>
            Run
          </Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(s)}>
            Edit
          </Button>
          <Popconfirm title="Delete this skill?" onConfirm={() => handleDelete(s.id)}>
            <Button size="small" danger icon={<DeleteOutlined />}>
              Del
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <PageShell
      title="技能"
      subtitle={`已注册 ${skills.length} 个技能`}
      icon={<ThunderboltOutlined />}
    >
      <div style={{ marginBottom: 24, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", gap: 24 }}>
          {stats && (
            <>
              <Statistic title="Total Skills" value={stats.totalSkills} />
              <Statistic title="Invocations" value={stats.totalInvocations} />
              <Statistic title="Success Rate" value={(stats.averageSuccessRate * 100).toFixed(0)} suffix="%" />
            </>
          )}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Button icon={<ReloadOutlined />} onClick={fetchData} loading={loading}>
            Refresh
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            New Skill
          </Button>
        </div>
      </div>

      {skills.length === 0 && !loading ? (
        <EmptyState description="No skills registered" />
      ) : (
        <Table dataSource={skills} columns={columns} rowKey="id" loading={loading} pagination={false} />
      )}

      {/* Create / Edit Drawer */}
      <Drawer
        title={editingSkill ? "Edit Skill" : "Create Skill"}
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); setEditingSkill(null); }}
        width={520}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input placeholder="e.g., summarize_text" />
          </Form.Item>
          <Form.Item name="description" label="Description" rules={[{ required: true }]}>
            <Input placeholder="What does this skill do?" />
          </Form.Item>
          <Form.Item name="language" label="Language" rules={[{ required: true }]} initialValue="python">
            <Select options={[
              { label: "Python", value: "python" },
              { label: "JavaScript", value: "javascript" },
              { label: "TypeScript", value: "typescript" },
            ]} />
          </Form.Item>
          <Form.Item name="code" label="Code" rules={[{ required: true }]}>
            <TextArea rows={8} placeholder="def run(params): ..." />
          </Form.Item>
          <Form.Item name="triggerPatterns" label="Trigger Patterns (comma-separated)">
            <Input placeholder="e.g., summarize, tl;dr" />
          </Form.Item>
          <Form.Item name="tags" label="Tags (comma-separated)">
            <Input placeholder="e.g., text, automation" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit">
              {editingSkill ? "Update" : "Create"}
            </Button>
          </Form.Item>
        </Form>
      </Drawer>

      {/* Invoke Drawer */}
      <Drawer
        title="Invoke Skill"
        open={invokeModalOpen}
        onClose={() => setInvokeModalOpen(false)}
        width={480}
        destroyOnClose
      >
        <Form layout="vertical">
          <Form.Item label="Parameters (JSON)">
            <TextArea
              rows={4}
              value={invokeParams}
              onChange={(e) => setInvokeParams(e.target.value)}
              placeholder='{"text": "hello world"}'
            />
          </Form.Item>
          <Button type="primary" onClick={handleInvoke} loading={invokeLoading}>
            Run
          </Button>
          {invokeResult && (
            <pre style={{ marginTop: 16, padding: 12, background: "var(--c-hover)", borderRadius: 8, fontSize: 12 }}>
              {invokeResult}
            </pre>
          )}
        </Form>
      </Drawer>
    </PageShell>
  );
}
