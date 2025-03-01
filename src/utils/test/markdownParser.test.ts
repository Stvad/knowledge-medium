import { describe, it, expect } from 'vitest'
import { parseMarkdownToBlocks } from '@/utils/markdownParser'

describe('markdownParser', () => {

  describe('parseMarkdownToBlocks', () => {
    it('should parse a simple markdown string into blocks', () => {
      const markdown = 'First line\nSecond line'
      const result = parseMarkdownToBlocks(markdown)

      expect(result).toHaveLength(2)
      expect(result[0].content).toBe('First line')
      expect(result[1].content).toBe('Second line')
      expect(result[0].childIds).toEqual([])
    })

    it('should handle indentation to create parent-child relationships', () => {
      const markdown = 'Parent\n  Child\n    Grandchild'
      const result = parseMarkdownToBlocks(markdown)

      expect(result).toHaveLength(3)
      expect(result[0].content).toBe('Parent')
      expect(result[1].content).toBe('Child')
      expect(result[2].content).toBe('Grandchild')

      // Check parent-child relationships
      expect(result[1].parentId).toBe(result[0].id)
      expect(result[2].parentId).toBe(result[1].id)
      expect(result[0].childIds).toContain(result[1].id)
      expect(result[1].childIds).toContain(result[2].id)
    })

    it('should handle list markers', () => {
      const markdown = `
- First item
- Second item
  - Nested item`
      const result = parseMarkdownToBlocks(markdown)

      expect(result).toHaveLength(3)
      expect(result[0].content).toBe('First item')
      expect(result[1].content).toBe('Second item')
      expect(result[2].content).toBe('Nested item')

      // Check parent-child relationships
      expect(result[1].parentId).toBe(undefined)
      expect(result[2].parentId).toBe(result[1].id)
    })

    it('should handle empty lines', () => {
      const markdown = 'First line\n\nSecond line'
      const result = parseMarkdownToBlocks(markdown)

      expect(result).toHaveLength(2)
      expect(result[0].content).toBe('First line')
      expect(result[1].content).toBe('Second line')
    })

    it('should handle mixed indentation and list markers', () => {
      const markdown = `
Root
  - First item
    - Nested item
  Second item`
      const result = parseMarkdownToBlocks(markdown)

      expect(result).toHaveLength(4)
      expect(result[0].content).toBe('Root')
      expect(result[1].content).toBe('First item')
      expect(result[2].content).toBe('Nested item')
      expect(result[3].content).toBe('Second item')

      // Check parent-child relationships
      expect(result[1].parentId).toBe(result[0].id)
      expect(result[2].parentId).toBe(result[1].id)
      expect(result[3].parentId).toBe(result[0].id)
    })

    it('should handle numbered lists', () => {
      const markdown = '1. First item\n2. Second item\n   1. Nested item'
      const result = parseMarkdownToBlocks(markdown)

      expect(result).toHaveLength(3)
      expect(result[0].content).toBe('First item')
      expect(result[1].content).toBe('Second item')
      expect(result[2].content).toBe('Nested item')
    })

    it('should set default properties', () => {
      const markdown = 'Single line'
      const result = parseMarkdownToBlocks(markdown)

      expect(result).toHaveLength(1)
      expect(result[0].properties).toEqual({})
      expect(result[0].childIds).toEqual([])
    })
  })
})
