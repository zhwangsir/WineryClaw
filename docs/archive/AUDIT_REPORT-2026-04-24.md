# WeBrain 项目审计报告 & 开发路线图

> 审计日期：2026-04-24  
> 审计范围：frontend/ + sub-brain/ + sub-brain/main-brain/ + tests/ + CI/CD

---

## 一、项目规模

| 模块 | 源文件数 | 测试文件数 | 测试覆盖度 |
|------|---------|-----------|-----------|
| Frontend (TS/TSX) | 56 | 3 | ⚠️ 极低 (~5%) |
| Sub Brain (TS) | 42 | 5 | ⚠️ 低 (~12%) |
| Main Brain (Python) | ~25 | 8 | ⚠️ 中等 (~32%) |
| Root Tests | — | 17 | ⚠️ 大多需运行服务 |
| **总计** | **~123** | **33** | **严重不足** |

---

## 二、问题分级总览

```
P0 严重 ████████░░ 8 项  — 安全漏洞、数据风险
P1 高   █████████░ 9 项  — 代码质量、类型安全
P2 中   ██████░░░░ 6 项  — 架构一致性、工程化
P3 低   ████░░░░░░ 4 项  — 文档、CI、体验
```

---

## 三、P0 — 严重问题（安全）

### 3.1 认证完全可选，所有端点默认公开
**文件**：`sub-brain/src/server/auth.ts:4-5`, `sub-brain/src/main.ts:45`  
**问题**：`WEBRAIN_API_KEY` 未设置时 `registerAuth()` 直接 `return`，所有 API（包括 `/tools/execute`、`/sandbox/*`、`/plugins/load-from-disk`）零鉴权开放。CORS 配置为 `origin: true, credentials: true`，允许任意来源携带凭据跨域访问。  
**风险**：任何人可通过公网 IP 直接执行代码、读取文件、加载恶意插件。  
**修复**：默认启用鉴权（至少 Basic Auth 或 Bearer Token），CORS 白名单化。

### 3.2 内置工具直接在宿主机执行任意代码
**文件**：`sub-brain/src/tools/built-in-tools.ts:30-36`, `sub-brain/src/tools/edit-file.ts`  
**问题**：`shell`、`python_exec`、`execute_code` 工具使用 `execSync`/`spawn` 直接运行命令，无沙箱隔离、无命令白名单、无超时强杀。`file_read`/`file_write`/`edit_file` 使用 `resolve()` 解析用户传入路径，无目录限制。  
**风险**：可读取 `~/.ssh/id_rsa`、删除系统文件、安装后门、挖矿。  
**修复**：工具默认走 Docker Sandbox；文件操作限制在项目目录 + 显式 allowlist。

### 3.3 动态插件加载可执行任意文件
**文件**：`sub-brain/src/plugins/plugin-loader.ts:170-243`  
**问题**：`POST /plugins/load-from-disk` 接收请求体中的 `path`，直接 `import()` 加载执行，无签名验证、无路径限制、无沙箱。  
**风险**：上传 JS 文件后作为插件加载即可 RCE。  
**修复**：插件仅允许从固定目录加载；启用前需管理员确认 + 签名/哈希校验。

### 3.4 SSRF — 无限制出站 HTTP
**文件**：`sub-brain/src/tools/built-in-tools.ts:136-152`, `sub-brain/src/server/proxy.ts:9-35`  
**问题**：`http_request` 工具允许任意 URL/Method/Body；`/brain/*` 代理无条件转发到 Main Brain，无路径校验。  
**风险**：可探测内网（AWS metadata `169.254.169.254`、K8s API）、攻击 Main Brain 内部端点。  
**修复**：URL 域名白名单；禁止访问私有 IP 段；代理层增加路径校验。

### 3.5 SQLite 数据库无权限隔离
**文件**：`sub-brain/src/db/sub-brain-db.ts`（推断）  
**问题**：Sub Brain SQLite 数据库存储在 `~/.webrain/` 下，文件权限未显式设置，与运行用户同权限。  
**风险**：其他进程或容器逃逸后可读取记忆、配置、API Key。  
**修复**：数据库文件设置 `0o600` 权限；敏感配置使用 OS keychain 或加密存储。

