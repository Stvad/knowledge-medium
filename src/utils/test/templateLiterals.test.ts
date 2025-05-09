import { describe, it, expect } from 'vitest'
import { reassembleTag, reassembleTagProducer } from '../templateLiterals'

describe('templateLiterals', () => {
  describe('reassembleTag', () => {
    it('should correctly reassemble a simple tag', () => {
      const result = reassembleTag`basicString`
      expect(result).toBe('basicString')
    })

    it('should reassemble the template with in-line template', () => {
      const value = "world"
      const result = reassembleTag`hello ${value}`
      expect(result).toBe('hello world')
    })

    it('should reassemble the template with in-line template mid string', () => {
      const value = "world"
      const result = reassembleTag`hello ${value} 2`
      expect(result).toBe('hello world 2')
    })

  })

  describe('reassembleTagProducer', () => {
    it('should round trip', () => {
      const consumer = (value: string) => value
      const template = reassembleTagProducer(consumer)
      const result = template`hello ${123}`
      expect(result).toEqual('hello 123')
    })
  })
})
