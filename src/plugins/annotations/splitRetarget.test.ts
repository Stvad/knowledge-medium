import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {ChangeScope} from '@/data/api'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import type {AppExtension} from '@/facets/facet'
import {referencesDataExtension} from '@/plugins/references/dataExtension.js'
import {captureAnchor, resolveAnchor, type RangeAnchor} from './anchor'
import {annotationsDataExtension} from './dataExtension'
import {annotationTargetProp, threadAnchorOf, threadTargetIdOf} from './schema'
import {anchorAfterSplit} from './splitRetarget'
import {createThread} from './threads'

const WS = 'ws'
const TEXT = 'Draft the plan on Monday. Review the plan with the team on Friday.'
const CUT = TEXT.indexOf('Review')
const opts = {scope: ChangeScope.BlockDefault}

let db: TestDb
let repo: Repo
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })

const setUp = async (extensions: readonly AppExtension[]) => {
  await resetTestDb(db.db)
  repo = createTestRepo({db: db.db, user: {id: 'alex'}, extensions}).repo
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: 'P', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Page'})
    await tx.create({id: 'B', workspaceId: WS, parentId: 'P', orderKey: 'a0', content: TEXT})
  }, opts)
}
beforeEach(() => setUp([referencesDataExtension, annotationsDataExtension]))

const anchorAt = (content: string, quote: string, nth = 0): RangeAnchor => {
  let from = -1
  for (let i = 0; i <= nth; i++) from = content.indexOf(quote, from + 1)
  return captureAnchor(content, from, from + quote.length)!
}

const threadOn = async (quote: string, nth = 0, targetId = 'B') =>
  (await createThread(repo, {targetId, anchor: anchorAt(TEXT, quote, nth), comment: 'x'})).threadId

/** Where the thread resolves now: its target, and its state in that target. */
const placeOf = async (threadId: string) => {
  const root = (await repo.load(threadId))!
  const target = threadTargetIdOf(root)!
  const anchor = threadAnchorOf(root)
  if (anchor.kind === 'block') return {target, state: 'block' as const}
  const resolved = resolveAnchor((await repo.load(target))!.content, anchor)
  return {target, state: resolved.state, quoteStart: anchor.quoteStart}
}

const split = (placement?: 'siblingBefore' | 'firstChild', before = TEXT.slice(0, CUT), after = TEXT.slice(CUT)) =>
  repo.mutate.split({id: 'B', before, after, placement})

describe('a split of the target', () => {
  it('moves a thread quoting the prefix onto the new sibling, exact, near the cut or not', async () => {
    const far = await threadOn('Draft the plan')
    const near = await threadOn('Monday')
    const whole = (await createThread(repo, {targetId: 'B', anchor: null, comment: 'x'})).threadId

    const sibling = await split()

    expect(await placeOf(far)).toEqual({target: sibling, state: 'exact', quoteStart: 0})
    expect(await placeOf(near)).toEqual({target: sibling, state: 'exact', quoteStart: TEXT.indexOf('Monday')})
    expect(await placeOf(whole)).toEqual({target: 'B', state: 'block'})
  })

  it('keeps a thread quoting the suffix on the original, exact at its new offset', async () => {
    const thread = await threadOn('the plan', 1)
    await split()
    expect(await placeOf(thread)).toEqual({target: 'B', state: 'exact', quoteStart: TEXT.indexOf('the plan', CUT) - CUT})
  })

  it('at a scope root, moves a thread quoting the suffix onto the new first child, exact at its new offset', async () => {
    const thread = await threadOn('with the team')
    const child = await split('firstChild')
    expect((await repo.load('B'))!.content).toBe(TEXT.slice(0, CUT))
    expect(await placeOf(thread)).toEqual({target: child, state: 'exact', quoteStart: TEXT.indexOf('with the team') - CUT})
  })

  it('at a scope root, keeps a thread quoting the prefix on the root, exact though its suffix now ends the block', async () => {
    const thread = await threadOn('Monday')
    await split('firstChild')
    expect(await placeOf(thread)).toEqual({target: 'B', state: 'exact', quoteStart: TEXT.indexOf('Monday')})
  })

  it.each(['siblingBefore', 'firstChild'] as const)('leaves a quote across the cut on the original, stale (%s)', async placement => {
    const thread = await threadOn('Monday. Review')
    await split(placement)
    expect(await placeOf(thread)).toEqual({target: 'B', state: 'stale', quoteStart: TEXT.indexOf('Monday')})
  })

  it('undoes the retarget with the split, in one step', async () => {
    const thread = await threadOn('Draft the plan')
    const sibling = await split()
    expect((await placeOf(thread)).target).toBe(sibling)

    expect(await repo.undo()).toBe(true)
    expect((await repo.load(sibling))?.deleted ?? true).toBe(true)
    expect(await placeOf(thread)).toEqual({target: 'B', state: 'exact', quoteStart: 0})
  })

  it('leaves a thread that is not exact in the text the split cut, which can be ahead of the stored row', async () => {
    const thread = await threadOn('Draft the plan')
    // The editor's live text, not yet flushed: it moved the quote.
    const live = `Note: ${TEXT}`
    await split('siblingBefore', live.slice(0, CUT + 6), live.slice(CUT + 6))
    expect(await placeOf(thread)).toEqual({target: 'B', state: 'stale', quoteStart: 0})
  })

  it('leaves a thread whose target is another block, whatever its edges say', async () => {
    await repo.tx(tx => tx.create({id: 'X', workspaceId: WS, parentId: 'P', orderKey: 'b0', content: TEXT}), opts)
    const thread = await threadOn('Draft the plan', 0, 'X')
    // An edge to B the thread's target does not support, as a stale projection leaves.
    await db.db.writeTransaction(tx => tx.execute(
      'UPDATE blocks SET references_json = ? WHERE id = ?',
      [JSON.stringify([{id: 'B', alias: 'B', sourceField: annotationTargetProp.name}]), thread],
    ))
    await split()
    expect(await placeOf(thread)).toEqual({target: 'X', state: 'exact', quoteStart: 0})
  })
})

describe('a split, with nothing to project the target edge afterwards', () => {
  beforeEach(() => setUp([annotationsDataExtension]))

  it('moves the thread’s target edge in the same transaction, so the new block finds it', async () => {
    const thread = await threadOn('Draft the plan')
    const sibling = await split()
    const edges = await db.db.getAll<{target_id: string}>(
      'SELECT target_id FROM block_references WHERE source_id = ? AND source_field = ?',
      [thread, annotationTargetProp.name],
    )
    expect(edges).toEqual([{target_id: sibling}])
  })
})

describe('anchorAfterSplit', () => {
  it('leaves a quote its piece would widen: the piece parses a reference span the whole text does not', () => {
    const content = 'a([[[[]] b'
    const anchor = captureAnchor(content, 6, 8)!
    expect(anchor.quote).toBe(']]')
    expect(captureAnchor(content.slice(3), 3, 5)!.quote).toBe('[[[]]')
    const pieces = [{blockId: 'before', start: 0, end: 3}, {blockId: 'after', start: 3, end: content.length}]
    expect(anchorAfterSplit({content, pieces}, anchor)).toBeNull()
  })
})
