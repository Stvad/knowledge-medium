import { useLayoutEffect, useRef } from 'react'
import { acquireEditModeKeepalive } from '@/components/editModeKeepalive.js'
import {
  editorViewFromActiveContexts,
  useActiveContextsState,
} from '@/shortcuts/ActiveContexts.js'

/**
 * Keep the underlying editor in edit mode while an overlay surface is open
 * IF it was opened from edit mode. Opening the overlay moves focus off the
 * editor, which would otherwise trip BlockEditor's exit-on-blur and
 * deactivate the EDIT_MODE_CM context — leaving the surface unable to list
 * or run edit commands (and, with vim normal mode off, no block context at
 * all). A 'yield-focus' keepalive holds edit mode without pulling focus
 * back from the overlay; on close, focus is handed back to the editor we
 * kept alive. Acquired in a layout effect so it lands before the blur's
 * deferred rAF decision fires.
 *
 * On close we refocus only if the sampled editor is STILL the active edit
 * context and mounted. A command run from the overlay may have moved focus
 * to another block or unmounted this editor; refocusing a stale view would
 * steal focus from the command, and focus() on a torn-down view can throw
 * (no `destroyed` guard in CM).
 *
 * Lives next to `acquireEditModeKeepalive`'s React consumers rather than in
 * editModeKeepalive.ts itself, which is deliberately env-agnostic and
 * node-tested. Shared by the command palette and the shortcut-help overlay
 * so the subtle focus-return contract is maintained in exactly one place.
 */
export function useEditModeYieldKeepalive(open: boolean): void {
  // Read the live active-contexts map through a ref so the open effect below
  // can sample it at open time without re-running on every activation change
  // (it's keyed on `open` alone).
  const active = useActiveContextsState()
  const activeRef = useRef(active)
  useLayoutEffect(() => {
    activeRef.current = active
  }, [active])

  useLayoutEffect(() => {
    if (!open) return
    const editorView = editorViewFromActiveContexts(activeRef.current)
    if (!editorView) return // opened from normal mode / not editing — nothing to keep alive
    const release = acquireEditModeKeepalive('yield-focus')
    return () => {
      const liveView = editorViewFromActiveContexts(activeRef.current)
      if (liveView === editorView && editorView.dom.isConnected) editorView.focus()
      release()
    }
  }, [open])
}
