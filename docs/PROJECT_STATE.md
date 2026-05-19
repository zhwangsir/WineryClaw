# WeBrain 项目状态文档

> **用途**：新开 AI 对话时，让 AI 读这一份文件即可同步项目完整状态。
> **维护约定**：每完成一个开发轮次（Round），更新「开发进度」「测试状态」「下一步」三节。
> **最后更新**：2026-05-19（M2 完成 — Planner 任务原子拆解,chat 复杂请求时自动出「N 步任务清单」+ 前端折叠面板）

---

## 0. 给新会话 AI 的第一句话

你正在接手 **WeBrain** —— 一个双脑架构的本地 AI 集成平台。先读完本文件，再读 `/Users/wangzhenyu/Documents/Project/WeBrain/CLAUDE.md`（操作规则），然后跑一次 `git status` + 测试套件确认工作树状态，再开始干活。

---

## 1. 项目身份与目录结构

**伞形目录** `/Users/wangzhenyu/Documents/Project/WeBrain/` 含三个项目：

| 目录 | 角色 | 可写性 |
|---|---|---|
| `webrain-integration/` | **唯一活跃开发项目** | ✅ 可写 |
| `hermes-agent-main/` | Hermes Agent 上游 vendored 参考 | ❌ 只读，仅供借鉴 |
| `openclaw-main/` | OpenClaw 上游 vendored 参考 | ❌ 只读，**硬规则**：禁止在此跑 coding agent / branch checkout / COI review |

「这个项目」「the project」一律指 `webrain-integration/`。

### 三层架构

```
Frontend (Vite + React, :8587)
    │  HTTP / WS / SSE，经 vite proxy
    ▼
Sub Brain (Fastify + TS, :3000)          ← 执行层：工具/插件/通道/浏览器/沙箱/MCP/CLI/SkillHub
    │  Axios over UDS（默认）或 TCP fallback
    ▼
Main Brain (FastAPI + Python, UDS /tmp/webrain-main.sock 或 TCP :18790)  ← 推理层：记忆/推理/进化/KG/Wiki/Cron
```

**易错点**：
- Sub Brain 是**执行层**不是代理层；Main Brain 只做推理/记忆/KG/Wiki/进化。
- 前端永不直连 Main Brain。Sub Brain 暴露 `/brain/*` 透传代理到 Main Brain。
- Sub Brain 端口固定 **3000**；旧文档里的 `9797` 一律视为过期。
- Main↔Sub 协议刻意无鉴权、CORS 全开（`protocol/protocol.md`），未经要求不要加。

---

## 2. 硬性约束（必须遵守）

| 约束 | 内容 |
|---|---|
| **范围** | 只动 `webrain-integration/`。`hermes-agent-main/`、`openclaw-main/` 只读。 |
| **安全** | 用户明确要求**排除所有安全加固类工作**（鉴权、CORS、沙箱、SSRF、权限校验等）。这是个人本地部署场景。除非用户主动提，不做安全相关改动。 |
| **自主模式** | 用户授权「过程中无需询问，自行决定操作，结束后汇报」。不要逐步征求许可，但每轮结束给清晰汇报。 |
| **语言** | 默认中文回复。代码/命令/路径/日志保留原文。文档与注释以 zh-CN 为主。 |
| **Gateguard 钩子** | 环境里有一个 fact-forcing 钩子，会拦截每个首次 Bash / Edit / Write，要求先陈述「事实」（调用者/重复性/数据文件/用户指令原文）再重试。这是环境摩擦，正常应对即可——陈述事实后重试同一操作即放行。 |

---

## 3. 开发哲学（用户定调的四大支柱）

1. **极致强大功能** —— 核心功能完备、性能优异。
2. **美观友好界面** —— 视觉体验 + 交互流畅。
3. **丰富生态系统** —— 插件扩展、第三方集成、社区资源共享。
4. **整洁规范结构** —— 代码组织合理、模块化、易维护易扩展。

附加：不畏惧工作量增加，持续优化开发流程与技术架构。

---

## 4. 用户想要的「双脑分工」最终形态

