import { useState, useEffect } from "react";
import { Button, Card, Drawer, Form, Input, Select, Table, Tag, Empty, Modal } from "antd";
import { UserOutlined, PlusOutlined, DeleteOutlined, ExclamationCircleOutlined } from "@ant-design/icons";
import { PageShell } from "../components/common/PageShell";
import { useIdentityStore } from "../stores/identityStore";

const ROLE_OPTIONS = [
  { value: "admin", label: "管理员" },
  { value: "user", label: "普通用户" },
  { value: "guest", label: "访客" },
];

export default function IdentityPage() {
  const { users, loading, fetchUsers, createUser, deleteUser } = useIdentityStore();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleCreate = async (values: { name: string; role: string; workspaces: string }) => {
    await createUser({
      name: values.name,
      role: values.role,
      workspaces: values.workspaces ? values.workspaces.split(",").map((s) => s.trim()) : [],
    });
    setDrawerOpen(false);
    form.resetFields();
  };

  return (
    <PageShell
      title="身份"
      subtitle="用户与权限管理"
      icon={<UserOutlined />}
      actions={
        <Button type="primary" icon={<PlusOutlined />} style={{ height: 40 }} onClick={() => setDrawerOpen(true)}>
          新建用户
        </Button>
      }
    >
      {users.length === 0 ? (
        <Empty description="暂无用户" />
      ) : (
        <Card style={{ borderRadius: 12, border: "1px solid var(--c-border)" }} bodyStyle={{ padding: 24 }}>
          <Table
            dataSource={users}
            rowKey="id"
            loading={loading}
            pagination={{ pageSize: 10 }}
            columns={[
              { title: "ID", dataIndex: "id", render: (v: string) => <span style={{ fontSize: 12, fontFamily: "monospace" }}>{v.slice(0, 12)}...</span> },
              { title: "名称", dataIndex: "name", render: (v: string) => <span style={{ fontWeight: 500 }}>{v}</span> },
              { title: "角色", dataIndex: "role", render: (v: string) => <Tag color={v === "admin" ? "red" : v === "user" ? "blue" : "default"}>{v}</Tag> },
              { title: "工作空间", dataIndex: "workspaces", render: (v: string[]) => (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {v?.map((w) => <Tag key={w} style={{ fontSize: 11, margin: 0 }}>{w}</Tag>)}
                </div>
              )},
              { title: "创建时间", dataIndex: "createdAt", render: (v: string) => <span style={{ fontSize: 12, color: "var(--c-text-3)" }}>{new Date(v).toLocaleString("zh-CN")}</span> },
              {
                title: "操作",
                key: "action",
                render: (_: unknown, record: { id: string; name: string }) => (
                  <Button
                    type="text"
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => {
                      Modal.confirm({
                        title: "确认删除",
                        icon: <ExclamationCircleOutlined />,
                        content: `确定要删除用户 "${record.name}" 吗？`,
                        okText: "删除",
                        okType: "danger",
                        cancelText: "取消",
                        onOk: () => deleteUser(record.id),
                      });
                    }}
                  >
                    删除
                  </Button>
                ),
              },
            ]}
          />
        </Card>
      )}

      <Drawer
        title={<span style={{ fontWeight: 600, fontSize: 16, color: "var(--c-text)" }}>新建用户</span>}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={420}
      >
        <Form form={form} layout="vertical" onFinish={handleCreate}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: "请输入用户名称" }]}>
            <Input placeholder="用户名称" />
          </Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true, message: "请选择角色" }]}>
            <Select placeholder="选择角色" options={ROLE_OPTIONS} />
          </Form.Item>
          <Form.Item name="workspaces" label="工作空间">
            <Input placeholder="逗号分隔，例如: default, dev" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" block>创建</Button>
          </Form.Item>
        </Form>
      </Drawer>
    </PageShell>
  );
}
