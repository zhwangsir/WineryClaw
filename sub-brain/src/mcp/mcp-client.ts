/**
 * MCP (Model Context Protocol) Client
 * 实现完整的 JSON-RPC over stdio MCP 连接，无需外部 SDK 依赖
 */

import { spawn, ChildProcess } from "child_process";

export interface MCPServerConfig {
  id: string;
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type: "stdio" | "http";
}

interface MCPTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface JSONRPCRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: unknown;
}

interface JSONRPCResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface MCPServerConnection {
  config: MCPServerConfig;
  process?: ChildProcess;
  tools: MCPTool[];
  initialized: boolean;
  requestId: number;
  pending: Map<number | string, { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }>;
  buffer: string;
}

export class MCPClient {
  private servers = new Map<string, MCPServerConnection>();
  private requestTimeoutMs = 30000;

  async connectServer(config: MCPServerConfig): Promise<{ ok: boolean; error?: string; tools?: string[] }> {
    if (this.servers.has(config.id)) {
      return { ok: false, error: `Server already connected: ${config.id}` };
    }

    const conn: MCPServerConnection = {
      config,
      tools: [],
      initialized: false,
      requestId: 0,
      pending: new Map(),
      buffer: "",
    };

    try {
      if (config.type === "stdio" && config.command) {
        await this._connectStdio(conn);
      } else if (config.type === "http" && config.url) {
        await this._connectHttp(conn);
      } else {
        return { ok: false, error: "Invalid config: missing command (stdio) or url (http)" };
      }

      this.servers.set(config.id, conn);
      console.log(`[mcp] Connected to ${config.name}: ${conn.tools.length} tools`);
      return { ok: true, tools: conn.tools.map((t) => t.name) };
    } catch (err: any) {
      this._cleanup(conn);
      console.error(`[mcp] Failed to connect ${config.name}:`, err.message);
      return { ok: false, error: String(err.message || err) };
    }
  }

