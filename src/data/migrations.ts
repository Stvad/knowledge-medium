import { PowerSyncDatabase } from '@powersync/web'

export async function runMigrations(db: PowerSyncDatabase) {
  console.log('🔧 Running PowerSync migrations...')
  
  // Enable foreign keys
  console.log('  ✓ Enabling foreign keys')
  await db.execute('PRAGMA foreign_keys = ON')

  // Note: powersync_crud virtual table is automatically created by PowerSync
  console.log('  ✓ Skipping powersync_crud (auto-created by PowerSync)')

  // Main blocks table (adjacency list with lexicographic ordering)
  console.log('  ✓ Creating blocks table')
  await db.execute(`
    CREATE TABLE IF NOT EXISTS blocks (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      order_key TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      create_time INTEGER NOT NULL,
      update_time INTEGER NOT NULL,
      created_by_user_id TEXT NOT NULL,
      updated_by_user_id TEXT NOT NULL,
      is_deleted INTEGER NOT NULL DEFAULT 0
    )
  `)

  console.log('  ✓ Creating blocks indexes')
  await db.execute('CREATE UNIQUE INDEX IF NOT EXISTS ux_blocks_parent_order ON blocks(parent_id, order_key)')
  await db.execute('CREATE INDEX IF NOT EXISTS ix_blocks_parent ON blocks(parent_id)')
  await db.execute('CREATE INDEX IF NOT EXISTS ix_blocks_updated ON blocks(update_time)')

  // Block properties (EAV model with type info)
  console.log('  ✓ Creating block_properties table')
  await db.execute(`
    CREATE TABLE IF NOT EXISTS block_properties (
      block_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      value_json TEXT,
      change_scope TEXT,
      PRIMARY KEY (block_id, name)
    )
  `)

  console.log('  ✓ Creating block_properties indexes')
  await db.execute('CREATE INDEX IF NOT EXISTS ix_props_name ON block_properties(name)')
  await db.execute('CREATE INDEX IF NOT EXISTS ix_props_type ON block_properties(type)')

  // Block references (typed edges)
  console.log('  ✓ Creating block_refs table')
  await db.execute(`
    CREATE TABLE IF NOT EXISTS block_refs (
      block_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      ref_type TEXT NOT NULL,
      origin TEXT NOT NULL,
      alias TEXT,
      span_start INTEGER,
      span_end INTEGER,
      source_property_name TEXT,
      source_property_path TEXT NOT NULL DEFAULT '',
      ordinal INTEGER,
      meta_json TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      PRIMARY KEY (block_id, target_id, ref_type, source_property_path)
    )
  `)

  console.log('  ✓ Creating block_refs indexes')
  await db.execute('CREATE INDEX IF NOT EXISTS ix_block_refs_target_type ON block_refs(target_id, ref_type)')
  await db.execute('CREATE INDEX IF NOT EXISTS ix_block_refs_block_type ON block_refs(block_id, ref_type)')
  await db.execute('CREATE INDEX IF NOT EXISTS ix_block_refs_origin ON block_refs(origin)')

  // FTS on block content
  console.log('  ✓ Creating FTS table')
  await db.execute(`
    CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
      content,
      content='blocks',
      content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    )
  `)

  // FTS triggers
  console.log('  ✓ Creating FTS triggers')
  await db.execute(`
    CREATE TRIGGER IF NOT EXISTS blocks_fts_ai AFTER INSERT ON blocks BEGIN
      INSERT INTO blocks_fts(rowid, content) VALUES (new.rowid, new.content);
    END
  `)

  await db.execute(`
    CREATE TRIGGER IF NOT EXISTS blocks_fts_ad AFTER DELETE ON blocks BEGIN
      INSERT INTO blocks_fts(blocks_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    END
  `)

  await db.execute(`
    CREATE TRIGGER IF NOT EXISTS blocks_fts_au AFTER UPDATE OF content ON blocks BEGIN
      INSERT INTO blocks_fts(blocks_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      INSERT INTO blocks_fts(rowid, content) VALUES (new.rowid, new.content);
    END
  `)

  // Create triggers for upload sync
  console.log('  ✓ Creating sync triggers')
  await createSyncTriggers(db)
  
  console.log('✅ PowerSync migrations complete!')
}

