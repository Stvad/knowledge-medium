// @vitest-environment happy-dom
/** Repo-backed integration of the `#` pick flow. The unit tests cover
 *  the source in isolation; these pin the wiring contract that keeps
 *  the pick safe across the types-triggered editor remount: the tag
 *  write and command-span removal land in ONE tx (the cache row is
 *  never tagged-but-still-carrying-the-trigger command), and the create
 *  flow ends registered + applied. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { ChangeScope, defineBlockType } from '@/data/api'
import { typesFacet } from '@/data/facets'
import { getBlockTypes } from '@/data/properties'
import { getOrCreatePropertiesPage } from '@/data/propertiesPage'
import { getOrCreateTypesPage } from '@/data/typesPage'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'
import { buildTypeTagSource } from '../codeMirrorExtensions'

const WS = 'ws-supertags-pick'
const TIMEOUT_MS = 3_000

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

interface Harness {
  repo: Repo
  dispose: () => void
}

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const {repo} = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    extensions: [
      typesFacet.of(defineBlockType({id: 'task', label: 'Task'}), {source: 'test'}),
    ],
  })
  repo.setActiveWorkspaceId(WS)
  await getOrCreatePropertiesPage(repo, WS)
  await getOrCreateTypesPage(repo, WS)
  return {repo, dispose: () => repo.setActiveWorkspaceId(null)}
}

let env: Harness
afterEach(() => env.dispose())

const makeBlock = async (repo: Repo, content: string): Promise<string> => {
  const id = await repo.mutate.createChild({parentId: repo.typesPageId!})
  await repo.mutate.setContent({id, content})
  return id
}

/** Drive the source at end-of-doc and apply the option with the given
 *  label; waits for the block to end up tagged before returning.
 *  `applyTag` persists the stripped view content itself (in the tag's
 *  undo group), so a plain view is enough — no editor flush needed. */
const pickAt = async (
  repo: Repo,
  blockId: string,
  doc: string,
  optionLabel: string,
): Promise<void> => {
  const block = repo.block(blockId)
  await block.load()
  const source = buildTypeTagSource({repo, block})
  const view = new EditorView({state: EditorState.create({doc}), parent: document.body})
  try {
    const result = await source(new CompletionContext(view.state, doc.length, false))
    expect(result).not.toBeNull()
    const option = result!.options.find(o => o.label === optionLabel)
    expect(option, `expected "${optionLabel}" among: ${result!.options.map(o => o.label).join(', ')}`).toBeDefined()
    const apply = option!.apply as (v: EditorView, c: unknown, from: number, to: number) => void
    apply(view, option, result!.from, doc.length)
    await vi.waitFor(async () => {
      const data = await repo.load(blockId)
      expect(getBlockTypes(data!).length).toBeGreaterThan(0)
    }, {timeout: TIMEOUT_MS})
  } finally {
    view.destroy()
  }
}

