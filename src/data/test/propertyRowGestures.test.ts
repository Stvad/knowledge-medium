/**
 * The outline's structural gestures (indent / outdent / move up-down) over
 * property rows on a child-backed workspace: each acts on the sibling list the
 * caller's property display mode draws, where a drawn row — field row or
 * value — moves like any block.
 *
 * Owner layout, structural order, set up per test with `arrange`:
 *   page
 *     owner
 *       a            (ordinary)
 *       status::     (shown in `non-hidden`)  → value `draft`
 *       secret::     (outline-skipped)        → value `shh`
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
    // tags' physical neighbour above is the outline-skipped secret row, so in
    // non-hidden it swaps with status.
    expect(await repo.mutate.moveVertical({id: ids.tags, direction: -1, propertyDisplay: NON_HIDDEN})).toBe(true)
    const order = await childIds('owner')
    expect(order.indexOf(ids.tags)).toBeLessThan(order.indexOf(ids.status))
  })

  it('treats a block that only links a skipped definition as an ordinary row', async () => {
    // Unmarked, so not a field row, though its target is a skipped definition.
    const secretDefinition = (await repo.load(ids.secret))!.referenceTargetId!
    await repo.tx(async tx => {
      await tx.create({id: 'link', workspaceId: WS, parentId: 'owner', orderKey: 'a0', content: `((${secretDefinition}))`})
    }, {scope: ChangeScope.BlockDefault})
    await arrange('owner', [ids.a, 'link', ids.b, ids.status, ids.secret, ids.tags])
    expect(await repo.mutate.moveVertical({id: ids.b, direction: -1, propertyDisplay: NON_HIDDEN})).toBe(true)
    expect((await childIds('owner')).slice(0, 3)).toEqual([ids.a, ids.b, 'link'])
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

  it('steps a value at its field row\'s edge into the neighbouring row, like any block', async () => {
    expect(await repo.mutate.moveVertical({id: ids.x, direction: -1, scopeRootId: 'page', propertyDisplay: ALL}))
      .toBe(true)
    expect(await parentOf(ids.x)).toBe(ids.secret)
  })

  it('steps into a drawn field row at an edge, like into any block', async () => {
    // a's last child steps down into a's next DRAWN sibling, the status row,
    // landing first among its values: a string it decodes as, so it is the value.
    await repo.tx(async tx => {
      await tx.create({id: 'a1', workspaceId: WS, parentId: 'a', orderKey: 'a0', content: 'a1'})
    }, {scope: ChangeScope.BlockDefault})
    expect(await repo.mutate.moveVertical({id: 'a1', direction: 1, scopeRootId: 'page', propertyDisplay: NON_HIDDEN}))
      .toBe(true)
    expect(await parentOf('a1')).toBe(ids.status)
    await vi.waitFor(() => expect(repo.block('owner').peekProperty(statusProp)).toBe('a1'))
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
    // b's previous physical sibling is the outline-skipped secret row.
    await repo.mutate.indent({id: ids.b, propertyDisplay: NON_HIDDEN})
    expect(await parentOf(ids.b)).toBe(ids.a)
  })

  it('indents a drawn property row like any block', async () => {
    // Moves the property onto a, the row above it.
    await repo.mutate.indent({id: ids.status, propertyDisplay: NON_HIDDEN})
    expect(await parentOf(ids.status)).toBe(ids.a)
  })

  it('indents under a drawn field row like under any block, as a peer of its value', async () => {
    await arrange('owner', [ids.status, ids.b, ids.a, ids.secret, ids.tags])
    await repo.mutate.indent({id: ids.b, propertyDisplay: NON_HIDDEN})
    expect(await parentOf(ids.b)).toBe(ids.status)
    // Last among the values, so the value the cell reads is still the first.
    expect(repo.block('owner').peekProperty(statusProp)).toBe('draft')
  })

  it('indents a drawn property row under the property row above it', async () => {
    // A marked row under a field row is a property of that row, not a value.
    await arrange('owner', [ids.status, ids.tags, ids.a, ids.secret, ids.b])
    await repo.mutate.indent({id: ids.tags, propertyDisplay: NON_HIDDEN})
    expect(await parentOf(ids.tags)).toBe(ids.status)
  })

  it('nests a value under its sibling value, like any block', async () => {
    await repo.mutate.indent({id: ids.y, propertyDisplay: ALL})
    expect(await parentOf(ids.y)).toBe(ids.x)
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

  it('outdents a value out of its field row, like any block', async () => {
    expect(await repo.mutate.outdent({id: ids.draft, propertyDisplay: ALL})).toBe(true)
    expect(await parentOf(ids.draft)).toBe('owner')
    // The scalar's only value left, so the key goes; its field row stays, empty.
    expect(repo.block('owner').peekProperty(statusProp)).toBeUndefined()
    expect(await parentOf(ids.status)).toBe('owner')
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
