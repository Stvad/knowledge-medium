// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { formatRoamDate } from '@/utils/dailyPage'
import { referenceTargetTypes } from '@/editor/referenceTargetTypes'
import { ChangeScope } from '@/data/api'
import { aliasesProp, typesProp } from '@/data/properties'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'
import { buildWikilinkSource, buildBlockrefSource } from '../codeMirrorExtensions'

const WS = 'ws-1'
let db: TestDb
let env: {repo: Repo}
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  await resetTestDb(db.db)
  env = createTestRepo({db: db.db, user: {id: 'user-1'}})
})
const create = async (args: {id: string; content?: string; aliases?: string[]; types: string[]}) => {
  await env.repo.tx(tx => tx.create({
    id: args.id, workspaceId: WS, parentId: null, orderKey: `key-${args.id}`,
    content: args.content ?? '',
    properties: {
      ...(args.aliases ? {[aliasesProp.name]: aliasesProp.codec.encode(args.aliases)} : {}),
      [typesProp.name]: typesProp.codec.encode(args.types),
    },
  }), {scope: ChangeScope.BlockDefault})
}


describe('typed reference completion sources', () => {
  it('constrains a whole wikilink with text after the caret', async () => {
    await create({id: 'person', aliases: ['Alice'], types: ['person']})
    await create({id: 'place', aliases: ['Alpine'], types: ['place']})
    env.repo.setActiveWorkspaceId(WS)
    const state = EditorState.create({doc: '[[Alpine]]', extensions: [referenceTargetTypes.of(['person'])]})
    const source = buildWikilinkSource({repo: env.repo} as Parameters<typeof buildWikilinkSource>[0])
    const result = await source(new CompletionContext(state, 4, false))
    expect(result?.options.map(option => option.label)).toEqual(['Alice'])
    expect(result?.to).toBe(8)
    env.repo.setActiveWorkspaceId(null)
  })

  it('includes a relative date only when its resolved target has an allowed type', async () => {
    const label = formatRoamDate(new Date())
    await create({id: 'daily', aliases: [label], types: ['daily']})
    env.repo.setActiveWorkspaceId(WS)
    const source = buildWikilinkSource({repo: env.repo} as Parameters<typeof buildWikilinkSource>[0])
    const state = (type: string) => EditorState.create({doc: '[[today', extensions: [referenceTargetTypes.of([type])]})
    const allowed = await source(new CompletionContext(state('daily'), 7, false))
    const disallowed = await source(new CompletionContext(state('person'), 7, false))
    expect(allowed?.options.map(option => option.label)).toContain(label)
    expect(disallowed).toBeNull()
    env.repo.setActiveWorkspaceId(null)
  })

  it('offers typed blocks for an implicit empty block reference', async () => {
    await create({id: 'person', content: 'Alice', types: ['person']})
    await create({id: 'place', content: 'Alpine', types: ['place']})
    env.repo.setActiveWorkspaceId(WS)
    const state = EditorState.create({doc: '((', extensions: [referenceTargetTypes.of(['person'])]})
    const source = buildBlockrefSource({repo: env.repo} as Parameters<typeof buildBlockrefSource>[0])
    const result = await source(new CompletionContext(state, 2, false))
    expect(result?.options.map(option => option.label)).toEqual(['Alice'])
    env.repo.setActiveWorkspaceId(null)
  })
})
