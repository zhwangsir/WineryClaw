/**
 * WeBrain CLI — 命令行界面
 * WeBrain CLI interface
 * 提供快速操作入口，无需启动前端
 */

import { execSync } from "child_process";

export interface CLIOptions {
  subBrainUrl: string;
  mainBrainUrl: string;
}

export class WeBrainCLI {
  private subBrainUrl: string;
  private mainBrainUrl: string;

  constructor(opts: CLIOptions) {
    this.subBrainUrl = opts.subBrainUrl;
    this.mainBrainUrl = opts.mainBrainUrl;
  }

  async status(): Promise<string> {
    const lines: string[] = [];
    lines.push("=== WeBrain Status ===");

    // Sub-brain health
    try {
      const resp = await fetch(`${this.subBrainUrl}/health`);
      const data = await resp.json();
      lines.push(`Sub Brain: ${data.status} @ ${this.subBrainUrl}`);
      lines.push(`  Modules: ${Object.keys(data.modules).join(", ")}`);
    } catch (err) { console.error("[webrain-cli] Error:", err);
      lines.push(`Sub Brain: ❌ unreachable @ ${this.subBrainUrl}`);
    }

    // Main-brain health
    try {
      const resp = await fetch(`${this.mainBrainUrl}/health`);
      const data = await resp.json();
      lines.push(`Main Brain: ${data.status} @ ${this.mainBrainUrl}`);
    } catch (err) { console.error("[webrain-cli] Error:", err);
      lines.push(`Main Brain: ❌ unreachable @ ${this.mainBrainUrl}`);
    }

    // Tools
    try {
      const resp = await fetch(`${this.subBrainUrl}/tools/list`);
      const data = await resp.json();
      lines.push(`Tools: ${data.tools.length} registered`);
      for (const t of data.tools.slice(0, 10)) {
        lines.push(`  ${t.enabled ? "✓" : "✗"} ${t.name} (${t.category})`);
      }
      if (data.tools.length > 10) lines.push(`  ... and ${data.tools.length - 10} more`);
    } catch (err) { console.error("[webrain-cli] Error:", err);
      lines.push("Tools: ❌ unavailable");
    }

    // Agents
    try {
      const resp = await fetch(`${this.subBrainUrl}/agents/stats`);
      const data = await resp.json();
      lines.push(`Agents: ${data.agents.total} (idle: ${data.agents.byStatus.idle}, running: ${data.agents.byStatus.running})`);
      lines.push(`Workflows: ${data.workflows.totalWorkflows} | Templates: ${data.templates.total} | Proposals: ${data.collaboration.activeProposals}`);
    } catch (err) { console.error("[webrain-cli] Error:", err);
      lines.push("Agents: ❌ unavailable");
    }

    return lines.join("\n");
  }

