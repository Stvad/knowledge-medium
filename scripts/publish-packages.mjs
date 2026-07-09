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
 * Auth: expects a non-interactive npm token in the environment (NODE_AUTH_TOKEN,
 * as written by actions/setup-node's registry-url). An automation token — not a
 * plain publish token — is required so the 2FA-protected account can publish
 * headlessly.
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
  } catch {
    // `npm view` exits non-zero when the package name doesn't exist yet (E404);
    // an existing name with a missing version instead returns '' at exit 0.
    // Both mean "not published".
    return ''
  }
}

let publishedCount = 0
for (const rel of packageDirs) {
  const dir = join(repoRoot, rel)
  const { name, version } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))

  if (publishedVersion(name, version) === version) {
    console.log(`= ${name}@${version} already on npm — skip`)
    continue
  }

  console.log(`+ publishing ${name}@${version}`)
  // publishConfig in each package.json pins public access + the npm registry;
  // --provenance attaches a signed build attestation (public repo + id-token).
  execFileSync('npm', ['publish', '--provenance', '--access', 'public'], {
    cwd: dir,
    stdio: 'inherit',
  })
  publishedCount++
}

console.log(
  publishedCount === 0
    ? 'Nothing to publish — all package versions already on npm.'
    : `Published ${publishedCount} package(s).`,
)