  private async _connectStdio(conn: MCPServerConnection): Promise<void> {
    const { command, args = [], env = {} } = conn.config;
    if (!command) throw new Error("Missing command for stdio connection");

    const proc = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    conn.process = proc;

    // Handle stderr for logging
    proc.stderr?.on("data", (data: Buffer) => {
      const lines = data.toString("utf-8").trim().split("\n");
      for (const line of lines) {
        if (line) console.log(`[mcp:${conn.config.id}] stderr: ${line}`);
      }
    });

    // Handle stdout for JSON-RPC responses
    proc.stdout?.on("data", (data: Buffer) => {
      conn.buffer += data.toString("utf-8");
      const lines = conn.buffer.split("\n");
      conn.buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) this._handleStdioLine(conn, line.trim());
      }
    });

    proc.on("error", (err) => {
      console.error(`[mcp:${conn.config.id}] Process error:`, err.message);
      this._rejectAllPending(conn, new Error(`Process error: ${err.message}`));
    });

    proc.on("close", (code) => {
      console.log(`[mcp:${conn.config.id}] Process exited with code ${code}`);
      this._rejectAllPending(conn, new Error(`Process exited with code ${code}`));
      conn.initialized = false;
    });

    // Wait for process to be ready
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Process spawn timeout")), 5000);
      proc.on("spawn", () => {
        clearTimeout(timer);
        resolve();
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    // MCP Initialize handshake
    const initResult = (await this._sendStdioRequest(conn, {
      jsonrpc: "2.0",
      id: ++conn.requestId,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "webrain", version: "1.0.0" },
      },
    })) as { protocolVersion?: string; capabilities?: unknown };

    if (!initResult || !initResult.protocolVersion) {
      throw new Error("MCP initialize handshake failed: no protocol version in response");
    }

    // Send initialized notification
    this._sendStdioNotification(conn, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    conn.initialized = true;

    // Discover tools
    const toolsResult = (await this._sendStdioRequest(conn, {
      jsonrpc: "2.0",
      id: ++conn.requestId,
      method: "tools/list",
      params: {},
    })) as { tools?: MCPTool[] };

    conn.tools = toolsResult?.tools || [];
  }

  private async _connectHttp(conn: MCPServerConnection): Promise<void> {
    const { url } = conn.config;
    if (!url) throw new Error("Missing url for http connection");

    try {
      const axios = (await import("axios")).default;

      // HTTP initialize handshake
      const initResp = await axios.post(url, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "webrain", version: "1.0.0" },
        },
      }, { timeout: 10000 });

      if (!initResp.data?.result?.protocolVersion) {
        throw new Error("MCP HTTP initialize handshake failed");
      }

      conn.initialized = true;

      // Discover tools
      const toolsResp = await axios.post(url, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }, { timeout: 10000 });

      conn.tools = toolsResp.data?.result?.tools || [];
    } catch (err: any) {
      throw new Error(`HTTP connection failed: ${err.message}`);
    }
  }

  private _sendStdioRequest(conn: MCPServerConnection, request: JSONRPCRequest): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = request.id;
      if (id === undefined) {
        reject(new Error("Request must have an id"));
        return;
      }

      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new Error(`Request timeout after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      conn.pending.set(id, { resolve, reject, timer });

      const payload = JSON.stringify(request) + "\n";
      if (conn.process?.stdin?.writable) {
        conn.process.stdin.write(payload, (err) => {
          if (err) {
            clearTimeout(timer);
            conn.pending.delete(id);
            reject(err);
          }
        });
      } else {
        clearTimeout(timer);
        conn.pending.delete(id);
        reject(new Error("Process stdin not writable"));
      }
    });
  }

  private _sendStdioNotification(conn: MCPServerConnection, notification: Omit<JSONRPCRequest, "id">): void {
    const payload = JSON.stringify(notification) + "\n";
    if (conn.process?.stdin?.writable) {
      conn.process.stdin.write(payload);
    }
  }

  private _handleStdioLine(conn: MCPServerConnection, line: string): void {
    try {
      const msg = JSON.parse(line) as JSONRPCResponse;
      if (msg.id !== undefined && conn.pending.has(msg.id)) {
        const pending = conn.pending.get(msg.id)!;
        clearTimeout(pending.timer);
        conn.pending.delete(msg.id);

        if (msg.error) {
          pending.reject(new Error(msg.error.message));
        } else {
          pending.resolve(msg.result);
        }
      }
    } catch (err) { console.error("[mcp-client] Error:", err);
      // Not a JSON-RPC message, ignore
    }
  }

  private _rejectAllPending(conn: MCPServerConnection, err: Error): void {
    for (const pending of conn.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    conn.pending.clear();
  }

  async callTool(serverId: string, toolName: string, params: Record<string, unknown>): Promise<unknown> {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`MCP server not connected: ${serverId}`);
    }

    if (!server.initialized) {
      throw new Error(`MCP server not initialized: ${serverId}`);
    }

    // Verify tool exists
    const tool = server.tools.find((t) => t.name === toolName);
    if (!tool) {
      throw new Error(`Tool not found on server ${serverId}: ${toolName}`);
    }

    if (server.config.type === "stdio") {
      const result = await this._sendStdioRequest(server, {
        jsonrpc: "2.0",
        id: ++server.requestId,
        method: "tools/call",
        params: { name: toolName, arguments: params },
      });
      return result;
    } else if (server.config.type === "http" && server.config.url) {
      const axios = (await import("axios")).default;
      const resp = await axios.post(
        server.config.url,
        {
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/call",
          params: { name: toolName, arguments: params },
        },
        { timeout: 60000 }
      );
      if (resp.data?.error) {
        throw new Error(resp.data.error.message);
      }
      return resp.data?.result;
    }

    throw new Error(`Unsupported connection type: ${server.config.type}`);
  }

  listTools(serverId?: string): Array<{ server: string; tool: string; description?: string; schema?: Record<string, unknown> }> {
    const results: Array<{ server: string; tool: string; description?: string; schema?: Record<string, unknown> }> = [];
    for (const [id, server] of this.servers) {
      if (serverId && id !== serverId) continue;
      for (const tool of server.tools) {
        results.push({ server: id, tool: tool.name, description: tool.description, schema: tool.inputSchema });
      }
    }
    return results;
  }

  disconnectServer(serverId: string): void {
    const server = this.servers.get(serverId);
    if (server) {
      this._cleanup(server);
      this.servers.delete(serverId);
      console.log(`[mcp] Disconnected ${serverId}`);
    }
  }

  private _cleanup(conn: MCPServerConnection): void {
    this._rejectAllPending(conn, new Error("Server disconnected"));
    if (conn.process) {
      conn.process.stdin?.end();
      conn.process.kill("SIGTERM");
      // Force kill after grace period
      setTimeout(() => {
        if (!conn.process?.killed) {
          conn.process?.kill("SIGKILL");
        }
      }, 3000);
    }
  }

  listServers(): Array<{ id: string; name: string; type: string; connected: boolean; toolCount: number }> {
    return Array.from(this.servers.entries()).map(([id, s]) => ({
      id,
      name: s.config.name,
      type: s.config.type,
      connected: s.initialized,
      toolCount: s.tools.length,
    }));
  }
}
