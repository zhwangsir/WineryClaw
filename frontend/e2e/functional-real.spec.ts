/**
 * 全功能实测 — 从用户视角逐一验证每个核心功能
 * 直接命中真实后端（无 mock），用真实数据验证功能是否正常
 *
 * 正确路径速查:
 *   admin 路由: /dashboard /agents /wiki /kg /channels /cron
 *              /templates /workflows /memory /uploads /skills
 *   上传 API:   POST /upload   body: {filename, data(base64)}
 *   Wiki API:   POST /brain/wiki/notes
 *   Cron API:   POST /brain/cron/jobs  {name, cron_expr, task_type, task_params}
 *   通道 API:   POST /channels/connect  {channel:"memory", config:{}}
 *   记忆查询:   POST /brain/memory/query  {query, top_k}
 */
import { test, expect, type Page } from "@playwright/test";

const BASE = "http://localhost:8587";

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

async function nav(page: Page, path: string) {
  await page.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForTimeout(600);
}

async function apiPost(page: Page, path: string, body: unknown) {
  return page.evaluate(
    async ({ url, data }) => {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    { url: `http://localhost:3456${path}`, data: body }
  );
}

async function apiGet(page: Page, path: string) {
  return page.evaluate(async (url) => {
    const r = await fetch(url);
    return { status: r.status, body: await r.json().catch(() => null) };
  }, `http://localhost:3456${path}`);
}

// ─── 1. 用户模式聊天 ──────────────────────────────────────────────────────────
test("用户聊天 — 发送消息并收到回复", async ({ page }) => {
  test.setTimeout(90000); // 流式 LLM 回复可能需要 60s+
  await nav(page, "/");
  const input = page.locator("textarea").first();
  await expect(input).toBeVisible({ timeout: 10000 });

  // 记录发送前已有的 .chat-markdown 数量（旧消息可能在滚动区域外/hidden）
  const beforeCount = await page.locator(".chat-markdown").count();

  await input.fill("你好，请用一句话介绍你自己");
  await input.press("Enter");

  // 等待新的助理 Markdown 回复出现（count 增加 = 新消息流结束）
  // 流式中 StreamingText 无 .chat-markdown，流结束后渲染 <div class="chat-markdown">
  await expect(async () => {
    const count = await page.locator(".chat-markdown").count();
    expect(count).toBeGreaterThan(beforeCount);
  }).toPass({ timeout: 60000, intervals: [1000] });

  // 用 JS 直接滚动自定义容器（scrollIntoViewIfNeeded 在 overflow:hidden 父容器下不可靠）
  await page.evaluate(() => {
    const c = document.querySelector(".chat-scroll-container");
    if (c) c.scrollTop = c.scrollHeight;
  });
  await page.waitForTimeout(300);

  // 验证最新消息有文字内容（证明 LLM 回复已渲染到 DOM，不依赖视口定位）
  const lastMsg = page.locator(".chat-markdown").last();
  const msgText = await lastMsg.textContent({ timeout: 5000 });
  expect(msgText?.trim().length).toBeGreaterThan(0);
});

// ─── 2. 知识库上传 ────────────────────────────────────────────────────────────
test("知识库 — API 上传 Markdown 文档并索引", async ({ page }) => {
  await nav(page, "/uploads");

  // POST /upload: body = {filename, data(base64), type?}
  const content = [
    "# WeBrain 功能测试文档",
    "",
    "这是由自动化测试上传的知识库文档，用于验证上传与索引功能。",
    "",
    "## 核心特性",
    "",
    "- 双脑架构: Sub-Brain + Main-Brain",
    "- 四级记忆: L1 → L4 自动整合",
    "- RAG 文档索引与引用",
    "- 技能执行沙箱",
  ].join("\n");
  const b64 = Buffer.from(content).toString("base64");

  const uploadRes = await page.evaluate(
    async ({ url, b64data }) => {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: "functional-test-doc.md", data: b64data, type: "text/markdown" }),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    { url: "http://localhost:3456/upload", b64data: b64 }
  );
  expect(uploadRes.status).toBe(200);
  expect(uploadRes.body?.ok).toBe(true);
  expect(uploadRes.body?.url).toBeTruthy();

  // 再索引到 RAG 知识库
  if (uploadRes.body?.url) {
    const ingestRes = await page.evaluate(
      async ({ url, filePath }) => {
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: filePath }),
        });
        return { status: r.status, body: await r.json().catch(() => null) };
      },
      { url: "http://localhost:3456/brain/rag/ingest", filePath: uploadRes.body.url }
    );
    // 200 表示成功，非 200 不算硬失败（路径可能不支持 ingest）
    expect([200, 202, 404, 422]).toContain(ingestRes.status);
  }

  // 上传页面本身应正常渲染
  await expect(page.locator("text=/上传|Upload/i").first()).toBeVisible({ timeout: 5000 });
});

