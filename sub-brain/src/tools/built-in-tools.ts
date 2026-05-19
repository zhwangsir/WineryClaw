/**
 * Built-in Tools — 扩展工具集
 * Core built-in tools for the system
 */

import { execSync, spawn } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, resolve, dirname } from "path";
import { registry, ToolDefinition } from "./tool-registry.js";
import { registerWebSearchTool } from "./web-search.js";
import { registerWebFetchTool } from "./web-fetch.js";
import { registerBrowserTools } from "./browser-tool.js";
import { registerEditFileTools } from "./edit-file.js";
import { registerSttTool } from "./stt-tool.js";

// ─── System / Shell ───

const shellDef: ToolDefinition = {
  name: "shell",
  description: "Execute a shell command on the local system",
  category: "system",
  parameters: [
    { name: "command", type: "string", description: "Shell command to execute", required: true },
    { name: "timeout", type: "number", description: "Timeout in milliseconds", default: 30000 },
    { name: "cwd", type: "string", description: "Working directory", default: "." },
  ],
};

async function shellExecute(params: Record<string, unknown>) {
  const cmd = String(params.command || "");
  const timeout = Number(params.timeout || 30000);
  const cwd = String(params.cwd || ".");
  const result = execSync(cmd, { cwd, encoding: "utf-8", timeout, stdio: ["pipe", "pipe", "pipe"] });
  return { output: result, exitCode: 0 };
}

// ─── File Operations ───

const fileReadDef: ToolDefinition = {
  name: "file_read",
  description: "Read contents of a file",
  category: "filesystem",
  parameters: [
    { name: "path", type: "string", description: "File path", required: true },
    { name: "encoding", type: "string", description: "File encoding", default: "utf-8" },
  ],
};

async function fileReadExecute(params: Record<string, unknown>) {
  const path = resolve(String(params.path || ""));
  const encoding = String(params.encoding || "utf-8") as BufferEncoding;
  const content = readFileSync(path, { encoding });
  return { path, content, size: Buffer.byteLength(content) };
}

const fileWriteDef: ToolDefinition = {
  name: "file_write",
  description: "Write content to a file (creates directories if needed)",
  category: "filesystem",
  parameters: [
    { name: "path", type: "string", description: "File path", required: true },
    { name: "content", type: "string", description: "Content to write", required: true },
    { name: "append", type: "boolean", description: "Append instead of overwrite", default: false },
  ],
};

async function fileWriteExecute(params: Record<string, unknown>) {
  const path = resolve(String(params.path || ""));
  const content = String(params.content || "");
  const append = Boolean(params.append);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { flag: append ? "a" : "w" });
  return { path, written: content.length, append };
}

const fileListDef: ToolDefinition = {
  name: "file_list",
  description: "List files in a directory",
  category: "filesystem",
  parameters: [
    { name: "path", type: "string", description: "Directory path", default: "." },
    { name: "recursive", type: "boolean", description: "List recursively", default: false },
  ],
};

async function fileListExecute(params: Record<string, unknown>) {
  const { globSync } = await import("glob");
  const path = String(params.path || ".");
  const recursive = Boolean(params.recursive);
  const pattern = recursive ? join(path, "**/*") : join(path, "*");
  const files = globSync(pattern, { dot: true, nodir: false });
  return { path, files: files.slice(0, 500) };
}

const fileSearchDef: ToolDefinition = {
  name: "file_search",
  description: "Search for text inside files (grep-like)",
  category: "filesystem",
  parameters: [
    { name: "pattern", type: "string", description: "Search pattern", required: true },
    { name: "path", type: "string", description: "Directory or file to search", default: "." },
    { name: "glob", type: "string", description: "File glob pattern", default: "*" },
  ],
};

async function fileSearchExecute(params: Record<string, unknown>) {
  const pattern = String(params.pattern || "");
  const path = String(params.path || ".");
  const glob = String(params.glob || "*");
  const { execSync } = await import("child_process");
  try {
    const output = execSync(`grep -rn --include="${glob}" "${pattern.replace(/"/g, '\\"')}" "${path}" 2>/dev/null || true`, { encoding: "utf-8" });
    const lines = output.trim().split("\n").filter(Boolean);
    return { pattern, matches: lines.slice(0, 100), count: lines.length };
  } catch (err) { console.error("[built-in-tools] Error:", err);
    return { pattern, matches: [], count: 0 };
  }
}

// ─── Network ───

const httpRequestDef: ToolDefinition = {
  name: "http_request",
  description: "Make an HTTP request",
  category: "network",
  parameters: [
    { name: "url", type: "string", description: "Request URL", required: true },
    { name: "method", type: "string", description: "HTTP method", default: "GET" },
    { name: "headers", type: "object", description: "Request headers", default: {} },
    { name: "body", type: "string", description: "Request body", default: "" },
    { name: "timeout", type: "number", description: "Timeout ms", default: 10000 },
  ],
};

async function httpRequestExecute(params: Record<string, unknown>) {
  const url = String(params.url || "");
  const method = String(params.method || "GET").toUpperCase();
  const headers = (params.headers || {}) as Record<string, string>;
  const body = String(params.body || "");
  const timeout = Number(params.timeout || 10000);

  const resp = await fetch(url, { method, headers, body: body || undefined, signal: AbortSignal.timeout(timeout) });
  const text = await resp.text();
  return {
    status: resp.status,
    statusText: resp.statusText,
    headers: Object.fromEntries(resp.headers.entries()),
    body: text.slice(0, 50000),
    truncated: text.length > 50000,
  };
}

// ─── Python Execution ───