- **主脑（对标 Hermes）**：全局深度推理、任务原子化拆解、长程记忆管控、执行路径规划、结果校验反思、经验沉淀进化。
- **副脑（对标 OpenClaw）**：执行主脑下发的指令，调用全部工具能力（浏览器/沙箱/系统命令/文件/网络），重试直至完成。
- 还要 **Hermes 式自我学习进化** + **OpenClaw 式生态**（类 ClawHub/SkillHub 安装 skill 直接用）。

**工程立场（已与用户达成）**：用户原话要求「无限重试 / 零校验 / 零拒绝 / 零警告」，已说服改为工程上更稳的形态——
- 有界重试（5 次 + 每次换策略，而非无限循环）
- 参数 schema 校验失败 → 结构化反馈给主脑自我修正（不是阻塞，是让 agent 更聪明）
- 高危动作用「用户预先声明的 allowlist」驱动确认（清单默认空 ≈ 零拒绝）
- 风险写入 ledger 日志而非弹窗打断

---

## 5. 8 阶段总路线图

```
Phase 1 (16h) RAG 基座            — Qdrant + retriever + 文件监听索引       ⏳ 未开始
Phase 2 (24h) 本地 LLM + Planner  — vLLM/Ollama 适配 + 任务原子拆解         ⏳ 未开始
Phase 3 (24h) Verify-Retry-Reflect — 5 次重试 + 策略多样化 + 经验沉淀       ⏳ 未开始
Phase 4 (16h) UX + Ledger         — 进度面板 + 高危 allowlist + replay     ⏳ 未开始
Phase 5 (20h) Skill 自我改进      — 使用统计→反思→fork 升级               ✅ 已完成 (Round A/C/E)
Phase 6 (16h) 自动 Skill 创建     — 新任务成功→打包 draft→用户收录          🟡 底层就绪，缺 Planner 触发
Phase 7 (12h) Honcho 用户建模     — 后台聚合对话→user profile             ⏳ 未开始
Phase 8 (16h) SkillHub 客户端     — 多源 registry + install/list/update   ✅ 已完成 (Round B/D)
```

LLM 端点（用户提供）：`http://43.119.32.180:1234/v1`，模型 `unsloth/qwen3.5-397b-a17b`，LM Studio 跑在用户另一台设备。
配置方式：环境变量 `WEBRAIN_LLM_BASE_URL` / `WEBRAIN_LLM_MODEL`，或 sub-brain 配置 UI。

---

## 6. 本会话已完成的开发（按时间序）

### 6.1 功能性 Bug 修复 + 死代码清理
- **KG 删除路由**：main_brain.py 加 `DELETE /kg/entities/{eid}` + `/kg/relations/{rid}`（前端原本 404）；删掉永远失败的 `/knowledge/entity/{id}` 旧路由（用了从未初始化的 `_state["knowledge_graph"]`）+ sub-brain 里平行的死路由。
- **Docker 链路**：frontend Dockerfile 端口 8587、sub-brain `EXPOSE 3000`、docker-compose 加 `VITE_PROXY_TARGET`、vite.config.ts 加 preview proxy。
- **Cron PID 锁**：cron_engine.py 单实例守护，防崩溃恢复后重复执行。
- **Plugin hook 全链路打通**：hooks.ts 加 `unregister`；plugin-loader.ts 在 6 个生命周期点 register/unregister；**关键**——tool-executor.ts 真正调用 `runPreToolCall`/`runPostToolCall`（之前是"注册了但没人触发"的死链）。
- 删 `frontend/src/store/`（空目录）、`tests/fixtures/fake-mcp-server.cjs`（无引用）。
- 归档 `PLAN.md`、`AUDIT_REPORT.md`、`frontend/UI_OPTIMIZATION_PLAN.md` → `docs/archive/`。
- CI 加 sub-brain vitest 步骤；agent-manager.test.ts 修测试清理（stale `agent-*` 目录）；requirements.txt 补 `psutil`。
- 修复 `ffmpeg.json` / `pdf.json` 两个 builtin skill —— `code` 字段内嵌双引号未转义导致 JSON 解析失败。

