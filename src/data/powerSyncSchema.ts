import { Schema } from '@powersync/web'

// Based on schema-proposal.md - Raw table definitions using PowerSync's withRawTables API
export const AppSchema = new Schema({})

AppSchema.withRawTables({
  blocks: {
    put: {
      sql: `INSERT OR REPLACE INTO blocks 
            (id, parent_id, order_key, content, create_time, update_time, 
             created_by_user_id, updated_by_user_id, is_deleted) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        'Id',
        { Column: 'parent_id' },
        { Column: 'order_key' },
        { Column: 'content' },
        { Column: 'create_time' },
        { Column: 'update_time' },
        { Column: 'created_by_user_id' },
        { Column: 'updated_by_user_id' },
        { Column: 'is_deleted' },
      ]
    },
    delete: {
      sql: 'UPDATE blocks SET is_deleted = 1 WHERE id = ?',
      params: ['Id']
    }
  },
  block_properties: {
    put: {
      sql: `INSERT OR REPLACE INTO block_properties 
            (block_id, name, type, value_json, change_scope) 
            VALUES (?, ?, ?, ?, ?)`,
      params: [
        { Column: 'block_id' },
        { Column: 'name' },
        { Column: 'type' },
        { Column: 'value_json' },
        { Column: 'change_scope' },
      ]
    },
    delete: {
      sql: 'DELETE FROM block_properties WHERE block_id = ? AND name = ?',
      params: [
        { Column: 'block_id' },
        { Column: 'name' }
      ]
    }
  },
  block_refs: {
    put: {
      sql: `INSERT OR REPLACE INTO block_refs 
            (block_id, target_id, ref_type, origin, alias, span_start, span_end,
             source_property_name, source_property_path, ordinal, meta_json,
             created_at, updated_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        { Column: 'block_id' },
        { Column: 'target_id' },
        { Column: 'ref_type' },
        { Column: 'origin' },
        { Column: 'alias' },
        { Column: 'span_start' },
        { Column: 'span_end' },
        { Column: 'source_property_name' },
        { Column: 'source_property_path' },
        { Column: 'ordinal' },
        { Column: 'meta_json' },
        { Column: 'created_at' },
        { Column: 'updated_at' },
      ]
    },
    delete: {
      sql: 'DELETE FROM block_refs WHERE block_id = ? AND target_id = ? AND ref_type = ? AND source_property_path = ?',
      params: [
        { Column: 'block_id' },
        { Column: 'target_id' },
        { Column: 'ref_type' },
        { Column: 'source_property_path' }
      ]
    }
  }
})
