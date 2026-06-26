/**
 * The running build's version, baked in at build time by Vite's `define`
 * (see vite.config.ts → resolveAppVersion). Surfaced in the status
 * dropdown and, later, used to detect when a newer build is deployed.
 */
export interface AppVersion {
  /** Monotonic, human-readable build id from the commit's committer date,
   *  minute-resolution so same-day builds disambiguate: "2026.06.13-1216". */
  readonly display: string
  /** Short commit SHA the build came from. */
  readonly sha: string
  /** Committer date as epoch milliseconds — an absolute, integer comparator
   *  for "is the deployed build newer than mine". */
  readonly timestamp: number
  /** Canonical GitHub commit URL, or null if origin isn't GitHub. */
  readonly commitUrl: string | null
}

// `__APP_VERSION__` is replaced with an object literal by Vite's `define`.
// The `typeof` guard keeps this safe where the define wasn't applied — e.g.
// the vitest config (vitest.config.ts) doesn't set it, so tests read `dev`.
export const appVersion: AppVersion =
  typeof __APP_VERSION__ === 'undefined'
    ? {display: 'dev', sha: 'dev', timestamp: 0, commitUrl: null}
    : __APP_VERSION__
