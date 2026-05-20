#!/usr/bin/env bash
# Demo data seeder (Round M1, 2026-05-21).
#
# Pushes a small, opinionated set of starter content into a running
# main-brain so a fresh install doesn't open into an empty void.
# Idempotent — re-running just overwrites the same entries.
#
# What it seeds
#   - 5  L1 memories (chat-style snippets)
#   - 3  L3 facts (long-term, fact-style)
#   - 3  RAG docs (under data/demo-docs/, indexed via /rag/index_file)
#   - 1  Wiki note (the "how this project works" intro)
#
# Usage
#   ./scripts/seed-demo-data.sh                       # default: http://127.0.0.1:18790
#   MAIN_BRAIN_URL=http://localhost:18790 ./scripts/seed-demo-data.sh
#   ./scripts/seed-demo-data.sh --dry-run             # show what would be sent
#
# Safe to run at any time. The seed contents are intentionally English+
# Chinese mix to also demo i18n behavior.

set -euo pipefail

MAIN_BRAIN_URL="${MAIN_BRAIN_URL:-http://127.0.0.1:18790}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEMO_DOC_DIR="${REPO_ROOT}/data/demo-docs"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) grep -E "^#" "$0" | sed -E 's/^# ?//'; exit 0 ;;
    *) echo "[seed] unknown arg: $1" >&2; exit 2 ;;
  esac
done

post() {
  local path="$1" body="$2"
  if [[ ${DRY_RUN} -eq 1 ]]; then
    echo "POST ${MAIN_BRAIN_URL}${path} :: ${body}"
    return 0
  fi
  local resp
  resp=$(curl -sS -X POST -H 'Content-Type: application/json' --max-time 15 \
              -d "${body}" "${MAIN_BRAIN_URL}${path}") || {
    echo "[seed] POST ${path} FAILED" >&2
    return 1
  }
  echo "${resp}" | head -c 240
  echo
}

# Probe main-brain first — fail fast with a useful message if it's down.
if [[ ${DRY_RUN} -eq 0 ]]; then
  if ! curl -sS --max-time 5 "${MAIN_BRAIN_URL}/health" >/dev/null 2>&1; then
    echo "[seed] main-brain not reachable at ${MAIN_BRAIN_URL}" >&2
    echo "[seed]   start it via: cd sub-brain/main-brain && source venv/bin/activate && python main_brain.py --port 18790" >&2
    exit 1
  fi
fi

echo "[seed] target: ${MAIN_BRAIN_URL}"

# ── L1 memories — short, recent, chat-style ──────────────────────────
echo "[seed] L1 memories…"
post /memory/store '{"level":"L1","content":"用户名:Master,默认语言中文。","session_id":"demo-onboarding","source":"system","importance":0.9}'
post /memory/store '{"level":"L1","content":"用户喜欢 Notion 风格 UI 和 dark mode。","session_id":"demo-onboarding","source":"chat","importance":0.6}'
post /memory/store '{"level":"L1","content":"目前在做的项目:WeBrain — 双脑 AI 集成平台。","session_id":"demo-onboarding","source":"chat","importance":0.85}'
post /memory/store '{"level":"L1","content":"机器:HUAWEI MateBook Pro, macOS 26.4.1 ARM64。","session_id":"demo-onboarding","source":"system","importance":0.5}'
post /memory/store '{"level":"L1","content":"打字时偏好 Enter 直接发送,Shift+Enter 换行。","session_id":"demo-onboarding","source":"chat","importance":0.4}'

# ── L3 facts — stable, fact-style, source=consolidation ──────────────
echo "[seed] L3 facts…"
post /memory/store '{"level":"L3","content":"RAG (Retrieval-Augmented Generation) 是把外部知识库检索结果作为上下文喂给 LLM,让模型回答超出训练数据的内容。","source":"fact","importance":0.95}'
post /memory/store '{"level":"L3","content":"WeBrain 架构是双脑:Sub Brain (Fastify/TS) 处理工具/插件/通道执行;Main Brain (FastAPI/Python) 负责推理/记忆/RAG。前端不直接连 Main Brain。","source":"fact","importance":0.95}'
post /memory/store '{"level":"L3","content":"Round J 系列引入了持久 Sandbox Workspaces — 长寿命 Docker 容器 + bind mount,跨调用保留 apt/pip 安装的工具和文件。","source":"fact","importance":0.9}'

