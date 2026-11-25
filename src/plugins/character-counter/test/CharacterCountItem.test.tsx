// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { RepoContext } from '@/context/repo'
import { ChangeScope, seedProperty, seedType } from '@/data/api'
import { materializePropertySeeds } from '@/data/definitionSeeds'
import { definitionSeedsFacet, typeSeedsFacet } from '@/data/facets'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import type { BlockGutterItem } from '@/extensions/blockInteraction.js'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext.js'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'
import { CHAR_COUNTER_TYPE, WORD_COUNTER_TYPE } from '../blockType'
import { characterCounterDataExtension } from '../dataExtension'
import { charExcludeProp, charLimitProp, charProfileProp, charScopeProp, type CharacterCounterScope } from '../properties'
import { builtinCountProfiles, characterCountProfilesFacet } from '../profiles'
import { characterCountItemContribution } from '../CharacterCountItem'

const WS = 'ws-char-counter'
const TIMEOUT_MS = 3_000
const draftType = seedType({seedKey: 'test:counter/type/draft', revision: 1, id: 'draft', label: 'Draft'})
const publishProp = seedProperty({
  seedKey: 'test:counter/property/publish', revision: 1, name: 'publish', preset: 'strict-enum',
  config: {options: [{value: 'article', label: 'Article'}, {value: 'exclude', label: 'Exclude'}]},
  defaultValue: 'article',
  changeScope: ChangeScope.BlockDefault,
})

const useHookOnlyCount = (): number => 7
const runtime = resolveFacetRuntimeSync([
  ...builtinCountProfiles,
  characterCountProfilesFacet.of({id: 'hook-only', useCount: useHookOnlyCount}, {source: 'test'}),
])

const item = characterCountItemContribution(undefined as never)
if (!item || Array.isArray(item)) throw new Error('expected one gutter item')
const CountItem = (item as BlockGutterItem).component

let sharedDb: TestDb
let repo: Repo
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    extensions: [characterCounterDataExtension, typeSeedsFacet.of(draftType), definitionSeedsFacet.of(publishProp)],
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

// The item can suspend while its block loads, and a suspended tree commits
// nothing, so the sibling marker appearing is the fence for "the item has
// rendered, and chose to show nothing".
const renderBlock = (id: string) => render(
  <RepoContext.Provider value={repo}>
    <AppRuntimeContextProvider value={runtime}>
      <CountItem block={repo.block(id)}/>
      <span data-testid="committed"/>
    </AppRuntimeContextProvider>
  </RepoContext.Provider>,
)

const badgeText = () => screen.getByLabelText(/count/i).textContent

describe('CharacterCountItem', () => {
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

  it('subtree scope shows nothing on the descendants themselves', async () => {
    await seedTree({scope: 'subtree', profile: 'words'})
    renderBlock(ROOT)
    await waitFor(() => expect(badgeText()).toBe('7'), {timeout: TIMEOUT_MS})
    cleanup()

    renderBlock(CHILD)
    await screen.findByTestId('committed', {}, {timeout: TIMEOUT_MS})
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

  it('skips an excluded publishing branch and follows live property and type changes', async () => {
    await materializePropertySeeds(repo, WS, [publishProp])
    await repo.awaitProcessors()
    const root = await seedTree({type: WORD_COUNTER_TYPE})
    await repo.mutate.createChild({parentId: ROOT, content: 'keep me'})
    const child = repo.block(CHILD)
    await root.set(charExcludeProp, 'publish=exclude | #Draft')
    renderBlock(ROOT)
    await waitFor(() => expect(badgeText()).toBe('9'), {timeout: TIMEOUT_MS})

    await child.set(publishProp, 'exclude')
    await waitFor(() => expect(badgeText()).toBe('4'), {timeout: TIMEOUT_MS})

    await child.set(publishProp, 'article')
    await waitFor(() => expect(badgeText()).toBe('9'), {timeout: TIMEOUT_MS})

    await repo.addType(CHILD, 'draft')
    await waitFor(() => expect(badgeText()).toBe('4'), {timeout: TIMEOUT_MS})

    await repo.removeType(CHILD, 'draft')
    await waitFor(() => expect(badgeText()).toBe('9'), {timeout: TIMEOUT_MS})
  })

  it('shows a query error until the exclusion is corrected', async () => {
    const root = await seedTree({scope: 'subtree', profile: 'words'})
    await root.set(charExcludeProp, '#Draft misspelled=exclude')
    renderBlock(ROOT)
    await screen.findByText('Invalid exclusion query')
    await root.set(charExcludeProp, '#Draft')
    await repo.addType(GRANDCHILD, 'draft')
    await waitFor(() => expect(badgeText()).toBe('5'), {timeout: TIMEOUT_MS})
  })

  it('uses the counter subtree to bound an ancestor query', async () => {
    const root = await seedTree({type: WORD_COUNTER_TYPE})
    await root.set(charExcludeProp, `under=((${CHILD}))`)
    renderBlock(ROOT)
    await waitFor(() => expect(badgeText()).toBe('2'), {timeout: TIMEOUT_MS})
  })

  it('a word counter configured for its children counts each child', async () => {
    const root = await seedTree({type: WORD_COUNTER_TYPE, scope: 'children'})
    await repo.addType(CHILD, 'draft')
    await root.set(charExcludeProp, '#Draft')
    renderBlock(CHILD)
    await waitFor(() => expect(badgeText()).toBe('3'), {timeout: TIMEOUT_MS})
  })

  it('shows nothing for a block with a malformed types cell, and its child, instead of throwing', async () => {
    await seedTree({scope: 'self'})
    await repo.tx(async tx => { await tx.update(CHILD, {properties: {types: 'not-a-list'}}) }, {scope: ChangeScope.BlockDefault})
    expect(repo.block(CHILD).peek()!.properties.types).toBe('not-a-list')
    for (const id of [CHILD, GRANDCHILD]) {
      renderBlock(id)
      await screen.findByTestId('committed', {}, {timeout: TIMEOUT_MS})
      expect(screen.queryByLabelText(/count/i)).toBeNull()
      cleanup()
    }
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
