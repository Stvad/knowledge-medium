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

const CLIENT_ID_KEY = 'km:client-id'

let cached: string | undefined

/** The persistent per-installation client id. Synchronous; safe where
 *  `localStorage` is absent (node/SSR/private mode) — it falls back to a
 *  process-stable id so callers within one session still get a single value. */
export const getClientId = (): string => {
  if (cached !== undefined) return cached
  try {
    const existing = globalThis.localStorage?.getItem(CLIENT_ID_KEY)
    if (existing) return (cached = existing)
    const fresh = uuidv4()
    globalThis.localStorage?.setItem(CLIENT_ID_KEY, fresh)
    return (cached = fresh)
  } catch {
    // localStorage threw (private-mode SecurityError, blocked storage) — keep a
    // session-stable id so grouping is still coherent within this run.
    return (cached ??= uuidv4())
  }
}

/** Test helper — drop the in-process cache so the next call re-resolves. */
export const resetClientIdCache = (): void => { cached = undefined }