describe('supertags pick integration', () => {
  it('tags the block and (via the editor flush) strips the command span from stored content', async () => {
    env = await setup()
    const blockId = await makeBlock(env.repo, 'call mom #ta')
    await pickAt(env.repo, blockId, 'call mom #ta', 'Task')
    const data = await env.repo.load(blockId)
    expect(getBlockTypes(data!)).toEqual(['task'])
    expect(data!.content).toBe('call mom')
  })

  it('#type turns the block ITSELF into a type named after its content', async () => {
    env = await setup()
    const blockId = await makeBlock(env.repo, 'Book #type')
    // "Type" is the built-in block-type meta-type, now offered in `#`.
    await pickAt(env.repo, blockId, 'Book #type', 'Type')

    const data = await env.repo.load(blockId)
    const types = getBlockTypes(data!)
    expect(types).toContain('block-type')
    expect(types).toContain('page')
    expect(data!.content).toBe('Book')
    expect(data!.properties['block-type:label']).toBe('Book')
    expect(data!.properties.alias).toEqual(['Book'])
    // The type doubles as its `[[Book]]` page — resolves to itself.
    const resolved = await env.repo.query.aliasLookup({workspaceId: WS, alias: 'Book'}).load()
    expect(resolved?.id).toBe(blockId)
  })

  it('create pick mints a registered type, tags the block, and strips the trigger', async () => {
    env = await setup()
    const blockId = await makeBlock(env.repo, 'dinner #recipe')
    await pickAt(env.repo, blockId, 'dinner #recipe', 'Create type "recipe"')
    const data = await env.repo.load(blockId)
    const [typeId] = getBlockTypes(data!)
    expect(typeId).toBeDefined()
    expect(env.repo.types.get(typeId)?.label).toBe('recipe')
    // Creation stamps a persisted palette color (least-used pick) so
    // fresh types don't hash-collide into look-alike chips.
    expect(env.repo.types.get(typeId)?.color).toMatch(/^oklch\(/)
    expect(data!.content).toBe('dinner')
  })

  it('strips the picked occurrence, not an earlier identical one (positional, never indexOf)', async () => {
    env = await setup()
    const blockId = await makeBlock(env.repo, 'see #ta note #ta')
    await pickAt(env.repo, blockId, 'see #ta note #ta', 'Task')
    const data = await env.repo.load(blockId)
    expect(getBlockTypes(data!)).toEqual(['task'])
    // An indexOf-based strip would produce 'see  note #ta'.
    expect(data!.content).toBe('see #ta note')
  })

  it('folds the strip and the tag into one undo entry (single cmd-Z reverts both)', async () => {
    env = await setup()
    const blockId = await makeBlock(env.repo, 'call mom #ta')
    await pickAt(env.repo, blockId, 'call mom #ta', 'Task')
    // Accepted: command span stripped from stored content + tagged.
    let data = await env.repo.load(blockId)
    expect(data!.content).toBe('call mom')
    expect(getBlockTypes(data!)).toEqual(['task'])
    // ONE undo reverts the WHOLE acceptance — the tag is removed AND the
    // `#ta` command text comes back. The strip and the tag are separate
    // txs folded into one undo group; without the group this undo would
    // revert only the tag and leave content at the stripped 'call mom'.
    expect(await env.repo.undo()).toBe(true)
    data = await env.repo.load(blockId)
    expect(getBlockTypes(data!)).toEqual([])
    expect(data!.content).toBe('call mom #ta')
  })

  it('persists the stripped view content so a lagging stored row does not corrupt the type name', async () => {
    env = await setup()
    // Stored content lags the view mid-trigger (the 300ms persistence
    // debounce hasn't caught up to the final "e"): a naive pick reading
    // stored content would register a type named "Book #typ". `applyTag`
    // instead persists the view's stripped content (`docAfter`, "Book")
    // in the tag's undo group before the typeify processor reads it.
    const blockId = await makeBlock(env.repo, 'Book #typ')
    const block = env.repo.block(blockId)
    await block.load()
    const source = buildTypeTagSource({repo: env.repo, block})

    // The view shows the full trigger (what the user actually typed).
    const view = new EditorView({state: EditorState.create({doc: 'Book #type'}), parent: document.body})
    try {
      const result = await source(new CompletionContext(view.state, 10, false))
      const option = result!.options.find(o => o.label === 'Type')!
      const apply = option.apply as (v: EditorView, c: unknown, from: number, to: number) => void
      apply(view, option, result!.from, 10)
      await vi.waitFor(async () => {
        const data = await env.repo.load(blockId)
        expect(getBlockTypes(data!)).toContain('block-type')
        expect(data!.properties['block-type:label']).toBe('Book')
        expect(data!.properties.alias).toEqual(['Book'])
      }, {timeout: TIMEOUT_MS})
    } finally {
      view.destroy()
    }
  })

  it('a failed create pick with an unmounted view restores the command span into stored content', async () => {
    env = await setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const blockId = await makeBlock(env.repo, 'dinner #recipe')
      const block = env.repo.block(blockId)
      await block.load()
      const source = buildTypeTagSource({repo: env.repo, block})
      const view = new EditorView({state: EditorState.create({doc: 'dinner #recipe'}), parent: document.body})
      const result = await source(new CompletionContext(view.state, 14, false))
      const option = result!.options.find(o => o.label === 'Create type "recipe"')!
      // Sabotage the create flow: no Types page → createTypeBlock
      // throws before minting anything.
      await env.repo.tx(async tx => { await tx.delete(env.repo.typesPageId!) }, {scope: ChangeScope.BlockDefault})
      // Simulate the editor having persisted the view deletion and
      // unmounted (navigate-away) before the failure lands.
      await env.repo.mutate.setContent({id: blockId, content: 'dinner'})
      const apply = option.apply as (v: EditorView, c: unknown, from: number, to: number) => void
      apply(view, option, result!.from, 14)
      view.destroy()
      await vi.waitFor(async () => {
        const data = await env.repo.load(blockId)
        expect(data!.content).toBe('dinner #recipe')
      }, {timeout: TIMEOUT_MS})
      expect(getBlockTypes((await env.repo.load(blockId))!)).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it('a STALE create sentinel picked after the type published reuses it — no duplicate-label mint', async () => {
    env = await setup()
    const first = await makeBlock(env.repo, 'a #recipe')
    const second = await makeBlock(env.repo, 'b #recipe')

    // Capture BOTH dropdowns before any create publishes — both offer
    // the create sentinel.
    const blockB = env.repo.block(second)
    await blockB.load()
    const sourceB = buildTypeTagSource({repo: env.repo, block: blockB})
    const viewB = new EditorView({state: EditorState.create({doc: 'b #recipe'}), parent: document.body})
    try {
      const staleResultB = await sourceB(new CompletionContext(viewB.state, 9, false))
      const staleCreateB = staleResultB!.options.find(o => o.label === 'Create type "recipe"')
      expect(staleCreateB).toBeDefined()

      // First create runs to completion (registered + applied).
      await pickAt(env.repo, first, 'a #recipe', 'Create type "recipe"')
      const firstTypeId = getBlockTypes((await env.repo.load(first))!)[0]

      // Now apply the STALE sentinel on block B — pickType's registry
      // re-check must reuse the published type instead of minting a
      // second "recipe".
      const apply = staleCreateB!.apply as (v: EditorView, c: unknown, from: number, to: number) => void
      apply(viewB, staleCreateB, staleResultB!.from, 9)
      await vi.waitFor(async () => {
        const data = await env.repo.load(second)
        expect(getBlockTypes(data!)).toEqual([firstTypeId])
      }, {timeout: TIMEOUT_MS})
      const recipeTypes = Array.from(env.repo.types.values())
        .filter(t => t.label === 'recipe')
      expect(recipeTypes).toHaveLength(1)
    } finally {
      viewB.destroy()
    }
  })
})
