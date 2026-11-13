// @vitest-environment node
/**
 * Where property machinery rows are minted: at ids derived from what they are,
 * under a namespace a sealed workspace keys with `K_id`.
 *
 * Node, with a stubbed localStorage, because an `e2ee` mode pin is only
 * writable against a durable store. The sealed namespace is cached per (user,
 * workspace) for the life of the module, so every test takes a FRESH
 * workspace id.
 *
 * Expected ids are recomputed from LITERAL namespaces and key shapes, never
 * asked of the code under test — see `derivedIds.test.ts`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { v5 as uuidv5 } from 'uuid'
import { ChangeScope, codecs, defineProperty, type AnyPropertySchema } from '@/data/api'
import type { Repo } from '@/data/repo'
import { projectedPropertyDefinitionsFacet } from '@/data/facets'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { storeWorkspaceKey, stubLocalStorage } from '@/data/test/e2eeFixtures'
import { getWorkspaceKeyStore } from '@/sync/keys/keyStore'
import { setModePin } from '@/sync/keys/modePin'
import { WorkspaceKeyUnavailableError } from '@/sync/keys/openWorkspaceKeys'
import { keyAtStart } from '@/data/orderKey'
import { propertyFieldContent } from '@/data/propertyChildren'
import { deleteSubtreeInTx } from '@/data/subtreeDelete'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { referencesDataExtension } from '@/plugins/references/dataExtension'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { mintPropertyChildRow, resolvePropertyChildNamespace, withPropertyChildIds } from './propertyChildMint'
import { plannedFieldRow } from './propertyChildrenProcessor'

const USER = 'user-prop-child-ids'
/** Spelled out: the plaintext namespace, and HMAC(K_id, 'km/property-child-ns/v1')
 *  for the key `storeWorkspaceKey(…, 7)` stores. */
const PLAINTEXT_NS = '4ddc11ad-ce83-4be7-813e-660f882e676d'
const SEALED_NS_FILL_7 = '096acf4c-89fd-4e56-8595-c23d6801e6da'

const STATUS_FIELD = '7e1f3a52-8c4d-4b69-a0e2-3f5a7c9e1d24'
const TAGS_FIELD = '8f2a4b63-9d5e-4c7a-b1f3-4a6c8e0f2b46'
const OWNER = '0b9d2c41-6a3e-4f58-9c71-2d4e6f8a0b13'

const statusSchema = defineProperty('status', {
  codec: codecs.string, defaultValue: '', changeScope: ChangeScope.BlockDefault,
})
const tagsSchema = defineProperty('tags', {
  codec: codecs.list(codecs.string), defaultValue: [] as string[], changeScope: ChangeScope.BlockDefault,
})

const fieldKey = (ws: string, owner: string, field: string) => `field|${ws}|${owner}|${field}`
const scalarKey = (ws: string, fieldRow: string) => `value|${ws}|${fieldRow}`
const memberKey = (ws: string, fieldRow: string, occurrence: number, value: string) =>
  `member|${ws}|${fieldRow}|${occurrence}|v["${value}"]`

let sharedDb: TestDb
let repo: Repo
let counter = 0
let WS = ''

const seedWorkspace = async (encryptionMode: 'none' | 'e2ee'): Promise<void> => {
  await sharedDb.db.execute(
    `INSERT OR REPLACE INTO workspaces
       (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
     VALUES (?, 'ws', ?, 1, 1, ?, NULL, 'children')`,
    [WS, USER, encryptionMode])
}

const registerDefinition = (fieldId: string, schema: AnyPropertySchema): void => {
  repo.setRuntimeContributions(projectedPropertyDefinitionsFacet, `def-${fieldId}`, [{
    metadata: {
      fieldId, workspaceId: WS, createdAt: 1, name: schema.name,
      changeScope: schema.changeScope, hidden: false, origin: 'user' as const,
    },
    schema,
  }], {workspaceId: WS})
}

const write = (fn: Parameters<Repo['tx']>[0]) =>
  repo.tx(fn, {scope: ChangeScope.BlockDefault})

interface Row { id: string; content: string; deleted: number; parent_id: string | null }

const childrenOf = (parentId: string): Promise<Row[]> => sharedDb.db.getAll<Row>(
  'SELECT id, content, deleted, parent_id FROM blocks WHERE parent_id = ? ORDER BY order_key, id',
  [parentId])
const liveChildrenOf = async (parentId: string) =>
  (await childrenOf(parentId)).filter(row => row.deleted === 0)
