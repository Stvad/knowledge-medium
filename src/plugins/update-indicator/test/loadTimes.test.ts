// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, type User } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { Repo } from '@/data/repo'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { getUserPrefsBlock } from '@/data/globalState'
import {
  currentLoadTimeProp,
  previousLoadTimeProp,
  recordUpdateIndicatorLoadTime,
} from '../loadTimes'

const WS = 'ws-1'
const USER: User = {id: 'user-1', name: 'Alice'}

interface Harness {
  h: TestDb
}

let env: Harness | undefined
let txSeq = 0

const makeRepo = (h: TestDb): Repo => {
  const repo = new Repo({
    db: h.db,
    cache: new BlockCache(),
    user: USER,
    newTxSeq: () => ++txSeq,
    registerKernelProcessors: false,
  })
  repo.setActiveWorkspaceId(WS)
  return repo
}

afterEach(async () => {
  vi.restoreAllMocks()
  txSeq = 0
  await env?.h.cleanup()
  env = undefined
})

describe('recordUpdateIndicatorLoadTime', () => {
  it('rolls the prior current load time into previousLoadTime across repo reloads', async () => {
    const h = await createTestDb()
    env = {h}

    const now = vi.spyOn(Date, 'now').mockReturnValue(100)
    const firstRepo = makeRepo(h)
    await recordUpdateIndicatorLoadTime(firstRepo, WS)
    const firstPrefs = await getUserPrefsBlock(firstRepo, WS, USER)
    expect(firstPrefs.peekProperty(previousLoadTimeProp)).toBe(0)
    expect(firstPrefs.peekProperty(currentLoadTimeProp)).toBe(100)

    now.mockReturnValue(200)
    const secondRepo = makeRepo(h)
    await recordUpdateIndicatorLoadTime(secondRepo, WS)
    const secondPrefs = await getUserPrefsBlock(secondRepo, WS, USER)
    expect(secondPrefs.peekProperty(previousLoadTimeProp)).toBe(100)
    expect(secondPrefs.peekProperty(currentLoadTimeProp)).toBe(200)

    const events = await h.db.getAll<{scope: string; source: string}>(
      'SELECT scope, source FROM command_events WHERE description = ? ORDER BY created_at',
      ['update indicator load time'],
    )
    expect(events).toEqual([
      {scope: ChangeScope.UserPrefs, source: 'user'},
      {scope: ChangeScope.UserPrefs, source: 'user'},
    ])
  })
})
