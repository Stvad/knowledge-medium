import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { useLayoutEffect, useMemo, useRef, type KeyboardEvent, type Ref } from 'react'
import { closeCompletion } from '@codemirror/autocomplete'
import { EditorView, keymap } from '@codemirror/view'
import { history, historyKeymap, insertNewline } from '@codemirror/commands'
import { useRepo } from '@/context/repo.js'
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
  // The keymap is built once per editor; it reads the latest callbacks.
  const handlers = useRef({onSubmit, onCancel})
  useLayoutEffect(() => { handlers.current = {onSubmit, onCancel} })

  const extensions = useMemo(() => [
    keyboardAwareScroll(),
    // A block's edits are undone by the repo's undo; a draft is no block yet,
    // so it keeps CodeMirror's.
    history(),
    keymap.of(historyKeymap),
    ...createMinimalMarkdownConfig([
      ...runtime.read(codeMirrorExtensionsFacet)({repo}),
      // After the plugins', so an open completion takes Enter first. In a
      // block, Enter is the outline's split, which never reaches a draft.
      // eslint-disable-next-line react-hooks/refs -- read on a key press, never during render
      keymap.of([
        {key: 'Enter', run: insertNewline},
        {key: 'Mod-Enter', run: () => { handlers.current.onSubmit(); return true }},
        // Ctrl as well on macOS, where Mod is Cmd.
        {key: 'Ctrl-Enter', run: () => { handlers.current.onSubmit(); return true }},
        {key: 'Escape', run: view => closeCompletion(view) || (handlers.current.onCancel(), true)},
      ]),
      EditorView.contentAttributes.of({'aria-label': label, 'aria-multiline': 'true'}),
    ]),
  ], [repo, runtime, label])

  return (
    <div onKeyDown={(event: KeyboardEvent) => event.stopPropagation()} className={className}>
      <CodeMirror
        ref={ref}
        theme="none"
        value={value}
        onChange={onChange}
        extensions={extensions}
        basicSetup={BLOCK_EDITOR_BASIC_SETUP}
        indentWithTab={false}
        readOnly={readOnly}
        placeholder={placeholder}
      />
    </div>
  )
}
