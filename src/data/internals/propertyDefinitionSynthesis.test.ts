// @vitest-environment node
/**
 * §9 orphan-definition synthesis: which definition-less cell keys get a
 * definition, which ones cannot have one, and that a synthesized definition
 * actually carries its key's existing values through the child machinery
 * unchanged.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, seedProperty } from '@/data/api'
import { definitionSeedsFacet } from '@/data/facets'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { PROPERTY_CELL_BACKFILL_ID } from './propertyCellBackfill'
import {
  applyPropertyDefinitionSynthesis,
  flipBlockedBySynthesis,
  inferPresetId,
  planPropertyDefinitionSynthesis,
  synthesizedPropertyDefinitionBlockId,
} from './propertyDefinitionSynthesis'

const WS = 'ws-synthesis'

const declaredProp = seedProperty({
  seedKey: 'test/property/declared',
  revision: 1,
  name: 'demo:declared',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

/** The workspace row synthesis reads its encryption mode from. Raw, because
 *  that is how the row arrives — server-written and synced. */
const seedWorkspaceRow = async (encryptionMode = 'none', migration = 'cell') => {
  await sharedDb.db.execute(
    `INSERT OR REPLACE INTO workspaces
       (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary,
        properties_migration)
     VALUES (?, ?, ?, 1, 1, ?, NULL, ?)`,
    [WS, 'ws', 'user-1', encryptionMode, migration])
}

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}}).repo
  repo.setActiveWorkspaceId(WS)
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    definitionSeedsFacet.of(declaredProp, {source: 'test'}),
  ], {repo, workspaceId: WS, safeMode: false}))
  await seedWorkspaceRow()
})

/** A cell written WITHOUT the tx layer — the shape a raw bag writer or an
 *  import leaves, and the only way to store a key no schema declares
 *  (`tx.setProperty` resolves the name and would refuse). */
const rawCell = async (id: string, properties: Record<string, unknown>) => {
  await repo.tx(async tx => {
    await tx.create({id, workspaceId: WS, parentId: null, orderKey: `k-${id}`, content: id})
  }, {scope: ChangeScope.BlockDefault, description: 'seed'})
  await sharedDb.db.execute(
    `UPDATE blocks SET properties_json = ? WHERE id = ?`,
    [JSON.stringify(properties), id])
}

const planFor = () => planPropertyDefinitionSynthesis(repo, WS)

const candidateFor = async (key: string) =>
  (await planFor()).candidates.find(c => c.key === key)

describe('inferPresetId', () => {
  it('picks the narrowest preset that can carry every stored value', () => {
    expect(inferPresetId({booleans: 3, numbers: 0, texts: 0, others: 0})).toBe('boolean')
    expect(inferPresetId({booleans: 0, numbers: 3, texts: 0, others: 0})).toBe('number')
    expect(inferPresetId({booleans: 0, numbers: 0, texts: 3, others: 0})).toBe('string')
  })

  it('falls back to raw-json for mixed or structured values', () => {
    expect(inferPresetId({booleans: 1, numbers: 1, texts: 0, others: 0})).toBe('raw-json')
    expect(inferPresetId({booleans: 0, numbers: 0, texts: 1, others: 1})).toBe('raw-json')
    // A null cell is not a string, a number or a boolean; only the identity
    // codec reads it back as itself.
    expect(inferPresetId({booleans: 0, numbers: 0, texts: 0, others: 2})).toBe('raw-json')
  })
})

