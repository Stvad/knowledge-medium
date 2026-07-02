// @vitest-environment jsdom
/** Repo-backed integration of the `#` pick flow. The unit tests cover
 *  the source in isolation; these pin the wiring contract that keeps
 *  the pick safe across the types-triggered editor remount: the tag
 *  write and the trigger-text removal land in ONE tx (the cache row is
 *  never tagged-but-still-carrying-the-trigger), and the create flow
 *  ends registered + applied. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { defineBlockType } from '@/data/api'
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
  const disposeSchemas = repo.userSchemas.start()
  const disposeTypes = repo.userTypes.start()
  return {repo, dispose: () => { disposeTypes(); disposeSchemas() }}
}

let env: Harness
afterEach(() => env.dispose())

const makeBlock = async (repo: Repo, content: string): Promise<string> => {
  const id = await repo.mutate.createChild({parentId: repo.typesPageId!})
  await repo.mutate.setContent({id, content})
  return id
}

/** Drive the source at end-of-doc and apply the option with the given
 *  label; waits for the block to end up tagged before returning. */
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
  it('tags the block and strips the trigger text from stored content in the same committed state', async () => {
    env = await setup()
    const blockId = await makeBlock(env.repo, 'call mom #ta')
    await pickAt(env.repo, blockId, 'call mom #ta', 'Task')
    const data = await env.repo.load(blockId)
    expect(getBlockTypes(data!)).toEqual(['task'])
    expect(data!.content).toBe('call mom ')
  })

  it('create pick mints a registered type, tags the block, and strips the trigger', async () => {
    env = await setup()
    const blockId = await makeBlock(env.repo, 'dinner #recipe')
    await pickAt(env.repo, blockId, 'dinner #recipe', 'Create type "recipe"')
    const data = await env.repo.load(blockId)
    const [typeId] = getBlockTypes(data!)
    expect(typeId).toBeDefined()
    expect(env.repo.types.get(typeId)?.label).toBe('recipe')
    expect(data!.content).toBe('dinner ')
  })

  it('strips the picked occurrence, not an earlier identical one (positional, never indexOf)', async () => {
    env = await setup()
    const blockId = await makeBlock(env.repo, 'see #ta note #ta')
    await pickAt(env.repo, blockId, 'see #ta note #ta', 'Task')
    const data = await env.repo.load(blockId)
    expect(getBlockTypes(data!)).toEqual(['task'])
    // An indexOf-based strip would produce 'see  note #ta'.
    expect(data!.content).toBe('see #ta note ')
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
