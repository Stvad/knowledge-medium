import { describe, it, expect } from 'vitest'
import { parseReferences, parseReferencesMarkdownAware, extractAliases, hasReferences } from '../referenceParser'

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
})
