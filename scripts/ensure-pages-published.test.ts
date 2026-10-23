import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SCRIPT = resolve(import.meta.dirname, 'ensure-pages-published.sh')

let root: string

// Fake curl: the live site never serves our sha, /pages/builds/latest answers
// with $BUILD_FIXTURE, and a rebuild POST is recorded in $POST_LOG.
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ensure-pages-published-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'curl'), `#!/bin/sh
case "$*" in
  *"-X POST"*) echo POST >> "$POST_LOG" ;;
  *pages/builds/latest*) cat "$BUILD_FIXTURE" ;;
  *version.json*) echo '{"sha":"older"}' ;;
esac
`)
  writeFileSync(join(bin, 'sleep'), '#!/bin/sh\n')
  for (const tool of ['curl', 'sleep']) chmodSync(join(bin, tool), 0o755)
  mkdirSync(join(root, 'dist'))
  writeFileSync(join(root, 'dist', 'version.json'), JSON.stringify({ sha: 'wanted' }))
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

const startedAgo = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

/** Runs the script for one retry round against the given latest-build answer; true if it requested a rebuild. */
function requestsRebuild(latestBuild: string): boolean {
  const fixture = join(root, 'build.json')
  const postLog = join(root, 'posts.log')
  writeFileSync(fixture, latestBuild)
  rmSync(postLog, { force: true })
  const run = spawnSync('bash', [SCRIPT], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(root, 'bin')}:${process.env.PATH}`,
      GH_TOKEN: 'token', GITHUB_REPOSITORY: 'owner/repo', APP_BASE_PATH: '/repo/',
      PAGES_PUBLISH_ROUNDS: '2', PAGES_PUBLISH_POLLS: '1',
      BUILD_FIXTURE: fixture, POST_LOG: postLog,
    },
  })
  expect(run.stdout).toContain('did not serve sha wanted')
  return existsSync(postLog) && readFileSync(postLog, 'utf8').includes('POST')
}

const build = (status: string, ageSeconds: number) => JSON.stringify({ status, created_at: startedAgo(ageSeconds) })

// Each case runs the real script: bash plus a few python3 starts (~500ms alone).
describe('ensure-pages-published retry', { timeout: 20_000 }, () => {
  it.each(['queued', 'building'])('waits on a %s build instead of cancelling it', status => {
    expect(requestsRebuild(build(status, 60))).toBe(false)
  })

  it('replaces a build that has been in flight past the stall threshold', () => {
    expect(requestsRebuild(build('building', 20 * 60))).toBe(true)
  })

  it.each(['built', 'errored'])('requests a rebuild when the latest build is %s', status => {
    expect(requestsRebuild(build(status, 60))).toBe(true)
  })

  it('requests a rebuild when the latest build cannot be read', () => {
    expect(requestsRebuild('not json')).toBe(true)
  })
})
