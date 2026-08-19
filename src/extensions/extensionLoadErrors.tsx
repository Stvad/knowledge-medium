import {
  createContext,
  ReactNode,
  useContext,
  useMemo,
  useSyncExternalStore,
} from 'react'
import { BatchableKeyedStore } from '@/extensions/batchableKeyedStore.js'

export type ExtensionLoadErrorsMap = ReadonlyMap<string, Error>

/**
 * Plain non-React store for extension load errors. The React provider
 * is a thin wrapper around this so the state machine itself is unit-
 * testable without mounting a component tree. Batch mode (used by the
 * runtime resolve to publish atomically) lives in the shared base.
 */
export class ExtensionLoadErrorStore extends BatchableKeyedStore<Error> {
  constructor() {
    super('ExtensionLoadErrors')
  }

  reportError = (blockId: string, error: Error): void => this.set(blockId, error)

  clearError = (blockId: string): void => this.delete(blockId)
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
