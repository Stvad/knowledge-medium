import {
  createContext,
  ReactNode,
  useContext,
  useMemo,
  useSyncExternalStore,
} from 'react'
import { BatchableKeyedStore } from '@/extensions/batchableKeyedStore.js'
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
export class ExtensionApprovalStatusStore extends BatchableKeyedStore<ExtensionApprovalStatus> {
  constructor() {
    super('ExtensionApprovalStatus')
  }

  report = (blockId: string, status: ExtensionApprovalStatus): void =>
    this.set(blockId, status)

  clear = (blockId: string): void => this.delete(blockId)
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
