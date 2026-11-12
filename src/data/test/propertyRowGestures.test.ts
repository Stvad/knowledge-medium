/**
 * The outline's structural gestures (indent / outdent / move up-down) over
 * property rows on a child-backed workspace: each acts on the sibling list the
 * caller's property display mode draws, and none takes a value out of its
 * field row.
 *
 * Owner layout, structural order, set up per test with `arrange`:
 *   page
 *     owner
 *       a            (ordinary)
 *       status::     (shown in `non-hidden`)  → value `draft`
 *       secret::     (hidden tier)            → value `shh`
 *       tags::       (list)                   → `x`, `y`
 *       b            (ordinary)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, seedProperty, type BlockData, type User } from '@/data/api'
import { definitionSeedsFacet } from '@/data/facets'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import {
  propertyDisplayProp,
  type PropertyDisplayScopeLevels,
  type PropertyDisplaySetting,
} from '@/data/propertyDisplayMode'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { moveBlocksInTx, PropertyValueSetMoveError } from '@/data/mutators'
import { PropertyMergeError } from '@/data/blockMerge'
import { resolveFacetRuntimeSync } from '@/facets/facet'

const USER: User = {id: 'user-1', name: 'Alice'}
const WS = 'ws-property-row-gestures'

const statusProp = seedProperty({
  seedKey: 'test/property/gesture-status', revision: 1, name: 'gesture:status',
  preset: 'string', defaultValue: '', changeScope: ChangeScope.BlockDefault,
})
const secretProp = seedProperty({
  seedKey: 'test/property/gesture-secret', revision: 1, name: 'gesture:secret',
  preset: 'string', defaultValue: '', changeScope: ChangeScope.BlockDefault, hidden: true,
})
const tagsProp = seedProperty({
  seedKey: 'test/property/gesture-tags', revision: 1, name: 'gesture:tags',
  preset: 'string-list', defaultValue: [], changeScope: ChangeScope.BlockDefault,
})

const scope = (workspace: PropertyDisplaySetting): PropertyDisplayScopeLevels =>
  ({childBacked: true, workspace, panel: 'inherit'})
const ALL = scope('all')
const NON_HIDDEN = scope('non-hidden')

let sharedDb: TestDb
let repo: Repo
/** Row ids by fixture name. */
let ids: Record<'page' | 'owner' | 'a' | 'b' | 'status' | 'draft' | 'secret' | 'tags' | 'x' | 'y', string>

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

const fieldRowOf = async (ownerId: string, fieldName: string): Promise<BlockData> => {
  const children = await repo.runQuery('core.children', {id: ownerId}) as BlockData[]
  const row = children.find(child => child.isFieldForm && child.referenceTargetId
    && repo.propertySchemaResolverFor(WS).resolveField(child.referenceTargetId).status === 'resolved'
    && (repo.propertySchemaResolverFor(WS).resolveField(child.referenceTargetId) as {schema: {name: string}})
      .schema.name === fieldName)
  if (!row) throw new Error(`no field row ${fieldName}`)
  return row
}

const childIds = async (parentId: string): Promise<string[]> =>
  await repo.runQuery('core.childIds', {id: parentId}) as string[]

/** Puts `children` under `parentId` in this order, ahead of anything else. */
const arrange = async (parentId: string, children: readonly string[]): Promise<void> => {
  await repo.tx(async tx => {
    for (const [i, id] of children.entries()) await tx.move(id, {parentId, orderKey: `a${i}`})
  }, {scope: ChangeScope.BlockDefault})
}

