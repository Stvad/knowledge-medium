// @vitest-environment node
/**
 * §9 orphan-definition synthesis: which definition-less cell keys get a
 * definition, which ones cannot have one, and that a synthesized definition
 * actually carries its key's existing values through the child machinery
 * unchanged.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, seedProperty } from '@/data/api'
import { presetIdProp, propertyNameProp } from '@/data/properties'
import { getOrCreatePropertiesPage } from '@/data/propertiesPage'
import { definitionSeedsFacet } from '@/data/facets'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { confirmPlaintextForSession } from '@/sync/keys/modePin'
import { PROPERTY_CELL_BACKFILL_ID } from './propertyCellBackfill'
import {
  applyPropertyDefinitionSynthesis,
  flipBlockedBySynthesis,
  inferPresetId,
  propertySynthesisWorkspaceRefusal,
  planPropertyDefinitionSynthesis,
  synthesizedPropertyDefinitionBlockId,
} from './propertyDefinitionSynthesis'

const WS = 'ws-synthesis'
/** Never confirmed plaintext, so `getModePin` reports null for it — the shape
 *  of an e2ee workspace, and of any workspace this device has not resolved. */
const UNPINNED_WS = 'ws-synthesis-unpinned'
const USER = 'user-1'

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
afterEach(() => { vi.restoreAllMocks() })

/** The workspace row synthesis reads its encryption mode from. Raw, because
 *  that is how the row arrives — server-written and synced. */
const seedWorkspaceRow = async (encryptionMode = 'none', workspaceId = WS) => {
  await sharedDb.db.execute(
    `INSERT OR REPLACE INTO workspaces
       (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary,
        properties_migration)
     VALUES (?, ?, ?, 1, 1, ?, NULL, 'cell')`,
    [workspaceId, 'ws', USER, encryptionMode])
}

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: {id: USER}}).repo
  repo.setActiveWorkspaceId(WS)
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    definitionSeedsFacet.of(declaredProp, {source: 'test'}),
  ], {repo, workspaceId: WS, safeMode: false}))
  await seedWorkspaceRow()
  // The real pin, not a mock: `workspaceAccess.ts` puts every unpinned
  // workspace through the first-encounter gate and confirming plaintext there
  // pins it, so this is the state any workspace an operator has open is in.
  confirmPlaintextForSession(USER, WS)
})

/** A cell written WITHOUT the tx layer — the shape a raw bag writer or an
 *  import leaves, and the only way to store a key no schema declares
 *  (`tx.setProperty` resolves the name and would refuse). */
const rawCell = async (
  id: string, properties: Record<string, unknown>, workspaceId = WS,
) => {
  await repo.tx(async tx => {
    await tx.create({id, workspaceId, parentId: null, orderKey: `k-${id}`, content: id})
  }, {scope: ChangeScope.BlockDefault, description: 'seed'})
  await sharedDb.db.execute(
    `UPDATE blocks SET properties_json = ? WHERE id = ?`,
    [JSON.stringify(properties), id])
}

const planFor = () => planPropertyDefinitionSynthesis(repo, WS)

/** Fence on the registry having caught up with a definition write.
 *
 *  The property-definition registry is a projector-driven projection of the
 *  definition BLOCKS, and `whenPropertyDefinitionsReady` awaits only the
 *  initial prime, not catch-up. Planning straight after a write therefore reads
 *  the pre-write world — which made one of these tests fail about 1 run in 25
 *  before this existed. */
