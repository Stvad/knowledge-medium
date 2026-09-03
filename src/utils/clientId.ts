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

/** OS family from a user agent, for when `navigator.platform` is empty.
 *
 *  A FAMILY, never the agent string itself: a label must be stable for the life
 *  of an installation. Version numbers live in the user agent, so a prefix of
 *  it changes on every OS or browser upgrade — and since a series is selected
 *  by exact label, that both orphans the existing baseline and puts the old
 *  rows beyond retention's reach, where they accumulate with nothing able to
 *  prune them. */
const platformFamily = (userAgent: string): string =>
  /android/i.test(userAgent) ? 'Android'
    : /iphone|ipad|ipod/i.test(userAgent) ? 'iOS'
      : /mac os|macintosh/i.test(userAgent) ? 'macOS'
        : /windows/i.test(userAgent) ? 'Windows'
          : /linux|x11/i.test(userAgent) ? 'Linux'
            : 'unknown'

/** Coarse device/surface label used to GROUP per-device telemetry — e.g.
 *  `installed:MacIntel`. Deliberately coarse: it is a grouping key for
 *  comparing a series against itself, not a fingerprint, so a bounded set of
 *  values is a feature — and a STABLE one, since the label selects the series.
 *  `navigator.platform` is deprecated and may be empty, hence the family
 *  fallback. */
export const getDeviceLabel = (): string => {
  if (typeof navigator === 'undefined') return `${deviceSurface()}:unknown`
  return `${deviceSurface()}:${navigator.platform || platformFamily(navigator.userAgent)}`
}

/** The half of `getDeviceLabel` that SELECTS a series.
 *
 *  One browser profile resolves the same client id installed as a PWA and as an
 *  ordinary tab, and their timings are not comparable — that is the whole job
 *  the label does, and this is the part of it that does the job. The platform
 *  half is descriptive: it distinguishes two browsers in a tree for a human
 *  reading it, and it CHANGES — `navigator.platform` is deprecated and may
 *  start returning empty on a browser upgrade, at which point a query matching
 *  the whole label stops recognising every record written before it. */
export const deviceSurface = (): 'installed' | 'browser' =>
  isInstalledAppDisplayMode() ? 'installed' : 'browser'