const parentOf = async (id: string): Promise<string | null> => (await repo.load(id))?.parentId ?? null

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  await sharedDb.db.execute(
    `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time,
       encryption_mode, wk_canary, properties_migration)
     VALUES (?, 'test ws', ?, 1, 1, 'none', NULL, 'children')`, [WS, USER.id])
  repo = createTestRepo({db: sharedDb.db, user: USER}).repo
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    [statusProp, secretProp, tagsProp].map(prop => definitionSeedsFacet.of(prop, {source: 'test'})),
  ]))
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'page'})
    await tx.create({id: 'owner', workspaceId: WS, parentId: 'page', orderKey: 'a0', content: 'owner'})
    await tx.create({id: 'a', workspaceId: WS, parentId: 'owner', orderKey: 'a0', content: 'a'})
    await tx.create({id: 'b', workspaceId: WS, parentId: 'owner', orderKey: 'a1', content: 'b'})
  }, {scope: ChangeScope.BlockDefault})
  await vi.waitFor(() => expect(repo.propertySchemas.has(tagsProp.name)).toBe(true))
  const owner = repo.block('owner')
  await owner.set(statusProp, 'draft')
  await owner.set(secretProp, 'shh')
  await owner.set(tagsProp, ['x', 'y'])
  const status = await fieldRowOf('owner', statusProp.name)
  const secret = await fieldRowOf('owner', secretProp.name)
  const tags = await fieldRowOf('owner', tagsProp.name)
  const [draft] = await childIds(status.id)
  const [x, y] = await childIds(tags.id)
  ids = {page: 'page', owner: 'owner', a: 'a', b: 'b', status: status.id, draft, secret: secret.id, tags: tags.id, x, y}
  await arrange('owner', [ids.a, ids.status, ids.secret, ids.tags, ids.b])
})

describe('move up / down', () => {
  it('skips a neighbour the mode hides', async () => {
    // tags' physical neighbour above is the hidden-tier secret row, so in
    // non-hidden it swaps with status.
    expect(await repo.mutate.moveVertical({id: ids.tags, direction: -1, propertyDisplay: NON_HIDDEN})).toBe(true)
    const order = await childIds('owner')
    expect(order.indexOf(ids.tags)).toBeLessThan(order.indexOf(ids.status))
  })

  it('reads the parent\'s own display setting over the scope', async () => {
    // The owner shows all of its properties, so secret is drawn there.
    await repo.block('owner').set(propertyDisplayProp, 'all')
    expect(await repo.mutate.moveVertical({id: ids.tags, direction: -1, propertyDisplay: NON_HIDDEN})).toBe(true)
    const order = await childIds('owner')
    expect(order.indexOf(ids.tags)).toBe(order.indexOf(ids.secret) - 1)
  })

  it('swaps a drawn property row like any block', async () => {
    expect(await repo.mutate.moveVertical({id: ids.status, direction: -1, propertyDisplay: NON_HIDDEN})).toBe(true)
    expect((await childIds('owner')).slice(0, 2)).toEqual([ids.status, ids.a])
  })

  it('no-ops at a value row\'s edge instead of taking it out of its field row', async () => {
    expect(await repo.mutate.moveVertical({id: ids.x, direction: -1, scopeRootId: 'page', propertyDisplay: ALL}))
      .toBe(false)
    expect(await parentOf(ids.x)).toBe(ids.tags)
  })

  it('no-ops at an edge whose next drawn row is a field row, rather than entering its values', async () => {
    // a's last child would step down into a's next DRAWN sibling, the status
    // row, landing first among its values: the scalar's value to the next write.
    await repo.tx(async tx => {
      await tx.create({id: 'a1', workspaceId: WS, parentId: 'a', orderKey: 'a0', content: 'a1'})
    }, {scope: ChangeScope.BlockDefault})
    expect(await repo.mutate.moveVertical({id: 'a1', direction: 1, scopeRootId: 'page', propertyDisplay: NON_HIDDEN}))
      .toBe(false)
    expect(await parentOf('a1')).toBe('a')
  })

  it('steps past a hidden row into the next drawn ordinary row at an edge', async () => {
    await arrange('owner', [ids.a, ids.secret, ids.b, ids.status, ids.tags])
    await repo.tx(async tx => {
      await tx.create({id: 'a1', workspaceId: WS, parentId: 'a', orderKey: 'a0', content: 'a1'})
    }, {scope: ChangeScope.BlockDefault})
    expect(await repo.mutate.moveVertical({id: 'a1', direction: 1, scopeRootId: 'page', propertyDisplay: NON_HIDDEN}))
      .toBe(true)
    expect(await parentOf('a1')).toBe(ids.b)
  })

  it('still reorders values within their field row', async () => {
    expect(await repo.mutate.moveVertical({id: ids.y, direction: -1, scopeRootId: 'page', propertyDisplay: ALL}))
      .toBe(true)
    expect(await childIds(ids.tags)).toEqual([ids.y, ids.x])
  })
})

