import { automergeRepo } from './repoInstance'
import { powerSyncDb } from './powerSyncInstance'
import { BlockData, BlockProperty } from '@/types'
import { LexoRank } from 'lexorank'

/**
 * Migrate Automerge data to PowerSync SQLite
 * Call from browser console: window.migrateAutomergeToSqlite('automerge:...')
 */
export async function migrateAutomergeToSqlite(rootBlockId: string) {
  console.log('🚀 Starting Automerge → SQLite migration...')
  console.log('📍 Root block ID:', rootBlockId)
  
  try {
    // Step 1: Recursively fetch all blocks from Automerge
    const allBlocks = await getAllAutomergeBlocks(rootBlockId)
    console.log(`📦 Found ${allBlocks.length} blocks to migrate`)
    
    // Step 2: Migrate blocks to PowerSync
    await powerSyncDb.writeTransaction(async (tx) => {
      let migratedCount = 0
      
      for (const blockData of allBlocks) {
        await migrateBlock(tx, blockData)
        migratedCount++
        
        if (migratedCount % 100 === 0) {
          console.log(`  ⏳ Migrated ${migratedCount}/${allBlocks.length} blocks...`)
        }
      }
      
      console.log(`✅ Successfully migrated ${migratedCount} blocks!`)
    })
    
    // Step 3: Verify migration
    const blockCount = await powerSyncDb.getOptional<{count: number}>(
      'SELECT COUNT(*) as count FROM blocks WHERE is_deleted = 0'
    )
    console.log(`✨ Verification: ${blockCount?.count} blocks in PowerSync`)
    
    return {
      success: true,
      migratedCount: allBlocks.length,
      verifiedCount: blockCount?.count
    }
  } catch (error) {
    console.error('❌ Migration failed:', error)
    throw error
  }
}

/**
 * Recursively fetch all blocks starting from root
 */
async function getAllAutomergeBlocks(rootId: string): Promise<BlockData[]> {
  const blocks: BlockData[] = []
  const seen = new Set<string>()
  
  async function traverse(id: string) {
    if (seen.has(id)) return
    seen.add(id)
    
    try {
      const handle = automergeRepo.find(id as any)
      const doc = await handle.doc() as BlockData | undefined
      
      if (!doc) {
        console.warn(`⚠️ Block ${id} not found, skipping`)
        return
      }
      
      blocks.push(doc)
      
      // Recursively traverse children
      for (const childId of doc.childIds || []) {
        await traverse(childId)
      }
    } catch (error) {
      console.warn(`⚠️ Error fetching block ${id}:`, error)
    }
  }
  
  await traverse(rootId)
  return blocks
}

/**
 * Migrate a single block to PowerSync
 */
async function migrateBlock(tx: any, blockData: BlockData) {
  const now = Date.now()
  
  // Generate order_key for children positioning
  const orderKey = await generateOrderKey(tx, blockData.parentId)
  
  // Insert block
  await tx.execute(
    `INSERT OR REPLACE INTO blocks 
     (id, parent_id, order_key, content, create_time, update_time, 
      created_by_user_id, updated_by_user_id, is_deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      blockData.id,
      blockData.parentId || null,
      orderKey,
      blockData.content || '',
      blockData.createTime || now,
      blockData.updateTime || now,
      blockData.createdByUserId || 'migrated-user',
      blockData.updatedByUserId || 'migrated-user'
    ]
  )
  
  // Insert properties
  for (const [name, prop] of Object.entries(blockData.properties || {})) {
    if (!prop) continue
    await migrateProperty(tx, blockData.id, name, prop)
  }
  
  // Insert references (text-based)
  for (const ref of blockData.references || []) {
    await tx.execute(
      `INSERT OR REPLACE INTO block_refs 
       (block_id, target_id, ref_type, origin, alias, span_start, span_end,
        source_property_name, source_property_path, ordinal, meta_json,
        created_at, updated_at)
       VALUES (?, ?, 'text-reference', 'text', ?, NULL, NULL, NULL, '', NULL, NULL, ?, ?)`,
      [
        blockData.id,
        ref.id,
        ref.alias,
        now,
        now
      ]
    )
  }
}

/**
 * Migrate a block property
 */
async function migrateProperty(
  tx: any,
  blockId: string,
  name: string,
  prop: BlockProperty
) {
  const type = inferPropertyType(prop.value)
  
  await tx.execute(
    `INSERT OR REPLACE INTO block_properties 
     (block_id, name, type, value_json, change_scope)
     VALUES (?, ?, ?, ?, ?)`,
    [
      blockId,
      name,
      type,
      JSON.stringify(prop.value),
      prop.changeScope || null
    ]
  )
}

/**
 * Infer property type from value
 */
function inferPropertyType(value: any): string {
  if (value === null) return 'null'
  if (value === undefined) return 'null'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'object') return 'object'
  return 'string'
}

/**
 * Generate order_key for a block based on its siblings
 */
async function generateOrderKey(tx: any, parentId: string | undefined): Promise<string> {
  if (!parentId) {
    return LexoRank.middle().toString()
  }
  
  // Get the last child's order_key
  const lastChild = await tx.getOptional(
    'SELECT order_key FROM blocks WHERE parent_id = ? AND is_deleted = 0 ORDER BY order_key DESC LIMIT 1',
    [parentId]
  ) as {order_key: string} | null
  
  if (!lastChild) {
    return LexoRank.middle().toString()
  }
  
  try {
    const prevRank = LexoRank.parse(lastChild.order_key)
    return prevRank.genNext().toString()
  } catch {
    // If parsing fails, use middle
    return LexoRank.middle().toString()
  }
}

/**
 * Helper to get current URL hash (root block ID)
 */
export function getCurrentRootBlockId(): string | null {
  const hash = window.location.hash
  return hash ? hash.substring(1) : null
}

// Expose to window for console access
if (typeof window !== 'undefined') {
  (window as any).migrateAutomergeToSqlite = migrateAutomergeToSqlite;
  (window as any).getCurrentRootBlockId = getCurrentRootBlockId
}
