/**
 * Sub Brain SQLite Persistence Layer
 * 为 ChannelManager, PluginLoader, EcosystemHub 提供统一持久化
 */

import { DatabaseSync } from "node:sqlite";
import { join } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync } from "fs";

const DB_DIR = join(homedir(), ".webrain");
const DB_PATH = join(DB_DIR, "sub-brain.db");

export class SubBrainDB {
  private db: DatabaseSync;

  constructor() {
    if (!existsSync(DB_DIR)) {
      mkdirSync(DB_DIR, { recursive: true });
    }
    this.db = new DatabaseSync(DB_PATH);
    this.initTables();
  }

  private initTables(): void {
    // Channels table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        connected INTEGER DEFAULT 0,
        config TEXT DEFAULT '{}',
        auto_reply INTEGER DEFAULT 0,
        agent_id TEXT DEFAULT 'agent-default',
        reply_delay_ms INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT
      )
    `);
    // M5 migration: add auto_reply column to pre-existing channels tables.
    // SQLite's ALTER TABLE ADD COLUMN succeeds at most once; subsequent
    // runs raise "duplicate column" which we catch and ignore. The CREATE
    // above declares the column for fresh installs; the ALTER is only
    // for installs that were created before M5.
    try {
      this.db.exec("ALTER TABLE channels ADD COLUMN auto_reply INTEGER DEFAULT 0");
    } catch {
      // Column already exists — expected on second-and-later runs.
    }
    // M5.1 migration: add agent_id and reply_delay_ms columns.
    try {
      this.db.exec("ALTER TABLE channels ADD COLUMN agent_id TEXT DEFAULT 'agent-default'");
    } catch { /* already exists */ }
    try {
      this.db.exec("ALTER TABLE channels ADD COLUMN reply_delay_ms INTEGER DEFAULT 0");
    } catch { /* already exists */ }

    // Messages table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        sender TEXT,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        direction TEXT NOT NULL DEFAULT 'inbound',
        created_at TEXT NOT NULL
      )
    `);

    // Plugins table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plugins (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        manifest TEXT DEFAULT '{}',
        config TEXT DEFAULT '{}',
        loaded_at TEXT NOT NULL,
        updated_at TEXT
      )
    `);

    // Ecosystem resources table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ecosystem_resources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT DEFAULT '{}',
        shared_with TEXT DEFAULT '[]',
        owner TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT
      )
    `);

    // Plugin manifest registry (for validation)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_registry (
        id TEXT PRIMARY KEY,
        specifier TEXT NOT NULL,
        checksum TEXT,
        validated INTEGER DEFAULT 0,
        registered_at TEXT NOT NULL
      )
    `);

    // Skill records for evolution
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        trigger_pattern TEXT,
        template TEXT,
        success_count INTEGER DEFAULT 0,
        failure_count INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT
      )
    `);

    // Pending replies queue (M7a: persistent auto-reply queue)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_replies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        sender TEXT NOT NULL,
        content TEXT NOT NULL,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        attempts INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 3,
        next_retry_at TEXT,
        status TEXT DEFAULT 'pending',
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_replies_status ON pending_replies(status)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_replies_retry ON pending_replies(next_retry_at)`);

    // Dead letter queue for permanently failed replies
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dead_letter_replies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        sender TEXT NOT NULL,
        content TEXT NOT NULL,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        attempts INTEGER DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL,
        failed_at TEXT NOT NULL
      )
    `);
  }

  getDb(): DatabaseSync {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}

export const subBrainDB = new SubBrainDB();