### 6.2 Skill 自学习 + 生态系统（Round A–E，主线工作）

| Round | 文件 | 内容 |
|---|---|---|
| **A** | `sub-brain/src/skills/skill-manager.ts`（重写） | Skill 接口扩展：`FailureMode` / `AutoImproveConfig` / `SkillSource` / telemetry；新增 `getCandidatesForImprovement` / `createImprovedFork`（不可变 fork 到 `improved/<id>/v<N>/`）/ `createDraft` / `listDrafts` / `promoteDraft`；`invokeSkill` 失败时做故障模式聚类 |
| **B** | `sub-brain/src/skills/skill-hub-types.ts`（新）<br>`sub-brain/src/skills/skill-hub-client.ts`（新） | `SkillHubClient`：`file://` + `https://` transport、registry 增删、refresh/search/find、install/uninstall/listInstalled；`SkillManager._loadInstalledHubSkills()` 启动时加载 `installed/` |
| **C** | `sub-brain/main-brain/evolution/skill_reflector.py`（新） | `SkillReflector.reflect_on_skill(skill)` —— 输入 skill + failureModes，输出 `Reflection(improved_code, reason)` 或 None；LLM 调用 DI 注入；响应解析鲁棒（fenced JSON / 带散文 / no-op 保护） |
| **D** | `sub-brain/src/server/skillhub-routes.ts`（新） | 抽出 **12 个 `/api/skillhub/*` 路由**（marketplace/registries/candidates/improve/drafts）+ `adaptHubItem` 适配器；main.ts 改为一行 `registerSkillhubRoutes(...)`；删 3 个调用不存在的 Python CLI 的死路由 |
| **E** | `sub-brain/main-brain/evolution/llm_client.py`（新）<br>`sub-brain/main-brain/evolution/skill_improvement_cycle.py`（新） | `make_llm_call_from_config()` —— OpenAI 兼容 chat-completions 工厂；`SkillImprovementCycle.run_once()` —— GET candidates → Reflector → POST improve；main_brain.py 接入：lifespan 实例化 + 后台调度任务（默认每 1h）+ `POST /evolution/skill-cycle/run` 手动触发端点 |

### 6.3 main.ts 路由提取(Round F–J,结构整洁支柱)

会话开始时 sub-brain `main.ts` 1155 行 / 149 个路由,全堆在一个文件里。按 `skillhub-routes.ts` 既有模板批量抽到 `server/*-routes.ts`,每个 module 配独立测试。

| Round | 抽出模块 | 路由 | 新增测试 |
|---|---|---:|---:|
| **F** | identity / ecosystem / proposals / tools / browser | 28 | 44 |
| **G** | uploads / skills / templates + 删 3 个死路由(memory/chat-stream/metrics-query) | 19 | 32 |
| **H** | workflows(含 workflow-runs) / plugins / sandbox(Docker+agent policy 合并) | 29 | 40 |
| **I** | channels / config(双 manager + axios reload 注入) / **agents(全 31 路由,1 个 module 分 5 节)** | 55 | 53 |
| **J** | ws (WebSocketHub 类封装 + 共享给 channelManager broadcast) | 1 | 8 |

**累计成果(F→J):**
```
main.ts          1155 → 327 行    (-828, -71.7%)
路由总数          149  → 1 inline (/hooks/registry, 3 行常量, 不值得抽)
server/ 模块数    ~10  → 25       (+15: a2a/agents/auth/browser/channels/cli/config/dokobot/
                                    ecosystem/health/identity/mcp/metrics/plugins/proposals/
                                    proxy/sandbox/skillhub/skills/static/templates/tools/
                                    uploads/workflows/ws + 静态/proxy/auth)
新增测试            ~71 → 353 pass (+282 new,  全绿)
```

**工程模板已稳定**(可在新会话直接套用):
```ts
// server/<name>-routes.ts
export interface <Name>RouteDeps { /* minimal deps */ }
export function register<Name>Routes(app: FastifyInstance, deps: <Name>RouteDeps): void {
  app.<method>("/<prefix>/...", async (req) => { ... });
}

// main.ts 一行:
register<Name>Routes(app, { <dep>: state.<dep> });
```

