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
