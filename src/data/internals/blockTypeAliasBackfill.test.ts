// @vitest-environment node

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { BLOCK_TYPE_TYPE, PAGE_TYPE } from '@/data/blockTypes'
import { typeDefinitionBlockId } from '@/data/definitionSeeds'
import { keyAtEnd } from '@/data/orderKey'
import {
  aliasesProp,
  blockTypeLabelProp,
  getAliases,
  seedKeyProp,
  typesProp,
} from '@/data/properties'
import { getOrCreateTypesPage } from '@/data/typesPage'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { aliasDataExtension } from '@/plugins/alias/dataExtension'

const WS = 'ws-block-type-alias-backfill'

interface Harness {
  h: TestDb
  repo: Repo
}

let sharedDb: TestDb
let env: Harness

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const { repo } = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    // The alias plugin is loaded so the backfill's alias writes run against
    // the REAL content<->alias sync, not in isolation.
    extensions: [aliasDataExtension],
  })
  repo.setActiveWorkspaceId(WS)
  await getOrCreateTypesPage(repo, WS)
  return {h: sharedDb, repo}
}

/** A type block in the shape it had BEFORE the write-time alias claim
 *  landed: `block-type` + `page` tagged, label + content set, no alias.
 *
 *  Built with a raw `db.writeTransaction` on purpose — going through
 *  `repo.tx` would fire `core.blockTypeTypeify`, which claims the alias and
 *  makes the row un-legacy. The raw write still maintains the
 *  trigger-backed `block_aliases` index, which is what the backfill's
 *  claimant check reads. */
const makeLegacyType = async (
  repo: Repo,
  label: string,
  extraProps: Record<string, unknown> = {},
): Promise<string> => {
  const id = await repo.mutate.createChild({parentId: repo.typesPageId!})
  await writeLegacyTypeShape(repo, id, label, extraProps)
  return id
}

/** The raw `UPDATE` behind `makeLegacyType`, split out so the seed-owned case
 *  can drive it at a deterministic `/type/` id (`seededDefinitionKey` only
 *  recognises a seed row whose id satisfies the hash for its own workspace). */
const writeLegacyTypeShape = async (
  repo: Repo,
  id: string,
  label: string,
  extraProps: Record<string, unknown>,
): Promise<void> => {
  const row = await repo.load(id)
  if (!row) throw new Error(`missing block ${id}`)
  await sharedDb.db.writeTransaction(async tx => {
    await tx.execute(
      'UPDATE blocks SET content = ?, properties_json = ? WHERE id = ?',
      [
        label,
        JSON.stringify({
          ...row.properties,
          [typesProp.name]: [BLOCK_TYPE_TYPE, PAGE_TYPE],
          [blockTypeLabelProp.name]: label,
          ...extraProps,
        }),
        id,
      ],
    )
  })
}

/** A live page claiming `alias` — the rival the backfill must not rob. */
const makeAliasedPage = async (repo: Repo, alias: string): Promise<string> => {
  const id = await repo.mutate.createChild({parentId: repo.typesPageId!})
  await repo.tx(async tx => {
    await tx.update(id, {content: alias})
    await tx.setProperty(id, aliasesProp, [alias])
  }, {scope: ChangeScope.BlockDefault})
  return id
}

const runBackfill = async (repo: Repo): Promise<void> => {
  repo.scheduleWorkspaceBackfills(WS)
  await vi.runAllTimersAsync()
  await repo.awaitWorkspaceBackfills()
  await repo.awaitProcessors()
}

const aliasesOf = async (repo: Repo, id: string): Promise<readonly string[]> => {
  const row = await repo.load(id)
  if (!row) throw new Error(`missing block ${id}`)
  return getAliases(row)
}

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
afterEach(() => { vi.useRealTimers() })

