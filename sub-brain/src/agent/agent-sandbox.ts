/**
 * Agent Sandbox — 进程隔离 + 文件系统沙箱
 * 限制 Agent 的文件访问范围、网络访问、资源使用
 */

import { homedir } from "os";
import { join, resolve, relative } from "path";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync } from "fs";

export interface SandboxPolicy {
  agentId: string;
  // File system
  allowedPaths: string[];        // Paths agent can read/write
  readOnlyPaths: string[];       // Paths agent can only read
  blockedPaths: string[];        // Explicitly blocked paths
  // Network
  allowNetwork: boolean;
  allowedHosts?: string[];       // If allowNetwork, restrict to these hosts
  blockedHosts?: string[];       // Explicitly blocked hosts
  // Resources
  maxCpuPercent?: number;        // CPU limit (0-100)
  maxMemoryMB?: number;          // Memory limit in MB
  maxFileSizeMB?: number;        // Max file write size
  maxExecutionTimeSec?: number;  // Max execution time
  // Tools
  allowedTools?: string[];       // Whitelist of tools
  blockedTools?: string[];       // Blacklist of tools
}

export interface SandboxSession {
  sessionId: string;
  agentId: string;
  policy: SandboxPolicy;
  workspacePath: string;
  createdAt: string;
  active: boolean;
}

export interface SandboxAuditLog {
  timestamp: string;
  agentId: string;
  sessionId: string;
  action: string;
  resource: string;
  allowed: boolean;
  reason?: string;
}

const SANDBOX_BASE = join(homedir(), ".webrain", "agents", "sandboxes");
const AUDIT_LOG_PATH = join(homedir(), ".webrain", "agents", "sandbox-audit.jsonl");

export class AgentSandbox {
  private sessions = new Map<string, SandboxSession>();
  private policies = new Map<string, SandboxPolicy>();
  private auditLogs: SandboxAuditLog[] = [];

  constructor() {
    this.ensureBaseDir();
    this.loadAuditLogs();
  }

  private ensureBaseDir(): void {
    if (!existsSync(SANDBOX_BASE)) {
      mkdirSync(SANDBOX_BASE, { recursive: true });
    }
  }

  private loadAuditLogs(): void {
    try {
      if (existsSync(AUDIT_LOG_PATH)) {
        const lines = readFileSync(AUDIT_LOG_PATH, "utf-8").split("\n").filter(Boolean);
        for (const line of lines.slice(-1000)) {
          try {
            this.auditLogs.push(JSON.parse(line));
          } catch (err) { console.error("[sandbox] Error:", err); }
        }
      }
    } catch (err) { console.error("[sandbox] Error:", err); }
  }

  private appendAudit(log: SandboxAuditLog): void {
    this.auditLogs.push(log);
    if (this.auditLogs.length > 10000) {
      this.auditLogs = this.auditLogs.slice(-5000);
    }
    try {
      writeFileSync(AUDIT_LOG_PATH, JSON.stringify(log) + "\n", { flag: "a" });
    } catch (err) { console.error("[sandbox] Error:", err); }
  }

  // ---- Policy Management ----

  createPolicy(policy: Omit<SandboxPolicy, "agentId"> & { agentId: string }): SandboxPolicy {
    this.policies.set(policy.agentId, policy);
    return policy;
  }

  getPolicy(agentId: string): SandboxPolicy | undefined {
    return this.policies.get(agentId);
  }

  updatePolicy(agentId: string, updates: Partial<SandboxPolicy>): SandboxPolicy | undefined {
    const policy = this.policies.get(agentId);
    if (!policy) return undefined;
    const updated = { ...policy, ...updates };
    this.policies.set(agentId, updated);
    return updated;
  }

  deletePolicy(agentId: string): boolean {
    return this.policies.delete(agentId);
  }

  // Create default restrictive policy
  createDefaultPolicy(agentId: string): SandboxPolicy {
    const workspace = join(SANDBOX_BASE, agentId);
    if (!existsSync(workspace)) mkdirSync(workspace, { recursive: true });

    const policy: SandboxPolicy = {
      agentId,
      allowedPaths: [workspace],
      readOnlyPaths: [],
      blockedPaths: [
        join(homedir(), ".ssh"),
        join(homedir(), ".webrain", "agents"),
        "/etc/shadow",
        "/etc/passwd",
      ],
      allowNetwork: true,
      allowedHosts: [],
      blockedHosts: [],
      maxCpuPercent: 50,
      maxMemoryMB: 512,
      maxFileSizeMB: 100,
      maxExecutionTimeSec: 300,
      allowedTools: [],
      blockedTools: ["shell", "docker"],
    };
    this.policies.set(agentId, policy);
    return policy;
  }

  // ---- Session Management ----

  createSession(agentId: string): SandboxSession {
    let policy = this.policies.get(agentId);
    if (!policy) {
      policy = this.createDefaultPolicy(agentId);
    }

    const workspacePath = join(SANDBOX_BASE, agentId);
    if (!existsSync(workspacePath)) mkdirSync(workspacePath, { recursive: true });

    const session: SandboxSession = {
      sessionId: `sandbox-${agentId}-${Date.now()}`,
      agentId,
      policy,
      workspacePath,
      createdAt: new Date().toISOString(),
      active: true,
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  getSession(sessionId: string): SandboxSession | undefined {
    return this.sessions.get(sessionId);
  }

  closeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.active = false;
    return true;
  }

  destroySession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    // Optionally clean up workspace
    // rmSync(session.workspacePath, { recursive: true, force: true });

    session.active = false;
    this.sessions.delete(sessionId);
    return true;
  }

  // ---- Access Control ----