const rowAt = (id: string) => sharedDb.db.getOptional<Row>(
  'SELECT id, content, deleted, parent_id FROM blocks WHERE id = ?', [id])

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
afterEach(async () => {
  await getWorkspaceKeyStore().delete(USER, WS)
  vi.unstubAllGlobals()
})
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  stubLocalStorage()
  WS = `3f2b7c10-9d4e-4a61-8c2f-${String(++counter).padStart(12, '0')}`
  repo = createTestRepo({db: sharedDb.db, user: {id: USER}}).repo
  repo.setActiveWorkspaceId(WS)
  // The References plugin, so a field row's `references` are real and a
  // restore that left them stale would show.
  repo.setFacetRuntime(resolveFacetRuntimeSync(
    [kernelDataExtension, referencesDataExtension], {repo, workspaceId: WS, safeMode: false}))
  registerDefinition(STATUS_FIELD, statusSchema)
  registerDefinition(TAGS_FIELD, tagsSchema)
})

const createOwner = (id = OWNER) => write(tx => tx.create({
  id, workspaceId: WS, parentId: null, orderKey: `k-${id}`, content: 'owner',
}).then(() => undefined))

describe('a plaintext workspace', () => {
  beforeEach(async () => {
    await seedWorkspace('none')
    setModePin(USER, WS, 'plaintext')
    await createOwner()
  })

  it('mints a scalar\'s field row and value child at their derived ids', async () => {
    await write(tx => tx.setProperty(OWNER, statusSchema, 'done'))

    const fieldRowId = uuidv5(fieldKey(WS, OWNER, STATUS_FIELD), PLAINTEXT_NS)
    expect((await liveChildrenOf(OWNER)).map(row => row.id)).toEqual([fieldRowId])
    expect(await liveChildrenOf(fieldRowId)).toEqual([expect.objectContaining({
      id: uuidv5(scalarKey(WS, fieldRowId), PLAINTEXT_NS), content: 'done',
    })])
  })

  it('keys each list member by its value and its occurrence among equal members', async () => {
    await write(tx => tx.setProperty(OWNER, tagsSchema, ['blue', 'red', 'blue']))

    const fieldRowId = uuidv5(fieldKey(WS, OWNER, TAGS_FIELD), PLAINTEXT_NS)
    expect((await liveChildrenOf(fieldRowId)).map(({id, content}) => ({id, content}))).toEqual([
      {id: uuidv5(memberKey(WS, fieldRowId, 0, 'blue'), PLAINTEXT_NS), content: 'blue'},
      {id: uuidv5(memberKey(WS, fieldRowId, 0, 'red'), PLAINTEXT_NS), content: 'red'},
      {id: uuidv5(memberKey(WS, fieldRowId, 1, 'blue'), PLAINTEXT_NS), content: 'blue'},
    ])
  })

  it('restores the removed rows when the property is set again, with the new value', async () => {
    await write(tx => tx.setProperty(OWNER, statusSchema, 'done'))
    const [field] = await liveChildrenOf(OWNER)
    const [value] = await liveChildrenOf(field!.id)
    await write(tx => tx.unsetProperty(OWNER, statusSchema))
    expect(await liveChildrenOf(OWNER)).toEqual([])

    await write(tx => tx.setProperty(OWNER, statusSchema, 'later'))

    expect((await liveChildrenOf(OWNER)).map(row => row.id)).toEqual([field!.id])
    expect(await liveChildrenOf(field!.id)).toEqual([
      expect.objectContaining({id: value!.id, content: 'later'}),
    ])
  })

  it('re-adds a removed list member at its slot in the new order', async () => {
    await write(tx => tx.setProperty(OWNER, tagsSchema, ['blue', 'red']))
    const [field] = await liveChildrenOf(OWNER)
    const [blue] = await liveChildrenOf(field!.id)
    await write(tx => tx.setProperty(OWNER, tagsSchema, ['red']))

    await write(tx => tx.setProperty(OWNER, tagsSchema, ['red', 'blue']))

    const members = await liveChildrenOf(field!.id)
    expect(members.map(row => row.content)).toEqual(['red', 'blue'])
    expect(members[1]!.id).toBe(blue!.id)
  })

  it('leaves a tombstone that died under another parent, even a dead one', async () => {
    // Restoring it would land a live row under a tombstoned parent, which the
    // parent-not-deleted trigger refuses by aborting the whole write.
    await createOwner('other-owner')
    await write(tx => tx.setProperty(OWNER, statusSchema, 'done'))
    const [field] = await liveChildrenOf(OWNER)
    await write(async tx => {
      await tx.move(field!.id, {parentId: 'other-owner', orderKey: keyAtStart(null)})
      await deleteSubtreeInTx(tx, 'other-owner')
    })
    expect(await rowAt(field!.id)).toMatchObject({deleted: 1, parent_id: 'other-owner'})

    await write(tx => tx.setProperty(OWNER, statusSchema, 'again'))

    const fields = await liveChildrenOf(OWNER)
    expect(fields).toHaveLength(1)
    expect(fields[0]!.id).not.toBe(field!.id)
    expect(await rowAt(field!.id)).toMatchObject({deleted: 1})
  })

  it('restores a tombstone that stopped being a field row as one, classified in the same tx', async () => {
    await write(tx => tx.setProperty(OWNER, statusSchema, 'done'))
    const [field] = await liveChildrenOf(OWNER)
    await write(async tx => {
      await tx.update(field!.id, {content: 'just text now'})
      await tx.delete(field!.id)
    })
    const plain = await sharedDb.db.get<{is_field_form: number | null; reference_target_id: string | null}>(
      'SELECT is_field_form, reference_target_id FROM blocks WHERE id = ?', [field!.id])
    expect(plain).toEqual({is_field_form: null, reference_target_id: null})

    let classifiedInTx: unknown
    await write(async tx => {
      await tx.setProperty(OWNER, statusSchema, 'again')
      const row = await tx.get(field!.id)
      classifiedInTx = {isFieldForm: row?.isFieldForm, target: row?.referenceTargetId}
    })

    expect(classifiedInTx).toEqual({isFieldForm: true, target: STATUS_FIELD})
    expect(await rowAt(field!.id)).toMatchObject({deleted: 0, content: propertyFieldContent(STATUS_FIELD)})
    const {references_json: references} = await sharedDb.db.get<{references_json: string}>(
      'SELECT references_json FROM blocks WHERE id = ?', [field!.id])
    expect(JSON.parse(references)).toEqual([expect.objectContaining({id: STATUS_FIELD})])
  })

  it('takes a random id when a live row it no longer recognizes holds the slot', async () => {
    // A field row moved out from under its owner is still at the derived id.
    await createOwner('other-owner')
    await write(tx => tx.setProperty(OWNER, statusSchema, 'done'))
    const [moved] = await liveChildrenOf(OWNER)
    await write(tx => tx.move(moved!.id, {parentId: 'other-owner', orderKey: keyAtStart(null)}))

    await write(tx => tx.setProperty(OWNER, statusSchema, 'second'))

    const fields = await liveChildrenOf(OWNER)
    expect(fields).toHaveLength(1)
    expect(fields[0]!.id).not.toBe(moved!.id)
    expect(await rowAt(moved!.id)).toMatchObject({deleted: 0, parent_id: 'other-owner'})
  })

  it('a list member edited in place keeps its id, and re-adding the old value mints beside it', async () => {
    await write(tx => tx.setProperty(OWNER, tagsSchema, ['blue']))
    const [field] = await liveChildrenOf(OWNER)
    const [member] = await liveChildrenOf(field!.id)
    await write(tx => tx.update(member!.id, {content: 'green'}))

    await write(tx => tx.setProperty(OWNER, tagsSchema, ['green', 'blue']))

    const members = await liveChildrenOf(field!.id)
    expect(members.map(row => row.content)).toEqual(['green', 'blue'])
    expect(members[0]!.id).toBe(member!.id)
    expect(members[1]!.id).not.toBe(member!.id)
  })
})

