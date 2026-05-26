# WeBrain Keeper — 自动化项目守护系统

> 创建于 2026-05-22 · WeBrain v2 启动伴生设施
> 由项目根级 `.claude/agents/webrain-keeper.md` sub-agent + 本目录下的脚本协同实现

## 目录结构

```
.webrain-keeper/
├── README.md              本文件
├── scripts/
│   ├── health-check.sh    监控：跑测试 + lint + benchmark，输出 reports/
│   ├── auto-fix.sh        简单纠正：prettier / eslint --fix / 同步测试数字
│   ├── keeper-loop.sh     主入口：launchd 触发的脚本，调用 Claude Code headless
│   ├── install.sh         一键启用 launchd（macOS）/ systemd（Linux）
│   └── uninstall.sh       一键禁用
├── logs/                  每次激活的 JSON 简报（git ignored）
├── alerts/                需要人类处理的告警 md（git ignored）
└── reports/               健康检查 JSON 报告（保留最近 30 天，git ignored）
```

## 工作原理

### 两层联动

1. **`.claude/agents/webrain-keeper.md`** — Claude Code 项目级 sub-agent 定义
   - 在主对话里 `Agent({subagent_type:"webrain-keeper", ...})` 可主动召唤
   - 由 Claude Code 内置 Agent 调度器加载
   - 也是 cron loop 远程触发时的执行实体

2. **Autonomous cron loop（launchd / systemd）** — 用户选 C 的方案
   - 每天 03:00（默认）触发 `scripts/keeper-loop.sh`
   - 该脚本调用 `claude` headless 启动 webrain-keeper sub-agent
   - 完成后日志写到 `logs/`

> 注:Stop hook 已在 settings.local.json 中保留为可选项,但默认未启用 —
> 用户希望 keeper 仅由显式 cron 触发 / 主对话召唤,不在每次 session 结束时跑测试。
> 如需开启 Stop hook,在 `.claude/settings.local.json` 的 `hooks.Stop` 中加入
> `bash -c 'nohup .webrain-keeper/scripts/health-check.sh --quick >/dev/null 2>&1 &'`。

## 一键启用

```bash
# macOS（launchd）
./scripts/install.sh

# 验证
launchctl list | grep webrain.keeper

# 查看日志
tail -f .webrain-keeper/logs/$(ls -t .webrain-keeper/logs/ | head -1)
```

## 一键禁用

```bash
./scripts/uninstall.sh
```

## 安全保证

- ✅ 永不直接 push `main`，所有改动走 `keeper/*` 分支 + PR
- ✅ 每次激活有 token + wall-clock 双重预算（1M tok / 20 min）
- ✅ 测试不绿绝不 commit
- ✅ 永不触碰 `~/CLAUDE.md` / `~/.claude/` / vendored upstream
- ✅ 失败 / 异常情况写入 `alerts/`，不自动决策

## 紧急停止

```bash
# 立即禁用 launchd 任务
launchctl unload ~/Library/LaunchAgents/ai.webrain.keeper.plist

# 或硬终止任何正在运行的 keeper 进程
pkill -f "webrain-keeper"
```

## 日志查看

```bash
# 最近一次健康简报
cat .webrain-keeper/reports/$(ls -t .webrain-keeper/reports/ | head -1)

# 最近 7 天告警
ls -lt .webrain-keeper/alerts/ | head -10

# 最近一次 keeper 激活日志
cat .webrain-keeper/logs/$(ls -t .webrain-keeper/logs/ | head -1)
```

## 与 ROADMAP_V2 的关系

Keeper 的目标导航来自 `docs/ROADMAP_V2.md` §1 三大 axis。
每次激活时，keeper 会读 ROADMAP_V2 + PROJECT_STATE，对照当前指标找 gap，推动一小步。