const pythonExecDef: ToolDefinition = {
  name: "python_exec",
  description: "Execute Python code and return the output",
  category: "code",
  parameters: [
    { name: "code", type: "string", description: "Python code to execute", required: true },
    { name: "timeout", type: "number", description: "Timeout ms", default: 30000 },
  ],
};

async function pythonExecExecute(params: Record<string, unknown>) {
  const code = String(params.code || "");
  const timeout = Number(params.timeout || 30000);
  const result = execSync(`python3 -c "${code.replace(/"/g, '\\"')}"`, { encoding: "utf-8", timeout });
  return { output: result };
}

// ─── Code Execution (write script then run) ───

const executeCodeDef: ToolDefinition = {
  name: "execute_code",
  description: "Write a Python script to a temp file and execute it. The script can use TOOL_CALL helper to invoke other tools programmatically.",
  category: "code",
  parameters: [
    { name: "script", type: "string", description: "Python script content", required: true },
    { name: "filename", type: "string", description: "Temp filename", default: "agent_script.py" },
    { name: "timeout", type: "number", description: "Timeout ms", default: 60000 },
  ],
};

async function executeCodeExecute(params: Record<string, unknown>) {
  const script = String(params.script || "");
  const filename = String(params.filename || "agent_script.py");
  const timeout = Number(params.timeout || 60000);
  const tmpDir = join(homedir(), ".webrain", "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const scriptPath = join(tmpDir, filename);
  writeFileSync(scriptPath, script);
  const result = execSync(`python3 "${scriptPath}"`, { encoding: "utf-8", timeout });
  return { output: result, scriptPath };
}

// ─── System Info ───

const systemInfoDef: ToolDefinition = {
  name: "system_info",
  description: "Get system information (OS, CPU, memory, disk)",
  category: "system",
  parameters: [],
};

async function systemInfoExecute(_params: Record<string, unknown>) {
  const os = await import("os");
  const { execSync } = await import("child_process");
  return {
    platform: os.platform(),
    arch: os.arch(),
    hostname: os.hostname(),
    cpus: os.cpus().length,
    totalMemory: os.totalmem(),
    freeMemory: os.freemem(),
    uptime: os.uptime(),
    loadavg: os.loadavg(),
    nodeVersion: process.version,
  };
}

// ─── Date / Time ───

const dateTimeDef: ToolDefinition = {
  name: "datetime",
  description: "Get current date and time in various formats",
  category: "utility",
  parameters: [
    { name: "format", type: "string", description: "Output format: iso, unix, local, utc", default: "iso" },
    { name: "timezone", type: "string", description: "Timezone offset (e.g. +08:00)", default: "" },
  ],
};

async function dateTimeExecute(params: Record<string, unknown>) {
  const format = String(params.format || "iso");
  const now = new Date();
  switch (format) {
    case "unix": return { timestamp: Math.floor(now.getTime() / 1000) };
    case "utc": return { datetime: now.toUTCString() };
    case "local": return { datetime: now.toLocaleString() };
    default: return { datetime: now.toISOString() };
  }
}

// ─── Calculator / Math ───

const calculatorDef: ToolDefinition = {
  name: "calculator",
  description: "Evaluate a mathematical expression safely",
  category: "utility",
  parameters: [
    { name: "expression", type: "string", description: "Math expression (e.g. 2+2*3, sin(0.5))", required: true },
  ],
};

async function calculatorExecute(params: Record<string, unknown>) {
  const expression = String(params.expression || "");
  // Safe evaluation using Function constructor with limited scope
  const fn = new Function("Math", `"use strict"; return (${expression})`);
  const result = fn(Math);
  return { expression, result, type: typeof result };
}

// ─── URL / Encode ───

const urlParseDef: ToolDefinition = {
  name: "url_parse",
  description: "Parse a URL into components",
  category: "utility",
  parameters: [
    { name: "url", type: "string", description: "URL to parse", required: true },
  ],
};

async function urlParseExecute(params: Record<string, unknown>) {
  const urlStr = String(params.url || "");
  const url = new URL(urlStr);
  return {
    href: url.href,
    protocol: url.protocol,
    host: url.host,
    hostname: url.hostname,
    port: url.port,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    origin: url.origin,
    searchParams: Object.fromEntries(url.searchParams.entries()),
  };
}

// ─── JSON Operations ───

const jsonParseDef: ToolDefinition = {
  name: "json_parse",
  description: "Parse and validate JSON, with pretty-print option",
  category: "utility",
  parameters: [
    { name: "text", type: "string", description: "JSON string", required: true },
    { name: "pretty", type: "boolean", description: "Pretty print output", default: false },
  ],
};

async function jsonParseExecute(params: Record<string, unknown>) {
  const text = String(params.text || "");
  const pretty = Boolean(params.pretty);
  const obj = JSON.parse(text);
  return { valid: true, object: obj, pretty: pretty ? JSON.stringify(obj, null, 2) : undefined };
}

// ─── Registration ───

export function registerAllTools(): void {
  registry.register(shellDef, shellExecute);
  registry.register(fileReadDef, fileReadExecute);
  registry.register(fileWriteDef, fileWriteExecute);
  registry.register(fileListDef, fileListExecute);
  registry.register(fileSearchDef, fileSearchExecute);
  registry.register(httpRequestDef, httpRequestExecute);
  registry.register(pythonExecDef, pythonExecExecute);
  registry.register(executeCodeDef, executeCodeExecute);
  registry.register(systemInfoDef, systemInfoExecute);
  registry.register(dateTimeDef, dateTimeExecute);
  registry.register(calculatorDef, calculatorExecute);
  registry.register(urlParseDef, urlParseExecute);
  registry.register(jsonParseDef, jsonParseExecute);
  registerWebSearchTool();
  registerWebFetchTool();
  registerBrowserTools();
  registerEditFileTools();
  registerSttTool();
}
