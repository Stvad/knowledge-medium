import { describe, expect, it } from 'vitest'
import { actionRefMajor, classifyPackage, parseEsmShPins, parseWorkflowUses, readOutdated, sameMajorUpCommand } from './deps-report.mjs'

const DAY = 86_400_000
const now = Date.parse('2026-10-24T00:00:00Z')
const week = 7 * DAY
const daysAgo = (n: number) => new Date(now - n * DAY).toISOString()

describe('classifyPackage', () => {
  it('picks the newest cooldown-eligible version within the current major', () => {
    const times = {'8.0.10': daysAgo(90), '8.3.4': daysAgo(9), '8.3.5': daysAgo(2)}
    expect(classifyPackage({name: 'vite', current: '8.0.10'}, times, {now, cooldownMs: week})).toMatchObject({
      sameMajor: {version: '8.3.4'},
      major: null,
      held: {version: '8.3.5', eligibleAt: new Date(Date.parse(daysAgo(2)) + week).toISOString()},
    })
  })

  it('reports an eligible major separately from the same-major target', () => {
    const times = {'7.29.2': daysAgo(200), '7.29.10': daysAgo(10), '8.0.7': daysAgo(16), '8.0.9': daysAgo(1)}
    expect(classifyPackage({name: '@babel/standalone', current: '7.29.2'}, times, {now, cooldownMs: week})).toMatchObject({
      sameMajor: {version: '7.29.10'},
      major: {version: '8.0.7'},
      held: {version: '8.0.9'},
    })
  })

  it('treats a 0.x minor as its own major line', () => {
    const times = {'0.5.2': daysAgo(100), '0.5.7': daysAgo(30), '0.6.0': daysAgo(20)}
    expect(classifyPackage({name: 'p', current: '0.5.2'}, times, {now, cooldownMs: week})).toMatchObject({
      sameMajor: {version: '0.5.7'},
      major: {version: '0.6.0'},
      held: null,
    })
  })

  it('ignores prereleases and registry bookkeeping keys', () => {
    const times = {created: daysAgo(999), modified: daysAgo(0), '6.0.3': daysAgo(100), '7.1.0-beta': daysAgo(30), '7.0.2': daysAgo(90)}
    expect(classifyPackage({name: 'typescript', current: '6.0.3'}, times, {now, cooldownMs: week})).toMatchObject({
      sameMajor: null,
      major: {version: '7.0.2'},
      held: null,
    })
  })

  it('orders versions numerically, not lexically', () => {
    const times = {'4.1.5': daysAgo(100), '4.1.12': daysAgo(20), '4.1.9': daysAgo(40)}
    expect(classifyPackage({name: 'vitest', current: '4.1.5'}, times, {now, cooldownMs: week}).sameMajor?.version).toBe('4.1.12')
  })

  it('does not classify a prerelease current version', () => {
    const times = {'7.0.0-dev.20260707.2': daysAgo(100), '7.0.2': daysAgo(90)}
    expect(classifyPackage({name: 'x', current: '7.0.0-dev.20260707.2'}, times, {now, cooldownMs: week})).toMatchObject({
      prerelease: true,
      sameMajor: null,
      major: null,
    })
  })
})

describe('sameMajorUpCommand', () => {
  it('names every same-major target explicitly, including packages whose next major is held', () => {
    const rows = [
      {name: 'vite', sameMajor: {version: '8.3.4'}, major: null},
      {name: '@babel/standalone', sameMajor: {version: '7.29.10'}, major: {version: '8.0.7'}},
      {name: 'typescript', sameMajor: null, major: {version: '7.0.2'}},
      {name: 'cmdk', sameMajor: {version: '1.1.2'}, major: {version: '2.0.0'}},
    ]
    expect(sameMajorUpCommand(rows as never)).toBe('pnpm up -r vite@8.3.4 @babel/standalone@7.29.10 cmdk@1.1.2')
  })

  it('leaves out the pinned package manager, which is not a dependency', () => {
    const rows = [
      {name: 'vite', sameMajor: {version: '8.3.4'}, major: null},
      {name: 'pnpm', sameMajor: {version: '10.34.7'}, major: null, packageManager: true},
    ]
    expect(sameMajorUpCommand(rows as never)).toBe('pnpm up -r vite@8.3.4')
  })

  it('returns null when nothing qualifies', () => {
    expect(sameMajorUpCommand([])).toBeNull()
  })
})