### 3.6 Sub Brain Dockerfile 以 root 运行
**文件**：`sub-brain/Dockerfile`  
**问题**：无 `USER` 指令，容器内进程以 root 运行。  
**风险**：容器逃逸后获得宿主机 root。  
**修复**：添加非 root 用户（参考 `main-brain/Dockerfile` 的做法）。

---

## 四、P1 — 高优先级问题

### 4.1 TypeScript `any` 泛滥（40+ 处）
**影响文件**：所有 `stores/*.ts`、`pages/ChatPage.tsx`、`api/kg.ts`、`api/cron.ts` 等  
**具体问题**：
- 所有 store 的 `catch (e: any)` 应使用 `unknown` + 类型守卫
- `modelHealth: Record<string, any>` 应定义为接口
- `toolCalls?: any[]` 应使用 `ToolCall[]`
- ChatPage `textareaRef: any`、`recognitionRef: any` 应使用具体类型
- API 层大量 `get<any>`、`post<any>` 应返回具体类型

### 4.2 Store 样板代码重复（~30 处相同模式）
**影响文件**：所有 `stores/*.ts`  
**模式**：
```ts
try { ... } catch (e: any) {
  message.error(e.message || "...");
  set({ loading: false });
}
```
**问题**：UI 层（`antd message`）与状态管理耦合，测试困难。  
**修复**：提取 `createStoreAction` 高阶函数或 Zustand middleware；store 只抛错误，UI 层统一处理。

### 4.3 ChatPage.tsx 过大（1089 行）
**文件**：`frontend/src/pages/ChatPage.tsx`  
**问题**：包含布局逻辑、状态管理、SSE 流处理、语音输入、拖拽上传、会话侧边栏、MessageBubble、HighlightedText 等 7+ 个独立关注点。`messagesEndRef` 声明但从未使用。  
**修复**：拆分为 `ChatSidebar`、`ChatInput`、`MessageList`、`MessageBubble`、`useVoiceInput`、`useDragDrop`。

### 4.4 `useDebounce` 三处重复实现
**文件**：`WikiPage.tsx`、`MemoryPage.tsx`、`ToolsPage.tsx`  
**修复**：提取到 `hooks/useDebounce.ts`。

### 4.5 API URL 前缀不一致
**当前状态**：
- `/api/agents` (agents)
- `/brain/chat`, `/brain/kg/...` (brain namespace)
- `/channels/...`, `/tools/...` (无前缀)
- `/config/...`, `/health/...` (根级)
**修复**：统一为 `/api/v1/*` 命名空间。

### 4.6 类型定义分散
**问题**：`CronJob`、`ChannelInfo`、`GlobalConfig` 等类型定义在各自 API 文件中，而非集中 `api/types.ts`。  
**修复**：统一类型到 `api/types.ts`，API 文件只保留调用逻辑。

### 4.7 API client `stream()` 类型不安全
**文件**：`frontend/src/api/client.ts:82`  
**问题**：`data as Record<string, string>` 强制转换可能传入非字符串值。  
**修复**：序列化前检查类型，或使用 `URLSearchParams` 的构造函数重载。

### 4.8 Main Brain Python 模块导入风险
**文件**：`sub-brain/main-brain/main_brain.py`（推断）  
**问题**：动态加载模块时可能缺少异常边界。  
**修复**：所有动态 import 包在 `try/except ImportError` 中。

---

## 五、P2 — 中优先级问题

### 5.1 前端测试覆盖率极低
| 类别 | 已测试 | 总数 | 覆盖率 |
|------|--------|------|--------|
| Pages | 1 (AgentsPage) | 10 | 10% |
| Stores | 1 (chatStore) | 9 | 11% |
| Components | 1 (MarkdownRenderer) | 15+ | ~7% |
| API Clients | 0 | 10 | 0% |
| Hooks | 0 | 3 | 0% |

