/**
 * ChannelPolicyDrawer — v2.33 (P1 follow-up to v2.30 M5.1 Channel 高级控制).
 *
 * v2.30 shipped the backend (`channel-policy.ts` + 4 HTTP endpoints) but
 * left ChannelsPage without a UI entry point — users could only edit
 * policy via curl. This drawer fills that gap.
 *
 * Layout (single drawer, tabbed):
 *   - 配置 tab: form for agentId / sender{Allow,Block} / keyword{Allow,Block}
 *               / timeWindows[] / maxRepliesPerHour / replyDelay
 *   - 审计 tab: recent policy decisions table (allowed / blocked + reason)
 *
 * The form serializes its state back to the v2.30 ChannelPolicy shape on
 * save (PUT /api/channels/:id/policy). Tag-based multi-input UIs avoid
 * any free-text JSON editing — users can't construct an invalid policy
 * from the UI.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  message,
} from "antd";
import { ClockCircleOutlined, DeleteOutlined, PlusOutlined, ReloadOutlined, SaveOutlined } from "@ant-design/icons";
import { channelsApi } from "../../api/channels";
import type { ChannelPolicy, PolicyAuditEntry } from "../../api/channels";

/** Plain "HH:MM" validator — keeps us off any date library. */
function isValidHHMM(s: string): boolean {
  return /^([0-1]?\d|2[0-3]):[0-5]\d$/.test(s.trim());
}

interface Props {
  channelId: string | null;
  open: boolean;
  onClose: () => void;
}

interface FormState {
  agentId: string;
  senderAllow: string[];
  senderBlock: string[];
  keywordAllow: string[];
  keywordBlock: string[];
  timeWindows: Array<{ start: string; end: string }>;
  maxRepliesPerHour: number;
  replyDelayMin: number;
  replyDelayMax: number;
}

const emptyForm: FormState = {
  agentId: "",
  senderAllow: [],
  senderBlock: [],
  keywordAllow: [],
  keywordBlock: [],
  timeWindows: [],
  maxRepliesPerHour: 0,
  replyDelayMin: 0,
  replyDelayMax: 0,
};

function policyToForm(p: ChannelPolicy | null | undefined): FormState {
  if (!p) return { ...emptyForm };
  return {
    agentId: p.agentId ?? "",
    senderAllow: p.senderAllow ?? [],
    senderBlock: p.senderBlock ?? [],
    keywordAllow: p.keywordAllow ?? [],
    keywordBlock: p.keywordBlock ?? [],
    timeWindows: (p.timeWindows ?? []).map((w) => ({ start: w.start, end: w.end })),
    maxRepliesPerHour: p.maxRepliesPerHour ?? 0,
    replyDelayMin: p.replyDelay?.minMs ?? 0,
    replyDelayMax: p.replyDelay?.maxMs ?? 0,
  };
}

function formToPolicy(f: FormState): ChannelPolicy {
  const out: ChannelPolicy = {};
  if (f.agentId.trim()) out.agentId = f.agentId.trim();
  if (f.senderAllow.length) out.senderAllow = f.senderAllow;
  if (f.senderBlock.length) out.senderBlock = f.senderBlock;
  if (f.keywordAllow.length) out.keywordAllow = f.keywordAllow;
  if (f.keywordBlock.length) out.keywordBlock = f.keywordBlock;
  if (f.timeWindows.length) out.timeWindows = f.timeWindows;
  if (f.maxRepliesPerHour > 0) out.maxRepliesPerHour = f.maxRepliesPerHour;
  if (f.replyDelayMax > 0) {
    out.replyDelay = {
      minMs: f.replyDelayMin,
      maxMs: f.replyDelayMax,
    };
  }
  return out;
}

