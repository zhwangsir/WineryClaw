"""
WeBrain Memory Manager — Phase 3 RAG Enhanced
L1-L4 分层记忆 + Hybrid Search (BM25 + Vector) + Re-ranking + Chunking
"""

import json
import logging
import sqlite3
import uuid
import math
import re
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

import httpx
import numpy as np

logger = logging.getLogger("webrain.memory")

# ---------------------------------------------------------------------------
# Re-ranking model (lazy-loaded)
# ---------------------------------------------------------------------------
_reranker = None


def _get_reranker():
    """Lazy-load cross-encoder re-ranker."""
    global _reranker
    if _reranker is None:
        try:
            from sentence_transformers import CrossEncoder
            _reranker = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2")
            logger.info("[memory] Re-ranker loaded: ms-marco-MiniLM-L-6-v2")
        except Exception as e:
            logger.warning(f"[memory] Failed to load re-ranker: {e}")
            _reranker = False
    return _reranker if _reranker is not False else None


class MemoryManager:
    """Orchestrates L1-L4 hierarchical memory with advanced RAG."""

    def __init__(self, db_path: Optional[str] = None, llm_config: Optional[Dict] = None):
        self._db_path = db_path or str(Path.home() / ".webrain" / "memory.db")
        Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)
        self.llm_config = llm_config or {
            "base_url": "http://192.168.71.100:1234/v1",
            "model_id": "minimax/minimax-m2.7",
        }
        # Embedding providers: ordered by preference
        self._embedding_providers = self._load_embedding_providers()
        # In-memory ANN index (numpy + sklearn)
        self._vector_ids: List[str] = []      # memory_id list
        self._vector_matrix: Optional[np.ndarray] = None  # (n, dim) float32
        self._ann_index: Optional[Any] = None  # sklearn NearestNeighbors
        self._ann_dirty = True
        self._http_client: Optional[httpx.AsyncClient] = None
        self._init_db()
        self._load_vector_index()  # build index from existing DB vectors

    def _get_client(self) -> httpx.AsyncClient:
        if self._http_client is None or self._http_client.is_closed:
            self._http_client = httpx.AsyncClient(timeout=30.0)
        return self._http_client

    async def close(self) -> None:
        if self._http_client and not self._http_client.is_closed:
            await self._http_client.aclose()

    @staticmethod
    def _in_placeholders(count: int) -> str:
        """Generate '?,?,?' for IN clause parameters."""
        return ",".join(["?"] * count)

    @contextmanager
    def _connect(self):
        conn = sqlite3.connect(self._db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS memories (
                    id TEXT PRIMARY KEY, level TEXT NOT NULL, content TEXT NOT NULL,
                    source TEXT DEFAULT '', session_id TEXT, created_at TEXT NOT NULL,
                    updated_at TEXT, metadata TEXT DEFAULT '{}', embedding TEXT, access_count INTEGER DEFAULT 0
                )
            """)
            conn.execute("""
                CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
                    content, source, session_id, content='memories', content_rowid='rowid'
                )
            """)
            conn.execute("""
                CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
                    INSERT INTO memories_fts(rowid, content, source, session_id) VALUES (new.rowid, new.content, new.source, new.session_id);
                END
            """)
            conn.execute("""
                CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
                    INSERT INTO memories_fts(memories_fts, rowid, content, source, session_id) VALUES ('delete', old.rowid, old.content, old.source, old.session_id);
                END
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS entities (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
                    description TEXT, mention_count INTEGER DEFAULT 1,
                    created_at TEXT NOT NULL, updated_at TEXT
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS facts (
                    id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, predicate TEXT NOT NULL,
                    object_value TEXT NOT NULL, confidence REAL DEFAULT 1.0, created_at TEXT NOT NULL
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS skills (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
                    trigger_pattern TEXT, template TEXT, success_count INTEGER DEFAULT 0,
                    failure_count INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS vectors (
                    id TEXT PRIMARY KEY, memory_id TEXT, vector TEXT, dim INTEGER,
                    vector_blob BLOB, created_at TEXT NOT NULL
                )
            """)
            # Migrate old JSON vectors to BLOB if needed
            try:
                rows = conn.execute("SELECT id, vector FROM vectors WHERE vector_blob IS NULL AND vector IS NOT NULL").fetchall()
                for row in rows:
                    vec = json.loads(row["vector"])
                    blob = np.array(vec, dtype=np.float32).tobytes()
                    conn.execute("UPDATE vectors SET vector_blob = ?, dim = ? WHERE id = ?",
                                 (blob, len(vec), row["id"]))
                if rows:
                    conn.commit()
                    logger.info(f"[memory] Migrated {len(rows)} old JSON vectors to BLOB")
            except Exception as e:
                logger.debug(f"[memory] Vector migration skipped: {e}")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_memories_level ON memories(level)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_vectors_memory ON vectors(memory_id)")
            # TTL / archive support
            try:
                conn.execute("ALTER TABLE memories ADD COLUMN ttl_days INTEGER DEFAULT NULL")
            except sqlite3.OperationalError:
                pass  # Column already exists
            try:
                conn.execute("ALTER TABLE memories ADD COLUMN archived INTEGER DEFAULT 0")
            except sqlite3.OperationalError:
                pass  # Column already exists
            conn.execute("""
                CREATE TABLE IF NOT EXISTS memories_archive (
                    id TEXT PRIMARY KEY, level TEXT NOT NULL, content TEXT NOT NULL,
                    source TEXT DEFAULT '', session_id TEXT, created_at TEXT NOT NULL,
                    updated_at TEXT, metadata TEXT DEFAULT '{}', embedding TEXT,
                    archived_at TEXT NOT NULL
                )
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_memories_archived ON memories(archived)")

    # ========== Vector Index (In-memory ANN) ==========
    def _load_vector_index(self) -> None:
        """Load all vectors from DB into memory index."""
        try:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT memory_id, vector_blob, dim FROM vectors WHERE vector_blob IS NOT NULL ORDER BY created_at"
                ).fetchall()
            if not rows:
                return
            ids = []
            vectors = []
            for row in rows:
                vec = np.frombuffer(row["vector_blob"], dtype=np.float32)
                if len(vec) == row["dim"]:
                    ids.append(row["memory_id"])
                    vectors.append(vec)
            if not vectors:
                return
            self._vector_ids = ids
            self._vector_matrix = np.vstack(vectors).astype(np.float32)
            self._ann_dirty = True
            self._build_ann_index()
            logger.info(f"[memory] Loaded {len(ids)} vectors into ANN index, dim={vectors[0].shape[0]}")
        except Exception as e:
            logger.warning(f"[memory] Failed to load vector index: {e}")

    def _build_ann_index(self) -> None:
        """Build or rebuild sklearn NearestNeighbors BallTree index."""
        if not self._ann_dirty or self._vector_matrix is None or len(self._vector_ids) < 10:
            return
        try:
            from sklearn.neighbors import NearestNeighbors
            # BallTree supports cosine via 'haversine' hack or brute in high-dim
            # For cosine similarity, we use 'brute' with cosine metric for accuracy
            # or normalize vectors and use 'euclidean' with BallTree for speed
            n_neighbors = min(64, len(self._vector_ids))
            self._ann_index = NearestNeighbors(
                n_neighbors=n_neighbors,
                metric="cosine",
                algorithm="brute",  # brute is fast enough for <100K vectors with numpy
            )
            self._ann_index.fit(self._vector_matrix)
            self._ann_dirty = False
            logger.info(f"[memory] ANN index built: {len(self._vector_ids)} vectors")
        except Exception as e:
            logger.warning(f"[memory] ANN index build failed: {e}")
            self._ann_index = None

    def _add_to_index(self, memory_id: str, vector: List[float]) -> None:
        """Add a single vector to the in-memory index."""
        vec = np.array(vector, dtype=np.float32)
        self._vector_ids.append(memory_id)
        if self._vector_matrix is None:
            self._vector_matrix = vec.reshape(1, -1)
        else:
            self._vector_matrix = np.vstack([self._vector_matrix, vec])
        self._ann_dirty = True
        # Rebuild index periodically (every 50 new vectors)
        if len(self._vector_ids) % 50 == 0:
            self._build_ann_index()

    # ========== L1-L4 CRUD ==========
    async def store(self, data: Dict[str, Any]) -> Dict[str, Any]:
        mem_id = str(uuid.uuid4())
        level = data.get("level", "L1")
        content = data.get("content", "")
        source = data.get("source", "")
        session_id = data.get("session_id", "")
        now = datetime.now(timezone.utc).isoformat()

        # Smart chunking for long content
        chunks = self._chunk_text(content)
        stored_ids = []

        with self._connect() as conn:
            if len(chunks) <= 1:
                # Single chunk — store as-is
                conn.execute(
                    "INSERT INTO memories (id, level, content, source, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                    (mem_id, level, content, source, session_id, now),
                )
                stored_ids.append(mem_id)
            else:
                # Multiple chunks — store each with chunk metadata
                for i, chunk in enumerate(chunks):
                    cid = str(uuid.uuid4()) if i > 0 else mem_id
                    meta = json.dumps({"chunk_index": i, "total_chunks": len(chunks), "parent_id": mem_id})
                    conn.execute(
                        "INSERT INTO memories (id, level, content, source, session_id, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (cid, level, chunk, source, session_id, now, meta),
                    )
                    stored_ids.append(cid)
            conn.commit()

        # Auto-extract semantic info for L2+ and L3
        if level in ("L2", "L3") and len(content) > 10:
            await self.extract_semantic(content)

        # Generate embeddings for L2+ chunks
        if level in ("L2", "L3"):
            for sid, chunk in zip(stored_ids, chunks):
                await self._store_embedding(sid, chunk)

        return {"id": mem_id, "level": level, "stored": True, "chunks": len(stored_ids)}

    # ========== Advanced Query: Hybrid Search + Re-ranking ==========
    async def query(self, query_data: Dict[str, Any]) -> List[Dict[str, Any]]:
        q = query_data.get("query", "")
        levels = query_data.get("levels", ["L1", "L2", "L3"])
        limit = query_data.get("limit", 10)
        use_vector = query_data.get("use_vector", True)
        use_rerank = query_data.get("use_rerank", True)
        top_k = query_data.get("top_k", limit * 3)  # Retrieve more for re-ranking

        if not q.strip():
            return []

        # Phase 1: Retrieve candidates from multiple sources
        fts_results = await self._fts_search(q, levels, top_k)
        vec_results = []
        if use_vector:
            vec_results = await self._vector_search(q, top_k, exclude_ids=[r["id"] for r in fts_results])

        # Phase 2: Hybrid fusion (RRF)
        fused = self._rrf_fuse([fts_results, vec_results], k=60)

        # Phase 3: Re-ranking (if enabled and available)
        if use_rerank and len(fused) > 1:
            fused = await self._rerank(q, fused, limit=limit)
        else:
            fused = fused[:limit]

        # Increment access count for retrieved memories
        self._increment_access([r["id"] for r in fused])

        return fused

    # ========== FTS5 Search ==========
    async def _fts_search(self, query: str, levels: List[str], limit: int) -> List[Dict]:
        try:
            with self._connect() as conn:
                placeholders = ",".join(["?"] * len(levels))
                # Escape FTS5 special chars
                safe_query = query.replace('"', '""')
                rows = conn.execute(
                    f"""SELECT m.*, rank as fts_rank FROM memories m
                        JOIN memories_fts fts ON m.rowid = fts.rowid
                        WHERE memories_fts MATCH ? AND m.level IN ({placeholders})
                        ORDER BY rank LIMIT ?""",
                    (safe_query, *levels, limit),
                ).fetchall()
                return [dict(r) for r in rows]
        except Exception as e:
            logger.warning(f"FTS search failed: {e}")
            return []

    # ========== Vector Search ==========
    async def _vector_search(self, query: str, limit: int, exclude_ids: List[str] = None) -> List[Dict]:
        """Vector search using in-memory ANN index (BallTree/brute) with numpy."""
        try:
            query_vec = await self._get_embedding(query)
            exclude_ids = set(exclude_ids or [])
            qvec = np.array(query_vec, dtype=np.float32)

            # Fast path: ANN index search
            if self._ann_index is not None and not self._ann_dirty and len(self._vector_ids) >= 10:
                try:
                    n_candidates = min(max(limit * 4, 20), len(self._vector_ids))
                    distances, indices = self._ann_index.kneighbors(qvec.reshape(1, -1), n_neighbors=n_candidates)
                    matched_ids = []
                    matched_scores = []
                    for dist, idx in zip(distances[0], indices[0]):
                        mid = self._vector_ids[idx]
                        if mid in exclude_ids:
                            continue
                        matched_ids.append(mid)
                        matched_scores.append(1.0 - dist)  # cosine distance → similarity
                    # Fetch full memory records
                    with self._connect() as conn:
                        placeholders = ",".join(["?"] * len(matched_ids)) if matched_ids else "''"
                        rows = conn.execute(
                            f"SELECT m.* FROM memories m WHERE m.id IN ({self._in_placeholders(len(matched_ids))})",
                            tuple(matched_ids),
                        ).fetchall()
                    id_to_row = {r["id"]: dict(r) for r in rows}
                    results = []
                    for mid, score in zip(matched_ids, matched_scores):
                        if mid in id_to_row:
                            item = id_to_row[mid]
                            item["vector_score"] = score
                            results.append(item)
                    return results[:limit]
                except Exception as e:
                    logger.debug(f"ANN search failed, falling back to brute force: {e}")

            # Fallback: brute-force with numpy batch computation (still much faster than JSON loop)
            if self._vector_matrix is not None and len(self._vector_ids) > 0:
                # Batch cosine similarity: (query · matrix) / (|query| * |matrix|)
                qnorm = np.linalg.norm(qvec) or 1.0
                mnorms = np.linalg.norm(self._vector_matrix, axis=1)
                mnorms[mnorms == 0] = 1.0
                dots = self._vector_matrix.dot(qvec)
                sims = dots / (mnorms * qnorm)
                # Sort by similarity
                top_idx = np.argsort(sims)[::-1]
                matched_ids = []
                matched_scores = []
                for idx in top_idx:
                    mid = self._vector_ids[idx]
                    if mid in exclude_ids:
                        continue
                    matched_ids.append(mid)
                    matched_scores.append(float(sims[idx]))
                    if len(matched_ids) >= limit:
                        break
                if matched_ids:
                    with self._connect() as conn:
                        placeholders = ",".join(["?"] * len(matched_ids))
                        rows = conn.execute(
                            f"SELECT m.* FROM memories m WHERE m.id IN ({self._in_placeholders(len(matched_ids))})",
                            tuple(matched_ids),
                        ).fetchall()
                    id_to_row = {r["id"]: dict(r) for r in rows}
                    results = []
                    for mid, score in zip(matched_ids, matched_scores):
                        if mid in id_to_row:
                            item = id_to_row[mid]
                            item["vector_score"] = score
                            results.append(item)
                    return results

            # Ultimate fallback: old DB scan (for backward compat or empty index)
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT v.*, m.* FROM vectors v JOIN memories m ON v.memory_id = m.id"
                ).fetchall()
            scored = []
            for row in rows:
                if row["memory_id"] in exclude_ids:
                    continue
                vec_json = row.get("vector")
                if not vec_json:
                    continue
                vec = json.loads(vec_json)
                sim = self._cosine_similarity(query_vec, vec)
                item = dict(row)
                item["vector_score"] = sim
                scored.append((sim, item))
            scored.sort(key=lambda x: x[0], reverse=True)
            return [item[1] for item in scored[:limit]]
        except Exception as e:
            logger.warning(f"Vector search failed: {e}")
            return []

    # ========== RRF Fusion ==========
    def _rrf_fuse(self, result_lists: List[List[Dict]], k: int = 60) -> List[Dict]:
        """Reciprocal Rank Fusion across multiple result lists."""
        scores: Dict[str, float] = {}
        items: Dict[str, Dict] = {}

        for results in result_lists:
            for rank, item in enumerate(results):
                item_id = item["id"]
                items[item_id] = item
                scores[item_id] = scores.get(item_id, 0.0) + 1.0 / (k + rank + 1)

        # Sort by fused score descending
        fused = sorted(scores.items(), key=lambda x: x[1], reverse=True)
        return [items[iid] for iid, _ in fused]

    # ========== Re-ranking ==========
    async def _rerank(self, query: str, candidates: List[Dict], limit: int = 10) -> List[Dict]:
        """Cross-encoder re-ranking of candidates."""
        reranker = _get_reranker()
        if reranker is None or len(candidates) == 0:
            return candidates[:limit]

        try:
            pairs = [(query, c.get("content", "")[:512]) for c in candidates]
            scores = reranker.predict(pairs)

            scored = []
            for cand, score in zip(candidates, scores):
                cand = dict(cand)
                cand["rerank_score"] = float(score)
                scored.append(cand)

            scored.sort(key=lambda x: x["rerank_score"], reverse=True)
            return scored[:limit]
        except Exception as e:
            logger.warning(f"Re-ranking failed: {e}")
            return candidates[:limit]

    # ========== Chunking ==========
    def _chunk_text(self, text: str, max_chunk_size: int = 800, overlap: int = 100) -> List[str]:
        """Smart semantic chunking by paragraphs with overlap."""
        if len(text) <= max_chunk_size:
            return [text]

        # Split by paragraphs
        paragraphs = re.split(r'\n\s*\n', text.strip())
        chunks = []
        current_chunk = ""

        for para in paragraphs:
            para = para.strip()
            if not para:
                continue

            if len(current_chunk) + len(para) + 2 <= max_chunk_size:
                current_chunk += ("\n\n" if current_chunk else "") + para
            else:
                if current_chunk:
                    chunks.append(current_chunk)
                # If single paragraph is too long, split by sentences
                if len(para) > max_chunk_size:
                    sentences = re.split(r'(?<=[。！？.!?])\s+', para)
                    current_chunk = ""
                    for sent in sentences:
                        if len(current_chunk) + len(sent) + 1 <= max_chunk_size:
                            current_chunk += (" " if current_chunk else "") + sent
                        else:
                            if current_chunk:
                                chunks.append(current_chunk)
                            current_chunk = sent
                else:
                    current_chunk = para

        if current_chunk:
            chunks.append(current_chunk)

        # Add overlap between chunks
        if len(chunks) > 1 and overlap > 0:
            overlapped = []
            for i, chunk in enumerate(chunks):
                if i > 0:
                    prev_tail = chunks[i - 1][-overlap:]
                    chunk = prev_tail + "\n" + chunk
                overlapped.append(chunk)
            return overlapped

        return chunks

    # ========== Access Tracking ==========
    def _increment_access(self, ids: List[str]) -> None:
        if not ids:
            return
        with self._connect() as conn:
            placeholders = ",".join(["?"] * len(ids))
            conn.execute(
                f"UPDATE memories SET access_count = access_count + 1 WHERE id IN ({placeholders})",
                tuple(ids),
            )
            conn.commit()

    # ========== Recent / Stats ==========
    async def get_recent(self, level: Optional[str] = None, limit: int = 50) -> List[Dict[str, Any]]:
        with self._connect() as conn:
            if level:
                rows = conn.execute(
                    "SELECT * FROM memories WHERE level = ? ORDER BY created_at DESC LIMIT ?",
                    (level, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM memories ORDER BY created_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            return [dict(r) for r in rows]

    async def get_skills(self, limit: int = 100) -> List[Dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute("SELECT * FROM skills LIMIT ?", (limit,)).fetchall()
            return [dict(r) for r in rows]

    # ========== NLP Semantic Extraction (via LLM) ==========
    async def extract_semantic(self, text: str) -> Dict[str, Any]:
        try:
            prompt = f"""从以下文本中提取实体和事实。以JSON格式返回：
{{"entities": [{{"name": "实体名", "type": "PERSON/ORG/LOCATION/TECH/OTHER", "description": "描述"}}],
 "facts": [{{"subject": "主语", "predicate": "谓语", "object": "宾语"}}]}}

文本：{text}"""

            result = await self._llm_call([
                {"role": "system", "content": "你是一个信息提取专家。"},
                {"role": "user", "content": prompt},
            ], max_tokens=1024)

            content = result["choices"][0]["message"]["content"]
            json_str = content
            if "```json" in content:
                json_str = content.split("```json")[1].split("```")[0].strip()
            elif "```" in content:
                json_str = content.split("```")[1].split("```")[0].strip()

            parsed = json.loads(json_str)
            entities = parsed.get("entities", [])
            facts = parsed.get("facts", [])

            stored_entities = 0
            with self._connect() as conn:
                for ent in entities:
                    eid = str(uuid.uuid4())
                    conn.execute(
                        "INSERT INTO entities (id, name, type, description, created_at) VALUES (?, ?, ?, ?, ?)",
                        (eid, ent.get("name", ""), ent.get("type", "OTHER"), ent.get("description", ""), datetime.now(timezone.utc).isoformat()),
                    )
                    stored_entities += 1
                conn.commit()

            stored_facts = 0
            with self._connect() as conn:
                for fact in facts:
                    entity_name = fact.get("subject", "")
                    row = conn.execute("SELECT id FROM entities WHERE name = ?", (entity_name,)).fetchone()
                    entity_id = row["id"] if row else str(uuid.uuid4())
                    if not row:
                        conn.execute(
                            "INSERT INTO entities (id, name, type, created_at) VALUES (?, ?, ?, ?)",
                            (entity_id, entity_name, "OTHER", datetime.now(timezone.utc).isoformat()),
                        )
                    conn.execute(
                        "INSERT INTO facts (id, entity_id, predicate, object_value, created_at) VALUES (?, ?, ?, ?, ?)",
                        (str(uuid.uuid4()), entity_id, fact.get("predicate", ""), fact.get("object", ""), datetime.now(timezone.utc).isoformat()),
                    )
                    stored_facts += 1
                conn.commit()

            return {"extracted": stored_entities + stored_facts, "entities": entities, "facts": facts}
        except Exception as e:
            logger.error(f"Semantic extraction failed: {e}")
            return {"extracted": 0, "entities": [], "facts": [], "error": str(e)}

    async def get_entities(self, entity_type: Optional[str] = None, limit: int = 50) -> List[Dict]:
        with self._connect() as conn:
            if entity_type:
                rows = conn.execute("SELECT * FROM entities WHERE type = ? LIMIT ?", (entity_type, limit)).fetchall()
            else:
                rows = conn.execute("SELECT * FROM entities LIMIT ?", (limit,)).fetchall()
            return [dict(r) for r in rows]

    # ========== Vector Embeddings ==========
    async def _store_embedding(self, memory_id: str, text: str) -> None:
        try:
            vector = await self._get_embedding(text)
            vec_blob = np.array(vector, dtype=np.float32).tobytes()
            with self._connect() as conn:
                conn.execute(
                    "INSERT OR REPLACE INTO vectors (id, memory_id, vector, vector_blob, dim, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                    (str(uuid.uuid4()), memory_id, json.dumps(vector), vec_blob, len(vector), datetime.now(timezone.utc).isoformat()),
                )
                conn.commit()
            # Update in-memory index
            self._add_to_index(memory_id, vector)
        except Exception as e:
            logger.warning(f"Embedding generation failed: {e}")

    def _load_embedding_providers(self) -> List[Dict]:
        """Load embedding provider configs from env / llm_config."""
        providers = []
        # 1. Ollama (local, preferred)
        ollama_url = self.llm_config.get("ollama_url") or "http://localhost:11434"
        if ollama_url:
            providers.append({
                "name": "ollama",
                "url": ollama_url.rstrip("/") + "/api/embeddings",
                "model": self.llm_config.get("ollama_embedding_model", "nomic-embed-text"),
                "headers": {},
                "payload_fmt": "ollama",
            })
        # 2. OpenAI-compatible API (cloud or local)
        base = self.llm_config.get("base_url", "").rstrip("/")
        if base:
            providers.append({
                "name": "openai-compatible",
                "url": base + "/embeddings",
                "model": self.llm_config.get("embedding_model", self.llm_config.get("model_id", "text-embedding-3-small")),
                "headers": {"Authorization": f"Bearer {self.llm_config.get('api_key', '')}"} if self.llm_config.get("api_key") else {},
                "payload_fmt": "openai",
            })
        # 3. Direct OpenAI
        openai_key = self.llm_config.get("openai_api_key") or self.llm_config.get("api_key")
        if openai_key:
            providers.append({
                "name": "openai",
                "url": "https://api.openai.com/v1/embeddings",
                "model": self.llm_config.get("openai_embedding_model", "text-embedding-3-small"),
                "headers": {"Authorization": f"Bearer {openai_key}"},
                "payload_fmt": "openai",
            })
        return providers

    async def _get_embedding(self, text: str) -> List[float]:
        """Try multiple embedding providers, fallback to local model, then hash."""
        # Try configured providers
        for provider in self._embedding_providers:
            try:
                vec = await self._call_embedding_provider(provider, text)
                if vec:
                    logger.debug(f"[embedding] {provider['name']} succeeded, dim={len(vec)}")
                    return vec
            except Exception as e:
                logger.debug(f"[embedding] {provider['name']} failed: {e}")
                continue

        # Try local sentence-transformers
        try:
            vec = await self._local_embedding(text)
            if vec:
                logger.info(f"[embedding] local sentence-transformers succeeded, dim={len(vec)}")
                return vec
        except Exception as e:
            logger.debug(f"[embedding] local model failed: {e}")

        # Last resort: hash-based deterministic fallback
        logger.warning("[embedding] All providers failed, using hash fallback")
        return self._fallback_embedding(text)

    async def _call_embedding_provider(self, provider: Dict, text: str) -> Optional[List[float]]:
        """Call a single embedding provider."""
        async with httpx.AsyncClient(timeout=30.0) as client:
            if provider["payload_fmt"] == "ollama":
                resp = await client.post(provider["url"], json={
                    "model": provider["model"],
                    "prompt": text,
                }, headers=provider["headers"])
                if resp.status_code == 200:
                    data = resp.json()
                    return data.get("embedding")
            elif provider["payload_fmt"] == "openai":
                resp = await client.post(provider["url"], json={
                    "model": provider["model"],
                    "input": text,
                }, headers=provider["headers"])
                if resp.status_code == 200:
                    data = resp.json()
                    emb = data.get("data", [{}])[0].get("embedding")
                    if emb:
                        return emb
        return None

    async def _local_embedding(self, text: str) -> Optional[List[float]]:
        """Use sentence-transformers locally (sync, run in thread)."""
        import asyncio
        try:
            from sentence_transformers import SentenceTransformer
            model = SentenceTransformer("all-MiniLM-L6-v2")
            loop = asyncio.get_event_loop()
            vec = await loop.run_in_executor(None, lambda: model.encode(text).tolist())
            return vec
        except Exception:
            return None

    def _fallback_embedding(self, text: str, dim: int = 128) -> List[float]:
        vec = [0.0] * dim
        text = text.lower()
        for i in range(len(text) - 2):
            tri = text[i:i+3]
            h = hash(tri) % dim
            vec[h] += 1.0
        norm = math.sqrt(sum(v * v for v in vec)) or 1.0
        return [v / norm for v in vec]

    def _cosine_similarity(self, a: List[float], b: List[float]) -> float:
        dot = sum(x * y for x, y in zip(a, b))
        norm_a = math.sqrt(sum(x * x for x in a)) or 1.0
        norm_b = math.sqrt(sum(x * x for x in b)) or 1.0
        return dot / (norm_a * norm_b)

    # ========== Context Compression ==========
    async def compress_context(self, messages: List[Dict], current_tokens: int) -> Dict[str, Any]:
        if len(messages) <= 4:
            return {"messages": messages, "original_tokens": current_tokens, "compressed_tokens": current_tokens, "compression_ratio": 0.0}

        preserved = [messages[0], messages[-1]]
        middle = messages[1:-1]
        summary = f"[摘要: {len(middle)} 条消息已压缩]"
        compressed = preserved[:1] + [{"role": "system", "content": summary}] + preserved[1:]
        return {"messages": compressed, "original_tokens": current_tokens, "compressed_tokens": len(compressed) * 50, "compression_ratio": 0.5}

    async def should_compress(self, current_tokens: int, threshold: int = 8000) -> bool:
        return current_tokens > threshold

    # ========== LLM Helper (Multi-endpoint aware) ==========
    async def _llm_call(self, messages: List[Dict], max_tokens: int = 1024) -> Dict[str, Any]:
        """Call LLM with multi-endpoint fallback support."""
        endpoints = self.llm_config.get("endpoints", [{
            "base_url": self.llm_config.get("base_url", "http://192.168.71.100:1234/v1"),
            "model_id": self.llm_config.get("model_id", "minimax/minimax-m2.7"),
            "api_key": self.llm_config.get("api_key"),
        }])

        last_error = None
        for ep in endpoints:
            base_url = ep.get("base_url", ep.get("baseUrl", "")).rstrip("/")
            model_id = ep.get("model_id", ep.get("modelId", "default"))
            api_key = ep.get("api_key", ep.get("apiKey"))

            url = f"{base_url}/chat/completions"
            payload = {
                "model": model_id,
                "messages": messages,
                "temperature": 0.3,
                "max_tokens": max_tokens,
            }
            headers = {"Content-Type": "application/json"}
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"

            try:
                async with httpx.AsyncClient(timeout=120.0) as client:
                    resp = await client.post(url, json=payload, headers=headers)
                    resp.raise_for_status()
                    return resp.json()
            except Exception as e:
                last_error = e
                logger.warning(f"LLM call failed for {base_url}: {e}, trying next endpoint...")
                continue

        raise RuntimeError(f"All LLM endpoints failed. Last error: {last_error}")

    # ========== Stats ==========
    async def get_stats(self) -> Dict[str, Any]:
        with self._connect() as conn:
            total = conn.execute("SELECT COUNT(*) as c FROM memories").fetchone()["c"]
            by_level = {}
            for row in conn.execute("SELECT level, COUNT(*) as c FROM memories GROUP BY level").fetchall():
                by_level[row["level"]] = row["c"]
            entity_count = conn.execute("SELECT COUNT(*) as c FROM entities").fetchone()["c"]
            fact_count = conn.execute("SELECT COUNT(*) as c FROM facts").fetchone()["c"]
            vector_count = conn.execute("SELECT COUNT(*) as c FROM vectors").fetchone()["c"]
            skill_count = conn.execute("SELECT COUNT(*) as c FROM skills").fetchone()["c"]
            archived = conn.execute("SELECT COUNT(*) as c FROM memories WHERE archived = 1").fetchone()["c"]
            return {"total": total, "by_level": by_level, "entities": entity_count, "facts": fact_count, "vectors": vector_count, "skills": skill_count, "archived": archived}

    # ========== TTL / Archive ==========

    async def archive_expired(self) -> Dict[str, Any]:
        """Archive memories whose ttl_days have expired."""
        now = datetime.now(timezone.utc)
        archived_count = 0

        with self._connect() as conn:
            # Find expired memories
            rows = conn.execute("""
                SELECT * FROM memories
                WHERE ttl_days IS NOT NULL
                  AND archived = 0
                  AND datetime(created_at, '+' || ttl_days || ' days') < datetime('now')
            """).fetchall()

            for row in rows:
                # Move to archive
                conn.execute("""
                    INSERT OR REPLACE INTO memories_archive
                    (id, level, content, source, session_id, created_at, updated_at, metadata, embedding, archived_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    row["id"], row["level"], row["content"], row["source"], row["session_id"],
                    row["created_at"], row["updated_at"], row["metadata"], row["embedding"],
                    now.isoformat(),
                ))
                # Delete from main + fts
                conn.execute("DELETE FROM memories WHERE id = ?", (row["id"],))
                archived_count += 1

            conn.commit()

        logger.info(f"[memory] Archived {archived_count} expired memories")
        return {"archived_count": archived_count}

    async def list_archived(self, limit: int = 50, offset: int = 0) -> List[Dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM memories_archive ORDER BY archived_at DESC LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()
            return [dict(r) for r in rows]

    async def restore_archived(self, memory_id: str) -> Dict[str, Any]:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM memories_archive WHERE id = ?", (memory_id,)).fetchone()
            if not row:
                return {"ok": False, "error": "Memory not found in archive"}

            conn.execute("""
                INSERT INTO memories (id, level, content, source, session_id, created_at, updated_at, metadata, embedding, archived)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            """, (
                row["id"], row["level"], row["content"], row["source"], row["session_id"],
                row["created_at"], row["updated_at"], row["metadata"], row["embedding"],
            ))
            conn.execute("DELETE FROM memories_archive WHERE id = ?", (memory_id,))
            conn.commit()

        return {"ok": True, "restored_id": memory_id}

    async def delete(self, memory_id: str) -> Dict[str, Any]:
        with self._connect() as conn:
            row = conn.execute("SELECT id FROM memories WHERE id = ?", (memory_id,)).fetchone()
            if not row:
                return {"ok": False, "error": "Memory not found"}
            conn.execute("DELETE FROM vectors WHERE memory_id = ?", (memory_id,))
            conn.execute("DELETE FROM memories WHERE id = ?", (memory_id,))
            conn.commit()
        return {"ok": True, "deleted_id": memory_id}

    async def get_session_memories(self, session_id: str, limit: int = 50) -> List[Dict]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM memories WHERE session_id = ? ORDER BY created_at DESC LIMIT ?",
                (session_id, limit),
            ).fetchall()
            return [dict(r) for r in rows]

    async def get_knowledge_context(self, query: str, session_id: Optional[str] = None) -> Dict[str, Any]:
        """Get combined L3+L4 knowledge context for a query."""
        memories = await self.query({"query": query, "levels": ["L2", "L3", "L4"], "limit": 10})
        entities = await self.get_entities(limit=20)
        return {
            "memories": memories,
            "entities": entities,
            "query": query,
            "session_id": session_id,
        }
