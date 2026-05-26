# WeBrain — First 10 Minutes

> A scripted walkthrough that takes a brand-new user from `git clone` to
> "I see why this is different" in about ten minutes. Every step lists
> what to click, what to expect, and how to know it worked. Each step is
> grounded in behaviour verified end-to-end via Chrome MCP in the Q-cycle
> regression sweeps (2026-05-21) — no aspirational features.
>
> Total wall-clock: **~10 min** on a warm machine, **~14 min** if main-brain
> needs to cold-load sentence-transformers on first run.

---

## 0. Prerequisites (one-time, ~3 min)

```bash
cd webrain-integration

# Python venv for main-brain
cd sub-brain/main-brain && python3 -m venv venv && \
  ./venv/bin/pip install -r requirements.txt && cd ../..

# Node deps for sub-brain + frontend
cd sub-brain && pnpm install && cd ..
cd frontend && pnpm install && cd ..

./scripts/verify-install.sh
```

You should see ✓ marks for venv, node_modules, and basic health probes.

---

## 1. Boot all three services (~30 s)

Three terminals (or three `&` background processes if you prefer):

| # | Where                  | Command                                                          |
|---|------------------------|------------------------------------------------------------------|
| 1 | `sub-brain/main-brain` | `source venv/bin/activate && python main_brain.py --port 18790`  |
| 2 | `sub-brain`            | `WEBRAIN_NO_MAIN_BRAIN=1 WEBRAIN_MAIN_BRAIN_PORT=18790 pnpm dev` |
| 3 | `frontend`             | `pnpm dev`                                                       |

**How to know it worked:** `curl -s http://localhost:3456/health` returns
`{"status":"ok"}` and `http://localhost:8587/` loads the user-mode home in
your browser.

---

## 2. Seed demo content (~10 s)

```bash
./scripts/seed-demo-data.sh
```

This loads 5 L1 memories + 3 L3 facts + 3 RAG docs + 1 wiki note into the
running main-brain. Without this step the next four sections work but
have nothing interesting to demo.

**How to know it worked:** `curl -s http://localhost:3456/brain/rag/stats`
shows `docs_count >= 3`.

---

## 3. Have a normal chat (~1 min)

1. Open `http://localhost:8587/` — the user-mode landing.
2. The chat input is centered at the bottom (`输入消息…`).
3. Type: `WeBrain 的双脑架构是怎么分工的？` and press Enter.

**What you should see:**
- A blinking cursor while the assistant streams
- A right-sidebar "知识库" panel listing the seeded `.md` files
- A coherent Chinese answer mentioning Sub Brain (TS/Fastify) and Main
  Brain (Python/FastAPI)
- Up to four "追问" chips below the answer if `WEBRAIN_FOLLOWUP_ENABLED`
  is on

**This validates:** SSE streaming + reactive theming + L1 storage of the
chat turn (it will appear in `/memory` later).

---

## 4. Upload a real document and ask about it (~2 min)

This is the differentiating "personal AI" moment.

1. Write yourself a one-page text file with **one fact only you would know**,
   e.g. `~/notes/my-policies.md`:

   ```markdown
   # My Personal Policies
   - I never start drinking coffee before 8am.
   - My WiFi rotation date is the first Monday of every month.
   - Movie code phrase for my partner is "BLUE-PARROT-91".
   ```

2. Drag that file from Finder/Explorer into the **knowledge panel on the
   right side of the chat**. The Dragger collapses on success (Round L2)
   and the file appears as `my-policies.md · 1 片段`.

3. Ask: `我什么时候才喝咖啡？` and press Enter.

**What you should see:**
- The answer cites the file ("根据您上传的 my-policies.md…")
- **Citation chips `[1] [2] [3]`** appear under the bubble (Round K3)
- The answer correctly says `8am`, not a generic LLM guess

