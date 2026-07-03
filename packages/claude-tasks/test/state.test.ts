import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import {createStateStore} from '../src/state'

let dir: string
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-tasks-state-'))
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

  it('loads a pre-baseline state file (missing key) as never-seen', async () => {
    const file = path.join(dir, 'legacy.json')
    await fs.writeFile(file, JSON.stringify({queryCursors: {q: ['a']}, launchTimes: [1]}))
    const store = createStateStore(file)
    expect(await store.getBaseline('mentions')).toBeNull()
    expect(await store.getCursor('q')).toEqual(['a'])
  })
})
