// @vitest-environment node
//
// Drives the REAL extension against a REAL repo, in the shape the identical
// decorator's tests next door use (`src/plugins/srs-rescheduling/test/plugin.test.ts`).
// Two things matter about going through `getEffectiveActions` + `invokeAction`
// instead of calling `transform.apply(action).handler(...)` directly:
//
//  - it applies `matchesAction`, so the transform's declared `context` is under
//    test. A transform aimed at the wrong context is present but never applied —
//    indistinguishable from a dropped one if you call `apply` yourself.
//  - the writes go through real property-schema resolution into the DB, so
//    "fell through" is asserted as the todo state the REAL `cycleTodoState`
//    left on the block, not as a spy call count.
//
// What it pins is the latch: reviewing a highlight is a one-time mark, and a
// marked highlight stops intercepting the key — it falls through and behaves
// like an ordinary block.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { ChangeScope } from '@/data/api/index.js'
import type { Block } from '@/data/block.js'
import type { Repo } from '@/data/repo.js'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb.js'
import { createTestRepo } from '@/data/test/createTestRepo.js'
import type { AppExtension, FacetRuntime } from '@/facets/facet.js'
import { dailyNotesDataExtension } from '@/plugins/daily-notes/dataExtension.js'
import { SWIPE_RIGHT_BLOCK_ACTION_ID } from '@/plugins/swipe-quick-actions/actions.js'
import {
  EDIT_MODE_TODO_CYCLE_ACTION_ID,
  TODO_CYCLE_ACTION_ID,
  todoActionsExtension,
} from '@/plugins/todo/actions.js'
import { todoDataExtension } from '@/plugins/todo/dataExtension.js'
import { statusProp, TODO_TYPE } from '@/plugins/todo/schema.js'
import { getBlockTypes } from '@/data/properties.js'
import { getEffectiveActions } from '@/shortcuts/effectiveActions.js'
import { invokeAction } from '@/shortcuts/actionDispatch.js'
import type {
  ActionConfig,
  ActionTrigger,
  BaseShortcutDependencies,
} from '@/shortcuts/types.js'

import readwiseContributions from './readwise.tsx'

// Wire-level names — what actually sits in the user's DB. Spelling them out pins
// the contract; the extension exports nothing but its contribution list.
const HIGHLIGHT_TYPE = 'readwise-highlight'
const REVIEWED_PROP = 'readwise:reviewed'
const HIGHLIGHT_ID_PROP = 'readwise:highlight_id'

const WS = 'ws-1'

/** The default export also carries the setup dialog's app-mount and the auto-sync
 *  effect; neither belongs in a repo-level runtime. Keep every real contribution
 *  object, drop the two that need an app shell. */
const EXCLUDED_FACETS = ['core.app-mounts', 'core.app-effects']
const readwiseDataAndActions = readwiseContributions
  .filter(c => !EXCLUDED_FACETS.includes(c.facet.id)) as unknown as AppExtension[]

let sharedDb: TestDb

const setup = (opts: { isReadOnly?: boolean } = {}) => {
  const { repo } = createTestRepo({
    db: sharedDb.db,
    isReadOnly: opts.isReadOnly,
    extensions: [
      dailyNotesDataExtension,  // readwise:review_date targets DAILY_NOTE_TYPE
      todoDataExtension,
      todoActionsExtension,     // the real cycle handlers the press falls through to
      ...readwiseDataAndActions,
    ],
  })
  return { repo, runtime: repo.facetRuntime! }
}

/** Seed a block, optionally type-tagged as a Readwise highlight with imported
 *  properties, in the shape `ensureHighlightReviewState` leaves after a sync. */
const seed = async (
  repo: Repo,
  id: string,
  { highlight, reviewed }: { highlight: boolean; reviewed?: boolean },
) => {
  const snapshot = repo.snapshotTypeRegistries()
  await repo.tx(async tx => {
    await tx.create({ id, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'text' })
    if (highlight) {
      await repo.addTypeInTx(tx, id, HIGHLIGHT_TYPE, {
        [HIGHLIGHT_ID_PROP]: '12345',
        [REVIEWED_PROP]: reviewed ?? false,
      }, snapshot)
    }
  }, { scope: ChangeScope.BlockDefault, description: 'seed' })
  const block = repo.block(id)
  await block.load()
  return block
}

