import { createContext, useContext, type PropsWithChildren, type ReactElement } from 'react'

/**
 * Marks a subtree's shortcut surfaces as SUSPENDED: every declarative
 * activation below this point resolves to nothing, so
 * `useActionContextActivations` deactivates whatever the subtree owns and
 * re-registers it when suspension lifts.
 *
 * Why this exists — it decouples two things that are currently welded
 * together by effect lifetime. A host that keeps several layout sessions
 * mounted at once (perspective keep-alive) has to hide all but one, and
 * both hiding modes are wrong in a different direction:
 *
 *   - `<Activity mode="hidden">` unmounts the hidden subtree's EFFECTS,
 *     which deregisters its action contexts for free — but subscriptions
 *     live in effects too, so the subtree's query handles are disposed
 *     while hidden and the reveal path re-renders from scratch
 *     (docs/handle-lifecycle-hidden-subtrees.html).
 *   - CSS hiding preserves the subtree exactly, but every hidden lane
 *     keeps its contexts registered — and `ActiveContexts` is
 *     last-activated-wins per context TYPE with no ownership check
 *     (docs/activeContexts-ownership-bug.md), so the lane you left keeps
 *     owning the keyboard.
 *
 * This context is the missing third option: preserve the subtree, but stop
 * it owning the keyboard. Default `false` — with no provider mounted,
 * behaviour is exactly what it was.
 *
 * DELIBERATELY NOT a key on `blockContext`: `blockContext` identity feeds
 * `DefaultBlockRenderer`'s renderer-resolution memo, so flipping a flag
 * there remounts every block in the subtree — which defeats the whole
 * point of keeping it alive. A dedicated context re-renders only the
 * activation hook's callers.
 *
 * SCOPE: this gates the DECLARATIVE funnel only — `useActionContext*` and
 * everything routed through it (`useShortcutSurfaceActivations`,
 * `PanelRenderer`'s MULTI_SELECT, `TopLevelRenderer`'s GLOBAL,
 * `ReviewSession`). Contexts entered imperatively from an action handler
 * (`dispatch.activate`, e.g. date-scrub) are not affected — but neither
 * are they cleared by Activity's effect unmount, so it is parity with the
 * alternative rather than a gap this introduces.
 */
export const ShortcutSurfaceSuspensionContext = createContext(false)

/** Whether the calling component's shortcut surfaces are suspended. */
export function useShortcutSurfacesSuspended(): boolean {
  return useContext(ShortcutSurfaceSuspensionContext)
}

/**
 * Suspend (or leave live) the shortcut surfaces of a subtree.
 *
 * Suspension is MONOTONIC through nesting: `suspended` ORs with the
 * inherited value, so a nested surface inside a hidden lane can never
 * hand the keyboard back to a subtree the host has hidden. A caller that
 * genuinely needs to un-suspend a descendant (a host that mounts a shared
 * modal inside a hidden lane, say) can provide the raw
 * {@link ShortcutSurfaceSuspensionContext} with `false` — an explicit,
 * greppable escape hatch rather than a silent prop.
 */
export function ShortcutSurfaceSuspensionProvider(
  {suspended, children}: PropsWithChildren<{suspended: boolean}>,
): ReactElement {
  const inherited = useContext(ShortcutSurfaceSuspensionContext)
  return (
    <ShortcutSurfaceSuspensionContext.Provider value={inherited || suspended}>
      {children}
    </ShortcutSurfaceSuspensionContext.Provider>
  )
}