**关键设计原则(踩过的坑都在这里):**
- **Literal path 优先于 :param 路由**——`/agents/messages` 必须早于 `/agents/:id` 注册,否则被吞
- **保留 manager 默认值的语义**——body 字段 omit 时传 `undefined` 而非 `""`/`[]`,让 manager 的默认值生效
- **死路由先验证再删**——3 个 `axios.delete(MAIN_BRAIN_URL/...)` 平行代理路由(memory/chat-stream/metrics-query)前端确认不用,删
- **JSDoc 注释里出现 `*/` 会提前关闭注释块**——`*/plugins/*` 这种要重新措辞
- **路径共享前缀的不同关注点合并**——`/sandbox/*` 涵盖 Docker 执行 + agent policy 两组,合 1 个 module 比拆 2 个更利 reader

### 6.4 前端 SkillhubPage 4-tab UI(Round K,前后端打通)

之前后端 12 个 `/api/skillhub/*` endpoint 都就绪了,但前端 `SkillhubPage.tsx` 只展示了单 tab 的 marketplace 列表。本轮把它扩成 **4 个 tab + 3 个 modal**,接通自学习闭环的全部可视化:

**前端文件改动:**
- `frontend/src/api/skillhub.ts` — 从 3 个方法扩到 **13 个** + 完整的 TypeScript 类型(`Skill`/`SkillRegistry`/`ImprovementCandidate`/`FailureMode`/`InstallResult` 等)
- `frontend/src/stores/skillhubStore.ts` — 从 3 个 action 扩到 **13 个**,新增 `installed` / `registries` / `candidates` / `drafts` 四个 state slot
- `frontend/src/pages/SkillhubPage.tsx` — 重写,4 tab + 3 modal(AddRegistry / Improve / DraftPreview)

**4 个 Tab:**
| Tab | 功能 |
|---|---|
| **Marketplace** | 搜索/安装 + 顶部 RegistriesPanel(添加/移除 registry + 一键刷新) |
| **Installed** | 已装 skill 列表(name/id/版本/registry 来源/使用次数 + 成功率进度条/卸载) |
| **Improvements** | 自学习候选(失败次数 + 主要故障 signature + reason + 「手动改进」按钮,弹出代码编辑 modal) |
| **Drafts** | Agent 自动捕获的草稿(预览/晋升,带 Popconfirm) |

**Tab 切换触发对应 fetch**——按需懒加载,首次打开 Marketplace 时只调 `fetchSkills + fetchRegistries`,切到其他 tab 才调对应 endpoint。

### 6.5 M1 — RAG 接入 chat（本轮）

把 §6 之前几轮上的 RAG 检索器和 chat 引擎拼起来，让 `/chat` 接口在调 LLM 之前自动召回相关文档块、塞进系统提示、并把命中清单回写到响应里给前端展示。

**后端改动：**

- `sub-brain/main-brain/chat/chat_engine.py`
  - `ChatEngine.__init__` 新增 `rag_retriever: Any = None` 参数 + 环境变量 `WEBRAIN_RAG_TOP_K`(默认 3) / `WEBRAIN_RAG_MIN_SCORE`(默认 0.0)
  - 新方法 `_retrieve_rag_context(user_input) -> (text, sources)` —— 失败开放(retriever 异常/未配置/空 query/空索引/全部低于阈值均返回 `"", []`),不抛
  - `_build_system_prompt` 接受 `rag_text` 参数；自动检测模板里没有 `{{rag_context}}` 占位时追加 `## Document Context` 段；fallback 模板里也已加上槽位
  - `chat()` 返回字典新增 `rag_sources: List[{doc_path, chunk_idx, score}]`
  - `chat_stream()` 在首个 `content` chunk 之前 yield `{"type": "rag_sources", "data": [...]}` 事件,前端可立即渲染徽章
