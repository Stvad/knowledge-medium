import { autocompletion } from '@codemirror/autocomplete'
import { EditorView, keymap } from '@codemirror/view'
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

export const referencesCodeMirrorExtensions: CodeMirrorExtensionContribution = ({repo}) => [
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
