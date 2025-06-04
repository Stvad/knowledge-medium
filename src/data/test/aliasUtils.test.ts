import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getAliases, findBlockByAlias, aliasExists } from '../aliasUtils'
import { Block } from '../block'

// Mock the dependencies
vi.mock('../repo')
vi.mock('../block')

describe('aliasUtils', () => {
  let mockRootBlock: Block
  let mockChildBlock: Block
  const rootBlockId = 'root-block-id'

  beforeEach(() => {
    mockChildBlock = {
      id: 'child-block-id',
      getProperty: vi.fn(),
      children: vi.fn().mockResolvedValue([])
    } as unknown as Block

    mockRootBlock = {
      id: rootBlockId,
      getProperty: vi.fn(),
      children: vi.fn().mockResolvedValue([mockChildBlock])
    } as unknown as Block
  })

  describe('getAliases', () => {
    it('should return empty array when no aliases exist', async () => {
      mockRootBlock.getProperty = vi.fn().mockResolvedValue(null)

      const result = await getAliases(mockRootBlock)
      
      expect(result).toEqual([])
    })

    it('should collect aliases from root and child blocks', async () => {
      mockRootBlock.getProperty = vi.fn().mockResolvedValue({
        value: ['root-alias']
      })
      mockChildBlock.getProperty = vi.fn().mockResolvedValue({
        value: ['child-alias']
      })
      
      const result = await getAliases(mockRootBlock)
      
      expect(result).toEqual(['root-alias', 'child-alias'])
    })

    it('should filter aliases based on search term', async () => {
      mockRootBlock.getProperty = vi.fn().mockResolvedValue({
        value: ['JavaScript', 'Java']
      })
      mockChildBlock.getProperty = vi.fn().mockResolvedValue({
        value: ['Python', 'TypeScript']
      })
      
      const result = await getAliases(mockRootBlock, 'java')
      
      expect(result).toEqual(['JavaScript', 'Java'])
    })

    it('should handle case insensitive filtering', async () => {
      mockRootBlock.getProperty = vi.fn().mockResolvedValue({
        value: ['CamelCase', 'lowercase']
      })
      mockChildBlock.getProperty = vi.fn().mockResolvedValue({
        value: ['UPPERCASE']
      })
      
      const result = await getAliases(mockRootBlock, 'CASE')
      
      expect(result).toEqual(['CamelCase', 'lowercase', 'UPPERCASE'])
    })

    it('should return unique aliases', async () => {
      mockRootBlock.getProperty = vi.fn().mockResolvedValue({
        value: ['test', 'other']
      })
      mockChildBlock.getProperty = vi.fn().mockResolvedValue({
        value: ['test', 'another']
      })
      
      const result = await getAliases(mockRootBlock)
      
      expect(result).toEqual(['test', 'other', 'another'])
    })

    it('should handle errors gracefully', async () => {
      mockRootBlock.getProperty = vi.fn().mockRejectedValue(new Error('Block read error'))
      
      const result = await getAliases(mockRootBlock)
      
      expect(result).toEqual([])
    })
  })

  describe('findBlockByAlias', () => {
    it('should find block with matching alias', async () => {
      mockRootBlock.getProperty = vi.fn().mockResolvedValue({
        value: ['root-alias']
      })
      mockChildBlock.getProperty = vi.fn().mockResolvedValue({
        value: ['target-alias']
      })
      
      const result = await findBlockByAlias(mockRootBlock, 'target-alias')
      
      expect(result).toBe(mockChildBlock)
    })

    it('should return null when alias not found', async () => {
      mockRootBlock.getProperty = vi.fn().mockResolvedValue({
        value: ['root-alias']
      })
      mockChildBlock.getProperty = vi.fn().mockResolvedValue({
        value: ['child-alias']
      })
      
      const result = await findBlockByAlias(mockRootBlock, 'nonexistent-alias')
      
      expect(result).toBeNull()
    })
  })

  describe('aliasExists', () => {
    it('should return true when alias exists', async () => {
      mockRootBlock.getProperty = vi.fn().mockResolvedValue({
        value: ['existing-alias']
      })
      
      const result = await aliasExists(mockRootBlock, 'existing-alias')
      
      expect(result).toBe(true)
    })

    it('should return false when alias does not exist', async () => {
      mockRootBlock.getProperty = vi.fn().mockResolvedValue({
        value: ['other-alias']
      })
      
      const result = await aliasExists(mockRootBlock, 'nonexistent-alias')
      
      expect(result).toBe(false)
    })
  })
})
