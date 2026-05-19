import { useState, useEffect } from "react";
import { Button, Card, Drawer, Form, Input, Select, Table, Tag, Empty, Popconfirm } from "antd";
import { CheckCircleOutlined, PlusOutlined, CheckOutlined, CloseOutlined } from "@ant-design/icons";
import { PageShell } from "../components/common/PageShell";
import { useProposalStore } from "../stores/proposalStore";

const statusColors: Record<string, string> = {
  open: "var(--c-accent)",
  closed: "var(--c-success)",
  expired: "var(--c-text-3)",
};

export default function ProposalsPage() {
  const { proposals, loading, fetchProposals, createProposal, vote, close } = useProposalStore();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [voteDrawerOpen, setVoteDrawerOpen] = useState(false);
  const [voteProposalId, setVoteProposalId] = useState("");
  const [form] = Form.useForm();
  const [voteForm] = Form.useForm();

  useEffect(() => {
    fetchProposals();
  }, [fetchProposals]);

  const handleCreate = async (values: { proposerId: string; topic: string; description: string; quorum: number }) => {
    await createProposal({
      proposerId: values.proposerId,
      topic: values.topic,
      description: values.description,
      quorum: values.quorum || 1,
    });
    setDrawerOpen(false);
    form.resetFields();
  };

  const openVote = (id: string) => {
    setVoteProposalId(id);
    setVoteDrawerOpen(true);
    voteForm.resetFields();
  };

  const handleVote = async (values: { agentId: string; vote: string; reason: string }) => {
    await vote(voteProposalId, values.agentId, values.vote === "yes", values.reason);
    setVoteDrawerOpen(false);
  };

  return (
    <PageShell
      title="提案"
      subtitle="多智能体共识提案与投票"
      icon={<CheckCircleOutlined />}
      actions={
        <Button type="primary" icon={<PlusOutlined />} style={{ height: 40 }} onClick={() => setDrawerOpen(true)}>
          新建提案
        </Button>
      }
    >
      {proposals.length === 0 ? (
        <Empty description="暂无提案" />
      ) : (
        <Card style={{ borderRadius: 12, border: "1px solid var(--c-border)" }} bodyStyle={{ padding: 24 }}>
          <Table
            dataSource={proposals}
            rowKey="id"
            loading={loading}
            pagination={{ pageSize: 10 }}
            columns={[
              { title: "主题", dataIndex: "topic", render: (v: string) => <span style={{ fontWeight: 500 }}>{v}</span> },
              { title: "提案人", dataIndex: "proposerId", render: (v: string) => <span style={{ fontSize: 12, color: "var(--c-text-3)" }}>{v}</span> },
              { title: "状态", dataIndex: "status", render: (v: string) => (
                <Tag style={{ color: statusColors[v] || "var(--c-text-3)", border: "none", background: "var(--c-hover)", fontSize: 12 }}>{v}</Tag>
              )},
              { title: "票数", render: (_: unknown, r: { votes?: unknown[]; quorum?: number }) => (
                <span style={{ fontSize: 12 }}>{(r.votes?.length || 0)} / {r.quorum || 1}</span>
              )},
              {
                title: "操作",
                key: "action",
                render: (_: unknown, record: any) => (
                  <div style={{ display: "flex", gap: 8 }}>
                    {record.status === "open" && (
                      <>
                        <Button size="small" icon={<CheckOutlined />} onClick={() => openVote(record.id)}>投票</Button>
                        <Popconfirm title="确认关闭" onConfirm={() => close(record.id)} okText="关闭" cancelText="取消">
                          <Button size="small" danger icon={<CloseOutlined />}>关闭</Button>
                        </Popconfirm>
                      </>
                    )}
                  </div>
                ),
              },
            ]}
          />
        </Card>
      )}

      <Drawer
        title={<span style={{ fontWeight: 600, fontSize: 16, color: "var(--c-text)" }}>新建提案</span>}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={480}
      >
        <Form form={form} layout="vertical" onFinish={handleCreate}>
          <Form.Item name="proposerId" label="提案人 ID" rules={[{ required: true }]}>
            <Input placeholder="Agent ID" />
          </Form.Item>
          <Form.Item name="topic" label="主题" rules={[{ required: true, message: "请输入主题" }]}>
            <Input placeholder="提案主题" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={3} placeholder="提案描述..." />
          </Form.Item>
          <Form.Item name="quorum" label="最低票数" initialValue={1}>
            <Input type="number" min={1} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" block>创建</Button>
          </Form.Item>
        </Form>
      </Drawer>

      <Drawer
        title={<span style={{ fontWeight: 600, fontSize: 16, color: "var(--c-text)" }}>投票</span>}
        open={voteDrawerOpen}
        onClose={() => setVoteDrawerOpen(false)}
        width={420}
      >
        <Form form={voteForm} layout="vertical" onFinish={handleVote}>
          <Form.Item name="agentId" label="投票人 ID" rules={[{ required: true }]}>
            <Input placeholder="Agent ID" />
          </Form.Item>
          <Form.Item name="vote" label="意见" rules={[{ required: true }]}>
            <Select options={[{ value: "yes", label: "同意" }, { value: "no", label: "反对" }]} />
          </Form.Item>
          <Form.Item name="reason" label="理由">
            <Input.TextArea rows={2} placeholder="投票理由..." />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" block>提交</Button>
          </Form.Item>
        </Form>
      </Drawer>
    </PageShell>
  );
}
