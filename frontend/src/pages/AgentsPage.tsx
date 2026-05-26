import { useState, useEffect } from "react";
import {
  Button,
  Drawer,
  Form,
  Input,
  Select,
  Switch,
  message,
  Tooltip,
  Popconfirm,
  Tag,
  Tabs,
  Checkbox,
  Row,
  Col,
} from "antd";
import {
  PlusOutlined,
  TeamOutlined,
  EditOutlined,
  DeleteOutlined,
  RobotOutlined,
  SettingOutlined,
  ToolOutlined,
  FileTextOutlined,
  ThunderboltOutlined,
  CodeOutlined,
  GlobalOutlined,
  PlayCircleOutlined,
} from "@ant-design/icons";
import { PageShell } from "../components/common/PageShell";
import { useAgentStore } from "../stores/agentStore";
import { StatusBadge } from "../components/common/StatusBadge";
import { EmptyState } from "../components/common/EmptyState";
import type { Agent, AgentToolConfig } from "../api/types";

const { TextArea } = Input;

const ALL_TOOLS: AgentToolConfig[] = [
  { name: "execute_shell", enabled: true, description: "执行本地 shell 命令" },
  { name: "read_file", enabled: true, description: "读取文件内容" },
  { name: "write_file", enabled: true, description: "写入文件" },
  { name: "http_request", enabled: true, description: "HTTP 请求" },
  { name: "browse_web", enabled: true, description: "浏览网页" },
];

const ROLE_OPTIONS = [
  { label: "通用助手", value: "general" },
  { label: "开发工程师", value: "developer" },
  { label: "数据分析师", value: "analyst" },
  { label: "写作助手", value: "writer" },
  { label: "客服", value: "support" },
  { label: "自定义", value: "custom" },
];

const CAPABILITY_OPTIONS = [
  { label: "对话", value: "chat" },
  { label: "推理", value: "reasoning" },
  { label: "工具使用", value: "tool_use" },
  { label: "记忆", value: "memory" },
];