describe('indent', () => {
  it('never targets a row the mode hides', async () => {
    await arrange('owner', [ids.a, ids.secret, ids.b, ids.status, ids.tags])
    // b's previous physical sibling is the hidden-tier secret row.
    await repo.mutate.indent({id: ids.b, propertyDisplay: NON_HIDDEN})
    expect(await parentOf(ids.b)).toBe(ids.a)
  })

  it('indents a drawn property row like any block', async () => {
    // Moves the property onto a, the row above it.
    await repo.mutate.indent({id: ids.status, propertyDisplay: NON_HIDDEN})
    expect(await parentOf(ids.status)).toBe(ids.a)
  })

  it('no-ops under a drawn field row rather than entering its values', async () => {
    await arrange('owner', [ids.status, ids.b, ids.a, ids.secret, ids.tags])
    await repo.mutate.indent({id: ids.b, propertyDisplay: NON_HIDDEN})
    expect(await parentOf(ids.b)).toBe('owner')
  })

  it('indents a drawn property row under the property row above it', async () => {
    // A marked row under a field row is a property of that row, not a value.
    await arrange('owner', [ids.status, ids.tags, ids.a, ids.secret, ids.b])
    await repo.mutate.indent({id: ids.tags, propertyDisplay: NON_HIDDEN})
    expect(await parentOf(ids.tags)).toBe(ids.status)
  })

  it('no-ops on a value row rather than nesting it under its sibling value', async () => {
    await repo.mutate.indent({id: ids.y, propertyDisplay: ALL})
    expect(await parentOf(ids.y)).toBe(ids.tags)
  })
})

describe('outdent', () => {
  it('outdents a drawn property row like any block', async () => {
    // Moves the property onto the page, after its owner.
    expect(await repo.mutate.outdent({id: ids.status, propertyDisplay: NON_HIDDEN})).toBe(true)
    expect(await childIds('page')).toEqual(['owner', ids.status])
  })

  it('lands right after its parent on the drawn list, before the parent\'s drawn next sibling', async () => {
    // The page's own property row follows the owner.
    await repo.block('page').set(statusProp, 'page-status')
    const pageStatus = await fieldRowOf('page', statusProp.name)
    await arrange('page', ['owner', pageStatus.id])
    expect(await repo.mutate.outdent({id: ids.b, propertyDisplay: NON_HIDDEN})).toBe(true)
    expect(await childIds('page')).toEqual(['owner', ids.b, pageStatus.id])
  })

  it('no-ops on a value row rather than taking it out of its field row', async () => {
    expect(await repo.mutate.outdent({id: ids.draft, propertyDisplay: ALL})).toBe(false)
    expect(await parentOf(ids.draft)).toBe(ids.status)
  })
})

describe('without a display scope (mode none, as before property rows)', () => {
  it('moves an ordinary block past every property row', async () => {
    expect(await repo.mutate.moveVertical({id: ids.b, direction: -1})).toBe(true)
    const order = await childIds('owner')
    expect(order.indexOf(ids.b)).toBeLessThan(order.indexOf(ids.a))
  })

  it('leaves a property row where it is', async () => {
    expect(await repo.mutate.moveVertical({id: ids.status, direction: -1})).toBe(false)
    expect(await repo.mutate.outdent({id: ids.status})).toBe(false)
    await repo.mutate.indent({id: ids.status})
    expect(await parentOf(ids.status)).toBe('owner')
  })

  it('treats a cell-backed scope as none, whatever its levels say', async () => {
    expect(await repo.mutate.moveVertical({
      id: ids.status, direction: -1, propertyDisplay: {...ALL, childBacked: false},
    })).toBe(false)
  })
})

