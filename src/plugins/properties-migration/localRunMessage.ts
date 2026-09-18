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
 * Workspace-SCOPED for the same reason everything else the dialog reads is: a
 * run started on one workspace and a dialog raised by a peer's claim on another
 * would otherwise be reported as the same thing.
 */
import { CallbackSet } from '@/utils/callbackSet'

export interface LocalMigrationRun {
  readonly workspaceId: string
  readonly message: string
}

let run: LocalMigrationRun | null = null
const listeners = new CallbackSet<[]>('properties-migration-local-run')

export const getLocalMigrationRun = (): LocalMigrationRun | null => run

export const subscribeLocalMigrationRun = (listener: () => void): (() => void) =>
  listeners.add(listener)

export const setLocalMigrationRun = (next: LocalMigrationRun | null): void => {
  if (next?.workspaceId === run?.workspaceId && next?.message === run?.message) return
  run = next
  listeners.notify()
}
