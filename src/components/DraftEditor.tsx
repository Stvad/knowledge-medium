import CodeMirror, { ExternalChange, type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { useCallback, useLayoutEffect, useMemo, useRef, type ClipboardEvent, type KeyboardEvent, type Ref } from 'react'
import { closeCompletion } from '@codemirror/autocomplete'
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, Transaction } from '@codemirror/state'
import { history, historyKeymap, insertNewline } from '@codemirror/commands'
import { useRepo } from '@/context/repo.js'
import type { Repo } from '@/data/repo.js'
import type { FacetRuntime } from '@/facets/facet.js'
import { readClipboardContent, type ClipboardContent } from '@/paste/clipboard.js'
import {
  pasteChordIntent,
  planSingleBlockPaste,
  resolvePasteWithMediaCapture,
  type PasteChordIntent,
} from '@/paste/operations.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { codeMirrorExtensionsFacet } from '@/editor/codeMirrorExtensions.js'
import { BLOCK_EDITOR_BASIC_SETUP, createMinimalMarkdownConfig } from '@/utils/codemirror.js'
import { keyboardAwareScroll } from '@/utils/keyboardAwareScroll.js'

interface DraftEditorProps {
  value: string
  onChange: (value: string) => void
  /** Cmd+Enter or Ctrl+Enter. */
  onSubmit: () => void
  /** Escape, once no completion is open. */
  onCancel: () => void
  label: string
  placeholder?: string
  readOnly?: boolean
  className?: string
  ref?: Ref<ReactCodeMirrorRef>
}

/** A paste through the block editor's pipeline: the paste verb's plugin
 *  rewrites, and media capture, which writes the pasted files as attachment
 *  blocks at once, so a draft that is then cancelled leaves them behind
 *  (accepted). A draft is one block's text, so a decision to split into
 *  blocks lands as its text at the caret. */
const pasteIntoDraft = async (
  view: EditorView,
  content: ClipboardContent,
  intent: PasteChordIntent,
  {runtime, repo}: {runtime: FacetRuntime; repo: Repo},
): Promise<void> => {
  const {from, to} = view.state.selection.main
  const {doc} = view.state
  const resolved = await resolvePasteWithMediaCapture(runtime, {
    ...content,
    intent,
    surface: 'editor',
    caret: {line: doc.lineAt(from).number, lineCount: doc.lines, from, to},
  }, {repo, workspaceId: repo.activeWorkspaceId ?? ''})
  // The capture awaits; the composer may have closed meanwhile.
  if (!resolved || !view.dom.isConnected) return
  const plan = planSingleBlockPaste(resolved.text, view.state.selection.main)
  view.dispatch({
    changes: {from: plan.from, to: plan.to, insert: plan.insert},
    selection: {anchor: plan.cursor},
    userEvent: 'input.paste',
  })
}

/**
 * The block editor's CodeMirror on text that is not a block yet, such as a
 * comment composer's draft: the same markdown config and the same plugin
 * extensions, read with no block, so `[[`/`((` completion, formatting keys and
 * soft line breaks work as they do in a block. Contributions that need the
 * block itself opt out (`CodeMirrorExtensionContext.block`).
 *
 * Keys stop at the wrapper, so the outline's shortcuts (normal mode, the
 * edit-mode block actions) never see what is typed here.
 */
export const DraftEditor = ({
  value, onChange, onSubmit, onCancel, label, placeholder, readOnly, className, ref,
}: DraftEditorProps) => {
  const repo = useRepo()
  const runtime = useAppRuntime()
  // The extensions are built once per editor; they read the latest callbacks.
  const handlers = useRef({onChange, onSubmit, onCancel})
  useLayoutEffect(() => { handlers.current = {onChange, onSubmit, onCancel} })
  const stableOnChange = useCallback((next: string) => handlers.current.onChange(next), [])
  // A paste event carries no modifiers, so its chord is latched on keydown.
  const pasteIntent = useRef<PasteChordIntent>('split')

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const intent = pasteIntent.current
    pasteIntent.current = 'split'
    const view = EditorView.findFromDOM(event.currentTarget)
    const content = readClipboardContent(event.clipboardData)
    if (!view || view.state.readOnly || !content) return
    event.preventDefault()
    void pasteIntoDraft(view, content, intent, {runtime, repo})
  }

  const extensions = useMemo(() => {
    const submit = () => { handlers.current.onSubmit(); return true }
    return [
      keyboardAwareScroll(),
      // A block's edits are undone by the repo's undo; a draft is no block yet,
      // so it keeps CodeMirror's.
      history(),
      keymap.of(historyKeymap),
      // The draft's owner sets `value` from outside (a re-aim's prefill); undo
      // stays with what was typed.
      EditorState.transactionExtender.of(tr =>
        tr.annotation(ExternalChange) ? {annotations: Transaction.addToHistory.of(false)} : null),
      // An async insert (a paste's capture, a place lookup) can land after the
      // owner made the draft read-only to submit it; dispatch ignores readOnly.
      EditorState.changeFilter.of(tr => !tr.startState.readOnly),
      ...createMinimalMarkdownConfig([
        ...runtime.read(codeMirrorExtensionsFacet)({repo}),
        // After the plugins', so an open completion takes Enter first. In a
        // block, Enter is the outline's split, which never reaches a draft.
        // eslint-disable-next-line react-hooks/refs -- read on a key press, never during render
        keymap.of([
          {key: 'Enter', run: insertNewline},
          {key: 'Mod-Enter', run: submit},
          {key: 'Ctrl-Enter', run: submit}, // on macOS, where Mod is Cmd
          {key: 'Escape', run: view => closeCompletion(view) || (handlers.current.onCancel(), true)},
        ]),
        EditorView.contentAttributes.of({'aria-label': label, 'aria-multiline': 'true'}),
      ]),
    ]
  }, [repo, runtime, label])

  return (
    <div
      onKeyDownCapture={(event: KeyboardEvent) => { pasteIntent.current = pasteChordIntent(event) ?? pasteIntent.current }}
      onKeyDown={(event: KeyboardEvent) => event.stopPropagation()}
      onPasteCapture={onPaste}
      className={className}
    >
      <CodeMirror
        ref={ref}
        theme="none"
        value={value}
        onChange={stableOnChange}
        extensions={extensions}
        basicSetup={BLOCK_EDITOR_BASIC_SETUP}
        indentWithTab={false}
        readOnly={readOnly}
        placeholder={placeholder}
      />
    </div>
  )
}