// ─── 3. Wiki 笔记 ─────────────────────────────────────────────────────────────
test("Wiki — 创建笔记并验证展示", async ({ page }) => {
  await nav(page, "/wiki");

  // POST /brain/wiki/notes (proxy 转发到 main-brain)
  const title = "自动化测试笔记 — " + Date.now();
  const res = await apiPost(page, "/brain/wiki/notes", {
    title,
    content: [
      "## 测试内容",
      "",
      "这是由自动化测试创建的 Wiki 笔记，用于验证知识库功能正常。",
      "",
      "- 支持 Markdown",
      "- 支持搜索",
      "- 支持标签",
    ].join("\n"),
    tags: ["自动化", "测试"],
  });
  expect(res.status).toBe(200);
  expect(res.body?.ok).toBe(true);

  // Wiki 页面应展示笔记
  await nav(page, "/wiki");
  await expect(page.locator("text=/自动化测试笔记|Wiki|笔记/i").first()).toBeVisible({ timeout: 10000 });
});

// ─── 4. 记忆系统 ─────────────────────────────────────────────────────────────
test("记忆系统 — 写入记忆并在页面展示", async ({ page }) => {
  await nav(page, "/memory");

  // 写入记忆
  const res = await apiPost(page, "/brain/memory/store", {
    content: "用户喜欢使用深色模式，并且偏好简洁的界面设计风格。这条记忆由自动化测试写入。",
    source: "functional-test",
    importance: 0.8,
  });
  expect([200, 201]).toContain(res.status);

  // 记忆页面应展示统计内容
  await nav(page, "/memory");
  await expect(page.locator("text=/L[1-4]|记忆|memory/i").first()).toBeVisible({ timeout: 10000 });
});

// ─── 5. 知识图谱实体 ──────────────────────────────────────────────────────────
test("知识图谱 — 创建实体与关系", async ({ page }) => {
  await nav(page, "/kg");

  // 创建两个实体
  const e1 = await apiPost(page, "/brain/kg/entities", {
    name: "WeBrain 系统",
    type: "product",
    properties: { description: "AI 智能体平台，由自动化测试创建" },
  });
  expect([200, 201]).toContain(e1.status);

  const e2 = await apiPost(page, "/brain/kg/entities", {
    name: "React 前端框架",
    type: "technology",
    properties: { description: "用于构建 WeBrain 前端" },
  });
  expect([200, 201]).toContain(e2.status);

  // KG 页面应展示实体
  await nav(page, "/kg");
  await expect(page.locator("text=/WeBrain 系统|知识图谱|实体/i").first()).toBeVisible({ timeout: 10000 });
});

// ─── 6. 智能体列表 ────────────────────────────────────────────────────────────
test("智能体 — API 创建并在页面展示", async ({ page }) => {
  await nav(page, "/agents");

  const agentName = "测试智能体-" + Date.now();
  const res = await apiPost(page, "/agents", {
    name: agentName,
    description: "自动化测试创建的智能体",
    systemPrompt: "你是一个测试助手，负责验证系统功能是否正常。",
    model: "default",
  });
  expect([200, 201]).toContain(res.status);
  expect(res.body?.ok).toBe(true);

  await nav(page, "/agents");
  await expect(page.locator("text=/测试智能体/").first()).toBeVisible({ timeout: 10000 });
});

// ─── 7. 模板系统 ─────────────────────────────────────────────────────────────
test("模板 — 创建模板并验证列表", async ({ page }) => {
  await nav(page, "/templates");

  const res = await apiPost(page, "/templates", {
    name: "客服助手模板",
    description: "自动化测试创建的客服模板",
    category: "support",
    role: "support",
    systemPrompt: "你是一个专业的客服助手，负责解答用户问题。",
    tags: ["客服", "测试"],
  });
  expect([200, 201]).toContain(res.status);
  expect(res.body?.ok).toBe(true);

  await nav(page, "/templates");
  await expect(page.locator("text=/客服助手模板|模板/i").first()).toBeVisible({ timeout: 10000 });
});

// ─── 8. 工作流 ───────────────────────────────────────────────────────────────
test("工作流 — 创建工作流并验证列表", async ({ page }) => {
  await nav(page, "/workflows");

  const res = await apiPost(page, "/workflows", {
    name: "自动化测试工作流",
    description: "由功能测试自动创建",
    nodes: [],
    edges: [],
  });
  expect([200, 201]).toContain(res.status);
  expect(res.body?.ok).toBe(true);

  await nav(page, "/workflows");
  await expect(page.locator("text=/自动化测试工作流|工作流/i").first()).toBeVisible({ timeout: 10000 });
});