describe('planPropertyDefinitionSynthesis', () => {
  it('offers a definition-less key, with its cell count and a preset its values fit', async () => {
    await rawCell('b1', {'demo:orphan': 'hello'})
    await rawCell('b2', {'demo:orphan': 'world'})

    const candidate = await candidateFor('demo:orphan')
    expect(candidate).toEqual({key: 'demo:orphan', cells: 2, presetId: 'string', notes: []})
  })

  it('says nothing about a key a seed already declares', async () => {
    await rawCell('b1', {[declaredProp.name]: 'value'})
    expect(await candidateFor(declaredProp.name)).toBeUndefined()
  })

  it('reports a key whose definition exists but is broken, instead of minting a rival', async () => {
    // A live `property-schema` block with an invalid change-scope:
    // `parsePropertyDefinitionMetadata` returns null, so the name resolves to
    // nothing while the definition block is right there. A second definition
    // would collide in the winner machinery rather than repair anything.
    await rawCell('defn', {
      types: ['property-schema'],
      'property-schema:name': 'demo:broken',
      'property-schema:change-scope': 'not-a-real-scope',
    })
    await rawCell('b1', {'demo:broken': 'x'})

    const plan = await planFor()
    expect(plan.candidates.map(c => c.key)).not.toContain('demo:broken')
    expect(plan.brokenDefinitions).toContainEqual({key: 'demo:broken', cells: 1})
  })

  it('refuses the empty key and a name that reads as a reference', async () => {
    await rawCell('b1', {'': 'x', '::((11111111-1111-4111-8111-111111111111))': 'y'})

    const plan = await planFor()
    expect(plan.candidates).toEqual([])
    expect(plan.blockers.map(b => b.key).sort())
      .toEqual(['', '::((11111111-1111-4111-8111-111111111111))'])
  })

  it('keeps an awkward-but-storable name verbatim and says what is awkward about it', async () => {
    await rawCell('b1', {' padded ': 'x', 'has]]bracket': 'y'})

    const plan = await planFor()
    expect(plan.blockers).toEqual([])
    const padded = plan.candidates.find(c => c.key === ' padded ')
    expect(padded?.notes.join(' ')).toMatch(/whitespace/)
    const bracket = plan.candidates.find(c => c.key === 'has]]bracket')
    expect(bracket?.notes.join(' ')).toMatch(/\[\[name\]\]/)
  })

  it('refuses an e2ee workspace, while still saying what it would have minted', async () => {
    await seedWorkspaceRow('e2ee')
    await rawCell('b1', {'demo:orphan': 'x'})

    const plan = await planFor()
    expect(plan.refusal).toMatch(/end-to-end encrypted/)
    // Not short-circuited to nothing: "e2ee with no orphans" and "e2ee with
    // twelve" are different situations and only the second blocks anything.
    expect(plan.candidates.map(c => c.key)).toEqual(['demo:orphan'])
  })

  it('refuses to WRITE to an e2ee workspace even when handed a plan', async () => {
    await rawCell('b1', {'demo:orphan': 'x'})
    const plan = await planFor()
    await seedWorkspaceRow('e2ee')

    await expect(applyPropertyDefinitionSynthesis(repo, plan))
      .rejects.toThrow(/end-to-end encrypted/)
  })

  it('refuses when this device has no workspace row, rather than assuming plaintext', async () => {
    await sharedDb.db.execute('DELETE FROM workspaces WHERE id = ?', [WS])
    await rawCell('b1', {'demo:orphan': 'x'})

    expect((await planFor()).refusal).toMatch(/encryption mode is unknown/)
  })
})

