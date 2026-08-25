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
  /** Test helper — clear published snapshots and listeners. */
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
    reset: () => {
      byWorkspace.clear()
      listeners.clear()
    },
  }
}
