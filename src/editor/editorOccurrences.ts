import type { EditorView } from '@codemirror/view'

/** The mounted editors of each block occurrence (a block in one render scope).
 *  A move can mount the block's new instance a commit before its old one is
 *  removed, and either may take focus last: the one removed while it holds
 *  focus hands it to the one that stays. */
const mounted = new Map<string, Set<EditorView>>()

const keyOf = (blockId: string, renderScopeId: string | undefined) => `${renderScopeId ?? ''}\u0000${blockId}`

/** Register a mounted editor; the returned release runs while its DOM is still
 *  attached (a layout effect's cleanup), so it can still see its own focus. */
export const trackEditorOccurrence = (
  blockId: string, renderScopeId: string | undefined, view: EditorView,
): () => void => {
  const key = keyOf(blockId, renderScopeId)
  const views = mounted.get(key) ?? new Set<EditorView>()
  mounted.set(key, views)
  views.add(view)
  return () => {
    const hadFocus = view.hasFocus
    views.delete(view)
    if (views.size === 0) mounted.delete(key)
    if (!hadFocus) return
    // After the commit has removed the leaving editor, and only if nothing
    // else took focus meanwhile.
    queueMicrotask(() => {
      const active = document.activeElement
      if (active && active !== document.body && active.isConnected) return
      ;[...views].find(other => other.dom.isConnected)?.focus()
    })
  }
}
