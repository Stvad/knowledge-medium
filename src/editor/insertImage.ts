/**
 * Pick image file(s) from the OS and insert their captured `((assetBlockId))`
 * reference(s) at the editor's caret — the editor-layer counterpart to the
 * paste path, reusable from any edit-mode surface (the mobile keyboard toolbar
 * button, the command palette, a future desktop button).
 *
 * It deliberately owns the whole awkward async-picker dance so callers don't
 * have to: snapshot the caret up front (the picker blurs the editor), hold edit
 * mode alive across the round-trip, capture through the shared media seam, and
 * refocus when done. Capture goes through {@link captureMediaVerb} (the
 * attachments plugin's effect) so byte storage / upload / content-dedup live in
 * exactly one place and this never imports the plugin.
 */
import { EditorSelection } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { Block } from '@/data/block.js'
import { captureMediaVerb } from '@/paste/captureMediaVerb.js'
import { resolveEditModeKeepalive, withEditModeKeepalive } from '@/components/editModeKeepalive.js'
import { showError } from '@/utils/toast.js'

export const INSERT_IMAGE_ACTION_ID = 'edit.cm.insert_image'
/** Normal-mode variant (no caret) — appends the image to the focused block. */
export const INSERT_IMAGE_NORMAL_MODE_ACTION_ID = 'insert_image'

/** Open the OS file picker for image(s); resolves with the chosen files, or an
 *  empty array if the user dismissed it. MUST be called synchronously inside a
 *  user gesture (it clicks a transient `<input>` before returning) or the
 *  browser won't open the picker. */
function pickImageFiles(): Promise<File[]> {
  return new Promise<File[]>(resolve => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.multiple = true
    // Off-screen-in-document rather than detached: some browsers only open the
    // picker for an input that's actually in the document.
    input.style.position = 'fixed'
    input.style.left = '-9999px'
    let settled = false
    let backstop = 0
    const cleanup = (files: File[]) => {
      if (settled) return
      settled = true
      input.removeEventListener('change', onChange)
      input.removeEventListener('cancel', onCancel)
      window.removeEventListener('focus', onWindowFocus)
      window.clearTimeout(backstop)
      input.remove()
      resolve(files)
    }
    const onChange = () => cleanup(input.files ? Array.from(input.files) : [])
    const onCancel = () => cleanup([])
    // Dismissal fallback. The `cancel` event isn't fired by older iOS Safari /
    // WebViews (< Safari 16.4), so a dismissed picker would otherwise resolve
    // neither `change` nor `cancel` — hanging the promise and leaking the
    // caller's edit-mode keepalive (pinning edit mode app-wide). So when focus
    // returns to the window with no files chosen, treat it as a dismissal,
    // deferred a tick so a real `change` (which populates `input.files` first)
    // wins.
    //
    // Known trade-off: alt-tabbing back while the picker is still open can
    // false-cancel and drop a subsequent selection — recoverable by re-picking,
    // and far better than a hung promise. We deliberately do NOT gate this on a
    // prior window `blur`: the cancel-less WebViews this exists for may not fire
    // one when the picker opens, which would suppress the release on exactly the
    // environments that need it.
    const onWindowFocus = () => {
      window.setTimeout(() => {
        if (!input.files || input.files.length === 0) cleanup([])
      }, 300)
    }
    // Absolute backstop: guarantee the promise resolves (and the keepalive
    // releases) even in an environment that fires neither `cancel` nor window
    // `focus`. Generous so a slow real pick — which still resolves via `change` —
    // is never cut short; only a truly event-less dismissal waits this out.
    backstop = window.setTimeout(() => cleanup([]), 3 * 60_000)
    input.addEventListener('change', onChange)
    input.addEventListener('cancel', onCancel)
    window.addEventListener('focus', onWindowFocus)
    document.body.appendChild(input)
    input.click()
  })
}

/** Insert reference text at a caret, preferring the live editor (caret lands
 *  after the insert, change rides the editor's normal commit path); falls back
 *  to writing block content directly if the editor unmounted while the picker
 *  was open. */
