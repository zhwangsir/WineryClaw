# WeBrain — Agent 开发指南

> **阅读对象**：AI 编程助手（Claude、Kimi、Copilot 等）。本文档假设你对本项目一无所知。
>
> **语言约定**：项目内文档与注释以简体中文（zh-CN）为主，请保持统一。

---

## 1. 项目概览

WeBrain 是一个基于**双脑架构**的本地 AI 集成平台：

- **主脑（Main Brain）**：Python/FastAPI，负责深度推理、L1-L4 四级记忆、知识图谱、Wiki、进化引擎、多模型路由。
- **副脑（Sub Brain）**：TypeScript/Fastify，负责工具执行、插件/通道/浏览器/沙箱/MCP/CLI/SkillHub 等全部执行层能力。
- **前端（Frontend）**：React 18 + Vite + Ant Design 5，提供聊天、仪表盘、系统管理等全部 UI。

核心设计哲学：**推理层与执行层物理隔离**。工具执行（文件读写、网络请求、Docker 容器、浏览器自动化）全部发生在副脑，主脑只做 LLM 推理与记忆管理。前端永不直连主脑，所有通信经副脑的 `/brain/*` 代理透传。

---

## 2. 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 18, Vite 5, TypeScript 5（严格模式）, Ant Design 5, Zustand, react-markdown, framer-motion, react-router-dom v6 |
| 副脑 | Node.js 22+, Fastify 4, TypeScript 5, Playwright, Dockerode, ESM, pino 日志, prom-client 指标 |
| 主脑 | Python 3.9+, FastAPI, Uvicorn, SQLite + FTS5, sentence-transformers, torch, transformers, scikit-learn, numpy, networkx |
| 测试 | Vitest（前后端）, jsdom, @testing-library/react, Playwright（前端 E2E）, pytest + pytest-cov + pytest-asyncio（主脑） |
| 部署 | Docker + Docker Compose |
| 包管理 | pnpm（workspace 模式，根目录 + frontend + sub-brain 各自独立 package.json） |

---

## 3. 目录结构与模块划分