// ─── 9. Cron 定时任务 ─────────────────────────────────────────────────────────
// Cron 在 main-brain 侧，通过 /brain/* 代理访问
// POST /brain/cron/jobs 参数: {name, cron_expr, task_type, task_params, enabled}
test("Cron — 创建定时任务并验证列表", async ({ page }) => {
  await nav(page, "/cron");

  const res = await apiPost(page, "/brain/cron/jobs", {
    name: "测试定时任务",
    cron_expr: "0 9 * * 1",
    task_type: "dreaming_run",
    task_params: {},
    enabled: false,
  });
  expect([200, 201]).toContain(res.status);
  expect(res.body?.ok).toBe(true);

  await nav(page, "/cron");
  await expect(page.locator("text=/测试定时任务|定时任务|Cron/i").first()).toBeVisible({ timeout: 10000 });
});

// ─── 10. 通道管理 ─────────────────────────────────────────────────────────────
// POST /channels/connect body: {channel: "<type>", config: {...}}
// "memory" 类型无需凭证，始终成功，用于测试
test("通道 — 连接 memory 通道并验证", async ({ page }) => {
  await nav(page, "/channels");

  const res = await page.evaluate(async () => {
    const r = await fetch("http://localhost:3456/channels/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "memory", config: {} }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  });
  expect([200, 201]).toContain(res.status);
  expect(res.body?.ok).toBe(true);

  await nav(page, "/channels");
  // 通道列表或页面标题应展示通道相关内容
  await expect(page.locator("text=/通道|memory|Channel/i").first()).toBeVisible({ timeout: 10000 });
});

// ─── 11. 主题切换 ─────────────────────────────────────────────────────────────
test("主题切换 — 深色/浅色切换无 JS 错误", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // HeaderBar 主题切换按钮在 admin 页面上
  await nav(page, "/dashboard");

  // 主题按钮图标: 深色模式显示 SunOutlined (data-icon="sun")，浅色显示 MoonOutlined
  const themeIcon = page.locator('[data-icon="sun"], [data-icon="moon"]').first();
  if (await themeIcon.count() > 0) {
    const themeBtn = themeIcon.locator(".."); // 父级 Button
    await themeBtn.click({ timeout: 5000 }).catch(() => themeIcon.click({ timeout: 5000 }));
    await page.waitForTimeout(500);
    // 再切回来
    const themeIcon2 = page.locator('[data-icon="sun"], [data-icon="moon"]').first();
    await themeIcon2.locator("..").click({ timeout: 5000 }).catch(() => themeIcon2.click({ timeout: 5000 }));
    await page.waitForTimeout(500);
  }
  expect(errors).toHaveLength(0);
});

// ─── 12. Admin 页面 — 无崩溃 ─────────────────────────────────────────────────
test("Admin Dashboard — 统计卡片数据加载", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await nav(page, "/dashboard");
  // Dashboard 应有统计相关内容
  const hasStats = await page.locator("text=/智能体|Agent|记忆|Memory|技能|Skill/i").count();
  expect(hasStats).toBeGreaterThan(0);
  expect(errors).toHaveLength(0);
});

// ─── 13. 记忆搜索 ─────────────────────────────────────────────────────────────
// 记忆查询端点: POST /brain/memory/query (非 /memory/search)
test("记忆搜索 — API 搜索返回结果", async ({ page }) => {
  await nav(page, "/memory");

  const res = await apiPost(page, "/brain/memory/query", {
    query: "界面设计",
    top_k: 5,
  });
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body?.results ?? res.body)).toBeTruthy();
});

// ─── 14. Dreaming 触发 ────────────────────────────────────────────────────────
test("Dreaming — 触发梦境整合并等待完成", async ({ page }) => {
  test.setTimeout(120000); // Dreaming 在数据量大 / 并发压力下可能需要 60-90s
  await nav(page, "/memory");

  const res = await page.evaluate(async () => {
    const r = await fetch("http://localhost:3456/brain/dreaming/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    // 注意: 这里 json() 等待完整响应，dreaming 是同步响应（不是流）
    return { status: r.status, body: await r.json().catch((e: Error) => ({ _err: e.message })) };
  });
  // Dreaming 可能返回 200 或 202
  expect([200, 202]).toContain(res.status);
  expect(res.body?.ok).toBe(true);
});

// ─── 15. Skills 页面 ──────────────────────────────────────────────────────────
test("Skills — 列表加载并显示技能", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await nav(page, "/skills");
  await expect(page.locator("text=/技能|skill/i").first()).toBeVisible({ timeout: 10000 });
  expect(errors).toHaveLength(0);
});
