/**
 * A stable identifier for *this browser/device installation* — a random id
 * minted once and persisted in `localStorage`, so it survives reloads but is
 * distinct per browser profile and per device (two Chrome profiles on one
 * machine get different ids; clearing site data mints a fresh one).
 *
 * This is the app-level "which client am I" notion used to group per-device
 * telemetry (e.g. startup-metrics records). It is deliberately NOT:
 *   - PowerSync's `getClientId()` (async, ps_kv-backed sync-client identity), nor
 *   - the agent-runtime bridge's ephemeral per-process id (regenerated each load).
 */

import { v4 as uuidv4 } from 'uuid'
import { isInstalledAppDisplayMode } from './layoutSessionId.js'

const CLIENT_ID_KEY = 'km:client-id'

let cached: string | undefined
let cachedIsPersistent = false

/** The persistent per-installation client id. Synchronous; safe where
 *  `localStorage` is absent (node/SSR/private mode) — it falls back to a
 *  process-stable id so callers within one session still get a single value. */
export const getClientId = (): string => {
  if (cached !== undefined) return cached
  try {
    const store = globalThis.localStorage
    if (!store) {
      // No storage API at all — Node/SSR/tests. There is no reload here to
      // survive, so the question `isClientIdPersistent` answers is moot and a
      // process-stable id is the honest answer. A real browser always DEFINES
      // localStorage; when access is blocked it throws (below) rather than
      // being absent, so this branch cannot mask the case that matters.
      cachedIsPersistent = true
      return (cached = uuidv4())
    }
    const existing = store.getItem(CLIENT_ID_KEY)
    if (existing) {
      cachedIsPersistent = true
      return (cached = existing)
    }
    const fresh = uuidv4()
    store.setItem(CLIENT_ID_KEY, fresh)
    // Read back rather than assume: a quota-full or partitioned store can
    // accept the call and keep nothing.
    cachedIsPersistent = store.getItem(CLIENT_ID_KEY) === fresh
    return (cached = fresh)
  } catch {
    // localStorage threw (private-mode SecurityError, blocked storage) — keep a
    // session-stable id so grouping is still coherent within this run, but it
    // will NOT survive a reload.
    return (cached ??= uuidv4())
  }
}

/** Test helper — drop the in-process cache so the next call re-resolves. */
export const resetClientIdCache = (): void => { cached = undefined; cachedIsPersistent = false }

/** Whether `getClientId()` survives a reload.
 *
 *  False in blocked-storage environments (private mode, a browser with site
 *  data disabled), where the id falls back to a per-process value. Anything
 *  keyed on the client id across sessions MUST check this: with a fresh id each
 *  load, per-client history is written where the next session will never look
 *  for it — accumulating groups nothing can read, forever. */
export const isClientIdPersistent = (): boolean => {
  getClientId()
  return cachedIsPersistent
}

/** Coarse device/surface label used to GROUP per-device telemetry — e.g.
 *  `installed:MacIntel`. Deliberately coarse: it is a grouping key for
 *  comparing a series against itself, not a fingerprint, so a bounded set of
 *  values is a feature. The `navigator.platform` fallback to a userAgent prefix
 *  exists only because the former is deprecated and may be empty. */
export const getDeviceLabel = (): string => {
  const surface = isInstalledAppDisplayMode() ? 'installed' : 'browser'
  if (typeof navigator === 'undefined') return `${surface}:unknown`
  const platform = navigator.platform || navigator.userAgent.slice(0, 40)
  return `${surface}:${platform}`
}