- `sub-brain/main-brain/main_brain.py` lifespan：实例化 ChatEngine 时把 `rag_retriever=_state["rag"]` 传进去,完成「定义/启动/使用」的闭环

**前端改动：**

- `frontend/src/api/types.ts` 新增 `RagSource` 接口；`ChatMessage` 加 `ragSources?: RagSource[]`
- `frontend/src/api/chat.ts` `send()` 返回值多带 `ragSources`
- `frontend/src/stores/chatStore.ts` 两条路径都接：非流式直接回填 `assistantMsg.ragSources`；流式收到 `rag_sources` 事件实时 patch 到最后一条 assistant message
- `frontend/src/components/chat/MessageBubble.tsx` 在 tool-call 区上方加一个蓝色 `参考 N 篇文档` 徽章,Tooltip 列出每条 `<filename> #chunk · score`

**测试改动：**

- `sub-brain/main-brain/tests/test_chat_engine.py` 新增 `TestChatEngineRAG`(9 用例)：
  - retriever=None 返回空 / 空 query 返回空且不打 retriever / `min_score` 过滤生效 / 块格式包含 filename+chunk+score / retriever 异常时 fail-open / `WEBRAIN_RAG_TOP_K` env 透传 / `chat()` 把 sources 串进返回值 / `chat_stream()` 在 content 之前发 `rag_sources` 事件 / 没有命中时不发 event
- `frontend/src/components/chat/MessageBubble.test.tsx` 新增 2 用例：`ragSources` 存在时渲染徽章 / 缺省时不渲染

**运行验收：**

```
main-brain  python3 -m pytest tests/test_chat_engine.py -x   → 13 pass (4 原 + 9 新)
frontend    pnpm exec tsc --noEmit                           → 0 errors
frontend    pnpm exec vitest MessageBubble                   → 10 pass (8 原 + 2 新)
```

**故意未做的事(范围控制):**

- 没改 `chat()` 非流式 reply 里的 inline 引用渲染——徽章 + Tooltip 已经能告诉用户"这次回答参考了哪些文档",再做内联 `[1][2]` 引用是 M1 之外的体验加料
- 没做"prompt 里给文档块编号→让 LLM 写引用脚注"——这需要改提示模板和后处理,留给下一个迭代
- 没改 system_prompt 默认模板让所有 agent 都包含 `{{rag_context}}`——已经有「不显含 slot 就追加」的兜底逻辑,显式改 agent 模板会牵动 agent fixture / 已存在的 agent 配置

### 6.6 M2 — Planner 任务原子拆解（本轮）

把用户复杂请求拆成结构化的 N 步原子任务,在调用 LLM 之前就告诉用户「我准备这样分步做」。这是 hermes-style 任务规划的第一阶段(只 plan,不执行,执行/校验/重试是 M3+)。

**新增模块 `sub-brain/main-brain/planner/`**:

- `planner.py`(311 行):
  - `PlanTask`/`Plan` dataclass(`@dataclass(frozen=True)`)
  - `Planner` 类:
    - `is_complex(text) -> bool` 廉价启发式:`MIN_COMPLEX_LEN=30` + `LONG_REQUEST_LEN=120`,zh/en 多步标记词正则(`然后/接着/先...再/step by step/first.../then...`),两个以上问号也算
    - `plan(text) -> Optional[Plan]` LLM 调用,**失败开放**——LLM 异常 / 非 JSON / tasks 全为空 都返回 None,chat 流水不受影响
    - `_resolve_endpoint()` 兼容 `endpoints[]` 多端点配置(按 priority 选)和单端点扁平配置
    - `MAX_TASKS_PER_PLAN=8` 截断,空 description 过滤,confidence clamp 到 [0,1]
- `__init__.py` 对外只暴露 `Planner` / `Plan` / `PlanTask`

**ChatEngine 接入(`chat_engine.py`)**:

