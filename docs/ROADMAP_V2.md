# WeBrain v2 路线图 — 「超越」的工程化定义

> **创建**：2026-05-22 · **状态**：v2 启动 · **接管**：本会话开始
> **上游对比项目**：Hermes Agent (Nous Research) / OpenClaw
> **本文件用途**：作为 `webrain-keeper` sub-agent 的指南针，所有自动化迭代必须以此为目标。

---

## 0. 战略前提

上一轮审计已经证明：单人 + AI 在 1 年内**量化追平** Hermes / OpenClaw 是数学不可能。
代码量 ~1/18、贡献者 1 vs 24+、channel 数 1/3、provider 数 1/29、原生 app 0 vs macOS+iOS+Android。

因此 WeBrain v2 **不追平**，而在**结构性已领先的 axis 上做到「绝对世界第一」**，
并在**用户实际场景**上做到「不可替代」。

「超越」= 在以下三个 axis 上 Hermes 和 OpenClaw **结构性做不到** + **可量化更好**。

---

## 1. 三大「超越」axis

### Axis 1 — 世界最强本地 AI 记忆系统

**为什么 WeBrain 能赢**：
- Hermes 的 Honcho 是 dialectic 用户建模，不是分层记忆系统
- OpenClaw 的 active-memory 是单层 extension，没有 L1-L4
- WeBrain 已有 19 轮元信号增强（S1-S19），是全行业最深

**v2 目标**（量化）：

| 指标 | 当前 | v2 目标 | 突破方法 |
|---|---:|---:|---|
| recall@5 | 0.625 | **≥ 0.85** | S20-S30 系列继续打磨 + 真实用户对话 fixture |
| recall@10 | 0.675 | **≥ 0.90** | 同上 |
| MRR | 0.590 | **≥ 0.80** | rerank 模型升级 + cross-encoder 微调 |
| 跨会话覆盖 | S10 仅首条触发 | **100%** | 每轮注入而非首条 |
| 记忆元信号轮次 | 19 (S1-S19) | **40+** | 继续 S20+ |
| 单调用 P95 | 103 ms | **≤ 80 ms** | connection pool 调到 8/16 + writer queue |
| 并发 30 P95 | 2450 ms | **≤ 800 ms** | 单 writer thread + read pool |
| 数据落盘加密 | 明文 SQLite | **SQLCipher 默认开** | 隐私优先立场需要硬保证 |

**衡量方法**：
- `pytest -m benchmark` 套件，固定 fixture，每个 release 必跑
- `tests/test_memory_benchmark.py` + `test_chat_latency_benchmark.py`

### Axis 2 — 世界最强双脑物理隔离架构

**为什么 WeBrain 能赢**：
- Hermes 是单 Python 进程
- OpenClaw 是单 Node.js 进程 + extension SDK
- WeBrain 双脑分离已有，但 plugin hook 跨进程没打通（PROJECT_STATE §12）

**v2 目标**：

| 指标 | 当前 | v2 目标 |
|---|---:|---:|
| Plugin hook 跨进程率 | 3/8（仅 startup / pre-tool / post-tool） | **8/8 全部** |
| Sub-brain 状态污染检测 | 无 | 自动 audit 每周一次 |
| Main-brain 推理 idempotency | 无显式保证 | 每个 `/chat` 调用 deterministic seed 可选 |
| 跨进程协议版本化 | 无 | protobuf schema + `protocol_version` 字段 |
| 双脑 supervised 启停 | 手工 | `webrain start/stop/status` 单命令 + systemd 服务化 |

### Axis 3 — 最完备的隐私优先本地 AI 平台

**为什么 WeBrain 能赢**：
- Hermes 提供 7 个 cloud backend（Modal / Daytona / Vercel Sandbox 等）
- OpenClaw 提供 fly.io + render.yaml 远程部署
- 没有任何一家把「拒绝把代码/对话发到第三方」作为产品立场（ADR-0001 是 WeBrain 的）

**v2 目标**：

| 指标 | 当前 | v2 目标 |
|---|---:|---:|
| 离线可跑度 | LLM 本地后即可 | **100%**（含一切：embedding / rerank / TTS / STT） |
| 数据落盘加密 | 明文 | SQLCipher + key 走 macOS Keychain / Linux Secret Service |
| 网络出站审计 | 黑盒 | 出站请求 ledger（host + bytes + 时间） |
| 默认沙箱网络 | `--network none` | 同 + 出站白名单已实现（L3） |
| 模型 provider 接入 | 1 + 框架 | **8 个**：OpenAI / Anthropic / Gemini / DeepSeek / Kimi / Qwen / Ollama / LM Studio |
| 隐私模式（一键全离线） | 无 | `webrain privacy on/off` 命令 |
| 数据导出/迁移 | 无 | `webrain export --to <path>` + `webrain import` |

---

## 2. 不追求的事（明确放弃）

**这些是 Hermes / OpenClaw 的强项，刻意不追**：