### 5.2 Sub Brain 核心模块未测试
- `browser-tool.ts` / `playwright-browser.ts` — 浏览器自动化
- `docker-sandbox.ts` — 安全沙箱
- `channel-manager.ts` / `email-protocol.ts` — 通道协议
- `plugin-loader.ts` / `plugin-sdk/*` — 插件系统
- `server/auth.ts` / `server/proxy.ts` — 基础设施

### 5.3 集成测试依赖运行中服务
**文件**：`tests/setup.ts`, `tests/api/*.test.ts`, `tests/e2e/*.test.ts`  
**问题**：8 个测试文件需要 Sub Brain (port 3000) + Main Brain 同时运行，无法在 CI 中可靠执行。  
**修复**：使用 `msw` (Mock Service Worker) 或 `nock` 进行 HTTP mock；Python 层使用 `unittest.mock` + `TestClient`。

### 5.4 CI 缺少 Sub Brain 类型检查与测试
**文件**：`.github/workflows/ci.yml`  
**当前**：CI 只检查了 frontend lint/format/build 和 main-brain pytest，**缺少 sub-brain 的类型检查和单元测试**。  
**修复**：在 CI 中添加 sub-brain 的 `tsc --noEmit` 和 `vitest run`。

### 5.5 前端 chunk 过大
**文件**：`frontend/vite.config.ts`  
**问题**：`react-core` chunk 2,062 KB（gzip 后 670 KB），主要原因是 `react-syntax-highlighter` 包含所有语言定义。  
**修复**：`manualChunks` 按语言拆分，或动态加载语言子集。

### 5.6 未使用 fixtures
**文件**：`tests/fixtures/fake-mcp-server.cjs`  
**问题**：存在但没有任何测试引用。  
**修复**：删除或补充对应测试。

---

## 六、P3 — 低优先级问题

### 6.1 前端缺少 `react-helmet-async` 页面标题管理
所有页面共享同一个 `<title>`，SEO 和浏览器标签体验差。

### 6.2 前端缺少错误边界页面级处理
`ErrorBoundary` 存在但只在 `main.tsx` 包裹根组件，缺少页面级降级 UI。

### 6.3 `PLAN.md` 已过时
文件内容与当前已实现功能不匹配，建议删除或重写为 `ROADMAP.md`。

### 6.4 `UI_OPTIMIZATION_PLAN.md` 应移入 docs/
前端目录中的计划文档不应与源码混合。

---

## 七、开发路线图

### Phase 1：安全加固（预计 1–2 周）
**目标**：消除 P0 安全漏洞，使系统达到"可公网部署"的最低安全基线。

| 任务 | 优先级 | 文件 | 工作量 |
|------|--------|------|--------|
| 1.1 强制 API Key 鉴权（默认生成随机 key） | P0 | `auth.ts`, `main.ts` | 4h |
| 1.2 CORS 白名单化（拒绝默认 `origin: true`） | P0 | `main.ts` | 2h |
| 1.3 文件工具目录沙箱（限制 `process.cwd()` + allowlist） | P0 | `built-in-tools.ts`, `edit-file.ts` | 8h |
| 1.4 Shell 工具默认禁用 / 强制 Docker Sandbox | P0 | `built-in-tools.ts`, `docker-sandbox.ts` | 8h |
| 1.5 插件加载路径限制 + 签名校验 | P0 | `plugin-loader.ts` | 6h |
| 1.6 HTTP 工具域名白名单 + 私有 IP 拦截 | P0 | `built-in-tools.ts`, `proxy.ts` | 6h |
| 1.7 SQLite 文件权限 `0o600` + 配置加密 | P0 | `sub-brain-db.ts`, `layered-config.ts` | 4h |
| 1.8 Sub Brain Dockerfile 非 root 用户 | P0 | `sub-brain/Dockerfile` | 2h |
| 1.9 安全审计测试（认证绕过、路径遍历、SSRF） | P0 | `tests/security/` | 8h |

### Phase 2：工程化 + 测试覆盖（预计 2–3 周）
**目标**：类型安全、代码复用、核心模块有测试守护。