const press = (runtime: FacetRuntime, actionId: string, block: Block) => {
  const action = getEffectiveActions(runtime).find(it => it.id === actionId) as
    ActionConfig | undefined
  expect(action, `no effective action ${actionId}`).toBeDefined()
  return invokeAction(runtime, {
    action: action!,
    deps: { block, uiStateBlock: block } as unknown as BaseShortcutDependencies,
    // A real trigger — `{type: 'programmatic'}` satisfies no ActionTrigger member.
    trigger: new CustomEvent('test-press') as ActionTrigger,
  })
}

/** What the press actually left on the block, read back decoded from the DB. */
const stateOf = (block: Block) => {
  const data = block.peek()!
  return {
    reviewed: data.properties[REVIEWED_PROP],
    types: [...getBlockTypes(data)],
    todoStatus: data.properties[statusProp.name],
    highlightId: data.properties[HIGHLIGHT_ID_PROP],
  }
}

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { await resetTestDb(sharedDb.db) })

// All three surfaces the extension decorates. Driving each through
// `getEffectiveActions` means each one's declared context has to match the real
// action's context for the transform to apply at all.
const SURFACES = [
  { name: 'normal-mode todo cycle', actionId: TODO_CYCLE_ACTION_ID },
  { name: 'edit-mode todo cycle', actionId: EDIT_MODE_TODO_CYCLE_ACTION_ID },
  { name: 'swipe right', actionId: SWIPE_RIGHT_BLOCK_ACTION_ID },
] as const

describe.each(SURFACES)('readwise review latch via $name', ({ actionId }) => {
  it('marks an unreviewed highlight and consumes the press', async () => {
    const { repo, runtime } = setup()
    const block = await seed(repo, 'hl', { highlight: true })

    await press(runtime, actionId, block)

    const state = stateOf(block)
    expect(state.reviewed).toBe(true)
    // Consumed: the todo cycle did NOT also run.
    expect(state.types).toEqual([HIGHLIGHT_TYPE])
    expect(state.todoStatus).toBeUndefined()
  })

  it('falls through on an already-reviewed highlight, into the real todo cycle', async () => {
    const { repo, runtime } = setup()
    const block = await seed(repo, 'hl', { highlight: true, reviewed: true })

    await press(runtime, actionId, block)

    const state = stateOf(block)
    expect(state.types).toEqual([HIGHLIGHT_TYPE, TODO_TYPE])
    expect(state.todoStatus).toBe('open')
    // The latch is untouched and the imported properties survive.
    expect(state.reviewed).toBe(true)
    expect(state.highlightId).toBe('12345')
  })

  it('marks on the first press, falls through on the second', async () => {
    const { repo, runtime } = setup()
    const block = await seed(repo, 'hl', { highlight: true })

    await press(runtime, actionId, block)
    const afterFirst = stateOf(block)
    await press(runtime, actionId, block)
    const afterSecond = stateOf(block)

    expect(afterFirst.reviewed).toBe(true)
    expect(afterFirst.types).toEqual([HIGHLIGHT_TYPE])
    // Second press does not un-review — it turns the highlight into a todo.
    expect(afterSecond.reviewed).toBe(true)
    expect(afterSecond.types).toEqual([HIGHLIGHT_TYPE, TODO_TYPE])
    expect(afterSecond.todoStatus).toBe('open')
  })

  it('leaves a non-highlight block entirely to the action', async () => {
    const { repo, runtime } = setup()
    const block = await seed(repo, 'plain', { highlight: false })

    await press(runtime, actionId, block)

    const state = stateOf(block)
    expect(state.types).toEqual([TODO_TYPE])
    expect(state.todoStatus).toBe('open')
    expect(state.reviewed).toBeUndefined()
  })

  it('writes nothing on a read-only repo, and still consumes the press', async () => {
    const writable = setup()
    const seeded = await seed(writable.repo, 'hl', { highlight: true })
    expect(stateOf(seeded).reviewed).toBe(false)

    const { repo, runtime } = setup({ isReadOnly: true })
    const block = repo.block('hl')
    await block.load()

    await press(runtime, actionId, block)

    const state = stateOf(block)
    expect(state.reviewed).toBe(false)
    // Consumed rather than fallen through: no todo either.
    expect(state.types).toEqual([HIGHLIGHT_TYPE])
    expect(state.todoStatus).toBeUndefined()
  })
})
