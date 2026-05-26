import { useState, useEffect } from "react";
import { Card, List, Button, Empty, Drawer, Tooltip, Form, Input, Select, message, Modal, Switch, Tag } from "antd";
import {
  GlobalOutlined,
  LinkOutlined,
  DisconnectOutlined,
  MessageOutlined,
  ReloadOutlined,
  PlusOutlined,
  ExclamationCircleOutlined,
  SafetyOutlined,
} from "@ant-design/icons";
import { PageShell } from "../components/common/PageShell";
import { useChannelStore } from "../stores/channelStore";
import { StatusBadge } from "../components/common/StatusBadge";
import ChannelPolicyDrawer from "../components/channels/ChannelPolicyDrawer";

function formatChannelTime(ts: string | undefined): string {
  if (!ts) return "—";
  try {
    const d = new Date(ts);
    return d.toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return String(ts);
  }
}

function formatMessageContent(m: any): string {
  if (typeof m.content === "string") return m.content;
  if (typeof m.text === "string") return m.text;
  if (m.message && typeof m.message === "string") return m.message;
  try {
    return JSON.stringify(m, null, 2).slice(0, 500);
  } catch {
    return String(m);
  }
}

const channelTypes = [
  { value: "telegram", label: "Telegram" },
  { value: "discord", label: "Discord" },
  { value: "web", label: "Web" },
  { value: "slack", label: "Slack" },
  { value: "matrix", label: "Matrix" },
  { value: "signal", label: "Signal" },
  { value: "imessage", label: "iMessage" },
  { value: "email", label: "Email" },
  { value: "sms", label: "SMS" },
  { value: "push", label: "Push" },
];

