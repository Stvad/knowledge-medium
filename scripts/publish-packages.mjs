#!/usr/bin/env node

/**
 * Publish workspace packages whose version isn't yet on npm.
 *
 * Model: publish-on-version-change. Run from CI after a green master build
 * (see .github/workflows/publish-packages.yml). For each package below we ask
 * the registry whether its *exact* local version already exists; if it does we
 * skip, otherwise we `npm publish`. This makes the whole thing idempotent — a
 * re-run (or a master push that didn't touch the package) is a safe no-op — and
 * keeps humans in control of version numbers: bump the version in your PR and
 * the merge publishes it, leave it alone and nothing happens.
 *
 * Order matters: agent-cli is agent-dispatch's build-time dependency, so it's
 * listed (and thus published) first.
 *
 * Auth: none in this script. In CI the publish authenticates via npm Trusted
 * Publishing (OIDC) — GitHub's id-token is exchanged with npm automatically, no
 * stored token — and provenance is attached automatically, so we don't pass
 * --provenance (which would also fail a local run outside CI's OIDC env).
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

// Publish order: dependencies before dependents.
const packageDirs = ['packages/agent-cli', 'packages/agent-dispatch']

/** Exact version already on npm? Returns the published version string, or '' if not. */
function publishedVersion(name, version) {
  try {
    return execFileSync('npm', ['view', `${name}@${version}`, 'version'], {
      encoding: 'utf8',
    }).trim()
  } catch (err) {
    // `npm view <name>@<version>` exits with an E404 both when the package
    // doesn't exist yet AND when the name exists but this version was never
    // published — that's the genuine "not published" signal, so return ''.
    // Any OTHER failure (network blip, registry 5xx, auth) must NOT be mistaken
    // for "unpublished": doing so would re-attempt publishing an existing
    // version and fail the job on a 403. Rethrow those so we fail loudly at the
    // cheap check instead of at a doomed `npm publish`.
    const detail = `${err.stdout ?? ''}${err.stderr ?? ''}` || err.message
    if (/E404/.test(detail)) return ''
    throw new Error(`npm view ${name}@${version} failed (not an E404):\n${detail}`)
  }
}

let publishedCount = 0
const failures = []
for (const rel of packageDirs) {
  const dir = join(repoRoot, rel)
  const { name, version } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))

  if (publishedVersion(name, version) === version) {
    console.log(`= ${name}@${version} already on npm — skip`)
    continue
  }

  console.log(`+ publishing ${name}@${version}`)
  // publishConfig in each package.json pins public access + the npm registry;
  // under trusted publishing npm attaches provenance on its own — no flags.
  // Isolate per package so one failure doesn't skip the rest of the list.
  try {
    execFileSync('npm', ['publish'], { cwd: dir, stdio: 'inherit' })
    publishedCount++
  } catch (err) {
    console.error(`✗ failed to publish ${name}@${version}: ${err.message}`)
    failures.push(`${name}@${version}`)
  }
}

console.log(
  publishedCount === 0 && failures.length === 0
    ? 'Nothing to publish — all package versions already on npm.'
    : `Published ${publishedCount} package(s).`,
)

if (failures.length > 0) {
  console.error(`Failed to publish: ${failures.join(', ')}`)
  process.exitCode = 1
}
