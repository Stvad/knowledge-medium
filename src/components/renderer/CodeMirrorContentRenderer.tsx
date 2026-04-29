import { BlockRendererProps } from '@/types.ts'
import { useMemo, ClipboardEvent } from 'react'
import { createMinimalMarkdownConfig } from '@/utils/codemirror.ts'
import { BlockEditor } from '@/components/BlockEditor.tsx'
import { useUIStateProperty } from '@/data/globalState.ts'
import { focusedBlockIdProp } from '@/data/properties.ts'
import { pasteMultilineText } from '@/utils/paste.ts'
import { useRepo } from '@/context/repo.tsx'
import { parseRelativeDate } from '@/utils/relativeDate.ts'
import { formatRoamDate } from '@/utils/dailyPage.ts'

export function CodeMirrorContentRenderer({block}: BlockRendererProps) {
  const repo = useRepo()

  const getAliasesForAutocomplete = useMemo(() => {
    return async (filter: string): Promise<string[]> => {
      const workspaceId = repo.activeWorkspaceId
      if (!workspaceId) {
        console.warn('No active workspace for alias search')
        return []
      }
      const aliases = await repo.getAliasesInWorkspace(workspaceId, filter)

      // If the user is typing a date phrase ("fri", "next mon", "april 28"),
      // surface the resolved long-form date as the top suggestion. Picking
      // it inserts e.g. "April 30th, 2026" inside [[…]], which then routes
      // through getOrCreateDailyNote on parseAndUpdateReferences. Without
      // this, autocomplete only matches existing aliases — daily notes that
      // don't yet exist for the day the user is reaching for stay invisible.
      const dateMatch = parseRelativeDate(filter)
      if (!dateMatch) return aliases

      const dateAlias = formatRoamDate(dateMatch.date)
      return [dateAlias, ...aliases.filter(a => a !== dateAlias)]
    }
  }, [repo])

  const searchBlocksForAutocomplete = useMemo(() => {
    return async (filter: string) => {
      const workspaceId = repo.activeWorkspaceId
      if (!workspaceId) return []
      // Cap at 12 — autocompletion popovers stop being useful after that and
      // a wider scan just hurts perceived latency on every keystroke.
      const blocks = await repo.searchBlocksByContent(workspaceId, filter, 12)
      const hits = await Promise.all(blocks.map(async b => {
        const data = await b.data()
        return data ? {id: data.id, content: data.content} : null
      }))
      return hits.filter((h): h is {id: string, content: string} => h !== null)
    }
  }, [repo])

  const extensions = useMemo(() => createMinimalMarkdownConfig({
    getAliases: getAliasesForAutocomplete,
    searchBlocks: searchBlocksForAutocomplete,
  }), [getAliasesForAutocomplete, searchBlocksForAutocomplete])

  const [, setFocusedBlockId] = useUIStateProperty(focusedBlockIdProp)

  const handlePaste = async (e: ClipboardEvent<HTMLDivElement>) => {
    e.stopPropagation()
    const text = e.clipboardData?.getData('text/plain')
    if (text?.includes('\n')) {
      e.preventDefault()
      const pasted = await pasteMultilineText(text, block, repo)
      if (pasted[0]) setFocusedBlockId(pasted[0].id)
    }
  }

  return (
    <BlockEditor
      block={block}
      extensions={extensions}
      className="min-h-[1.7em]"
      basicSetup={{
        closeBrackets: true,
        lineNumbers: false,
        foldGutter: false,
        dropCursor: false,
        allowMultipleSelections: false,
        indentOnInput: false,
        highlightSelectionMatches: false,
        searchKeymap: false,
        defaultKeymap: false,
        history: false,
        historyKeymap: false,
        highlightActiveLine: false,
        completionKeymap: false,
      }}
      indentWithTab={false}
      onPasteCapture={handlePaste}
    />
  )
}