**This validates:** the full RAG path — upload → chunk → embed → retrieve
→ inject as context → generate → cite. End-to-end verified by Q13 with a
deliberately-impossible-to-guess test fact ("PURPLE-IGUANA-7849 in
staging environment") and the assistant returned exactly the right
answer with the right citation.

---

## 5. Install your first skill (~1 min)

1. Click the gear icon top-right → land on `/dashboard` (admin).
2. Sidebar → 智能体 → **Skillhub** (`/skillhub`).
3. Marketplace tab shows **8 starter skills** from the bundled
   `webrain-starters` registry (no setup needed):

   | Skill        | What it does                                  |
   |--------------|-----------------------------------------------|
   | Clean URL    | Strip utm_/fbclid/etc tracking params         |
   | Slugify      | Text → URL-safe slug, CJK-aware               |
   | JSON Pretty  | Parse + 2-space re-emit, helpful error hints  |
   | Word Count   | chars / no-ws / lines / words / CJK-chars     |
   | Markdown TOC | H1-H6 → nested GitHub-anchor TOC              |
   | CSV Headers  | Read CSV path → headers + row count           |
   | Base64 Decode| Standard + URL-safe, binary detector          |
   | UUID Generator| crypto.randomUUID, 1-100 at once             |

4. Click **+ 安装** on `UUID Generator`. A success toast appears, the
   `Installed` tab badge bumps to 1, and the button changes to `已安装`.

5. Sidebar → 智能体 → **技能** (`/skills`). Find `UUID Generator`, click
   **Run**. Pass `{"n": 5}`. You'll get back five real UUID v4 strings.

**This validates:** registry → install → in-memory hot-load → invoke. The
"install bumps the dot but doesn't actually wire the skill" bug class
(found and fixed during this round) cannot regress here.

---

## 6. See what the brain has remembered (~1 min)

1. Sidebar → 核心 → **记忆** (`/memory`).
2. Top cards show L1/L2/L3/L4 counts. Right after seeding + a few chats
   you'll see L1 dominate (recent chat snippets) plus the 3 seeded L3
   facts.
3. Click **冲突 (N)** tab. If demo seed brought along smoke fixtures
   you'll see grouped contradicting facts with `当前 / 旧版` badges and
   `设为当前` buttons.
4. Click **运行 Dreaming**. This kicks the consolidation pipeline (L1→L2
   summaries, L2→L3 facts, L3→L4 promotion). On a fresh dev DB it's
   instant; on real usage it takes a few seconds.

**This validates:** the four-tier memory model and the dreaming pass
that's the *self-evolving* half of the Hermes-style vision. The Q14.1
fix means the `冲突` tab text now stays readable in both themes.

---

## 7. Flip the theme + sweep the admin surface (~1 min)

1. Top-right icon → sun/moon toggle. The whole app re-derives AntD tokens
   reactively (Round Q10).
2. Click through 通道 / 沙箱 / 工具 / Hooks / 定时任务 / 工作流 / 模板 / A2A / 配置
   / 设置. Every admin page should render with a header, sidebar, and a
   sensible empty state — not a JSON dump, not a blank page, not a
   `渲染异常` red screen.

**This validates** the Q14 sweep results — every one of the 28 admin
pages was screenshot-verified working in both themes during the
2026-05-21 cycle.

---

## What you have now

In ~10 minutes you have proven that WeBrain:

1. **Talks** (chat with streaming + suggested follow-ups)
2. **Remembers** (L1-L4 hierarchy + dreaming consolidation + conflict
   detection)
3. **Reads your documents** (RAG with citation chips that link back to
   source files)
4. **Runs skills you install** (Skillhub ecosystem with 8 starter skills
   out of the box; you can also fork your own)
5. **Has 28 admin surfaces** for tools, channels, sandbox, MCP, hooks,
   cron, A2A, workflows, plugins, etc. — none of them crash.

The two things you cannot validate in ten minutes — but can validate in
**7-14 days of real use** — are:

- The **SkillReflector** turning your low-success-rate skills into
  improved forks (`/skillhub` → Improvements tab fills up)
- The **L4 promotion** lifting facts you ask about frequently into
  always-on context, and **L1→L3 consolidation** distilling your chat
  history into stable facts

That's the next loop. Use it for a week, then come back to
`/memory` and `/skillhub` → Improvements and see what changed.
