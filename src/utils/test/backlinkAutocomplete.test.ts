import { describe, it, expect, vi } from 'vitest'
import { EditorState, EditorSelection } from '@codemirror/state'
import { CompletionContext, insertBracket } from '@codemirror/autocomplete'
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

  // Select `world`, type `[` `[` — `closeBrackets` wraps the selection and
  // leaves `world` selected inside `[[…]]`. CodeMirror anchors the
  // CompletionContext at `selection.main.from` (its `cur()`), which here is
  // the position just after `[[`, so reading the query at `context.pos`
  // yields '' and `[[` offers the bare-trigger suggestions (the navigation
  // MRU) instead of completing on the text that was just wrapped.
  describe('query region with a wrapped selection', () => {
    /** Type `bracket` over the selection the way `closeBrackets` does, then
     *  build the context where the autocomplete plugin builds it. Driving
     *  the real `insertBracket` keeps the upstream facts under test: that
     *  wrapping leaves the text selected, and that `cur()` is the range's
     *  `from` rather than its head. */
    const afterWrapping = (doc: string, from: number, to: number, brackets: string) => {
      let state = EditorState.create({doc, selection: EditorSelection.range(from, to)})
      for (const bracket of brackets) {
        const tr = insertBracket(state, bracket)
        expect(tr).not.toBeNull()
        state = tr!.state
      }
      return {state, context: new CompletionContext(state, state.selection.main.from, false)}
    }

    it('leaves the wrapped text selected, with the query anchor at the [[', () => {
      const {state, context} = afterWrapping('hello world', 6, 11, '[[')
      expect(state.doc.toString()).toBe('hello [[world]]')
      expect([context.pos, state.selection.main.to]).toEqual([8, 13])
    })

    it('searches on the selected text, not the empty string', async () => {
      const getAliases = vi.fn().mockResolvedValue(['World News'])
      const source = backlinkCompletionSource({getAliases})
      await source(afterWrapping('hello world', 6, 11, '[[').context)
      expect(getAliases).toHaveBeenCalledWith('world')
    })

    it('spans the whole selection, so accepting replaces the wrapped text', async () => {
      const source = backlinkCompletionSource({getAliases: async () => ['World News']})
      const result = await source(afterWrapping('hello world', 6, 11, '[[').context)
      expect(result).toMatchObject({from: 8, to: 13})
    })
  })
})