describe('applyPropertyDefinitionSynthesis', () => {
  it('mints a definition the registry resolves before the caller does anything else', async () => {
    await rawCell('b1', {'demo:orphan': 'hello'})

    const result = await applyPropertyDefinitionSynthesis(repo, await planFor())
    expect(result.created).toBe(1)

    // Synchronously, not after a subscription tick: the caller's very next
    // step is the backfill, which asks this same resolver to resolve the name.
    expect(repo.propertySchemaResolverFor(WS).resolve('demo:orphan').status).toBe('resolved')
  })

  it('mints it hidden, at the deterministic id, with no seed provenance', async () => {
    await rawCell('b1', {'demo:orphan': 'hello'})
    await applyPropertyDefinitionSynthesis(repo, await planFor())

    const id = synthesizedPropertyDefinitionBlockId(WS, 'demo:orphan')
    const row = repo.block(id).peek()
    expect(row).toBeDefined()
    expect(row!.properties['property-schema:hidden']).toBe(true)
    expect(row!.properties['property-schema:name']).toBe('demo:orphan')
    // User origin, not a code seed: a seeded id would put it in a namespace
    // whose owner is expected to re-materialize it.
    expect(repo.propertyDefinitions?.definitionsByFieldId.get(id)?.origin).toBe('user')
  })

  it('carries the key through the backfill with the stored value unchanged', async () => {
    // The whole point. Before synthesis this key is the one class of property
    // data a flipped workspace cannot make child-backed.
    await rawCell('b1', {'demo:orphan': 'hello'})
    await applyPropertyDefinitionSynthesis(repo, await planFor())
    await sharedDb.db.execute(
      `UPDATE workspaces SET properties_migration = 'children' WHERE id = ?`, [WS])

    expect((await repo.runWorkspaceBackfillNow(WS, PROPERTY_CELL_BACKFILL_ID)).outcome)
      .toBe('ran')

    const children = await repo.db.getAll<{content: string}>(
      `SELECT c.content AS content FROM blocks f
         JOIN blocks c ON c.parent_id = f.id
        WHERE f.parent_id = 'b1' AND f.is_field_form = 1`)
    expect(children.map(c => c.content)).toEqual(['hello'])
    // And the cell is still exactly what it was — a synthesized definition
    // must not rewrite the values it is applied to retroactively.
    const cell = await repo.db.get<{properties_json: string}>(
      `SELECT properties_json FROM blocks WHERE id = 'b1'`)
    expect(JSON.parse(cell.properties_json)).toEqual({'demo:orphan': 'hello'})
  })

  it('is a no-op on a second run', async () => {
    await rawCell('b1', {'demo:orphan': 'hello'})
    await applyPropertyDefinitionSynthesis(repo, await planFor())

    const second = await planFor()
    expect(second.candidates).toEqual([])
    expect(await applyPropertyDefinitionSynthesis(repo, second))
      .toEqual({created: 0, restored: 0, skipped: []})
  })

  it('restores a synthesized definition someone deleted, rather than minting a rival', async () => {
    await rawCell('b1', {'demo:orphan': 'hello'})
    await applyPropertyDefinitionSynthesis(repo, await planFor())
    const id = synthesizedPropertyDefinitionBlockId(WS, 'demo:orphan')
    await repo.tx(async tx => { await tx.delete(id) },
                  {scope: ChangeScope.BlockDefault, description: 'delete definition'})

    const plan = await planFor()
    expect(plan.candidates.map(c => c.key)).toEqual(['demo:orphan'])
    expect(await applyPropertyDefinitionSynthesis(repo, plan))
      .toMatchObject({created: 0, restored: 1})
  })

  it('still mints the keys it can when another key is a hard blocker', async () => {
    // The blocker blocks the FLIP, not the minting: the other key's definition
    // is useful either way, and `flipBlockedBySynthesis` is what refuses.
    await rawCell('b1', {'demo:orphan': 'x', '': 'y'})

    const plan = await planFor()
    expect(plan.candidates.map(c => c.key)).toEqual(['demo:orphan'])
    expect(await applyPropertyDefinitionSynthesis(repo, plan)).toMatchObject({created: 1})
  })
})

describe('flipBlockedBySynthesis', () => {
  it('blocks on a key no definition can ever back, naming it', async () => {
    await rawCell('b1', {'': 'y'})
    expect(flipBlockedBySynthesis(await planFor())).toMatch(/empty property key/)
  })

  it('blocks an e2ee workspace that has orphan keys', async () => {
    await seedWorkspaceRow('e2ee')
    await rawCell('b1', {'demo:orphan': 'x'})
    expect(flipBlockedBySynthesis(await planFor())).toMatch(/end-to-end encrypted/)
  })

  it('lets an e2ee workspace with nothing to mint through', async () => {
    // The refusal is about MINTING a dictionary-testable id. With no orphan
    // keys there is nothing to mint, so the invariant already holds.
    await seedWorkspaceRow('e2ee')
    await rawCell('b1', {[declaredProp.name]: 'x'})
    expect(flipBlockedBySynthesis(await planFor())).toBeNull()
  })

  it('lets a clean workspace through', async () => {
    await rawCell('b1', {'demo:orphan': 'x'})
    await applyPropertyDefinitionSynthesis(repo, await planFor())
    expect(flipBlockedBySynthesis(await planFor())).toBeNull()
  })
})