  async chat(message: string, sessionId = "cli"): Promise<string> {
    try {
      const resp = await fetch(`${this.mainBrainUrl}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, session_id: sessionId }),
      });
      const data = await resp.json();
      if (data.reply) return data.reply;
      if (data.error) return `Error: ${data.error}`;
      return JSON.stringify(data, null, 2);
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  }

  async exec(tool: string, params: Record<string, unknown>): Promise<string> {
    try {
      const resp = await fetch(`${this.subBrainUrl}/tools/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool, params }),
      });
      const data = await resp.json();
      if (data.ok) return JSON.stringify(data.result, null, 2);
      if (data.confirmationNeeded) return `⚠️ Confirmation needed: ${data.reason}\nID: ${data.confirmationId}`;
      return `Error: ${data.error}`;
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  }

  async confirm(confirmId: string): Promise<string> {
    try {
      const resp = await fetch(`${this.subBrainUrl}/tools/confirmations/${confirmId}/approve`, { method: "POST" });
      const data = await resp.json();
      return data.ok ? "✅ Confirmed" : `❌ Failed: ${JSON.stringify(data)}`;
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  }

  async memoryStats(): Promise<string> {
    try {
      const resp = await fetch(`${this.mainBrainUrl}/memory/sync`);
      const data = await resp.json();
      return `Memory Stats:\n  Total: ${data.total}\n  By Level: ${JSON.stringify(data.by_level)}\n  Entities: ${data.entities}\n  Facts: ${data.facts}\n  Vectors: ${data.vectors}\n  Skills: ${data.skills}`;
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  }

  async agents(): Promise<string> {
    try {
      const resp = await fetch(`${this.subBrainUrl}/agents`);
      const data = await resp.json();
      const lines: string[] = [`Agents: ${data.agents.length}`];
      for (const a of data.agents) {
        lines.push(`  ${a.status === "running" ? "▶" : "○"} ${a.name} (${a.id}) — ${a.status}`);
      }
      return lines.join("\n");
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  }

  // ---- Phase 3: Extended CLI ----

  async agentRun(agentId: string, taskType: string, payload: Record<string, unknown>): Promise<string> {
    try {
      const resp = await fetch(`${this.subBrainUrl}/agents/${agentId}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: taskType, payload, contextId: `cli-${Date.now()}` }),
      });
      const data = await resp.json();
      if (!data.ok) return `Error: ${data.error || "Failed to create task"}`;
      const taskId = data.task.taskId;

      // Start task
      await fetch(`${this.subBrainUrl}/agents/tasks/${taskId}/start`, { method: "POST" });

      // Poll for completion
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const taskResp = await fetch(`${this.subBrainUrl}/a2a/task/${taskId}`);
        const taskData = await taskResp.json();
        if (taskData.task?.status === "completed") {
          return `✅ Task completed\nResult: ${JSON.stringify(taskData.task.result, null, 2)}`;
        }
        if (taskData.task?.status === "failed") {
          return `❌ Task failed: ${taskData.task.error}`;
        }
      }
      return `⏳ Task ${taskId} is still running...`;
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  }

  async workflowRun(workflowId: string, inputs: Record<string, unknown> = {}): Promise<string> {
    try {
      const resp = await fetch(`${this.subBrainUrl}/workflows/${workflowId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputs }),
      });
      const data = await resp.json();
      if (!data.ok) return `Error: ${data.error || "Failed to run workflow"}`;
      const run = data.run;
      return `✅ Workflow run started\nRun ID: ${run.runId}\nStatus: ${run.status}`;
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  }

  async workflowList(): Promise<string> {
    try {
      const resp = await fetch(`${this.subBrainUrl}/workflows`);
      const data = await resp.json();
      const lines: string[] = [`Workflows: ${data.workflows.length}`];
      for (const w of data.workflows) {
        lines.push(`  ${w.name} (${w.id}) — ${w.nodes.length} nodes, ${w.edges.length} edges`);
      }
      return lines.join("\n");
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  }

  async templateList(): Promise<string> {
    try {
      const resp = await fetch(`${this.subBrainUrl}/templates`);
      const data = await resp.json();
      const lines: string[] = [`Templates: ${data.templates.length}`];
      for (const t of data.templates) {
        lines.push(`  ${t.name} (${t.id}) — ${t.category} ${t.isBuiltIn ? "[built-in]" : ""}`);
      }
      return lines.join("\n");
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  }

  async templateInstantiate(templateId: string, name: string): Promise<string> {
    try {
      const resp = await fetch(`${this.subBrainUrl}/templates/${templateId}/instantiate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, workspaceId: "default", owner: "cli" }),
      });
      const data = await resp.json();
      if (data.ok) return `✅ Agent created: ${data.agent.name} (${data.agent.id})`;
      return `Error: ${data.error}`;
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  }

  async configGet(key?: string): Promise<string> {
    try {
      const resp = await fetch(`${this.subBrainUrl}/config/global`);
      const data = await resp.json();
      if (key) return `${key}: ${JSON.stringify(data.config?.[key], null, 2)}`;
      return JSON.stringify(data.config, null, 2);
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  }

  async configSet(key: string, value: string): Promise<string> {
    try {
      const parsed = JSON.parse(value);
      const resp = await fetch(`${this.subBrainUrl}/config/global`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: parsed }),
      });
      const data = await resp.json();
      return data.ok ? `✅ ${key} = ${value}` : `Error: ${JSON.stringify(data)}`;
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  }

  async cacheStats(): Promise<string> {
    try {
      const resp = await fetch(`${this.mainBrainUrl}/cache/stats`);
      const data = await resp.json();
      return JSON.stringify(data, null, 2);
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  }

  async cacheClear(): Promise<string> {
    try {
      const resp = await fetch(`${this.mainBrainUrl}/cache/clear`, { method: "POST" });
      const data = await resp.json();
      return data.ok ? "✅ Cache cleared" : `Error: ${JSON.stringify(data)}`;
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  }
}
