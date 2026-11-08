/** Runtime stand-in for the app's `@/utils/navigation.js`.
 *
 *  The view calls `useBlockOpener()` once and invokes the returned opener per
 *  duplicate session it renders an "Open" affordance for. The real hook
 *  resolves a live `Repo`/panel React context this suite does not stand up —
 *  reproducing that would test the navigation stack, not this view. What the
 *  view's contract actually is is "which block did the click try to open",
 *  so this records that and nothing else.
 *
 *  Aliased in `vitest.config.ts`; `src/` still imports the real path. */

export interface OpenedTarget {
  blockId: string
  workspaceId?: string
}

let opened: OpenedTarget[] = []

/** Back to "nothing opened yet". Call in `beforeEach`. */
export const resetOpenedBlocks = (): void => {
  opened = []
}

export const openedBlocks = (): readonly OpenedTarget[] => opened

export const useBlockOpener = () => (_event: unknown, target: OpenedTarget): void => {
  opened.push(target)
}

// ──── navigateFromGlobalCommand ────
//
// The real one resolves to `null` — it never rejects — when a
// navigation-policy plugin vetoes the gesture or the navigation errors. That
// silent `null` is the whole reason this fake is ARMABLE rather than a plain
// recorder: a caller that discards the result looks exactly like a caller that
// succeeded, so the only way to tell them apart is to refuse and watch.

let navigations: OpenedTarget[] = []
let refuse = false

/** Back to "nothing navigated, nothing refused". Call in `beforeEach`. */
export const resetNavigation = (): void => {
  navigations = []
  refuse = false
}

/** Make every later navigation resolve `null`, as a vetoed gesture does. */
export const refuseNavigation = (): void => { refuse = true }

export const navigatedTo = (): readonly OpenedTarget[] => navigations

export const navigateFromGlobalCommand = async (
  _repo: unknown,
  target: OpenedTarget,
): Promise<{blockId: string} | null> => {
  navigations.push(target)
  return refuse ? null : {blockId: target.blockId}
}
