// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { ChangeScope } from '@/data/api'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext.js'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'
import type { BlockRendererProps } from '@/types'
import { CHAR_COUNTER_TYPE, WORD_COUNTER_TYPE } from '../blockType'
import { characterCounterDataExtension } from '../dataExtension'
import { charLimitProp, charProfileProp, charScopeProp, type CharacterCounterScope } from '../properties'
import { builtinCountProfiles, characterCountProfilesFacet } from '../profiles'
import { characterCountDecoratorContribution } from '../CharacterCountDecorator'

const WS = 'ws-char-counter'
const TIMEOUT_MS = 3_000

const useHookOnlyCount = (): number => 7
const runtime = resolveFacetRuntimeSync([
  ...builtinCountProfiles,
  characterCountProfilesFacet.of({id: 'hook-only', useCount: useHookOnlyCount}, {source: 'test'}),
])

const Inner = ({block}: BlockRendererProps) => <div data-testid={`inner-${block.id}`}/>
const decorate = characterCountDecoratorContribution(undefined as never)
if (typeof decorate !== 'function') throw new Error('expected a decorator')
const Decorated = decorate(Inner)

let sharedDb: TestDb
let repo: Repo
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    extensions: [characterCounterDataExtension],
  }).repo
  repo.setActiveWorkspaceId(WS)
})
afterEach(() => {
  cleanup()
  repo.setActiveWorkspaceId(null)
})

const ROOT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const CHILD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const GRANDCHILD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'

/** root "Essay draft" → child "one two three" → grandchild "four five". */
const seedTree = async (counter: {
  type?: string
  scope?: CharacterCounterScope
  profile?: string
  limit?: number
}) => {
  await repo.tx(async tx => {
    await tx.create({id: ROOT, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Essay draft'})
  }, {scope: ChangeScope.BlockDefault})
  await repo.mutate.createChild({parentId: ROOT, id: CHILD, content: 'one two three'})
  await repo.mutate.createChild({parentId: CHILD, id: GRANDCHILD, content: 'four five'})
  await repo.addType(ROOT, counter.type ?? CHAR_COUNTER_TYPE)
  const root = repo.block(ROOT)
  if (counter.scope !== undefined) await root.set(charScopeProp, counter.scope)
  if (counter.profile !== undefined) await root.set(charProfileProp, counter.profile)
  if (counter.limit !== undefined) await root.set(charLimitProp, counter.limit)
  return root
}

const renderBlock = (id: string) => render(
  <AppRuntimeContextProvider value={runtime}>
    <Decorated block={repo.block(id)}/>
  </AppRuntimeContextProvider>,
)

const badgeText = () => screen.getByLabelText(/count/i).textContent

describe('CharacterCountDecorator', () => {
  it('counts words in the block itself with the words profile', async () => {
    await seedTree({scope: 'self', profile: 'words'})
    renderBlock(ROOT)
    await waitFor(() => expect(badgeText()).toBe('2'), {timeout: TIMEOUT_MS})
  })

  it('subtree scope totals the root and every descendant, and follows edits deep in the tree', async () => {
    await seedTree({scope: 'subtree', profile: 'words', limit: 6})
    renderBlock(ROOT)
    // Before the subtree loads there is no badge, never a placeholder total.
    expect([undefined, '7 / 6']).toContain(screen.queryByLabelText(/count/i)?.textContent)
    await waitFor(() => expect(badgeText()).toBe('7 / 6'), {timeout: TIMEOUT_MS})

    await repo.block(GRANDCHILD).setContent('four')
    await waitFor(() => expect(badgeText()).toBe('6 / 6'), {timeout: TIMEOUT_MS})
  })

  it('subtree scope counts characters when no profile is set', async () => {
    await seedTree({scope: 'subtree'})
    renderBlock(ROOT)
    // 'Essay draft' + 'one two three' + 'four five'
    await waitFor(() => expect(badgeText()).toBe(String(11 + 13 + 9)), {timeout: TIMEOUT_MS})
  })

  it('subtree scope does not decorate the descendants themselves', async () => {
    await seedTree({scope: 'subtree', profile: 'words'})
    renderBlock(ROOT)
    await waitFor(() => expect(badgeText()).toBe('7'), {timeout: TIMEOUT_MS})
    cleanup()

    renderBlock(CHILD)
    await waitFor(() => expect(screen.getByTestId(`inner-${CHILD}`)).toBeTruthy(), {timeout: TIMEOUT_MS})
    expect(screen.queryByLabelText(/count/i)).toBeNull()
  })

  it('subtree scope leaves out the counter block\'s own property rows', async () => {
    await resetTestDb(sharedDb.db)
    await sharedDb.db.execute(`INSERT INTO workspaces
      (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
      VALUES (?, 'Test', 'user-1', 1, 1, 'none', NULL, 'children')`, [WS])
    repo = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      extensions: [characterCounterDataExtension],
      appGenerators: true,
    }).repo
    repo.setActiveWorkspaceId(WS)
    await seedTree({scope: 'subtree', profile: 'words'})
    await repo.awaitProcessors()
    const fieldRows = await sharedDb.db.getAll<{id: string}>(
      'SELECT id FROM blocks WHERE parent_id = ? AND is_field_form = 1 AND deleted = 0', [ROOT])
    expect(fieldRows.length).toBeGreaterThan(0)

    renderBlock(ROOT)
    await waitFor(() => expect(badgeText()).toBe('7'), {timeout: TIMEOUT_MS})
  })

  it('a word counter starts out counting words over its whole subtree', async () => {
    const root = await seedTree({type: WORD_COUNTER_TYPE})
    expect(root.get(charScopeProp)).toBe('subtree')
    expect(root.get(charProfileProp)).toBe('words')
    renderBlock(ROOT)
    await waitFor(() => expect(badgeText()).toBe('7'), {timeout: TIMEOUT_MS})
  })

  it('a word counter configured for its children decorates each child', async () => {
    await seedTree({type: WORD_COUNTER_TYPE, scope: 'children'})
    renderBlock(CHILD)
    await waitFor(() => expect(badgeText()).toBe('3'), {timeout: TIMEOUT_MS})
  })

  it('says a hook-only profile cannot total a subtree instead of showing a wrong number', async () => {
    await seedTree({scope: 'subtree', profile: 'hook-only'})
    renderBlock(ROOT)
    await waitFor(
      () => expect(badgeText()).toBe('hook-only: no subtree total'),
      {timeout: TIMEOUT_MS},
    )
  })
})
