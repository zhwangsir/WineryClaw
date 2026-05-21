import { useState, useEffect } from "react";
import {
  Button,
  Card,
  Input,
  Tag,
  Empty,
  Table,
  Tabs,
  Progress,
  Modal,
  Form,
  Switch,
  InputNumber,
  Popconfirm,
  Tooltip,
  Space,
} from "antd";
import {
  AppstoreAddOutlined,
  DownloadOutlined,
  DeleteOutlined,
  ReloadOutlined,
  PlusOutlined,
  ThunderboltOutlined,
  CheckOutlined,
  FileTextOutlined,
} from "@ant-design/icons";
import { PageShell } from "../components/common/PageShell";
import { useSkillhubStore } from "../stores/skillhubStore";
import type { Skill, SkillRegistry, ImprovementCandidate, SkillhubItem } from "../api/skillhub";

type TabKey = "marketplace" | "installed" | "improvements" | "drafts";

export default function SkillhubPage() {
  const {
    // marketplace
    skills,
    loading,
    fetchSkills,
    search,
    install,
    refresh,
    // installed
    installed,
    installedLoading,
    fetchInstalled,
    uninstall,
    // registries
    registries,
    registriesLoading,
    fetchRegistries,
    addRegistry,
    removeRegistry,
    // candidates
    candidates,
    candidatesLoading,
    fetchCandidates,
    improve,
    // drafts
    drafts,
    draftsLoading,
    fetchDrafts,
    promoteDraft,
  } = useSkillhubStore();

  const [activeTab, setActiveTab] = useState<TabKey>("marketplace");
  const [q, setQ] = useState("");
  const [registryModalOpen, setRegistryModalOpen] = useState(false);
  const [improveModalState, setImproveModalState] = useState<{
    open: boolean;
    candidate?: ImprovementCandidate;
    code: string;
    reason: string;
  }>({ open: false, code: "", reason: "" });
  const [draftPreview, setDraftPreview] = useState<Skill | null>(null);

  // Eager-load the data for each tab when first switched to.
  useEffect(() => {
    if (activeTab === "marketplace") {
      fetchSkills();
      fetchRegistries();
    } else if (activeTab === "installed") {
      fetchInstalled();
    } else if (activeTab === "improvements") {
      fetchCandidates();
    } else if (activeTab === "drafts") {
      fetchDrafts();
    }
  }, [activeTab, fetchSkills, fetchRegistries, fetchInstalled, fetchCandidates, fetchDrafts]);

  const handleSearch = () => {
    if (q.trim()) search(q);
    else fetchSkills();
  };

  return (
    <PageShell title="技能市场" subtitle="Skillhub · 安装 · 自我改进 · 草稿审核" icon={<AppstoreAddOutlined />}>
      <Tabs
        activeKey={activeTab}
        onChange={(k) => setActiveTab(k as TabKey)}
        items={[
          {
            key: "marketplace",
            label: (
              <span>
                <AppstoreAddOutlined /> 市场
              </span>
            ),
            children: (
              <MarketplaceTab
                skills={skills}
                loading={loading}
                q={q}
                onQChange={setQ}
                onSearch={handleSearch}
                onInstall={install}
                onRefreshAll={() => refresh()}
                registries={registries}
                registriesLoading={registriesLoading}
                onAddRegistryClick={() => setRegistryModalOpen(true)}
                onRemoveRegistry={removeRegistry}
              />
            ),
          },
          {
            key: "installed",
            label: (
              <span>
                <CheckOutlined /> 已安装 <Tag style={{ marginLeft: 4 }}>{installed.length}</Tag>
              </span>
            ),
            children: (
              <InstalledTab
                installed={installed}
                loading={installedLoading}
                onUninstall={uninstall}
                onReload={fetchInstalled}
              />
            ),
          },
          {
            key: "improvements",
            label: (
              <span>
                <ThunderboltOutlined /> 改进{" "}
                <Tag style={{ marginLeft: 4 }} color={candidates.length > 0 ? "orange" : undefined}>
                  {candidates.length}
                </Tag>
              </span>
            ),
            children: (
              <ImprovementsTab
                candidates={candidates}
                loading={candidatesLoading}
                onReload={fetchCandidates}
                onImproveClick={(c) =>
                  setImproveModalState({
                    open: true,
                    candidate: c,
                    code: c.skill.code,
                    reason: "manual: " + c.primaryFailureMode.signature,
                  })
                }
              />
            ),
          },
          {
            key: "drafts",
            label: (
              <span>
                <FileTextOutlined /> 草稿{" "}
                <Tag style={{ marginLeft: 4 }} color={drafts.length > 0 ? "blue" : undefined}>
                  {drafts.length}
                </Tag>
              </span>
            ),
            children: (
              <DraftsTab
                drafts={drafts}
                loading={draftsLoading}
                onReload={fetchDrafts}
                onPreview={setDraftPreview}
                onPromote={promoteDraft}
              />
            ),
          },
        ]}
      />

      <AddRegistryModal
        open={registryModalOpen}
        onClose={() => setRegistryModalOpen(false)}
        onSubmit={async (reg) => {
          const ok = await addRegistry(reg);
          if (ok) setRegistryModalOpen(false);
        }}
      />

      <ImproveModal
        state={improveModalState}
        onClose={() => setImproveModalState({ open: false, code: "", reason: "" })}
        onChange={(patch) => setImproveModalState((s) => ({ ...s, ...patch }))}
        onSubmit={async () => {
          if (!improveModalState.candidate) return;
          const ok = await improve(
            improveModalState.candidate.skill.id,
            improveModalState.code,
            improveModalState.reason
          );
          if (ok) setImproveModalState({ open: false, code: "", reason: "" });
        }}
      />

      <DraftPreviewModal draft={draftPreview} onClose={() => setDraftPreview(null)} />
    </PageShell>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Marketplace tab — search + install + registries panel
// ─────────────────────────────────────────────────────────────────────────────

interface MarketplaceTabProps {
  skills: SkillhubItem[];
  loading: boolean;
  q: string;
  onQChange: (v: string) => void;
  onSearch: () => void;
  onInstall: (slug: string) => void;
  onRefreshAll: () => void;
  registries: SkillRegistry[];
  registriesLoading: boolean;
  onAddRegistryClick: () => void;
  onRemoveRegistry: (name: string) => void;
}

function MarketplaceTab({
  skills,
  loading,
  q,
  onQChange,
  onSearch,
  onInstall,
  onRefreshAll,
  registries,
  registriesLoading,
  onAddRegistryClick,
  onRemoveRegistry,
}: MarketplaceTabProps) {
  return (
    <>
      <Space style={{ marginBottom: 16, width: "100%", justifyContent: "space-between" }}>
        <Space>
          <Input.Search
            placeholder="搜索技能..."
            value={q}
            onChange={(e) => onQChange(e.target.value)}
            onSearch={onSearch}
            style={{ width: 360 }}
            allowClear
          />
          <Tooltip title="刷新所有 registry">
            <Button icon={<ReloadOutlined />} onClick={onRefreshAll} loading={loading} />
          </Tooltip>
        </Space>
      </Space>

      <RegistryPanel
        registries={registries}
        loading={registriesLoading}
        onAddClick={onAddRegistryClick}
        onRemove={onRemoveRegistry}
      />

      {skills.length === 0 && !loading ? (
        <Empty description="无技能 — 添加一个 registry 后刷新试试" />
      ) : (
        <Card style={{ borderRadius: 12, marginTop: 16 }} styles={{ body: { padding: 24 } }}>
          <Table
            dataSource={skills}
            rowKey="slug"
            loading={loading}
            pagination={{ pageSize: 10 }}
            columns={[
              { title: "名称", dataIndex: "name", render: (v: string) => <span style={{ fontWeight: 500 }}>{v}</span> },
              {
                title: "Slug",
                dataIndex: "slug",
                render: (v: string) => (
                  <span style={{ fontSize: 12, fontFamily: "monospace", color: "var(--c-text-3)" }}>{v}</span>
                ),
              },
              {
                title: "描述",
                dataIndex: "description",
                render: (v: string) => <span style={{ fontSize: 12, color: "var(--c-text-2)" }}>{v || "—"}</span>,
              },
              {
                title: "版本",
                dataIndex: "version",
                render: (v: string) => <Tag style={{ fontSize: 11 }}>{v || "—"}</Tag>,
              },
              {
                title: "来源",
                dataIndex: "author",
                render: (v: string) => <span style={{ fontSize: 12, color: "var(--c-text-3)" }}>{v || "—"}</span>,
              },
              {
                title: "操作",
                key: "action",
                render: (_: unknown, record: { slug: string; installed?: boolean }) => (
                  <Button
                    size="small"
                    type={record.installed ? "default" : "primary"}
                    icon={<DownloadOutlined />}
                    disabled={record.installed}
                    onClick={() => onInstall(record.slug)}
                    data-testid={record.installed ? `skill-installed-${record.slug}` : `skill-install-${record.slug}`}
                  >
                    {record.installed ? "已安装" : "安装"}
                  </Button>
                ),
              },
            ]}
          />
        </Card>
      )}
    </>
  );
}

function RegistryPanel({
  registries,
  loading,
  onAddClick,
  onRemove,
}: {
  registries: SkillRegistry[];
  loading: boolean;
  onAddClick: () => void;
  onRemove: (name: string) => void;
}) {
  return (
    <Card
      size="small"
      style={{ borderRadius: 12, marginBottom: 12 }}
      title={
        <Space>
          <span>Registries</span>
          <Tag>{registries.length}</Tag>
        </Space>
      }
      extra={
        <Button size="small" icon={<PlusOutlined />} onClick={onAddClick}>
          添加
        </Button>
      }
      loading={loading}
    >
      {registries.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未配置任何 registry" />
      ) : (
        <Space wrap>
          {registries.map((r) => (
            <Popconfirm
              key={r.name}
              title={`移除 registry "${r.name}"?`}
              onConfirm={() => onRemove(r.name)}
              okText="移除"
              cancelText="取消"
            >
              <Tag
                closable
                color={r.enabled ? "blue" : undefined}
                onClose={(e) => e.preventDefault()}
                style={{ cursor: "pointer", padding: "4px 8px", fontSize: 12 }}
              >
                {r.name} <span style={{ opacity: 0.6, marginLeft: 4 }}>{r.url}</span>
              </Tag>
            </Popconfirm>
          ))}
        </Space>
      )}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Installed tab
// ─────────────────────────────────────────────────────────────────────────────

function InstalledTab({
  installed,
  loading,
  onUninstall,
  onReload,
}: {
  installed: Skill[];
  loading: boolean;
  onUninstall: (slug: string) => void;
  onReload: () => void;
}) {
  return (
    <>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ReloadOutlined />} onClick={onReload}>
          刷新
        </Button>
      </Space>

      {installed.length === 0 && !loading ? (
        <Empty description="没有从 hub 安装的技能" />
      ) : (
        <Card style={{ borderRadius: 12 }} styles={{ body: { padding: 24 } }}>
          <Table
            dataSource={installed}
            rowKey="id"
            loading={loading}
            pagination={{ pageSize: 10 }}
            columns={[
              { title: "名称", dataIndex: "name", render: (v: string) => <span style={{ fontWeight: 500 }}>{v}</span> },
              {
                title: "ID",
                dataIndex: "id",
                render: (v: string) => (
                  <span style={{ fontSize: 12, fontFamily: "monospace", color: "var(--c-text-3)" }}>{v}</span>
                ),
              },
              { title: "版本", dataIndex: "version", render: (v: number) => <Tag>v{v}</Tag> },
              {
                title: "来源 registry",
                dataIndex: "hubRegistry",
                render: (v: string) => <span style={{ fontSize: 12 }}>{v || "—"}</span>,
              },
              {
                title: "使用次数",
                dataIndex: "usageCount",
                render: (v: number) => (v ?? 0).toString(),
              },
              {
                title: "成功率",
                dataIndex: "successRate",
                render: (v: number) => (
                  <Progress percent={Math.round((v ?? 0) * 100)} size="small" style={{ width: 100 }} />
                ),
              },
              {
                title: "操作",
                key: "action",
                render: (_: unknown, record: Skill) => (
                  <Popconfirm
                    title={`卸载 "${record.name}"?`}
                    onConfirm={() => onUninstall(record.id)}
                    okText="卸载"
                    cancelText="取消"
                  >
                    <Button size="small" danger icon={<DeleteOutlined />}>
                      卸载
                    </Button>
                  </Popconfirm>
                ),
              },
            ]}
          />
        </Card>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Improvements tab — candidates from self-improvement loop
// ─────────────────────────────────────────────────────────────────────────────

function ImprovementsTab({
  candidates,
  loading,
  onReload,
  onImproveClick,
}: {
  candidates: ImprovementCandidate[];
  loading: boolean;
  onReload: () => void;
  onImproveClick: (c: ImprovementCandidate) => void;
}) {
  return (
    <>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ReloadOutlined />} onClick={onReload}>
          刷新候选
        </Button>
        <span style={{ color: "var(--c-text-3)", fontSize: 12 }}>
          这些技能已达到自学习阈值,可手动触发改进或等待后台调度
        </span>
      </Space>

      {candidates.length === 0 && !loading ? (
        <Empty description="目前没有改进候选 — 累积调用后失败率达 15%、用量 ≥10 次会自动入列" />
      ) : (
        <Card style={{ borderRadius: 12 }} styles={{ body: { padding: 24 } }}>
          <Table
            dataSource={candidates}
            rowKey={(c) => c.skill.id}
            loading={loading}
            pagination={{ pageSize: 10 }}
            columns={[
              {
                title: "技能",
                dataIndex: ["skill", "name"],
                render: (v: string) => <span style={{ fontWeight: 500 }}>{v}</span>,
              },
              {
                title: "失败次数",
                dataIndex: ["primaryFailureMode", "count"],
                render: (v: number) => <Tag color="orange">{v} 次</Tag>,
              },
              {
                title: "主要故障",
                dataIndex: ["primaryFailureMode", "signature"],
                render: (v: string) => (
                  <span style={{ fontSize: 12, fontFamily: "monospace", color: "var(--c-text-2)" }}>{v}</span>
                ),
              },
              {
                title: "Reason",
                dataIndex: "reason",
                render: (v: string) => <span style={{ fontSize: 12 }}>{v}</span>,
              },
              {
                title: "操作",
                key: "action",
                render: (_: unknown, c: ImprovementCandidate) => (
                  <Button size="small" type="primary" icon={<ThunderboltOutlined />} onClick={() => onImproveClick(c)}>
                    手动改进
                  </Button>
                ),
              },
            ]}
          />
        </Card>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Drafts tab — auto-discovered drafts pending user promotion
// ─────────────────────────────────────────────────────────────────────────────

function DraftsTab({
  drafts,
  loading,
  onReload,
  onPreview,
  onPromote,
}: {
  drafts: Skill[];
  loading: boolean;
  onReload: () => void;
  onPreview: (d: Skill) => void;
  onPromote: (id: string) => void;
}) {
  return (
    <>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ReloadOutlined />} onClick={onReload}>
          刷新
        </Button>
        <span style={{ color: "var(--c-text-3)", fontSize: 12 }}>
          这些是 agent 在执行新任务时自动打包的草稿,审核后晋升即可运行
        </span>
      </Space>

      {drafts.length === 0 && !loading ? (
        <Empty description="没有待审核草稿" />
      ) : (
        <Card style={{ borderRadius: 12 }} styles={{ body: { padding: 24 } }}>
          <Table
            dataSource={drafts}
            rowKey="id"
            loading={loading}
            pagination={{ pageSize: 10 }}
            columns={[
              {
                title: "草稿名",
                dataIndex: "name",
                render: (v: string) => <span style={{ fontWeight: 500 }}>{v}</span>,
              },
              {
                title: "描述",
                dataIndex: "description",
                render: (v: string) => <span style={{ fontSize: 12 }}>{v || "—"}</span>,
              },
              { title: "语言", dataIndex: "language", render: (v: string) => <Tag>{v}</Tag> },
              {
                title: "创建时间",
                dataIndex: "createdAt",
                render: (v: string) => <span style={{ fontSize: 12, color: "var(--c-text-3)" }}>{v}</span>,
              },
              {
                title: "操作",
                key: "action",
                render: (_: unknown, d: Skill) => (
                  <Space>
                    <Button size="small" onClick={() => onPreview(d)}>
                      查看
                    </Button>
                    <Popconfirm
                      title={`将草稿 "${d.name}" 晋升为正式技能?`}
                      onConfirm={() => onPromote(d.id)}
                      okText="晋升"
                      cancelText="取消"
                    >
                      <Button size="small" type="primary" icon={<CheckOutlined />}>
                        晋升
                      </Button>
                    </Popconfirm>
                  </Space>
                ),
              },
            ]}
          />
        </Card>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Modals
// ─────────────────────────────────────────────────────────────────────────────

function AddRegistryModal({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (reg: SkillRegistry) => void;
}) {
  const [form] = Form.useForm<SkillRegistry>();

  return (
    <Modal
      title="添加 Skill Registry"
      open={open}
      onCancel={onClose}
      onOk={() => {
        form.validateFields().then((values) => {
          onSubmit({
            name: values.name,
            url: values.url,
            enabled: values.enabled !== false,
            priority: typeof values.priority === "number" ? values.priority : 50,
          });
          form.resetFields();
        });
      }}
      okText="添加"
      cancelText="取消"
    >
      <Form form={form} layout="vertical" initialValues={{ enabled: true, priority: 50 }}>
        <Form.Item label="名称" name="name" rules={[{ required: true, message: "必填" }]}>
          <Input placeholder="my-registry" />
        </Form.Item>
        <Form.Item
          label="URL"
          name="url"
          rules={[{ required: true, message: "必填" }]}
          extra="支持 file:///abs/path 或 https://..."
        >
          <Input placeholder="https://example.com/skills" />
        </Form.Item>
        <Form.Item label="优先级" name="priority" extra="数字越大越优先,默认 50">
          <InputNumber min={0} max={100} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item label="启用" name="enabled" valuePropName="checked">
          <Switch />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function ImproveModal({
  state,
  onClose,
  onChange,
  onSubmit,
}: {
  state: { open: boolean; candidate?: ImprovementCandidate; code: string; reason: string };
  onClose: () => void;
  onChange: (patch: Partial<{ code: string; reason: string }>) => void;
  onSubmit: () => void;
}) {
  return (
    <Modal
      title={`手动改进:${state.candidate?.skill.name ?? ""}`}
      open={state.open}
      onCancel={onClose}
      onOk={onSubmit}
      okText="生成 Fork"
      cancelText="取消"
      width={720}
    >
      <Form layout="vertical">
        <Form.Item label="改进后的代码">
          <Input.TextArea
            value={state.code}
            onChange={(e) => onChange({ code: e.target.value })}
            rows={12}
            style={{ fontFamily: "monospace", fontSize: 12 }}
          />
        </Form.Item>
        <Form.Item label="改进原因" extra="将记入 ~/.webrain/skills/improved/<id>/v<N>/reason.txt">
          <Input.TextArea value={state.reason} onChange={(e) => onChange({ reason: e.target.value })} rows={3} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function DraftPreviewModal({ draft, onClose }: { draft: Skill | null; onClose: () => void }) {
  return (
    <Modal
      title={draft ? `草稿预览:${draft.name}` : ""}
      open={draft !== null}
      onCancel={onClose}
      footer={null}
      width={720}
    >
      {draft && (
        <>
          <p style={{ color: "var(--c-text-3)", fontSize: 12 }}>{draft.description || "(无描述)"}</p>
          <Space direction="vertical" size={4} style={{ marginBottom: 12 }}>
            <span style={{ fontSize: 12 }}>
              ID: <code>{draft.id}</code>
            </span>
            <span style={{ fontSize: 12 }}>
              语言: <Tag>{draft.language}</Tag>
            </span>
            <span style={{ fontSize: 12 }}>
              触发模式:{" "}
              {draft.triggerPatterns.map((p, i) => (
                <Tag key={i}>{p}</Tag>
              ))}
            </span>
          </Space>
          <Input.TextArea value={draft.code} rows={16} readOnly style={{ fontFamily: "monospace", fontSize: 12 }} />
        </>
      )}
    </Modal>
  );
}
