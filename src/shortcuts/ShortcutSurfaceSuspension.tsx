import { createContext, useContext, type PropsWithChildren, type ReactElement } from 'react'

/**
 * Marks a subtree's shortcut surfaces as SUSPENDED: every declarative
 * activation below this point resolves to nothing, so
 * `useActionContextActivations` deactivates whatever the subtree owns and
 * re-registers it when suspension lifts.
 *
 * Why this exists — input ownership and effect lifetime are welded
 * together, and a host that keeps several layout sessions mounted at once
 * (perspective keep-alive) needs them apart. Hiding the inactive lanes
 * with CSS is the settled mode, because it is the only one that preserves
 * a lane exactly: DOM, handles, animations, media, and the query
 * subscriptions that live in effects — which `<Activity mode="hidden">`
 * would tear down along with them
 * (docs/handle-lifecycle-hidden-subtrees.html). No production code in
 * `src/` mounts `Activity`.
 *
 * The cost of that choice is precisely this: a CSS-hidden lane keeps every
 * effect mounted, so it keeps its action contexts claimed — and
 * `ActiveContexts` is last-activated-wins per context TYPE with no
 * ownership check (docs/activeContexts-ownership-bug.md), so the lane you
 * left goes on owning the keyboard, and nothing else in the stack takes it
 * back. This context is therefore the SOLE mechanism for hidden-lane input
 * isolation, not a convenience over an alternative that also works.
 *
 * Default `false` — with no provider mounted, behaviour is exactly what it
 * was.
 *
 * DELIBERATELY NOT a key on `blockContext`: `blockContext` is a dependency
 * of `DefaultBlockRenderer`'s `resolveContext` memo, and that memo's
 * identity is in turn the element TYPE of every slot it builds
 * (`ContentSlot` / `FooterSlot` / `ControlsSlot` / `Layout`) — so flipping
 * a flag on it gives React a new type and remounts each block's slots, the
 * live CodeMirror editor included. That is exactly the regression #548 /
 * #553 fixed by taking `aliases` back out of the resolve context, and it
 * defeats the whole point of keeping the lane alive. A dedicated context
 * re-renders only the activation hook's callers.
 *
 * SCOPE — three boundaries worth stating outright:
 *
 *   - It gates the DECLARATIVE funnel, and that funnel is exhaustive by
 *     construction: everything reaches `useActionContextActivations`
 *     (`useShortcutSurfaceActivations`, and through it every block surface
 *     and `BlockEditor`'s EDIT_MODE_CM; `PanelRenderer`'s
 *     MULTI_SELECT_MODE; `TopLevelRenderer`'s GLOBAL; `CommandPalette`;
 *     `usePropertyEditingShortcuts`; `ReviewSession`). Suspending a lane
 *     therefore also drops a command palette or property editor mounted
 *     INSIDE it — intended, but worth knowing before you mount one there.
 *   - Contexts entered imperatively from an action handler
 *     (`dispatch.activate`) are not affected. Today that is exactly one
 *     caller, date-scrub, and its exit is driven by handlers on the
 *     app-root coordinator rather than by any lane's effects — so its
 *     claim never belonged to the lane in the first place. A gesture-
 *     scoped mode outliving a lane switch is a pre-existing property of
 *     imperative activation, not something this introduces; if one ever
 *     needs to survive a switch, that is the seam to fix, not this one.
 *   - It retracts the shortcut CLAIM only. It does not move DOM focus and
 *     it does not hide the subtree from DOM-walking consumers — spatial
 *     navigation's `horizontalNeighborPanel` enumerates
 *     `[data-layout-column-id]` across the whole `document`
 *     (plugins/spatial-navigation/walker.ts), and a CSS-hidden lane's
 *     nodes are still in it. Keeping raw keystrokes and DOM traversal out
 *     of a hidden lane stays the host's job.
 *
 * ONE-COMMIT CONSTRAINT — this is isolation by ORDERING, not by OWNERSHIP.
 * `deactivate` removes by context TYPE with no owner check, so a handover
 * between two mounted subtrees that both want the same type is only safe
 * when both flip in the SAME commit: React runs every passive-effect
 * destroy before any create, which makes the arriver's activation the last
 * write. Suspend one lane a commit LATER than the other unsuspended and
 * the leaver's blind deactivate deletes the arriver's live claim, which
 * nothing re-registers — the context ends up owned by nobody. Ownership-
 * aware claims (a per-type claim stack keyed by token) remove the
 * constraint entirely; until then, a host MUST flip the outgoing and
 * incoming lane in one commit. See the `it.fails` case in
 * `test/shortcutSurfaceSuspension.test.tsx`.
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
 * genuinely needs to un-suspend a descendant can provide the raw
 * {@link ShortcutSurfaceSuspensionContext} with `false` — an explicit,
 * greppable escape hatch rather than a silent prop.
 *
 * The escape hatch is for a descendant that is React-inside the hidden
 * lane but VISIBLE on screen — a shared modal portalled out of it, say.
 * Using it on a subtree that is genuinely hidden reinstates the exact
 * failure the provider exists to prevent.
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