export default function ChannelPolicyDrawer({ channelId, open, onClose }: Props) {
  const [form, setForm] = useState<FormState>(emptyForm);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [audit, setAudit] = useState<PolicyAuditEntry[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [tab, setTab] = useState<"config" | "audit">("config");

  const refresh = useCallback(async () => {
    if (!channelId) return;
    setLoading(true);
    try {
      const res = await channelsApi.getPolicy(channelId);
      setForm(policyToForm(res.policy));
    } catch (e) {
      message.error(`无法加载策略: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [channelId]);

  const loadAudit = useCallback(async () => {
    if (!channelId) return;
    setAuditLoading(true);
    try {
      const res = await channelsApi.policyAudit(channelId, 50);
      setAudit(res.entries);
    } catch (e) {
      message.error(`无法加载审计: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAuditLoading(false);
    }
  }, [channelId]);

  useEffect(() => {
    if (open && channelId) {
      void refresh();
      void loadAudit();
    }
  }, [open, channelId, refresh, loadAudit]);

  const save = useCallback(async () => {
    if (!channelId) return;
    if (form.replyDelayMin > form.replyDelayMax) {
      message.error("replyDelay 最小值不能超过最大值");
      return;
    }
    setSaving(true);
    try {
      const policy = formToPolicy(form);
      const res = await channelsApi.setPolicy(channelId, policy);
      if (res.ok) {
        message.success("策略已保存");
        await refresh();
      } else {
        message.error(`保存失败: ${res.error || "unknown"}`);
      }
    } catch (e) {
      message.error(`保存异常: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }, [channelId, form, refresh]);

  const clearAll = useCallback(async () => {
    if (!channelId) return;
    try {
      await channelsApi.clearPolicy(channelId);
      message.success("策略已清除,恢复默认 allow-all");
      setForm(emptyForm);
    } catch (e) {
      message.error(`清除异常: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [channelId]);

  const auditStats = useMemo(() => {
    const total = audit.length;
    const blocked = audit.filter((e) => !e.allowed).length;
    return { total, blocked, allowed: total - blocked };
  }, [audit]);

  return (
    <Drawer
      title={
        <Space>
          <span>渠道策略</span>
          {channelId && <Tag>{channelId}</Tag>}
        </Space>
      }
      open={open}
      onClose={onClose}
      width={640}
      extra={
        <Space>
          <Tooltip title="重新加载">
            <Button icon={<ReloadOutlined />} onClick={refresh} loading={loading} />
          </Tooltip>
        </Space>
      }
    >
      <Alert
        showIcon
        type="info"
        style={{ marginBottom: 16 }}
        message="策略在 chat_engine 之前生效"
        description="不符合策略的入站消息会被静默丢弃,不会消耗 LLM 余额,但仍会持久化到 messages 表中(审计追溯)。空策略 = 全部放行。"
      />

      <Tabs activeKey={tab} onChange={(k) => setTab(k as "config" | "audit")}>
        <Tabs.TabPane tab="配置" key="config">
          <Form layout="vertical" disabled={loading || saving}>
            <Form.Item label="代理 ID (agentId)" help="为空则使用默认代理">
              <Input
                placeholder="agent-xxx"
                value={form.agentId}
                onChange={(e) => setForm({ ...form, agentId: e.target.value })}
              />
            </Form.Item>

            <Form.Item label="发件人白名单 (senderAllow)" help="非空时仅这些发件人会触发回复(子串,不区分大小写)">
              <Select
                mode="tags"
                value={form.senderAllow}
                onChange={(v) => setForm({ ...form, senderAllow: v })}
                placeholder="@alice 或 example.com"
                tokenSeparators={[","]}
              />
            </Form.Item>

            <Form.Item label="发件人黑名单 (senderBlock)" help="任意命中即阻断">
              <Select
                mode="tags"
                value={form.senderBlock}
                onChange={(v) => setForm({ ...form, senderBlock: v })}
                placeholder="spam@x.com"
                tokenSeparators={[","]}
              />
            </Form.Item>

            <Form.Item label="关键词白名单 (keywordAllow)" help="非空时消息必须含至少一个">
              <Select
                mode="tags"
                value={form.keywordAllow}
                onChange={(v) => setForm({ ...form, keywordAllow: v })}
                placeholder="urgent, help, 紧急"
                tokenSeparators={[","]}
              />
            </Form.Item>

            <Form.Item label="关键词黑名单 (keywordBlock)" help="命中任一即阻断">
              <Select
                mode="tags"
                value={form.keywordBlock}
                onChange={(v) => setForm({ ...form, keywordBlock: v })}
                placeholder="广告, spam, off-topic"
                tokenSeparators={[","]}
              />
            </Form.Item>

            <Form.Item
              label={
                <Space>
                  <ClockCircleOutlined />
                  时间窗口 (timeWindows)
                </Space>
              }
              help="本地时区,跨夜请写如 22:00 → 06:00 - 空则 24/7"
            >
              <Space direction="vertical" style={{ width: "100%" }}>
                {form.timeWindows.map((w, idx) => {
                  const startBad = !isValidHHMM(w.start);
                  const endBad = !isValidHHMM(w.end);
                  return (
                    <Space key={idx}>
                      <Input
                        placeholder="HH:MM"
                        value={w.start}
                        status={startBad ? "error" : undefined}
                        style={{ width: 100 }}
                        onChange={(e) => {
                          const tws = [...form.timeWindows];
                          tws[idx] = { ...tws[idx], start: e.target.value };
                          setForm({ ...form, timeWindows: tws });
                        }}
                      />
                      <span>→</span>
                      <Input
                        placeholder="HH:MM"
                        value={w.end}
                        status={endBad ? "error" : undefined}
                        style={{ width: 100 }}
                        onChange={(e) => {
                          const tws = [...form.timeWindows];
                          tws[idx] = { ...tws[idx], end: e.target.value };
                          setForm({ ...form, timeWindows: tws });
                        }}
                      />
                      <Button
                        icon={<DeleteOutlined />}
                        danger
                        type="text"
                        onClick={() => {
                          const tws = form.timeWindows.filter((_, i) => i !== idx);
                          setForm({ ...form, timeWindows: tws });
                        }}
                      />
                    </Space>
                  );
                })}
                <Button
                  icon={<PlusOutlined />}
                  onClick={() =>
                    setForm({
                      ...form,
                      timeWindows: [...form.timeWindows, { start: "09:00", end: "18:00" }],
                    })
                  }
                >
                  添加时间窗
                </Button>
              </Space>
            </Form.Item>

            <Form.Item label="每小时最多回复 (maxRepliesPerHour)" help="0 = 不限速">
              <InputNumber
                min={0}
                max={10000}
                value={form.maxRepliesPerHour}
                onChange={(v) => setForm({ ...form, maxRepliesPerHour: v ?? 0 })}
                style={{ width: 200 }}
              />
            </Form.Item>

            <Form.Item label="回复延迟模拟 (replyDelay ms)" help="模拟人类节奏,0 = 立即">
              <Space>
                <InputNumber
                  min={0}
                  value={form.replyDelayMin}
                  onChange={(v) => setForm({ ...form, replyDelayMin: v ?? 0 })}
                  addonBefore="最小"
                  addonAfter="ms"
                  style={{ width: 200 }}
                />
                <InputNumber
                  min={0}
                  value={form.replyDelayMax}
                  onChange={(v) => setForm({ ...form, replyDelayMax: v ?? 0 })}
                  addonBefore="最大"
                  addonAfter="ms"
                  style={{ width: 200 }}
                />
              </Space>
            </Form.Item>

            <Space style={{ marginTop: 8 }}>
              <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={save}>
                保存
              </Button>
              <Popconfirm
                title="清除策略?"
                description="恢复为默认 allow-all"
                onConfirm={clearAll}
                okText="清除"
                cancelText="取消"
              >
                <Button danger icon={<DeleteOutlined />}>
                  清除策略
                </Button>
              </Popconfirm>
            </Space>
          </Form>
        </Tabs.TabPane>

        <Tabs.TabPane
          tab={
            <Space>
              审计
              {auditStats.total > 0 && (
                <Tag color={auditStats.blocked > 0 ? "warning" : "default"}>
                  阻断 {auditStats.blocked} / {auditStats.total}
                </Tag>
              )}
            </Space>
          }
          key="audit"
        >
          {audit.length === 0 ? (
            <Empty description={auditLoading ? "加载中..." : "暂无策略决策记录"} />
          ) : (
            <Table<PolicyAuditEntry>
              dataSource={audit}
              rowKey={(r) => `${r.ts}-${r.sender}`}
              size="small"
              loading={auditLoading}
              pagination={{ pageSize: 10 }}
              columns={[
                {
                  title: "时间",
                  dataIndex: "ts",
                  width: 130,
                  render: (v: string) => (
                    <span style={{ fontSize: 11, color: "var(--c-text-3)" }}>
                      {new Date(v).toLocaleString("zh-CN", { hour12: false })}
                    </span>
                  ),
                },
                {
                  title: "发件人",
                  dataIndex: "sender",
                  width: 120,
                  render: (v: string) => <code style={{ fontSize: 11 }}>{v}</code>,
                },
                {
                  title: "判定",
                  dataIndex: "allowed",
                  width: 70,
                  render: (v: boolean) => (v ? <Tag color="success">放行</Tag> : <Tag color="error">阻断</Tag>),
                },
                {
                  title: "原因 / 内容",
                  render: (_: unknown, r) => (
                    <Tooltip
                      title={
                        <>
                          <div>原因: {r.reason}</div>
                          <div>内容: {r.contentPreview}</div>
                          {r.delayMs > 0 && <div>延迟: {r.delayMs}ms</div>}
                        </>
                      }
                    >
                      <span
                        style={{
                          fontSize: 12,
                          color: r.allowed ? "var(--c-text-2)" : "#b91c1c",
                          maxWidth: 360,
                          display: "inline-block",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          verticalAlign: "bottom",
                        }}
                      >
                        {r.reason}
                      </span>
                    </Tooltip>
                  ),
                },
              ]}
            />
          )}
        </Tabs.TabPane>
      </Tabs>
    </Drawer>
  );
}
