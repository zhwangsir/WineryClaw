# 用户试用报告 — 2026-05-20

> 我以"刚下载这个项目的用户"身份从零启动 webrain,跑了几个真实场景,记录每一个摩擦点。
> 不是测试。是用。

---

## TL;DR

跑通整个系统**一共发现 12 个问题**,其中:
- **3 个 P0**(系统直接跑不起来或核心功能死代码)
- **4 个 P1**(用户体验被严重劫持)
- **5 个 P2**(噪音 / 小坑 / 优化项)

本轮当场修了 **3 个最关键的**:
- ✅ #8 双重 notFoundHandler 启动崩溃 → 改 main.ts:守护;加 4 个回归测试
- ✅ #11 冲突检测在生产中是死代码 → main_brain.py lifespan 加 ConflictDetector 实例化 + 注入
- ✅ #12 冲突阈值 0.7 对 CJK 太严 → 默认改 0.5,环境变量可调

剩下的 9 个记在本文档,留作后续真使用过程持续追踪。

---

## 详细记录

### P0 - 阻塞型

#### Issue #8 — sub-brain 启动崩溃,但日志看起来在跑(本轮已修复)
- **症状**: `pnpm dev` 输出只有 `$ tsx watch src/main.ts`,30 秒后端口 3000 仍未监听,进程在跑但完全沉默。从用户视角无法诊断
- **根因**: `static.ts:73` 在 frontend/dist 存在时已注册 SPA fallback notFoundHandler,`main.ts:109` 又注册一遍。Fastify 不允许 → 启动时抛 `Error: Not found handler already set for Fastify instance with prefix: '/'`。tsx watch 把启动错误吞了
- **修复**: `main.ts` 只在 `registerStatic` 返回 undefined 时(即没有 dist)才注册自己的 404 handler
- **测试**: 新增 `sub-brain/tests/static-routes.test.ts`,4 个回归测试,包含"如果未来 Fastify 允许双注册,提醒我们可以删 guard"的反向断言
- **教训**: 单元测试覆盖路由模块独立行为,**没有任何测试覆盖 main.ts 启动序列**。本轮加的 static-routes.test.ts 是补丁,真正的补丁需要一个"完整启动一次 Fastify 实例"的 boot 集成测试。这是 #P1-后续

#### Issue #11 — 冲突检测完整闭环但生产从不调用(本轮已修复)
- **症状**: 存储 "用户叫王震宇" 和 "用户的名字是李四",看 /memory/conflicts → 空。两条都是 current=1,UI 上没有任何冲突提示
- **根因**: `MemoryManager._conflict_detector` 默认 None,`mm.set_conflict_detector(...)` 只在单元测试里被调用,**main_brain.py lifespan 从未注入**。整个 conflict_detector.py + 14 个测试 + 前端 ConflictCard UI 全部是死代码
- **修复**: lifespan 里在 MemoryManager 创建后 instantiate ConflictDetector + 注入 LLM caller 闭包 + `mm.set_conflict_detector()`
- **环境变量**: `WEBRAIN_CONFLICT_DETECTOR_DISABLED=1` 可关
- **教训**: **单元测试不能验证生产 wiring**。我所有冲突检测测试都直接 `mm.set_conflict_detector(detector)`,完全跳过了 lifespan 注入这一步。下一轮要做一个"从 lifespan 完整初始化 → 验证关键依赖都被 wire 上"的 smoke test
- **次级教训**: 用户试用 5 分钟就发现了 6 周代码量都没暴露的问题。**没有任何"端到端真实跑"的环节**就是这个原因

#### Issue #12 — 冲突阈值对中文太严(本轮已修复)
- **症状**: 即便 wiring 修了,"用户的名字是李四" vs "我叫王震宇" 仍然 `checked: 0` — 候选过滤掉了。手动 vector_search 显示两条 cosine sim 只有 0.52,远低于默认阈值 0.7
- **根因**: 多语种 MiniLM 在短 CJK 字符串上的 cosine 普遍低于英文。0.7 是英文 SBERT 时代经验值,不适合 CJK
- **修复**: DEFAULT_SIMILARITY_THRESHOLD 0.7 → 0.5,`WEBRAIN_CONFLICT_SIMILARITY_THRESHOLD` env 可覆盖。LLM 判断本身就是 false positive 的第二道滤网,候选放宽不致命
- **教训**: 任何阈值默认都应该是 **benchmark 跑过的**,不是想当然的。下一轮需要在 fixture 上 grid search 这个值

### P1 - 严重 UX

#### Issue #5 — 旧数据迁移后看不见
- **症状**: 启动后 `/memory/sync` 显示 60 个 L1 + 0 个 vector。我之前测试时存的所有 chat 记录都在,但 vector 索引没有 — 任何中文语义搜索都查不到它们
- **根因**: M-Memory-1 的 L1 默认 embedding 是 schema-level 变更(新行会被 embed),没有数据迁移(老行没有 vector 行)
- **未修复**: 留作后续。需要一个 idempotent backfill 脚本 / 启动时自动跑的迁移任务
- **影响**: 第一次升级到 M-Memory-1 的用户会看到"我的旧数据怎么搜不到了" → 困惑

