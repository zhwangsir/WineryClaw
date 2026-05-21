# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Scope reminder.** The umbrella `~/WeBrain/CLAUDE.md` says: only `webrain-integration/` is actively developed. When the user says "the project," they mean this directory. `hermes-agent-main/` and `openclaw-main/` are reference-only.
>
> **Don't duplicate.** `README.md` covers user-facing setup, ports, and the architecture diagram. `docs/PROJECT_STATE.md` is the canonical state-of-the-project doc — read it on a fresh session to sync the full history. This file documents non-obvious things that are easy to get wrong.

> **Round labels** (used in commits + `docs/PROJECT_STATE.md`):
> `B` = core feature · `C` = smoke-test surface · `D` = benchmark / data tuning · `E` = audit-fix · `F` = frontend / performance · `G` = OSS prep · `H` = DB tuning · `I` = UI refactor · `J` = sandbox runtime · `K` = user-mode UX · `L` = ops + hardening.

> **Current test totals** (2026-05-22, post Round S S5–S10):
> **450** sub-brain unit + 1216 frontend unit + **485** main-brain unit + 53 backend smoke + **89** Playwright e2e (21 page-smoke + 15 functional-real + 39 functional-deep + 14 hermetic) + 5 benchmarks. **All green.**
>
> Playwright workers=5, retries=1 (local). functional-deep covers 10 groups: Skills/KG/Memory/Wiki/Agents/Chat/Dashboard/MemoryUI/DataOps/ErrorBounds + 3 cross-feature pipelines.

> **Sandbox runtime decision** — see `docs/adr/0001-sandbox-runtime.md`. We stay on the in-house `DockerSandbox` + workspace mode; do not refactor toward E2B / OpenHands without first re-reading that ADR's "Triggers for revisiting" list.

---

## Commands

### Setup (one-time)

```bash
# main-brain Python venv (REQUIRED — sub-brain spawns this Python interpreter
# by preference; see sub-brain/src/main-brain-spawn.ts)
cd sub-brain/main-brain && python3 -m venv venv && \
  ./venv/bin/pip install -r requirements.txt && cd ../..

# Sub-brain + frontend
cd sub-brain && pnpm install && cd ..
cd frontend && pnpm install && cd ..

# Quick check that everything's in place
./scripts/verify-install.sh
```

### Run all three services in dev

```bash
# Terminal 1 — main-brain (FastAPI on UDS by default, or TCP if WEBRAIN_MAIN_BRAIN_PORT set)
cd sub-brain/main-brain && source venv/bin/activate && python main_brain.py

# Terminal 2 — sub-brain (Fastify on :3000)
cd sub-brain && pnpm dev

# Terminal 3 — frontend (Vite HMR on :8587)
cd frontend && pnpm dev
```

Note: sub-brain `pnpm dev` will auto-spawn its own main-brain if one isn't already running. To prevent that during smoke tests or when you've started main-brain manually, set `WEBRAIN_NO_MAIN_BRAIN=1`.

### Test commands

| What | Where | Command |
|---|---|---|
| Main-brain unit | `sub-brain/main-brain/` | `pytest` (default — excludes smoke + benchmark) |
| Main-brain smoke (~6 min, spawns services) | same | `pytest -m smoke tests/smoke/ -s --no-cov` |
| Main-brain benchmarks | same | `pytest -m benchmark -s --no-cov` |
| Main-brain single test by name | same | `pytest -k "test_chat_no_tools"` |
| Main-brain single benchmark | same | `pytest -m benchmark -s tests/test_rerank_impact.py` |
| Sub-brain unit (vitest) | `sub-brain/` | `pnpm exec vitest run` |
| Sub-brain single file | same | `pnpm exec vitest run tests/proxy.test.ts` |
| Sub-brain type-check | same | `pnpm exec tsc --noEmit` |
| Frontend unit (vitest + jsdom) | `frontend/` | `pnpm exec vitest run` |
| Frontend e2e (Playwright, all hermetic-mocked) | `frontend/` | `pnpm exec playwright test` |
| Frontend e2e single file | same | `pnpm exec playwright test e2e/chat-flow.spec.ts` |
| Frontend type-check | same | `pnpm exec tsc --noEmit` |
| Frontend lint | same | `pnpm lint` (read) or `pnpm lint:fix` (autofix) |
| Umbrella integration (needs `:3000` + `/brain/health` live) | `webrain-integration/` | `pnpm exec vitest run` |
| Single integration by name | same | `pnpm exec vitest run -t "memory search"` |

