import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {ChangeScope} from '@/data/api'
import {PAGE_TYPE} from '@/data/blockTypes'
import {typesProp} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {referencesDataExtension} from '@/plugins/references/dataExtension.js'
import {captureAnchor, type RangeAnchor} from './anchor'
import {annotationsPlugin} from './index'
import {threadForRange} from './rangeRefs'
import {THREAD_TYPE, annotationTargetProp} from './schema'
import {createThread, setThreadStatus} from './threads'

const WS = 'ws'
const B_TEXT = 'As planned, the launch moves to Thursday, and the demo moves too.'
const opts = {scope: ChangeScope.BlockDefault}

let db: TestDb
let repo: Repo
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })

beforeEach(async () => {
  await resetTestDb(db.db)
  // `((id))` parses as a reference only when `id` is UUID-shaped.
  repo = createTestRepo({
    db: db.db, user: {id: 'alex', name: 'Alex'}, newId: () => crypto.randomUUID(),
    extensions: [referencesDataExtension, annotationsPlugin],
  }).repo
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Project notes',
      properties: {[typesProp.name]: [PAGE_TYPE]}})
    await tx.create({id: 'B', workspaceId: WS, parentId: 'page', orderKey: 'a0', content: B_TEXT})
  }, opts)
})

const anchorFor = (quote: string, content = B_TEXT): RangeAnchor => {
  const from = content.indexOf(quote)
  return captureAnchor(content, from, from + quote.length)!
}

/** Copy a reference to `content[from, to)` of B, as the action does. */
const copyAt = (from: number, to: number, content = B_TEXT) =>
  threadForRange(repo, 'B', captureAnchor(content, from, to)!, content)

const copy = (quote: string, content = B_TEXT) => {
  const from = content.indexOf(quote)
  return copyAt(from, from + quote.length, content)
}

const threadsOnB = () =>
  repo.query['core.typedBlockIds']({
    workspaceId: WS, types: [THREAD_TYPE],
    referencedBy: {id: 'B', sourceField: annotationTargetProp.name},
  }).load()

describe('threadForRange', () => {
  it('copying the same range twice reuses one thread', async () => {
    const first = await copy('Thursday')
    const second = await copy('Thursday')

    expect(second).toBe(first)
    expect(await threadsOnB()).toEqual([first])
    // A highlight: no comments under it.
    expect(await repo.block(first).children.load()).toEqual([])
  })

  it('reuses a discussion on the range, not only a highlight', async () => {
    const {threadId} = await createThread(repo, {targetId: 'B', anchor: anchorFor('Thursday'), comment: 'Confirmed?'})
    await vi.waitFor(async () => expect(await threadsOnB()).toEqual([threadId]))

    expect(await copy('Thursday')).toBe(threadId)
  })

  it('makes a new thread for a different range of the same quote', async () => {
    const first = await copy('moves')
    await vi.waitFor(async () => expect(await threadsOnB()).toEqual([first]))
    const later = B_TEXT.lastIndexOf('moves')

    expect(await copyAt(later, later + 'moves'.length)).not.toBe(first)
  })

  it('makes a new thread for a quote that shares only its start or its end', async () => {
    const thurs = await copy('Thurs')
    const day = await copy('day')
    const thursday = await copy('Thursday')

    expect(new Set([thurs, day, thursday]).size).toBe(3)
  })

  it('reuses a thread whose quote stayed put while the text around it changed', async () => {
    const first = await copy('Thursday')
    for (const [from, to] of [['launch', 'lunch!'], ['the demo', 'the show']] as const) {
      const edited = B_TEXT.replace(from, to)
      await repo.tx(tx => tx.update('B', {content: edited}), opts)
      expect(await copy('Thursday', edited)).toBe(first)
      await repo.tx(tx => tx.update('B', {content: B_TEXT}), opts)
    }
  })

  it('makes a new thread for a longer quote whose context reads the same', async () => {
    const repeated = 'a'.repeat(40)
    await repo.tx(tx => tx.update('B', {content: repeated}), opts)
    const one = await copyAt(0, 1, repeated)

    expect(await copyAt(0, 2, repeated)).not.toBe(one)
  })

  it('prefers a thread exact on the text over one that only moved onto it', async () => {
    const {threadId: moved} = await createThread(repo, {targetId: 'B', anchor: anchorFor('Thursday'), comment: 'Confirmed?'})
    const edited = `Note: ${B_TEXT}`
    await repo.tx(tx => tx.update('B', {content: edited}), opts)
    const {threadId: exact} = await createThread(repo, {targetId: 'B', anchor: anchorFor('Thursday', edited)})
    await vi.waitFor(async () => expect(await threadsOnB()).toHaveLength(2))

    expect(await copy('Thursday', edited)).toBe(exact)
    expect(moved).not.toBe(exact)
  })

  it('reads the selection’s text, which can run ahead of the stored row', async () => {
    const first = await copy('Thursday')

    expect(await copy('Thursday', `Note: ${B_TEXT}`)).toBe(first)
  })

  it('passes over a whole-block thread', async () => {
    const {threadId: whole} = await createThread(repo, {targetId: 'B', anchor: null, comment: 'About all of it'})
    await vi.waitFor(async () => expect(await threadsOnB()).toEqual([whole]))

    expect(await copy('Thursday')).not.toBe(whole)
  })

  it('does not reuse a resolved thread', async () => {
    const resolved = await copy('Thursday')
    await setThreadStatus(repo, resolved, 'resolved')

    expect(await copy('Thursday')).not.toBe(resolved)
  })

  it('reuses a thread whose quote moved, only where it now highlights the selection', async () => {
    const first = await copy('moves')
    await vi.waitFor(async () => expect(await threadsOnB()).toEqual([first]))
    const edited = `Note: ${B_TEXT}`
    await repo.tx(tx => tx.update('B', {content: edited}), opts)

    expect(await copy('moves', edited)).toBe(first)
    const later = edited.lastIndexOf('moves')
    expect(await copyAt(later, later + 'moves'.length, edited)).not.toBe(first)
  })
})

describe('a range reference', () => {
  it('deleting its thread leaves the quote as plain text in the quoting block', async () => {
    const threadId = await copy('Thursday')
    await repo.tx(tx => tx.create({
      id: 'X', workspaceId: WS, parentId: 'page', orderKey: 'a1',
      content: `Reading notes: ((${threadId})) is fixed now.`,
    }), opts)
    await repo.awaitProcessors()
    expect(await repo.query['core.typedBlockIds']({workspaceId: WS, referencedBy: {id: threadId}}).load()).toEqual(['X'])

    await repo.mutate.delete({id: threadId})

    expect((await repo.load('X'))?.content).toBe('Reading notes: Thursday is fixed now.')
  })
})
