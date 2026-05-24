/** Browser-geolocation wrapper for the geo plugin.
 *
 *  Wraps `navigator.geolocation.getCurrentPosition` with three
 *  improvements over the raw API:
 *    - Promise-shaped instead of callback.
 *    - Distinct error kinds (`'denied' | 'unavailable' | 'timeout'`)
 *      via a typed `CurrentLocationError`, so callers can branch on
 *      kind for the right UX message instead of pattern-matching on
 *      the upstream error code enum.
 *    - Optional `navigator` injection for tests — defaults to the
 *      browser global. No app-side permission storage; the browser is
 *      the source of truth.
 *
 *  We do NOT cache coords here. Phase F UX wants a fresh fix per pick
 *  session (user might have moved); caching a stale fix would silently
 *  pin to the wrong spot. */

const DEFAULT_TIMEOUT_MS = 10_000

export interface CurrentLocation {
  lat: number
  lng: number
  /** Accuracy radius in meters at 68% confidence (per the W3C spec). */
  accuracy: number
}

export type CurrentLocationErrorKind =
  | 'denied'
  | 'unavailable'
  | 'timeout'
  | 'unsupported'

export class CurrentLocationError extends Error {
  constructor(public readonly kind: CurrentLocationErrorKind, message: string) {
    super(message)
    this.name = 'CurrentLocationError'
  }
}

export interface GetCurrentPositionOptions {
  timeoutMs?: number
  /** Override `navigator` (for tests). Defaults to the global. */
  navigator?: Partial<Navigator>
}

const kindFor = (code: number): CurrentLocationErrorKind => {
  // Codes per the W3C Geolocation spec.
  if (code === 1) return 'denied'
  if (code === 2) return 'unavailable'
  if (code === 3) return 'timeout'
  return 'unavailable'
}

export const getCurrentPosition = (
  options: GetCurrentPositionOptions = {},
): Promise<CurrentLocation> => {
  const nav = options.navigator ?? (typeof navigator !== 'undefined' ? navigator : undefined)
  const geo = nav?.geolocation
  if (!geo) {
    return Promise.reject(new CurrentLocationError(
      'unsupported',
      'Geolocation is not available in this environment',
    ))
  }
  return new Promise((resolve, reject) => {
    geo.getCurrentPosition(
      (pos) => resolve({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      }),
      (err) => reject(new CurrentLocationError(
        kindFor(err.code),
        err.message || 'Geolocation failed',
      )),
      {
        enableHighAccuracy: true,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      },
    )
  })
}