export default function AgentsPage() {
  const { agents, fetchAgents, createAgent, updateAgent, deleteAgent, updateSystemPrompt, getSystemPrompt, runAgent } =
    useAgentStore();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [activeTab, setActiveTab] = useState("basic");
  const [form] = Form.useForm();
  const [systemPrompt, setSystemPrompt] = useState("");
  const [tools, setTools] = useState<AgentToolConfig[]>(ALL_TOOLS);
  const [saving, setSaving] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [runAgentId, setRunAgentId] = useState("");
  const [runResult, setRunResult] = useState("");
  const [runLoading, setRunLoading] = useState(false);
  const [runForm] = Form.useForm();

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  const openCreate = () => {
    setEditingAgent(null);
    setSystemPrompt("");
    setTools(ALL_TOOLS.map((t) => ({ ...t })));
    setActiveTab("basic");
    form.resetFields();
    form.setFieldsValue({
      role: "general",
      capabilities: ["chat", "reasoning", "tool_use", "memory"],
      enabled: true,
    });
    setDrawerOpen(true);
  };

  const openEdit = async (agent: Agent) => {
    setEditingAgent(agent);
    setActiveTab("basic");
    form.setFieldsValue({
      name: agent.name,
      description: agent.description,
      role: agent.role || "general",
      capabilities: agent.capabilities || ["chat", "reasoning", "tool_use", "memory"],
      enabled: agent.enabled ?? true,
      modelConfig: {
        baseUrl: agent.modelConfig?.baseUrl || "",
        modelId: agent.modelConfig?.modelId || "",
        temperature: agent.modelConfig?.temperature ?? 0.7,
        maxTokens: agent.modelConfig?.maxTokens ?? 4096,
      },
    });
    // Load system prompt
    const prompt = await getSystemPrompt(agent.id);
    setSystemPrompt(prompt);
    // Load tools
    const agentTools = agent.tools || [];
    setTools(
      ALL_TOOLS.map((t) => ({
        ...t,
        enabled:
          agentTools.includes(t.name) ||
          agentTools.includes(t.name.replace("execute_", "").replace("read_", "file_").replace("write_", "file_")),
      }))
    );
    setDrawerOpen(true);
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);

      const payload: Partial<Agent> = {
        name: values.name,
        description: values.description || "",
        role: values.role,
        capabilities: values.capabilities || ["chat", "reasoning", "tool_use", "memory"],
        enabled: values.enabled ?? true,
        modelConfig: values.modelConfig?.baseUrl
          ? {
              baseUrl: values.modelConfig.baseUrl,
              modelId: values.modelConfig.modelId,
              temperature: values.modelConfig.temperature,
              maxTokens: values.modelConfig.maxTokens,
            }
          : {},
        tools: tools.filter((t) => t.enabled).map((t) => t.name),
      };

      if (editingAgent) {
        await updateAgent(editingAgent.id, payload);
        // Update system prompt separately
        if (systemPrompt) {
          await updateSystemPrompt(editingAgent.id, systemPrompt);
        }
      } else {
        const agent = await createAgent(payload);
        if (agent && systemPrompt) {
          await updateSystemPrompt(agent.id, systemPrompt);
        }
      }

      setDrawerOpen(false);
      setEditingAgent(null);
    } catch (e: any) {
      if (e.errorFields) {
        message.error("请填写必填项");
      } else {
        message.error(e.message || "保存失败");
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    await deleteAgent(id);
  };

  const openRun = (agent: Agent) => {
    setRunAgentId(agent.id);
    setRunResult("");
    runForm.resetFields();
    setRunOpen(true);
  };

  const handleRun = async (values: { input: string }) => {
    setRunLoading(true);
    try {
      const result = await runAgent(runAgentId, values.input);
      setRunResult(String(result || ""));
    } finally {
      setRunLoading(false);
    }
  };

  const getRoleLabel = (role?: string) => {
    const found = ROLE_OPTIONS.find((r) => r.value === role);
    return found?.label || role || "通用";
  };

  const getRoleIcon = (role?: string) => {
    switch (role) {
      case "developer":
        return <CodeOutlined />;
      case "analyst":
        return <ThunderboltOutlined />;
      case "writer":
        return <FileTextOutlined />;
      case "support":
        return <TeamOutlined />;
      default:
        return <RobotOutlined />;
    }
  };

  return (
    <PageShell
      title="智能体"
      subtitle="管理 AI 智能体 — 每个智能体拥有独立的配置、提示词和工具"
      icon={<TeamOutlined />}
      actions={
        <Button type="primary" icon={<PlusOutlined />} style={{ height: 40, fontWeight: 600 }} onClick={openCreate}>
          新建智能体
        </Button>
      }
    >
      {agents.length === 0 ? (
        <EmptyState description="暂无智能体" actionLabel="创建第一个智能体" onAction={openCreate} />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 20 }}>
          {agents.map((agent) => (
            <div
              key={agent.id}
              style={{
                padding: "24px",
                borderRadius: 12,
                border: "1px solid var(--c-border)",
                background: "var(--c-card)",
                boxShadow: "var(--shadow)",
                transition: "all 200ms",
                cursor: "pointer",
                position: "relative",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.boxShadow = "var(--shadow-hover)";
                (e.currentTarget as HTMLElement).style.transform = "translateY(-2px)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.boxShadow = "var(--shadow)";
                (e.currentTarget as HTMLElement).style.transform = "translateY(0)";
              }}
              onClick={() => openEdit(agent)}
            >
              {/* Header */}
              <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 12 }}>
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 10,
                    background: "var(--c-accent-soft)",
                    color: "var(--c-accent)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 20,
                    flexShrink: 0,
                  }}
                >
                  {getRoleIcon(agent.role)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span
                      style={{
                        fontWeight: 600,
                        fontSize: 16,
                        color: "var(--c-text)",
                        lineHeight: 1.3,
                      }}
                    >
                      {agent.name}
                    </span>
                    {agent.isDefault && (
                      <Tag color="blue" style={{ fontSize: 11, margin: 0 }}>
                        默认
                      </Tag>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--c-text-2)" }}>{getRoleLabel(agent.role)}</div>
                </div>
                <StatusBadge status={agent.enabled ? "ok" : "disconnected"} />
              </div>

              {/* Description */}
              <div
                style={{
                  color: "var(--c-text-2)",
                  fontSize: 13,
                  lineHeight: 1.6,
                  marginBottom: 16,
                  minHeight: 20,
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }}
              >
                {agent.description || "暂无描述"}
              </div>

              {/* Meta */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                {(agent.capabilities || []).map((cap) => (
                  <Tag key={cap} style={{ fontSize: 11, margin: 0 }}>
                    {cap}
                  </Tag>
                ))}
              </div>

              {/* Footer */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  borderTop: "1px solid var(--c-border)",
                  paddingTop: 12,
                }}
              >
                <div style={{ fontSize: 12, color: "var(--c-text-3)" }}>
                  {agent.modelConfig?.modelId ? (
                    <Tooltip title={agent.modelConfig.modelId}>
                      <span>
                        <GlobalOutlined style={{ marginRight: 4 }} />
                        {agent.modelConfig.modelId.split("/").pop()}
                      </span>
                    </Tooltip>
                  ) : (
                    <span>使用全局模型</span>
                  )}
                </div>
                <div style={{ display: "flex", gap: 4 }}>
                  <Tooltip title="运行">
                    <Button
                      size="small"
                      type="text"
                      icon={<PlayCircleOutlined />}
                      style={{ color: "var(--c-accent)" }}
                      onClick={(e) => {
                        e.stopPropagation();
                        openRun(agent);
                      }}
                    />
                  </Tooltip>
                  <Tooltip title="编辑">
                    <Button
                      size="small"
                      type="text"
                      icon={<EditOutlined />}
                      onClick={(e) => {
                        e.stopPropagation();
                        openEdit(agent);
                      }}
                    />
                  </Tooltip>
                  {!agent.isDefault && (
                    <Popconfirm
                      title="确认删除"
                      description={`删除智能体 "${agent.name}"？此操作不可恢复。`}
                      onConfirm={(e) => {
                        e?.stopPropagation();
                        handleDelete(agent.id);
                      }}
                      onCancel={(e) => e?.stopPropagation()}
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                    >
                      <Tooltip title="删除">
                        <Button
                          size="small"
                          type="text"
                          danger
                          icon={<DeleteOutlined />}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </Tooltip>
                    </Popconfirm>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create / Edit Drawer */}
      <Drawer
        title={
          <span style={{ fontWeight: 600, fontSize: 16, color: "var(--c-text)" }}>
            {editingAgent ? `编辑: ${editingAgent.name}` : "新建智能体"}
          </span>
        }
        width={600}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        destroyOnHidden
        footer={
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 12 }}>
            <Button onClick={() => setDrawerOpen(false)}>取消</Button>
            <Button type="primary" loading={saving} onClick={handleSave}>
              {editingAgent ? "保存" : "创建"}
            </Button>
          </div>
        }
      >
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            {
              key: "basic",
              label: (
                <span>
                  <RobotOutlined /> 基本信息
                </span>
              ),
              children: (
                <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
                  <Form.Item label="名称" name="name" rules={[{ required: true, message: "请输入智能体名称" }]}>
                    <Input placeholder="例如: 代码助手" />
                  </Form.Item>
                  <Form.Item label="描述" name="description">
                    <TextArea rows={2} placeholder="描述智能体的功能和特点..." />
                  </Form.Item>
                  <Form.Item label="角色" name="role" rules={[{ required: true }]}>
                    <Select options={ROLE_OPTIONS} placeholder="选择角色类型" />
                  </Form.Item>
                  <Form.Item label="能力" name="capabilities">
                    <Checkbox.Group options={CAPABILITY_OPTIONS} />
                  </Form.Item>
                  <Form.Item label="启用" name="enabled" valuePropName="checked">
                    <Switch />
                  </Form.Item>
                </Form>
              ),
            },
            {
              key: "prompt",
              label: (
                <span>
                  <FileTextOutlined /> 系统提示词
                </span>
              ),
              children: (
                <>
                  <div style={{ marginBottom: 12, fontSize: 13, color: "var(--c-text-2)" }}>
                    支持模板变量：{"{{tools}}"}、{"{{memory}}"}、{"{{agent_name}}"}、{"{{agent_role}}"}
                  </div>
                  <TextArea
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    rows={20}
                    placeholder={`# 角色定义

你是 {{agent_name}}，一个专业的 AI 助手。

## 可用工具
{{tools}}

## 相关记忆
{{memory}}
`}
                    style={{ fontFamily: "monospace", fontSize: 13 }}
                  />
                </>
              ),
            },
            {
              key: "tools",
              label: (
                <span>
                  <ToolOutlined /> 工具配置
                </span>
              ),
              children: (
                <>
                  <div style={{ marginBottom: 12, fontSize: 13, color: "var(--c-text-2)" }}>
                    选择该智能体可以使用的工具
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {tools.map((tool, idx) => (
                      <div
                        key={tool.name}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 12,
                          padding: "10px 12px",
                          borderRadius: 8,
                          border: "1px solid var(--c-border)",
                          background: tool.enabled ? "var(--c-accent-soft)" : "transparent",
                        }}
                      >
                        <Checkbox
                          checked={tool.enabled}
                          onChange={(e) => {
                            const next = [...tools];
                            next[idx].enabled = e.target.checked;
                            setTools(next);
                          }}
                        />
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 500, fontSize: 14 }}>{tool.name}</div>
                          <div style={{ fontSize: 12, color: "var(--c-text-2)" }}>{tool.description}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ),
            },
            {
              key: "model",
              label: (
                <span>
                  <SettingOutlined /> 模型配置
                </span>
              ),
              children: (
                <Form form={form} layout="vertical">
                  <Form.Item label="模型 Base URL" name={["modelConfig", "baseUrl"]}>
                    <Input placeholder="留空使用全局配置，例如: http://localhost:1234/v1" />
                  </Form.Item>
                  <Form.Item label="模型 ID" name={["modelConfig", "modelId"]}>
                    <Input placeholder="留空使用全局配置，例如: unsloth/qwen3.5-397b-a17b" />
                  </Form.Item>
                  <Row gutter={16}>
                    <Col span={12}>
                      <Form.Item label="温度 (Temperature)" name={["modelConfig", "temperature"]}>
                        <Input type="number" min={0} max={2} step={0.1} placeholder="0.7" />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item label="最大 Token" name={["modelConfig", "maxTokens"]}>
                        <Input type="number" min={256} max={32768} step={256} placeholder="4096" />
                      </Form.Item>
                    </Col>
                  </Row>
                  <div style={{ fontSize: 12, color: "var(--c-text-3)", marginTop: 8 }}>
                    留空以上所有字段将使用全局模型配置
                  </div>
                </Form>
              ),
            },
          ]}
        />
      </Drawer>

      {/* Run Agent Drawer */}
      <Drawer
        title={<span style={{ fontWeight: 600, fontSize: 16, color: "var(--c-text)" }}>运行智能体</span>}
        open={runOpen}
        onClose={() => setRunOpen(false)}
        width={560}
      >
        <Form form={runForm} layout="vertical" onFinish={handleRun}>
          <Form.Item name="input" label="输入" rules={[{ required: true, message: "请输入任务描述" }]}>
            <TextArea rows={4} placeholder="描述你想让智能体执行的任务..." />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={runLoading} block icon={<PlayCircleOutlined />}>
              运行
            </Button>
          </Form.Item>
        </Form>
        {runResult && (
          <div style={{ marginTop: 24 }}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, color: "var(--c-text)" }}>执行结果</div>
            <div
              style={{
                padding: 16,
                borderRadius: 8,
                background: "var(--c-card)",
                border: "1px solid var(--c-border)",
                color: "var(--c-text)",
                fontSize: 13,
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {runResult}
            </div>
          </div>
        )}
      </Drawer>
    </PageShell>
  );
}
