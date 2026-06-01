import { BlockRendererProps } from '@/types.js'
import { useMemo, ClipboardEvent, useRef } from 'react'
import { EditorView } from '@codemirror/view'
import { EditorSelection } from '@codemirror/state'
import type { ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { createMinimalMarkdownConfig } from '@/utils/codemirror.js'
import { BlockEditor } from '@/components/BlockEditor.js'
import { useUIStateBlock } from '@/data/globalState.js'
import { editorSelection, focusBlock } from '@/data/properties.js'
import {
  pasteEditModeMultilineText,
  planEditModeMultilinePaste,
} from '@/utils/paste.js'
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
  const editorRef = useRef<ReactCodeMirrorRef>(null)

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
      const editorView = editorRef.current?.view
      if (!editorView) return

      const selection = editorView.state.selection.main
      const plan = planEditModeMultilinePaste(text, editorView.state.doc.toString(), {
        from: selection.from,
        to: selection.to,
      })
      if (!plan) return

      editorView.dispatch({
        changes: {from: 0, to: editorView.state.doc.length, insert: plan.targetContent},
        selection: EditorSelection.cursor(plan.focusOffsetInTarget),
      })

      const result = await pasteEditModeMultilineText(plan, block, repo, {
        scopeRootId: blockContext.scopeRootId,
      })
      const renderScopeId = typeof blockContext.renderScopeId === 'string'
        ? blockContext.renderScopeId
        : undefined
      if (!result) return

      await uiStateBlock.set(editorSelection, {
        blockId: result.focusBlock.id,
        start: result.focusOffset,
      })
      void focusBlock(uiStateBlock, result.focusBlock.id, {edit: true, renderScopeId})
    }
  }

  return (
    <BlockEditor
      ref={editorRef}
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
