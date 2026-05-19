/**
 * Layered Configuration — Global / Workspace / Agent 三层配置 + 热重载
 * Layered configuration system
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, watch } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface AgentConfig {
  agentId: string;
  name: string;
  modelConfig?: Record<string, unknown>;
  tools?: { enabled?: string[]; disabled?: string[] };
  channels?: string[];
  permissions?: string[];
}

export interface WorkspaceConfig {
  workspaceId: string;
  name: string;
  agents: AgentConfig[];
  defaultModel?: Record<string, unknown>;
  sharedSecrets?: string[];
}

export interface GlobalConfig {
  version: string;
  debug: boolean;
  logLevel: string;
  maxConcurrentTools: number;
  toolTimeoutMs: number;
  requireConfirmation: boolean;
  whitelistMode: "strict" | "permissive";
  defaultWorkspace: string;
  workspaces: WorkspaceConfig[];
}

const CONFIG_DIR = join(homedir(), ".webrain", "config");
const GLOBAL_PATH = join(CONFIG_DIR, "global.json");

const DEFAULT_GLOBAL: GlobalConfig = {
  version: "1.0.0",
  debug: false,
  logLevel: "info",
  maxConcurrentTools: 8,
  toolTimeoutMs: 30000,
  requireConfirmation: true,
  whitelistMode: "strict",
  defaultWorkspace: "default",
  workspaces: [
    {
      workspaceId: "default",
      name: "Default Workspace",
      agents: [
        {
          agentId: "default-agent",
          name: "WeBrain Agent",
          permissions: ["tool:shell", "tool:file_read", "tool:file_write", "tool:http_request", "tool:python_exec"],
        },
      ],
    },
  ],
};

export class LayeredConfigManager {
  private globalConfig: GlobalConfig;
  private watchers: Map<string, ReturnType<typeof watch>> = new Map();
  private reloadCallbacks: Array<(path: string) => void> = [];

  constructor() {
    this.globalConfig = this.loadGlobal();
    this.setupWatcher();
  }

  private loadGlobal(): GlobalConfig {
    try {
      if (existsSync(GLOBAL_PATH)) {
        const raw = readFileSync(GLOBAL_PATH, "utf-8");
        return { ...DEFAULT_GLOBAL, ...JSON.parse(raw) };
      }
    } catch (err) { console.error("[layered-config] Error:", err);
      console.error("[config] Failed to load global config:", err);
    }
    this.saveGlobal(DEFAULT_GLOBAL);
    return { ...DEFAULT_GLOBAL };
  }

  private saveGlobal(config: GlobalConfig): void {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }
    writeFileSync(GLOBAL_PATH, JSON.stringify(config, null, 2), "utf-8");
  }

  private setupWatcher(): void {
    if (!existsSync(CONFIG_DIR)) return;
    try {
      const watcher = watch(CONFIG_DIR, { recursive: true }, (eventType, filename) => {
        if (filename?.endsWith(".json")) {
          console.log(`[config] Detected change: ${filename}, reloading...`);
          this.globalConfig = this.loadGlobal();
          for (const cb of this.reloadCallbacks) {
            cb(join(CONFIG_DIR, filename));
          }
        }
      });
      this.watchers.set("global", watcher);
    } catch (err) { console.error("[layered-config] Error:", err);
      console.error("[config] Failed to setup watcher:", err);
    }
  }

  getGlobal(): GlobalConfig {
    return JSON.parse(JSON.stringify(this.globalConfig));
  }

  updateGlobal(updates: Partial<GlobalConfig>): GlobalConfig {
    this.globalConfig = { ...this.globalConfig, ...updates };
    this.saveGlobal(this.globalConfig);
    return this.getGlobal();
  }

  getWorkspace(workspaceId?: string): WorkspaceConfig | undefined {
    const id = workspaceId || this.globalConfig.defaultWorkspace;
    return this.globalConfig.workspaces.find((w) => w.workspaceId === id);
  }

  getAgent(agentId: string, workspaceId?: string): AgentConfig | undefined {
    const ws = this.getWorkspace(workspaceId);
    return ws?.agents.find((a) => a.agentId === agentId);
  }

  listWorkspaces(): WorkspaceConfig[] {
    return JSON.parse(JSON.stringify(this.globalConfig.workspaces));
  }

  listAgents(workspaceId?: string): AgentConfig[] {
    const ws = this.getWorkspace(workspaceId);
    return ws ? JSON.parse(JSON.stringify(ws.agents)) : [];
  }

  addWorkspace(workspace: WorkspaceConfig): WorkspaceConfig {
    const idx = this.globalConfig.workspaces.findIndex((w) => w.workspaceId === workspace.workspaceId);
    if (idx >= 0) {
      this.globalConfig.workspaces[idx] = workspace;
    } else {
      this.globalConfig.workspaces.push(workspace);
    }
    this.saveGlobal(this.globalConfig);
    return this.getWorkspace(workspace.workspaceId)!;
  }

  addAgent(agent: AgentConfig, workspaceId?: string): AgentConfig | undefined {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return undefined;
    const idx = ws.agents.findIndex((a) => a.agentId === agent.agentId);
    if (idx >= 0) {
      ws.agents[idx] = agent;
    } else {
      ws.agents.push(agent);
    }
    this.saveGlobal(this.globalConfig);
    return this.getAgent(agent.agentId, workspaceId);
  }

  deleteWorkspace(workspaceId: string): boolean {
    const idx = this.globalConfig.workspaces.findIndex((w) => w.workspaceId === workspaceId);
    if (idx < 0) return false;
    this.globalConfig.workspaces.splice(idx, 1);
    this.saveGlobal(this.globalConfig);
    return true;
  }

  onReload(callback: (path: string) => void): void {
    this.reloadCallbacks.push(callback);
  }

  close(): void {
    for (const w of this.watchers.values()) {
      w.close();
    }
    this.watchers.clear();
  }
}
