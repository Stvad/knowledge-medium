import { createContext, useContext, type PropsWithChildren, type ReactElement } from 'react'

/**
 * Marks a subtree as BACKGROUND: rendered and fully alive, but not the one
 * the user is acting on. A host that keeps several layout sessions mounted
 * at once sets this on every session except the visible one.
 *
 * The contract, and the whole reason for the name: a background subtree
 * may keep doing anything it likes — render, hold query subscriptions, run
 * animations, play media — but it MUST NOT claim a resource the app has
 * only one of. Today that means the keyboard, via the declarative shortcut
 * funnel. It is deliberately NOT a signal to shut down: keeping hidden
 * lanes fully alive is the point of the feature, so a consumer that reads
 * this and stops working is misusing it.
 *
 * Why it exists at all — input ownership and effect lifetime are welded
 * together, and a host that keeps sessions warm needs them apart. Hiding
 * inactive lanes with CSS is the settled mode, because it is the only one
 * that preserves a lane exactly: DOM, handles, animations, media, and the
 * query subscriptions that live in effects, all of which
 * `<Activity mode="hidden">` would tear down
 * (docs/handle-lifecycle-hidden-subtrees.html). No production code in
 * `src/` mounts `Activity`. The cost of that choice is precisely this: a
 * CSS-hidden lane keeps every effect mounted, so it goes on owning the
 * keyboard unless something retracts the claim.
 *
 * `LayoutWsContext` is the other member of this family — a background
 * subtree keeps re-rendering, so its anchors would otherwise stamp the
 * ACTIVE lane's ws-context onto their hrefs. Same shape: a resource with
 * one holder, and a mounted-but-background subtree that must not speak for
 * the app. Expect `document.title`, DOM focus and any global modal slot to
 * join if they ever contend.
 *
 * Default `false` — with no provider mounted, behaviour is exactly what it
 * was, which is correct for a single-session host.
 *
 * DELIBERATELY NOT a key on `blockContext`: it is a dependency of
 * `DefaultBlockRenderer`'s `resolveContext` memo, whose identity is the
 * element TYPE of every slot that memo builds — so flipping a flag there
 * remounts each block's slots, the live CodeMirror editor included, which
 * defeats the point of keeping the lane alive. That invariant and its
 * precedent belong to `BlockResolveContext`; see
 * `src/extensions/blockInteraction.ts`. A dedicated context re-renders
 * only the activation hook's callers.
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
 * HANDOVER is ownership-safe, and does not depend on commit ordering.
 * `useActionContextActivations` registers through `claim`/`release`, which
 * are keyed by token rather than by context type, so two mounted subtrees
 * may hold the same type at once and a leaver can never delete the
 * arriver's live claim. That was not always true: by-type `deactivate`
 * made a handover safe only when both halves flipped in one commit, and
 * `test/backgroundSubtreeActivations.test.tsx` pins the split-commit case
 * that used to fail.
 */
export const BackgroundSubtreeContext = createContext(false)

/** Whether the calling component sits in a background subtree — alive, but
 *  not entitled to claim single-holder app resources. */
export function useIsBackgroundSubtree(): boolean {
  return useContext(BackgroundSubtreeContext)
}

/**
 * Mark a subtree background (or leave it in the foreground).
 *
 * Background-ness is MONOTONIC through nesting: `background` ORs with the
 * inherited value, so a descendant of a background subtree can never
 * promote itself back to the foreground and take the keyboard from the
 * lane the user is actually in. A caller that genuinely needs to exempt a
 * descendant provides the raw {@link BackgroundSubtreeContext} with
 * `false` — an explicit, greppable escape hatch rather than a silent prop.
 *
 * Note this composes differently from `LayoutWsContext`, its sibling in
 * the same family: that one is innermost-wins, because a nested session
 * genuinely replaces its parent's identity. Here the outermost `true`
 * wins. Keep them separate contexts for that reason — one value with two
 * opposite nesting rules invites an override that reads correct and is not.
 *
 * The escape hatch is for a descendant that is React-inside the background
 * subtree but VISIBLE on screen — a shared modal portalled out of it, say.
 * Using it on a subtree that is genuinely hidden reinstates the exact
 * failure the provider exists to prevent.
 */
export function BackgroundSubtreeProvider(
  {background, children}: PropsWithChildren<{background: boolean}>,
): ReactElement {
  const inherited = useContext(BackgroundSubtreeContext)
  return (
    <BackgroundSubtreeContext.Provider value={inherited || background}>
      {children}
    </BackgroundSubtreeContext.Provider>
  )
}
