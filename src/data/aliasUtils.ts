/**
 * Utilities for working with block aliases in the backlink system
 */

import { aliasProp } from '@/data/properties'
import { Block } from '@/data/block'

/**
 * Generic block visitor that traverses a block tree and calls a visitor function on each block
 * @param rootBlock The root block to start traversal from
 * @param visitor Function called for each block, can return a value to stop traversal early
 * @returns Promise resolving to the early return value if any, or undefined
 */
async function visitBlocks<T>(
  rootBlock: Block,
  visitor: (block: Block) => Promise<T | undefined>
): Promise<T | undefined> {
  const visitedBlocks = new Set<string>()
  
  const traverse = async (block: Block): Promise<T | undefined> => {
    if (visitedBlocks.has(block.id)) return undefined
    visitedBlocks.add(block.id)
    
    try {
      // Call visitor function - if it returns a value, stop traversal
      const result = await visitor(block)
      if (result !== undefined) return result
      
      // Recursively traverse children
      const children = await block.children()
      for (const child of children) {
        const childResult = await traverse(child)
        if (childResult !== undefined) return childResult
      }
    } catch (error) {
      // Skip blocks that can't be read
      console.warn('Error visiting block:', block.id, error)
    }
    
    return undefined
  }
  
  try {
    return traverse(rootBlock)
  } catch (error) {
    console.warn('Error in block traversal:', error)
    return undefined
  }
}

/**
 * Get all aliases from blocks, optionally filtered by a search term
 * @param rootBlock The root block to start traversal from
 * @param filter Optional filter string to match against aliases (case-insensitive)
 * @returns Promise resolving to array of matching aliases
 */
export async function getAliases(rootBlock: Block, filter: string = ''): Promise<string[]> {
  const allAliases: string[] = []
  
  await visitBlocks(rootBlock, async (block) => {
    const aliasProperty = await block.getProperty(aliasProp())
    if (aliasProperty?.value && Array.isArray(aliasProperty.value)) {
      allAliases.push(...aliasProperty.value)
    }
    return undefined // Continue traversal
  })
  
  // Filter aliases based on search term
  const filteredAliases = filter 
    ? allAliases.filter(alias => 
        alias.toLowerCase().includes(filter.toLowerCase())
      )
    : allAliases
  
  // Return unique aliases
  return Array.from(new Set(filteredAliases))
}

/**
 * Find a block by its alias
 * @param rootBlock The root block to start traversal from
 * @param alias The alias to search for
 * @returns Promise resolving to the block with the given alias, or null if not found
 */
export async function findBlockByAlias(rootBlock: Block, alias: string): Promise<Block | null> {
  const foundBlock = await visitBlocks(rootBlock, async (block) => {
    const aliasProperty = await block.getProperty(aliasProp())
    if (aliasProperty?.value && Array.isArray(aliasProperty.value)) {
      if (aliasProperty.value.includes(alias)) {
        return block // Return block to stop traversal
      }
    }
    return undefined // Continue traversal
  })
  
  return foundBlock || null
}

/**
 * Check if an alias already exists in the system
 * @param rootBlock The root block to start traversal from
 * @param alias The alias to check
 * @returns Promise resolving to true if alias exists, false otherwise
 */
export async function aliasExists(rootBlock: Block, alias: string): Promise<boolean> {
  const block = await findBlockByAlias(rootBlock, alias)
  return block !== null
}
