/**
 * The archive-service seam.
 *
 * Everything above this file talks about "submit a URL, later learn where the
 * copy lives". Nothing above it knows about the Wayback Machine. Swapping in
 * archive.today, a self-hosted ArchiveBox, or a stub for tests is a matter of
 * contributing another `ArchiveService` to `archiveServicesFacet` and pointing
 * `webarchive:serviceId` at it.
 *
 * `submit` and `resolve` are deliberately separate calls. In a browser the
 * save endpoints of real archives are either cross-origin-opaque or
 * asynchronous (the service crawls the page after accepting the request), so
 * "the request resolved" is NOT "the page is archived". Conflating them would
 * make us write an archive URL we have never seen. `resolve` is the only
 * thing that may promote a record to `archived`, and it does so by reading
 * the snapshot back.
 */

import { keyedMapFacet } from '@/facets/facet.js'

export interface ArchiveSubmission {
  /** True when the service accepted the request. NOT a claim that the page is
   *  archived — only `resolve` can establish that. */
  readonly accepted: boolean
  /** Present only when the service returned a snapshot URL synchronously and
   *  we actually read it. Never synthesized. */
  readonly archiveUrl?: string
}

export interface ArchiveService {
  readonly id: string
  readonly label: string
  /** Where the archived copies live. Fed into the URL policy as a loop guard
   *  so an archive link inside a record we wrote is never itself submitted. */
  readonly hosts: readonly string[]
  /** Human-readable note rendered in settings — who the user is trusting. */
  readonly privacyNote: string
  submit(url: string, signal?: AbortSignal): Promise<ArchiveSubmission>
  /** Look for a snapshot taken at or after `notBefore`. Returns the snapshot
   *  URL when one exists, `undefined` while the service is still working.
   *  Throwing means "the check failed", which is retried; `undefined` means
   *  "not there yet", which is also retried but is not an error. */
  resolve(url: string, notBefore: Date, signal?: AbortSignal): Promise<string | undefined>
}

export const archiveServicesFacet = keyedMapFacet<ArchiveService>(
  'web-archive.services',
  service => service.id,
)

// ──── Wayback Machine ────

export const WAYBACK_SERVICE_ID = 'web.archive.org'

/** Save Page Now 2 credentials. Read from configuration, never committed and
 *  never logged — `archive.org/account/s3.php` issues them. Without them the
 *  plugin falls back to the unauthenticated save endpoint, which still works
 *  but tells us nothing about the outcome (see `submit`). */
export interface SpnCredentials {
  readonly accessKey: string
  readonly secretKey: string
}

export const readSpnCredentialsFromEnv = (): SpnCredentials | undefined => {
  const accessKey = import.meta.env.VITE_WEB_ARCHIVE_SPN_ACCESS_KEY?.trim()
  const secretKey = import.meta.env.VITE_WEB_ARCHIVE_SPN_SECRET_KEY?.trim()
  if (!accessKey || !secretKey) return undefined
  return {accessKey, secretKey}
}

/** Wayback timestamps are `YYYYMMDDhhmmss` in UTC. */
export const waybackTimestamp = (date: Date): string =>
  date.toISOString().replace(/[-:T]/g, '').slice(0, 14)

export const parseWaybackTimestamp = (raw: string): Date | undefined => {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(raw)
  if (!match) return undefined
  const [, y, mo, d, h, mi, s] = match
  const date = new Date(Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!))
  return Number.isNaN(date.getTime()) ? undefined : date
}

interface AvailabilityResponse {
  archived_snapshots?: {
    closest?: {available?: boolean; url?: string; timestamp?: string}
  }
}

export interface WaybackServiceOptions {
  /** Injected so tests never touch the network and the credential lookup
   *  stays out of module scope. */
  readonly fetchImpl?: typeof fetch
  readonly credentials?: SpnCredentials | undefined
}

export const createWaybackService = (
  options: WaybackServiceOptions = {},
): ArchiveService => {
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const credentials = options.credentials

  const submitAuthenticated = async (
    url: string,
    creds: SpnCredentials,
    signal?: AbortSignal,
  ): Promise<ArchiveSubmission> => {
    const response = await doFetch('https://web.archive.org/save', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Authorization': `LOW ${creds.accessKey}:${creds.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({url}).toString(),
      signal,
    })
    if (!response.ok) {
      // Deliberately no response body in the message: an auth failure body
      // from SPN can echo the access key back.
      throw new Error(`Save Page Now returned ${response.status}`)
    }
    const body = await response.json() as {job_id?: string; message?: string}
    if (!body.job_id) {
      throw new Error(body.message ?? 'Save Page Now did not start a job')
    }
    // The job is queued, not finished. `resolve` promotes it once the
    // snapshot is readable.
    return {accepted: true}
  }

  const submitAnonymous = async (
    url: string,
    signal?: AbortSignal,
  ): Promise<ArchiveSubmission> => {
    // No credentials → the plain save endpoint. It sends no CORS headers, so
    // `no-cors` is the only way the request leaves the browser at all, and it
    // makes the response opaque: status is always 0 and the body unreadable.
    // A resolved promise therefore means "the request was dispatched", which
    // is exactly what `accepted` claims and no more. The archive URL comes
    // from `resolve`.
    await doFetch(`https://web.archive.org/save/${url}`, {
      method: 'GET',
      mode: 'no-cors',
      redirect: 'follow',
      signal,
    })
    return {accepted: true}
  }

  return {
    id: WAYBACK_SERVICE_ID,
    label: 'Internet Archive (Wayback Machine)',
    hosts: ['web.archive.org', 'archive.org'],
    privacyNote:
      'Submitted URLs become part of the Internet Archive\'s public record, ' +
      'including the fact that they were submitted at this time.',

    submit: (url, signal) =>
      credentials
        ? submitAuthenticated(url, credentials, signal)
        : submitAnonymous(url, signal),

    resolve: async (url, notBefore, signal) => {
      // The availability API is a public, CORS-enabled JSON endpoint — unlike
      // the save endpoint, we can actually read this one, which is what makes
      // a *verified* archive URL possible.
      const query = new URLSearchParams({
        url,
        timestamp: waybackTimestamp(notBefore),
      })
      const response = await doFetch(
        `https://archive.org/wayback/available?${query.toString()}`,
        {method: 'GET', headers: {'Accept': 'application/json'}, signal},
      )
      if (!response.ok) throw new Error(`Availability check returned ${response.status}`)

      const body = await response.json() as AvailabilityResponse
      const closest = body.archived_snapshots?.closest
      if (!closest?.available || !closest.url || !closest.timestamp) return undefined

      const takenAt = parseWaybackTimestamp(closest.timestamp)
      // "Closest" can be a snapshot from years ago. Reporting that as the
      // result of *this* submission would be a lie with a plausible-looking
      // URL attached, so an older snapshot counts as "not yet".
      if (!takenAt || takenAt.getTime() < notBefore.getTime() - RESOLVE_CLOCK_SKEW_MS) {
        return undefined
      }
      // The API answers over http for historical reasons.
      return closest.url.replace(/^http:\/\//, 'https://')
    },
  }
}

/** Wayback stamps a snapshot with its own clock; allow a minute of drift
 *  before deciding a snapshot predates our submission. */
const RESOLVE_CLOCK_SKEW_MS = 60_000

export const waybackArchiveService = createWaybackService({
  credentials: readSpnCredentialsFromEnv(),
})
