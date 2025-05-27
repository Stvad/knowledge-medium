/**
 * CodeMirror extension for [[alias]] autocomplete
 * Triggers on [[ input and shows available aliases
 */

import { Extension } from '@codemirror/state'
import { autocompletion, CompletionContext, CompletionResult, completionKeymap } from '@codemirror/autocomplete'
import { keymap } from '@codemirror/view'

export interface BacklinkAutocompleteOptions {
  /**
   * Function to get aliases based on a filter string
   * @param filter The current search term to filter aliases
   * @returns Promise resolving to array of matching aliases
   */
  getAliases: (filter: string) => Promise<string[]>
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
    keymap.of(completionKeymap.map(it => ({...it, stopPropagation: true})))
  ]
}

/**
 * Completion source for [[alias]] syntax
 */
function backlinkCompletionSource(options: BacklinkAutocompleteOptions) {
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

    // Get filtered aliases
    const aliases = await options.getAliases(searchTerm)

    if (aliases.length === 0) {
      return null
    }

    return {
      from: startPos,
      to: pos,
      options: aliases.map(alias => ({
        label: alias,
        // Only add closing brackets if they don't already exist
        apply: hasClosingBrackets ? alias : `${alias}]]`,
        type: 'text',
        info: `Link to: ${alias}`
      }))
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