describe('a sealed workspace', () => {
  beforeEach(async () => {
    await seedWorkspace('e2ee')
    setModePin(USER, WS, 'e2ee')
    await createOwner()
  })

  it('mints under HMAC(K_id, the versioned label), never the public namespace', async () => {
    await storeWorkspaceKey(USER, WS, 7)
    expect(await resolvePropertyChildNamespace(repo, WS)).toBe(SEALED_NS_FILL_7)

    await write(tx => tx.setProperty(OWNER, statusSchema, 'done'))

    expect((await liveChildrenOf(OWNER)).map(row => row.id))
      .toEqual([uuidv5(fieldKey(WS, OWNER, STATUS_FIELD), SEALED_NS_FILL_7)])
  })

  it('refuses to resolve without K_id, and the write mints a random id instead', async () => {
    await expect(resolvePropertyChildNamespace(repo, WS))
      .rejects.toBeInstanceOf(WorkspaceKeyUnavailableError)

    await write(tx => tx.setProperty(OWNER, statusSchema, 'done'))

    const fields = await liveChildrenOf(OWNER)
    expect(fields).toHaveLength(1)
    expect(fields[0]!.id).not.toBe(uuidv5(fieldKey(WS, OWNER, STATUS_FIELD), PLAINTEXT_NS))
    expect(fields[0]!.id).not.toBe(uuidv5(fieldKey(WS, OWNER, STATUS_FIELD), SEALED_NS_FILL_7))
  })

  it('leaves the bulk form\'s rows random while the namespace is unresolved', async () => {
    await storeWorkspaceKey(USER, WS, 7)
    let rows: Awaited<ReturnType<typeof withPropertyChildIds>> = []
    await write(async tx => {
      rows = await withPropertyChildIds(tx, WS, [plannedFieldRow(tx, {id: OWNER, workspaceId: WS}, STATUS_FIELD)])
    })
    expect(rows.map(row => row.id)).toEqual([undefined])
  })

  it('mints a random id when the key exists but nothing resolved it before the lock', async () => {
    await storeWorkspaceKey(USER, WS, 7)

    await write(tx => tx.setProperty(OWNER, statusSchema, 'done'))

    const fields = await liveChildrenOf(OWNER)
    expect(fields).toHaveLength(1)
    expect(fields[0]!.id).not.toBe(uuidv5(fieldKey(WS, OWNER, STATUS_FIELD), PLAINTEXT_NS))
    expect(fields[0]!.id).not.toBe(uuidv5(fieldKey(WS, OWNER, STATUS_FIELD), SEALED_NS_FILL_7))
  })
})