- `__init__` 新增 `planner` 参数 + `WEBRAIN_PLANNER_ENABLED` 环境开关(默认开)
- 新方法 `_make_plan(user_input)` —— 包一层异常隔离,返回 dict 或 None
- 静态方法 `_format_plan_for_prompt(plan_dict)` —— 渲染成「`## Plan` markdown 块」塞进系统提示
- `_build_system_prompt` 新增 `plan_block` 参数,模板没有 `{{plan}}` 槽位时自动追加
- `chat()` 返回值新增 `plan` 字段(同时 max-iterations 兜底路径也带上)
- `chat_stream()` 在 RAG 事件之后、第一个 content chunk 之前 yield `{"type": "plan", "data": plan_dict}`

**main_brain.py lifespan**:实例化 `Planner(llm_config=llm_config)`,作为 `_state["planner"]` 传进 ChatEngine 完成「定义/启动/使用」闭环。

**前端改动**:

- `api/types.ts` 新增 `PlanTask` + `ChatPlan` 接口;`ChatMessage.plan?: ChatPlan`
- `api/chat.ts` send 返回值多带 `plan: r.plan ?? undefined`
- `stores/chatStore.ts` 两条路径都接:非流式直接回填 `assistantMsg.plan`;流式收到 `type: "plan"` 事件实时 patch 到最后一条 assistant message
- `components/chat/MessageBubble.tsx` 在 reasoning 块上方加绿色折叠面板「📋 规划 N 步任务 · 置信度 X%」,展开后是有序列表 + 工具提示词 + reasoning 一句话(用 `<ol>` 渲染,task 上挂工具 hint 单色 monospace tag)

**测试**:

- `tests/test_planner.py`(20 用例,新增): 8 个 is_complex 启发式(空/短/长/各类标记/多问号/marker-but-too-short)+ 6 个 happy path(JSON 解析/fenced block/cap-at-8/skip-empty-desc/confidence-clamp)+ 4 个 fail-open(LLM 异常/非 JSON/缺 tasks/全部 invalid)+ 2 个 endpoint resolution
- `tests/test_chat_engine.py` 新增 `TestChatEnginePlanner`(9 用例):env 关 / planner=None / planner 异常 fail-open / 返回 dict / format markdown 块 / 空 plan 不渲染 / `chat()` 串到响应 / `chat_stream` 在 content 之前发 plan 事件 / 无 plan 时不发事件
- `frontend/src/components/chat/MessageBubble.test.tsx` 新增 3 用例:plan 完整渲染(任务/置信度/工具 hint/reasoning)/ 缺省 plan 不渲染 / 点击切换折叠

**运行验收**:

```
main-brain  pytest test_planner.py + test_chat_engine.py  → 42 pass(20 planner + 22 chat)
main-brain  pytest tests/ (除 watchdog dep 缺失的 watcher) → 135 pass
frontend    tsc --noEmit                                  → 0 errors
frontend    vitest run                                    → 116 files / 1179 pass / 0 fail
```

**故意未做(M2 范围控制,留给 M3+)**:

- ❌ 执行 plan 里的每一步并把进度回写给前端(M3 — verify & retry 循环)
- ❌ 失败 task 自动换策略重试(M3)
- ❌ 把 plan 当 cron / workflow 的输入做 multi-agent 编排(M4+)
- ❌ plan 历史持久化 / 用户编辑 plan / 拖拽重排(超 M-roadmap 范围)

### 6.7 自学习闭环的物理路径（已全线打通）

```
main-brain 后台任务 _skill_evolution_scheduler（每 1h）
  → SkillImprovementCycle.run_once()
    → GET sub-brain /api/skillhub/candidates        （拉达到阈值的 skill）
    → 逐个 SkillReflector.reflect_on_skill()
      → make_llm_call_from_config()(...)            （POST LM Studio /v1/chat/completions）
      ← improved_code + reason
    → POST sub-brain /api/skillhub/improve
      → SkillManager.createImprovedFork()           （写 ~/.webrain/skills/improved/<id>/v<N>/）
      → 下次 sub-brain 启动自动覆盖原版
```

---

## 7. 当前测试状态（Round K 结束时验证 / 2026-05-19）

