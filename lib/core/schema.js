/**
 * DDL for the in-plugin store.
 *
 * This is the schema from `docs/CORE-DESIGN.md`, and it deliberately differs
 * from the Python engine's: embeddings live in their own table (so a model
 * change never rewrites a memory row), updates are supersede operations with a
 * validity window instead of in-place overwrites, provenance is first class,
 * and keyword search is an FTS5 trigram index (verified to match Chinese
 * substrings on the DSH runtime: Node 24 / SQLite 3.53).
 *
 * `meta.schema_version` is written on creation so a future migration has a
 * version to read rather than a schema to guess.
 */

export const SCHEMA_VERSION = 1

export const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 3000;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY,
  user_id       TEXT,
  agent_id      TEXT,
  run_id        TEXT,
  text          TEXT NOT NULL,
  memory_type   TEXT NOT NULL DEFAULT 'user'
                CHECK (memory_type IN ('user','agent','procedural')),
  metadata      TEXT NOT NULL DEFAULT '{}',
  origin        TEXT NOT NULL DEFAULT 'manual',
  source_ref    TEXT,
  confidence    REAL NOT NULL DEFAULT 1.0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  valid_from    TEXT NOT NULL,
  superseded_by TEXT REFERENCES memories(id) ON DELETE SET NULL,
  CHECK (user_id IS NOT NULL OR agent_id IS NOT NULL OR run_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS memories_scope_current
  ON memories(user_id, agent_id, run_id) WHERE superseded_by IS NULL;
CREATE INDEX IF NOT EXISTS memories_superseded ON memories(superseded_by);

CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  vector     BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, model)
) WITHOUT ROWID;

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  text,
  content='memories',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF text ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TABLE IF NOT EXISTS blocks (
  scope_type  TEXT NOT NULL CHECK (scope_type IN ('user','agent')),
  scope_id    TEXT NOT NULL,
  label       TEXT NOT NULL,
  value       TEXT NOT NULL,
  value_limit INTEGER NOT NULL DEFAULT 2000,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (scope_type, scope_id, label)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS relations (
  id         INTEGER PRIMARY KEY,
  source_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'related'
             CHECK (kind IN ('related','similar','contradicts','supersedes')),
  weight     REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (source_id, target_id, kind)
);

CREATE TABLE IF NOT EXISTS history (
  id        INTEGER PRIMARY KEY,
  -- No foreign key on purpose: the audit trail must outlive the memory it is
  -- about, or a delete erases its own record. The real export proved this:
  -- it carries history rows whose memory was deleted in the old store.
  memory_id TEXT NOT NULL,
  action    TEXT NOT NULL
            CHECK (action IN ('add','update','supersede','delete','import')),
  old_text  TEXT,
  new_text  TEXT,
  actor     TEXT NOT NULL DEFAULT 'system',
  at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS history_memory ON history(memory_id, at);

CREATE TABLE IF NOT EXISTS flags (
  memory_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  reason     TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open'
             CHECK (status IN ('open','resolved','dismissed')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, reason)
) WITHOUT ROWID;
`
