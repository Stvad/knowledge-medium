import { v4 as uuidv4 } from 'uuid'

export const BROWSER_LAYOUT_SESSION_ID_STORAGE_KEY = 'ws-nav.layoutSessionId'
export const INSTALLED_APP_LAYOUT_SESSION_ID_STORAGE_KEY = 'ws-nav.installedAppLayoutSessionId'

let memoizedLayoutSessionId: string | null = null

export interface LayoutSessionIdStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const readOrCreateLayoutSessionId = (
  storage: LayoutSessionIdStorage,
  key: string,
  makeId: () => string = uuidv4,
): string => {
  const stored = storage.getItem(key)
  if (stored) return stored
  const generated = makeId()
  storage.setItem(key, generated)
  return generated
}

const INSTALLED_APP_DISPLAY_MODES = ['standalone', 'minimal-ui', 'fullscreen', 'window-controls-overlay'] as const

export const isInstalledAppDisplayMode = (): boolean => {
  if (typeof window === 'undefined') return false
  const navigatorWithStandalone = window.navigator as Navigator & {standalone?: boolean}
  if (navigatorWithStandalone.standalone === true) return true
  if (typeof window.matchMedia !== 'function') return false
  return INSTALLED_APP_DISPLAY_MODES.some(mode =>
    window.matchMedia(`(display-mode: ${mode})`).matches,
  )
}

interface LayoutSessionStorageTarget {
  storage: Storage
  key: string
}

const getLayoutSessionStorageTarget = (): LayoutSessionStorageTarget | null => {
  if (typeof window === 'undefined') return null
  try {
    if (isInstalledAppDisplayMode()) {
      return {
        storage: window.localStorage,
        key: INSTALLED_APP_LAYOUT_SESSION_ID_STORAGE_KEY,
      }
    }
    return {
      storage: window.sessionStorage,
      key: BROWSER_LAYOUT_SESSION_ID_STORAGE_KEY,
    }
  } catch {
    return null
  }
}

/** The per-device BASE layout-session id — a boot-time seed, not "the
 *  session the user is looking at" (those can diverge once the
 *  perspectives host lands). Only the boot seed may bind to it directly.
 *
 *  `src/utils/test/layoutSessionId.test.ts` is in the allowlist too: it
 *  pins THIS function's own storage-target selection + memoization (the
 *  seed's mechanics), which no other file exercises — not a "call
 *  getLayoutSessionId instead of the injected channel" case the rule is
 *  otherwise guarding against.
 *
 *  @ambient allowIn: src/utils/layoutSessionId.ts, src/data/repo.ts, src/bootstrap/workspaceBootstrap.ts, src/utils/test/layoutSessionId.test.ts
 *  @ambientMessage getLayoutSessionId is the per-device base id (boot seed only). Use repo.activeLayoutSessionId in imperative code, or the layoutSessionBlockId block context in the render tree (PR 2).
 */
export const getLayoutSessionId = (): string => {
  if (memoizedLayoutSessionId) return memoizedLayoutSessionId
  const target = getLayoutSessionStorageTarget()
  if (!target) {
    memoizedLayoutSessionId = uuidv4()
    return memoizedLayoutSessionId
  }
  try {
    memoizedLayoutSessionId = readOrCreateLayoutSessionId(target.storage, target.key)
  } catch {
    memoizedLayoutSessionId = uuidv4()
  }
  return memoizedLayoutSessionId
}

export const __resetLayoutSessionIdForTesting = (): void => {
  memoizedLayoutSessionId = null
}