describe('blockTypeNameAliasBackfill', () => {
  it('claims the label so [[label]] resolves to a legacy type block', async () => {
    vi.useFakeTimers()
    env = await setup()
    const id = await makeLegacyType(env.repo, 'Author')
    expect(await aliasesOf(env.repo, id)).toEqual([])

    await runBackfill(env.repo)

    expect(await aliasesOf(env.repo, id)).toEqual(['Author'])
    const resolved = await env.repo.query.aliasLookup({workspaceId: WS, alias: 'Author'}).load()
    expect(resolved?.id).toBe(id)
  })

  it('appends to — never replaces — an alias set the user already curated', async () => {
    vi.useFakeTimers()
    env = await setup()
    const id = await makeLegacyType(env.repo, 'Author', {[aliasesProp.name]: ['Scribe']})

    await runBackfill(env.repo)

    expect(await aliasesOf(env.repo, id)).toEqual(['Scribe', 'Author'])
  })

  it('leaves the type alias-less when another block already claims the name', async () => {
    vi.useFakeTimers()
    env = await setup()
    const pageId = await makeAliasedPage(env.repo, 'Author')
    const typeId = await makeLegacyType(env.repo, 'Author')
    // A bystander in the SAME batch tx. Without the in-tx claimant check the
    // colliding `setProperty` trips `block_aliases_workspace_alias_unique` and
    // rolls the whole batch back, so this is what proves the veto is doing the
    // work rather than the storage trigger catching it after the damage.
    const bystanderId = await makeLegacyType(env.repo, 'Publisher')

    await runBackfill(env.repo)

    expect(await aliasesOf(env.repo, typeId)).toEqual([])
    expect(await aliasesOf(env.repo, pageId)).toEqual(['Author'])
    expect(await aliasesOf(env.repo, bystanderId)).toEqual(['Publisher'])
    const resolved = await env.repo.query.aliasLookup({workspaceId: WS, alias: 'Author'}).load()
    expect(resolved?.id).toBe(pageId)
  })

  it('claims for the first of two same-named legacy types and skips the second', async () => {
    vi.useFakeTimers()
    env = await setup()
    // Both land in ONE batch tx, so the in-tx claimant check is what prevents
    // the uniqueness trigger from rolling the whole batch back.
    const first = await makeLegacyType(env.repo, 'Author')
    const second = await makeLegacyType(env.repo, 'Author')

    await runBackfill(env.repo)

    const claimed = [await aliasesOf(env.repo, first), await aliasesOf(env.repo, second)]
    expect(claimed.filter(a => a.includes('Author'))).toHaveLength(1)
    expect(claimed).toContainEqual([])
  })

  it('skips seed-owned type blocks without aborting the rest of the batch', async () => {
    vi.useFakeTimers()
    env = await setup()
    // A seed row is only recognised as one at its deterministic id, so mint it
    // there rather than at a generated id (which would make the guard vacuous).
    const seedKey = 'system:kernel-data/type/page'
    const seedRowId = typeDefinitionBlockId(WS, seedKey)
    await env.repo.tx(async tx => {
      await tx.createOrGet({
        id: seedRowId,
        workspaceId: WS,
        parentId: env.repo.typesPageId!,
        orderKey: keyAtEnd(),
        content: 'Page',
      })
    }, {scope: ChangeScope.BlockDefault})
    await writeLegacyTypeShape(env.repo, seedRowId, 'Page', {[seedKeyProp.name]: seedKey})
    const userTypeId = await makeLegacyType(env.repo, 'Author')

    await runBackfill(env.repo)

    // Code types were never `[[Label]]` pages — and, more sharply, editing a
    // seed-materialized row is refused outright by the structural-edit policy
    // ("its bag is code-owned"), which THROWS. Reaching one un-skipped would
    // abort the whole run, marker included, so the bystander's claim is what
    // proves the skip happened before the write rather than after it.
    expect(await aliasesOf(env.repo, seedRowId)).toEqual([])
    expect(await aliasesOf(env.repo, userTypeId)).toEqual(['Author'])
  })

  it('skips a label-less type block instead of naming it from content', async () => {
    vi.useFakeTimers()
    env = await setup()
    const id = await makeLegacyType(env.repo, '')
    await sharedDb.db.writeTransaction(async tx => {
      await tx.execute('UPDATE blocks SET content = ? WHERE id = ?', ['scratch', id])
    })

    await runBackfill(env.repo)

    expect(await aliasesOf(env.repo, id)).toEqual([])
  })

  it('is idempotent and no-ops on a type that already claims its label', async () => {
    vi.useFakeTimers()
    env = await setup()
    const id = await makeLegacyType(env.repo, 'Author', {[aliasesProp.name]: ['Author']})

    await runBackfill(env.repo)

    expect(await aliasesOf(env.repo, id)).toEqual(['Author'])
  })

  it('re-derives pre-existing [[label]] references onto the type block', async () => {
    env = await setup()
    // Mirror production ordering: the per-open derive sweep must have run
    // before `scheduleReferenceTargetNameRederive` accumulates anything (it
    // no-ops pre-sweep by design, since the sweep covers every name).
    await env.repo.whenPropertyDefinitionsReady(WS)
    vi.useFakeTimers()
    env.repo.scheduleReferenceTargetDerivePass(WS)
    await vi.runAllTimersAsync()
    await env.repo.awaitReferenceTargetDerive()

    const typeId = await makeLegacyType(env.repo, 'Author')
    // A reference written while nothing claimed "Author" stamps NULL, and
    // nothing content-driven ever revisits it — the CLAIM is the trigger. The
    // backfill writes through `repo.tx`, so `core.aliasClaimRederive` fires and
    // the stale row re-binds without a reload.
    const refId = await env.repo.mutate.createChild({parentId: env.repo.typesPageId!})
    await env.repo.tx(async tx => {
      await tx.update(refId, {content: '[[Author]]'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.awaitProcessors()
    expect((await env.repo.load(refId))?.referenceTargetId ?? null).toBeNull()

    await runBackfill(env.repo)

    await vi.waitFor(async () => {
      await env.repo.awaitReferenceTargetDerive()
      expect((await env.repo.load(refId))?.referenceTargetId).toBe(typeId)
    })
  })
})
