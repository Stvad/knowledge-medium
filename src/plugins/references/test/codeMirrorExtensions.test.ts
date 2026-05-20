import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { wikilinkBoundaryInputTransaction } from '../codeMirrorExtensions.ts'

const applyInput = (doc: string, pos: number, insert: string) => {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(pos),
  })
  const transaction = wikilinkBoundaryInputTransaction(state, pos, pos, insert)
  if (!transaction) return null

  const next = state.update(transaction).state
  return {
    doc: next.doc.toString(),
    head: next.selection.main.head,
  }
}

describe('references CodeMirror extensions', () => {
  describe('wikilink boundary input', () => {
    it('inserts space after a wikilink when the cursor is between the closing brackets', () => {
      expect(applyInput('[[i]]', 4, ' ')).toEqual({
        doc: '[[i]] ',
        head: 6,
      })
    })

    it('does not move ordinary alias edits outside the closing delimiter seam', () => {
      expect(applyInput('[[i]]', 3, ' ')).toBeNull()
    })

    it('leaves bracket-closing to CodeMirror when the user types ] manually', () => {
      expect(applyInput('[[i]]', 3, ']')).toBeNull()
    })

    it('does not handle unmatched closing brackets outside a wikilink', () => {
      expect(applyInput('plain ]]', 7, ' ')).toBeNull()
    })
  })
})