```
webrain-integration/
├── frontend/                   # React 前端 (Vite + Ant Design)
│   ├── src/
│   │   ├── pages/             # 页面组件（每页一个 .tsx + .test.tsx）
│   │   ├── components/        # 公共组件（按领域分 chat / common / layout / settings / tools）
│   │   ├── stores/            # Zustand 状态管理（每 store 一个 .ts + .test.ts）
│   │   ├── api/               # Axios API 客户端封装
│   │   ├── hooks/             # React Hooks（如 useTheme）
│   │   ├── utils/             # 工具函数
│   │   ├── i18n/              # i18next 国际化
│   │   └── styles/            # 全局 CSS + 主题 token
│   ├── e2e/                   # Playwright E2E 测试
│   ├── package.json
│   ├── vite.config.ts         # Vite 配置（含 dev proxy 到副脑 :3456）
│   ├── vitest.config.ts       # 前端单元测试配置
│   ├── tsconfig.json          # TS 严格模式，路径别名 `@/*` → `src/*`
│   └── eslint.config.mjs      # ESLint + typescript-eslint + react-hooks + prettier
│
├── sub-brain/                  # 副脑 (Fastify + TypeScript)
│   ├── src/
│   │   ├── server/            # HTTP 路由注册（每个领域一个 *-routes.ts）
│   │   ├── tools/             # 内置工具注册与执行
│   │   ├── channels/          # 消息通道协议（Webhook、Email、IMessage 等）
│   │   ├── agent/             # 智能体管理、工作流引擎、模板引擎、协作
│   │   ├── browser/           # Playwright 浏览器自动化
│   │   ├── sandbox/           # Docker 沙箱执行
│   │   ├── skills/            # SkillHub 技能市场 + 运行时
│   │   ├── mcp/               # MCP 客户端
│   │   ├── cli/               # WeBrain CLI 远程执行
│   │   ├── dokobot/           # Dokobot CDP 浏览器桥接
│   │   ├── plugin-sdk/        # 插件开发 SDK（Hooks、Context、Registry）
│   │   ├── plugins/           # 插件加载器
│   │   ├── config/            # 模型配置 + 分层配置管理
│   │   ├── identity/          # 身份管理
│   │   ├── ecosystem/         # 生态系统 Hub
│   │   ├── db/                # SQLite 本地数据库
│   │   ├── utils/             # 通用工具
│   │   └── types/             # 类型声明
│   ├── main-brain/            # 主脑 Python 服务（嵌入在 sub-brain 目录下）
│   │   ├── chat/              # 对话引擎
│   │   ├── memory/            # 记忆管理（L1-L4 分层、RAG、知识图谱、ActiveMemory）
│   │   ├── reasoning/         # 推理引擎
│   │   ├── evolution/         # 进化引擎 + 技能反射
│   │   ├── decision/          # 决策中心
│   │   ├── planner/           # 任务规划器 + 执行器
│   │   ├── bridge/            # 副脑客户端
│   │   ├── wiki/              # Wiki 笔记引擎
│   │   ├── cron/              # Cron 定时任务引擎
│   │   ├── canvas/            # Canvas 画布引擎
│   │   ├── media/             # 媒体处理
│   │   ├── mcp/               # MCP 服务端
│   │   ├── tools/             # 工具桥接
│   │   ├── cache/             # 缓存管理
│   │   ├── observability/     # 指标与结构化日志
│   │   ├── tests/             # 单元测试
│   │   │   ├── smoke/         # E2E 启动冒烟测试（ spawn 真实子进程）
│   │   │   └── fixtures/      # 测试夹具
│   │   ├── main_brain.py      # 主入口
│   │   ├── requirements.txt   # Python 依赖
│   │   └── pyproject.toml     # pytest + coverage 配置
│   ├── tests/                 # 副脑单元测试
│   ├── package.json
│   ├── tsconfig.json
│   └── vitest.config.ts
│
├── tests/                      # 根目录集成测试（需要 :3456 副脑 + /brain/health 主脑存活）
│   ├── api/                   # API 契约测试
│   ├── integration/           # 跨层集成测试
│   ├── e2e/                   # 端到端测试
│   ├── system/                # 系统级流水线测试
│   ├── unit/                  # 根目录单元测试
│   └── setup.ts               # Vitest 全局 setup（后端健康检查）
│
├── protocol/                   # 主脑↔副脑通信协议文档
├── scripts/                    # 构建与辅助脚本
│   ├── verify-install.sh      # 依赖/venv 检查，加 --smoke 可跑 E2E 冒烟
│   ├── backup-data.sh         # 数据备份
│   └── seed-demo-data.sh      # 演示数据种子
├── docker-compose.yml          # Docker 编排（main-brain / sub-brain / frontend / dokobot）
├── package.json                # 根 package.json（husky + lint-staged + vitest）
├── vitest.config.ts            # 根 Vitest 配置（跑 integration + e2e + umbrella tests）
├── .env.example                # 环境变量模板
└── docs/                       # 项目文档
    ├── PROJECT_STATE.md        # 当前项目状态（每轮开发后更新）
    ├── CONTRIBUTING.md         # 贡献规范（分支命名、提交风格、PR 要求）
    ├── TEST_REPORT.md          # 测试报告
    ├── USER_TRIAL_2026-05-20.md # 用户试用复盘
    └── adr/                    # 架构决策记录
```

---

## 4. 构建与开发命令

### 环境要求
- **Node.js 22+**
- **Python 3.9+**（推荐 3.11）
- **pnpm**
- Docker（可选，用于沙箱功能）

### 一次性安装

```bash
# 主脑 Python venv（副脑启动时会优先使用此 venv 的 Python 解释器）
cd sub-brain/main-brain
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
cd ../..

# 副脑 + 前端依赖
cd sub-brain && pnpm install && cd ..
cd frontend && pnpm install && cd ..

# 快速验证
./scripts/verify-install.sh
```

### 本地开发（三个终端）

```bash
# 终端 1：主脑（默认 UDS /tmp/webrain-main.sock；也可设 WEBRAIN_MAIN_BRAIN_PORT=18790 走 TCP）
cd sub-brain/main-brain && source venv/bin/activate && python main_brain.py

# 终端 2：副脑（:3456，会自动尝试 spawn 主脑；若已手动启动主脑，设 WEBRAIN_NO_MAIN_BRAIN=1）
cd sub-brain && pnpm dev

# 终端 3：前端（Vite HMR :8587，proxy 到 localhost:3456）
cd frontend && pnpm dev
```

访问 `http://localhost:8587`。

### Docker 一键启动

```bash
docker-compose up --build
```

### 构建产物

```bash
# 前端生产构建
cd frontend && pnpm build        # 输出到 frontend/dist/

# 副脑生产构建
cd sub-brain && pnpm build       # tsc 输出到 sub-brain/dist/
```

---

## 5. 测试策略

项目有四层独立测试体系，请根据验证目标选择正确层级：

| 层级 | 位置 | 命令 | 说明 | 耗时 |
|------|------|------|------|------|
| **前端单元** | `frontend/src/**/*.test.{ts,tsx}` | `cd frontend && pnpm vitest run` | jsdom + @testing-library/react。覆盖率阈值：lines 50%, functions 40%, branches 65%, statements 50%。 | <2 min |
| **副脑单元** | `sub-brain/tests/**/*.test.ts` | `cd sub-brain && pnpm test` | Node 环境 Vitest。 | <1 min |
| **主脑单元** | `sub-brain/main-brain/tests/test_*.py` | `cd sub-brain/main-brain && pytest` | 默认排除 `tests/smoke/`。含覆盖率与 HTML 报告。 | <2 min |
| **冒烟测试** | `sub-brain/main-brain/tests/smoke/` | `pytest -m smoke tests/smoke/ -s --no-cov` | spawn 真实主脑+副脑子进程，验证 HTTP 级契约。 | ~6 min |
| **基准测试** | `sub-brain/main-brain/tests/test_*benchmark*.py` | `pytest -m benchmark -s --no-cov` | Recall/MRR/延迟基准，opt-in。 | 2-5 min |
| **集成测试** | `tests/`（根目录） | `pnpm test`（即 `vitest run`） | 需要副脑 `:3456` + `/brain/health` 存活。 | ~2 min |
| **前端 E2E** | `frontend/e2e/*.spec.ts` | `cd frontend && pnpm exec playwright test` | Playwright，全部 hermetic（`page.route()` mock 后端）。 | <30 s |

### 根 `vitest.config.ts` 配置要点
- `pool: "forks"`
- `testTimeout: 60000`
- `setupFiles: ["./tests/setup.ts", "./frontend/src/test-setup.ts"]`

### 测试规范
- **不要**给 CI 命令加 `|| true`，测试必须真实失败。
- 冒烟测试使用 `WEBRAIN_DATA_DIR=<tmp>` 避免污染开发数据库。
- 前端测试 setup（`frontend/src/test-setup.ts`）包含 framer-motion mock、AntD 已知警告过滤、React Router future flag 过滤。

---

## 6. 代码风格与规范

### TypeScript（前后端通用）
- **ESM 全栈**：所有 `.ts` 文件使用 ESM，`type: "module"`。相对导入必须以 `.js` 结尾（`tsconfig` bundler 解析要求）。
- **严格模式开启**：`strict: true`，`noUnusedLocals: true`，`noUnusedParameters: true`。
- 前端路径别名：`@/*` → `src/*`。副脑无路径别名，使用相对导入。
- 未使用参数前缀 `_` 可豁免 ESLint 未使用变量检查。
- 生产代码中**不要**留 `console.log`：副脑用 `pino`（`request.log`），主脑用标准库 `logging`，浏览器代码开发时可用但提交前应清理。

### Python（主脑）
- Python 3.9+，使用类型注解。
- 异步优先：主脑是 asyncio/FastAPI 应用，CPU 密集型 ML 推理必须包在 `loop.run_in_executor(None, ...)` 中。
- 懒加载单例需要 `threading.Lock` 双检锁（参考 `_get_embedder` / `_get_reranker`）。
- `asyncio.create_task` 必须保留 Task 引用（存入 set + `add_done_callback(set.discard)`），否则 CPython GC 可能回收中断。

### ESLint / Prettier（前端）
- 配置：`eslint.config.mjs` 使用 `@eslint/js` + `typescript-eslint` + `eslint-plugin-react-hooks` + `eslint-config-prettier`。
- 规则亮点：
  - `@typescript-eslint/no-explicit-any`: `warn`
  - `@typescript-eslint/no-unused-vars`: `warn`，忽略 `^_` 前缀
  - `no-console`: `warn`，仅允许 `console.warn` / `console.error`
  - `prefer-const`: `warn`
- Husky + lint-staged：提交前自动对 `frontend/src/**/*.{ts,tsx}` 跑 `eslint --fix` + `prettier --write`。

### Git 工作流
- 分支：`main`（稳定）、`develop`（日常开发）。
- PR 目标分支：`main`。
- CI 跑在 `push` 到 `main`/`develop` 以及 `pull_request` 到 `main` 时。
- 提交风格与 Round 标签：见 `docs/CONTRIBUTING.md`。

---

## 7. 关键架构事实（易错点）

### 前后端通信路径
- 前端 **永不直连主脑**。所有主脑接口经副脑 `/brain/*` 代理。
- 副脑默认通过 **Unix Domain Socket** (`/tmp/webrain-main.sock`) 与主脑通信；也可设 `WEBRAIN_MAIN_BRAIN_PORT` 切到 TCP。
- 前端 axios 层调用 `/api/<resource>`，副脑在 `onRequest` hook 中把 `/api/` 前缀 strip 掉（`skillhub` 除外，它原生用 `/api/skillhub`）。

### 副脑 auto-spawn 主脑
- 副脑 `pnpm dev` / `node dist/main.js` 启动时，若 `WEBRAIN_NO_MAIN_BRAIN !== "1"`，会自动 spawn 主脑 Python 子进程。
- 解释器选择优先级：`venv/bin/python3` > `WEBRAIN_PYTHON` 环境变量 > 系统 `python3`（带警告）。
- 手动启动主脑时，务必设 `WEBRAIN_NO_MAIN_BRAIN=1` 避免重复 spawn。

### LLM 配置热重载
- `POST /config/reload` 会让主脑重新从副脑拉取模型配置，然后**必须显式传播**到每个持有 `llm_config` 副本的引擎（chat、reasoning、dreaming、active_memory、kg、planner、SkillReflector）。
- 这是反复出现的 bug 类型：任何在 lifespan boot 时闭包捕获 `llm_config` 的组件，都需要在 reload 路径中被重建。

### FastAPI 参数映射陷阱
- FastAPI 中 `request: Any` 会被映射为 query 参数，不是 body。如需接收任意 JSON body，请用 `request: Dict[str, Any] = Body(...)` 或 `request: Any = Body(...)`。

### SQLite 单写锁
- `memory.store` 等写操作在 SQLite 上串行。并发场景下 30 个同时写入约 2.1s/个。如需更高吞吐量，考虑 WAL 模式或批量写入。

### 代理头剥离
- `/brain/*` 代理会剥离 `x-forwarded-*` / `x-real-ip`（Round E2 加固），但**会保留 `Authorization`**（MCP write-tool 需要 bearer auth）。如需新增自定义 header 透传，请显式加入 `proxy.ts` 白名单。

---

## 8. 环境变量速查

| 变量 | 作用域 | 默认值 | 说明 |
|------|--------|--------|------|
| `WEBRAIN_SUB_BRAIN_PORT` | 副脑 | `3000` | 副脑 HTTP 端口 |
| `WEBRAIN_MAIN_BRAIN_UDS` | 副脑 | `/tmp/webrain-main.sock` | 主脑 UDS 路径。与 `WEBRAIN_MAIN_BRAIN_PORT` 二选一 |
| `WEBRAIN_MAIN_BRAIN_PORT` | 副脑 | `18790` | 强制 TCP 模式连主脑 |
| `WEBRAIN_NO_MAIN_BRAIN` | 副脑 | unset | `1` 时副脑不自动 spawn 主脑 |
| `WEBRAIN_DATA_DIR` | 主脑 | `<repo>/data/main-brain/` | 主脑数据目录。测试请用 `<tmp>` 避免污染 |
| `WEBRAIN_PYTHON` | 副脑 spawn | auto | 自定义主脑 Python 解释器 |
| `LOG_LEVEL` | 全局 | `info` | 日志级别 |
| `WEBRAIN_API_KEY` | 副脑 | unset | 可选 API Key 鉴权 |
| `WEBRAIN_HYDE_ENABLED` | 主脑 | `1` | HyDE 记忆检索增强 |
| `WEBRAIN_REFLECTION_ENABLED` | 主脑 | `0` | 反思循环（默认关，控制延迟） |
| `WEBRAIN_WORKING_MEMORY_ENABLED` | 主脑 | `1` | 会话工作记忆 |
| `WEBRAIN_CONTEXT_COMPRESS_ENABLED` | 主脑 | `1` | 上下文压缩 |
| `WEBRAIN_KG_CONTEXT_ENABLED` | 主脑 | `1` | 知识图谱上下文注入 |
| `WEBRAIN_TEMPORAL_CONTEXT_ENABLED` | 主脑 | `1` | 时态上下文注入 |
| `WEBRAIN_ACTIVE_MEMORY_ENABLED` | 主脑 | `1` | ActiveMemory 模式提取 |
| `WEBRAIN_PLANNER_ENABLED` | 主脑 | `1` | Planner 任务规划 |

更多 Round S 系列记忆增强开关，见 `CLAUDE.md` §Environment variable cheat sheet。

---

## 9. 安全说明

本项目定位为**个人本地部署**，主脑↔副脑通信协议**刻意无鉴权、CORS 全开、无速率限制**。

- **不要**未经用户明确要求就添加鉴权、CORS 限制、SSRF 防护、权限校验等安全加固。
- 若用户主动要求，可在副脑 `server/auth.ts` 层添加 `WEBRAIN_API_KEY` 校验（已有基础实现）。
- `/brain/*` 代理已剥离 `x-forwarded-*` / `x-real-ip`  header（Round E2）。

---

## 10. 部署

### Docker Compose（推荐）
```bash
docker-compose up --build
```
服务：
- `main-brain`：Python 多阶段构建，非 root 用户运行，HEALTHCHECK 就绪探针。
- `sub-brain`：Node 22 slim，build 后 `node dist/main.js`。
- `frontend`：Node 22 slim，build 后 `pnpm preview`。
- `dokobot`：CDP 浏览器守护（端口 9222）。

### 数据卷
- `./data/sub-brain/main-brain:/data` — 主脑持久化数据
- `./data/sub-brain:/data` — 副脑持久化数据
- `./data/shared:/shared` — 共享数据

### PWA
- 前端注册 Service Worker（`public/sw.js`），支持离线缓存与桌面安装。

---

## 11. 参考文档索引

| 文件 | 内容 |
|------|------|
| `README.md` | 用户面向的快速开始、架构图、端口说明 |
| `CLAUDE.md` | 面向 Claude Code 的详细操作指南、环境变量大全、bug 模式清单 |
| `docs/PROJECT_STATE.md` | 项目当前状态、开发轮次历史、基准数据 |
| `docs/CONTRIBUTING.md` | 贡献规范、分支与提交风格、测试要求 |
| `protocol/protocol.md` | 主脑↔副脑通信协议（REST + WebSocket） |
| `docs/adr/` | 架构决策记录（如沙箱运行时选型） |

---

> 最后更新：2026-05-24（基于代码库实际内容生成，非假设）。
