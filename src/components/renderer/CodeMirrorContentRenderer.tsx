import { BlockRendererProps } from '@/types.js'
import { useMemo, ClipboardEvent } from 'react'
import { EditorView } from '@codemirror/view'
import { createMinimalMarkdownConfig } from '@/utils/codemirror.js'
import { BlockEditor } from '@/components/BlockEditor.js'
import { useUIStateBlock } from '@/data/globalState.js'
import { focusBlock } from '@/data/properties.js'
import { pasteMultilineText } from '@/utils/paste.js'
import { useRepo } from '@/context/repo.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { codeMirrorExtensionsFacet } from '@/extensions/editor.js'
import { convertEmptyChildBlockToProperty } from '@/utils/propertyCreation.js'
import { useBlockContext } from '@/context/block.js'

export function CodeMirrorContentRenderer({block}: BlockRendererProps) {
  const repo = useRepo()
  const runtime = useAppRuntime()
  const uiStateBlock = useUIStateBlock()
  const blockContext = useBlockContext()

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

  const handlePaste = async (e: ClipboardEvent<HTMLDivElement>) => {
    e.stopPropagation()
    const text = e.clipboardData?.getData('text/plain')
    if (text?.includes('\n')) {
      e.preventDefault()
      const pasted = await pasteMultilineText(text, block, repo)
      const renderScopeId = typeof blockContext.renderScopeId === 'string'
        ? blockContext.renderScopeId
        : undefined
      if (pasted[0]) void focusBlock(uiStateBlock, pasted[0].id, {renderScopeId})
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
