import { describe, expect, it } from 'vitest'
import { actionRefMajor, classifyPackage, parseWorkflowUses, readInventory, refreshCommands } from './deps-report.mjs'

const DAY = 86_400_000
const now = Date.parse('2026-10-24T00:00:00Z')
const week = 7 * DAY
const policy = {now, cooldownMs: week}
const daysAgo = (n: number) => new Date(now - n * DAY).toISOString()

/** A registry document: `time` as given; every version in it is published
 *  unless listed as unpublished, and not deprecated unless listed. */
const packument = (time: Record<string, string>, {deprecated = [] as string[], unpublished = [] as string[]} = {}) => ({
  time,
  versions: Object.fromEntries(
    Object.keys(time)
      .filter(v => v !== 'created' && v !== 'modified' && !unpublished.includes(v))
      .map(v => [v, deprecated.includes(v) ? {deprecated: 'Bad release'} : {}]),
  ),
})

describe('classifyPackage', () => {
  it('picks the newest cooldown-eligible version within the current major', () => {
    const doc = packument({'8.0.10': daysAgo(90), '8.3.4': daysAgo(9), '8.3.5': daysAgo(2)})
    expect(classifyPackage({name: 'vite', current: '8.0.10'}, doc, policy)).toMatchObject({
      sameMajor: {version: '8.3.4'},
      major: null,
      held: {version: '8.3.5', eligibleAt: new Date(Date.parse(daysAgo(2)) + week).toISOString()},
    })
  })

  it('reports an eligible major separately from the same-major target', () => {
    const doc = packument({'7.29.2': daysAgo(200), '7.29.10': daysAgo(10), '8.0.7': daysAgo(16), '8.0.9': daysAgo(1)})
    expect(classifyPackage({name: '@babel/standalone', current: '7.29.2'}, doc, policy)).toMatchObject({
      sameMajor: {version: '7.29.10'},
      major: {version: '8.0.7'},
      held: {version: '8.0.9'},
    })
  })

  it('treats a 0.x minor, and each 0.0.x patch, as its own major line', () => {
    const minors = packument({'0.5.2': daysAgo(100), '0.5.7': daysAgo(30), '0.6.0': daysAgo(20)})
    expect(classifyPackage({name: 'p', current: '0.5.2'}, minors, policy)).toMatchObject({
      sameMajor: {version: '0.5.7'},
      major: {version: '0.6.0'},
      held: null,
    })
    const patches = packument({'0.0.3': daysAgo(100), '0.0.9': daysAgo(30)})
    expect(classifyPackage({name: 'p', current: '0.0.3'}, patches, policy)).toMatchObject({sameMajor: null, major: {version: '0.0.9'}})
  })

  it('never targets a deprecated or unpublished version', () => {
    const doc = packument(
      {'6.9.0': daysAgo(100), '6.9.1': daysAgo(60), '6.10.0': daysAgo(30), '6.11.0': daysAgo(20)},
      {deprecated: ['6.10.0'], unpublished: ['6.11.0']},
    )
    expect(classifyPackage({name: 'jest-dom', current: '6.9.0'}, doc, policy)).toMatchObject({
      sameMajor: {version: '6.9.1'},
      major: null,
      held: null,
    })
  })

  it('skips a published version with no publish time, whose cooldown cannot be judged', () => {
    const doc = {time: {'1.0.0': daysAgo(100), '1.1.0': daysAgo(30)}, versions: {'1.0.0': {}, '1.1.0': {}, '1.2.0': {}}}
    expect(classifyPackage({name: 'p', current: '1.0.0'}, doc, policy)).toMatchObject({sameMajor: {version: '1.1.0'}, held: null})
  })

  it('ignores prereleases and registry bookkeeping keys', () => {
    const doc = packument({created: daysAgo(999), modified: daysAgo(0), '6.0.3': daysAgo(100), '7.1.0-beta': daysAgo(30), '7.0.2': daysAgo(90)})
    expect(classifyPackage({name: 'typescript', current: '6.0.3'}, doc, policy)).toMatchObject({
      sameMajor: null,
      major: {version: '7.0.2'},
      held: null,
    })
  })

  it('orders versions numerically, not lexically', () => {
    const doc = packument({'4.1.5': daysAgo(100), '4.1.12': daysAgo(20), '4.1.9': daysAgo(40)})
    expect(classifyPackage({name: 'vitest', current: '4.1.5'}, doc, policy).sameMajor?.version).toBe('4.1.12')
  })

  it('does not classify a prerelease current version', () => {
    const doc = packument({'7.0.0-dev.20260707.2': daysAgo(100), '7.0.2': daysAgo(90)})
    expect(classifyPackage({name: 'x', current: '7.0.0-dev.20260707.2'}, doc, policy)).toMatchObject({
      prerelease: true,
      sameMajor: null,
      major: null,
    })
  })
})

