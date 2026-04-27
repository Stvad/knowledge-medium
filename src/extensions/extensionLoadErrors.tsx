import {
  createContext,
  ReactNode,
  useContext,
  useMemo,
  useSyncExternalStore,
} from 'react'

export type ExtensionLoadErrorsMap = ReadonlyMap<string, Error>

/**
 * Plain non-React store for extension load errors. The React provider
 * is a thin wrapper around this so the state machine itself is unit-
 * testable without mounting a component tree.
 */
export class ExtensionLoadErrorStore {
  private errors: ReadonlyMap<string, Error> = new Map()
  private readonly listeners = new Set<() => void>()

  getSnapshot = (): ExtensionLoadErrorsMap => this.errors

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  reportError = (blockId: string, error: Error): void => {
    const next = new Map(this.errors)
    next.set(blockId, error)
    this.errors = next
    this.notify()
  }

  clearError = (blockId: string): void => {
    if (!this.errors.has(blockId)) return
    const next = new Map(this.errors)
    next.delete(blockId)
    this.errors = next
    this.notify()
  }

  reset = (): void => {
    if (this.errors.size === 0) return
    this.errors = new Map()
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
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