# ── RAG demo docs ─────────────────────────────────────────────────────
echo "[seed] RAG demo docs…"
mkdir -p "${DEMO_DOC_DIR}"

cat > "${DEMO_DOC_DIR}/01-getting-started.md" <<'EOF'
# WeBrain Quick Start

WeBrain is a personal AI companion that runs entirely on your machine. It pairs a fast Node sub-brain (tools, plugins, channels) with a Python main-brain (reasoning, memory, RAG).

## Where to start
1. Chat in the main column — anything you'd ask a chatbot, ask here.
2. Drag a document into the right sidebar — `.md`, `.pdf`, `.docx`, `.txt`, `.json` all auto-index.
3. Click the gear icon top-right for the admin panel (agents, tools, sandbox, channels…).

## Memory levels
- **L1** — raw recent chat messages (~7 days)
- **L2** — daily summaries
- **L3** — consolidated long-term facts
- **L4** — high-frequency knowledge promoted to "always-on" context

The brain consolidates upward automatically during the dreaming pass.
EOF

cat > "${DEMO_DOC_DIR}/02-rag-explained.md" <<'EOF'
# How RAG works in WeBrain

When you upload a file, WeBrain splits it into ~500-token chunks, generates an embedding vector for each chunk with `all-MiniLM-L6-v2`, and stores them indexed by document.

At chat time the user's question is also embedded, the top-K (default 3) most similar chunks are retrieved, and they're injected into the chat system prompt as `## Retrieved context`. The AI's reply then cites those chunks as `[1] [2] [3]` footnotes under the message.

This is what lets you ask "what was that thing in Chapter 4?" without re-pasting the chapter.
EOF

cat > "${DEMO_DOC_DIR}/03-sandbox-workspaces.md" <<'EOF'
# Sandbox workspaces (Round J)

If Docker is installed, WeBrain can give the AI a long-lived Linux container to work in. Files installed packages (apt-get, pip install) survive between calls — the AI can actually iterate on a real environment instead of starting from scratch every turn.

Create a workspace from the admin Sandbox page, enable network if needed, optionally restrict outbound to a whitelist of domains. The bind mount lives at `~/.webrain/workspaces/<id>/` and survives container restarts.
EOF

post /rag/index_file "$(printf '{"path":"%s/01-getting-started.md"}' "${DEMO_DOC_DIR}")"
post /rag/index_file "$(printf '{"path":"%s/02-rag-explained.md"}' "${DEMO_DOC_DIR}")"
post /rag/index_file "$(printf '{"path":"%s/03-sandbox-workspaces.md"}' "${DEMO_DOC_DIR}")"

# ── Wiki note — the "how this project works" intro ───────────────────
echo "[seed] wiki note…"
post /wiki/notes '{"id":"demo-intro","title":"WeBrain 入门","content":"WeBrain 是一个本地 AI 伴侣。三层架构:Frontend (Vite/React) → Sub Brain (Fastify/TS) → Main Brain (FastAPI/Python)。Sub Brain 跑工具/插件/通道/沙箱,Main Brain 跑推理/记忆/RAG/Wiki。\n\n核心特性:\n- 双脑 + 进程间 UDS 通信\n- L1→L4 四级记忆 + 自动 consolidation\n- RAG 文档索引 + 引用编号\n- 持久 Sandbox Workspaces (Round J)\n- 用户/管理端分离 UI (Round I)\n\n开始用:在聊天框对话,上传文档建知识库,点齿轮进管理端。","tags":["intro","architecture"]}'

if [[ ${DRY_RUN} -eq 0 ]]; then
  echo
  echo "[seed] done · 5 L1 + 3 L3 memories, 3 RAG docs, 1 wiki note"
  echo "[seed] refresh UserHomePage to see the new RAG docs in the right sidebar"
else
  echo "[seed] dry-run only — no requests sent"
fi
