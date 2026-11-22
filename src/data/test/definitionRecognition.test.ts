// @vitest-environment node
/**
 * §9 recognition condition 3 — does a field row's target name a definition —
 * for `property-schema` blocks the registry cannot fully use. The outline SQL
 * (`recognizedFieldRowSql`, run here through `core.childIds`) and the tx layer
 * (`visibleChildrenOf` → `isResolvableFieldDefinition`) must give one answer:
 *  - a definition whose codec this device cannot build still classifies, since
 *    classification needs the definition and not the plugin owning its preset;
 *  - a block whose metadata does not parse is no definition, and its field row
 *    degrades to a visible unknown-field row.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { USER_SCHEMAS_PROJECTOR_ID } from '@/data/userSchemasService'
import { visibleChildrenOf } from '@/data/visibleChildren'
import { NO_PROPERTY_DISPLAY_SCOPE } from '@/data/propertyDisplayMode'
import type { Repo } from '@/data/repo'
import { materializePropertySeeds } from '@/data/definitionSeeds'
import { typesProp } from '@/data/properties'
import { isPropertyPanelHiddenProperty } from '@/components/propertyPanel/visibility'

const WS = 'ws-definition-recognition'
const DEF = 'd0000000-0000-4000-8000-000000000001'
const OWNER = 'a0000000-0000-4000-8000-000000000001'
const NOTE = 'b0000000-0000-4000-8000-000000000001'
const FIELD = 'b0000000-0000-4000-8000-000000000002'

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { await resetTestDb(sharedDb.db) })

const openRepo = async (): Promise<Repo> => {
  const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
  repo.setActiveWorkspaceId(WS)
  await repo.projectors.handle(USER_SCHEMAS_PROJECTOR_ID)!.whenPrimed(WS)
  return repo
}

/** A definition block with `bag`, and an owner holding an ordinary child and a
 *  field row targeting the definition. */
const seed = async (repo: Repo, bag: Record<string, unknown>): Promise<void> => {
  await repo.tx(async tx => {
    await tx.create({id: DEF, workspaceId: WS, parentId: null, orderKey: 'a0', content: '', properties: bag})
    await tx.create({id: OWNER, workspaceId: WS, parentId: null, orderKey: 'a1', content: 'owner'})
    await tx.create({id: NOTE, workspaceId: WS, parentId: OWNER, orderKey: 'a0', content: 'note'})
    await tx.create({id: FIELD, workspaceId: WS, parentId: OWNER, orderKey: 'a1', content: `::((${DEF}))`})
  }, {scope: ChangeScope.BlockDefault})
}

const views = async (repo: Repo): Promise<{sql: string[]; tx: string[]}> => ({
  sql: await repo.runQuery('core.childIds', {id: OWNER, propertyChildren: 'none'}) as string[],
  tx: (await repo.tx(tx => visibleChildrenOf(tx, OWNER, undefined, NO_PROPERTY_DISPLAY_SCOPE), {scope: ChangeScope.BlockDefault}))
    .map(child => child.id),
})

const definitionBag = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  types: ['property-schema'],
  'property-schema:name': 'status',
  'property-schema:preset': 'string',
  ...overrides,
})

describe('a definition this device cannot build a codec for', () => {
  it.each([
    {why: 'its preset is not loaded', bag: definitionBag({'property-schema:preset': 'preset-whose-plugin-is-not-loaded'})},
    {why: 'it names no preset', bag: {types: ['property-schema'], 'property-schema:name': 'status'}},
  ])('still classifies when $why: both views hide its field row', async ({bag}) => {
    const repo = await openRepo()
    await seed(repo, bag)
    await vi.waitFor(() => {
      expect(repo.propertyDefinitions?.definitionsByFieldId.has(DEF), 'registry parsed the definition').toBe(true)
    })
    expect(repo.propertySchemaResolverFor(WS).resolveField(DEF))
      .toEqual({status: 'identity-unavailable', reason: 'behavior-unavailable'})

    expect(await views(repo)).toEqual({sql: [NOTE], tx: [NOTE]})
  })
})

describe('a property-schema block whose metadata does not parse', () => {
  it.each([
    {why: 'its change scope is not one', bag: definitionBag({'property-schema:change-scope': 'not-a-change-scope'})},
    {why: 'its name is empty', bag: definitionBag({'property-schema:name': ''})},
  ])('is no definition when $why: both views show its field row', async ({bag}) => {
    const repo = await openRepo()
    await seed(repo, bag)
    await vi.waitFor(() => {
      expect(repo.propertyDefinitions?.unparseableDefinitionIds.has(DEF), 'registry reported the block').toBe(true)
    })
    expect(repo.propertyDefinitions?.definitionsByFieldId.has(DEF)).toBe(false)

    expect(await views(repo)).toEqual({sql: [NOTE, FIELD], tx: [NOTE, FIELD]})
  })
})