  checkFileAccess(agentId: string, filePath: string, operation: "read" | "write" | "execute"): { allowed: boolean; reason?: string } {
    const policy = this.policies.get(agentId);
    if (!policy) return { allowed: true }; // No policy = allow (for backwards compat)

    const resolved = resolve(filePath);

    // Check allowed paths first (explicit allow overrides block)
    const allowedPaths = [...policy.allowedPaths, ...(operation === "read" ? policy.readOnlyPaths : [])];
    const inAllowed = allowedPaths.some(ap => resolved.startsWith(resolve(ap)));

    if (inAllowed) {
      // Write check for read-only paths
      if (operation === "write" && policy.readOnlyPaths.some(rp => resolved.startsWith(resolve(rp)))) {
        this.logAudit(agentId, "file_write", filePath, false, "Path is read-only");
        return { allowed: false, reason: `Path ${filePath} is read-only` };
      }
      this.logAudit(agentId, `file_${operation}`, filePath, true);
      return { allowed: true };
    }

    // Check blocked paths
    for (const bp of policy.blockedPaths) {
      if (resolved.startsWith(resolve(bp))) {
        this.logAudit(agentId, "file_access", filePath, false, "Path blocked by policy");
        return { allowed: false, reason: `Path ${filePath} is blocked` };
      }
    }

    this.logAudit(agentId, "file_access", filePath, false, "Path outside allowed scope");
    return { allowed: false, reason: `Path ${filePath} outside allowed scope` };
  }

  checkNetworkAccess(agentId: string, host: string): { allowed: boolean; reason?: string } {
    const policy = this.policies.get(agentId);
    if (!policy) return { allowed: true };

    if (!policy.allowNetwork) {
      this.logAudit(agentId, "network_access", host, false, "Network disabled by policy");
      return { allowed: false, reason: "Network access disabled" };
    }

    if (policy.blockedHosts?.some(h => host.includes(h))) {
      this.logAudit(agentId, "network_access", host, false, "Host blocked by policy");
      return { allowed: false, reason: `Host ${host} is blocked` };
    }

    if (policy.allowedHosts && policy.allowedHosts.length > 0) {
      const allowed = policy.allowedHosts.some(h => host.includes(h));
      if (!allowed) {
        this.logAudit(agentId, "network_access", host, false, "Host not in allowed list");
        return { allowed: false, reason: `Host ${host} not in allowed list` };
      }
    }

    this.logAudit(agentId, "network_access", host, true);
    return { allowed: true };
  }

  checkToolAccess(agentId: string, toolName: string): { allowed: boolean; reason?: string } {
    const policy = this.policies.get(agentId);
    if (!policy) return { allowed: true };

    if (policy.blockedTools?.includes(toolName)) {
      this.logAudit(agentId, "tool_access", toolName, false, "Tool blocked by policy");
      return { allowed: false, reason: `Tool ${toolName} is blocked` };
    }

    if (policy.allowedTools && policy.allowedTools.length > 0 && !policy.allowedTools.includes(toolName)) {
      this.logAudit(agentId, "tool_access", toolName, false, "Tool not in allowed list");
      return { allowed: false, reason: `Tool ${toolName} not in allowed list` };
    }

    this.logAudit(agentId, "tool_access", toolName, true);
    return { allowed: true };
  }

  // ---- File Operations (sandboxed) ----

  sandboxedRead(agentId: string, filePath: string): { ok: boolean; content?: string; error?: string } {
    const check = this.checkFileAccess(agentId, filePath, "read");
    if (!check.allowed) return { ok: false, error: check.reason };

    try {
      const content = readFileSync(filePath, "utf-8");
      return { ok: true, content };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  sandboxedWrite(agentId: string, filePath: string, content: string): { ok: boolean; error?: string } {
    const check = this.checkFileAccess(agentId, filePath, "write");
    if (!check.allowed) return { ok: false, error: check.reason };

    const policy = this.policies.get(agentId);
    if (policy?.maxFileSizeMB) {
      const sizeMB = Buffer.byteLength(content, "utf-8") / (1024 * 1024);
      if (sizeMB > policy.maxFileSizeMB) {
        return { ok: false, error: `File size ${sizeMB.toFixed(1)}MB exceeds limit ${policy.maxFileSizeMB}MB` };
      }
    }

    try {
      writeFileSync(filePath, content);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  sandboxedList(agentId: string, dirPath: string): { ok: boolean; items?: string[]; error?: string } {
    const check = this.checkFileAccess(agentId, dirPath, "read");
    if (!check.allowed) return { ok: false, error: check.reason };

    try {
      const items = readdirSync(dirPath).map(name => {
        const stat = statSync(join(dirPath, name));
        return `${stat.isDirectory() ? "[D]" : "[F]"} ${name}`;
      });
      return { ok: true, items };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  // ---- Audit ----

  private logAudit(agentId: string, action: string, resource: string, allowed: boolean, reason?: string): void {
    this.appendAudit({
      timestamp: new Date().toISOString(),
      agentId,
      sessionId: this.sessions.get(agentId)?.sessionId || "none",
      action,
      resource,
      allowed,
      reason,
    });
  }

  getAuditLogs(agentId?: string, limit = 100): SandboxAuditLog[] {
    let logs = [...this.auditLogs];
    if (agentId) logs = logs.filter(l => l.agentId === agentId);
    return logs.slice(-limit);
  }

  getStats(): {
    totalPolicies: number;
    activeSessions: number;
    totalAuditLogs: number;
    blockedActions: number;
  } {
    return {
      totalPolicies: this.policies.size,
      activeSessions: Array.from(this.sessions.values()).filter(s => s.active).length,
      totalAuditLogs: this.auditLogs.length,
      blockedActions: this.auditLogs.filter(l => !l.allowed).length,
    };
  }
}
