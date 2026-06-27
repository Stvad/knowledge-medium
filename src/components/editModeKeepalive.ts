/**
 * Edit-mode keepalive — a process-wide latch that tells {@link
 * BlockEditor}'s blur handler to KEEP a block in edit mode even though the
 * CodeMirror editor has lost DOM focus, instead of running its default
 * exit-on-blur.
 *
 * Two surfaces legitimately pull focus off a focused editor without meaning
 * to end editing, and they want OPPOSITE things from the blur handler:
 *
 *  - 'refocus' — the focus loss is incidental and the editor should get focus
 *    back. The mobile keyboard toolbar uses this: a structural action (indent /
 *    reorder) reparents the editor's DOM node mid-commit and native focus drops
 *    to <body>, and the OS file picker steals focus while open. In both cases we
 *    want to stay in edit mode AND snap focus back to the editor.
 *
 *  - 'yield-focus' — another surface has DELIBERATELY taken focus and must keep
 *    it. The command palette uses this: opening it moves focus into the palette
 *    input, but we want the underlying editor to stay in edit mode (so its
 *    EDIT_MODE_CM context stays active and the palette can list + run edit
 *    commands against the live editor). Pulling focus back here would break the
 *    palette — so the blur handler must leave focus alone; the surface refocuses
 *    the editor itself when it closes.
 *
 * The latch is a pair of counters (not booleans) so overlapping holds compose —
 * e.g. two quick toolbar taps. `yield-focus` wins over `refocus` when both are
 * held: if any surface has claimed focus, stealing it back would break that
 * surface, so we only refocus when nothing has.
 */

export type EditModeKeepaliveMode = 'refocus' | 'yield-focus'

let refocusHolds = 0
let yieldHolds = 0

/** Acquire a keepalive hold. Returns the release fn; callers MUST schedule the
 *  release (timer / cleanup / finally). Idempotent — the returned fn is safe to
 *  call more than once but only decrements its counter once. */
export const acquireEditModeKeepalive = (mode: EditModeKeepaliveMode): (() => void) => {
  if (mode === 'refocus') refocusHolds++
  else yieldHolds++
  let released = false
  return () => {
    if (released) return
    released = true
    if (mode === 'refocus') refocusHolds--
    else yieldHolds--
  }
}

/** What the editor's blur handler should do, given any active holds:
 *   - 'exit'    — no hold; proceed with the normal exit-on-blur.
 *   - 'refocus' — a hold is active and no surface owns focus; keep edit mode and
 *                 snap focus back to the editor.
 *   - 'yield'   — a surface owns focus; keep edit mode but leave focus where it
 *                 is (the surface restores editor focus on close). */
export const resolveEditModeKeepalive = (): 'exit' | 'refocus' | 'yield' => {
  if (yieldHolds > 0) return 'yield'
  if (refocusHolds > 0) return 'refocus'
  return 'exit'
}
