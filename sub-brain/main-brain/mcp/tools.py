"""Tool registry for the webrain MCP server.

Each `ToolSpec` declares a tool's MCP name, description, and input
schema. The matching `ToolHandler` is an async callable that takes a
state dict (the main_brain `_state` dict, threaded through at dispatch
time) and the tool's `arguments`, and returns a value that MCP will
wrap as `{"content": [{"type": "text", "text": json.dumps(value)}]}`.

We expose 6 tools at v1:

  webrain_memory_query   — semantic memory search across levels
  webrain_memory_recent  — recent memories (chronological)
  webrain_rag_query      — RAG document chunk retrieval
  webrain_rag_stats      — RAG corpus statistics
  webrain_wiki_search    — search wiki notes by content
  webrain_kg_search      — search knowledge graph entities

All read-only on purpose. v1 doesn't expose mutation tools (memory_store,
wiki_create, etc.) because there's no auth gate on the MCP endpoint
yet — read-only is the safe default.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, List

from .protocol import INTERNAL_ERROR, INVALID_PARAMS, MCPError

logger = logging.getLogger("webrain.mcp.tools")

# A handler receives the main_brain `_state` dict and the tool's `arguments`
# from `tools/call`, and returns the raw result (any JSON-serialisable value).
ToolHandler = Callable[[Dict[str, Any], Dict[str, Any]], Awaitable[Any]]


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    input_schema: Dict[str, Any]
    handler: ToolHandler
    # M4b.1: "read" tools are open-access (read-only over webrain state);
    # "write" tools mutate state and require a valid bearer token.
    # Default is "read" to keep tooling that doesn't set scope explicitly
    # on the safe side.
    scope: str = "read"

    def to_dict(self) -> Dict[str, Any]:
        """MCP shape returned by `tools/list`."""
        return {
            "name": self.name,
            "description": self.description,
            "inputSchema": self.input_schema,
            # Custom annotation — MCP spec doesn't standardize "scope" yet,
            # but informational fields are tolerated and the frontend uses it.
            "scope": self.scope,
        }


# ---------------------------------------------------------------------------
# Handlers
# ---------------------------------------------------------------------------


def _require(state: Dict[str, Any], key: str) -> Any:
    """Look up a subsystem in `_state` or raise INTERNAL_ERROR.

    We surface the missing key as an internal error rather than letting a
    KeyError leak — clients should see a structured MCP error.
    """
    obj = state.get(key)
    if obj is None:
        raise MCPError(INTERNAL_ERROR, f"subsystem '{key}' not initialized")
    return obj


def _require_str(args: Dict[str, Any], key: str) -> str:
    value = args.get(key)
    if not isinstance(value, str) or not value.strip():
        raise MCPError(INVALID_PARAMS, f"'{key}' is required and must be a non-empty string")
    return value


async def _memory_query(state: Dict[str, Any], args: Dict[str, Any]) -> Any:
    memory = _require(state, "memory")
    query = _require_str(args, "query")
    levels = args.get("levels") or ["L2", "L3"]
    limit = int(args.get("limit", 10))
    if not isinstance(levels, list):
        raise MCPError(INVALID_PARAMS, "'levels' must be an array of level strings")
    results = await memory.query({"query": query, "levels": levels, "limit": limit})
    return {"results": results, "count": len(results)}


async def _memory_recent(state: Dict[str, Any], args: Dict[str, Any]) -> Any:
    memory = _require(state, "memory")
    level = args.get("level")  # optional
    limit = int(args.get("limit", 20))
    results = await memory.get_recent(level, limit)
    return {"memories": results, "count": len(results)}


async def _rag_query(state: Dict[str, Any], args: Dict[str, Any]) -> Any:
    rag = _require(state, "rag")
    query = _require_str(args, "query")
    k = int(args.get("k", 5))
    try:
        chunks = rag.retrieve(query, k=k)
    except Exception as e:
        raise MCPError(INTERNAL_ERROR, f"rag retrieve failed: {type(e).__name__}: {e}")
    # Normalize Chunk dataclass to dict for JSON serialization
    out = [
        {
            "doc_path": c.doc_path,
            "chunk_idx": c.chunk_idx,
            "text": c.text,
            "score": c.score,
        }
        for c in chunks
    ]
    return {"chunks": out, "count": len(out)}


async def _rag_stats(state: Dict[str, Any], _args: Dict[str, Any]) -> Any:
    rag = _require(state, "rag")
    try:
        s = rag.stats()
    except Exception as e:
        raise MCPError(INTERNAL_ERROR, f"rag stats failed: {type(e).__name__}: {e}")
    return s


async def _wiki_search(state: Dict[str, Any], args: Dict[str, Any]) -> Any:
    wiki = _require(state, "wiki")
    query = _require_str(args, "query")
    limit = int(args.get("limit", 20))
    try:
        # WikiEngine.search returns notes; if absent, fall back to list_notes filter
        if hasattr(wiki, "search"):
            results = wiki.search(query, limit=limit)
        else:
            all_notes = wiki.list_notes() if hasattr(wiki, "list_notes") else []
            q = query.lower()
            results = [
                n for n in all_notes
                if q in (n.get("title", "") + " " + n.get("content", "")).lower()
            ][:limit]
    except Exception as e:
        raise MCPError(INTERNAL_ERROR, f"wiki search failed: {type(e).__name__}: {e}")
    return {"notes": results, "count": len(results)}


async def _memory_store(state: Dict[str, Any], args: Dict[str, Any]) -> Any:
    """Write tool — append a new memory entry. Requires bearer auth."""
    memory = _require(state, "memory")
    content = _require_str(args, "content")
    level = str(args.get("level", "L2")).strip() or "L2"
    if level not in ("L1", "L2", "L3", "L4"):
        raise MCPError(INVALID_PARAMS, f"invalid level {level!r}; expected L1|L2|L3|L4")
    source = str(args.get("source", "mcp")).strip() or "mcp"
    session_id = str(args.get("session_id", "")).strip() or None
    entry: Dict[str, Any] = {"level": level, "content": content, "source": source}
    if session_id:
        entry["session_id"] = session_id
    result = await memory.store(entry)
    return {"stored": True, "entry": result}


async def _wiki_create(state: Dict[str, Any], args: Dict[str, Any]) -> Any:
    """Write tool — create a wiki note. Requires bearer auth."""
    wiki = _require(state, "wiki")
    title = _require_str(args, "title")
    content = _require_str(args, "content")
    tags_raw = args.get("tags") or []
    if not isinstance(tags_raw, list):
        raise MCPError(INVALID_PARAMS, "'tags' must be a list of strings")
    tags = [str(t) for t in tags_raw if isinstance(t, (str, int, float))]

    try:
        # WikiEngine has shifted shapes across versions — try the most-common
        # method names in order of preference, surface a clear error if none
        # match the installed engine.
        if hasattr(wiki, "create_note"):
            note = wiki.create_note(title=title, content=content, tags=tags)
        elif hasattr(wiki, "add_note"):
            note = wiki.add_note(title=title, content=content, tags=tags)
        else:
            raise MCPError(INTERNAL_ERROR, "wiki engine has no create_note/add_note method")
    except MCPError:
        raise
    except Exception as e:
        raise MCPError(INTERNAL_ERROR, f"wiki create failed: {type(e).__name__}: {e}")
    return {"created": True, "note": note}


async def _rag_index_file(state: Dict[str, Any], args: Dict[str, Any]) -> Any:
    """Write tool — index a file into the RAG corpus. Requires bearer auth."""
    rag = _require(state, "rag")
    path = _require_str(args, "path")
    try:
        result = rag.index_file(path)
    except Exception as e:
        raise MCPError(INTERNAL_ERROR, f"rag index_file failed: {type(e).__name__}: {e}")
    # RAGRetriever.index_file returns a dict already in the right shape
    return result if isinstance(result, dict) else {"indexed": True, "result": result}


async def _kg_search(state: Dict[str, Any], args: Dict[str, Any]) -> Any:
    kg = _require(state, "kg")
    query = _require_str(args, "query")
    limit = int(args.get("limit", 10))
    try:
        if hasattr(kg, "search"):
            results = kg.search(query, limit=limit)
        elif hasattr(kg, "search_entities"):
            results = kg.search_entities(query, limit=limit)
        else:
            raise MCPError(INTERNAL_ERROR, "kg has neither search nor search_entities")
    except MCPError:
        raise
    except Exception as e:
        raise MCPError(INTERNAL_ERROR, f"kg search failed: {type(e).__name__}: {e}")
    return {"results": results}


# ---------------------------------------------------------------------------
# Registry — order matters for tools/list display
# ---------------------------------------------------------------------------


TOOL_REGISTRY: List[ToolSpec] = [
    ToolSpec(
        name="webrain_memory_query",
        description=(
            "Semantic search across webrain's memory layers (L1 raw session "
            "/ L2 summarized / L3 long-term / L4 reflective). Returns "
            "ranked memories matching the query."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Natural language search query"},
                "levels": {
                    "type": "array",
                    "items": {"type": "string", "enum": ["L1", "L2", "L3", "L4"]},
                    "description": "Memory levels to search (default: L2, L3)",
                },
                "limit": {"type": "integer", "minimum": 1, "maximum": 100, "description": "Max results (default: 10)"},
            },
            "required": ["query"],
        },
        handler=_memory_query,
    ),
    ToolSpec(
        name="webrain_memory_recent",
        description="Get the most recently stored memories, optionally filtered by level.",
        input_schema={
            "type": "object",
            "properties": {
                "level": {"type": "string", "enum": ["L1", "L2", "L3", "L4"], "description": "Filter to one level"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100, "description": "Max results (default: 20)"},
            },
        },
        handler=_memory_recent,
    ),
    ToolSpec(
        name="webrain_rag_query",
        description=(
            "Retrieve top-k document chunks from webrain's local RAG index "
            "using cosine similarity over multilingual embeddings."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
                "k": {"type": "integer", "minimum": 1, "maximum": 20, "description": "Top-k chunks (default: 5)"},
            },
            "required": ["query"],
        },
        handler=_rag_query,
    ),
    ToolSpec(
        name="webrain_rag_stats",
        description="Get statistics about the RAG corpus (doc count, chunk count, embedding dim, indexed paths).",
        input_schema={"type": "object", "properties": {}},
        handler=_rag_stats,
    ),
    ToolSpec(
        name="webrain_wiki_search",
        description="Search webrain's wiki note collection by title and content substring.",
        input_schema={
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Substring or keyword to match"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100, "description": "Max results (default: 20)"},
            },
            "required": ["query"],
        },
        handler=_wiki_search,
    ),
    ToolSpec(
        name="webrain_kg_search",
        description="Search the knowledge graph for entities matching a query string.",
        input_schema={
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Entity name or alias substring"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 50, "description": "Max results (default: 10)"},
            },
            "required": ["query"],
        },
        handler=_kg_search,
    ),
    # ----- M4b.1 write-class tools (require bearer auth) -----
    ToolSpec(
        name="webrain_memory_store",
        description="Append a new memory entry. Requires authentication.",
        scope="write",
        input_schema={
            "type": "object",
            "properties": {
                "content": {"type": "string", "description": "Memory content"},
                "level": {
                    "type": "string",
                    "enum": ["L1", "L2", "L3", "L4"],
                    "description": "Memory layer (default L2)",
                },
                "source": {"type": "string", "description": "Source tag (default 'mcp')"},
                "session_id": {"type": "string", "description": "Optional session id to associate"},
            },
            "required": ["content"],
        },
        handler=_memory_store,
    ),
    ToolSpec(
        name="webrain_wiki_create",
        description="Create a new wiki note. Requires authentication.",
        scope="write",
        input_schema={
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Note title"},
                "content": {"type": "string", "description": "Note markdown body"},
                "tags": {"type": "array", "items": {"type": "string"}, "description": "Optional tag list"},
            },
            "required": ["title", "content"],
        },
        handler=_wiki_create,
    ),
    ToolSpec(
        name="webrain_rag_index_file",
        description="Index a local file into the RAG corpus. Requires authentication.",
        scope="write",
        input_schema={
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Absolute path to the file"},
            },
            "required": ["path"],
        },
        handler=_rag_index_file,
    ),
]


def find_tool(name: str) -> ToolSpec:
    """Look up a tool by MCP name; raise METHOD_NOT_FOUND on miss."""
    from .protocol import METHOD_NOT_FOUND
    for spec in TOOL_REGISTRY:
        if spec.name == name:
            return spec
    raise MCPError(METHOD_NOT_FOUND, f"unknown tool: {name!r}")
