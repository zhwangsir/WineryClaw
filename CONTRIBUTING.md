# 贡献指南 / Contributing

> Read this in [English](#english) below.

感谢有兴趣参与 WeBrain 的开发。

## 开发环境

需要的工具：
- Node.js 22+
- Python 3.9+(推荐 3.11+)
- pnpm(推荐) 或 npm
- macOS / Linux(Windows 通过 WSL2)

按 `README.md` 的"快速开始"装好依赖,再用 `./scripts/verify-install.sh` 确认环境就绪。

## 开发流程

1. **从 main 分支拉新分支**,命名 `feat/<feature-name>` / `fix/<bug>` / `docs/<scope>` / `test/<area>`。
2. **写代码前先看 `CLAUDE.md`**——里面的"Hot bug-pattern reminders"列了一些只有过来人才知道的陷阱(闭包捕获 stale config、FastAPI Any 误映射 query、`asyncio.create_task` GC race 等)。
3. **测试是认真的**。我们有四层:
   - 单元测试 (~1988 个,<2 min)
   - Backend smoke (~53 个,~6 min,真服务+mock LLM)
   - Playwright frontend e2e (~14 个,<30 s,hermetic mock)
   - Benchmark (recall/MRR/延迟,opt-in via `-m benchmark`)
4. **改公开 API/路由的话,验证两端**:`frontend/src/api/*.ts` 和 `sub-brain/src/server/*.ts` 是否同步;新增 `/brain/*` 是否在 main-brain 有对应 endpoint。
5. **提交前跑过相关测试**。详见 `CLAUDE.md` 命令表;最低限度跑你改动文件对应的那一组。

## 提交风格

参考 `git log` 看最近 50 个 commit 的写法。简要约定:

```
<type>: <subject>

<body>
```

`type` ∈ {`feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `chore`, `ci`, `bench`}。

主体里说明"做了什么"和"为什么"——尤其是"为什么"。如果是 bug 修复,说清楚 bug 是哪一类(闭包?race?config 漂移?)。

## Code Review

PR 至少跑过:
- `pnpm exec tsc --noEmit`(sub-brain + frontend 两边都跑)
- `pnpm exec vitest run`(三处的 unit 测试)
- `pytest`(main-brain unit 测试)
- 改了端到端路径的,跑对应的 smoke / playwright

CRITICAL/HIGH 等级的 reviewer 反馈必须在合并前处理。MEDIUM/LOW 可以记到 PROJECT_STATE.md 里下次处理。

## 一些边界

- **`hermes-agent-main/` 和 `openclaw-main/` 是只读参考**——不要在那里改东西。
- **不要打 LLM 服务端**——`localhost:1234`(LM Studio 风格)和 `localhost:52415` 是占位默认,不是真实可达的地址。配置真实地址用 `WEBRAIN_*` 环境变量或 sub-brain 的 `/config/model`。
- **不要把 .env 提交进 git**——`.gitignore` 已经处理了,但 PR review 时也请目测一下。

## 报 Bug / 建议

[GitHub Issues](https://github.com/zhwangsir/WeBrain/issues)。

报 Bug 时请附带:
- 复现步骤
- 你的环境(OS / Node / Python 版本)
- 相关日志片段(去掉敏感信息)
- 是否影响 user-facing 流程,还是只是开发体验

---

## English

Thanks for your interest in WeBrain.

### Dev setup

Required:
- Node.js 22+
- Python 3.9+ (3.11+ recommended)
- pnpm (preferred) or npm
- macOS / Linux (Windows via WSL2)

Follow the README "快速开始 / Quickstart" section, then run `./scripts/verify-install.sh` to confirm.

### Workflow

1. Branch off `main` as `feat/<x>` / `fix/<x>` / `docs/<x>` / `test/<x>`.
2. Read `CLAUDE.md` before writing code — its "Hot bug-pattern reminders" section lists the architectural traps the audit + smoke layers have caught (closure-captured stale config, FastAPI Any→query mapping, asyncio.create_task GC race, etc.).
3. Tests matter, across four layers (unit / backend smoke / Playwright frontend e2e / benchmark). See `CLAUDE.md` for invocation commands.
4. If you change an API or route, verify BOTH ends — `frontend/src/api/*.ts` and `sub-brain/src/server/*.ts` should stay in sync; new `/brain/*` paths need a matching main-brain endpoint.
5. Run the relevant test groups before submitting.

### Commit style

Look at `git log` for recent examples. Format:

```
<type>: <subject>

<body>
```

Where `type` ∈ `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `chore`, `ci`, `bench`.

The body should explain WHY, not just WHAT — especially the bug class for fixes.

### Code review

A PR should pass:
- `pnpm exec tsc --noEmit` (sub-brain and frontend)
- `pnpm exec vitest run` (the three unit suites)
- `pytest` (main-brain unit)
- Smoke / Playwright tests for changed e2e paths

CRITICAL/HIGH reviewer findings must be addressed before merge. MEDIUM/LOW can be deferred via PROJECT_STATE.md.

### Boundaries

- `hermes-agent-main/` and `openclaw-main/` are read-only references.
- Don't ping LLM endpoints — `localhost:1234` (LM Studio default) and `localhost:52415` are placeholders, not real endpoints. Configure real endpoints via `WEBRAIN_*` env vars or sub-brain's `/config/model`.
- Never commit `.env` files. `.gitignore` already covers them, but please double-check during PR review.

### Reporting issues

Use [GitHub Issues](https://github.com/zhwangsir/WeBrain/issues).

Include:
- Reproduction steps
- Your environment (OS, Node, Python versions)
- Relevant log excerpts (with sensitive info redacted)
- Whether it impacts user-facing flow or just dev experience
