/**
 * Agent Template Engine — Agent 模板市场
 * 预置模板管理 + 自定义模板 + 模板实例化
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  version: string;
  author: string;
  tags: string[];
  // Agent configuration blueprint
  blueprint: {
    role: string;
    systemPrompt: string;
    capabilities: string[];
    tools: string[];
    modelConfig: Record<string, unknown>;
    channels: string[];
    maxSteps?: number;
    harnessEnabled?: boolean;
  };
  // Variables that can be substituted during instantiation
  variables?: Record<string, { type: string; default?: unknown; description: string }>;
  createdAt: string;
  updatedAt: string;
  isBuiltIn: boolean;
}

export interface TemplateInstanceOptions {
  name?: string;
  workspaceId?: string;
  owner?: string;
  variables?: Record<string, unknown>;
}

const TEMPLATE_DIR = join(homedir(), ".webrain", "agents", "templates");
const BUILTIN_TEMPLATES: AgentTemplate[] = [
  {
    id: "tpl-researcher",
    name: "Research Agent",
    description: "Deep research agent with web search, browsing, and summarization capabilities",
    category: "productivity",
    version: "1.0.0",
    author: "webrain",
    tags: ["research", "web", "analysis"],
    blueprint: {
      role: "researcher",
      systemPrompt: "You are a research assistant. Your job is to gather information from the web, analyze sources, and produce comprehensive summaries. Always cite your sources and indicate confidence levels.",
      capabilities: ["chat", "reasoning", "tool_use", "memory", "web_search", "web_browse"],
      tools: ["web_search", "web_fetch", "browser_navigate", "browser_extract", "file_write"],
      modelConfig: { temperature: 0.3, maxTokens: 4096 },
      channels: [],
      maxSteps: 10,
      harnessEnabled: true,
    },
    variables: {
      researchDomain: { type: "string", default: "general", description: "Primary research domain (e.g., tech, science, business)" },
      depth: { type: "number", default: 3, description: "Research depth level (1-5)" },
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isBuiltIn: true,
  },
  {
    id: "tpl-coder",
    name: "Code Agent",
    description: "Software development agent with code generation, review, and debugging capabilities",
    category: "development",
    version: "1.0.0",
    author: "webrain",
    tags: ["coding", "debugging", "review"],
    blueprint: {
      role: "coder",
      systemPrompt: "You are a senior software engineer. You write clean, well-documented code. You follow best practices, write tests, and explain your design decisions. When debugging, you systematically isolate issues.",
      capabilities: ["chat", "reasoning", "tool_use", "memory", "code_gen", "code_review"],
      tools: ["shell", "file_read", "file_write", "edit_file", "apply_patch", "python_exec"],
      modelConfig: { temperature: 0.2, maxTokens: 8192 },
      channels: [],
      maxSteps: 15,
      harnessEnabled: true,
    },
    variables: {
      language: { type: "string", default: "python", description: "Primary programming language" },
      style: { type: "string", default: "pep8", description: "Code style guide to follow" },
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isBuiltIn: true,
  },
  {
    id: "tpl-writer",
    name: "Content Writer",
    description: "Creative writing agent for blogs, documentation, and marketing copy",
    category: "creative",
    version: "1.0.0",
    author: "webrain",
    tags: ["writing", "creative", "marketing"],
    blueprint: {
      role: "writer",
      systemPrompt: "You are a professional content writer. You craft engaging, clear, and well-structured content. You adapt your tone to the audience and purpose. You optimize for readability and SEO when appropriate.",
      capabilities: ["chat", "reasoning", "tool_use", "memory", "writing"],
      tools: ["web_search", "file_read", "file_write"],
      modelConfig: { temperature: 0.7, maxTokens: 4096 },
      channels: [],
      maxSteps: 8,
      harnessEnabled: false,
    },
    variables: {
      tone: { type: "string", default: "professional", description: "Writing tone (professional, casual, technical, creative)" },
      format: { type: "string", default: "markdown", description: "Output format (markdown, html, plain)" },
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isBuiltIn: true,
  },
  {
    id: "tpl-analyst",
    name: "Data Analyst",
    description: "Data analysis agent for CSV, SQL, and statistical operations",
    category: "data",
    version: "1.0.0",
    author: "webrain",
    tags: ["data", "analysis", "sql", "csv"],
    blueprint: {
      role: "analyst",
      systemPrompt: "You are a data analyst. You clean, transform, and analyze data. You produce clear visualizations and actionable insights. You write efficient SQL queries and Python data processing code.",
      capabilities: ["chat", "reasoning", "tool_use", "memory", "data_analysis"],
      tools: ["shell", "python_exec", "file_read", "file_write"],
      modelConfig: { temperature: 0.1, maxTokens: 4096 },
      channels: [],
      maxSteps: 12,
      harnessEnabled: true,
    },
    variables: {
      dataSource: { type: "string", default: "csv", description: "Primary data source type (csv, sql, json, api)" },
      vizTool: { type: "string", default: "matplotlib", description: "Visualization library preference" },
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isBuiltIn: true,
  },
  {
    id: "tpl-devops",
    name: "DevOps Agent",
    description: "Infrastructure and deployment automation agent",
    category: "infrastructure",
    version: "1.0.0",
    author: "webrain",
    tags: ["devops", "docker", "deployment", "monitoring"],
    blueprint: {
      role: "devops",
      systemPrompt: "You are a DevOps engineer. You automate deployments, manage containers, configure CI/CD pipelines, and monitor infrastructure. You follow infrastructure-as-code principles and security best practices.",
      capabilities: ["chat", "reasoning", "tool_use", "memory", "automation"],
      tools: ["shell", "docker", "file_read", "file_write", "http_request"],
      modelConfig: { temperature: 0.2, maxTokens: 4096 },
      channels: ["slack", "email"],
      maxSteps: 15,
      harnessEnabled: true,
    },
    variables: {
      platform: { type: "string", default: "docker", description: "Deployment platform (docker, k8s, aws, azure)" },
      ciTool: { type: "string", default: "github-actions", description: "CI/CD tool (github-actions, gitlab-ci, jenkins)" },
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isBuiltIn: true,
  },
  {
    id: "tpl-support",
    name: "Support Agent",
    description: "Customer support agent with knowledge base integration and escalation",
    category: "support",
    version: "1.0.0",
    author: "webrain",
    tags: ["support", "customer", "helpdesk"],
    blueprint: {
      role: "support",
      systemPrompt: "You are a customer support specialist. You are patient, empathetic, and thorough. You search the knowledge base before answering, escalate complex issues appropriately, and always confirm that the customer's problem is resolved.",
      capabilities: ["chat", "reasoning", "tool_use", "memory", "knowledge_base"],
      tools: ["web_search", "file_read", "http_request"],
      modelConfig: { temperature: 0.4, maxTokens: 2048 },
      channels: ["email", "slack", "telegram"],
      maxSteps: 6,
      harnessEnabled: false,
    },
    variables: {
      product: { type: "string", default: "general", description: "Product name being supported" },
      escalationThreshold: { type: "number", default: 0.7, description: "Confidence threshold for escalation (0-1)" },
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isBuiltIn: true,
  },
  {
    id: "tpl-security",
    name: "Security Agent",
    description: "Security analysis and auditing agent",
    category: "security",
    version: "1.0.0",
    author: "webrain",
    tags: ["security", "audit", "scanning"],
    blueprint: {
      role: "security",
      systemPrompt: "You are a security engineer. You analyze code for vulnerabilities, review configurations for security issues, and provide remediation advice. You follow OWASP guidelines and industry best practices.",
      capabilities: ["chat", "reasoning", "tool_use", "memory", "security_scan"],
      tools: ["shell", "file_read", "file_write", "python_exec"],
      modelConfig: { temperature: 0.1, maxTokens: 4096 },
      channels: ["email", "slack"],
      maxSteps: 10,
      harnessEnabled: true,
    },
    variables: {
      scanType: { type: "string", default: "sast", description: "Scan type (sast, dast, dependency, config)" },
      severityThreshold: { type: "string", default: "medium", description: "Minimum severity to report (low, medium, high, critical)" },
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isBuiltIn: true,
  },
];

export class AgentTemplateEngine {
  private templates = new Map<string, AgentTemplate>();

  constructor() {
    this.loadBuiltins();
    this.loadCustom();
  }

  private loadBuiltins(): void {
    for (const tpl of BUILTIN_TEMPLATES) {
      this.templates.set(tpl.id, tpl);
    }
  }

  private loadCustom(): void {
    try {
      if (!existsSync(TEMPLATE_DIR)) return;
      for (const f of readdirSync(TEMPLATE_DIR)) {
        if (f.endsWith(".json")) {
          try {
            const tpl: AgentTemplate = JSON.parse(readFileSync(join(TEMPLATE_DIR, f), "utf-8"));
            this.templates.set(tpl.id, tpl);
          } catch (err) { console.error("[template-engine] Error:", err); console.error("[template] Error:", err); }
        }
      }
    } catch (err) { console.error("[template-engine] Error:", err);
      console.error("[template] Load custom failed:", err);
    }
  }

  private saveCustom(tpl: AgentTemplate): void {
    if (tpl.isBuiltIn) return;
    try {
      if (!existsSync(TEMPLATE_DIR)) mkdirSync(TEMPLATE_DIR, { recursive: true });
      writeFileSync(join(TEMPLATE_DIR, `${tpl.id}.json`), JSON.stringify(tpl, null, 2));
    } catch (err) { console.error("[template-engine] Error:", err);
      console.error("[template] Save custom failed:", err);
    }
  }

  private deleteCustomFile(id: string): void {
    try {
      const path = join(TEMPLATE_DIR, `${id}.json`);
      if (existsSync(path)) unlinkSync(path);
    } catch (err) { console.error("[template-engine] Error:", err); console.error("[template] Error:", err); }
  }

  // ---- CRUD ----

  list(category?: string, tag?: string): AgentTemplate[] {
    let all = Array.from(this.templates.values());
    if (category) all = all.filter(t => t.category === category);
    if (tag) all = all.filter(t => t.tags.includes(tag));
    return all;
  }

  get(id: string): AgentTemplate | undefined {
    return this.templates.get(id);
  }

  create(tpl: Omit<AgentTemplate, "id" | "createdAt" | "updatedAt" | "isBuiltIn">): AgentTemplate {
    const full: AgentTemplate = {
      ...tpl,
      id: `tpl-${Date.now()}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isBuiltIn: false,
    };
    this.templates.set(full.id, full);
    this.saveCustom(full);
    return full;
  }

  update(id: string, updates: Partial<Omit<AgentTemplate, "id" | "createdAt" | "isBuiltIn">>): AgentTemplate | undefined {
    const tpl = this.templates.get(id);
    if (!tpl || tpl.isBuiltIn) return undefined;
    Object.assign(tpl, updates, { updatedAt: new Date().toISOString() });
    this.saveCustom(tpl);
    return tpl;
  }

  delete(id: string): boolean {
    const tpl = this.templates.get(id);
    if (!tpl || tpl.isBuiltIn) return false;
    this.deleteCustomFile(id);
    return this.templates.delete(id);
  }

  // ---- Instantiation ----

  instantiate(tplId: string, options: TemplateInstanceOptions = {}): { ok: boolean; card?: Record<string, unknown>; error?: string } {
    const tpl = this.templates.get(tplId);
    if (!tpl) return { ok: false, error: `Template ${tplId} not found` };

    const vars = options.variables || {};

    // Apply variable substitutions
    let systemPrompt = tpl.blueprint.systemPrompt;
    for (const [key, def] of Object.entries(tpl.variables || {})) {
      const value = vars[key] ?? def.default ?? "";
      systemPrompt = systemPrompt.replace(new RegExp(`{{${key}}}`, "g"), String(value));
    }

    // Build AgentCard-compatible object
    const card = {
      name: options.name || `${tpl.name} Instance`,
      description: tpl.description,
      capabilities: [...tpl.blueprint.capabilities],
      modelConfig: { ...tpl.blueprint.modelConfig },
      tools: [...tpl.blueprint.tools],
      channels: [...tpl.blueprint.channels],
      owner: options.owner || "user-default",
      workspaceId: options.workspaceId || "default",
      // Extended fields
      role: tpl.blueprint.role,
      systemPrompt,
      maxSteps: tpl.blueprint.maxSteps,
      harnessEnabled: tpl.blueprint.harnessEnabled,
      templateId: tpl.id,
      templateVariables: vars,
    };

    return { ok: true, card };
  }

  // ---- Categories & Tags ----

  getCategories(): string[] {
    const cats = new Set<string>();
    for (const t of this.templates.values()) cats.add(t.category);
    return Array.from(cats).sort();
  }

  getTags(): string[] {
    const tags = new Set<string>();
    for (const t of this.templates.values()) {
      for (const tag of t.tags) tags.add(tag);
    }
    return Array.from(tags).sort();
  }

  getStats(): { total: number; builtin: number; custom: number; categories: string[]; tags: string[] } {
    const all = Array.from(this.templates.values());
    return {
      total: all.length,
      builtin: all.filter(t => t.isBuiltIn).length,
      custom: all.filter(t => !t.isBuiltIn).length,
      categories: this.getCategories(),
      tags: this.getTags(),
    };
  }
}
