PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS blocks (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  parent_id TEXT,
  order_key TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  create_time INTEGER NOT NULL,
  update_time INTEGER NOT NULL,
  created_by_user_id TEXT NOT NULL,
  updated_by_user_id TEXT NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
  PRIMARY KEY (workspace_id, id),
  CHECK (workspace_id != '' AND id != ''),
  FOREIGN KEY (workspace_id, parent_id) REFERENCES blocks(workspace_id, id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_blocks_workspace_parent_order
  ON blocks(workspace_id, parent_id, order_key);

CREATE INDEX IF NOT EXISTS ix_blocks_parent
  ON blocks(workspace_id, parent_id)
  WHERE is_deleted = 0;

CREATE INDEX IF NOT EXISTS ix_blocks_updated
  ON blocks(workspace_id, update_time);

CREATE TABLE IF NOT EXISTS block_properties (
  workspace_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('string','number','boolean','object','array','null')),
  value_json TEXT,
  change_scope TEXT,
  PRIMARY KEY (workspace_id, block_id, name),
  FOREIGN KEY (workspace_id, block_id) REFERENCES blocks(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_block_properties_name
  ON block_properties(workspace_id, name);

CREATE TABLE IF NOT EXISTS block_refs (
  workspace_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  target_workspace_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  ref_type TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('text', 'property')),
  alias TEXT,
  span_start INTEGER,
  span_end INTEGER,
  source_property_name TEXT,
  source_property_path TEXT NOT NULL DEFAULT '',
  ordinal INTEGER,
  meta_json TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  PRIMARY KEY (workspace_id, block_id, target_workspace_id, target_id, ref_type, source_property_path),
  FOREIGN KEY (workspace_id, block_id) REFERENCES blocks(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_block_refs_target
  ON block_refs(target_workspace_id, target_id, ref_type);

CREATE INDEX IF NOT EXISTS ix_block_refs_block
  ON block_refs(workspace_id, block_id, ref_type);

CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
  content,
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS blocks_fts_after_insert
AFTER INSERT ON blocks
WHEN NEW.is_deleted = 0
BEGIN
  INSERT INTO blocks_fts(rowid, content)
  VALUES ((SELECT rowid FROM blocks WHERE workspace_id = NEW.workspace_id AND id = NEW.id), NEW.content);
END;

CREATE TRIGGER IF NOT EXISTS blocks_fts_after_update
AFTER UPDATE ON blocks
BEGIN
  INSERT INTO blocks_fts(blocks_fts, rowid, content)
  VALUES ('delete', (SELECT rowid FROM blocks WHERE workspace_id = OLD.workspace_id AND id = OLD.id), OLD.content);

  INSERT INTO blocks_fts(rowid, content)
  SELECT
    (SELECT rowid FROM blocks WHERE workspace_id = NEW.workspace_id AND id = NEW.id),
    NEW.content
  WHERE NEW.is_deleted = 0;
END;

CREATE TRIGGER IF NOT EXISTS blocks_fts_after_delete
AFTER DELETE ON blocks
BEGIN
  INSERT INTO blocks_fts(blocks_fts, rowid, content)
  VALUES ('delete', (SELECT rowid FROM blocks WHERE workspace_id = OLD.workspace_id AND id = OLD.id), OLD.content);
END;
