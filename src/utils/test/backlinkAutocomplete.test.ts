import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { CompletionContext } from '@codemirror/autocomplete'
import {
  type BacklinkCompletionCandidate,
  backlinkCompletionSource,
  isInsideBacklinkBrackets,
} from '../backlinkAutocomplete'

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

  describe('completion source filter behavior', () => {
    const callSource = async (
      text: string,
      cursorPos: number,
      aliases: Array<string | BacklinkCompletionCandidate>,
    ) => {
      const state = EditorState.create({doc: text})
      const context = new CompletionContext(state, cursorPos, false)
      const source = backlinkCompletionSource({getAliases: async () => aliases})
      return source(context)
    }

    it('returns filter:false so non-substring suggestions (e.g. resolved dates) survive CM filtering', async () => {
      // Simulate user typing "[[fri" — getAliases returns the long-form
      // date that the relative-date parser resolved upstream.
      const result = await callSource('[[fri', 5, ['April 30th, 2026'])
      expect(result).not.toBeNull()
      expect(result!.filter).toBe(false)
    })

    it('still surfaces option labels verbatim — CM uses them for insertion', async () => {
      const result = await callSource('[[fri', 5, ['April 30th, 2026'])
      expect(result!.options.map(opt => opt.label)).toEqual(['April 30th, 2026'])
    })

    it('supports candidates whose visible label differs from inserted text', async () => {
      const result = await callSource('[[to', 4, [{
        label: 'April 28th, 2026',
        apply: '2026-04-28',
        detail: 'today',
      }])
      expect(result!.options.map(opt => ({
        label: opt.label,
        detail: opt.detail,
      }))).toEqual([{
        label: 'April 28th, 2026',
        detail: 'today',
      }])
    })
  })
})
