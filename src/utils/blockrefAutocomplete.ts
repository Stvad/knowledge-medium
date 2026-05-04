/**
 * CodeMirror completion source for `((` block-ref syntax. Triggers when the
 * cursor is inside `((<filter>` and surfaces blocks whose content matches.
 * Picking a candidate inserts `<block-id>))` after the existing `((`.
 *
 * Companion to backlinkAutocomplete.ts — searches by content instead of alias
 * because block refs target arbitrary blocks, not aliased pages.
 */

import { EditorSelection } from '@codemirror/state'
import { CompletionContext, CompletionResult } from '@codemirror/autocomplete'

export interface BlockSearchHit {
  id: string
  content: string
}

export interface BlockrefAutocompleteOptions {
  searchBlocks: (filter: string) => Promise<BlockSearchHit[]>
}

const stripWhitespace = (s: string) => s.replace(/\s+/g, ' ').trim()

export function blockrefCompletionSource(options: BlockrefAutocompleteOptions) {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const {state, pos} = context
    const line = state.doc.lineAt(pos)
    const lineText = line.text
    const linePos = pos - line.from

    const beforeCursor = lineText.slice(0, linePos)
    const afterCursor = lineText.slice(linePos)

    // Match the most recent `((` before the cursor, capturing whatever was
    // typed since. The negative pattern `[^)]*?` keeps us from spanning
    // across an already-closed `((id))` earlier on the line.
    const openMatch = beforeCursor.match(/\(\(([^)]*?)$/)
    if (!openMatch) return null

    const filter = openMatch[1]
    // Cheap noise filter — without something to search, surfacing every block
    // in the workspace is just clutter.
    if (filter.length === 0 && !context.explicit) return null

    const startPos = line.from + openMatch.index! + 2
    const closingExists = afterCursor.startsWith('))')

    const hits = await options.searchBlocks(filter)
    if (hits.length === 0) return null

    return {
      from: startPos,
      to: pos,
      filter: false,
      options: hits.map(hit => {
        const label = stripWhitespace(hit.content) || hit.id
        return {
          label,
          // The literal block id is what actually gets inserted; we surface
          // the content as the user-facing label since UUIDs are unreadable.
          apply: (view, _, from, to) => {
            view.dispatch({
              changes: {from, to, insert: closingExists ? hit.id : `${hit.id}))`},
              selection: EditorSelection.cursor(from + hit.id.length + 2),
            })
          },
          type: 'variable',
        }
      }),
    }
  }
}
