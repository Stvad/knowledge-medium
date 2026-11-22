// @vitest-environment node
/** Every term shape compiled and run by the engine against one fixed set of
 *  blocks, with values on both sides of each day boundary. Times are in the
 *  fixture's UTC+2 local zone for created/updated and UTC for the date property. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Repo } from '@/data/repo'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { parseQuery } from '../query/parse'
import { WS, createQueryRepo, dbResolver, writeBlocks } from './queryDb'
import { MARY, PROJECTS, localDayStart } from './queryFixtures'

const at = (iso: string) => Date.parse(iso)
const LATER = at('2026-01-10T12:00:00.000Z')
const ALL = ['a', 'b', 'c', 'd', 'm', 'p']

let db: TestDb
let repo: Repo
beforeAll(async () => {
  db = await createTestDb()
  repo = await createQueryRepo(db)
  await writeBlocks(db, [
    {id: PROJECTS, createdAt: LATER},
    {id: MARY, createdAt: LATER},
    {id: 'a', parentId: PROJECTS, types: ['t-book'], createdAt: at('2026-01-04T22:00:00.000Z'),
      properties: {status: 'open', rating: 3, label: '', done: true, due: '2026-01-05T00:00:00.000Z', tags: ['a'], assignee: MARY},
      references: [{id: MARY, alias: MARY, sourceField: 'assignee'}]},
    {id: 'b', parentId: 'a', types: ['t-article'], createdAt: at('2026-01-05T21:59:59.999Z'),
      properties: {status: 'closed', rating: 1, label: 'x', done: false, due: '2026-01-05T23:59:59.999Z', tags: ['b'], related: [MARY]},
      references: [{id: MARY, alias: MARY, sourceField: 'related'}]},
    {id: 'c', createdAt: at('2026-01-05T22:00:00.000Z'),
      properties: {rating: 'x', due: '2026-01-06T00:00:00.000Z'}, references: [{id: MARY, alias: 'Mary'}]},
    {id: 'd', createdAt: at('2026-01-04T21:59:59.999Z')},
  ])
})
afterAll(async () => { await db.cleanup() })

const run = async (text: string) => {
  const parsed = parseQuery(text, dbResolver, {localDayStart})
  expect(parsed.errors).toEqual([])
  const ids = await repo.query.typedBlockIds({workspaceId: WS, ...parsed.query}).load()
  return [...ids].map(id => id === PROJECTS ? 'p' : id === MARY ? 'm' : id).sort()
}
const except = (...ids: string[]) => ALL.filter(id => !ids.includes(id))

describe('parsed terms in the engine', () => {
  it.each([
    ['#book', ['a']],
    ['#book|#article', ['a', 'b']],
    ['!#book', except('a')],
    ['status=open', ['a']],
    ['status!=open', except('a')],
    ['label=""', ['a']],
    ['label', ['a', 'b']],
    ['!label', except('a', 'b')],
    ['rating>=1', ['a', 'b']],
    ['rating<3', ['b']],
    ['rating!=3', except('a')],
    ['done=false', ['b']],
    ['due=2026-01-05', ['a', 'b']],
    ['due<=2026-01-05', ['a', 'b']],
    ['due<2026-01-06', ['a', 'b']],
    ['due>2026-01-05', ['c']],
    ['due>=2026-01-06', ['c']],
    ['due!=2026-01-05', except('a', 'b')],
    ['due<2026-01-05T12:00:00.000Z', ['a']],
    ['due<=9999-12-31', ['a', 'b', 'c']],
    ['due>9999-12-31', []],
    ['tags=a', ['a']],
    ['tags!=a', except('a')],
    ['assignee=[[Mary]]', ['a']],
    ['assignee!=[[Mary]]', except('a')],
    ['related=[[Mary]]', ['b']],
    ['refs=[[Mary]]', ['a', 'b', 'c']],
    [`childof=((${PROJECTS}))`, ['a']],
    ['#article under=[[Projects]]', ['b']],
    ['created=2026-01-05', ['a', 'b']],
    ['created<=2026-01-05', ['a', 'b', 'd']],
    ['created<2026-01-05', ['d']],
    ['created>2026-01-05', ['c', 'm', 'p']],
    ['created>=2026-01-05', except('d')],
    ['created!=2026-01-05', except('a', 'b')],
    ['updated=2026-01-05', ['a', 'b']],
    ['status=open | rating=1', ['a', 'b']],
    ['(#book | refs=[[Mary]]) !#article', ['a', 'c']],
  ] as const)('%s', async (text, expected) => {
    expect(await run(text)).toEqual(expected)
  })
})