### Common verification flow

```bash
./scripts/verify-install.sh             # deps + venv + node_modules sanity
./scripts/verify-install.sh --smoke     # adds e2e smoke (~50s, spawns services)
```

---

## Architecture: non-obvious facts

The README has the diagram. These are the things that are easy to get wrong and aren't in the diagram:

### Execution split

- **Sub-brain is the execution layer.** Tools, plugins, channels, browser, sandbox, MCP, CLI all run here. Main-brain only does reasoning / memory / wiki / KG / model routing.
- **Frontend never reaches main-brain directly.** Sub-brain exposes `/brain/*` as a pass-through proxy. For health checks of main-brain, use `GET /brain/health`.
- **Proxy is intentionally not allowlisted** (`sub-brain/src/server/proxy.ts`). But it now **strips `x-forwarded-*` / `x-real-ip`** before forwarding (Round E2 hardening) — see comments inline.
- **Authorization headers ARE forwarded.** The Round C4 smoke caught that the proxy used to strip them; required for MCP write-tool bearer auth.

### Transport selection (sub-brain → main-brain)

In `sub-brain/src/main.ts`:
- If neither `WEBRAIN_MAIN_BRAIN_UDS` nor `WEBRAIN_MAIN_BRAIN_PORT` is set → UDS (`/tmp/webrain-main.sock`).
- If `WEBRAIN_MAIN_BRAIN_PORT` is set → TCP to that port.
- Stale UDS sockets cause boot failure — clean before restart if you switch.

### Main-brain bind + data dir

- `main_brain.py` reads `--port`/`--uds` argparse args + `WEBRAIN_DATA_DIR` env.
- **The data dir is the project's `data/main-brain/` directory by default.** Smoke tests set `WEBRAIN_DATA_DIR=<tmp>` to avoid polluting it. If you see hundreds of orphan rows accumulating in dev, that's why.
- The port-bind happens BEFORE heavy lifespan init (sentence-transformers, etc.) so port conflicts fail fast — don't move that probe.

### LLM config reload

`POST /config/reload` on main-brain re-fetches LLM config from sub-brain's `/config/model`, then **must propagate the new config to every engine that holds its own copy**: chat, reasoning, dreaming, active_memory, kg, planner, AND the SkillReflector's pre-built llm_call closure. See `main_brain.py` near line 730. This is a recurring bug class — every engine that closes over `llm_config` at boot needs explicit handling here.

### Sub-brain auto-spawn of main-brain

Sub-brain's `main.ts` will spawn its own main-brain child unless `WEBRAIN_NO_MAIN_BRAIN=1`. The spawned child uses the venv interpreter discovered by `pickPythonInterpreter` (`sub-brain/src/main-brain-spawn.ts`). If venv is missing, it falls back to system `python3` with a loud warning. **Don't silently fall back without warning** — the user will spend hours debugging ModuleNotFoundError.

### Frontend stores

- `frontend/src/stores/` is the live Zustand layer.
- `frontend/src/store/` (singular) is empty legacy — don't add anything there.
- Every HTTP call goes through `frontend/src/api/*.ts`. When adding/renaming a frontend route, verify the matching endpoint exists in `sub-brain/src/server/`.

---

## Environment variable cheat sheet