```
sub-brain  pnpm exec tsc --noEmit       → 0 errors
sub-brain  pnpm exec vitest run         → 32 files / 353 pass / 2 skip / 0 fail
frontend   pnpm exec tsc --noEmit       → 0 errors
frontend   pnpm exec vitest run         → 116 files / 1174 pass / 0 fail
main-brain python -m pytest tests/      → 75 pass / 0 fail（自 Round E 起未变）
```

会话累计新增测试(F+G+H+I+J):
- Sub-brain TS：plugin-hook-wiring(4)、proxy(7)、auth(10)、tool-executor-hooks(6)、skill-manager-selfimprove(14)、skill-hub-client(14)、skillhub-routes(18)
- Main-brain Python：test_skill_reflector(10)、test_skill_improvement_cycle(12)

---

## 8. 进行中 / 被打断的任务

**无打断中的任务**——上一轮(Round F–J)主线是 main.ts 路由提取,已 100% 完成:

- `sub-brain/src/main.ts` 当前 **327 行**(从 1155 减到 327,-71.7%)。
- 唯一剩下的 inline 路由 `/hooks/registry` 是 3 行常量数组,刻意保留(过度抽取会降低可读性)。
- `server/` 下 25 个 routes 模块,全部对齐 `register*Routes(app, deps)` 模板。
- 每个模块配独立测试,**32 个测试文件 / 353 pass / 0 fail**。

下一会话开始时直接进 §9 列的优先任务即可。

---

## 9. 下一步（按实用优先级）

| 优先 | 任务 | 说明 |
|---|---|---|
| 🔥 | **M3 Planner Verify+Retry** | 把 M2 的 plan 真正跑起来:逐 task 执行 → 验证产出 → 失败最多重试 5 次,第 3 次后换策略(LLM 调用变长 prompt / 换工具)。 |
| 🔥 | 默认 registry 种子 | 给本地默认 registry 配 1–2 个示范 skill,首次打开 marketplace 不空。 |
| ✅ | ~~M2 Planner 任务拆解~~ | 完成于 2026-05-19(§6.6)。 |
| ✅ | ~~M1 RAG 接入 chat~~ | 完成于 2026-05-19(§6.5)。 |
| ✅ | ~~Phase 1 RAG 基座~~ | retriever + watcher + 8 endpoints + 前端 4 区页面已上线(L1–L4)。 |
| 📦 | Phase 6 自动 skill 创建 | 依赖 Phase 2 Planner 提供「新任务」触发信号。 |
| 📦 | Phase 7 Honcho 用户建模 | 后台进程聚合对话历史 → `user/profile.md`。 |
| 🟢 | main.ts 进一步切 bootstrap/lifecycle 模块 | 可选,327 行的入口文件已经合理。若要继续按"清洁结构"打,可拆 `bootstrap.ts`(state 实例化) + `lifecycle.ts`(main-brain 起停),但 ROI 一般。 |

---

## 10. 关键文件地图

### Sub Brain (TS)
```
sub-brain/src/
├── main.ts                          单一引导文件（待瘦身，见 §8）
├── server/
│   ├── auth.ts / proxy.ts / static.ts / metrics.ts
│   └── skillhub-routes.ts           ★ 12 个 /api/skillhub/* 路由
├── skills/
│   ├── skill-manager.ts             ★ 自学习核心（telemetry/fork/draft）
│   ├── skill-hub-types.ts           ★ registry/index/install 类型
│   ├── skill-hub-client.ts          ★ marketplace 客户端
│   └── builtins/*.json              10 个内置 skill
├── tools/tool-executor.ts           ★ 已接入 plugin pre/post tool hooks
├── plugin-sdk/hooks.ts              hookRegistry（register/unregister）
└── plugins/plugin-loader.ts         插件生命周期 + hook 注册
```

### Main Brain (Python)
```
sub-brain/main-brain/
├── main_brain.py                    FastAPI app；§6 接入了 skill-cycle 调度
├── evolution/
│   ├── evolution_engine.py          既有进化引擎
│   ├── skill_reflector.py           ★ LLM 反思器
│   ├── skill_improvement_cycle.py   ★ 自学习编排器
│   └── llm_client.py                ★ OpenAI 兼容 LLM 调用工厂
├── reasoning/ memory/ cron/ chat/ decision/ wiki/ canvas/  各推理子系统
└── tests/                           pytest，CI python-check job 跑
```

