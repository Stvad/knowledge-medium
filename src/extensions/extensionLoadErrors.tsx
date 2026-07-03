import {
  createContext,
  ReactNode,
  useContext,
  useMemo,
  useSyncExternalStore,
} from 'react'
import { CallbackSet } from '@/utils/callbackSet'

export type ExtensionLoadErrorsMap = ReadonlyMap<string, Error>

/**
 * Plain non-React store for extension load errors. The React provider
 * is a thin wrapper around this so the state machine itself is unit-
 * testable without mounting a component tree.
 */
export class ExtensionLoadErrorStore {
  private errors: ReadonlyMap<string, Error> = new Map()
  // When non-null a batch is open: reportError/clearError buffer into it and
  // DON'T notify; commitBatch swaps it in as a single old→new transition.
  // Used by the runtime resolve so a re-resolve publishes atomically instead
  // of reset→dribble, which briefly blanked the map and blinked the row
  // status icons.
  private batch: Map<string, Error> | null = null
  private readonly listeners = new CallbackSet<[]>('ExtensionLoadErrors')

  getSnapshot = (): ExtensionLoadErrorsMap => this.errors

  subscribe = (listener: () => void): (() => void) => this.listeners.add(listener)

  /** Open a batch. Subsequent reportError/clearError buffer without notifying
   *  until commitBatch. The buffer starts EMPTY (like reset()) and is rebuilt
   *  from this resolve's reports. Discards any in-progress batch. */
  beginBatch = (): void => {
    this.batch = new Map()
  }

  /** Publish the buffered batch as ONE notification. No-op if none open. */
  commitBatch = (): void => {
    if (this.batch === null) return
    this.errors = this.batch
    this.batch = null
    this.listeners.notify()
  }

  /** Drop the buffer without publishing (cancelled / errored resolve). */
  abandonBatch = (): void => {
    this.batch = null
  }

  reportError = (blockId: string, error: Error): void => {
    if (this.batch !== null) {
      this.batch.set(blockId, error)
      return
    }
    const next = new Map(this.errors)
    next.set(blockId, error)
    this.errors = next
    this.listeners.notify()
  }

  clearError = (blockId: string): void => {
    if (this.batch !== null) {
      this.batch.delete(blockId)
      return
    }
    if (!this.errors.has(blockId)) return
    const next = new Map(this.errors)
    next.delete(blockId)
    this.errors = next
    this.listeners.notify()
  }

  reset = (): void => {
    this.batch = null
    if (this.errors.size === 0) return
    this.errors = new Map()
    this.listeners.notify()
  }
}

interface ExtensionLoadErrorsContextValue {
  store: ExtensionLoadErrorStore
}

const noopStore = new ExtensionLoadErrorStore()

const ExtensionLoadErrorsContext = createContext<ExtensionLoadErrorsContextValue>({
  store: noopStore,
})

export const ExtensionLoadErrorsProvider = ({
  children,
  store,
}: {
  children: ReactNode
  store?: ExtensionLoadErrorStore
}) => {
  const ownStore = useMemo(() => store ?? new ExtensionLoadErrorStore(), [store])
  const value = useMemo(() => ({store: ownStore}), [ownStore])

  return (
    <ExtensionLoadErrorsContext.Provider value={value}>
      {children}
    </ExtensionLoadErrorsContext.Provider>
  )
}

const useExtensionLoadErrorsStore = (): ExtensionLoadErrorStore =>
  useContext(ExtensionLoadErrorsContext).store

export const useExtensionLoadErrors = (): {
  errors: ExtensionLoadErrorsMap
  reportError: (blockId: string, error: Error) => void
  clearError: (blockId: string) => void
  reset: () => void
} => {
  const store = useExtensionLoadErrorsStore()
  const errors = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  return {
    errors,
    reportError: store.reportError,
    clearError: store.clearError,
    reset: store.reset,
  }
}

export const useExtensionLoadError = (blockId: string): Error | undefined => {
  const store = useExtensionLoadErrorsStore()
  return useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().get(blockId),
    () => store.getSnapshot().get(blockId),
  )
}