describe('every other user move (move command, drag, cut and paste)', () => {
  it('refuses to take a value out of its field row, moving nothing', async () => {
    await expect(repo.tx(tx => moveBlocksInTx(tx, [ids.b, ids.x], {parentId: 'page', position: {kind: 'last'}}),
      {scope: ChangeScope.BlockDefault})).rejects.toBeInstanceOf(PropertyValueSetMoveError)
    expect(await parentOf(ids.x)).toBe(ids.tags)
    expect(await parentOf(ids.b)).toBe('owner')
  })

  it('refuses to put a block among a field row\'s values', async () => {
    await expect(repo.tx(tx => moveBlocksInTx(tx, [ids.b], {parentId: ids.status, position: {kind: 'first'}}),
      {scope: ChangeScope.BlockDefault})).rejects.toBeInstanceOf(PropertyValueSetMoveError)
    expect(await parentOf(ids.b)).toBe('owner')
  })

  it('moves a field row like any block, and values within their field row', async () => {
    await repo.tx(async tx => {
      await moveBlocksInTx(tx, [ids.status], {parentId: 'page', position: {kind: 'last'}})
      await moveBlocksInTx(tx, [ids.y], {parentId: ids.tags, position: {kind: 'first'}})
    }, {scope: ChangeScope.BlockDefault})
    expect(await parentOf(ids.status)).toBe('page')
    expect(await childIds(ids.tags)).toEqual([ids.y, ids.x])
  })
})

describe('merge (Backspace at a start, Delete at an end, the merge picker)', () => {
  const contentOf = async (id: string): Promise<string | undefined> => (await repo.load(id))?.content

  it('refuses to fold the first value into its field row', async () => {
    await expect(repo.mutate.merge({intoId: ids.tags, fromId: ids.x})).rejects.toBeInstanceOf(PropertyMergeError)
    expect(repo.block('owner').peekProperty(tagsProp)).toEqual(['x', 'y'])
  })

  it('refuses to fold a block into a field row', async () => {
    await expect(repo.mutate.merge({intoId: ids.status, fromId: ids.b})).rejects.toBeInstanceOf(PropertyMergeError)
    expect(repo.block('owner').peekProperty(statusProp)).toBe('draft')
  })

  it('refuses to fold a field row into the block above it', async () => {
    await expect(repo.mutate.merge({intoId: ids.a, fromId: ids.status})).rejects.toBeInstanceOf(PropertyMergeError)
    expect(await parentOf(ids.status)).toBe('owner')
  })

  it('refuses to fold an ordinary block into a value', async () => {
    await expect(repo.mutate.merge({intoId: ids.y, fromId: ids.b})).rejects.toBeInstanceOf(PropertyMergeError)
    expect(await contentOf(ids.y)).toBe('y')
  })

  it('refuses to fold a value into an ordinary block', async () => {
    await expect(repo.mutate.merge({intoId: ids.a, fromId: ids.x})).rejects.toBeInstanceOf(PropertyMergeError)
    expect(await parentOf(ids.x)).toBe(ids.tags)
  })

  it('refuses to fold one property\'s value into another\'s', async () => {
    await expect(repo.mutate.merge({intoId: ids.x, fromId: ids.draft})).rejects.toBeInstanceOf(PropertyMergeError)
    expect(await contentOf(ids.x)).toBe('x')
  })

  it('joins two values of one field row like any two blocks', async () => {
    await repo.mutate.merge({intoId: ids.x, fromId: ids.y})
    expect(await contentOf(ids.x)).toBe('xy')
  })
})
