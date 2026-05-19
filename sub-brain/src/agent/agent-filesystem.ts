/**
 * Agent File System — 每个智能体独立文件夹存储
 *
 * 文件夹结构:
 * ~/.webrain/agents/
 *   {agent-id}/
 *     agent.json      # 元数据
 *     system.md       # 系统提示词 (支持 {{tools}} {{memory}} 模板变量)
 *     tools.json      # 工具配置
 *     sandbox.json    # 沙箱策略
 */

import {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  renameSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import type { AgentCard } from "./agent-manager.js";

export const AGENTS_DIR = join(homedir(), ".webrain", "agents");
const AGENTS_JSON_BACKUP = join(AGENTS_DIR, "agents.json.migrated");

export interface AgentFiles {
  card: AgentCard;
  systemPrompt: string;
  tools: AgentToolConfig[];
  sandbox?: Record<string, unknown>;
}

export interface AgentToolConfig {
  name: string;
  enabled: boolean;
  description?: string;
}

export interface AgentToolPermissions {
  allow?: string[];
  deny?: string[];
}

function agentDir(id: string): string {
  return join(AGENTS_DIR, id);
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Default system prompt template — no hardcoded persona */
const DEFAULT_SYSTEM_TEMPLATE = `# {{agent_name}}

{{agent_name}} is a helpful AI assistant.

## Available Tools
{{tools}}

## Relevant Memories
{{memory}}
`;

/** Default tools config */
const DEFAULT_TOOLS: AgentToolConfig[] = [
  { name: "execute_shell", enabled: true, description: "Execute local shell commands" },
  { name: "read_file", enabled: true, description: "Read file contents" },
  { name: "write_file", enabled: true, description: "Write files" },
  { name: "http_request", enabled: true, description: "HTTP requests" },
  { name: "browse_web", enabled: true, description: "Browse web pages" },
];

export class AgentFileSystem {
  /** Load a single agent from its folder */
  loadAgent(id: string): AgentFiles | undefined {
    const dir = agentDir(id);
    if (!existsSync(dir)) return undefined;

    const agentJsonPath = join(dir, "agent.json");
    const systemMdPath = join(dir, "system.md");
    const toolsJsonPath = join(dir, "tools.json");

    if (!existsSync(agentJsonPath)) return undefined;

    try {
      const card: AgentCard = JSON.parse(readFileSync(agentJsonPath, "utf-8"));
      const systemPrompt = existsSync(systemMdPath)
        ? readFileSync(systemMdPath, "utf-8")
        : "";
      const tools: AgentToolConfig[] = existsSync(toolsJsonPath)
        ? JSON.parse(readFileSync(toolsJsonPath, "utf-8"))
        : [];
      const sandbox = existsSync(join(dir, "sandbox.json"))
        ? JSON.parse(readFileSync(join(dir, "sandbox.json"), "utf-8"))
        : undefined;

      return { card, systemPrompt, tools, sandbox };
    } catch (err) { console.error("[agent-filesystem] Error:", err);
      console.error(`[agent-fs] Failed to load agent ${id}:`, err);
      return undefined;
    }
  }

  /** Save or update an agent folder */
  saveAgent(files: AgentFiles): void {
    const dir = agentDir(files.card.id);
    ensureDir(dir);

    // Write agent.json
    writeFileSync(join(dir, "agent.json"), JSON.stringify(files.card, null, 2));

    // Write system.md
    writeFileSync(join(dir, "system.md"), files.systemPrompt);

    // Write tools.json
    writeFileSync(join(dir, "tools.json"), JSON.stringify(files.tools, null, 2));

    // Write sandbox.json if present
    if (files.sandbox) {
      writeFileSync(join(dir, "sandbox.json"), JSON.stringify(files.sandbox, null, 2));
    }
  }

  /** Delete an agent folder */
  deleteAgent(id: string): boolean {
    const dir = agentDir(id);
    if (!existsSync(dir)) return false;
    try {
      rmSync(dir, { recursive: true, force: true });
      return true;
    } catch (err) { console.error("[agent-filesystem] Error:", err);
      console.error(`[agent-fs] Failed to delete agent ${id}:`, err);
      return false;
    }
  }

  /** List all agent IDs */
  listAgentIds(): string[] {
    if (!existsSync(AGENTS_DIR)) return [];
    return readdirSync(AGENTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }

  /** List all agent cards */
  listAgents(): AgentCard[] {
    return this.listAgentIds()
      .map((id) => this.loadAgent(id)?.card)
      .filter((c): c is AgentCard => !!c);
  }

  /** Check if an agent exists */
  exists(id: string): boolean {
    return existsSync(join(agentDir(id), "agent.json"));
  }

  /** Count agents */
  count(): number {
    return this.listAgentIds().length;
  }

  /** Create a minimal default agent (generic, no hardcoded persona) */
  createDefaultAgent(): AgentFiles {
    const id = "agent-default";
    const now = new Date().toISOString();
    const card: AgentCard = {
      id,
      name: "WeBrain Agent",
      description: "Default general-purpose agent",
      capabilities: ["chat", "reasoning", "tool_use", "memory"],
      modelConfig: {},
      tools: ["shell", "file_read", "file_write", "http_request"],
      channels: [],
      owner: "user-default",
      workspaceId: "default",
      status: "idle",
      role: "general",
      maxSteps: 10,
      createdAt: now,
      updatedAt: now,
    };

    const systemPrompt = DEFAULT_SYSTEM_TEMPLATE
      .replace(/{{agent_name}}/g, card.name)
      .replace(/{{agent_role}}/g, card.role || "assistant");

    const files: AgentFiles = {
      card,
      systemPrompt,
      tools: DEFAULT_TOOLS,
    };

    this.saveAgent(files);
    return files;
  }

  /** Migrate from old agents.json to folder structure */
  migrateFromJson(jsonPath: string): { migrated: number; errors: string[] } {
    const errors: string[] = [];
    let migrated = 0;

    if (!existsSync(jsonPath)) return { migrated: 0, errors: [] };

    try {
      const list: AgentCard[] = JSON.parse(readFileSync(jsonPath, "utf-8"));
      for (const card of list) {
        try {
          const dir = agentDir(card.id);
          if (existsSync(dir)) {
            errors.push(`Agent ${card.id} already exists, skipping`);
            continue;
          }

          const systemPrompt = card.systemPrompt || DEFAULT_SYSTEM_TEMPLATE
            .replace(/{{agent_name}}/g, card.name)
            .replace(/{{agent_role}}/g, card.role || "assistant");

          // Map old tools to new config
          const tools: AgentToolConfig[] = DEFAULT_TOOLS.map((t) => ({
            ...t,
            enabled: card.tools?.includes(t.name) ?? true,
          }));

          // If agent has custom tools not in defaults, add them
          if (card.tools) {
            for (const toolName of card.tools) {
              if (!tools.find((t) => t.name === toolName)) {
                tools.push({ name: toolName, enabled: true });
              }
            }
          }

          const files: AgentFiles = {
            card: { ...card, systemPrompt: undefined },
            systemPrompt,
            tools,
          };

          this.saveAgent(files);
          migrated++;
        } catch (err: any) {
          errors.push(`Failed to migrate agent ${card.id}: ${err.message}`);
        }
      }

      // Backup old file
      renameSync(jsonPath, AGENTS_JSON_BACKUP);
      console.log(`[agent-fs] Migrated ${migrated} agents from ${jsonPath}`);
    } catch (err: any) {
      errors.push(`Failed to read agents.json: ${err.message}`);
    }

    return { migrated, errors };
  }

  /** Build system prompt with template variables substituted */
  buildSystemPrompt(agentId: string, vars: {
    memory?: string;
    tools?: string;
    agent_name?: string;
    agent_role?: string;
  } = {}): string | undefined {
    const files = this.loadAgent(agentId);
    if (!files) return undefined;

    let prompt = files.systemPrompt || "";

    // Substitute template variables
    prompt = prompt.replace(/{{memory}}/g, vars.memory || "No relevant memories");
    prompt = prompt.replace(/{{tools}}/g, vars.tools || "");
    prompt = prompt.replace(/{{agent_name}}/g, vars.agent_name || files.card.name || "AI Assistant");
    prompt = prompt.replace(/{{agent_role}}/g, vars.agent_role || files.card.role || "assistant");

    return prompt;
  }

  /** Get enabled tools for an agent */
  getEnabledTools(agentId: string): string[] {
    const files = this.loadAgent(agentId);
    if (!files) return [];
    return files.tools.filter((t) => t.enabled).map((t) => t.name);
  }

  /** Get agent model config (returns empty object if not set) */
  getModelConfig(agentId: string): Record<string, unknown> {
    const files = this.loadAgent(agentId);
    if (!files) return {};
    return (files.card.modelConfig as Record<string, unknown>) || {};
  }
}
