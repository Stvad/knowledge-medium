/**
 * CodeMirror extension for [[alias]] autocomplete
 * Triggers on [[ input and shows available aliases
 */

import { Extension, EditorSelection } from '@codemirror/state'
import { autocompletion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { keymap } from '@codemirror/view'
import { completionKeymapWithEscapeFallthrough } from '@/utils/codemirrorCompletion.js'

export interface BacklinkCompletionCandidate {
  label: string
  apply?: string
  detail?: string
  type?: string
}

export interface BacklinkAutocompleteOptions {
  /**
   * Function to get completion candidates based on a filter string
   * @param filter The current search term to filter aliases
   * @returns Promise resolving to array of matching candidates
   */
  getAliases: (filter: string) => Promise<Array<string | BacklinkCompletionCandidate>>
}

/**
 * Create autocomplete extension for backlinks
 */
export function createBacklinkAutocomplete(options: BacklinkAutocompleteOptions): Extension {
  return [
    autocompletion({
      override: [backlinkCompletionSource(options)],
      defaultKeymap: false,
    }),
    keymap.of(completionKeymapWithEscapeFallthrough)
  ]
}

/**
 * Completion source for [[alias]] syntax
 */
export function backlinkCompletionSource(options: BacklinkAutocompleteOptions) {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const { state, pos } = context
    const line = state.doc.lineAt(pos)
    const lineText = line.text
    const linePos = pos - line.from

    // Check if we're inside [[ ]] brackets
    const beforeCursor = lineText.slice(0, linePos)
    const afterCursor = lineText.slice(linePos)
    
    // Find the last [[ before cursor
    const openBracketMatch = beforeCursor.match(/\[\[([^\]]*?)$/)
    if (!openBracketMatch) {
      return null
    }

    // Check if there's a closing ]] after cursor (or we're at the end building one)
    const closeBracketIndex = afterCursor.indexOf(']]')
    const hasClosingBrackets = closeBracketIndex !== -1
    
    // Extract the current search term (text between [[ and cursor)
    const searchTerm = openBracketMatch[1]
    const startPos = line.from + openBracketMatch.index! + 2 // Position after [[

    // Get filtered candidates
    const candidates = await options.getAliases(searchTerm)

    if (candidates.length === 0) {
      return null
    }

    return {
      from: startPos,
      to: pos,
      // Source-side filtering is final — `getAliases` already runs a
      // workspace-scoped LIKE filter, and we surface entries the user
      // didn't *type* (e.g. typing "fri" suggests "April 30th, 2026"
      // via the relative-date parser). CodeMirror's default fuzzy
      // filter would hide those, since the label doesn't contain the
      // typed substring.
      filter: false,
      options: candidates.map(candidate => {
        const label = typeof candidate === 'string' ? candidate : candidate.label
        const applyText = typeof candidate === 'string' ? candidate : candidate.apply ?? candidate.label
        const detail = typeof candidate === 'string' ? undefined : candidate.detail
        const type = typeof candidate === 'string' ? 'class' : candidate.type ?? 'class'
        return {
          label,
          detail,
          apply: (view, _, from, to) => {
            view.dispatch({
              changes: { from, to, insert: hasClosingBrackets ? applyText : `${applyText}]]` },
              // Place cursor two characters past the insertion start (after ']]')
              selection: EditorSelection.cursor(from + applyText.length + 2)
            });
          },
          type,
        }
      })
    }
  }
}

/**
 * Check if cursor is currently inside [[ ]] brackets
 */
export function isInsideBacklinkBrackets(text: string, position: number): boolean {
  const beforeCursor = text.slice(0, position)
  const afterCursor = text.slice(position)
  
  const openBrackets = beforeCursor.lastIndexOf('[[')
  const closeBrackets = beforeCursor.lastIndexOf(']]')
  
  // We're inside if the last [[ comes after the last ]]
  // and there's no ]] in the text after cursor before the next [[
  if (openBrackets > closeBrackets) {
    const nextCloseBrackets = afterCursor.indexOf(']]')
    const nextOpenBrackets = afterCursor.indexOf('[[')
    
    // We're inside if there's a ]] coming up and it comes before any new [[
    return nextCloseBrackets !== -1 && (nextOpenBrackets === -1 || nextCloseBrackets < nextOpenBrackets)
  }
  
  return false
}