| 任务 | 优先级 | 说明 |
|------|--------|------|
| 2.1 消除所有 `any`（store 层优先） | P1 | 使用 `unknown` + 类型守卫；定义 `ApiError`/`AppError` 类型 |
| 2.2 提取 `useDebounce` hook | P1 | 统一 3 处重复实现 |
| 2.3 提取 Store 错误处理中间件 | P1 | Zustand middleware 封装 `try/catch/loading` |
| 2.4 拆分 ChatPage | P1 | `ChatSidebar`, `ChatInput`, `MessageList`, `MessageBubble` |
| 2.5 统一 API 类型到 `api/types.ts` | P1 | `CronJob`, `ChannelInfo`, `GlobalConfig` 等 |
| 2.6 前端 API 层测试（msw mock） | P1 | `agents.test.ts`, `chat.test.ts`, `tools.test.ts` |
| 2.7 前端 Store 测试 | P1 | `agentStore`, `configStore`, `systemStore` |
| 2.8 Sub Brain 核心测试 | P1 | `plugin-loader.test.ts`, `docker-sandbox.test.ts` |
| 2.9 CI 补充 sub-brain tsc + vitest | P1 | `.github/workflows/ci.yml` |
| 2.10 集成测试去服务依赖 | P2 | 用 `nock`/`msw` 替代真实 HTTP 调用 |

### Phase 3：功能增强（预计 2–3 周）
**目标**：提升用户体验和系统能力。

| 任务 | 优先级 | 说明 |
|------|--------|------|
| 3.1 WebSocket 实时推送 | P2 | 替换轮询，状态实时同步 |
| 3.2 前端 chunk 拆分优化 | P2 | `manualChunks` 降低首屏加载 |
| 3.3 消息持久化后端 | P2 | `/brain/chat/history` 完整 CRUD |
| 3.4 增量 Markdown 渲染 | P2 | 避免流式输出时全量 re-render |
| 3.5 对话导出多格式 | P3 | JSON / PDF / 图片 |
| 3.6 多语言完整覆盖 | P3 | 所有页面接入 i18n |
| 3.7 前端页面标题管理 | P3 | `react-helmet-async` |
| 3.8 前端错误边界页面级 | P3 | 每个路由独立降级 UI |

### Phase 4：运维 & 文档（持续）
**目标**：生产级可维护性。

| 任务 | 优先级 | 说明 |
|------|--------|------|
| 4.1 结构化日志（JSON） | P3 | Pino / winston 替代 console |
| 4.2 链路追踪完善 | P3 | OpenTelemetry + Jaeger |
| 4.3 性能基准测试 | P3 | k6 / artillery 压测 |
| 4.4 部署文档 | P3 | K8s Helm Chart / Docker Swarm |
| 4.5 API 文档（OpenAPI） | P3 | Fastify swagger + 自动生成 |
| 4.6 开发者文档 | P3 | Plugin SDK 开发指南 |

---

## 八、立即执行建议（本周）

如果只有一个冲刺周期，建议按以下顺序：

1. **周一**：安全加固 Phase 1.1–1.3（认证 + CORS + 文件沙箱）
2. **周二**：安全加固 Phase 1.4–1.6（Shell 沙箱 + 插件限制 + SSRF）
3. **周三**：工程化 Phase 2.1–2.3（消除 any + 提取 hook + store 中间件）
4. **周四**：工程化 Phase 2.4–2.6（拆分 ChatPage + 统一类型 + API 测试）
5. **周五**：CI 补充 + 回归测试 + 文档更新

---

## 九、风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| 安全漏洞被利用 | 高 | 灾难性 | Phase 1 优先执行，部署前必须完成 |
| 代码重构引入回归 | 中 | 高 | 每步重构伴随测试补充，小步快跑 |
| 测试 mock 不准确 | 中 | 中 | 定期跑集成测试验证 mock 有效性 |
| 第三方依赖漏洞 | 低 | 中 | 启用 Dependabot，定期 `pnpm audit` |

---

> **结论**：WeBrain 核心功能完整、架构设计合理，但**安全基线尚未达到生产要求**，**测试覆盖率严重不足**。建议立即启动 Phase 1 安全加固，同时并行推进 Phase 2 工程化改进。