| Var | Service | Default | Effect |
|---|---|---|---|
| `WEBRAIN_MAIN_BRAIN_UDS` | sub-brain | `/tmp/webrain-main.sock` | UDS path. Set this OR `WEBRAIN_MAIN_BRAIN_PORT`, not both. |
| `WEBRAIN_MAIN_BRAIN_PORT` | sub-brain | `18790` | Forces TCP transport to main-brain. |
| `WEBRAIN_SUB_BRAIN_URL` | main-brain | `http://127.0.0.1:3000` | Where main-brain fetches `/config/model` from. Smoke fixtures set this to the spawned sub-brain's port. |
| `WEBRAIN_NO_MAIN_BRAIN` | sub-brain | unset | If `1`, sub-brain skips auto-spawning a main-brain child. Useful when running main-brain manually. |
| `WEBRAIN_DATA_DIR` | main-brain | `<repo>/data/main-brain/` | Override data dir. Smoke uses a tmpdir so it doesn't pollute the dev DB. |
| `WEBRAIN_MCP_TOKEN` | main-brain | auto-generated to `~/.webrain/mcp_token` | Bearer token for MCP write tools. Smoke fixtures pin it. |
| `WEBRAIN_CONFLICT_LLM_TIMEOUT_S` | main-brain | `20` | Per-candidate timeout for the conflict-judge LLM call. Smoke sets `2` to avoid hangs against unreachable mock URLs. |
| `WEBRAIN_LLM_HEALTH_DISABLED` | main-brain | unset | If `1`, skips the background LLM-endpoint health monitor. Smoke uses this. |
| `WEBRAIN_RELEVANCE_WEIGHT` | main-brain | `0.7` | Blender weight (memory retrieval). Round D2 picked this with rerank=True. |
| `WEBRAIN_IMPORTANCE_WEIGHT` | main-brain | `1 - RELEVANCE` | Auto-derived; set only if you want non-complementary weights. |
| `WEBRAIN_ACTIVE_MEMORY_ENABLED` | main-brain | `1` | Set to `0` to disable fire-and-forget ActiveMemory pattern extraction from chat. |
| `WEBRAIN_PLANNER_ENABLED` | main-brain | `1` | Set to `0` to skip the Planner phase even when a Planner is wired. |
| `WEBRAIN_RAG_TOP_K` | main-brain | `3` | Top-K chunks injected into chat system prompt. |
| `WEBRAIN_RAG_MIN_SCORE` | main-brain | `0.0` | Minimum cosine to include a RAG chunk. |
| `WEBRAIN_PYTHON` | sub-brain spawn | (auto-pick from venv) | Override Python interpreter when sub-brain spawns main-brain. |
| `WEBRAIN_EMBEDDED` | main-brain | unset | Set to `1` automatically by sub-brain when spawning main-brain as a child. |
| `WEBRAIN_HYDE_ENABLED` | main-brain | `1` | Round S1: HyDE 记忆检索增强。每次记忆查询前额外一次 LLM 调用生成假设答案文档用于向量检索，显著提升知识密集型问答的 recall。设为 `0` 禁用（降低延迟但会损失检索精度）。 |
| `WEBRAIN_HYDE_MAX_TOKENS` | main-brain | `120` | HyDE 假设答案文档的最大 token 数。 |
| `WEBRAIN_REFLECTION_ENABLED` | main-brain | `0` | Round S2: 反思循环。答复生成后自动评分，分低则修订（额外 1-2 次 LLM 调用）。默认关闭以控制延迟。 |
| `WEBRAIN_REFLECTION_THRESHOLD` | main-brain | `3` | 反思触发分数阈值（1-5）。低于该值时触发修订。 |
| `WEBRAIN_WORKING_MEMORY_ENABLED` | main-brain | `1` | Round S3: 会话工作记忆。每轮对话后异步提取 3-5 条关键事实，注入下轮系统提示，防止长对话中重要信息丢失。 |
| `WEBRAIN_WORKING_MEMORY_MAX` | main-brain | `10` | 每个会话最大工作记忆条数（超出后滚动淘汰旧条目）。 |
| `WEBRAIN_TOOL_CACHE_TTL` | main-brain | `300` | Round S4: 只读工具结果缓存 TTL（秒）。同一会话内相同参数的 file_read / http_request GET 命中缓存时跳过子脑调用。 |
| `WEBRAIN_CONTEXT_COMPRESS_ENABLED` | main-brain | `1` | Round S5: 上下文压缩。工具调用链超过阈值时自动压缩中间历史，防止上下文窗口溢出。设为 `0` 禁用。 |
| `WEBRAIN_CONTEXT_COMPRESS_THRESHOLD` | main-brain | `12` | 触发上下文压缩的消息条数阈值。超过此数量时对中间消息进行 LLM 摘要压缩。 |
| `WEBRAIN_CONTEXT_COMPRESS_KEEP` | main-brain | `4` | 压缩时保留的最近消息条数（不压缩的末尾窗口）。 |
| `WEBRAIN_DEDUP_ENABLED` | main-brain | `1` | Round S7: 语义去重。L2→L3 提取新事实前先做向量相似度检查，与现有 L3 高度相似（超过阈值）则更新已有行而非新建重复条目。设为 `0` 禁用（禁后每次 Dreaming 都会创建潜在重复行）。 |
| `WEBRAIN_DEDUP_THRESHOLD` | main-brain | `0.85` | L3 语义去重的余弦相似度阈值（0-1）。超过此值视为重复，触发合并而非新建。调低可减少误合并；调高可减少漏合并。 |
| `WEBRAIN_USER_PROFILE_ENABLED` | main-brain | `1` | Round S8: 持久化用户上下文。将 L3/L4 中的 [preference]/[goal] 事实无条件注入每次对话的系统提示，使 AI 时刻感知用户风格偏好（不依赖查询相关性）。设为 `0` 禁用。 |
| `WEBRAIN_USER_PROFILE_TOP_K` | main-brain | `5` | S8 用户画像最多注入多少条 [preference]/[goal] 事实。 |
| `WEBRAIN_USER_PROFILE_TTL` | main-brain | `60` | S8 用户画像缓存有效期（秒）。到期后下次对话重新查 DB。 |
| `WEBRAIN_KG_CONTEXT_ENABLED` | main-brain | `1` | Round S9: KG 上下文注入。每次对话时用消息关键词检索知识图谱，将命中实体及其一跳关系注入系统提示，使 AI 能利用跨会话积累的结构化实体知识。纯内存操作，延迟 <1ms。设为 `0` 禁用。 |
| `WEBRAIN_KG_CONTEXT_TOP_K` | main-brain | `3` | S9 每次最多注入多少个 KG 实体。 |
| `WEBRAIN_KG_CONTEXT_MAX_RELS` | main-brain | `3` | S9 每个实体最多展开多少条直接关联关系。 |
| `WEBRAIN_CONV_ANCHOR_ENABLED` | main-brain | `1` | Round S10: 会话锚点。新会话第一条消息时，在向量空间检索近期相关 L2 对话摘要注入系统提示，帮助 AI 维持跨会话对话脉络（"上次我们在讨论..."）。后续消息不触发。设为 `0` 禁用。 |
| `WEBRAIN_CONV_ANCHOR_TOP_K` | main-brain | `2` | S10 最多注入多少条近期相关对话摘要。 |
| `WEBRAIN_CONV_ANCHOR_DAYS` | main-brain | `7` | S10 只检索最近多少天内的 L2 摘要（超出则过滤）。 |

