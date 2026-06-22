import { BlockRendererProps } from '@/types.js'
import { useMemo, ClipboardEvent, KeyboardEvent, useRef } from 'react'
import { EditorSelection } from '@codemirror/state'
import type { ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { createMinimalMarkdownConfig } from '@/utils/codemirror.js'
import { BlockEditor } from '@/components/BlockEditor.js'
import { useUIStateBlock } from '@/data/globalState.js'
import { editorSelection, focusBlock } from '@/data/properties.js'
import {
  pasteChordIntent,
  pasteEditModeMultilineText,
  planEditModeMultilinePaste,
  planSingleBlockPaste,
} from '@/utils/paste.js'
import { pasteDecisionVerb } from '@/extensions/paste.js'
import { useRepo } from '@/context/repo.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { codeMirrorExtensionsFacet } from '@/extensions/editor.js'
import { createFieldCreationKeydownExtension } from './fieldCreationKeydown.js'
import { useBlockContext } from '@/context/block.js'

export function CodeMirrorContentRenderer({block}: BlockRendererProps) {
  const repo = useRepo()
  const runtime = useAppRuntime()
  const uiStateBlock = useUIStateBlock()
  const blockContext = useBlockContext()
  const editorRef = useRef<ReactCodeMirrorRef>(null)
  // The paste ClipboardEvent carries no modifier state, so we latch the
  // most recent paste chord's intent on keydown and read it back in
  // handlePaste. Cmd/Ctrl+Shift+V ('single-block') drops text into the
  // current block verbatim; plain Cmd/Ctrl+V ('split') keeps the
  // existing outline-splitting behavior.
  const pasteIntentRef = useRef<'split' | 'single-block'>('split')

  const extensions = useMemo(() => {
    const fieldCreationExtension = createFieldCreationKeydownExtension(block, repo)
    const pluginExtensions = runtime.read(codeMirrorExtensionsFacet)({repo, block})
    return createMinimalMarkdownConfig([...pluginExtensions, fieldCreationExtension])
  }, [block, repo, runtime])

  // Latch the paste chord's Shift state before the paste event fires
  // (paste events can't see modifiers). Capture phase so we run before
  // CodeMirror's own keydown handling.
  const handleKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>) => {
    const intent = pasteChordIntent(e)
    if (intent) pasteIntentRef.current = intent
  }

  const handlePaste = async (e: ClipboardEvent<HTMLDivElement>) => {
    e.stopPropagation()
    const text = e.clipboardData?.getData('text/plain')
    if (!text) return
    // Read-only editors leave paste to the browser (a no-op on a
    // non-editable surface) — matches the historical single-block guard.
    if (repo.isReadOnly) return

    // Latch + reset the chord intent (the paste event can't see modifiers)
    // and capture the editor state synchronously. `preventDefault` MUST run
    // before the async decision resolves, or the browser's native paste
    // fires first; so we always take over the paste here and reproduce the
    // native single-line insert ourselves for the `native` decision below.
    const intent = pasteIntentRef.current
    pasteIntentRef.current = 'split'
    const html = e.clipboardData?.getData('text/html') || undefined
    e.preventDefault()
    const editorView = editorRef.current?.view
    if (!editorView) return
    const selection = editorView.state.selection.main
    const docText = editorView.state.doc.toString()

    // The paste verb decides how the clipboard lands; with no plugin
    // contributions this returns `defaultPasteDecision`, i.e. the previous
    // hardcoded behavior. `decision.text` lets an override rewrite the
    // content (e.g. CSV → markdown) before it's applied.
    const decision = await pasteDecisionVerb.run(runtime, {text, html, intent})

    if (decision.kind !== 'split') {
      // `single-block` and `native` both drop text into the current block
      // verbatim; only `single-block` may carry a rewritten payload.
      const insert = decision.kind === 'single-block' ? decision.text ?? text : text
      const plan = planSingleBlockPaste(insert, {from: selection.from, to: selection.to})
      editorView.dispatch({
        changes: {from: plan.from, to: plan.to, insert: plan.insert},
        selection: EditorSelection.cursor(plan.cursor),
      })
      return
    }

    const splitText = decision.text ?? text
    const plan = planEditModeMultilinePaste(splitText, docText, {
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
      onKeyDownCapture={handleKeyDownCapture}
      onPasteCapture={handlePaste}
    />
  )
}