describe('readOutdated', () => {
  const json = (o: object) => JSON.stringify(o)
  const dependents = [{name: 'app', location: '/x'}]

  it('maps each package to its installed version and dependents', () => {
    const stdout = json({vite: {current: '8.0.10', wanted: '8.0.10', latest: '8.3.5', dependentPackages: dependents}})
    expect(readOutdated({status: 1, stdout, stderr: ''})).toEqual([{name: 'vite', current: '8.0.10', usedBy: 'app'}])
  })

  it('falls back to the locked version before the first install', () => {
    const stdout = json({clsx: {wanted: '2.1.1', latest: '2.1.1', dependentPackages: dependents}})
    expect(readOutdated({status: 0, stdout, stderr: ''})).toEqual([{name: 'clsx', current: '2.1.1', usedBy: 'app'}])
  })

  it('reads an empty successful scan as nothing outdated', () => {
    expect(readOutdated({status: 0, stdout: '', stderr: ''})).toEqual([])
  })

  it('refuses a command that did not run', () => {
    const error = Object.assign(new Error('spawnSync pnpm ENOENT'), {code: 'ENOENT'})
    expect(() => readOutdated({status: null, stdout: '', stderr: '', error})).toThrow(/pnpm outdated did not run: spawnSync pnpm ENOENT/)
  })

  it('refuses a failing exit status, with its stderr, even when it printed JSON', () => {
    expect(() => readOutdated({status: 2, stdout: '{}', stderr: 'ERR_PNPM_NO_LOCKFILE'})).toThrow(/failed \(exit 2\).*ERR_PNPM_NO_LOCKFILE/)
  })

  it('refuses "outdated" with nothing printed, and output that is not JSON', () => {
    expect(() => readOutdated({status: 1, stdout: '', stderr: ''})).toThrow(/printed no JSON/)
    expect(() => readOutdated({status: 1, stdout: 'Scope: all 3 workspace projects', stderr: ''})).toThrow(/printed no JSON/)
  })
})

describe('parseWorkflowUses', () => {
  it('extracts remote actions with their refs, dropping local and docker steps', () => {
    const yml = [
      '      - uses: actions/checkout@v6',
      '        uses: pnpm/action-setup@v4',
      "      - uses: 'actions/cache@v4'",
      '      - uses: github/codeql-action/init@v3',
      '      - uses: ./.github/actions/local',
      '      - uses: docker://alpine:3',
      '      # - uses: actions/old@v1',
    ].join('\n')
    expect(parseWorkflowUses(yml)).toEqual([
      {action: 'actions/checkout', ref: 'v6'},
      {action: 'pnpm/action-setup', ref: 'v4'},
      {action: 'actions/cache', ref: 'v4'},
      {action: 'github/codeql-action', ref: 'v3'},
    ])
  })
})

describe('actionRefMajor', () => {
  it('reads the major from a version tag', () => {
    expect(actionRefMajor('v4')).toBe(4)
    expect(actionRefMajor('v4.1.0')).toBe(4)
    expect(actionRefMajor('6')).toBe(6)
  })

  it('has no major for a commit SHA or a branch', () => {
    expect(actionRefMajor('3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c')).toBeNull()
    expect(actionRefMajor('main')).toBeNull()
  })
})

describe('parseEsmShPins', () => {
  it('finds version-pinned esm.sh imports, scoped or not', () => {
    const src = [
      "import * as sdk from 'https://esm.sh/matrix-js-sdk@38.0.0?bundle'",
      'const x = "https://esm.sh/@scope/pkg@1.2.3/sub/path.js"',
      "fetch('https://esm.sh/unpinned')",
    ].join('\n')
    expect(parseEsmShPins(src)).toEqual([
      {name: 'matrix-js-sdk', version: '38.0.0'},
      {name: '@scope/pkg', version: '1.2.3'},
    ])
  })
})
