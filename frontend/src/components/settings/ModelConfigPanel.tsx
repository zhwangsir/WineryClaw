import { useState, useEffect } from "react";
import { Form, Input, Button, Table, Slider, InputNumber, Modal, message, Spin, Popconfirm } from "antd";
import {
  PlusOutlined,
  BugOutlined,
  ReloadOutlined,
  SaveOutlined,
  DeleteOutlined,
  EditOutlined,
} from "@ant-design/icons";
import { useConfigStore } from "../../stores/configStore";

interface EndpointFormData {
  name: string;
  baseUrl: string;
  modelId: string;
  apiKey?: string;
  priority?: number;
  timeout?: number;
}

export default function ModelConfigPanel() {
  const { modelConfig, loading, detecting, detectResult, fetchModelConfig, saveModelConfig, detectModel, resetModel } =
    useConfigStore();

  const [form] = Form.useForm();
  const [epModalOpen, setEpModalOpen] = useState(false);
  const [editingEp, setEditingEp] = useState<EndpointFormData | null>(null);
  const [epForm] = Form.useForm();

  useEffect(() => {
    fetchModelConfig();
  }, [fetchModelConfig]);

  useEffect(() => {
    if (modelConfig) {
      form.setFieldsValue({
        baseUrl: modelConfig.baseUrl,
        modelId: modelConfig.modelId,
        apiKey: modelConfig.apiKey,
        temperature: modelConfig.temperature,
        maxTokens: modelConfig.maxTokens,
      });
    }
  }, [modelConfig, form]);

  const handleSave = async () => {
    const values = await form.validateFields();
    await saveModelConfig(values);
    message.success("模型配置已保存");
  };

  const handleDetect = async () => {
    await detectModel();
    if (detectResult?.ok) {
      message.success(detectResult.message);
    } else if (detectResult) {
      message.warning(detectResult.message);
    }
  };

  const handleReset = async () => {
    await resetModel();
    message.success("已重置为默认配置");
    fetchModelConfig();
  };

  const endpoints = modelConfig?.endpoints || [];

  const openAddEp = () => {
    setEditingEp(null);
    epForm.resetFields();
    setEpModalOpen(true);
  };

  const openEditEp = (ep: EndpointFormData) => {
    setEditingEp(ep);
    epForm.setFieldsValue(ep);
    setEpModalOpen(true);
  };

  const handleSaveEp = async () => {
    const values: EndpointFormData = await epForm.validateFields();
    const newEndpoints = editingEp
      ? endpoints.map((e) => (e.name === editingEp.name ? values : e))
      : [...endpoints, values];
    await saveModelConfig({ endpoints: newEndpoints as any });
    setEpModalOpen(false);
    message.success(editingEp ? "端点已更新" : "端点已添加");
  };

  const handleDeleteEp = async (name: string) => {
    const newEndpoints = endpoints.filter((e) => e.name !== name);
    await saveModelConfig({ endpoints: newEndpoints as any });
    message.success("端点已删除");
  };

  return (
    <Spin spinning={loading}>
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        {/* Base config */}
        <div>
          <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 16, color: "var(--c-text)" }}>基础配置</div>
          <Form form={form} layout="vertical" style={{ maxWidth: 600 }}>
            <Form.Item label="Base URL" name="baseUrl" rules={[{ required: true }]}>
              <Input placeholder="http://localhost:1234/v1" />
            </Form.Item>
            <Form.Item label="模型 ID" name="modelId" rules={[{ required: true }]}>
              <Input placeholder="gpt-4o" />
            </Form.Item>
            <Form.Item label="API Key" name="apiKey">
              <Input.Password placeholder="可选" />
            </Form.Item>
            <Form.Item label="Temperature" name="temperature">
              <Slider min={0} max={2} step={0.1} marks={{ 0: "0", 1: "1", 2: "2" }} />
            </Form.Item>
            <Form.Item label="Max Tokens" name="maxTokens">
              <InputNumber min={256} max={128000} step={256} style={{ width: "100%" }} />
            </Form.Item>
          </Form>
        </div>

        {/* Endpoints */}
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <div style={{ fontWeight: 600, fontSize: 15, color: "var(--c-text)" }}>模型端点</div>
            <Button type="primary" icon={<PlusOutlined />} size="small" onClick={openAddEp}>
              新增端点
            </Button>
          </div>
          <Table
            size="small"
            rowKey="name"
            dataSource={endpoints}
            pagination={false}
            // v2.42 — explicit scroll.x guarantees the right-most columns
            // (优先级 / 超时 / 操作) never get clipped on a narrow Card.
            // Previously the table header overflowed and the action icons
            // were cut off below ~880px effective width.
            scroll={{ x: 760 }}
            columns={[
              { title: "名称", dataIndex: "name", width: 120 },
              { title: "Base URL", dataIndex: "baseUrl", ellipsis: true },
              { title: "模型", dataIndex: "modelId", width: 180 },
              { title: "优先级", dataIndex: "priority", width: 70, align: "center" as const },
              {
                title: "超时",
                dataIndex: "timeout",
                width: 70,
                align: "center" as const,
                render: (v: number) => `${v}s`,
              },
              {
                title: "操作",
                width: 100,
                align: "center" as const,
                render: (_: any, record: EndpointFormData) => (
                  <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
                    <Button
                      type="text"
                      size="small"
                      icon={<EditOutlined />}
                      onClick={() => openEditEp(record)}
                      style={{ color: "var(--c-text-2)" }}
                    />
                    <Popconfirm title="确认删除此端点？" onConfirm={() => handleDeleteEp(record.name)}>
                      <Button type="text" size="small" icon={<DeleteOutlined />} style={{ color: "var(--c-text-3)" }} />
                    </Popconfirm>
                  </div>
                ),
              },
            ]}
          />
        </div>

        {/* Actions */}
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <Button type="primary" icon={<SaveOutlined />} onClick={handleSave}>
            保存配置
          </Button>
          <Button icon={<BugOutlined />} loading={detecting} onClick={handleDetect}>
            检测模型
          </Button>
          <Popconfirm title="确认重置为默认配置？" onConfirm={handleReset}>
            <Button icon={<ReloadOutlined />}>重置默认</Button>
          </Popconfirm>
        </div>

        {/* Detect result */}
        {detectResult && (
          <div
            style={{ padding: 20, borderRadius: 12, background: "var(--c-hover)", border: "1px solid var(--c-border)" }}
          >
            <div
              style={{
                fontWeight: 600,
                color: detectResult.ok ? "var(--c-text)" : "var(--c-text-3)",
                marginBottom: 12,
                fontSize: 14,
              }}
            >
              {detectResult.ok ? "✓ 检测通过" : "✕ 检测未通过"}: {detectResult.message}
            </div>
            {detectResult.details?.endpoints && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {detectResult.details.endpoints.map((ep: any) => (
                  <div key={ep.name} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
                    <span
                      style={{
                        background: ep.ok ? "var(--c-success)" : "var(--c-error)",
                        color: "#ffffff",
                        padding: "2px 10px",
                        borderRadius: 6,
                        fontSize: 12,
                        fontWeight: 400,
                      }}
                    >
                      {ep.ok ? "正常" : "异常"}
                    </span>
                    <span style={{ fontWeight: 600, color: "var(--c-text)" }}>{ep.name}</span>
                    <span style={{ color: "var(--c-text-2)", fontWeight: 300 }}>{ep.message}</span>
                    {ep.availableModels && (
                      <span style={{ color: "var(--c-text-3)", fontSize: 11, fontWeight: 300 }}>
                        可用: {ep.availableModels.join(", ")}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Endpoint Modal */}
      <Modal
        open={epModalOpen}
        title={
          <span style={{ fontWeight: 600, fontSize: 16, color: "var(--c-text)" }}>
            {editingEp ? "编辑端点" : "新增端点"}
          </span>
        }
        onCancel={() => setEpModalOpen(false)}
        onOk={handleSaveEp}
        okText="保存"
        destroyOnHidden
      >
        <Form form={epForm} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item label="名称" name="name" rules={[{ required: true }]}>
            <Input placeholder="例如: openai" />
          </Form.Item>
          <Form.Item label="Base URL" name="baseUrl" rules={[{ required: true }]}>
            <Input placeholder="https://api.openai.com/v1" />
          </Form.Item>
          <Form.Item label="模型 ID" name="modelId" rules={[{ required: true }]}>
            <Input placeholder="gpt-4o" />
          </Form.Item>
          <Form.Item label="API Key" name="apiKey">
            <Input.Password placeholder="可选" />
          </Form.Item>
          <Form.Item label="优先级" name="priority" initialValue={5}>
            <InputNumber min={1} max={20} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="超时 (秒)" name="timeout" initialValue={60}>
            <InputNumber min={5} max={600} style={{ width: "100%" }} />
          </Form.Item>
        </Form>
      </Modal>
    </Spin>
  );
}
