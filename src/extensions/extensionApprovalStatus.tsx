import {
  createContext,
  ReactNode,
  useContext,
  useMemo,
  useSyncExternalStore,
} from 'react'
import { CallbackSet } from '@/utils/callbackSet'
import type { ExtensionApprovalStatus } from '@/extensions/dynamicExtensions.js'

export type { ExtensionApprovalStatus }

export type ExtensionApprovalStatusMap = ReadonlyMap<string, ExtensionApprovalStatus>

/**
 * Plain non-React store for the device-local trust status of enabled
 * extension blocks (issue #67). Populated by the dynamic-extensions loader
 * during runtime resolution:
 *   - `needs-approval`: enabled by intent (here or on another device) but
 *     never approved on THIS device — nothing runs until the user reviews
 *     and approves the live source ("Enable here").
 *   - `update-available`: approved, but the live source has drifted from
 *     the approved pin — the pinned version keeps running; "Update"
 *     re-approves the live source.
 *
 * Mirrors `extensionLoadErrors.tsx`: the React provider is a thin wrapper
 * so the state machine is unit-testable without mounting a tree.
 */
export class ExtensionApprovalStatusStore {
  private statuses: ReadonlyMap<string, ExtensionApprovalStatus> = new Map()
  // When non-null a batch is open: report/clear buffer into it and DON'T
  // notify; commitBatch swaps it in as a single old→new transition. Used by
  // the runtime resolve so a re-resolve publishes atomically instead of
  // reset→dribble, which briefly blanked the map and flickered the global
  // prompt toasts + status chip.
  private batch: Map<string, ExtensionApprovalStatus> | null = null
  private readonly listeners = new CallbackSet<[]>('ExtensionApprovalStatus')

  getSnapshot = (): ExtensionApprovalStatusMap => this.statuses

  subscribe = (listener: () => void): (() => void) => this.listeners.add(listener)

  /** Open a batch. Subsequent report/clear buffer without notifying until
   *  commitBatch. The buffer starts EMPTY (like reset()) and is rebuilt from
   *  this resolve's reports — so a block that's no longer pending is simply
   *  not re-reported and drops out on commit. Discards any in-progress batch
   *  (a superseded resolve). */
  beginBatch = (): void => {
    this.batch = new Map()
  }

  /** Publish the buffered batch as ONE notification (even when it clears the
   *  map). No-op if no batch is open. */
  commitBatch = (): void => {
    if (this.batch === null) return
    this.statuses = this.batch
    this.batch = null
    this.listeners.notify()
  }

  /** Drop the buffer without publishing (cancelled / errored resolve). */
  abandonBatch = (): void => {
    this.batch = null
  }

  report = (blockId: string, status: ExtensionApprovalStatus): void => {
    if (this.batch !== null) {
      this.batch.set(blockId, status)
      return
    }
    const next = new Map(this.statuses)
    next.set(blockId, status)
    this.statuses = next
    this.listeners.notify()
  }

  clear = (blockId: string): void => {
    if (this.batch !== null) {
      this.batch.delete(blockId)
      return
    }
    if (!this.statuses.has(blockId)) return
    const next = new Map(this.statuses)
    next.delete(blockId)
    this.statuses = next
    this.listeners.notify()
  }

  reset = (): void => {
    this.batch = null
    if (this.statuses.size === 0) return
    this.statuses = new Map()
    this.listeners.notify()
  }
}

interface ExtensionApprovalStatusContextValue {
  store: ExtensionApprovalStatusStore
}

const noopStore = new ExtensionApprovalStatusStore()

const ExtensionApprovalStatusContext =
  createContext<ExtensionApprovalStatusContextValue>({store: noopStore})

export const ExtensionApprovalStatusProvider = ({
  children,
  store,
}: {
  children: ReactNode
  store?: ExtensionApprovalStatusStore
}) => {
  const ownStore = useMemo(
    () => store ?? new ExtensionApprovalStatusStore(),
    [store],
  )
  const value = useMemo(() => ({store: ownStore}), [ownStore])

  return (
    <ExtensionApprovalStatusContext.Provider value={value}>
      {children}
    </ExtensionApprovalStatusContext.Provider>
  )
}

const useStore = (): ExtensionApprovalStatusStore =>
  useContext(ExtensionApprovalStatusContext).store

/** Subscribe to a single block's trust status (undefined = running
 *  as-authored / nothing to surface). */
export const useExtensionApprovalStatus = (
  blockId: string,
): ExtensionApprovalStatus | undefined => {
  const store = useStore()
  return useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().get(blockId),
    () => store.getSnapshot().get(blockId),
  )
}

/** Subscribe to the whole trust-status map (blockId → status). Used by the
 *  global prompt surface, which needs every pending extension at once rather
 *  than a single row. The store returns a referentially-stable Map between
 *  changes, so this is safe to drive a `useMemo`/`useSyncExternalStore`. */
export const useExtensionApprovalStatuses = (): ExtensionApprovalStatusMap => {
  const store = useStore()
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
