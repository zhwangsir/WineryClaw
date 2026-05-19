import { useState, useEffect } from "react";
import { Button, Switch, Tag, Table, message, Modal } from "antd";
import { AppstoreOutlined, ReloadOutlined, DeleteOutlined, ExclamationCircleOutlined } from "@ant-design/icons";
import { PageShell } from "../components/common/PageShell";
import { pluginsApi, type Plugin } from "../api/plugins";
import { usePluginStore } from "../stores/pluginStore";
import { EmptyState } from "../components/common/EmptyState";

export default function PluginsPage() {
  const { deletePlugin } = usePluginStore();
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchPlugins = async () => {
    setLoading(true);
    try {
      const list = await pluginsApi.list();
      setPlugins(list);
    } catch (e: any) {
      message.error("Failed to load plugins: " + e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPlugins();
  }, []);

  const toggle = async (p: Plugin, enabled: boolean) => {
    try {
      if (enabled) {
        await pluginsApi.enable(p.id);
        message.success(`Plugin "${p.name}" enabled`);
      } else {
        await pluginsApi.disable(p.id);
        message.success(`Plugin "${p.name}" disabled`);
      }
      setPlugins((prev) => prev.map((x) => (x.id === p.id ? { ...x, enabled } : x)));
    } catch (e: any) {
      message.error(e.message);
    }
  };

  const handleUnload = async (p: Plugin) => {
    try {
      await pluginsApi.unload(p.id);
      message.success(`Plugin "${p.name}" unloaded`);
      fetchPlugins();
    } catch (e: any) {
      message.error(e.message);
    }
  };

  const columns = [
    {
      title: "Name",
      dataIndex: "name",
      key: "name",
      render: (_: string, p: Plugin) => (
        <div>
          <div style={{ fontWeight: 600 }}>{p.name}</div>
          <div style={{ fontSize: 12, color: "var(--c-text-3)" }}>{p.id}</div>
        </div>
      ),
    },
    {
      title: "Version",
      dataIndex: "version",
      key: "version",
      width: 100,
    },
    {
      title: "Status",
      key: "status",
      width: 120,
      render: (_: unknown, p: Plugin) => (
        <Switch
          
          checked={p.enabled}
          onChange={(v) => toggle(p, v)}
        />
      ),
    },
    {
      title: "Permissions",
      key: "permissions",
      render: (_: unknown, p: Plugin) => (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {(p.manifest?.permissions || []).map((perm) => (
            <Tag key={perm}>{perm}</Tag>
          ))}
        </div>
      ),
    },
    {
      title: "Actions",
      key: "actions",
      width: 120,
      render: (_: unknown, p: Plugin) => (
        <div style={{ display: "flex", gap: 8 }}>
          <Button danger onClick={() => handleUnload(p)}>
            Unload
          </Button>
          <Button
            type="text"
            danger
            icon={<DeleteOutlined />}
            onClick={() => {
              Modal.confirm({
                title: "确认删除",
                icon: <ExclamationCircleOutlined />,
                content: `确定要彻底删除插件 "${p.name}" 吗？`,
                okText: "删除",
                okType: "danger",
                cancelText: "取消",
                onOk: async () => {
                  await deletePlugin(p.id);
                  fetchPlugins();
                },
              });
            }}
          >
            删除
          </Button>
        </div>
      ),
    },
  ];

  return (
    <PageShell
      title="Plugins"
      subtitle={`${plugins.length} plugin(s) loaded`}
      icon={<AppstoreOutlined />}
    >
      <div style={{ marginBottom: 16, display: "flex", justifyContent: "flex-end" }}>
        <Button icon={<ReloadOutlined />} onClick={fetchPlugins} loading={loading}>
          Refresh
        </Button>
      </div>
      {plugins.length === 0 && !loading ? (
        <EmptyState description="No plugins loaded" />
      ) : (
        <Table
          dataSource={plugins}
          columns={columns}
          rowKey="id"
          loading={loading}
          pagination={false}
          
        />
      )}
    </PageShell>
  );
}
