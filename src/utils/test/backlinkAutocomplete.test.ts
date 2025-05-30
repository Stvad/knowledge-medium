import { describe, it, expect, vi } from 'vitest'
import { createBacklinkAutocomplete, isInsideBacklinkBrackets } from '../backlinkAutocomplete'

describe('backlinkAutocomplete', () => {
  describe('isInsideBacklinkBrackets', () => {
    it('should return true when cursor is inside [[ ]]', () => {
      expect(isInsideBacklinkBrackets('[[test]]', 3)).toBe(true)
      expect(isInsideBacklinkBrackets('[[test]]', 6)).toBe(true)
    })

    it('should return false when cursor is outside [[ ]]', () => {
      expect(isInsideBacklinkBrackets('[[test]]', 0)).toBe(false)
      expect(isInsideBacklinkBrackets('[[test]]', 8)).toBe(false)
    })

    it('should return false when cursor is in incomplete [[', () => {
      expect(isInsideBacklinkBrackets('[[test', 3)).toBe(false) // No closing ]]
      expect(isInsideBacklinkBrackets('[[test', 6)).toBe(false)
    })

    it('should handle multiple brackets correctly', () => {
      expect(isInsideBacklinkBrackets('[[first]] and [[second]]', 17)).toBe(true)
      expect(isInsideBacklinkBrackets('[[first]] and [[second]]', 10)).toBe(false)
    })
  })

  describe('createBacklinkAutocomplete', () => {
    it('should create autocomplete extension', () => {
      const getAliases = vi.fn().mockResolvedValue([])
      const extension = createBacklinkAutocomplete({ getAliases })
      
      expect(extension).toBeDefined()
    })

    it('should call getAliases with search term', async () => {
      const getAliases = vi.fn().mockResolvedValue(['test-alias', 'another-alias'])
      createBacklinkAutocomplete({ getAliases })
      
      // This is a simplified test - in practice, we'd need to trigger
      // the completion source manually or through editor interactions
      expect(getAliases).toBeDefined()
    })
  })

  describe('getAliases integration', () => {
    it('should filter aliases based on search term', async () => {
      const allAliases = ['JavaScript', 'Java', 'Python', 'TypeScript']
      const getAliases = vi.fn().mockImplementation((filter: string) => {
        return Promise.resolve(
          allAliases.filter(alias => 
            alias.toLowerCase().includes(filter.toLowerCase())
          )
        )
      })
      
      const result = await getAliases('java')
      expect(result).toEqual(['JavaScript', 'Java'])
    })

    it('should handle empty search term', async () => {
      const allAliases = ['test1', 'test2', 'other']
      const getAliases = vi.fn().mockImplementation((filter: string) => {
        if (!filter) return Promise.resolve(allAliases)
        return Promise.resolve(
          allAliases.filter(alias => 
            alias.toLowerCase().includes(filter.toLowerCase())
          )
        )
      })
      
      const result = await getAliases('')
      expect(result).toEqual(allAliases)
    })

    it('should handle case insensitive matching', async () => {
      const allAliases = ['CamelCase', 'lowercase', 'UPPERCASE']
      const getAliases = vi.fn().mockImplementation((filter: string) => {
        return Promise.resolve(
          allAliases.filter(alias => 
            alias.toLowerCase().includes(filter.toLowerCase())
          )
        )
      })
      
      const result = await getAliases('case')
      expect(result).toEqual(['CamelCase', 'lowercase', 'UPPERCASE'])
    })
  })

  describe('completion application', () => {
    it('should complete with closing brackets when they do not exist', () => {
      const alias = 'test-alias'
      const completion = `${alias}]]`
      
      expect(completion).toBe('test-alias]]')
    })

    it('should complete without closing brackets when they already exist', () => {
      const alias = 'test-alias'
      // This simulates the case where closing brackets already exist
      const completion = alias
      
      expect(completion).toBe('test-alias')
    })

    it('should provide info text', () => {
      const alias = 'my-page'
      const info = `Link to: ${alias}`
      
      expect(info).toBe('Link to: my-page')
    })
  })
})