describe('mintPropertyChildRow restores a tombstone as the planned row', () => {
  beforeEach(async () => {
    await seedWorkspace('none')
    setModePin(USER, WS, 'plaintext')
    await createOwner()
  })

  // Read INSIDE the writing tx, right after the mint: the deferred materializer
  // canonicalizes a field row's content later in the same commit, which would
  // hide a restore that left the tombstone's own text.
  it('content, order key, references and both derived columns, before any processor runs', async () => {
    const id = uuidv5(fieldKey(WS, OWNER, STATUS_FIELD), PLAINTEXT_NS)
    await write(async tx => {
      // An order key of its own, so the restore has to move it to the planned one.
      await tx.create({id, workspaceId: WS, parentId: OWNER, orderKey: 'zz', content: 'old text'})
      await tx.delete(id)
    })

    let restored: unknown
    await write(async tx => {
      const minted = await mintPropertyChildRow(
        tx, plannedFieldRow(tx, {id: OWNER, workspaceId: WS}, STATUS_FIELD), 'restore')
      const row = await tx.get(minted)
      restored = {
        id: minted, deleted: row?.deleted, content: row?.content, orderKey: row?.orderKey,
        isFieldForm: row?.isFieldForm, target: row?.referenceTargetId,
        references: row?.references.map(ref => ref.id),
      }
    })

    expect(restored).toEqual({
      id, deleted: false, content: propertyFieldContent(STATUS_FIELD), orderKey: keyAtStart(null),
      isFieldForm: true, target: STATUS_FIELD, references: [STATUS_FIELD],
    })
  })
})

describe('withPropertyChildIds (the create-only bulk form)', () => {
  beforeEach(async () => {
    await seedWorkspace('none')
    setModePin(USER, WS, 'plaintext')
    await createOwner()
  })

  it('derives each id where nothing sits, and leaves an occupied one random — tombstones included', async () => {
    const derived = uuidv5(fieldKey(WS, OWNER, STATUS_FIELD), PLAINTEXT_NS)
    const tombstoned = uuidv5(fieldKey(WS, OWNER, TAGS_FIELD), PLAINTEXT_NS)
    await write(async tx => {
      await tx.create({
        id: tombstoned, workspaceId: WS, parentId: OWNER, orderKey: keyAtStart(null),
        content: propertyFieldContent(TAGS_FIELD),
      })
      await tx.delete(tombstoned)
    })

    let rows: Awaited<ReturnType<typeof withPropertyChildIds>> = []
    await write(async tx => {
      const owner = {id: OWNER, workspaceId: WS}
      rows = await withPropertyChildIds(tx, WS, [
        plannedFieldRow(tx, owner, STATUS_FIELD),
        plannedFieldRow(tx, owner, TAGS_FIELD),
        plannedFieldRow(tx, owner, STATUS_FIELD),
      ])
    })

    expect(rows.map(row => row.id)).toEqual([derived, undefined, undefined])
  })
})
