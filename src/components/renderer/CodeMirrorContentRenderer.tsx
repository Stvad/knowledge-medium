import { BlockRendererProps } from '@/types.ts'
import { useMemo, ClipboardEvent, useState } from 'react'
import { createMinimalMarkdownConfig } from '@/utils/codemirror.ts'
import { BlockEditor } from '@/components/BlockEditor.tsx'
import { useUIStateProperty } from '@/data/globalState.ts'
import { focusedBlockIdProp } from '@/data/properties.ts'
import { pasteMultilineText } from '@/utils/paste.ts'
import { useRepo } from '@/context/repo.tsx'
import { useCodeMirrorEditModeShortcuts } from '@/shortcuts/useActionContext.ts'
import { EditorView } from '@codemirror/view'

export function CodeMirrorContentRenderer({block}: BlockRendererProps) {
  const extensions = useMemo(() => createMinimalMarkdownConfig(), [])

  const [, setFocusedBlockId] = useUIStateProperty(focusedBlockIdProp)
  const repo = useRepo()
  const [editorView, setEditorView] = useState<EditorView| undefined>(undefined)

  const shortcutDependencies = useMemo(() => ({
    block,
    editorView: editorView!,
  }), [
    block,
    editorView,
  ])

  useCodeMirrorEditModeShortcuts(shortcutDependencies, !!editorView)

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
      ref={(val) => {
        // Once, we're relying on EditorView to be stable
        setEditorView(e => e ? e : val?.view)
      }}
      block={block}
      extensions={extensions}
      autoFocus
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
