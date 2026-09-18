/**
 * What the device running the migration is doing right now.
 *
 * A module store because the two ends never meet in a React tree: the gesture
 * is an action handler, and the dialog that shows this is mounted app-wide off
 * the synced claim. Every OTHER device shows the same dialog with nothing here,
 * which is the honest state — a peer knows the workspace is being converted and
 * not how far along it is.
 */
import { CallbackSet } from '@/utils/callbackSet'

let message: string | null = null
const listeners = new CallbackSet<[]>('properties-migration-local-run')

export const getLocalMigrationMessage = (): string | null => message

export const subscribeLocalMigrationMessage = (listener: () => void): (() => void) =>
  listeners.add(listener)

export const setLocalMigrationMessage = (next: string | null): void => {
  if (next === message) return
  message = next
  listeners.notify()
}
