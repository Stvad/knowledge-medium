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

// ──── navigate / navigateFromGlobalCommand ────
//
// Both resolve to `null` — neither rejects — when a navigation-policy plugin
// vetoes the gesture or the navigation errors. That silent `null` is the whole
// reason this fake is ARMABLE rather than a plain recorder: a caller that
// discards the result looks exactly like a caller that succeeded, so the only
// way to tell them apart is to refuse and watch.
//
// They share one list so a test reads "where did this land" in one place, and
// each records WHICH entry point it came through — that is the distinction
// under test (a command lands in the main pane; a panel navigation swaps the
// pane the gesture was made in), and it is invisible from the block id alone.

export type Navigation =
  | {via: 'global-command'; blockId: string; workspaceId?: string}
  | {via: 'navigate'; blockId: string; workspaceId?: string; target: string; panelId?: string}

let navigations: Navigation[] = []
let refuse = false

/** Back to "nothing navigated, nothing refused". Call in `beforeEach`. */
export const resetNavigation = (): void => {
  navigations = []
  refuse = false
}

/** Make every later navigation resolve `null`, as a vetoed gesture does. */
export const refuseNavigation = (): void => { refuse = true }

export const navigatedTo = (): readonly Navigation[] => navigations

const record = (entry: Navigation): {blockId: string} | null => {
  navigations.push(entry)
  return refuse ? null : {blockId: entry.blockId}
}

export const navigateFromGlobalCommand = async (
  _repo: unknown,
  {blockId, workspaceId}: OpenedTarget,
): Promise<{blockId: string} | null> =>
  record({via: 'global-command', blockId, workspaceId})

export const navigate = async (
  _repo: unknown,
  {blockId, workspaceId, target, panelId}: {
    blockId: string
    workspaceId?: string
    target: string
    panelId?: string
  },
): Promise<{blockId: string} | null> =>
  record({via: 'navigate', blockId, workspaceId, target, panelId})