---

## Test layer cheat sheet

There are four distinct test layers — pick the right one for what you're verifying:

| Layer | Files | What it catches | Cost |
|---|---|---|---|
| **Unit** | `sub-brain/tests/*.test.ts`, `frontend/src/**/*.test.tsx`, `sub-brain/main-brain/tests/test_*.py` (no marker) | Logic, type, branch | <2 min total |
| **Smoke** (e2e backend) | `sub-brain/main-brain/tests/smoke/test_e2e_*.py` | Wiring bugs, config-reload propagation, FastAPI param mapping, proxy header behavior | ~6 min, real subprocesses |
| **Playwright** (e2e frontend) | `frontend/e2e/*.spec.ts` | UI mount/render, backend response handling, security (token-leak) — all hermetic via `page.route()` | <30 s |
| **Benchmark** | `sub-brain/main-brain/tests/test_*benchmark*.py`, `test_blender_grid.py`, `test_rerank_impact.py`, `test_chat_latency_benchmark.py` | Recall/MRR regression, blender weight optimality, P50/P95 latency | 2-5 min each, opt-in only |

**Why the smoke layer exists.** The autonomous session 2026-05-20 caught 5 production bugs through smoke (closure-captured stale config × 2, FastAPI `Any → query` mapping, proxy header strip, vector-level filter bypass) and another 7 via code-reviewer audit — none of which the 1988 unit tests touched. The smoke pattern is `spawn real services + mock LLM + assert HTTP-level contracts`. See `tests/smoke/conftest.py` for the fixture machinery.

