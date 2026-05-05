import { describe, it, expect } from 'vitest'
import {
  parseReferences,
  parseReferencesMarkdownAware,
  extractAliases,
  hasReferences,
  parseBlockRefs,
  isBlockRefId,
  parseBlockRefTarget,
} from '../referenceParser'

describe('referenceParser', () => {
  describe('parseReferences', () => {
    it('should parse basic [[alias]] syntax', () => {
      const content = 'This is a [[test]] reference'
      const result = parseReferences(content)
      
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        alias: 'test',
        startIndex: 10,
        endIndex: 18
      })
    })

    it('should parse multiple references', () => {
      const content = 'Here are [[first]] and [[second]] references'
      const result = parseReferences(content)
      
      expect(result).toHaveLength(2)
      expect(result[0].alias).toBe('first')
      expect(result[1].alias).toBe('second')
    })

    it('should handle nested syntax [text]([[alias]])', () => {
      const content = 'This is [display text]([[alias]]) with custom text'
      const result = parseReferences(content)
      
      expect(result).toHaveLength(1)
      expect(result[0].alias).toBe('alias')
    })

    it('should trim whitespace from aliases', () => {
      const content = 'Reference with [[ spaced alias ]] whitespace'
      const result = parseReferences(content)
      
      expect(result).toHaveLength(1)
      expect(result[0].alias).toBe('spaced alias')
    })

    it('should ignore empty references', () => {
      const content = 'Empty [[]] reference should be ignored'
      const result = parseReferences(content)
      
      expect(result).toHaveLength(0)
    })

    it('should handle malformed syntax gracefully', () => {
      const content = 'Malformed [[ incomplete and [[valid]] reference'
      const result = parseReferences(content)
      
      expect(result).toHaveLength(1)
      expect(result[0].alias).toBe('valid')
    })

    it('should handle aliases with special characters', () => {
      const content = 'Reference to [[AI/ML Research]] and [[Node.js]]'
      const result = parseReferences(content)
      
      expect(result).toHaveLength(2)
      expect(result[0].alias).toBe('AI/ML Research')
      expect(result[1].alias).toBe('Node.js')
    })

    it('should handle nested references correctly', () => {
      const content = 'Outer [[outer with [[inner]] nested]] reference'
      const result = parseReferences(content)
      
      expect(result).toHaveLength(2)
      expect(result[0].alias).toBe('outer with [[inner]] nested')
      expect(result[1].alias).toBe('inner')
    })

    it('should handle multiple levels of nesting', () => {
      const content = '[[level1 [[level2 [[level3]] nested]] here]]'
      const result = parseReferences(content)
      
      expect(result).toHaveLength(3)
      expect(result[0].alias).toBe('level1 [[level2 [[level3]] nested]] here')
      expect(result[1].alias).toBe('level2 [[level3]] nested')
      expect(result[2].alias).toBe('level3')
    })

    it('should handle adjacent nested references', () => {
      const content = '[[first [[nested1]]]][[second [[nested2]]]]'
      const result = parseReferences(content)
      
      expect(result).toHaveLength(4)
      expect(result[0].alias).toBe('first [[nested1]]')
      expect(result[1].alias).toBe('nested1')
      expect(result[2].alias).toBe('second [[nested2]]')
      expect(result[3].alias).toBe('nested2')
    })
  })

  describe('parseReferencesMarkdownAware', () => {
    it('should parse references while respecting markdown structure', () => {
      const content = 'Normal [[reference]] and `code with [[not-a-ref]]`'
      const result = parseReferencesMarkdownAware(content)
      
      // Should find the normal reference but skip the one in code
      expect(result).toHaveLength(1)
      expect(result[0].alias).toBe('reference')
    })

    it('should handle code blocks', () => {
      const content = `
Normal [[reference]] here

\`\`\`
Code block with [[code-ref]]
\`\`\`

Another [[normal-ref]]
`
      const result = parseReferencesMarkdownAware(content)
      
      expect(result).toHaveLength(2)
      expect(result.map(r => r.alias)).toEqual(['reference', 'normal-ref'])
    })

    it('should fallback to regex parsing on error', () => {
      // Test with malformed markdown that might break remark
      const content = 'Simple [[reference]] test'
      const result = parseReferencesMarkdownAware(content)
      
      expect(result).toHaveLength(1)
      expect(result[0].alias).toBe('reference')
    })
  })

  describe('extractAliases', () => {
    it('should extract unique aliases', () => {
      const content = 'Multiple [[test]] and [[other]] and [[test]] again'
      const result = extractAliases(content)
      
      expect(result).toHaveLength(2)
      expect(result).toContain('test')
      expect(result).toContain('other')
    })

    it('should return empty array for no references', () => {
      const content = 'No references here'
      const result = extractAliases(content)
      
      expect(result).toHaveLength(0)
    })
  })

  describe('hasReferences', () => {
    it('should return true when references exist', () => {
      expect(hasReferences('Has [[reference]]')).toBe(true)
    })

    it('should return false when no references exist', () => {
      expect(hasReferences('No references here')).toBe(false)
    })

    it('should return false for malformed references', () => {
      expect(hasReferences('Malformed [[ reference')).toBe(false)
    })
  })

  describe('parseBlockRefs', () => {
    const id = '0123abcd-4567-89ef-0123-456789abcdef'
    const id2 = 'fedcba98-7654-3210-fedc-ba9876543210'

    it('parses a bare ((uuid)) ref', () => {
      const result = parseBlockRefs(`see ((${id})) for context`)
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({blockId: id, embed: false})
    })

    it('parses an aliased [label](((uuid))) ref as one block ref span', () => {
      const content = `see [named block](((${id}))) for context`
      const result = parseBlockRefs(content)
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({blockId: id, embed: false, label: 'named block'})
      expect(content.slice(result[0].startIndex, result[0].endIndex)).toBe(`[named block](((${id})))`)
    })

    it('parses a !((uuid)) embed', () => {
      const result = parseBlockRefs(`!((${id}))`)
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({blockId: id, embed: true})
    })

    it('does not double-count the inner ref of a !((uuid)) embed', () => {
      const result = parseBlockRefs(`!((${id})) and ((${id2}))`)
      expect(result).toHaveLength(2)
      expect(result[0]).toMatchObject({blockId: id, embed: true})
      expect(result[1]).toMatchObject({blockId: id2, embed: false})
    })

    it('treats a bare !((uuid)) at start of line as embed', () => {
      const result = parseBlockRefs(`!((${id}))\nrest`)
      expect(result[0]).toMatchObject({blockId: id, embed: true})
    })

    it('ignores ((not-a-uuid))', () => {
      expect(parseBlockRefs('((hello world))')).toHaveLength(0)
    })

    it('lowercases the captured id', () => {
      const upper = id.toUpperCase()
      const [ref] = parseBlockRefs(`((${upper}))`)
      expect(ref.blockId).toBe(id)
    })
  })

  describe('parseBlockRefTarget', () => {
    it('accepts a markdown link destination for a block ref', () => {
      expect(parseBlockRefTarget('((0123ABCD-4567-89EF-0123-456789ABCDEF))')).toBe(
        '0123abcd-4567-89ef-0123-456789abcdef',
      )
    })

    it('rejects non-block-ref destinations', () => {
      expect(parseBlockRefTarget('https://example.com')).toBeNull()
      expect(parseBlockRefTarget('(((0123abcd-4567-89ef-0123-456789abcdef)))')).toBeNull()
    })
  })

  describe('isBlockRefId', () => {
    it('accepts a uuid', () => {
      expect(isBlockRefId('0123abcd-4567-89ef-0123-456789abcdef')).toBe(true)
    })
    it('rejects non-uuid', () => {
      expect(isBlockRefId('not-a-uuid')).toBe(false)
    })
  })
})
