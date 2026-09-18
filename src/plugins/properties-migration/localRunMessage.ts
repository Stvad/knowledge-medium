/**
 * What the device running the migration is doing right now, and which workspace
 * it is doing it to.
 *
 * A module store because the two ends never meet in a React tree: the gesture
 * is an action handler, and the dialog that shows this is mounted app-wide off
 * the synced claim. Every OTHER device shows the same dialog with nothing here,
 * which is the honest state — a peer knows the workspace is being converted and
 * not how far along it is.
 *
 * OWNED, which is the part that is not obvious. The palette is global and stays
 * reachable while the dialog is up, so a second invocation can start, be turned
 * away by the claim, and report its own failure — and an unowned store would
 * let that failure clear the running line, which is what carries "leave this
 * tab open", at the moment the operator is most likely to close the tab. A
 * write only lands while the writer still holds the slot.
 */
import { createWorkspaceSnapshotStore } from '@/utils/workspaceSnapshotStore.js'

/** Identity only — never inspected, so nothing can forge or guess one. */
export type RunOwner = symbol

export interface LocalRunSnapshot {
  readonly workspaceId: string
  readonly message: string
  readonly owner: RunOwner
  /** Has this run taken the claim? The dialog cannot read that off the claim
   *  row, because "no claim" is true at BOTH ends of a run — before `tryClaim`
   *  writes it, and after it is released or completed. Without this, the tab
   *  that is writing reads as one that has not started, and is told nothing has
   *  been written. */
  readonly claimed: boolean
}

const store = createWorkspaceSnapshotStore<LocalRunSnapshot>('properties-migration-local-run')

export const subscribeLocalMigrationRun = store.subscribe

export const localMigrationRunFor = (
  workspaceId: string | null,
): LocalRunSnapshot | null => store.getFor(workspaceId)

/** Take the slot for `workspaceId`, if it is free. The returned owner is what
 *  every later write has to present.
 *
 *  FIRST-WINS, which is the point: a second invocation arriving while a run is
 *  live gets a token that owns nothing, so every one of its writes — including
 *  the failure report it is about to make when the claim turns it away — is a
 *  no-op here. The live run keeps the line. Its outcome still reaches the user;
 *  outcomes are toasts, and they do not come through this slot. */
export const beginLocalMigrationRun = (
  workspaceId: string, message: string,
): RunOwner => {
  const owner: RunOwner = Symbol('properties-migration-run')
  if (store.getFor(workspaceId) === null) {
    store.publish({workspaceId, message, owner, claimed: false})
  }
  return owner
}

export const updateLocalMigrationRun = (
  owner: RunOwner, workspaceId: string, message: string,
): void => {
  const live = store.getFor(workspaceId)
  if (live?.owner !== owner) return
  store.publish({...live, message})
}

/** This run now holds the claim, and keeps saying so until it ends. */
export const markLocalMigrationRunClaimed = (
  owner: RunOwner, workspaceId: string,
): void => {
  const live = store.getFor(workspaceId)
  if (live?.owner !== owner) return
  store.publish({...live, claimed: true})
}

export const endLocalMigrationRun = (owner: RunOwner, workspaceId: string): void => {
  if (store.getFor(workspaceId)?.owner !== owner) return
  store.clearFor(workspaceId)
}

/** Test helper — drops the listeners too, which no production caller may do. */
export const __resetLocalMigrationRunForTests = store.reset
