# WeBrain Integration 修复方案

## 问题总览

| 优先级 | 问题 | 影响 | 修复策略 |
|--------|------|------|----------|
| P0 | 测试系统瘫痪 | 122个测试无法运行 | 更新 setup.ts 端口/UDS 检测 |
| P0 | TypeScript 编译失败 | 无法构建生产包 | 安装类型包 + 修复代码错误 |
| P1 | Docker Compose 过期 | 容器化不可用 | 更新端口 9797→3000 |
| P1 | API 路由不对齐 | 前端调用404 | 统一前后端路由约定 |
| P2 | CI 掩盖错误 | 质量问题被隐藏 | 移除 `\|\| true` |
| P2 | UDS Socket 残留 | 重启失败 | 启动前清理旧 socket |
| P3 | README 过期 | 文档误导 | 更新架构图和端口 |

---

## Phase 1: 修复测试系统

**目标**: 让 `pnpm test` 不再因 setup.ts 配置错误而全部失败

1. `tests/setup.ts`: 
   - 端口 9797 → 3000
   - Main Brain URL 支持 UDS (先检查 /brain/health 代理)
   - 添加重试机制

2. `vitest.config.ts`:
   - 确保 pool: forks 配置正确
   - 排除可能卡住的测试文件

## Phase 2: 修复 TypeScript 编译 (17个错误)

**类别 A: 缺少类型声明** (7个错误)
- `nodemailer`, `imap-simple`, `@types/web-push`
- `puppeteer`, `chrome-remote-interface`
- `glob`, `node:sqlite`
- 方案: 安装 `@types/*` 包或在 tsconfig 中声明模块

**类别 B: 代码逻辑错误** (5个错误)
- `server/static.ts`: 函数返回类型不匹配
- `plugin-sdk/context.ts`: Buffer 类型不匹配
- `agent/collaboration-engine.ts`: 变量使用前未赋值
- `agent/workflow-engine.ts`: 联合类型不匹配
- `browser/playwright-browser.ts`: Promise/string 不匹配

**类别 C: 其他类型问题** (5个错误)
- `server/static.ts` 多处 Fastify 类型问题

## Phase 3: Docker Compose + CI

- `docker-compose.yml`: 所有 9797 → 3000
- `sub-brain/main-brain` URL: http://main-brain:18790 (保持不变)
- `.github/workflows/ci.yml`: 更新路径，移除 `\|\| true`

## Phase 4: API 路由对齐

**后端缺失的路由** (需要添加):
- `GET /api/memory` → 返回记忆列表
- `GET /api/memory/search?q=` → 搜索记忆
- `POST /api/memory` → 存储记忆
- `GET /api/wiki` → 返回笔记列表
- `GET /api/wiki/search?q=` → 搜索笔记
- `GET /api/kg/entities` → 返回实体列表
- `GET /api/agents` → 返回智能体列表 (已有但路径可能不同)

**前端 API 层修正**:
- `api/memory.ts`: 修正路径
- `api/wiki.ts`: 修正路径
- `api/kg.ts`: 修正路径

## Phase 5: UDS 清理 + 文档

- `main.ts`: 启动前 `unlinkSync(MAIN_BRAIN_UDS)` 如果存在
- `README.md`: 更新端口为 3000
