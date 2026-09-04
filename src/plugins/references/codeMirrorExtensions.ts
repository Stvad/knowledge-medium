import type { CompletionSource } from '@codemirror/autocomplete'
import { EditorView } from '@codemirror/view'
import { EditorSelection, EditorState, Prec } from '@codemirror/state'
import type {
  CodeMirrorExtensionContext,
  CodeMirrorExtensionContribution,
} from '@/editor/codeMirrorExtensions.js'
import { formatRoamDate } from '@/utils/dailyPage.js'
import { relativeDateCandidates } from '@/utils/relativeDate.js'
import { backlinkCompletionSource } from '@/utils/backlinkAutocomplete.js'
import { blockrefCompletionSource } from '@/utils/blockrefAutocomplete.js'
import {
  completionTypeHint,
  searchAliasLabels,
  searchBlocksAcrossSources,
} from '@/utils/linkTargetAutocomplete.js'
import { loadRecentBlockIds } from '@/plugins/quick-find/recents.js'
import { canRenderAsWikilink } from './referenceParser.ts'
import type { TypeContribution } from '@/data/api'

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

/** Alias search rows → `[[` completions, dropping any target the wikilink
 *  grammar can't carry.
 *
 *  Offering such a target hands the user dead markup: accepting the
 *  completion writes a span the parser reads no reference from, so it
 *  renders as literal text and gains no backlink, with nothing on screen
 *  saying why. Reachable today — a workspace can already hold over-cap
 *  aliases (phantom pages are exactly that, and several begin
 *  `import {`, so typing `[[import ` surfaces them). Filtering is also the
 *  right end state: those names cannot be linked to at all, so listing
 *  them offers a broken choice.
 *
 *  Split out and exported so the filter is testable — inside the
 *  `getAliases` closure it is reachable only through a live CodeMirror
 *  completion context. */
export const aliasCompletions = (
  matches: readonly {label: string; typeIds: readonly string[]}[],
  typeRegistry: ReadonlyMap<string, TypeContribution>,
): Array<{label: string; detail: string | undefined}> =>
  matches
    .filter(match => canRenderAsWikilink(match.label))
    .map(match => ({
      label: match.label,
      detail: completionTypeHint(match.typeIds, typeRegistry),
    }))

const buildWikilinkSource = ({repo}: CodeMirrorExtensionContext): CompletionSource =>
  backlinkCompletionSource({
    getAliases: async (filter: string) => {
      const workspaceId = repo.activeWorkspaceId
      if (!workspaceId) {
        console.warn('No active workspace for alias search')
        return []
      }

      // MRU loads through the memoized ui-state helper, so this is
      // O(1) after the first call. Done once per autocomplete trigger
      // — cheap, and keeps the ranker reactive to navigation pushes
      // that happen between keystrokes.
      const recentBlockIds = await loadRecentBlockIds(repo, workspaceId)
      const matches = await searchAliasLabels(repo, {workspaceId, query: filter, recentBlockIds})
      // `repo.types` is the in-memory registry snapshot — a synchronous
      // map read, so naming each row's type costs nothing beyond the
      // bounded per-id type lookup `searchAliasLabels` already did.
      const typeRegistry = repo.types
      // No `type` — `backlinkCompletionSource` already defaults alias
      // candidates to 'class'.
      const aliases = aliasCompletions(matches, typeRegistry)
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
        ...aliases.filter(alias => !dateLabels.has(alias.label)),
      ]
    },
  })

const buildBlockrefSource = ({repo}: CodeMirrorExtensionContext): CompletionSource =>
  blockrefCompletionSource({
    searchBlocks: async (filter: string) => {
      const workspaceId = repo.activeWorkspaceId
      if (!workspaceId) return []

      const query = filter.trim()
      // Shared merge point (searchSourcesFacet), not a direct
      // `searchByContent` call, so a contributed search source (e.g.
      // semantic search) is reachable from block-ref completion too.
      const blocks = query
        ? await searchBlocksAcrossSources(repo, {
          workspaceId,
          query,
          limit: 12,
        })
        // USER-AUTHORED recents, not `recentBlocks`: the latter is every live
        // non-empty row, which includes each plugin's ui-state — panel rows,
        // per-device group labels, whatever a plugin files under the user's
        // state roots. With twelve results to offer, app bookkeeping crowds out
        // the blocks someone might actually want to reference. Same definition
        // of "authored" the Recents view uses — one shared resolver, so the
        // two cannot drift — but without its ancestor chains, which this
        // picker never shows and would re-query on every open.
        : await repo.query.recentUserBlocks({
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