function insertReferencesAtCaret(
  editorView: EditorView,
  block: Block,
  caret: { from: number; to: number },
  references: readonly string[],
): void {
  // One reference per captured file, each on its own line — matches the paste
  // path's separator (src/paste/operations.ts), so a multi-image insert reads
  // the same whether it came from paste or this picker.
  const insertText = references.join('\n')

  if (editorView.dom.isConnected) {
    const docLength = editorView.state.doc.length
    const from = Math.min(caret.from, docLength)
    const to = Math.min(caret.to, docLength)
    editorView.dispatch({
      changes: { from, to, insert: insertText },
      selection: EditorSelection.cursor(from + insertText.length),
    })
    editorView.focus()
    return
  }

  const content = block.peek()?.content ?? ''
  const from = Math.min(caret.from, content.length)
  const to = Math.min(caret.to, content.length)
  void block.setContent(content.slice(0, from) + insertText + content.slice(to))
}

/** Capture already-read files into `((assetBlockId))` reference strings via the
 *  shared media seam, deriving repo/runtime/workspace from the target block.
 *  Returns [] when there's nothing to insert (no runtime/workspace, or capture
 *  failed — failures are toasted by the verb impl). */
async function captureFilesToReferences(block: Block, files: readonly File[]): Promise<string[]> {
  const repo = block.repo
  const runtime = repo.facetRuntime
  if (!runtime) return []
  const workspaceId = block.peek()?.workspaceId ?? repo.activeWorkspaceId ?? ''
  if (!workspaceId) {
    showError('Open a workspace to attach images.')
    return []
  }
  const { references } = await captureMediaVerb.run(runtime, { repo, workspaceId, files: [...files] })
  return [...references]
}

/** Pick image file(s) and insert their captured references at the editor's
 *  caret. MUST be reached synchronously from a user gesture (it clicks the
 *  picker before its first await) so the OS picker actually opens. */
export async function pickAndInsertImages(
  { editorView, block }: { editorView: EditorView; block: Block },
): Promise<void> {
  const { from, to } = editorView.state.selection.main
  const caret = { from, to }
  try {
    // Keep edit mode alive across the picker: it blurs the editor, and the
    // deferred exit-on-blur would otherwise see focus on the file input (or, on
    // return, on nothing) and tear edit mode down. 'refocus' keeps edit mode AND
    // snaps focus back; withEditModeKeepalive holds it past the round-trip and
    // the late post-insert commit. See editModeKeepalive.
    await withEditModeKeepalive('refocus', async () => {
      const files = await pickImageFiles()
      if (files.length === 0) return
      const references = await captureFilesToReferences(block, files)
      if (references.length === 0) return
      insertReferencesAtCaret(editorView, block, caret, references)
    })
  } finally {
    requestAnimationFrame(() => {
      // Don't pull focus back if another surface (an open palette holding a
      // 'yield-focus' keepalive) owns it — mirror the blur handler's
      // yield-over-refocus precedence. Skip a torn-down editor.
      if (resolveEditModeKeepalive() !== 'yield' && editorView.dom.isConnected) {
        editorView.focus()
      }
    })
  }
}

/** Pick image file(s) and append their captured references to a block's
 *  content — the normal-mode counterpart to {@link pickAndInsertImages}, for
 *  when there's no editor/caret (a focused-but-not-editing block). No keepalive:
 *  there's no edit-mode session to preserve. Appends on its own line(s) — the
 *  image renders inline after the block's existing content, matching the
 *  at-caret insert's "inline in this block" semantics. MUST be reached
 *  synchronously from a user gesture so the picker opens. */
export async function pickImagesIntoBlock(block: Block): Promise<void> {
  const files = await pickImageFiles()
  if (files.length === 0) return
  const references = await captureFilesToReferences(block, files)
  if (references.length === 0) return
  // Ensure the row is loaded before deriving new content — `peek()` is
  // `undefined` for a not-yet-resident block, and `?? ''` would turn the append
  // into a full overwrite that drops the real content.
  const data = block.peek() ?? await block.load()
  if (!data) return
  const refsText = references.join('\n')
  // Trim trailing whitespace/newlines so the append doesn't open a blank line
  // (or strand a whitespace-only block before the image).
  const base = (data.content ?? '').replace(/\s+$/, '')
  await block.setContent(base ? `${base}\n${refsText}` : refsText)
}