const untilKeyUnresolved = (key: string) => vi.waitFor(() =>
  expect(repo.propertySchemaResolverFor(WS).resolve(key).status).not.toBe('resolved'))

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
    expect(candidate).toEqual({key: 'demo:orphan', cells: 2, presetId: 'string'})
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

  it('keeps an awkward-but-storable name verbatim rather than trimming it', async () => {
    // `addSchema` is not the path here precisely because it trims: it would
    // mint "padded" for the cell key " padded " and leave the original still
    // definition-less, which is unsatisfiable against the flip gate.
    await rawCell('b1', {' padded ': 'x', 'has]]bracket': 'y'})

    const plan = await planFor()
    expect(plan.blockers).toEqual([])
    expect(plan.candidates.map(c => c.key).sort()).toEqual([' padded ', 'has]]bracket'])
  })

  it('refuses a key the database could not hand back faithfully', async () => {
    // A lone UTF-16 surrogate in a property key comes back from `json_each` as
    // replacement characters (measured: three U+FFFD for "\ud800"), so what the
    // scan sees is not what the data holds. Minting for the mangled spelling
    // would leave the real key orphaned while the flip gate counted it covered.
    await rawCell('b1', {'\ud800': 'x'})

    const plan = await planFor()
    expect(plan.candidates).toEqual([])
    expect(plan.blockers[0]!.reason).toMatch(/replacement character/)
  })

  it('refuses a workspace this device has not confirmed unencrypted', async () => {
    // The authority is the mode pin, not the server column — and note the row
    // here says 'none', so a denylist on the column would wave this through.
    await seedWorkspaceRow('none', UNPINNED_WS)

    expect(await propertySynthesisWorkspaceRefusal(repo, UNPINNED_WS))
      .toMatch(/has not confirmed/)
  })

  it('still says what it would have minted when the workspace is refused', async () => {
    // Not short-circuited to nothing: "refused with no orphans" and "refused
    // with twelve" are different situations, and only the second blocks
    // anything.
    await seedWorkspaceRow('e2ee')
    await rawCell('b1', {'demo:orphan': 'x'})

    const plan = await planFor()
    expect(plan.refusal).not.toBeNull()
    expect(plan.candidates.map(c => c.key)).toEqual(['demo:orphan'])
  })

  it('refuses when the pin says plaintext but the row says otherwise', async () => {
    // A contradiction, and on a privacy question a contradiction resolves
    // closed rather than picking the friendlier answer.
    await seedWorkspaceRow('e2ee')
    await rawCell('b1', {'demo:orphan': 'x'})

    expect((await planFor()).refusal).toMatch(/pinned as unencrypted but its row reads/)
  })

  it('refuses to WRITE once this device has fallen behind, even with a clean plan', async () => {
    // The gap can open while the operator reads the confirmation. A device that
    // has not received a definition yet would mint a RIVAL for it, and the
    // loser strands every field row that bound to it.
    await rawCell('b1', {'demo:orphan': 'x'})
    const plan = await planFor()
    vi.spyOn(repo, 'syncViewGap').mockResolvedValue('this device is not caught up')

    await expect(applyPropertyDefinitionSynthesis(repo, plan))
      .rejects.toThrow(/not caught up/)
    expect(repo.block(synthesizedPropertyDefinitionBlockId(WS, 'demo:orphan')).peek())
      .toBeUndefined()
  })

  it('refuses to WRITE once the workspace stops reading as plaintext, even with a clean plan', async () => {
    await rawCell('b1', {'demo:orphan': 'x'})
    const plan = await planFor()
    await seedWorkspaceRow('e2ee')

    await expect(applyPropertyDefinitionSynthesis(repo, plan))
      .rejects.toThrow(/pinned as unencrypted but its row reads/)
  })

  it('refuses when this device has no workspace row, rather than assuming plaintext', async () => {
    await sharedDb.db.execute('DELETE FROM workspaces WHERE id = ?', [WS])
    await rawCell('b1', {'demo:orphan': 'x'})

    expect((await planFor()).refusal).toMatch(/its row reads null/)
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
      .toEqual({created: 0, restored: 0, converged: 0, skipped: []})
  })

  it('restores a synthesized definition someone deleted, rather than minting a rival', async () => {
    await rawCell('b1', {'demo:orphan': 'hello'})
    await applyPropertyDefinitionSynthesis(repo, await planFor())
    const id = synthesizedPropertyDefinitionBlockId(WS, 'demo:orphan')
    await repo.tx(async tx => { await tx.delete(id) },
                  {scope: ChangeScope.BlockDefault, description: 'delete definition'})
    await untilKeyUnresolved('demo:orphan')

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

describe('applyPropertyDefinitionSynthesis: the id is occupied, or the key stopped being orphaned', () => {
  it('skips a key that gained a definition while the plan was on screen, rather than minting a rival', async () => {
    // The runbook this migration prints tells the operator to enable a key's
    // owning extension FIRST — which is exactly the write that lands in the
    // window the confirmation dialog holds open.
    await rawCell('b1', {'demo:orphan': 'hello'})
    const plan = await planFor()
    await getOrCreatePropertiesPage(repo, WS)
    await repo.userSchemas.addSchema({name: 'demo:orphan', presetId: 'string'})

    const result = await applyPropertyDefinitionSynthesis(repo, plan)

    // Converged, not skipped: the key HAS a definition now, which is the
    // invariant. Whose it is doesn't matter.
    expect(result).toMatchObject({created: 0, converged: 1, skipped: []})
    // One definition for the name, not two: a rival strands whatever field rows
    // bind to the loser's fieldId.
    const definitions = await repo.db.getAll<{n: number}>(
      `SELECT COUNT(*) AS n FROM blocks b JOIN block_types t ON t.block_id = b.id
        WHERE t.type = 'property-schema' AND b.workspace_id = ? AND b.deleted = 0
          AND json_extract(b.properties_json, '$."property-schema:name"') = 'demo:orphan'`,
      [WS])
    expect(definitions[0]!.n).toBe(1)
  })

  it('reports an already-defined key as converged rather than minting again', async () => {
    await rawCell('b1', {'demo:orphan': 'hello'})
    const plan = await planFor()
    await applyPropertyDefinitionSynthesis(repo, plan)

    // The SAME plan again — the stale-plan shape, and what a second device sees.
    const again = await applyPropertyDefinitionSynthesis(repo, plan)

    expect(again).toMatchObject({created: 0, restored: 0, converged: 1, skipped: []})
  })

  it('skips a key whose deterministic id stopped being its definition', async () => {
    await rawCell('b1', {'demo:orphan': 'hello'})
    await applyPropertyDefinitionSynthesis(repo, await planFor())
    const id = synthesizedPropertyDefinitionBlockId(WS, 'demo:orphan')
    // The definition is minted HIDDEN precisely to invite this look, and the
    // rename processor is flip-gated, so pre-flip the cell keeps the old key.
    await repo.tx(async tx => { await tx.setProperty(id, propertyNameProp, 'demo:renamed') },
                  {scope: ChangeScope.BlockDefault, description: 'rename'})
    await untilKeyUnresolved('demo:orphan')

    const plan = await planFor()
    expect(plan.candidates.map(c => c.key)).toEqual(['demo:orphan'])
    const result = await applyPropertyDefinitionSynthesis(repo, plan)

    expect(result).toMatchObject({created: 0, restored: 0, converged: 0})
    expect(result.skipped.map(s => s.key)).toEqual(['demo:orphan'])
    // And the flip must not step over it — the backfill excludes unregistered
    // keys from its work list, so it would report `ran` with zero failures.
    expect(flipBlockedBySynthesis(plan, result)).toMatch(/still have no definition/)
  })

  it('restores a tombstone under the key it is for, re-asserting the preset', async () => {
    // `tx.restore` alone brings back the STORED bag: a preset the operator had
    // switched to `date` came back as `date` and rewrote every value of the key.
    await rawCell('b1', {'demo:orphan': 'hello'})
    await applyPropertyDefinitionSynthesis(repo, await planFor())
    const id = synthesizedPropertyDefinitionBlockId(WS, 'demo:orphan')
    await repo.tx(async tx => { await tx.setProperty(id, presetIdProp, 'date') },
                  {scope: ChangeScope.BlockDefault, description: 'switch preset'})
    await repo.tx(async tx => { await tx.delete(id) },
                  {scope: ChangeScope.BlockDefault, description: 'delete'})
    await untilKeyUnresolved('demo:orphan')

    // Spied rather than inferred from the resolver: the projector's tick often
    // wins the race on its own, so asserting the OUTCOME would pass with the
    // synchronous publish deleted. The publish is the guarantee — the backfill
    // freezes one resolver for a multi-minute run a few awaits later.
    const publish = vi.spyOn(repo.userSchemas, 'appendUserSchema')

    const result = await applyPropertyDefinitionSynthesis(repo, await planFor())

    expect(result).toMatchObject({restored: 1})
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({name: 'demo:orphan'}), id, WS)
    const row = repo.block(id).peek()!
    expect(row.properties['property-schema:preset']).toBe('string')
    // The type membership survives the restore patch — building the patch from
    // the four owned fields alone would drop `types` and un-type the definition.
    expect(repo.propertySchemaResolverFor(WS).resolve('demo:orphan').status).toBe('resolved')
  })

  it('publishes a converged definition with the BLOCK\'s preset, not the plan\'s guess', async () => {
    // The block is live and may have been retyped deliberately. Publishing the
    // plan's inferred preset would have the backfill read historical values
    // under one codec and the projector replace it with another moments later.
    await rawCell('b1', {'demo:orphan': 'hello'})
    const plan = await planFor()
    await applyPropertyDefinitionSynthesis(repo, plan)
    const id = synthesizedPropertyDefinitionBlockId(WS, 'demo:orphan')
    await repo.tx(async tx => { await tx.setProperty(id, presetIdProp, 'raw-json') },
                  {scope: ChangeScope.BlockDefault, description: 'retype'})
    const publish = vi.spyOn(repo.userSchemas, 'appendUserSchema')
    vi.spyOn(repo, 'propertySchemaResolverFor').mockReturnValue({
      resolve: () => ({status: 'identity-unavailable', reason: 'definition-unavailable'}),
      resolveField: () => ({status: 'identity-unavailable', reason: 'definition-unavailable'}),
      resolveBoundary: () => ({status: 'identity-unavailable', reason: 'definition-unavailable'}),
    } as unknown as ReturnType<typeof repo.propertySchemaResolverFor>)

    await applyPropertyDefinitionSynthesis(repo, plan)

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({codec: expect.objectContaining({type: 'object'})}), id, WS)
  })

  it('publishes a converged definition too, not just one it created', async () => {
    await rawCell('b1', {'demo:orphan': 'hello'})
    const plan = await planFor()
    await applyPropertyDefinitionSynthesis(repo, plan)
    // Force the registry back to not knowing it, so the `ours` branch — "the
    // block is here, the projection has not caught up" — is the one taken.
    const id = synthesizedPropertyDefinitionBlockId(WS, 'demo:orphan')
    const publish = vi.spyOn(repo.userSchemas, 'appendUserSchema')
    vi.spyOn(repo, 'propertySchemaResolverFor').mockReturnValue({
      resolve: () => ({status: 'identity-unavailable', reason: 'definition-unavailable'}),
      resolveField: () => ({status: 'identity-unavailable', reason: 'definition-unavailable'}),
      resolveBoundary: () => ({status: 'identity-unavailable', reason: 'definition-unavailable'}),
    } as unknown as ReturnType<typeof repo.propertySchemaResolverFor>)

    const again = await applyPropertyDefinitionSynthesis(repo, plan)

    expect(again).toMatchObject({created: 0, converged: 1})
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({name: 'demo:orphan'}), id, WS)
  })

  it('refuses to restore a tombstone that is no longer this key\'s definition', async () => {
    await rawCell('b1', {'demo:orphan': 'hello'})
    await applyPropertyDefinitionSynthesis(repo, await planFor())
    const id = synthesizedPropertyDefinitionBlockId(WS, 'demo:orphan')
    await repo.tx(async tx => { await tx.setProperty(id, propertyNameProp, 'demo:renamed') },
                  {scope: ChangeScope.BlockDefault, description: 'rename'})
    await repo.tx(async tx => { await tx.delete(id) },
                  {scope: ChangeScope.BlockDefault, description: 'delete'})
    await untilKeyUnresolved('demo:orphan')

    const result = await applyPropertyDefinitionSynthesis(repo, await planFor())

    // Resurrecting a block the user deleted, under a name they chose, and
    // counting it as a definition added for a key that still has none.
    expect(result).toMatchObject({created: 0, restored: 0})
    expect(result.skipped.map(s => s.key)).toEqual(['demo:orphan'])
  })

  it('skips a foreign occupant rather than aborting the whole mint', async () => {
    // Unreachable while workspace ids are UUIDs, so it is defence in depth —
    // but the alternative is a DuplicateIdError out of the insert that takes
    // every other key's definition down with it.
    await rawCell('b1', {'demo:orphan': 'hello'})
    const id = synthesizedPropertyDefinitionBlockId(WS, 'demo:orphan')
    await repo.tx(async tx => {
      await tx.create({id, workspaceId: 'some-other-ws', parentId: null,
                       orderKey: 'a0', content: 'squatter'})
    }, {scope: ChangeScope.BlockDefault, description: 'squat'})

    const result = await applyPropertyDefinitionSynthesis(repo, await planFor())
    expect(result.skipped[0]!.reason).toMatch(/another workspace/)
  })

  it('does not leave the synthesis write on the undo stack', async () => {
    // The gesture clears the stack at the flip and the backfill clears it on
    // its first batch, but a run can end between the two — leaving these as the
    // only committed write with a live undo entry, one cmd-Z from deleting
    // definitions whose keys are already migrating.
    await rawCell('b1', {'demo:orphan': 'hello'})
    // Created up front so its own (undoable) transaction is not what this
    // measures — `getOrCreatePropertiesPage` is a separate commit.
    await getOrCreatePropertiesPage(repo, WS)
    const before = repo.undoManagerFor(WS).peekUndo(ChangeScope.BlockDefault)

    await applyPropertyDefinitionSynthesis(repo, await planFor())

    expect(repo.undoManagerFor(WS).peekUndo(ChangeScope.BlockDefault)).toEqual(before)
  })
})