### Frontend (React)
```
frontend/src/
├── api/                             每个 HTTP 调用的封装；skillhub.ts 已存在
├── pages/SkillhubPage.tsx           待升级 4-tab
├── stores/                          Zustand（store/ 单数空目录已删）
└── components/chat/                 ChatPage 已拆分的子组件
```

### 数据目录（运行时，~/.webrain/）
```
~/.webrain/
├── registries.json                  SkillHub registry 配置
├── skills/
│   ├── skills.json                  runtime active skills
│   ├── invocations.json             调用日志（末 1000 条）
│   ├── installed/<id>/skill.json    hub 安装的
│   ├── improved/<id>/v<N>/          自学习 fork（运行时覆盖原版）
│   └── drafts/<id>/                 auto-create 草稿（待用户晋升）
├── cron.db / cron.pid               Cron 引擎
└── sub-brain.db                     Sub Brain SQLite（plugins/channels/ecosystem）
```

---

## 11. 如何运行与测试

详细见 `webrain-integration/README.md` §「快速开始」「测试」。要点：

```bash
# 三终端开发
cd sub-brain/main-brain && source venv/bin/activate && python main_brain.py   # 主脑
cd sub-brain && pnpm dev                                                       # 副脑
cd frontend && pnpm dev                                                        # 前端 :8587

# 测试
cd sub-brain && pnpm exec tsc --noEmit && pnpm exec vitest run                 # 副脑
cd sub-brain/main-brain && source venv/bin/activate && python -m pytest tests/ -q --no-cov  # 主脑

# 手动触发自学习一轮
curl -X POST http://localhost:18790/evolution/skill-cycle/run
```

测试基础设施注意：
- `sub-brain/vitest.config.ts` 无特殊 pool 配置；测试用 `vi.mock` 隔离 `node:sqlite` 等。
- main-brain 测试需 venv 里装了 `pytest pytest-asyncio pytest-cov psutil`。
- 涉及 `~/.webrain/` 的测试用合成 id（`skill-test-*` / `test-skill-*` / `skill-draft-*`）+ beforeEach/afterEach 清理，不碰真实数据。

---

## 12. 已知技术债 / 待办

| 项 | 说明 |
|---|---|
| ~~main.ts 仍 1096 行~~ | ✅ Round F–J 完成,现 327 行,98% 路由已模块化。 |
| 5/8 plugin hook 类型未接通 | `pre_llm_call` / `post_llm_call` / `on_session_start` / `on_session_end` / `on_shutdown` —— 这些事件物理上发生在 main-brain Python，sub-brain TS 的 hookRegistry 跨不过进程边界。需要跨进程 RPC 或重新设计 SDK。已工作的：`on_startup` / `pre_tool_call` / `post_tool_call`。 |
| 前端 `: any` 残留 | 早期审计报告 367 处 `: any` + 119 处 `catch (e: any)`。store 已有较全测试，引入中间件需重写大量测试，ROI 倒挂，暂缓。 |
| `channel-manager.ts` 731 行无单测 | 4 个 SDK 通道，需深度 mock。 |
| `docker-sandbox.ts` 无单测 | 需真实 Docker daemon，属集成测试范畴。 |
| 集成测试依赖运行中服务 | `webrain-integration/tests/` 下若干测试需 sub-brain + main-brain 都在线。可用 msw mock 化。 |
| ~~SkillhubPage 旧版单 tab~~ | ✅ Round K 完成,4 tab + 3 modal,API/store/page 全部对齐 13 endpoint。 |

---

## 13. 维护本文档

每完成一个 Round：
1. 更新 §6（已完成开发）追加一行。
2. 更新 §7（测试状态）的数字。
3. 更新 §8（进行中）和 §9（下一步）。
4. 顶部「最后更新」改日期。
5. 新技术债记入 §12。
