import type { CompletionSource } from '@codemirror/autocomplete'
import { EditorView } from '@codemirror/view'
import { EditorSelection, EditorState, Prec } from '@codemirror/state'
import type {
  CodeMirrorExtensionContext,
  CodeMirrorExtensionContribution,
} from '@/extensions/editor.js'
import { formatRoamDate } from '@/utils/dailyPage.js'
import { relativeDateCandidates } from '@/utils/relativeDate.js'
import { backlinkCompletionSource } from '@/utils/backlinkAutocomplete.js'
import { blockrefCompletionSource } from '@/utils/blockrefAutocomplete.js'
import { searchAliasLabels } from '@/utils/linkTargetAutocomplete.js'

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

/**
 * Workaround for Chrome's contenteditable mis-positioning printable text
 * inserted at the end of a `[[wikilink]]`. Repro: with the doc `[[i]]` and
 * the cursor at position 5 (past the second `]`), typing a space yields
 * `[[i] ]` with the cursor between the two `]`. The visual caret was
 * correct (past both `]`), but the DOM caret was actually inside the last
 * bracket's text node, and Chrome inserted the space there. CodeMirror's
 * MutationObserver reads back `[[i] ]`, runs `findDiff` against `[[i]]`,
 * and (since both diff anchors are valid) lands the insertion at position
 * 4 instead of 5. The same path explains the `[[i| ]]` → `[[i] |]` case
 * in the bug report. No code in the app is wrong here — it's an upstream
 * DOM/diff interaction.
 *
 * Fix: a high-precedence `inputHandler` that, for plain single-cursor
 * insertions whose diff anchor landed *strictly before* the cursor,
 * redirects the change to the cursor position. Normal typing always
 * inserts at the caret; cases where a diff legitimately lands earlier
 * (selection replace, composition/IME) are excluded.
 */
const insertAtCaretForMisplacedDiff = Prec.highest(
  EditorView.inputHandler.of((view, from, to, insert) => {
    if (insert.length === 0) return false
    if (from !== to) return false
    if (view.composing) return false

    const sel = view.state.selection.main
    if (!sel.empty) return false
    if (from >= sel.from) return false

    view.dispatch({
      changes: {from: sel.from, insert},
      selection: EditorSelection.cursor(sel.from + insert.length),
      userEvent: 'input.type',
      scrollIntoView: true,
    })
    return true
  }),
)

const buildWikilinkSource = ({repo}: CodeMirrorExtensionContext): CompletionSource =>
  backlinkCompletionSource({
    getAliases: async (filter: string) => {
      const workspaceId = repo.activeWorkspaceId
      if (!workspaceId) {
        console.warn('No active workspace for alias search')
        return []
      }

      const aliases = await searchAliasLabels(repo, {workspaceId, query: filter})
      const dateCompletions = relativeDateCandidates(filter).map(candidate => {
        const label = formatRoamDate(candidate.date)
        return {
          label,
          apply: label,
          detail: candidate.phrase,
          iso: candidate.iso,
          type: 'constant',
        }
      })
      if (dateCompletions.length === 0) return aliases

      const dateLabels = new Set(dateCompletions.flatMap(candidate => [
        candidate.label,
        candidate.iso,
      ]))
      return [
        ...dateCompletions,
        ...aliases.filter(alias => !dateLabels.has(alias)),
      ]
    },
  })

const buildBlockrefSource = ({repo}: CodeMirrorExtensionContext): CompletionSource =>
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
  })

/** References plugin CM contribution: theme + chrome diff workaround +
 *  wikilink / blockref completion sources. Sources are built once per
 *  editor mount (outside the languageData callback) so each instance
 *  has stable identity across keystrokes. CM's single central
 *  `autocompletion()` call walks `EditorState.languageData` and picks
 *  up everything contributed via the `autocomplete` field. */
export const referencesCodeMirrorExtensions: CodeMirrorExtensionContribution = (ctx) => {
  const wikilinkSource = buildWikilinkSource(ctx)
  const blockrefSource = buildBlockrefSource(ctx)
  return [
    insertAtCaretForMisplacedDiff,
    referenceAutocompleteTheme,
    EditorState.languageData.of(() => [
      {autocomplete: wikilinkSource},
      {autocomplete: blockrefSource},
    ]),
  ]
}