**Mock LLM** lives at `sub-brain/main-brain/tests/smoke/mock_llm_server.py`. It branches on prompt content:
- "fact contradiction judge" → JSON `{contradicts, reason}` (configurable via `PUT /__debug/conflict-mode`)
- "memory consolidation expert" → echoes source so FTS keeps matching
- else → `MOCK-LLM-REPLY` sentinel

---

## Hot bug-pattern reminders

These are the architectural traps the smoke + audit layers kept catching. When adding new code, check for them explicitly:

1. **Closure capture of `llm_config` at lifespan boot.** Any async helper that uses `llm_config` must read from `_state["chat"].llm_config` dynamically (or be rebuilt by `/config/reload`). The `_conflict_llm_caller` and `SkillReflector` both had this bug.

2. **FastAPI `request: Any`** — gets mapped to a query parameter, not the body. Use `request: Dict[str, Any]` OR `request: Any = Body(...)`. The `/mcp/jsonrpc` endpoint was completely broken for 6 weeks because of this.

3. **`asyncio.create_task` without retaining the Task** — CPython's GC can collect it mid-flight. Always store in a set + `add_done_callback(set.discard)`. The `ChatEngine._fire_active_memory_async` pattern is the reference.

4. **Sync ML inference on the event loop.** `reranker.predict(pairs)` and `embedder.encode(text)` are CPU-bound; wrap in `loop.run_in_executor(None, ...)`. Cold-loading them can cost 10-30s of total event-loop block.

5. **SQLite single-writer lock** — concurrent `memory.store` calls serialize. The chat-latency benchmark shows 30 concurrent calls take ~2.1s each. If you need more throughput, consider WAL mode or batched writes (not yet done).

6. **Lazy-loaded singletons need a `threading.Lock` for double-checked init.** Both `_get_embedder` and `_get_reranker` in `memory_manager.py` use this pattern — copy it for any new ML model load.

7. **`/brain/*` proxy strips most non-`x-*` headers.** When adding a new auth scheme that needs custom headers, either use `Authorization`, an `x-*` name, or extend the explicit forward list in `sub-brain/src/server/proxy.ts`.

---

## Code style conventions

- **ESM throughout.** Relative TypeScript imports in sub-brain must end in `.js` (per `tsconfig` resolution). Frontend uses the same.
- **Docs and inline comments are predominantly zh-CN.** Match the local style unless asked otherwise.
- **Python 3.9+ required.** main-brain runs on the venv interpreter.
- **Node 22+** for sub-brain and frontend.
- **No `console.log` left in production code** — sub-brain uses pino (`request.log`), main-brain uses `logger`. Browser code can use console during dev but not in committed code.
- **Don't add `|| true` to CI commands.** Tests must actually fail loudly.

---

## Things to leave alone

- `hermes-agent-main/`, `openclaw-main/` — reference-only, do not touch.
- `frontend/src/store/` (singular) — legacy stub, gets removed eventually.
- `data/main-brain/` — runtime data. Polluting it with dev/test artifacts is a real maintenance burden; use `WEBRAIN_DATA_DIR=<tmp>` for tests.
- `sub-brain/data/` — created at runtime, gitignored.
- `dist/`, `node_modules/`, `venv/`, `htmlcov/` — all build artifacts, gitignored.
- The Main↔Sub wire protocol (`protocol/protocol.md`) is intentionally unauthenticated and CORS-open. Don't add auth/rate-limit there unless explicitly asked.

---

## Where to look for context

- **`README.md`** — user-facing setup, ports, architecture diagram.
- **`docs/PROJECT_STATE.md`** — the single source of truth for "what's the state of the project right now." Section anchors worth knowing:
  - §1–13 — session-by-session development history
  - §14 — Memory benchmark baselines (recall@5/10, MRR; blender grid results both with and without rerank)
  - §15 — Chat latency baseline (sequential P50/P95/P99 + concurrent P95)
- **`docs/USER_TRIAL_2026-05-20.md`** — the user trial that surfaced the bug classes the smoke layer now catches.
- **`CONTRIBUTING.md`** — dev workflow, branch naming, commit-style conventions, test-layer expectations for PRs (bilingual zh-CN + English).
- **`LICENSE`** — MIT.
- **`~/WeBrain/CLAUDE.md`** — umbrella scope rules (the "only webrain-integration/" rule).
- **`~/CLAUDE.md`** — global user preferences (response language, Karpathy rules, Superpowers pipeline).
