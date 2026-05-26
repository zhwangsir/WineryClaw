/**
 * Model Configuration Module
 * 自定义大模型配置管理 — 持久化存储 + 自动检测 + 多模型端点支持
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface ModelEndpoint {
  name: string;
  baseUrl: string;
  modelId: string;
  apiKey?: string;
  priority?: number;
  timeout?: number;
}

export interface ModelConfig {
  baseUrl: string;
  modelId: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  endpoints?: ModelEndpoint[];
  updatedAt: string;
}

const DEFAULT_ENDPOINTS: ModelEndpoint[] = [
  {
    name: "lm-studio",
    baseUrl: "http://localhost:1234/v1",
    modelId: "minimax/minimax-m2.7",
    priority: 10,
    timeout: 120,
  },
  {
    name: "exo-cluster",
    baseUrl: "http://localhost:52415",
    modelId: "default",
    priority: 5,
    timeout: 120,
  },
  // Cloud providers — add your API keys in Settings
  {
    name: "openai",
    baseUrl: "https://api.openai.com/v1",
    modelId: "gpt-4o",
    apiKey: process.env.OPENAI_API_KEY || "",
    priority: 8,
    timeout: 60,
  },
  {
    name: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    modelId: "claude-sonnet-4-20250514",
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    priority: 8,
    timeout: 60,
  },
  {
    name: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    modelId: "deepseek-chat",
    apiKey: process.env.DEEPSEEK_API_KEY || "",
    priority: 7,
    timeout: 60,
  },
  {
    name: "google-gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    modelId: "gemini-1.5-pro",
    apiKey: process.env.GOOGLE_API_KEY || "",
    priority: 7,
    timeout: 60,
  },
];

const DEFAULT_CONFIG: ModelConfig = {
  baseUrl: "http://localhost:1234/v1",
  modelId: "minimax/minimax-m2.7",
  temperature: 0.7,
  maxTokens: 4096,
  endpoints: DEFAULT_ENDPOINTS,
  updatedAt: new Date().toISOString(),
};

const CONFIG_DIR = join(homedir(), ".webrain");
const CONFIG_PATH = join(CONFIG_DIR, "model-config.json");

export class ModelConfigManager {
  private config: ModelConfig;

  constructor() {
    this.config = this.load();
  }

  private load(): ModelConfig {
    try {
      if (existsSync(CONFIG_PATH)) {
        const raw = readFileSync(CONFIG_PATH, "utf-8");
        const parsed = JSON.parse(raw) as Partial<ModelConfig>;
        const merged = { ...DEFAULT_CONFIG, ...parsed, updatedAt: parsed.updatedAt || new Date().toISOString() };
        // Ensure endpoints are always present
        if (!merged.endpoints || merged.endpoints.length === 0) {
          merged.endpoints = [
            {
              name: "primary",
              baseUrl: merged.baseUrl || DEFAULT_CONFIG.baseUrl,
              modelId: merged.modelId || DEFAULT_CONFIG.modelId,
              apiKey: merged.apiKey,
              priority: 10,
              timeout: 120,
            },
          ];
        }
        return merged;
      }
    } catch (err) { console.error("[model-config] Error:", err);
      console.error("[model-config] Failed to load config:", err);
    }
    return { ...DEFAULT_CONFIG };
  }

  save(config: Partial<ModelConfig>): ModelConfig {
    this.config = {
      ...this.config,
      ...config,
      updatedAt: new Date().toISOString(),
    };
    // Ensure endpoints are always present
    if (!this.config.endpoints || this.config.endpoints.length === 0) {
      this.config.endpoints = [
        {
          name: "primary",
          baseUrl: this.config.baseUrl || DEFAULT_CONFIG.baseUrl,
          modelId: this.config.modelId || DEFAULT_CONFIG.modelId,
          apiKey: this.config.apiKey,
          priority: 10,
          timeout: 120,
        },
      ];
    }
    try {
      if (!existsSync(CONFIG_DIR)) {
        mkdirSync(CONFIG_DIR, { recursive: true });
      }
      writeFileSync(CONFIG_PATH, JSON.stringify(this.config, null, 2), "utf-8");
    } catch (err) { console.error("[model-config] Error:", err);
      console.error("[model-config] Failed to save config:", err);
      throw err;
    }
    return this.config;
  }

  get(): ModelConfig {
    return { ...this.config };
  }

  getDefault(): ModelConfig {
    return { ...DEFAULT_CONFIG };
  }

  reset(): ModelConfig {
    this.config = { ...DEFAULT_CONFIG, updatedAt: new Date().toISOString() };
    this.save(this.config);
    return this.config;
  }

  /** 自动检测当前配置有效性 */
  async detect(): Promise<{ ok: boolean; message: string; details?: any }> {
    const endpoints = this.config.endpoints || [
      { name: "primary", baseUrl: this.config.baseUrl, modelId: this.config.modelId },
    ];

    const results = [];
    for (const ep of endpoints) {
      const url = ep.baseUrl.replace(/\/$/, "");
      let epResult: any = { name: ep.name, baseUrl: ep.baseUrl, modelId: ep.modelId, ok: false };

      // Strategy 1: try /models (OpenAI-compatible)
      try {
        const axios = (await import("axios")).default;
        const resp = await axios.get(`${url}/models`, { timeout: 10000 });
        const models = resp.data?.data || [];
        const found = models.find((m: any) => m.id === ep.modelId);
        epResult = {
          ...epResult,
          ok: true,
          message: found
            ? `Model ${ep.modelId} ready`
            : `Service OK, model ${ep.modelId} not found`,
          availableModels: models.map((m: any) => m.id).slice(0, 10),
          targetFound: !!found,
        };
      } catch (err1: any) {
        // Strategy 2: try completion probe
        try {
          const axios = (await import("axios")).default;
          await axios.post(
            `${url}/chat/completions`,
            { model: ep.modelId, messages: [{ role: "user", content: "Hi" }], max_tokens: 5 },
            { timeout: 15000 }
          );
          epResult = { ...epResult, ok: true, message: "Model responsive (completion probe)" };
        } catch (err2: any) {
          const msg = err2.response?.data?.error?.message || err2.message || String(err2);
          epResult = { ...epResult, ok: false, message: msg };
        }
      }
      results.push(epResult);
    }

    const healthyCount = results.filter((r) => r.ok).length;
    return {
      ok: healthyCount > 0,
      message: `${healthyCount}/${results.length} endpoints healthy`,
      details: { endpoints: results },
    };
  }
}