describe('refreshCommands', () => {
  const row = (name: string, users: string[], target: string | null, extra = {}) =>
    ({name, from: name, users, sameMajor: target ? {version: target} : null, ...extra})

  it('bumps each project separately, so one project never moves another across a major', () => {
    const rows = [
      row('vite', ['app'], '8.3.4'),
      row('semver', ['app'], '6.3.1'),
      row('semver', ['cli', 'dispatch'], '7.8.5'),
      row('typescript', ['app'], null),
    ]
    expect(refreshCommands(rows)).toEqual([
      'pnpm --filter app up vite@8.3.4 semver@6.3.1',
      'pnpm --filter cli up semver@7.8.5',
      'pnpm --filter dispatch up semver@7.8.5',
      'pnpm up -r',
    ])
  })

  it('leaves out aliases and the pinned package manager, which `pnpm up name@version` would mangle', () => {
    const rows = [
      row('typescript-native', ['app'], '7.0.3', {from: 'typescript'}),
      row('pnpm', ['packageManager'], '12.14.1', {packageManager: true}),
      row('vite', ['app'], '8.3.4'),
    ]
    expect(refreshCommands(rows)).toEqual(['pnpm --filter app up vite@8.3.4', 'pnpm up -r'])
  })

  it('always ends with the in-range refresh, which carries transitive fixes', () => {
    expect(refreshCommands([])).toEqual(['pnpm up -r'])
  })

  it('runs in the reported project when it is not the repo root', () => {
    expect(refreshCommands([row('@atproto/api', ['ext'], '0.19.19')], 'agent-extensions/x')).toEqual([
      'pnpm -C agent-extensions/x --filter ext up @atproto/api@0.19.19',
      'pnpm -C agent-extensions/x up -r',
    ])
  })
})

describe('readInventory', () => {
  const dep = (from: string, version: string) => ({from, version, resolved: `https://registry.npmjs.org/${from}/-/x.tgz`, path: 'p'})
  const listing = JSON.stringify([
    {name: 'app', path: '/a', dependencies: {vite: dep('vite', '8.3.4'), 'typescript-native': dep('typescript', '7.0.2')}, devDependencies: {typescript: dep('typescript', '6.0.3')}},
    {name: 'cli', path: '/b', dependencies: {zod: dep('zod', '4.6.7'), app: {from: 'app', version: 'link:..', path: '/a'}}, devDependencies: {typescript: dep('typescript', '6.0.3')}},
  ])

  it('lists every direct dependency once per version, with its registry name and the projects using it', () => {
    expect(readInventory({status: 0, stdout: listing, stderr: ''})).toEqual([
      {name: 'vite', from: 'vite', current: '8.3.4', users: ['app']},
      {name: 'typescript-native', from: 'typescript', current: '7.0.2', users: ['app']},
      {name: 'typescript', from: 'typescript', current: '6.0.3', users: ['app', 'cli']},
      {name: 'zod', from: 'zod', current: '4.6.7', users: ['cli']},
    ])
  })

  it('refuses a command that did not run', () => {
    const error = Object.assign(new Error('spawnSync pnpm ENOENT'), {code: 'ENOENT'})
    expect(() => readInventory({status: null, stdout: '', stderr: '', error})).toThrow(/pnpm ls did not run: spawnSync pnpm ENOENT/)
  })

  it('refuses a failing exit status, with its stderr, even when it printed JSON', () => {
    expect(() => readInventory({status: 1, stdout: '[]', stderr: 'ERR_PNPM_NO_LOCKFILE'})).toThrow(/failed \(exit 1\).*ERR_PNPM_NO_LOCKFILE/)
  })

  it('refuses output that is not a project list', () => {
    expect(() => readInventory({status: 0, stdout: '', stderr: ''})).toThrow(/printed no project list/)
    expect(() => readInventory({status: 0, stdout: '{}', stderr: ''})).toThrow(/printed no project list/)
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

