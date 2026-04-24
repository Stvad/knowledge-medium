/**
 * Utilities for working with block aliases in the backlink system
 */

import { aliasProp } from '@/data/properties'
import type { Block } from '@/data/block'
import { visitBlocks } from '@/data/blockTraversal.ts'

const hasQueryBackedAliasLookup = (
  block: Block,
): block is Block & {
  repo: {
    getAliasesInSubtree: (rootId: string, filter?: string) => Promise<string[]>
    findBlockByAliasInSubtree: (rootId: string, alias: string) => Promise<Block | null>
  }
} =>
  typeof block.repo?.getAliasesInSubtree === 'function' &&
  typeof block.repo?.findBlockByAliasInSubtree === 'function'

/**
 * Get all aliases from blocks, optionally filtered by a search term
 * @param rootBlock The root block to start traversal from
 * @param filter Optional filter string to match against aliases (case-insensitive)
 * @returns Promise resolving to array of matching aliases
 */
export async function getAliases(rootBlock: Block, filter: string = ''): Promise<string[]> {
  if (hasQueryBackedAliasLookup(rootBlock)) {
    try {
      return await rootBlock.repo.getAliasesInSubtree(rootBlock.id, filter)
    } catch (error) {
      console.warn('Failed to query aliases from db, falling back to traversal', error)
    }
  }

  const allAliases: string[] = []
  
  await visitBlocks(rootBlock, async (block) => {
    const aliasProperty = await block.getProperty(aliasProp())
    if (aliasProperty?.value && Array.isArray(aliasProperty.value)) {
      allAliases.push(...aliasProperty.value)
    }
    return undefined // Continue traversal
  }, {catchErrors: true})
  
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
  if (hasQueryBackedAliasLookup(rootBlock)) {
    try {
      return await rootBlock.repo.findBlockByAliasInSubtree(rootBlock.id, alias)
    } catch (error) {
      console.warn('Failed to query alias from db, falling back to traversal', error)
    }
  }

  const foundBlock = await visitBlocks(rootBlock, async (block) => {
    const aliasProperty = await block.getProperty(aliasProp())
    if (aliasProperty?.value && Array.isArray(aliasProperty.value)) {
      if (aliasProperty.value.includes(alias)) {
        return block // Return block to stop traversal
      }
    }
    return undefined // Continue traversal
  }, {catchErrors: true})
  
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