describe('a mounted outline view follows the registry', () => {
  // The registry moves AFTER the write that moved it, and none of these writes
  // touches the owner's parent edge, so only the recognition channel can
  // re-run a handle already holding the old answer.
  const untyped = {'property-schema:name': 'status', 'property-schema:preset': 'string'}
  it.each([
    {why: 'a definition stops parsing', from: definitionBag({}),
      to: definitionBag({'property-schema:change-scope': 'not-a-change-scope'}), before: [NOTE], after: [NOTE, FIELD]},
    {why: 'a tagged block starts parsing', from: definitionBag({'property-schema:name': ''}),
      to: definitionBag({}), before: [NOTE, FIELD], after: [NOTE]},
    {why: 'a block gains the property-schema type', from: untyped,
      to: definitionBag({}), before: [NOTE, FIELD], after: [NOTE]},
  ])('re-resolves when $why', async ({from, to, before, after}) => {
    const repo = await openRepo()
    await seed(repo, from)
    const handle = repo.query.childIds({id: OWNER, propertyChildren: 'none'})
    const unsubscribe = handle.subscribe(() => {})
    try {
      await vi.waitFor(() => expect(handle.peek()).toEqual(before))
      await repo.tx(tx => tx.update(DEF, {properties: to}), {scope: ChangeScope.BlockDefault})
      await vi.waitFor(() => expect(handle.peek()).toEqual(after))
    } finally {
      unsubscribe()
    }
  })
})

