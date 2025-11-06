Here is the schema proposed by another model for this app, use it as a reference, but feel free to critique and suggest improvements:

```sql
PRAGMA foreign_keys = ON;

-- BLOCKS (adjacency list; lexicographic order_key for O(1) inserts between siblings)
CREATE TABLE blocks (
  id                 TEXT PRIMARY KEY,
  parent_id          TEXT REFERENCES blocks(id) ON DELETE SET NULL,
  order_key          TEXT NOT NULL,                 -- e.g., LexoRank-style string
  content            TEXT NOT NULL DEFAULT '',
  create_time        INTEGER NOT NULL,              -- ms since epoch
  update_time        INTEGER NOT NULL,
  created_by_user_id TEXT NOT NULL,
  updated_by_user_id TEXT NOT NULL,
  is_deleted         INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  CHECK (id != parent_id)
);
CREATE UNIQUE INDEX ux_blocks_parent_order ON blocks(parent_id, order_key);
CREATE INDEX ix_blocks_parent   ON blocks(parent_id) WHERE is_deleted=0;
CREATE INDEX ix_blocks_updated  ON blocks(update_time);

-- PROPERTIES (EAV; JSON preserves union types)
CREATE TABLE block_properties (
  block_id     TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('string','number','boolean','object','array','null')),
  value_json   TEXT,
  change_scope TEXT,
  PRIMARY KEY (block_id, name)
);
CREATE INDEX ix_props_name      ON block_properties(name);
CREATE INDEX ix_props_name_str  ON block_properties(name, json_extract(value_json,'$'))                WHERE type='string';
CREATE INDEX ix_props_name_num  ON block_properties(name, CAST(json_extract(value_json,'$') AS REAL))  WHERE type='number';
CREATE INDEX ix_props_name_bool ON block_properties(name, CAST(json_extract(value_json,'$') AS INTEGER)) WHERE type='boolean';

-- REFERENCES (typed edges). ref_type='text-reference' for inline links; property-derived edges use the property name.
CREATE TABLE block_refs (
  block_id             TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  target_id            TEXT NOT NULL,   -- FK optional in local-first; add DEFERRABLE FK if your replicator guarantees order
  ref_type             TEXT NOT NULL,   -- 'text-reference' OR property name ('author', 'tag', ...)
  origin               TEXT NOT NULL CHECK (origin IN ('text','property')),

  -- Inline (origin='text')
  alias                TEXT,
  span_start           INTEGER,
  span_end             INTEGER,

  -- Property-derived (origin='property')
  source_property_name TEXT,
  source_property_path TEXT NOT NULL DEFAULT '',     -- e.g., '$[0]' for arrays; normalized empty when N/A
  ordinal              INTEGER,

  meta_json            TEXT,
  created_at           INTEGER,
  updated_at           INTEGER,

  PRIMARY KEY (block_id, target_id, ref_type, source_property_path),
  CHECK (
    (origin='text'     AND source_property_name IS NULL)
    OR
    (origin='property' AND source_property_name IS NOT NULL)
  )
);
CREATE INDEX ix_block_refs_target_type ON block_refs(target_id, ref_type);
CREATE INDEX ix_block_refs_block_type  ON block_refs(block_id, ref_type);
CREATE INDEX ix_block_refs_propname    ON block_refs(source_property_name) WHERE origin='property';

-- OPTIONAL: typed attributes on the edge (only if you need queryable edge metadata)
CREATE TABLE block_ref_props (
  block_id  TEXT NOT NULL,
  target_id TEXT NOT NULL,
  ref_type  TEXT NOT NULL,
  name      TEXT NOT NULL,
  value_json TEXT,
  PRIMARY KEY (block_id, target_id, ref_type, name),
  FOREIGN KEY (block_id, target_id, ref_type)
    REFERENCES block_refs(block_id, target_id, ref_type) ON DELETE CASCADE
);

-- OPTIONAL: store authoritative Automerge payload per block; project into tables above on doc change
CREATE TABLE block_docs (
  block_id   TEXT PRIMARY KEY REFERENCES blocks(id) ON DELETE CASCADE,
  encoded    BLOB NOT NULL,
  heads_json TEXT NOT NULL,
  size_bytes INTEGER GENERATED ALWAYS AS (length(encoded)) VIRTUAL
);

-- FTS on block content (external content)
CREATE VIRTUAL TABLE blocks_fts USING fts5(
  content,
  content='blocks',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER blocks_fts_ai AFTER INSERT ON blocks BEGIN
  INSERT INTO blocks_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER blocks_fts_ad AFTER DELETE ON blocks BEGIN
  INSERT INTO blocks_fts(blocks_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER blocks_fts_au AFTER UPDATE OF content ON blocks BEGIN
  INSERT INTO blocks_fts(blocks_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO blocks_fts(rowid, content) VALUES (new.rowid, new.content);
END;
```
