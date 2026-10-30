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

const threadsOnB = () =>
  repo.query['core.typedBlockIds']({
    workspaceId: WS, types: [THREAD_TYPE],
    referencedBy: {id: 'B', sourceField: annotationTargetProp.name},
  }).load()

describe('threadForRange', () => {
  it('copying the same range twice reuses one thread', async () => {
    const first = await threadForRange(repo, 'B', B_TEXT, anchorFor('Thursday'))
    const second = await threadForRange(repo, 'B', B_TEXT, anchorFor('Thursday'))

    expect(second).toBe(first)
    expect(await threadsOnB()).toEqual([first])
    // A highlight: no comments under it.
    expect(await repo.block(first).children.load()).toEqual([])
  })

  it('reuses a discussion on the range, not only a highlight', async () => {
    const {threadId} = await createThread(repo, {targetId: 'B', anchor: anchorFor('Thursday'), comment: 'Confirmed?'})
    await vi.waitFor(async () => expect(await threadsOnB()).toEqual([threadId]))

    expect(await threadForRange(repo, 'B', B_TEXT, anchorFor('Thursday'))).toBe(threadId)
  })

  it('makes a new thread for a different range of the same quote', async () => {
    const first = await threadForRange(repo, 'B', B_TEXT, anchorFor('moves'))
    await vi.waitFor(async () => expect(await threadsOnB()).toEqual([first]))
    const later = B_TEXT.lastIndexOf('moves')
    const second = await threadForRange(repo, 'B', B_TEXT, captureAnchor(B_TEXT, later, later + 'moves'.length)!)

    expect(second).not.toBe(first)
  })

  it('makes a new thread for a quote that shares only its start or its end', async () => {
    const thurs = await threadForRange(repo, 'B', B_TEXT, anchorFor('Thurs'))
    const day = await threadForRange(repo, 'B', B_TEXT, anchorFor('day'))
    const thursday = await threadForRange(repo, 'B', B_TEXT, anchorFor('Thursday'))

    expect(new Set([thurs, day, thursday]).size).toBe(3)
  })

  it('does not reuse a resolved thread, or one whose anchor only moved', async () => {
    const resolved = await threadForRange(repo, 'B', B_TEXT, anchorFor('Thursday'))
    await setThreadStatus(repo, resolved, 'resolved')
    const reopened = await threadForRange(repo, 'B', B_TEXT, anchorFor('Thursday'))
    expect(reopened).not.toBe(resolved)

    const edited = `Note: ${B_TEXT}`
    await repo.tx(tx => tx.update('B', {content: edited}), opts)
    expect(await threadForRange(repo, 'B', edited, anchorFor('Thursday', edited))).not.toBe(reopened)
  })
})

describe('a range reference', () => {
  it('deleting its thread leaves the quote as plain text in the quoting block', async () => {
    const threadId = await threadForRange(repo, 'B', B_TEXT, anchorFor('Thursday'))
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