export default function ChannelsPage() {
  const {
    channels,
    loading,
    fetchChannels,
    disconnectChannel,
    toggleChannel,
    connectChannel,
    fetchMessages,
    messages,
    deleteChannel,
    setAutoReply,
  } = useChannelStore();

  const [msgDrawerOpen, setMsgDrawerOpen] = useState(false);
  const [msgChannelId, setMsgChannelId] = useState<string>("");
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectForm] = Form.useForm();
  const [connectLoading, setConnectLoading] = useState(false);
  // v2.33: per-channel policy editor
  const [policyDrawerOpen, setPolicyDrawerOpen] = useState(false);
  const [policyChannelId, setPolicyChannelId] = useState<string | null>(null);

  useEffect(() => {
    fetchChannels();
  }, [fetchChannels]);

  const openMessages = async (id: string) => {
    setMsgChannelId(id);
    await fetchMessages(id);
    setMsgDrawerOpen(true);
  };

  const handleConnect = async (values: { name: string; type: string; token: string }) => {
    setConnectLoading(true);
    try {
      await connectChannel(values.name, { type: values.type, token: values.token });
      message.success("通道连接成功");
      setConnectOpen(false);
      connectForm.resetFields();
      await fetchChannels();
    } catch (err: any) {
      message.error(err?.message || "连接失败");
    } finally {
      setConnectLoading(false);
    }
  };

  return (
    <PageShell title="通道" subtitle="多平台消息通道管理" icon={<GlobalOutlined />}>
      <div style={{ marginBottom: 32, display: "flex", gap: 12 }}>
        <Tooltip title="刷新通道列表">
          <Button icon={<ReloadOutlined />} onClick={fetchChannels} style={{ height: 40 }}>
            刷新
          </Button>
        </Tooltip>
        <Button type="primary" icon={<PlusOutlined />} style={{ height: 40 }} onClick={() => setConnectOpen(true)}>
          连接新通道
        </Button>
      </div>

      {loading && channels.length === 0 ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 24 }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              style={{
                padding: 32,
                borderRadius: 12,
                border: "1px solid var(--c-border)",
                background: "var(--c-card)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
                <div style={{ width: 80, height: 16, background: "var(--c-hover)", borderRadius: 4 }} />
                <div style={{ width: 40, height: 16, background: "var(--c-hover)", borderRadius: 4 }} />
              </div>
              <div style={{ width: "60%", height: 14, background: "var(--c-hover)", borderRadius: 4 }} />
            </div>
          ))}
        </div>
      ) : channels.length === 0 ? (
        <Empty
          description={<span style={{ color: "var(--c-text-3)", fontSize: 14, fontWeight: 300 }}>暂无通道</span>}
        />
      ) : (
        <List
          grid={{ gutter: 24, xs: 1, sm: 1, md: 2, lg: 3 }}
          dataSource={channels}
          renderItem={(ch) => (
            <List.Item>
              <Card
                style={{ borderRadius: 12, border: "1px solid var(--c-border)", boxShadow: "var(--shadow)" }}
                styles={{
                  body: { padding: 32 },
                  header: { padding: "20px 24px", borderBottom: "1px solid var(--c-border)" },
                }}
                title={
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <StatusBadge status={ch.connected ? "connected" : "disconnected"} />
                    <span style={{ fontWeight: 600, fontSize: 15, color: "var(--c-text)" }}>{ch.name}</span>
                  </div>
                }
                actions={[
                  ch.connected ? (
                    <Button
                      key="toggle"
                      type="text"
                      size="small"
                      icon={<DisconnectOutlined />}
                      onClick={() => disconnectChannel(ch.id)}
                      style={{ color: "var(--c-text-3)" }}
                    >
                      断开
                    </Button>
                  ) : (
                    <Button
                      key="toggle"
                      type="text"
                      size="small"
                      icon={<LinkOutlined />}
                      onClick={() => toggleChannel(ch.id)}
                      style={{ color: "var(--c-accent)" }}
                    >
                      连接
                    </Button>
                  ),
                  <Button
                    key="messages"
                    type="text"
                    size="small"
                    icon={<MessageOutlined />}
                    onClick={() => openMessages(ch.id)}
                    style={{ color: "var(--c-text-2)" }}
                  >
                    消息
                  </Button>,
                  <Button
                    key="delete"
                    type="text"
                    size="small"
                    danger
                    onClick={() => {
                      Modal.confirm({
                        title: "确认删除",
                        icon: <ExclamationCircleOutlined />,
                        content: `确定要删除通道 "${ch.name}" 吗？此操作不可撤销。`,
                        okText: "删除",
                        okType: "danger",
                        cancelText: "取消",
                        onOk: () => deleteChannel(ch.id),
                      });
                    }}
                  >
                    删除
                  </Button>,
                ]}
              >
                <div style={{ fontSize: 13, color: "var(--c-text-2)", fontWeight: 300, marginBottom: 8 }}>
                  类型:{" "}
                  <span
                    style={{
                      background: "var(--c-hover)",
                      border: "1px solid var(--c-border)",
                      padding: "2px 8px",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                  >
                    {ch.type}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "var(--c-text-3)", fontWeight: 300 }}>ID: {ch.id}</div>

                {/* M5 — auto-reply toggle: when on, inbound messages are
                    routed to chat_engine and the response is sent back */}
                <div
                  style={{
                    marginTop: 12,
                    paddingTop: 12,
                    borderTop: "1px solid var(--c-border)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <Tooltip title="开启后,入站消息会经过 LLM 自动回复给原 sender(需要 channel 已连接 + 在接收)">
                    <span style={{ fontSize: 13, color: "var(--c-text-2)" }}>
                      自动回复
                      {ch.auto_reply && (
                        <Tag color="success" style={{ marginLeft: 8 }}>
                          ON
                        </Tag>
                      )}
                    </span>
                  </Tooltip>
                  <Switch size="small" checked={!!ch.auto_reply} onChange={(checked) => setAutoReply(ch.id, checked)} />
                </div>

                {/* v2.33 — open policy editor drawer (per-channel agent /
                    sender/keyword filters / time windows / rate limit /
                    reply delay; see ChannelPolicyDrawer for full surface). */}
                <div style={{ marginTop: 8, display: "flex", justifyContent: "flex-end" }}>
                  <Tooltip title="编辑接收策略 (agent / 过滤 / 时段 / 限速)">
                    <Button
                      size="small"
                      type="text"
                      icon={<SafetyOutlined />}
                      onClick={() => {
                        setPolicyChannelId(ch.id);
                        setPolicyDrawerOpen(true);
                      }}
                    >
                      策略
                    </Button>
                  </Tooltip>
                </div>
              </Card>
            </List.Item>
          )}
        />
      )}

      <ChannelPolicyDrawer
        channelId={policyChannelId}
        open={policyDrawerOpen}
        onClose={() => setPolicyDrawerOpen(false)}
      />

      <Drawer
        title={<span style={{ fontWeight: 600, fontSize: 16, color: "var(--c-text)" }}>通道消息: {msgChannelId}</span>}
        open={msgDrawerOpen}
        onClose={() => setMsgDrawerOpen(false)}
        width={480}
      >
        {messages.length === 0 ? (
          <Empty
            description={<span style={{ color: "var(--c-text-3)", fontSize: 14, fontWeight: 300 }}>暂无消息</span>}
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {messages.map((m: any, i: number) => (
              <div
                key={i}
                style={{
                  padding: 14,
                  borderRadius: 10,
                  background: "var(--c-card)",
                  border: "1px solid var(--c-border)",
                  boxShadow: "var(--shadow)",
                }}
              >
                <div style={{ fontSize: 11, color: "var(--c-text-3)", fontWeight: 300, marginBottom: 4 }}>
                  {formatChannelTime(m.timestamp || m.time)}
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: "var(--c-text)",
                    fontWeight: 400,
                    lineHeight: 1.6,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {formatMessageContent(m)}
                </div>
              </div>
            ))}
          </div>
        )}
      </Drawer>

      <Drawer
        title={<span style={{ fontWeight: 600, fontSize: 16, color: "var(--c-text)" }}>连接新通道</span>}
        open={connectOpen}
        onClose={() => setConnectOpen(false)}
        width={420}
      >
        <Form form={connectForm} layout="vertical" onFinish={handleConnect}>
          <Form.Item name="name" label="通道名称" rules={[{ required: true, message: "请输入通道名称" }]}>
            <Input placeholder="例如: 我的 Telegram 机器人" />
          </Form.Item>
          <Form.Item name="type" label="通道类型" rules={[{ required: true, message: "请选择通道类型" }]}>
            <Select placeholder="选择通道类型" options={channelTypes} />
          </Form.Item>
          <Form.Item
            name="token"
            label="认证令牌"
            rules={[{ required: true, message: "请输入认证令牌" }]}
            extra="不同通道需要的认证信息不同，通常为 API Token"
          >
            <Input.Password placeholder="输入 API Token 或认证密钥" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={connectLoading} block>
              连接
            </Button>
          </Form.Item>
        </Form>
      </Drawer>
    </PageShell>
  );
}
