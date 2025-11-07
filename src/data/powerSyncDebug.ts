import { powerSyncDb } from './powerSyncInstance'

/**
 * Debug utility to verify PowerSync tables were created correctly
 * Run this in browser console: window.checkPowerSyncTables()
 */
export async function checkPowerSyncTables() {
  console.log('🔍 Checking PowerSync tables...')
  
  try {
    // Check if tables exist
    const tables = await powerSyncDb.getAll<{name: string}>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    )
    
    console.log('📋 Tables found:', tables.map(t => t.name))
    
    // Check blocks table structure
    const blocksInfo = await powerSyncDb.getAll(
      'PRAGMA table_info(blocks)'
    )
    console.log('\n🧱 Blocks table structure:', blocksInfo)
    
    // Check block_properties table structure  
    const propsInfo = await powerSyncDb.getAll(
      'PRAGMA table_info(block_properties)'
    )
    console.log('\n📝 Block properties table structure:', propsInfo)
    
    // Check block_refs table structure
    const refsInfo = await powerSyncDb.getAll(
      'PRAGMA table_info(block_refs)'
    )
    console.log('\n🔗 Block refs table structure:', refsInfo)
    
    // Check indexes
    const indexes = await powerSyncDb.getAll(
      "SELECT name, tbl_name FROM sqlite_master WHERE type='index' ORDER BY tbl_name, name"
    )
    console.log('\n🗂️ Indexes:', indexes)
    
    // Check FTS table
    const ftsExists = tables.some(t => t.name === 'blocks_fts')
    console.log('\n🔎 FTS enabled:', ftsExists)
    
    console.log('\n✅ PowerSync setup verified!')
    return true
  } catch (error) {
    console.error('❌ PowerSync check failed:', error)
    return false
  }
}

/**
 * Test inserting a block into PowerSync
 * Run this in browser console: window.testPowerSyncInsert()
 */
export async function testPowerSyncInsert() {
  console.log('🧪 Testing PowerSync insert...')
  
  try {
    const testId = 'test-block-' + Date.now()
    
    await powerSyncDb.execute(
      `INSERT INTO blocks 
       (id, parent_id, order_key, content, create_time, update_time, 
        created_by_user_id, updated_by_user_id, is_deleted)
       VALUES (?, NULL, '0|0', 'Test block', ?, ?, 'test-user', 'test-user', 0)`,
      [testId, Date.now(), Date.now()]
    )
    
    console.log('✅ Insert successful, ID:', testId)
    
    // Read it back
    const result = await powerSyncDb.getOptional(
      'SELECT * FROM blocks WHERE id = ?',
      [testId]
    )
    
    console.log('📖 Retrieved block:', result)
    
    // Clean up
    await powerSyncDb.execute(
      'DELETE FROM blocks WHERE id = ?',
      [testId]
    )
    
    console.log('🧹 Cleanup complete')
    return true
  } catch (error) {
    console.error('❌ Test failed:', error)
    return false
  }
}

// Expose to window for easy console access
if (typeof window !== 'undefined') {
  (window as any).checkPowerSyncTables = checkPowerSyncTables;
  (window as any).testPowerSyncInsert = testPowerSyncInsert;
  (window as any).powerSyncDb = powerSyncDb
}
