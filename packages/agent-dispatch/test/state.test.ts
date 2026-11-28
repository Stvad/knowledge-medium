import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import {createStateStore} from '../src/state'

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
    const snapshot = {baselineMs: 40, baselineIds: ['old'], pending: [{id: 'new', tag: 'sample', count: 2, extra: null}]}
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

  it.each([
    ['truncated JSON', '{"queryCursors":'],
    ['array at root', '[]'],
    ['unexpected field', '{"notAStateFile":42}'],
    ['invalid row snapshot', '{"rowTasks":{"w":{"baselineMs":42,"baselineIds":[],"pending":[{"title":"sample"}]}}}'],
    ['missing row cutoff', '{"rowTasks":{"w":{"baselineIds":[],"pending":[]}}}'],
    ['invalid launch history', '{"launchTimes":["bad"]}'],
    ['invalid cursor', '{"queryCursors":{"q":1}}'],
    ['invalid backlink baseline', '{"backlinkBaselines":{"w":null}}'],
  ])('refuses to overwrite a state file with %s', async (_problem, contents) => {
    const file = path.join(dir, 'damaged.json')
    await fs.writeFile(file, contents)
    const store = createStateStore(file)
    await expect(store.getLaunchTimes()).rejects.toThrow('contains invalid state')
    await expect(store.setLaunchTimes([42])).rejects.toThrow('contains invalid state')
    expect(await fs.readFile(file, 'utf8')).toBe(contents)
  })
})
