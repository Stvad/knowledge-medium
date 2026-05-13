export interface ElectricSyncState {
  connected: boolean
  connecting: boolean
  hasSynced: boolean
  downloading: boolean
  errorMessage: string | null
  lastSyncedAt: Date | undefined
}

const DEFAULT_STATE: ElectricSyncState = {
  connected: false,
  connecting: false,
  hasSynced: false,
  downloading: false,
  errorMessage: null,
  lastSyncedAt: undefined,
}

const statesByUser = new Map<string, ElectricSyncState>()
const listeners = new Set<() => void>()

export const getElectricSyncState = (userId: string): ElectricSyncState =>
  statesByUser.get(userId) ?? DEFAULT_STATE

export const updateElectricSyncState = (
  userId: string,
  patch: Partial<ElectricSyncState>,
): void => {
  statesByUser.set(userId, {
    ...getElectricSyncState(userId),
    ...patch,
  })
  for (const listener of listeners) listener()
}

export const subscribeElectricSyncState = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
