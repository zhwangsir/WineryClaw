/**
 * MCP Server info panel (M4b).
 *
 * Shows that webrain is exposing itself as an MCP server, lists the
 * tools available to external MCP clients, and provides copy-friendly
 * connection snippets for both HTTP and stdio transports.
 */

import { useEffect, useState } from "react";
import { Card, Table, Tag, Typography, Empty, message, Alert, Space, Button } from "antd";
import { ApiOutlined, CopyOutlined, LockOutlined, UnlockOutlined } from "@ant-design/icons";
import { mcpApi, type MCPSelfServerInfo, type MCPExposedToolSummary } from "../../api/mcp";

const { Paragraph, Text } = Typography;

// Resolve the absolute MCP endpoint URL from the page origin + the
// relative path the backend reports. The backend says `/mcp/jsonrpc`
// but external clients need to go through the sub-brain proxy at
// `/brain/mcp/jsonrpc` — we always present the proxied URL.
function resolveMcpUrl(): string {
  if (typeof window === "undefined") return "/brain/mcp/jsonrpc";
  const origin = window.location.origin;
  return `${origin}/brain/mcp/jsonrpc`;
}

function CopyableSnippet({ code, label }: { code: string; label: string }) {
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      message.success("已复制");
    } catch {
      message.error("复制失败");
    }
  };
  return (
    <div style={{ marginTop: 8 }}>
      <Space>
        <Text strong>{label}</Text>
        <Button size="small" icon={<CopyOutlined />} onClick={onCopy}>
          复制
        </Button>
      </Space>
      <pre
        style={{
          marginTop: 6,
          padding: "10px 12px",
          background: "var(--c-bg-2, #f5f5f5)",
          borderRadius: 6,
          fontSize: 12,
          overflowX: "auto",
          whiteSpace: "pre",
          fontFamily: "monospace",
        }}
      >
        {code}
      </pre>
    </div>
  );
}

export default function MCPInfoPanel() {
  const [info, setInfo] = useState<MCPSelfServerInfo | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const data = await mcpApi.selfInfo();
        setInfo(data);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "加载失败";
        message.error(`MCP server 信息加载失败: ${msg}`);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (!info) {
    return (
      <Card title="webrain MCP server" loading={loading} style={{ marginTop: 16 }}>
        <Empty description="加载中..." />
      </Card>
    );
  }

  const mcpUrl = resolveMcpUrl();
  const authRequired = !!info.auth_required_for_write;
  const tokenConfigured = !!info.token_configured;
  const writeToolCount = info.tools.filter((t) => t.scope === "write").length;
  const bridgeSnippet = authRequired
    ? `# Stdio bridge for MCP clients that spawn subprocesses
# Set WEBRAIN_MCP_TOKEN env var first (read it from ~/.webrain/mcp_token
# after first launch, or set your own WEBRAIN_MCP_TOKEN before startup).
export WEBRAIN_MCP_TOKEN="<your-token-here>"
python sub-brain/main-brain/tools/mcp_stdio_bridge.py \\
    --url ${mcpUrl}`
    : `# Stdio bridge for MCP clients that spawn subprocesses
python sub-brain/main-brain/tools/mcp_stdio_bridge.py \\
    --url ${mcpUrl}`;

  return (
    <Card
      title={
        <Space>
          <ApiOutlined />
          <span>webrain MCP server</span>
          <Tag color="success">
            {info.server.name} v{info.server.version}
          </Tag>
          <Tag>{info.transport}</Tag>
        </Space>
      }
      style={{ marginTop: 16 }}
    >
      <Alert
        type="info"
        showIcon
        message="把 webrain 作为 MCP server 暴露给外部客户端使用"
        description={
          <Paragraph style={{ marginBottom: 0 }}>
            外部 MCP 客户端可以通过下方 HTTP 端点直接调用 webrain 的 memory / RAG / wiki / knowledge graph 能力。需要
            stdio 传输的客户端请用下方 stdio bridge 脚本作为子进程。
          </Paragraph>
        }
        style={{ marginBottom: 16 }}
      />

      <CopyableSnippet label="HTTP 端点 (JSON-RPC 2.0)" code={mcpUrl} />
      <CopyableSnippet label="Stdio bridge 命令" code={bridgeSnippet} />

      {/* M4b.1 — authentication status */}
      <div
        style={{
          marginTop: 16,
          padding: "12px 16px",
          borderRadius: 8,
          border: "1px solid var(--c-border)",
          background: "var(--c-bg-2, #f5f5f5)",
        }}
      >
        <Space direction="vertical" size={4} style={{ width: "100%" }}>
          <Space>
            <Text strong>鉴权状态</Text>
            {authRequired ? (
              <Tag icon={<LockOutlined />} color="warning">
                write 工具需要 token
              </Tag>
            ) : (
              <Tag icon={<UnlockOutlined />} color="default">
                write 工具开放(未配置 token)
              </Tag>
            )}
            {tokenConfigured && <Tag color="success">已配置 token</Tag>}
          </Space>
          <Text style={{ fontSize: 12, color: "var(--c-text-3)" }}>
            Token 通过 <Text code>WEBRAIN_MCP_TOKEN</Text> 环境变量 或 <Text code>~/.webrain/mcp_token</Text> 文件 提供
            / 自动生成。read 类工具(query / search / stats)不需要 token,write 类工具(memory_store / wiki_create /
            rag_index_file)需要 <Text code>Authorization: Bearer &lt;token&gt;</Text> 头。
          </Text>
        </Space>
      </div>

      <div style={{ marginTop: 24 }}>
        <Text strong>
          暴露的工具 ({info.tool_count}
          {writeToolCount > 0 && ` · ${writeToolCount} 个 write`}):
        </Text>
        <Table<MCPExposedToolSummary>
          dataSource={info.tools}
          rowKey="name"
          pagination={false}
          size="small"
          style={{ marginTop: 8 }}
          columns={[
            {
              title: "工具名",
              dataIndex: "name",
              width: 240,
              render: (n: string) => (
                <Text code style={{ fontSize: 12 }}>
                  {n}
                </Text>
              ),
            },
            {
              title: "scope",
              dataIndex: "scope",
              width: 80,
              render: (s: string | undefined) =>
                s === "write" ? (
                  <Tag icon={<LockOutlined />} color="warning">
                    write
                  </Tag>
                ) : (
                  <Tag color="default">read</Tag>
                ),
            },
            {
              title: "描述",
              dataIndex: "description",
              render: (d: string) => <span style={{ fontSize: 12 }}>{d}</span>,
            },
          ]}
        />
      </div>
    </Card>
  );
}
