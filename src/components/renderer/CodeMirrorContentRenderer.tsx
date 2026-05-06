import { BlockRendererProps } from '@/types.ts'
import { useMemo, ClipboardEvent } from 'react'
import { EditorView } from '@codemirror/view'
import { createMinimalMarkdownConfig } from '@/utils/codemirror.ts'
import { BlockEditor } from '@/components/BlockEditor.tsx'
import { useUIStateProperty } from '@/data/globalState.ts'
import { focusedBlockIdProp } from '@/data/properties.ts'
import { pasteMultilineText } from '@/utils/paste.ts'
import { useRepo } from '@/context/repo.tsx'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { codeMirrorExtensionsFacet } from '@/extensions/editor.ts'
import { convertEmptyChildBlockToProperty } from '@/utils/propertyCreation.ts'

export function CodeMirrorContentRenderer({block}: BlockRendererProps) {
  const repo = useRepo()
  const runtime = useAppRuntime()

  const extensions = useMemo(() => {
    const fieldCreationExtension = EditorView.domEventHandlers({
      keydown: (event, view) => {
        if (
          repo.isReadOnly ||
          event.key !== '>' ||
          event.defaultPrevented ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey
        ) {
          return false
        }

        const selection = view.state.selection.main
        if (!selection.empty || selection.from !== 0 || view.state.doc.length !== 0) {
          return false
        }
        if (!block.peek()?.parentId) return false

        event.preventDefault()
        event.stopPropagation()

        void convertEmptyChildBlockToProperty(block, repo).catch(error => {
          console.error('[CodeMirrorContentRenderer] Failed to create property field', error)
        })

        return true
      },
    })
    const pluginExtensions = runtime.read(codeMirrorExtensionsFacet)({repo, block})
    return createMinimalMarkdownConfig([...pluginExtensions, fieldCreationExtension])
  }, [block, repo, runtime])

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
