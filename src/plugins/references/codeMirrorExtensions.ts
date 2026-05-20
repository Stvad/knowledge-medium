import { autocompletion } from '@codemirror/autocomplete'
import { EditorView, keymap } from '@codemirror/view'
import { EditorSelection, Prec, type EditorState, type TransactionSpec } from '@codemirror/state'
import type { CodeMirrorExtensionContribution } from '@/extensions/editor.ts'
import { formatRoamDate } from '@/utils/dailyPage.ts'
import { parseRelativeDate } from '@/utils/relativeDate.ts'
import { backlinkCompletionSource } from '@/utils/backlinkAutocomplete.ts'
import { blockrefCompletionSource } from '@/utils/blockrefAutocomplete.ts'
import { completionKeymapWithEscapeFallthrough } from '@/utils/codemirrorCompletion.ts'
import { searchAliasLabels } from '@/utils/linkTargetAutocomplete.ts'

const referenceAutocompleteTheme = EditorView.theme({
  '.cm-tooltip.cm-tooltip-autocomplete.tm-reference-autocomplete': {
    zIndex: '1000',
    overflow: 'hidden',
    border: '1px solid hsl(var(--border))',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'hsl(var(--popover))',
    color: 'hsl(var(--popover-foreground))',
    padding: '0.25rem',
    fontFamily: 'inherit',
    fontSize: '0.875rem',
    lineHeight: '1.25rem',
    boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete.tm-reference-autocomplete > ul': {
    maxHeight: '14rem',
    minWidth: '16rem',
    maxWidth: '28rem',
    padding: 0,
    fontFamily: 'inherit',
  },
  '.cm-tooltip.cm-tooltip-autocomplete.tm-reference-autocomplete > ul > li': {
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
    gap: '0.5rem',
    borderRadius: 'var(--radius-sm)',
    padding: '0.375rem 0.5rem',
    color: 'hsl(var(--popover-foreground))',
    lineHeight: '1.25rem',
  },
  '.cm-tooltip.cm-tooltip-autocomplete.tm-reference-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'hsl(var(--muted))',
    color: 'hsl(var(--foreground))',
  },
  '.cm-tooltip.cm-tooltip-autocomplete.tm-reference-autocomplete .cm-completionLabel': {
    minWidth: 0,
    flex: '1 1 auto',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  '.cm-tooltip.cm-tooltip-autocomplete.tm-reference-autocomplete .cm-completionDetail': {
    marginLeft: 'auto',
    maxWidth: '40%',
    overflow: 'hidden',
    color: 'hsl(var(--muted-foreground))',
    fontSize: '0.75rem',
    lineHeight: '1rem',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  '.cm-tooltip.cm-tooltip-autocomplete.tm-reference-autocomplete .cm-completionMatchedText': {
    fontWeight: 600,
    textDecoration: 'none',
  },
})

const hasUnclosedWikilinkBefore = (text: string): boolean => {
  const stack: number[] = []
  for (let i = 0; i < text.length - 1;) {
    const pair = text.slice(i, i + 2)
    if (pair === '[[') {
      stack.push(i)
      i += 2
    } else if (pair === ']]') {
      if (stack.length > 0) stack.pop()
      i += 2
    } else {
      i++
    }
  }
  return stack.length > 0
}

const isBetweenWikilinkClosingDelimiter = (state: EditorState, pos: number): boolean =>
  pos > 0 &&
  state.sliceDoc(pos - 1, pos + 1) === ']]' &&
  hasUnclosedWikilinkBefore(state.sliceDoc(0, pos - 1))

export const wikilinkBoundaryInputTransaction = (
  state: EditorState,
  from: number,
  to: number,
  insert: string,
): TransactionSpec | null => {
  const selection = state.selection.main
  if (!selection.empty || from !== selection.from || to !== selection.to || insert.length === 0) {
    return null
  }

  if (insert !== ']' && isBetweenWikilinkClosingDelimiter(state, from)) {
    const insertAt = from + 1
    return {
      changes: {from: insertAt, insert},
      selection: EditorSelection.cursor(insertAt + insert.length),
      scrollIntoView: true,
      userEvent: 'input.type',
    }
  }

  return null
}

export const wikilinkBoundaryInputHandler = Prec.highest(EditorView.inputHandler.of((view, from, to, insert) => {
  const transaction = wikilinkBoundaryInputTransaction(view.state, from, to, insert)
  if (!transaction) return false
  view.dispatch(transaction)
  return true
}))

export const referencesCodeMirrorExtensions: CodeMirrorExtensionContribution = ({repo}) => [
  wikilinkBoundaryInputHandler,
  referenceAutocompleteTheme,
  autocompletion({
    override: [
      backlinkCompletionSource({
        getAliases: async (filter: string): Promise<string[]> => {
          const workspaceId = repo.activeWorkspaceId
          if (!workspaceId) {
            console.warn('No active workspace for alias search')
            return []
          }

          const aliases = await searchAliasLabels(repo, {workspaceId, query: filter})
          const dateMatch = parseRelativeDate(filter)
          if (!dateMatch) return aliases

          const dateAlias = formatRoamDate(dateMatch.date)
          return [dateAlias, ...aliases.filter(alias => alias !== dateAlias)]
        },
      }),
      blockrefCompletionSource({
        searchBlocks: async (filter: string) => {
          const workspaceId = repo.activeWorkspaceId
          if (!workspaceId) return []

          const query = filter.trim()
          const blocks = query
            ? await repo.query.searchByContent({
              workspaceId,
              query,
              limit: 12,
            }).load()
            : await repo.query.recentBlocks({
              workspaceId,
              limit: 12,
            }).load()
          return blocks.map(block => ({id: block.id, content: block.content}))
        },
      }),
    ],
    defaultKeymap: false,
    icons: false,
    tooltipClass: () => 'tm-reference-autocomplete',
  }),
  keymap.of(completionKeymapWithEscapeFallthrough),
]
