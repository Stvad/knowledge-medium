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
} from '@/paste/operations.js'
import { pasteDecisionVerb, type PasteRequest } from '@/paste/decision.js'
import { captureMediaVerb } from '@/paste/captureMediaVerb.js'
import { useRepo } from '@/context/repo.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { codeMirrorExtensionsFacet } from '@/editor/codeMirrorExtensions.js'
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
    // Read-only editors leave paste to the browser (a no-op on a
    // non-editable surface) — matches the historical single-block guard.
    if (repo.isReadOnly) return
    // File(s) on the clipboard (a pasted image) carry no text/plain, so read
    // them BEFORE the no-text early return below — otherwise an image paste
    // would fall through to the browser.
    const files = e.clipboardData?.files
    const fileList = files && files.length > 0 ? Array.from(files) : []
    const text = e.clipboardData?.getData('text/plain') ?? ''
    if (!text && fileList.length === 0) return

    // Latch + reset the chord intent — the paste event can't see modifiers,
    // so the keydown handler latched it. `preventDefault` MUST run
    // synchronously or the browser's native paste fires first; the editor
    // always takes over the paste.
    const intent = pasteIntentRef.current
    pasteIntentRef.current = 'split'
    const html = e.clipboardData?.getData('text/html') || undefined
    e.preventDefault()

    // Read the live editor state once: the decision is SYNCHRONOUS (`runSync`),
    // so it resolves before any `await` below and the caret it keys on can't
    // move between this read and the dispatch. (When the decision was async this
    // had to be split into a pre-decision caret snapshot + a post-decision
    // re-read, because an override could await and move the caret mid-flight.)
    const editorView = editorRef.current?.view
    if (!editorView) return
    const selection = editorView.state.selection.main
    const caret = {
      line: editorView.state.doc.lineAt(selection.from).number,
      lineCount: editorView.state.doc.lines,
      from: selection.from,
      to: selection.to,
    }

    // The paste verb decides how the clipboard lands; with no plugin
    // contributions this returns `defaultPasteDecision`, i.e. the previous
    // hardcoded behavior. It's a pure, synchronous policy — an override may key
    // on the paste-time position (title line 1 vs body line 2+) but must decide
    // synchronously. `decision.text` lets it rewrite the content (e.g. CSV →
    // markdown) before it's applied.
    const request: PasteRequest = {text, html, files: fileList, intent, surface: 'editor', caret}
    const decided = pasteDecisionVerb.runSync(runtime, request)

    // For a media paste, capture the file(s) FIRST (async) — the embed(s) are TEXT we
    // splice into the paste below, so the attachment lands at the caret per the text
    // policy, exactly like the clipboard text (NOT a forced child block). The capture
    // verb is the attachments plugin's effect; this renderer never imports it. The
    // slow upload stays fire-and-forget inside the impl, so we only await the (fast)
    // asset-block write.
    let pasteText = text
    if (decided.kind === 'media') {
      const workspaceId = block.peek()?.workspaceId ?? repo.activeWorkspaceId ?? ''
      let embeds: readonly string[] = []
      if (workspaceId && fileList.length > 0) {
        try {
          embeds = (await captureMediaVerb.run(runtime, {repo, workspaceId, files: fileList})).embeds
        } catch (err) {
          // A buggy capture plugin must not break the paste — the text half still pastes.
          console.warn('[media] paste capture failed', err)
        }
      } else if (fileList.length > 0) {
        console.warn('[media] could not capture pasted file(s): no workspace for block', block.id)
      }
      // Clipboard text first, then one embed per captured file — each on its own line.
      pasteText = [text, ...embeds].filter(Boolean).join('\n')
      if (!pasteText) return // nothing captured and no text
      // The capture awaited; the view may have unmounted in that window.
      if (!editorRef.current?.view) return
    }

    // The paste text (clipboard ± embeds) flows through the verb so plugin text
    // handling still applies; for a media paste re-decide with files stripped + the
    // spliced text, so the file half doesn't re-trigger media.
    const decision =
      decided.kind === 'media'
        ? pasteDecisionVerb.runSync(runtime, {...request, text: pasteText, files: []})
        : decided
    if (decision.kind === 'media') return // a plugin returned media without files — nothing to paste

    // Re-read the caret: a media capture awaited above, so use the live selection.
    const insertAt = editorView.state.selection.main

    if (decision.kind === 'single-block') {
      const plan = planSingleBlockPaste(decision.text ?? pasteText, {
        from: insertAt.from,
        to: insertAt.to,
      })
      editorView.dispatch({
        changes: {from: plan.from, to: plan.to, insert: plan.insert},
        selection: EditorSelection.cursor(plan.cursor),
      })
      return
    }

    const plan = planEditModeMultilinePaste(decision.text ?? pasteText, editorView.state.doc.toString(), {
      from: insertAt.from,
      to: insertAt.to,
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
