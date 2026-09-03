/**
 * A module store holding the latest snapshot PER WORKSPACE.
 *
 * The per-workspace keying is the point, not an implementation detail: a
 * publish for one workspace must not blank a subscriber reading another, so a
 * single slot would let a background pass for workspace A wipe what an open
 * dialog is showing for workspace B. Keeping that rule in one place is why this
 * is a factory rather than a shape each caller re-types.
 *
 * Framework-agnostic — `subscribe` / `getFor` are shaped for
 * `useSyncExternalStore`, and callers reach a peer plugin's store through an
 * action id rather than importing it, exactly as `@/utils/toggleStore` does.
 */
import { CallbackSet } from '@/utils/callbackSet.js'

export interface WorkspaceSnapshotStore<T> {
  publish: (snapshot: T) => void
  /** The last snapshot for `workspaceId` — a stable reference until THAT
   *  workspace publishes again — or null. */
  getFor: (workspaceId: string | null | undefined) => T | null
  subscribe: (listener: () => void) => () => void
  /** Drop every snapshot and tell subscribers to re-read — for when the
   *  snapshots describe a world that no longer exists (a Repo swap) but the
   *  subscribers are the same components and must keep receiving updates.
   *  Distinct from `reset` because detaching a `useSyncExternalStore` listener
   *  is PERMANENT: it re-subscribes only when the `subscribe` identity changes,
   *  and these are module-stable. */
  clearSnapshots: () => void
  /** Test helper — also drops the listeners, which no production caller may do.
   *  For `afterEach`, so one test's subscribers cannot outlive it. */
  reset: () => void
}

export const createWorkspaceSnapshotStore = <T extends { workspaceId: string }>(
  label: string,
): WorkspaceSnapshotStore<T> => {
  const byWorkspace = new Map<string, T>()
  const listeners = new CallbackSet(label)
  return {
    publish: (snapshot) => {
      byWorkspace.set(snapshot.workspaceId, snapshot)
      listeners.notify()
    },
    getFor: (workspaceId) =>
      (workspaceId != null ? byWorkspace.get(workspaceId) : undefined) ?? null,
    subscribe: (listener) => listeners.add(listener),
    clearSnapshots: () => {
      byWorkspace.clear()
      listeners.notify()
    },
    reset: () => {
      byWorkspace.clear()
      listeners.clear()
    },
  }
}
