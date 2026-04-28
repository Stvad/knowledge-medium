import { BlockRendererProps } from '@/types.ts'
import { useMemo, ClipboardEvent } from 'react'
import { createMinimalMarkdownConfig } from '@/utils/codemirror.ts'
import { BlockEditor } from '@/components/BlockEditor.tsx'
import { useUIStateProperty } from '@/data/globalState.ts'
import { focusedBlockIdProp } from '@/data/properties.ts'
import { pasteMultilineText } from '@/utils/paste.ts'
import { useRepo } from '@/context/repo.tsx'

export function CodeMirrorContentRenderer({block}: BlockRendererProps) {
  const repo = useRepo()

  const getAliasesForAutocomplete = useMemo(() => {
    return async (filter: string): Promise<string[]> => {
      const workspaceId = repo.activeWorkspaceId
      if (!workspaceId) {
        console.warn('No active workspace for alias search')
        return []
      }
      return repo.getAliasesInWorkspace(workspaceId, filter)
    }
  }, [repo])

  const extensions = useMemo(() => createMinimalMarkdownConfig({
    getAliases: getAliasesForAutocomplete
  }), [getAliasesForAutocomplete])

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
