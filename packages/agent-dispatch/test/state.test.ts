import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import {parseConfig} from '../src/config'
import {createStateStore} from '../src/state'

const mixedWatchers = parseConfig({workspaceId: 'ws-test', watchers: [
  {kind: 'query', name: 'plain', sql: 'SELECT id FROM blocks'},
  {kind: 'query', name: 'rows', sql: 'SELECT id FROM blocks', rowTasks: true},
]}).watchers

let dir: string
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-dispatch-state-'))
})
afterAll(async () => {
  await fs.rm(dir, {recursive: true, force: true})
})

describe('state store', () => {
  it('round-trips backlink baselines across store instances (daemon restarts)', async () => {
    const file = path.join(dir, 'state.json')
    const store = createStateStore(file)
    expect(await store.getBaseline('mentions')).toBeNull()

    await store.setBaseline('mentions', 123)
    expect(await store.getBaseline('mentions')).toBe(123)
    // A fresh store over the same file (restart) sees the baseline —
    // otherwise every restart would re-baseline and drop queued mentions.
    expect(await createStateStore(file).getBaseline('mentions')).toBe(123)
  })

  it('preserves pending columns and the baseline beside overlapping budget writes', async () => {
    const file = path.join(dir, 'row-tasks.json')
    const store = createStateStore(file)
    const snapshot = {baselineIds: ['old'], pending: [{id: 'new', tag: 'sample', count: 2, extra: null}]}
    await Promise.all([store.setRowTasks('watcher', snapshot), store.setLaunchTimes([42])])
    const restarted = createStateStore(file)
    expect(await restarted.getRowTasks('watcher')).toEqual(snapshot)
    expect(await restarted.getLaunchTimes()).toEqual([42])
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
  })

  it('loads a pre-baseline state file (missing key) as never-seen', async () => {
    const file = path.join(dir, 'legacy.json')
    await fs.writeFile(file, JSON.stringify({queryCursors: {q: ['a']}, launchTimes: [1]}))
    const store = createStateStore(file)
    expect(await store.getBaseline('mentions')).toBeNull()
    expect(await store.getCursor('q')).toEqual(['a'])
  })

  it.each(['{"rowTasks":', '[]', '{"rowTasks":{"w":{"baselineIds":[],"pending":[{"content":"private-column"}]}}}'])('preserves malformed or wrong-root state for row tasks (%s)', async contents => {
    const file = path.join(dir, 'protected-state.json')
    await fs.writeFile(file, contents)
    const original = await fs.readFile(file)
    const store = createStateStore(file, mixedWatchers)

    await expect(store.getLaunchTimes()).rejects.toThrow(new Error(`state file at ${file} contains invalid state. Restore a valid copy to resume.`))
    expect(await fs.readFile(file)).toEqual(original)
    await expect(store.setLaunchTimes([42])).rejects.toThrow(`state file at ${file} contains invalid state. Restore a valid copy to resume.`)
    expect(await fs.readFile(file)).toEqual(original)
  })

  it('keeps plain-query recovery from malformed state and repairs it on the next write', async () => {
    const file = path.join(dir, 'plain-recovery.json')
    await fs.writeFile(file, '{"queryCursors":')
    const store = createStateStore(file)

    expect(await store.getCursor('q')).toBeNull()
    await store.setLaunchTimes([42])
    expect(await createStateStore(file).getLaunchTimes()).toEqual([42])
  })

  it('allows a fresh row-task state file and protects mixed watcher configs', async () => {
    const freshFile = path.join(dir, 'fresh-row-state.json')
    const freshStore = createStateStore(freshFile, mixedWatchers)
    expect(await freshStore.getRowTasks('q')).toBeNull()
    await freshStore.setLaunchTimes([42])
    expect(await createStateStore(freshFile, mixedWatchers).getLaunchTimes()).toEqual([42])

    const mixedFile = path.join(dir, 'mixed-state.json')
    const damaged = '{"rowTasks":'
    await fs.writeFile(mixedFile, damaged)
    const mixedStore = createStateStore(mixedFile, mixedWatchers)
    await expect(mixedStore.getCursor('plain')).rejects.toThrow(`state file at ${mixedFile} contains invalid state. Restore a valid copy to resume.`)
    expect(await fs.readFile(mixedFile, 'utf8')).toBe(damaged)
  })
})