describe('flipBlockedBySynthesis', () => {
  it('blocks on a key no definition can ever back, naming it', async () => {
    await rawCell('b1', {'': 'y'})
    expect(flipBlockedBySynthesis(await planFor())).toMatch(/empty property key/)
  })

  it('blocks a refused workspace that has orphan keys', async () => {
    await seedWorkspaceRow('e2ee')
    await rawCell('b1', {'demo:orphan': 'x'})
    expect(flipBlockedBySynthesis(await planFor())).toMatch(/have no definition/)
  })

  it('lets a refused workspace with nothing to mint through', async () => {
    // The refusal is about MINTING a dictionary-testable id. With no orphan
    // keys there is nothing to mint, so the invariant already holds.
    await seedWorkspaceRow('e2ee')
    await rawCell('b1', {[declaredProp.name]: 'x'})
    expect(flipBlockedBySynthesis(await planFor())).toBeNull()
  })

  it('blocks while any block has a property bag this device cannot read', async () => {
    // Not "some bad data over there" — a hole in the very scan this decision is
    // made from, so the invariant is UNVERIFIED rather than satisfied.
    await rawCell('b1', {'demo:orphan': 'x'})
    await applyPropertyDefinitionSynthesis(repo, await planFor())
    await rawCell('corrupt', {})
    await sharedDb.db.execute(
      `UPDATE blocks SET properties_json = '42' WHERE id = 'corrupt'`)

    const plan = await planFor()
    expect(plan.unreadableBlocks).toBe(1)
    expect(flipBlockedBySynthesis(plan)).toMatch(/cannot read/)
  })

  it('lets a clean workspace through', async () => {
    await rawCell('b1', {'demo:orphan': 'x'})
    await applyPropertyDefinitionSynthesis(repo, await planFor())
    expect(flipBlockedBySynthesis(await planFor())).toBeNull()
  })
})
