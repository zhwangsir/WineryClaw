# WeBrain

> 双脑架构 AI 集成平台 —— 主脑负责深度推理与记忆，副脑负责工具执行与通道交互。

WeBrain 是一个基于**双脑架构**的 AI 集成平台，通过分离"推理中心"与"执行中心"，实现安全、可扩展、长记忆的人机协作系统。

---

## 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                    Frontend (port 8587)                      │
│              React 18 + Vite + Ant Design 5                  │
│         Markdown Streaming · Voice Input · PWA              │
└─────────────────────────┬───────────────────────────────────┘
                          │ HTTP / WebSocket
┌─────────────────────────┴───────────────────────────────────┐
│                   Sub Brain (port 3456)                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │  Tools   │ │ Channels │ │  Plugins │ │  Agent   │       │
│  │ Registry │ │  Webhook │ │   SDK    │ │ Manager  │       │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘       │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │  Browser │ │  Sandbox │ │  Memory  │ │   CLI    │       │
│  │ Playwright│ │ Docker  │ │  Proxy   │ │          │       │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘       │
│                          ↕ /brain/* Proxy                    │
└─────────────────────────┬───────────────────────────────────┘
                          │ UDS /tmp/webrain-main.sock
┌─────────────────────────┴───────────────────────────────────┐
│                    Main Brain (UDS/TCP)                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │  Memory  │ │ Reasoning│ │ Evolution│ │ Decision │       │
│  │ L1-L4    │ │  Engine  │ │  Engine  │ │  Center  │       │
│  │ 分层存储  │ │ 思维链   │ │ 自我进化 │ │ 路由决策 │       │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘       │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐                     │
│  │   Chat   │ │   Wiki   │ │Knowledge │                     │
│  │  Engine  │ │  Engine  │ │  Graph   │                     │
│  │ 流式对话 │ │ 笔记管理 │ │ 知识图谱 │                     │
│  └──────────┘ └──────────┘ └──────────┘                     │
└─────────────────────────────────────────────────────────────┘
```

### 双脑架构优势

- **安全隔离**：工具执行（文件读写、网络请求、Docker 容器）在 Sub Brain 中运行，与推理核心物理隔离
- **水平扩展**：Sub Brain 可独立集群部署，Main Brain 专注 LLM 推理
- **长时记忆**：L1-L4 四级记忆系统（会话 → 日 → 主题 → 永久），支持语义检索
- **多模型路由**：支持多个 LLM 端点自动故障转移与负载均衡

---

## 核心功能

### 🤖 智能对话
- **SSE 流式输出**：实时 Markdown 渲染，代码语法高亮，增量滚动
- **多会话管理**：侧边栏会话列表，支持搜索、导出、删除
- **语音输入**：Web Speech API 语音识别（中文支持）
- **文件拖拽上传**：支持 .txt / .md / .json 文本文件直接拖入对话
- **模型切换**：Header 实时显示模型健康状态，一键切换 LLM 端点
- **工具调用开关**：实时控制 Function Calling 启用/关闭

### 🧠 记忆系统
- **四级记忆**：L1 会话级 → L2 日归档 → L3 主题聚合 → L4 永久知识
- **知识图谱**：自动提取实体关系，构建可查询的知识网络
- **Wiki 笔记**：支持 Markdown 编辑、实时预览、全文搜索

### 🛠️ 工具与插件
- **内置工具集**：Web 搜索、浏览器自动化、代码执行、文件编辑、终端命令
- **Docker 沙箱**：代码在隔离容器中执行，确保安全
- **插件 SDK**：TypeScript 插件接口，支持 Hooks 生命周期

### 📊 系统管理
- **仪表盘**：实时健康状态、模块监控、模型端点状态
- **Cron 任务**：定时任务调度与管理
- **通道管理**：多渠道消息接入（Web、邮件、Webhook）
- **智能体管理**：Agent 创建、配置、状态监控

### 🎨 用户体验
- **深色/浅色主题**：CSS 变量驱动，平滑过渡动画
- **PWA 支持**：Service Worker 离线缓存，可安装为桌面应用
- **命令面板**：`Cmd/Ctrl+K` 快速跳转，`Cmd/Ctrl+/` 快捷键帮助
- **响应式布局**：移动端自适应，侧边栏抽屉导航

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 18, Vite, Ant Design 5, Zustand, react-markdown |
| Sub Brain | Fastify, TypeScript, Playwright, Dockerode, ESM |
| Main Brain | Python, FastAPI, Uvicorn, SQLite + FTS5 |
| 测试 | Vitest, jsdom, @testing-library/react, pytest |
| 部署 | Docker, Docker Compose |

---

## 快速开始

### 环境要求
- Node.js 22+
- Python 3.9+ (3.11+ recommended for newer asyncio features)
- pnpm (推荐) 或 npm

### 安装依赖

```bash
# 安装前端依赖
cd frontend && pnpm install

# 安装 Sub Brain 依赖
cd ../sub-brain && pnpm install

# 安装 Main Brain Python 依赖
cd main-brain
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 开发启动

```bash
# 终端 1：启动 Main Brain
cd sub-brain/main-brain
source venv/bin/activate
python main_brain.py

# 终端 2：启动 Sub Brain
cd sub-brain
pnpm dev

# 终端 3：启动前端开发服务器
cd frontend
pnpm dev

# 访问 http://localhost:8587
```

### Docker 一键启动

```bash
docker-compose up --build
```

### 安装检查

```bash
# 验证依赖、venv、node_modules 是否就绪
./scripts/verify-install.sh

# 同时跑 e2e smoke 测试(~50s)
./scripts/verify-install.sh --smoke
```

---

## 项目结构

```
webrain-integration/
├── frontend/               # React 前端 (Vite + Ant Design)
│   ├── src/
│   │   ├── pages/         # 页面组件 (Chat, Dashboard, Settings...)
│   │   ├── components/    # 公共组件 (MarkdownRenderer, Layout...)
│   │   ├── stores/        # Zustand 状态管理
│   │   ├── api/           # API 客户端封装
│   │   └── styles/        # 全局样式与主题
│   └── ...
├── sub-brain/              # 副脑 (Fastify + TypeScript)
│   ├── src/
│   │   ├── server/        # HTTP 服务器、代理、认证
│   │   ├── tools/         # 工具注册与执行
│   │   ├── channels/      # 消息通道协议
│   │   ├── agent/         # 智能体管理
│   │   └── plugin-sdk/    # 插件开发 SDK
│   ├── main-brain/        # 主脑 (Python FastAPI)
│   │   ├── chat/          # 对话引擎
│   │   ├── memory/        # 记忆管理 (L1-L4)
│   │   ├── reasoning/     # 推理引擎
│   │   ├── evolution/     # 进化引擎
│   │   └── tests/         # Python 单元测试
│   └── ...
├── tests/                  # 集成测试与 E2E 测试
├── scripts/                # 构建与部署脚本
└── docker-compose.yml      # Docker 编排
```

---

## 端口说明

| 服务 | 地址 | 说明 |
|------|------|------|
| 前端开发服务器 | `http://localhost:8587` | Vite HMR 开发服务器 |
| Sub Brain API | `http://localhost:3456` | API 网关 + Brain 代理 |
| Main Brain | UDS `/tmp/webrain-main.sock` | Unix Domain Socket |
| Main Brain (fallback) | `http://localhost:18790` | TCP 回退模式 |
| Prometheus Metrics | `http://localhost:3456/metrics` | 进程与 HTTP 指标 |

---

## 测试

```bash
# 前端测试
cd frontend && pnpm test

# Sub Brain 测试
cd sub-brain && pnpm test

# Main Brain 测试
cd sub-brain/main-brain && pytest

# 集成测试（需要服务运行）
pnpm test
```

---

## 工程规范

- **ESLint + Prettier**：代码格式与质量检查
- **Husky + lint-staged**：提交前自动格式化
- **TypeScript 严格模式**：全栈类型安全
- **Vitest**：前端单元测试覆盖
- **GitHub Actions CI**：自动化检查与构建

---

## 开源协议

MIT License

---

>  Made with ❤️ for human-AI collaboration.