describe('the hidden-tier child view (`propertyChildren: \'non-hidden\'`)', () => {
  const tierView = (repo: Repo) => repo.runQuery('core.childIds', {id: OWNER, propertyChildren: 'non-hidden'})

  it('keeps a field row whose definition is not hidden, and drops one whose definition is', async () => {
    const repo = await openRepo()
    await seed(repo, definitionBag({}))
    await vi.waitFor(() => expect(repo.propertyDefinitions?.definitionsByFieldId.has(DEF)).toBe(true))
    expect(await tierView(repo)).toEqual([NOTE, FIELD])

    await repo.tx(tx => tx.update(DEF, {properties: definitionBag({'property-schema:hidden': true})}),
      {scope: ChangeScope.BlockDefault})
    await vi.waitFor(async () => expect(await tierView(repo)).toEqual([NOTE]))
  })

  it('drops a field row whose definition is hide-in-outline, which the panel still shows', async () => {
    const repo = await openRepo()
    await seed(repo, definitionBag({'property-schema:hide-in-outline': true}))
    await vi.waitFor(() => expect(repo.propertyDefinitions?.definitionsByFieldId.get(DEF)?.hideInOutline).toBe(true))
    expect(await tierView(repo)).toEqual([NOTE])
    expect(await repo.runQuery('core.childIds', {id: OWNER, propertyChildren: 'all'})).toEqual([NOTE, FIELD])
    // Only the outline's default view reads it: not hidden anywhere else.
    expect(isPropertyPanelHiddenProperty('status', repo.propertySchemas, new Map(), repo.propertyDefinitions)).toBe(false)
  })

  it('re-resolves a mounted handle when the hidden bit moves, though recognition does not', async () => {
    const repo = await openRepo()
    await seed(repo, definitionBag({'property-schema:hidden': true}))
    const handle = repo.query.childIds({id: OWNER, propertyChildren: 'non-hidden'})
    const unsubscribe = handle.subscribe(() => {})
    try {
      await vi.waitFor(() => expect(handle.peek()).toEqual([NOTE]))
      await repo.tx(tx => tx.update(DEF, {properties: definitionBag({'property-schema:hidden': false})}),
        {scope: ChangeScope.BlockDefault})
      await vi.waitFor(() => expect(handle.peek()).toEqual([NOTE, FIELD]))
    } finally {
      unsubscribe()
    }
  })

  // A marked row whose span resolves nothing has a NULL target: membership in
  // the (never empty — kernel seeds are hidden) hidden list must read false,
  // not NULL, or `NOT (...)` hides a row that is no property at all.
  it('keeps a marked row whose span resolves nothing', async () => {
    const repo = await openRepo()
    await vi.waitFor(() => expect(repo.propertyDefinitions).not.toBeNull())
    await repo.tx(async tx => {
      await tx.create({id: OWNER, workspaceId: WS, parentId: null, orderKey: 'a1', content: 'owner'})
      await tx.create({id: FIELD, workspaceId: WS, parentId: OWNER, orderKey: 'a1', content: '::[[future-field]]'})
    }, {scope: ChangeScope.BlockDefault})
    await vi.waitFor(async () => {
      const row = await repo.db.getOptional<{is_field_form: number | null; reference_target_id: string | null}>(
        'SELECT is_field_form, reference_target_id FROM blocks WHERE id = ?', [FIELD])
      expect(row).toEqual({is_field_form: 1, reference_target_id: null})
    })
    expect(await tierView(repo)).toEqual([FIELD])
  })

  // A built-in marked hide-in-outline in code, whose definition row was
  // materialized before the field existed — every existing workspace's shape.
  it('takes a built-in\'s hide-in-outline from its declaration until its row stores one', async () => {
    const repo = await openRepo()
    await vi.waitFor(() => expect(repo.propertyDefinitions).not.toBeNull())
    const types = repo.propertySchemaResolverFor(WS).resolve('types')
    expect(types.status).toBe('resolved')
    const fieldId = types.status === 'resolved' ? types.schema.fieldId : ''
    // Materialize the seed's row, then give it the old shape: no stored key.
    await repo.ensureSystemPages(WS)
    await materializePropertySeeds(repo, WS, [typesProp])
    const row = (await repo.load(fieldId))!
    expect(row.properties['property-schema:hide-in-outline']).toBe(true)
    const withoutKey = {...row.properties}
    delete withoutKey['property-schema:hide-in-outline']
    await repo.tx(tx => tx.update(fieldId, {properties: withoutKey}), {scope: ChangeScope.Automation})
    await vi.waitFor(() => {
      const definition = repo.propertyDefinitions?.definitionsByFieldId.get(fieldId)
      expect(definition).toBeDefined()
      expect(definition!.hideInOutline).toBeUndefined()
    })
    await repo.tx(async tx => {
      await tx.create({id: OWNER, workspaceId: WS, parentId: null, orderKey: 'a1', content: 'owner'})
      await tx.create({id: NOTE, workspaceId: WS, parentId: OWNER, orderKey: 'a0', content: 'note'})
      await tx.create({id: FIELD, workspaceId: WS, parentId: OWNER, orderKey: 'a1', content: `::((${fieldId}))`})
    }, {scope: ChangeScope.BlockDefault})
    expect(await tierView(repo)).toEqual([NOTE])

    // A stored value wins over the declaration, false included.
    await repo.tx(tx => tx.update(fieldId, {properties: {...withoutKey, 'property-schema:hide-in-outline': false}}),
      {scope: ChangeScope.Automation})
    await vi.waitFor(async () => expect(await tierView(repo)).toEqual([NOTE, FIELD]))
  })

  it('drops the field row of a hidden kernel seed', async () => {
    const repo = await openRepo()
    await vi.waitFor(() => expect(repo.propertyDefinitions).not.toBeNull())
    const collapsedFieldId = repo.propertySchemaResolverFor(WS).resolve('system:collapsed')
    expect(collapsedFieldId.status).toBe('resolved')
    const fieldId = collapsedFieldId.status === 'resolved' ? collapsedFieldId.schema.fieldId : ''
    await repo.tx(async tx => {
      await tx.create({id: OWNER, workspaceId: WS, parentId: null, orderKey: 'a1', content: 'owner'})
      await tx.create({id: NOTE, workspaceId: WS, parentId: OWNER, orderKey: 'a0', content: 'note'})
      await tx.create({id: FIELD, workspaceId: WS, parentId: OWNER, orderKey: 'a1', content: `::((${fieldId}))`})
    }, {scope: ChangeScope.BlockDefault})
    expect(await repo.runQuery('core.childIds', {id: OWNER})).toEqual([NOTE, FIELD])
    expect(await tierView(repo)).toEqual([NOTE])
  })
})

describe('the child queries\' arguments', () => {
  it.each(['core.children', 'core.childIds', 'core.subtree'] as const)(
    '%s refuses an unknown option instead of ignoring it', async name => {
      const repo = await openRepo()
      await expect(repo.runQuery(name, {id: OWNER, hidePropertyChildren: true} as never)).rejects.toThrow()
    })
})