#### Issue #4 — main-brain 初始化所有 state 然后才 bind 端口
- **症状**: 第一次启动时端口被占用,main-brain 跑完 Wiki / KG / Cron / Skill 初始化(~3 秒)才尝试 bind,失败后整套撤销
- **未修复**: 应该先 try-bind 一个 placeholder server,确认端口可用再做重活
- **影响**: 端口冲突时浪费时间 + 启动日志看着像成功但其实最后 crash

#### Issue #10 — sub-brain 自动 spawn main-brain 但用错 Python
- **症状**: 当 main-brain 没单独跑时,sub-brain 尝试 spawn `python main_brain.py` 子进程。系统 python 没有 watchdog → 子进程 ModuleNotFoundError
- **未修复**: spawn 应该用 `sub-brain/main-brain/venv/bin/python3` 而不是系统 python
- **影响**: 用户跟着 README 跑 `pnpm dev` 应该能一键启动,但实际上 main-brain 需要手动单独启,违反 README

#### Issue #7 — tsx watch 吞启动错误
- **症状**: Issue #8 的根因。`pnpm dev`(= `tsx watch src/main.ts`)在启动期间 throw,但 tsx 不打印,只是 hang 在那里
- **未修复**: 是 tsx 自己的行为,本项目无法直接改。但**我们可以在 sub-brain 入口加一个早期 try/catch + console.error**,让 fatal 错误至少打到 stderr
- **影响**: 上游错误的 debug 信号被截断

### P2 - 噪音 / 小坑

#### Issue #1 — README 说 Python 3.11+,但实际跑 3.9 也能用
- venv 用的是 3.9.6,测试全过。要么 README 改实际最低版本,要么 CI 测最低版本

#### Issue #3 — 启动时不感知 stale process
- 上次 main-brain 没清干净,新启动 port conflict。**没有 PID 文件 / lockfile 检测**
- 至少应该 startup 时检测一下 "我准备 bind 的端口当前是谁占的" → 友好提示

#### Issue #6 — 第一次 `pnpm dev` 输出仅 1 行 30 秒静默
- 即使没有 #8 那个崩溃,正常启动也太安静。Fastify 自己的 logger 没打到 stdout
- 可以在 main.ts 第一行打一个 banner: 版本号 + 启动时间 + 期望监听端口

#### Issue #9 — docker not found 时输出原始 Buffer dump
```
output: [ null, <Buffer >, <Buffer 2f 62 69 6e 2f 73 68 ...> ]
```
- 应该捕获 docker 探测 stderr 并 log "docker disabled (not on PATH)" 一行

#### Issue #2 — 上下文已自动清理但需要保留 main-brain 启动后 access_count=0 这个 UX 微调
- 用户存完一条 memory 立刻 query,看到 `access_count: 0`,容易困惑(我刚查了为什么是 0)
- 因为 `_increment_access` 是 query 返回 results **之后**才执行的 UPDATE。下次查询才会显示 access_count 增加
- 不算 bug,但前端 UI 可以加 "+1 (本次查询)" 提示

---

## 修复总结

| Issue | 状态 | 测试 | 备注 |
|---|---|---|---|
| #8 双重 notFoundHandler | ✅ 已修 | static-routes.test.ts × 4 | main.ts 加 guard |
| #11 冲突检测死代码 | ✅ 已修 | (依赖已有 14 个 test) | main_brain.py lifespan wire |
| #12 阈值对 CJK 太严 | ✅ 已修 | (现有 test 不受影响) | 0.7 → 0.5 + env override |
| #1 Python 版本 | ⏸️ doc | - | 改 README |
| #3 stale PID | ⏸️ | - | 加 startup probe |
| #4 重活在 bind 之前 | ⏸️ | - | 重排 lifespan 顺序 |
| #5 旧数据缺 embedding | ⏸️ | - | 写 backfill 迁移 |
| #6 启动太安静 | ⏸️ | - | 加 startup banner |
| #7 tsx 吞错误 | ⏸️ | - | main.ts 入口 try/catch |
| #9 docker 探测噪音 | ⏸️ | - | 静默处理 |
| #10 错的 Python | ⏸️ | - | spawn 用 venv |
| #2 access_count UX | ⏸️ | - | 前端文案 |

---

## 对开发流程的反思

**为什么这些问题没被代码评审 / 单元测试 / benchmark 抓住?**

1. **没有任何 boot smoke test**。所有测试都假设各组件已经构造好。`main.ts:109` 的双重 notFoundHandler 永远不会被任何单测触发,因为没有测试调用整个 lifespan
2. **冲突检测的 14 个单元测试全部通过 → 我误以为功能上线**。事实是单测只覆盖 `MemoryManager.set_conflict_detector(d) → 行为正确`,从来没测过 `lifespan → 自动 attach`。生产路径没有任何覆盖
3. **benchmark 用的是手工 fixture,不是用户真实数据**。fixture 里的对话刻意写得对比鲜明 → 冲突阈值 0.7 看似够用。真实 CJK 短句一上来就破掉了这个假设
4. **README 没有任何 "fresh install,从零跑起来" 的 e2e 验证**。我打字写"`pnpm dev` 启动 sub-brain"这一行,从来没真的从 fresh checkout 跑过这条路径

**结论**: 接下来如果继续做这个项目,必须建立**一个 e2e smoke test**:
- 从 checkout 出来
- 按 README 步骤启动 3 个服务
- 跑 5 个真实 API 调用(store / query / chat / dreaming / conflicts)
- 全部成功才算 green

这个测试要纳入 CI。即便它耗 60 秒。
