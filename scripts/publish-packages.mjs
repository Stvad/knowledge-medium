#!/usr/bin/env node

/**
 * Publish workspace packages whose version isn't yet on npm.
 *
 * Model: publish-on-version-change. Run from CI after a green master build
 * (see .github/workflows/publish-packages.yml). For each package below we ask
 * the registry whether its *exact* local version already exists; if it does we
 * skip, otherwise we publish. This makes the whole thing idempotent — a
 * re-run (or a master push that didn't touch the package) is a safe no-op — and
 * keeps humans in control of version numbers: bump the version in your PR and
 * the merge publishes it, leave it alone and nothing happens.
 *
 * Two modes, one per publish-workflow job — split for OIDC supply-chain
 * isolation (see the workflow file's top comment):
 *
 *   --pack     Runs in the `build` job (full `pnpm install`, workspace links
 *              live, no id-token). For each package, `pnpm pack`s it to
 *              packed/<dir-basename>.tgz. This is where the workspace:
 *              protocol is load-bearing: in-workspace deps are declared with
 *              it (agent-dispatch -> agent-cli is workspace:^), and `pnpm
 *              pack` rewrites that to a concrete semver range
 *              (workspace:^ -> ^<version>) in the tarball's manifest — see
 *              the comment in pnpm-workspace.yaml. Plain `npm pack`/`npm
 *              publish` would ship the literal "workspace:^" string, which is
 *              unresolvable for consumers outside this workspace.
 *
 *   --publish  Runs in the `publish` job (id-token: write, no install — see
 *              the workflow file). For each expected tarball, in order, this
 *              reads the *tarball's* embedded name@version (already-resolved
 *              static content — no workspace protocol left to resolve) and
 *              asks the registry whether it's already published; if not, it
 *              publishes that tarball directly with `npm publish`. Because a
 *              tarball needs no workspace resolution, this mode runs zero
 *              pnpm workspace operations — the isolation invariant this
 *              split exists for.
 *
 * Order matters, twice over: agent-cli is agent-dispatch's build-time
 * dependency, so it's listed (and thus packed/published) first; and because
 * agent-dispatch's workspace:^ dep on agent-cli gets rewritten to a concrete
 * ^<version> range at pack time, a failed agent-cli publish must stop the
 * --publish run rather than let agent-dispatch publish next and ship a
 * dependency range pointing at a version that never landed. See the loop
 * below.
 *
 * Auth: none in this script. In CI the publish authenticates via npm Trusted
 * Publishing (OIDC) — GitHub's id-token is exchanged with npm automatically, no
 * stored token — and provenance is attached automatically, so we don't pass
 * --provenance (which would also fail a local run outside CI's OIDC env).
 *
 * Prebuilt: the workflow's build job compiles each package's dist before
 * packing it, so --publish never rebuilds. `npm publish --ignore-scripts`
 * both skips prepublishOnly (there's no toolchain in the publish job to
 * rebuild) and keeps any third-party lifecycle script away from the OIDC
 * token.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const packedDir = join(repoRoot, 'packed')

// Publish order: dependencies before dependents.
const packageDirs = ['packages/agent-cli', 'packages/agent-dispatch']

/** Where --pack writes, and --publish reads, package `rel`'s tarball. */
function tarballFor(rel) {
  return join(packedDir, `${basename(rel)}.tgz`)
}

/** name/version embedded in a packed tarball's package.json (post workspace: rewrite). */
function readTarballManifest(tarball) {
  const json = execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' })
  return JSON.parse(json)
}

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

const mode = process.argv[2]
if (mode !== '--pack' && mode !== '--publish') {
  console.error('Usage: publish-packages.mjs --pack | --publish')
  process.exit(1)
}

if (mode === '--pack') {
  for (const rel of packageDirs) {
    const dir = join(repoRoot, rel)
    const { name, version } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const out = tarballFor(rel)
    console.log(`packing ${name}@${version} -> ${out}`)
    // pnpm (not npm) packs: this is the step that rewrites workspace:^ to a
    // concrete semver range in the tarball's manifest (module comment above).
    execFileSync('pnpm', ['pack', '--out', out], { cwd: dir, stdio: 'inherit' })
  }
  process.exit(0)
}

// --publish
let publishedCount = 0
const failures = []
for (let i = 0; i < packageDirs.length; i++) {
  const rel = packageDirs[i]
  const tarball = tarballFor(rel)
  const { name, version } = readTarballManifest(tarball)

  if (publishedVersion(name, version) === version) {
    console.log(`= ${name}@${version} already on npm — skip`)
    continue
  }

  console.log(`+ publishing ${name}@${version}`)
  // publishConfig in each package.json (preserved in the tarball's manifest)
  // pins public access + the npm registry; under trusted publishing
  // provenance is attached on its own — no flags needed for either.
  // --ignore-scripts: dist is prebuilt (see the module comment above). No
  // --no-git-checks equivalent needed: that was a pnpm-only guard against its
  // own git-branch check; plain npm publish has no such check to suppress.
  try {
    execFileSync('npm', ['publish', tarball, '--ignore-scripts'], { stdio: 'inherit' })
    publishedCount++
  } catch (err) {
    console.error(`✗ failed to publish ${name}@${version}: ${err.message}`)
    failures.push(`${name}@${version}`)
    // Fail-fast, on purpose: NOT per-package isolation anymore. Once
    // workspace:^ rewriting is in play (module comment above), a later
    // package's published manifest can point at an earlier package's
    // version, so publishing it after an earlier failure would ship a
    // dependency range on a version that never landed. Stop here instead of
    // isolating and continuing.
    const skipped = packageDirs.slice(i + 1).map(skippedRel => {
      const m = readTarballManifest(tarballFor(skippedRel))
      return `${m.name}@${m.version}`
    })
    if (skipped.length > 0) {
      console.error(`✗ stopping — skipping remaining package(s) queued after the failure: ${skipped.join(', ')}`)
    }
    break
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
