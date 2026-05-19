/**
 * MCP Server info panel (M4b).
 *
 * Shows that webrain is exposing itself as an MCP server, lists the
 * tools available to external MCP clients, and provides copy-friendly
 * connection snippets for both HTTP and stdio transports.
 */

import { useEffect, useState } from "react";
import { Card, Table, Tag, Typography, Empty, message, Alert, Space, Button } from "antd";
import { ApiOutlined, CopyOutlined } from "@ant-design/icons";
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
  const bridgeSnippet = `# Stdio bridge for MCP clients that spawn subprocesses
python sub-brain/main-brain/tools/mcp_stdio_bridge.py \\
    --url ${mcpUrl}`;

  return (
    <Card
      title={
        <Space>
          <ApiOutlined />
          <span>webrain MCP server</span>
          <Tag color="success">{info.server.name} v{info.server.version}</Tag>
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
            外部 MCP 客户端可以通过下方 HTTP 端点直接调用 webrain 的 memory / RAG / wiki /
            knowledge graph 能力。需要 stdio 传输的客户端请用下方 stdio bridge 脚本作为子进程。
          </Paragraph>
        }
        style={{ marginBottom: 16 }}
      />

      <CopyableSnippet label="HTTP 端点 (JSON-RPC 2.0)" code={mcpUrl} />
      <CopyableSnippet label="Stdio bridge 命令" code={bridgeSnippet} />

      <div style={{ marginTop: 24 }}>
        <Text strong>暴露的工具 ({info.tool_count}):</Text>
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
              render: (n: string) => <Text code style={{ fontSize: 12 }}>{n}</Text>,
            },
            {
              title: "描述",
              dataIndex: "description",
              render: (d: string) => <span style={{ fontSize: 12 }}>{d}</span>,
            },
          ]}
        />
      </div>

      <Alert
        type="warning"
        showIcon
        style={{ marginTop: 16 }}
        message="v1 仅暴露只读工具"
        description="当前未对 MCP endpoint 做认证,只暴露 query/search 类只读工具。后续加 token 鉴权后再开放 write 类工具。"
      />
    </Card>
  );
}
