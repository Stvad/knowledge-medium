/**
 * Resolves the build's user-facing version from git.
 *
 * Shape: { display, sha, timestamp, commitUrl }
 *   - display:   a monotonic, human-readable id derived from the commit's
 *                committer date, rendered in the *commit's own* timezone
 *                (the offset is stored in the commit, so this is identical
 *                on every build machine) at minute resolution so multiple
 *                builds on the same day disambiguate: e.g. "2026.06.13-1216".
 *   - sha:       short commit SHA the build came from (links to the commit).
 *   - timestamp: committer date as epoch milliseconds — an absolute,
 *                integer-comparable "is the deployed build newer than mine"
 *                value for the update check that comes later.
 *   - commitUrl: canonical GitHub commit URL, or null if origin isn't GitHub.
 *
 * Consumed by vite.config.ts (baked into the bundle via `define` and emitted
 * as dist/version.json). Mirrors the git source-order used by
 * inject-sw-build-id.ts so the displayed version and the SW cache id agree.
 */
import {execFileSync} from 'node:child_process'

// execFile (no shell) with a fixed argv — no interpolation, no injection
// surface. Returns '' on any failure so a non-git checkout degrades to 'dev'.
const git = (args: string[]) => {
  try {
    return execFileSync('git', args, {stdio: ['ignore', 'pipe', 'ignore']})
      .toString()
      .trim()
  } catch {
    return ''
  }
}

export const resolveAppVersion = () => {
  const sha = (process.env.GITHUB_SHA || git(['rev-parse', 'HEAD'])).slice(0, 8) || 'dev'

  // Strict-ISO committer date, already rendered in the committer's timezone,
  // e.g. "2026-06-13T12:16:16+02:00". Slice the wall-clock parts directly so
  // the displayed date/time matches when the commit was made (no tz shift);
  // parse with Date() only for the absolute epoch-ms comparator.
  const iso = git(['show', '-s', '--format=%cI', 'HEAD'])
  const parts = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  const display = parts ? `${parts[1]}.${parts[2]}.${parts[3]}-${parts[4]}${parts[5]}` : 'dev'
  const timestamp = iso ? new Date(iso).getTime() : 0

  // origin can be SSH (git@github.com:Owner/Repo.git) or HTTPS; normalize to
  // the https://github.com/Owner/Repo form, then link to the commit.
  const remote = process.env.GITHUB_REPOSITORY
    ? `https://github.com/${process.env.GITHUB_REPOSITORY}`
    : git(['config', '--get', 'remote.origin.url'])
        .replace(/^git@github\.com:/, 'https://github.com/')
        .replace(/\.git$/, '')
  const commitUrl =
    remote.startsWith('https://github.com/') && sha !== 'dev'
      ? `${remote}/commit/${sha}`
      : null

  return {display, sha, timestamp, commitUrl}
}