| 不追的事 | 为什么 |
|---|---|
| 30+ channel 覆盖 | 用户实际只用 5-8 个 |
| 30+ LLM provider | Axis 3 列出的 8 个覆盖 95% 场景 |
| Cloud backend（Modal / Daytona / Vercel） | 与「单机隐私优先」立场冲突 |
| 原生 iOS / Android app | 单人无法维护 native mobile + 双脑架构 |
| RL trajectory generation（Hermes Atropos） | 需研究团队和 GPU 集群 |
| 24 contributor 社区 | 接受单人 + AI 协作的产能 |

---

## 3. v2 Sprint 路线

### Sprint 0.1（本会话）✅ 进行中
- ROADMAP_V2.md ✅
- `.claude/agents/webrain-keeper.md` sub-agent 定义
- Stop hook + autonomous cron loop 触发器
- PROJECT_STATE.md 同步 K/L/S 12 轮

### Sprint 0.2 — M6b 桌面壳 (Tauri)
路线图最后一块。2-3 周。完成后 v2 桌面端落地。

### Sprint 0.3 — 5 大 LLM provider 接入
OpenAI / Anthropic / Gemini / DeepSeek / Kimi。LLMRouter 真正用起来。3-5 天。

### Sprint 0.4 — S20+ 记忆系统深度
继续 S 系列直到 S30+，把 recall/MRR 推到 0.80+。1-2 周。

### Sprint 0.5 — 双脑跨进程 plugin hook
8/8 hook 全部跨进程可调。1 周。

### Sprint 0.6 — SQLCipher + 网络 ledger + 隐私模式
Axis 3 收尾。1-2 周。

### Sprint 0.7 — 性能极致打磨
单写 thread + read pool，P95 ≤ 80ms。1 周。

---

## 4. 衡量「v2 完成」的客观标准

v2 release 必须同时满足：

- [x] **Axis 1 元信号轮次 40+** — ✅ v2.14 达成 40/40
- [x] **Axis 2 跨进程 plugin hook 8/8** — ✅ v2.15 达成 8/8
- [x] **Axis 3 SQLCipher 加密** — ✅ v2.10 opt-in
- [x] **Axis 3 网络出站审计 ledger** — ✅ v2.16
- [x] **Axis 3 8 LLM provider 配置** — ✅ v2.10
- [x] **Axis 3 privacy mode toggle** — ✅ v2.17
- [ ] Axis 1 recall@5 ≥ 0.85（当前 0.625 rerank ON，差 26%）
- [ ] Axis 1 单调用 P95 ≤ 80ms（2026-05-23 实测 ~200ms。v2.44 已实施
       writer-thread + read-pool 架构 (ADR-0002),但同机 A/B 显示并未
       达到 architect 预测的 75-85ms 目标 — 瓶颈不在 SQLite 写锁,需
       profiling 定位)
- [ ] Axis 1 并发 30 P95 ≤ 800ms（2026-05-23 实测 ~5200ms。v2.44
       writer thread 架构已就位但单机未观测到预测的 2450→700-900 改善
       — 见 ADR-0002 "Triggers for revisiting"）
- [x] M6b 桌面壳可在 macOS 一键启动（.app/.dmg 已就绪；Linux 在
       desktop-linux CI 中验证 `tauri build --bundles deb`,实际 boot
       smoke 未做 — 用户当前主用 macOS+Web,Linux GA 验证延后）
- [ ] webrain-keeper sub-agent 已运行至少 30 天且无失控记录
- [x] 所有测试套件全绿（main-brain 969 / sub-brain 537 / frontend 1267
       / e2e 89 / smoke 53;v2.44 写迁移期间无回归）
- [x] PROJECT_STATE.md 文档零漂移（v2.18 已同步至 §20）

**当前进度**: 三大 axis **接口主指标全部达成**;算法侧 recall + 性能侧
P95 仍是 open item (v2.44 架构就位但需 profiling 才能拿到 win)。

---

## 5. 给 webrain-keeper 的指令

`webrain-keeper` 是本路线图的执行者。每次激活时：

1. 读 ROADMAP_V2.md（本文件）+ 当前 PROJECT_STATE.md
2. 对照当前指标 vs §1 目标，找出最大 gap
3. 提出当前 Sprint 的下一个原子任务
4. 严格按 Karpathy 四原则执行
5. 永不直接 push 到 `main`，必须开 `keeper/<topic>-<date>` 分支
6. 测试不绿绝不 commit
7. 每次运行后写 `.webrain-keeper/logs/<timestamp>.json` 记录
8. 每周一次：同步 PROJECT_STATE.md + 检查文档漂移

---

## 6. 安全护栏（硬规则）

- 永不修改 `~/CLAUDE.md` / `~/.claude/`
- 永不在 `hermes-agent-main/` / `openclaw-main/` 内做任何写操作
- 永不 `git push --force` / `git reset --hard origin/main` / `rm -rf`
- 永不绕过 hook（`--no-verify`）
- 凡涉及 LLM provider key / token 的修改，必须先停下来等用户确认
- 每次 cron loop 单次预算上限：1M tokens、20 分钟 wall clock

---

*本文件由用户王震宇于 2026-05-22 授权创建，作为 WeBrain v2 启动文档。*
*未经用户审视前，所有 keeper 自动化迭代必须以本路线图为唯一目标。*
