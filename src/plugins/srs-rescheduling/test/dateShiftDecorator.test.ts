// @vitest-environment node

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { Repo } from '@/data/repo'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { actionsFacet } from '@/extensions/core.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import {
  DATE_SHIFT_FORWARD_DAY_ACTION_ID,
  dateReferenceShiftActions,
  dailyNoteBlockId,
  dailyNotesDataExtension,
  getOrCreateDailyNote,
} from '@/plugins/daily-notes'
import { getEffectiveActions } from '@/shortcuts/effectiveActions.ts'
import { ActionContextTypes, type ActionConfig, type BlockShortcutDependencies } from '@/shortcuts/types.ts'
import { typesProp } from '@/data/properties.ts'
import {
  SRS_SM25_TYPE,
  srsNextReviewDateProp,
  srsReschedulingPlugin,
} from '../index.ts'

const WORKSPACE = 'ws-1'

let h: TestDb
let repo: Repo

const setupRuntime = () => {
  const runtime = resolveFacetRuntimeSync([
    kernelDataExtension,
    dailyNotesDataExtension,
    srsReschedulingPlugin,
    dateReferenceShiftActions.map(action => actionsFacet.of(action, {source: 'test'})),
  ])
  repo.setFacetRuntime(runtime)
  return runtime
}

const findDateShiftAction = (runtime: ReturnType<typeof setupRuntime>) =>
  getEffectiveActions(runtime).find(action =>
    action.id === DATE_SHIFT_FORWARD_DAY_ACTION_ID &&
    action.context === ActionContextTypes.NORMAL_MODE,
  ) as ActionConfig<typeof ActionContextTypes.NORMAL_MODE>

beforeEach(async () => {
  h = await createTestDb()
  repo = new Repo({
    db: h.db,
    cache: new BlockCache(),
    user: {id: 'user-1'},
    registerKernelProcessors: false,
  })
})

afterEach(async () => {
  await h.cleanup()
})

describe('SRS date-shift action decoration', () => {
  it('shifts srs next-review-date before falling back to block content', async () => {
    const runtime = setupRuntime()
    const may1 = await getOrCreateDailyNote(repo, WORKSPACE, '2026-05-01')
    await repo.tx(tx => tx.create({
      id: 'srs-block',
      workspaceId: WORKSPACE,
      parentId: null,
      orderKey: 'a0',
      content: 'content date [[2026-06-01]]',
      properties: {
        [typesProp.name]: typesProp.codec.encode([SRS_SM25_TYPE]),
        [srsNextReviewDateProp.name]: srsNextReviewDateProp.codec.encode(may1.id),
      },
    }), {scope: ChangeScope.BlockDefault})

    const block = repo.block('srs-block')
    await block.load()
    const action = findDateShiftAction(runtime)

    await action.handler({block, uiStateBlock: block} as BlockShortcutDependencies, {} as KeyboardEvent)

    expect(block.peek()?.content).toBe('content date [[2026-06-01]]')
    expect(block.get(srsNextReviewDateProp)).toBe(dailyNoteBlockId(WORKSPACE, '2026-05-02'))
  })

  it('falls back to the generic date-reference shift when SRS has no resolvable review date', async () => {
    const runtime = setupRuntime()
    await repo.tx(tx => tx.create({
      id: 'srs-block',
      workspaceId: WORKSPACE,
      parentId: null,
      orderKey: 'a0',
      content: 'content date [[2026-06-01]]',
      properties: {
        [typesProp.name]: typesProp.codec.encode([SRS_SM25_TYPE]),
      },
    }), {scope: ChangeScope.BlockDefault})

    const block = repo.block('srs-block')
    await block.load()
    const action = findDateShiftAction(runtime)

    await action.handler({block, uiStateBlock: block} as BlockShortcutDependencies, {} as KeyboardEvent)

    expect(block.peek()?.content).toBe('content date [[2026-06-02]]')
    expect(block.peek()?.properties[srsNextReviewDateProp.name]).toBeUndefined()
  })

  it('makes decorated canRun true for SRS blocks with next-review-date and no content date', async () => {
    const runtime = setupRuntime()
    const may1 = await getOrCreateDailyNote(repo, WORKSPACE, '2026-05-01')
    await repo.tx(tx => tx.create({
      id: 'srs-block',
      workspaceId: WORKSPACE,
      parentId: null,
      orderKey: 'a0',
      content: 'no inline date',
      properties: {
        [typesProp.name]: typesProp.codec.encode([SRS_SM25_TYPE]),
        [srsNextReviewDateProp.name]: srsNextReviewDateProp.codec.encode(may1.id),
      },
    }), {scope: ChangeScope.BlockDefault})

    const block = repo.block('srs-block')
    await block.load()
    const action = findDateShiftAction(runtime)

    expect(action.canRun?.({block, uiStateBlock: block} as never)).toBe(true)
  })
})
