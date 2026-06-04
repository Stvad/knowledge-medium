// @vitest-environment node

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { actionsFacet } from '@/extensions/core.js'
import { resolveFacetRuntimeSync } from '@/extensions/facet.js'
import { typesProp } from '@/data/properties.js'
import { getEffectiveActions } from '@/shortcuts/effectiveActions.js'
import { ActionContextTypes, type ActionConfig, type BlockShortcutDependencies } from '@/shortcuts/types.js'
import {
  RESCHEDULE_BLOCK_DATE_ACTION_ID,
  dailyNotesDataExtension,
  getOrCreateDailyNote,
  rescheduleBlockDateAction,
} from '@/plugins/daily-notes'
import {
  SRS_SM25_TYPE,
  srsNextReviewDateProp,
  srsReschedulingPlugin,
} from '../index.ts'

const WS = 'ws-1'
let sharedDb: TestDb
let h: TestDb
let repo: Repo

const setupRuntime = () => {
  const runtime = resolveFacetRuntimeSync([
    kernelDataExtension,
    dailyNotesDataExtension,
    srsReschedulingPlugin,
    actionsFacet.of(rescheduleBlockDateAction, {source: 'test'}),
  ])
  repo.setFacetRuntime(runtime)
  return runtime
}

const findRescheduleAction = (runtime: ReturnType<typeof setupRuntime>) =>
  getEffectiveActions(runtime).find(action =>
    action.id === RESCHEDULE_BLOCK_DATE_ACTION_ID &&
    action.context === ActionContextTypes.NORMAL_MODE,
  ) as ActionConfig<typeof ActionContextTypes.NORMAL_MODE>

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  h = sharedDb
  repo = new Repo({
    db: h.db, cache: new BlockCache(), user: {id: 'user-1'},
    registerKernelProcessors: false,
  })
})

afterEach(async () => {
  repo.stopSyncObserver()
})

describe('reschedule action with SRS decorator', () => {
  it('canRun is true on a regular block with one date reference (base predicate)', async () => {
    const runtime = setupRuntime()
    await repo.tx(tx => tx.create({id: 'b', workspaceId: WS, parentId: null, orderKey: 'a',
      content: 'due [[2026-05-15]]'}), {scope: ChangeScope.BlockDefault})
    const block = repo.block('b'); await block.load()

    const action = findRescheduleAction(runtime)
    expect(action.canRun?.({block, uiStateBlock: block} as BlockShortcutDependencies)).toBe(true)
  })

  it('canRun is true on an SRS block without inline date (decorator extension)', async () => {
    const runtime = setupRuntime()
    const may1 = await getOrCreateDailyNote(repo, WS, '2026-05-01')
    await repo.tx(tx => tx.create({id: 'srs', workspaceId: WS, parentId: null, orderKey: 'a',
      content: 'no inline date',
      properties: {
        [typesProp.name]: typesProp.codec.encode([SRS_SM25_TYPE]),
        [srsNextReviewDateProp.name]: srsNextReviewDateProp.codec.encode(may1.id),
      },
    }), {scope: ChangeScope.BlockDefault})

    const block = repo.block('srs'); await block.load()
    const action = findRescheduleAction(runtime)
    expect(action.canRun?.({block, uiStateBlock: block} as BlockShortcutDependencies)).toBe(true)
  })

  it('canRun is false on a plain block (no date, no SRS state)', async () => {
    const runtime = setupRuntime()
    await repo.tx(tx => tx.create({id: 'plain', workspaceId: WS, parentId: null, orderKey: 'a',
      content: 'just notes'}), {scope: ChangeScope.BlockDefault})
    const block = repo.block('plain'); await block.load()

    const action = findRescheduleAction(runtime)
    expect(action.canRun?.({block, uiStateBlock: block} as BlockShortcutDependencies)).toBe(false)
  })
})
