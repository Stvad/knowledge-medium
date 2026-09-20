// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { aliasesProp, typesProp } from '@/data/properties.js'
import { propertyFieldContent } from '@/data/propertyChildren'
import { propertyDefinitionBlockId } from '@/data/definitionSeeds'
import { getOrCreatePropertiesPage } from '@/data/propertiesPage'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { searchLinkTargetIdCandidates } from '@/utils/linkTargetAutocomplete'
import { propertyValueContexts } from '@/utils/propertyValueContext'

const WS = 'ws-1'

let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}}).repo
  // The property NAME on a context comes from the workspace's definition
  // registry, which only exists for the pinned workspace.
  repo.setActiveWorkspaceId(WS)
  await getOrCreatePropertiesPage(repo, WS)
})
afterEach(() => { repo.setActiveWorkspaceId(null) })

const fieldIdOf = (seedKey: string) => propertyDefinitionBlockId(WS, seedKey)

const create = async (args: {
  id: string
  parentId?: string | null
  content?: string
  orderKey?: string
  fieldId?: string
}) => {
  await repo.tx(tx => tx.create({
    id: args.id,
    workspaceId: WS,
    parentId: args.parentId ?? null,
    orderKey: args.orderKey ?? `key-${args.id}`,
    content: args.fieldId ? propertyFieldContent(args.fieldId) : args.content ?? '',
    ...(args.fieldId ? {referenceTargetId: args.fieldId, isFieldForm: true} : {}),
  }), {scope: ChangeScope.BlockDefault})
}

/** A block with one property, as the cell-to-children migration leaves it: a
 *  field row under the owner, one value row under that. */
const createWithPropertyRow = async (args: {
  ownerId: string
  ownerContent: string
  seedKey: string
  valueId: string
  valueContent: string
}) => {
  await create({id: args.ownerId, content: args.ownerContent})
  await create({id: `${args.ownerId}-field`, parentId: args.ownerId, fieldId: fieldIdOf(args.seedKey)})
  await create({
    id: args.valueId,
    parentId: `${args.ownerId}-field`,
    content: args.valueContent,
  })
}

describe('propertyValueContexts', () => {
  it('names the property a row holds a value for, and the block it is on', async () => {
    await createWithPropertyRow({
      ownerId: 'page', ownerContent: 'Reading List',
      seedKey: aliasesProp.seedKey, valueId: 'value', valueContent: 'Reading List',
    })

    const contexts = await propertyValueContexts(repo, WS, ['value'])

    expect(contexts.get('value')).toMatchObject({
      fieldId: fieldIdOf(aliasesProp.seedKey),
      propertyName: 'alias',
      ownerId: 'page',
    })
    expect(contexts.get('value')?.owner?.content).toBe('Reading List')
  })

  it('reads the name off the definition, not off one hard-coded property', async () => {
    await createWithPropertyRow({
      ownerId: 'page', ownerContent: 'Reading List',
      seedKey: typesProp.seedKey, valueId: 'value', valueContent: 'note',
    })

    expect((await propertyValueContexts(repo, WS, ['value'])).get('value')?.propertyName)
      .toBe('types')
  })

  it('leaves an ordinary child of an ordinary block alone', async () => {
    await create({id: 'page', content: 'Reading List'})
    await create({id: 'child', parentId: 'page', content: 'Reading List'})

    expect(await propertyValueContexts(repo, WS, ['page', 'child'])).toEqual(new Map())
  })

  it('leaves a marked row alone when its target is no definition the workspace knows', async () => {
    // §9 recognition is the bit PLUS a resolvable definition — a `::` block a
    // user typed by hand points at nothing and owns no values.
    await create({id: 'page', content: 'Reading List'})
    await create({
      id: 'page-field', parentId: 'page',
      fieldId: '00000000-0000-4000-8000-00000000beef',
    })
    await create({id: 'value', parentId: 'page-field', content: 'Reading List'})

    expect(await propertyValueContexts(repo, WS, ['value'])).toEqual(new Map())
  })
})

describe('searchLinkTargetIdCandidates — a block and its own property rows', () => {
  const candidates = (query: string, limit = 10) =>
    searchLinkTargetIdCandidates(repo, {workspaceId: WS, query, limit})

  it('ranks a block above the property row that repeats its content', async () => {
    // Both match the query text EXACTLY, so no text score can separate them and
    // the order falls out of SQL recency — which the migration leaves pointing
    // at the value row it just minted. Picking the preselected default then
    // stores a property row's id as the reference (km-1iia).
    await createWithPropertyRow({
      ownerId: 'page', ownerContent: 'Reading List',
      seedKey: aliasesProp.seedKey, valueId: 'value', valueContent: 'Reading List',
    })

    expect((await candidates('Reading List')).map(candidate => candidate.id))
      .toEqual(['page', 'value'])
  })

  it('tells the two apart, so neither row is a bare duplicate of the other', async () => {
    await createWithPropertyRow({
      ownerId: 'page', ownerContent: 'Reading List',
      seedKey: aliasesProp.seedKey, valueId: 'value', valueContent: 'Reading List',
    })

    const out = await candidates('Reading List')

    expect(out.map(candidate => candidate.context))
      .toEqual([undefined, 'alias of Reading List'])
  })

  it('moves only the OWNER, so a caller that then drops it leaves the rest in place', async () => {
    // The ref editor filters this list by the property's `targetTypes` AFTER
    // asking for it, and an ineligible owner is dropped there. Pushing the
    // property row down instead of pulling the owner up would strand the row
    // behind blocks it had outranked, for an owner no longer on screen.
    await create({id: 'owner', content: 'Reading List'})
    await create({id: 'owner-field', parentId: 'owner', fieldId: fieldIdOf(aliasesProp.seedKey)})
    await create({id: 'unrelated', content: 'Reading List'})
    await create({id: 'value', parentId: 'owner-field', content: 'Reading List'})

    const ordered = (await candidates('Reading List')).map(candidate => candidate.id)

    expect(ordered).toEqual(['owner', 'value', 'unrelated'])
    // The property row still outranks `unrelated`, as it did before the pass.
    expect(ordered.filter(id => id !== 'owner')).toEqual(['value', 'unrelated'])
  })

  it('keeps a property row where it ranked when its owner is not in the list', async () => {
    // Demotion is relative to the OWNER, not a blanket "machinery last": with
    // nothing to sit under, a property row competes on its own merits.
    await create({id: 'owner', content: 'somewhere else entirely'})
    await create({id: 'owner-field', parentId: 'owner', fieldId: fieldIdOf(aliasesProp.seedKey)})
    await create({id: 'value', parentId: 'owner-field', content: 'Reading List'})
    await create({id: 'later', content: 'Reading List but longer', orderKey: 'zz'})

    const out = await candidates('Reading List')

    expect(out.map(candidate => candidate.id)).toContain('value')
    expect(out.map(candidate => candidate.id).indexOf('value'))
      .toBeLessThan(out.map(candidate => candidate.id).indexOf('later'))
  })
})
