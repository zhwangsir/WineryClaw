/**
 * Persistent Reply Queue (M7a).
 *
 * Replaces the in-memory Promise-chain queue with an SQLite-backed
 * persistent queue + retry loop + dead-letter queue.
 *
 * Design:
 *   - enqueue: write to pending_replies (fast, never blocks)
 *   - worker: poll every N seconds for pending rows, process them
 *   - retry: exponential backoff (1s, 2s, 4s) up to max_attempts
 *   - DLQ: rows that exhaust max_attempts are moved to dead_letter_replies
 */

import { DatabaseSync } from "node:sqlite";

export interface PendingReplyRow {
  id: number;
  channel_id: string;
  sender: string;
  content: string;
  session_id: string;
  agent_id: string;
  attempts: number;
  max_attempts: number;
  next_retry_at: string | null;
  status: string;
  error: string | null;
  created_at: string;
}

export interface EnqueueParams {
  channel_id: string;
  sender: string;
  content: string;
  session_id: string;
  agent_id: string;
  max_attempts?: number;
}

export class PersistentReplyQueue {
  constructor(private db: DatabaseSync) {}

  /** Insert a new reply into the pending queue. Returns the row id. */
  enqueue(params: EnqueueParams): number {
    const stmt = this.db.prepare(`
      INSERT INTO pending_replies
        (channel_id, sender, content, session_id, agent_id, max_attempts, status, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))
    `);
    const result = stmt.run(
      params.channel_id,
      params.sender,
      params.content,
      params.session_id,
      params.agent_id,
      params.max_attempts ?? 3,
    );
    return Number(result.lastInsertRowid);
  }

  /**
   * Atomically claim the next pending reply that is due for retry.
   * Status transitions: pending → processing.
   */
  dequeue(): PendingReplyRow | null {
    // SQLite does not have SKIP LOCKED, so we use a status guard.
    const select = this.db.prepare(`
      SELECT * FROM pending_replies
      WHERE status = 'pending'
        AND (next_retry_at IS NULL OR next_retry_at <= datetime('now'))
      ORDER BY id ASC
      LIMIT 1
    `);
    const row = select.get() as PendingReplyRow | undefined;
    if (!row) return null;

    const update = this.db.prepare(`
      UPDATE pending_replies
      SET status = 'processing', attempts = attempts + 1, updated_at = datetime('now')
      WHERE id = ? AND status = 'pending'
    `);
    const result = update.run(row.id);
    if (result.changes === 0) {
      // Race lost — another worker claimed it
      return null;
    }
    return { ...row, status: "processing", attempts: row.attempts + 1 };
  }

  /** Mark a reply as successfully completed. Deletes the row. */
  markSuccess(id: number): void {
    const stmt = this.db.prepare("DELETE FROM pending_replies WHERE id = ?");
    stmt.run(id);
  }

  /**
   * Mark a reply as failed.
   * If attempts < max_attempts: compute next_retry_at and return to pending.
   * Otherwise: move to dead_letter_replies and delete from pending.
   */
  markFailed(id: number, error: string): void {
    const get = this.db.prepare("SELECT * FROM pending_replies WHERE id = ?");
    const row = get.get(id) as PendingReplyRow | undefined;
    if (!row) return;

    if (row.attempts >= row.max_attempts) {
      // Move to DLQ
      const dlq = this.db.prepare(`
        INSERT INTO dead_letter_replies
          (channel_id, sender, content, session_id, agent_id, attempts, error, created_at, failed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `);
      dlq.run(
        row.channel_id,
        row.sender,
        row.content,
        row.session_id,
        row.agent_id,
        row.attempts,
        error,
        row.created_at,
      );
      const del = this.db.prepare("DELETE FROM pending_replies WHERE id = ?");
      del.run(id);
    } else {
      // Exponential backoff: 1s, 2s, 4s, ...
      const backoffMs = Math.min(1000 * Math.pow(2, row.attempts - 1), 30000);
      const nextRetry = new Date(Date.now() + backoffMs).toISOString();
      const upd = this.db.prepare(`
        UPDATE pending_replies
        SET status = 'pending', next_retry_at = ?, error = ?, updated_at = datetime('now')
        WHERE id = ?
      `);
      upd.run(nextRetry, error, id);
    }
  }

  getPendingCount(): number {
    const stmt = this.db.prepare("SELECT COUNT(*) as c FROM pending_replies WHERE status = 'pending'");
    const row = stmt.get() as { c: number } | undefined;
    return row?.c ?? 0;
  }

  getProcessingCount(): number {
    const stmt = this.db.prepare("SELECT COUNT(*) as c FROM pending_replies WHERE status = 'processing'");
    const row = stmt.get() as { c: number } | undefined;
    return row?.c ?? 0;
  }

  getDeadLetterCount(): number {
    const stmt = this.db.prepare("SELECT COUNT(*) as c FROM dead_letter_replies");
    const row = stmt.get() as { c: number } | undefined;
    return row?.c ?? 0;
  }

  /** Peek at pending rows (for monitoring / admin UI). */
  listPending(limit = 50): PendingReplyRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM pending_replies
      ORDER BY created_at DESC
      LIMIT ?
    `);
    return (stmt.all(limit) as PendingReplyRow[]) ?? [];
  }

  /** Peek at DLQ rows (for monitoring / admin UI). */
  listDeadLetter(limit = 50): Array<Omit<PendingReplyRow, "status" | "next_retry_at" | "max_attempts"> & { failed_at: string }> {
    const stmt = this.db.prepare(`
      SELECT * FROM dead_letter_replies
      ORDER BY failed_at DESC
      LIMIT ?
    `);
    return (stmt.all(limit) as any[]) ?? [];
  }
}
