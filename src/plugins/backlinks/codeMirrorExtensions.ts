import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { keymap } from '@codemirror/view'
import type { CodeMirrorExtensionContribution } from '@/extensions/editor.ts'
import { formatRoamDate } from '@/utils/dailyPage.ts'
import { parseRelativeDate } from '@/utils/relativeDate.ts'
import { backlinkCompletionSource } from '@/utils/backlinkAutocomplete.ts'
import { blockrefCompletionSource } from '@/utils/blockrefAutocomplete.ts'
import { searchAliasLabels } from '@/utils/linkTargetAutocomplete.ts'

export const backlinksCodeMirrorExtensions: CodeMirrorExtensionContribution = ({repo}) => [
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

          const blocks = await repo.query.searchByContent({
            workspaceId,
            query: filter,
            limit: 12,
          }).load()
          return blocks.map(block => ({id: block.id, content: block.content}))
        },
      }),
    ],
    defaultKeymap: false,
  }),
  keymap.of(completionKeymap.map(item => ({...item, stopPropagation: true}))),
]
