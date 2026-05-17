/**
 * Imperative dialog facade. Mirrors `utils/toast.ts` so non-React
 * callers (action handlers, post-commit processors, scripted tasks)
 * can prompt the user without holding a React tree. A single
 * `<DialogHost />` mounted via `appMountsFacet` subscribes to the
 * queue and renders whatever is currently outstanding.
 *
 * Each `openDialog` call returns a promise that resolves when the
 * dialog confirms (with the typed result) or cancels (with `null`).
 * Dialogs queue independently — a second `openDialog` while one is
 * already on screen mounts both. Callers that want to serialise
 * should `await` the previous promise before opening the next.
 */
import type { ComponentType } from 'react'
import { CallbackSet } from '@/utils/callbackSet'

export interface DialogContextProps<TResult> {
  resolve: (value: TResult) => void
  cancel: () => void
}

export type DialogComponent<
  TResult,
  TProps extends object = Record<string, never>,
> = ComponentType<DialogContextProps<TResult> & TProps>

/** Untyped entry the host iterates. The typed `openDialog` casts at
 *  the boundary so consumers keep narrow generics on their dialog
 *  components without leaking unknowns across the API. */
export interface DialogQueueEntry {
  id: number
  Component: ComponentType<DialogContextProps<unknown> & Record<string, unknown>>
  props: Record<string, unknown>
  /** Called by the host when the dialog component invokes
   *  `resolve(value)` or `cancel()`. Cancellation passes `null`. */
  finalize: (value: unknown) => void
}

let nextId = 0
const subscribers = new CallbackSet<[]>('dialogs')
let queue: readonly DialogQueueEntry[] = []

export const openDialog = <
  TResult,
  TProps extends object = Record<string, never>,
>(
  Component: DialogComponent<TResult, TProps>,
  props?: TProps,
): Promise<TResult | null> =>
  new Promise(resolve => {
    const id = ++nextId
    const finalize = (value: unknown): void => {
      queue = queue.filter(entry => entry.id !== id)
      resolve(value as TResult | null)
      subscribers.notify()
    }
    const entry: DialogQueueEntry = {
      id,
      Component: Component as ComponentType<
        DialogContextProps<unknown> & Record<string, unknown>
      >,
      props: (props ?? {}) as Record<string, unknown>,
      finalize,
    }
    queue = [...queue, entry]
    subscribers.notify()
  })

export const getDialogQueue = (): readonly DialogQueueEntry[] => queue

export const subscribeDialogs = (callback: () => void): (() => void) =>
  subscribers.add(callback)

/** Test-only reset. Drops all queued dialogs (resolving each with
 *  `null` so any awaiters unblock) and notifies subscribers so the
 *  host unmounts. */
export const __resetDialogsForTests = (): void => {
  const drained = queue
  queue = []
  nextId = 0
  for (const entry of drained) entry.finalize(null)
  subscribers.notify()
}