async function createSyncTriggers(db: PowerSyncDatabase) {
  // Blocks sync triggers
  await db.execute(`
    CREATE TRIGGER IF NOT EXISTS blocks_insert_sync
    AFTER INSERT ON blocks
    FOR EACH ROW
    BEGIN
      INSERT INTO powersync_crud (op, id, type, data) 
      VALUES ('PUT', NEW.id, 'blocks', json_object(
        'parent_id', NEW.parent_id,
        'order_key', NEW.order_key,
        'content', NEW.content,
        'create_time', NEW.create_time,
        'update_time', NEW.update_time,
        'created_by_user_id', NEW.created_by_user_id,
        'updated_by_user_id', NEW.updated_by_user_id,
        'is_deleted', NEW.is_deleted
      ));
    END
  `)

  await db.execute(`
    CREATE TRIGGER IF NOT EXISTS blocks_update_sync
    AFTER UPDATE ON blocks
    FOR EACH ROW
    BEGIN
      INSERT INTO powersync_crud (op, id, type, data) 
      VALUES ('PATCH', NEW.id, 'blocks', json_object(
        'parent_id', NEW.parent_id,
        'order_key', NEW.order_key,
        'content', NEW.content,
        'update_time', NEW.update_time,
        'updated_by_user_id', NEW.updated_by_user_id,
        'is_deleted', NEW.is_deleted
      ));
    END
  `)

  // Block properties sync triggers
  await db.execute(`
    CREATE TRIGGER IF NOT EXISTS block_properties_insert_sync
    AFTER INSERT ON block_properties
    FOR EACH ROW
    BEGIN
      INSERT INTO powersync_crud (op, id, type, data) 
      VALUES ('PUT', NEW.block_id || '_' || NEW.name, 'block_properties', json_object(
        'block_id', NEW.block_id,
        'name', NEW.name,
        'type', NEW.type,
        'value_json', NEW.value_json,
        'change_scope', NEW.change_scope
      ));
    END
  `)

  await db.execute(`
    CREATE TRIGGER IF NOT EXISTS block_properties_update_sync
    AFTER UPDATE ON block_properties
    FOR EACH ROW
    BEGIN
      INSERT INTO powersync_crud (op, id, type, data) 
      VALUES ('PATCH', NEW.block_id || '_' || NEW.name, 'block_properties', json_object(
        'block_id', NEW.block_id,
        'name', NEW.name,
        'type', NEW.type,
        'value_json', NEW.value_json,
        'change_scope', NEW.change_scope
      ));
    END
  `)

  await db.execute(`
    CREATE TRIGGER IF NOT EXISTS block_properties_delete_sync
    AFTER DELETE ON block_properties
    FOR EACH ROW
    BEGIN
      INSERT INTO powersync_crud (op, id, type) 
      VALUES ('DELETE', OLD.block_id || '_' || OLD.name, 'block_properties');
    END
  `)

  // Block refs sync triggers
  await db.execute(`
    CREATE TRIGGER IF NOT EXISTS block_refs_insert_sync
    AFTER INSERT ON block_refs
    FOR EACH ROW
    BEGIN
      INSERT INTO powersync_crud (op, id, type, data) 
      VALUES ('PUT', NEW.block_id || '_' || NEW.target_id || '_' || NEW.ref_type || '_' || NEW.source_property_path, 'block_refs', json_object(
        'block_id', NEW.block_id,
        'target_id', NEW.target_id,
        'ref_type', NEW.ref_type,
        'origin', NEW.origin,
        'alias', NEW.alias,
        'span_start', NEW.span_start,
        'span_end', NEW.span_end,
        'source_property_name', NEW.source_property_name,
        'source_property_path', NEW.source_property_path,
        'ordinal', NEW.ordinal,
        'meta_json', NEW.meta_json,
        'created_at', NEW.created_at,
        'updated_at', NEW.updated_at
      ));
    END
  `)

  await db.execute(`
    CREATE TRIGGER IF NOT EXISTS block_refs_update_sync
    AFTER UPDATE ON block_refs
    FOR EACH ROW
    BEGIN
      INSERT INTO powersync_crud (op, id, type, data) 
      VALUES ('PATCH', NEW.block_id || '_' || NEW.target_id || '_' || NEW.ref_type || '_' || NEW.source_property_path, 'block_refs', json_object(
        'block_id', NEW.block_id,
        'target_id', NEW.target_id,
        'ref_type', NEW.ref_type,
        'origin', NEW.origin,
        'alias', NEW.alias,
        'span_start', NEW.span_start,
        'span_end', NEW.span_end,
        'source_property_name', NEW.source_property_name,
        'source_property_path', NEW.source_property_path,
        'ordinal', NEW.ordinal,
        'meta_json', NEW.meta_json,
        'created_at', NEW.created_at,
        'updated_at', NEW.updated_at
      ));
    END
  `)

  await db.execute(`
    CREATE TRIGGER IF NOT EXISTS block_refs_delete_sync
    AFTER DELETE ON block_refs
    FOR EACH ROW
    BEGIN
      INSERT INTO powersync_crud (op, id, type) 
      VALUES ('DELETE', OLD.block_id || '_' || OLD.target_id || '_' || OLD.ref_type || '_' || OLD.source_property_path, 'block_refs');
    END
  `)
}
