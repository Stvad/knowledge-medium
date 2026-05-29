// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveFacetRuntimeSync } from '@/extensions/facet'
import { ChangeScope, codecs, defineProperty, type AnyPropertySchema } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { propertySchemasFacet } from '@/data/facets'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { aliasesProp, propertyNameProp, rendererProp } from '@/data/properties'
import { PAGE_TYPE } from '@/data/blockTypes'
import { getOrCreatePropertiesPage } from '@/data/propertiesPage'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { PROPERTY_CHILDREN_BACKFILL_MARKER_PREFIX } from '@/data/internals/clientSchema'
import { kernelValuePresetsExtension } from '@/components/propertyEditors/kernelValuePresets'
import { deleteProperty } from '@/components/propertyPanel/actions'
import { Repo } from './repo'

const WS = 'ws-property-children'

interface Harness {
  h: TestDb
  repo: Repo
  statusProp: AnyPropertySchema
  dispose?: () => void
}

const makeStatusProp = (): AnyPropertySchema =>
  defineProperty<string>('status', {
    codec: codecs.string,
    defaultValue: '',
    changeScope: ChangeScope.BlockDefault,
    fieldId: 'field-status',
  })

const setup = async (options: {
  registerStatusProp?: boolean
  extraSchemas?: readonly AnyPropertySchema[]
  activateWorkspace?: boolean
} = {}): Promise<Harness> => {
  const {
    registerStatusProp = true,
    extraSchemas = [],
    activateWorkspace = true,
  } = options
  const h = await createTestDb()
  const cache = new BlockCache()
  let timeCursor = 1700_000_000_000
  let idCursor = 0
  const repo = new Repo({
    db: h.db,
    cache,
    user: {id: 'user-1'},
    now: () => ++timeCursor,
    newId: () => `gen-${++idCursor}`,
    startRowEventsTail: false,
  })
  const statusProp = makeStatusProp()
  if (activateWorkspace) repo.setActiveWorkspaceId(WS)
  const schemas = registerStatusProp ? [statusProp, ...extraSchemas] : extraSchemas
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    kernelValuePresetsExtension,
    ...schemas.map(schema => propertySchemasFacet.of(schema, {source: 'test'})),
  ]))
  return {h, repo, statusProp}
}

const createRoot = async (repo: Repo, id: string): Promise<void> => {
  await repo.tx(
    tx => tx.create({id, workspaceId: WS, parentId: null, orderKey: id}),
    {scope: ChangeScope.BlockDefault},
  )
}

const rawLiveChildren = async (h: TestDb, parentId: string) =>
  h.db.getAll<{
    id: string
    content: string
    reference_target_id: string | null
    properties_json: string
  }>(
    `
      SELECT id, content, reference_target_id, properties_json
      FROM blocks
      WHERE parent_id = ? AND deleted = 0
      ORDER BY order_key, id
    `,
    [parentId],
  )

const seedLegacyPropertiesRow = async (
  h: TestDb,
  id: string,
  orderKey: string,
  properties: Record<string, unknown>,
): Promise<void> => {
  await h.db.execute(
    `
      INSERT INTO blocks (
        id, workspace_id, parent_id, reference_target_id, order_key,
        content, properties_json, references_json, created_at, updated_at,
        created_by, updated_by, deleted
      ) VALUES (?, ?, NULL, NULL, ?, ?, ?, '[]', ?, ?, ?, ?, 0)
    `,
    [
      id,
      WS,
      orderKey,
      'Legacy parent',
      JSON.stringify(properties),
      1,
      1,
      'user-1',
      'user-1',
    ],
  )
}

let env: Harness
afterEach(async () => {
  env.dispose?.()
  await env.h.cleanup()
})

describe('child-backed user properties', () => {
  it('writes user-defined properties as field child blocks while keeping the parent cache hot', async () => {
    env = await setup({registerStatusProp: false})
    await createRoot(env.repo, 'parent')

    await env.repo.mutate.setProperty({
      id: 'parent',
      schema: env.statusProp,
      value: 'Doing',
    })

    expect(env.repo.cache.getSnapshot('parent')?.properties.status).toBe('Doing')

    const children = await rawLiveChildren(env.h, 'parent')
    expect(children).toHaveLength(1)
    expect(children[0]!.content).toBe('[[status]]')
    expect(children[0]!.reference_target_id).toBe('field-status')
    expect(JSON.parse(children[0]!.properties_json)).toEqual({})
    await expect(rawLiveChildren(env.h, children[0]!.id)).resolves.toMatchObject([
      {content: 'Doing', reference_target_id: null},
    ])
    await expect(env.repo.block('parent').childIds.load()).resolves.toEqual([children[0]!.id])
  })

  it('writes kernel and plugin schemas as property children too', async () => {
    env = await setup()
    await createRoot(env.repo, 'parent')

    await env.repo.mutate.setProperty({
      id: 'parent',
      schema: rendererProp,
      value: 'markdown',
    })

    expect(env.repo.cache.getSnapshot('parent')?.properties.renderer).toBe('markdown')
    const children = await rawLiveChildren(env.h, 'parent')
    expect(children).toHaveLength(1)
    expect(children[0]!.content).toBe('[[renderer]]')
    expect(children[0]!.reference_target_id).toBe(rendererProp.fieldId)
    await expect(rawLiveChildren(env.h, children[0]!.id)).resolves.toMatchObject([
      {content: 'markdown', reference_target_id: null},
    ])
    await expect(env.repo.block('parent').childIds.load()).resolves.toEqual([children[0]!.id])
  })

  it('materializes property children for raw properties writes', async () => {
    env = await setup()
    await createRoot(env.repo, 'parent')

    await env.repo.tx(async tx => {
      await tx.update('parent', {
        properties: {
          [env.statusProp.name]: env.statusProp.codec.encode('Doing'),
        },
      })
    }, {scope: ChangeScope.BlockDefault})

    const children = await rawLiveChildren(env.h, 'parent')
    expect(children).toHaveLength(1)
    expect(children[0]!.content).toBe('[[status]]')
    expect(children[0]!.reference_target_id).toBe(env.statusProp.fieldId)
    await expect(rawLiveChildren(env.h, children[0]!.id)).resolves.toMatchObject([
      {content: 'Doing'},
    ])
  })

  it('backfills pre-child properties_json rows into field/value children', async () => {
    env = await setup()
    await seedLegacyPropertiesRow(env.h, 'legacy-parent', 'a0', {
      [env.statusProp.name]: env.statusProp.codec.encode('Doing'),
    })

    await env.repo.backfillPropertyChildrenFromProperties({
      workspaceId: WS,
      batchSize: 1,
      respectCompletionMarkers: false,
    })

    const children = await rawLiveChildren(env.h, 'legacy-parent')
    expect(children).toHaveLength(1)
    expect(children[0]!).toMatchObject({
      content: '[[status]]',
      reference_target_id: env.statusProp.fieldId,
    })
    await expect(rawLiveChildren(env.h, children[0]!.id)).resolves.toMatchObject([
      {content: 'Doing', reference_target_id: null},
    ])
  })

  it('runs the startup migration when schemas become available for the active workspace', async () => {
    env = await setup({registerStatusProp: false})
    await seedLegacyPropertiesRow(env.h, 'legacy-parent', 'a0', {
      [env.statusProp.name]: env.statusProp.codec.encode('Doing'),
    })

    env.repo.setRuntimeContributions(propertySchemasFacet, 'test', [env.statusProp])
    await env.repo.__drainPropertyChildrenBackfillForTesting()

    const children = await rawLiveChildren(env.h, 'legacy-parent')
    expect(children).toHaveLength(1)
    expect(children[0]!).toMatchObject({
      content: '[[status]]',
      reference_target_id: env.statusProp.fieldId,
    })
    await expect(rawLiveChildren(env.h, children[0]!.id)).resolves.toMatchObject([
      {content: 'Doing', reference_target_id: null},
    ])
  })

  it('marks full backfills complete while row-targeted sync catch-up bypasses the marker', async () => {
    env = await setup({activateWorkspace: false})
    await seedLegacyPropertiesRow(env.h, 'legacy-parent', 'a0', {
      [env.statusProp.name]: env.statusProp.codec.encode('Doing'),
    })

    await expect(env.repo.backfillPropertyChildrenFromProperties({
      workspaceId: WS,
      batchSize: 1,
    })).resolves.toBe(1)

    const markerKey = `${PROPERTY_CHILDREN_BACKFILL_MARKER_PREFIX}${WS}:${env.statusProp.fieldId}:${env.statusProp.name}`
    await expect(env.h.db.getOptional<{key: string}>(
      'SELECT key FROM client_schema_state WHERE key = ?',
      [markerKey],
    )).resolves.toEqual({key: markerKey})

    await seedLegacyPropertiesRow(env.h, 'late-parent', 'b0', {
      [env.statusProp.name]: env.statusProp.codec.encode('Later'),
    })

    await expect(env.repo.backfillPropertyChildrenFromProperties({
      workspaceId: WS,
      batchSize: 1,
    })).resolves.toBe(0)
    await expect(rawLiveChildren(env.h, 'late-parent')).resolves.toEqual([])

    await expect(env.repo.backfillPropertyChildrenFromProperties({
      workspaceId: WS,
      blockIds: ['late-parent'],
    })).resolves.toBe(1)

    const children = await rawLiveChildren(env.h, 'late-parent')
    expect(children).toHaveLength(1)
    expect(children[0]!).toMatchObject({
      content: '[[status]]',
      reference_target_id: env.statusProp.fieldId,
    })
    await expect(rawLiveChildren(env.h, children[0]!.id)).resolves.toMatchObject([
      {content: 'Later', reference_target_id: null},
    ])
  })

  it('reprojects the parent cache when the property child content changes', async () => {
    env = await setup()
    await createRoot(env.repo, 'parent')
    await env.repo.mutate.setProperty({
      id: 'parent',
      schema: env.statusProp,
      value: 'Doing',
    })
    const fieldId = (await rawLiveChildren(env.h, 'parent'))[0]!.id
    const childId = (await rawLiveChildren(env.h, fieldId))[0]!.id

    await env.repo.mutate.setContent({id: childId, content: 'Done'})

    expect(env.repo.cache.getSnapshot('parent')?.properties.status).toBe('Done')
  })

  it('derives a field reference target from exact wikilink content in the same transaction', async () => {
    env = await setup()
    await createRoot(env.repo, 'parent')

    await env.repo.tx(async tx => {
      await tx.create({
        id: 'status-field-row',
        workspaceId: WS,
        parentId: 'parent',
        orderKey: 'a0',
        content: '[[status]]',
      })
      await tx.create({
        id: 'status-value-row',
        workspaceId: WS,
        parentId: 'status-field-row',
        orderKey: 'a0',
        content: 'Doing',
      })
    }, {scope: ChangeScope.BlockDefault})

    const [field] = await rawLiveChildren(env.h, 'parent')
    expect(field).toMatchObject({
      id: 'status-field-row',
      content: '[[status]]',
      reference_target_id: env.statusProp.fieldId,
    })
    expect(env.repo.cache.getSnapshot('parent')?.properties.status).toBe('Doing')
  })

  it('derives a field reference target from an exact block-ref field definition', async () => {
    const schemaBlockId = '63a14fa0-2f07-4793-a8e1-151f3775cb2c'
    const customProp = defineProperty<string>('custom', {
      codec: codecs.string,
      defaultValue: '',
      changeScope: ChangeScope.BlockDefault,
      fieldId: schemaBlockId,
    })
    env = await setup({extraSchemas: [customProp]})
    await createRoot(env.repo, 'parent')

    await env.repo.tx(async tx => {
      await tx.create({
        id: 'custom-field-row',
        workspaceId: WS,
        parentId: 'parent',
        orderKey: 'a0',
        content: `((63a14fa0-2f07-4793-a8e1-151f3775cb2c))`,
      })
      await tx.create({
        id: 'custom-value-row',
        workspaceId: WS,
        parentId: 'custom-field-row',
        orderKey: 'a0',
        content: 'Filled',
      })
    }, {scope: ChangeScope.BlockDefault})

    const [field] = await rawLiveChildren(env.h, 'parent')
    expect(field).toMatchObject({
      id: 'custom-field-row',
      content: '((63a14fa0-2f07-4793-a8e1-151f3775cb2c))',
      reference_target_id: schemaBlockId,
    })
    await expect(env.repo.block('parent').childIds.load()).resolves.toEqual(['custom-field-row'])
    expect(env.repo.cache.getSnapshot('parent')?.properties.custom).toBe('Filled')
  })

  it('derives a field reference target when an existing child is edited to an exact block-ref field definition', async () => {
    const schemaBlockId = '63a14fa0-2f07-4793-a8e1-151f3775cb2c'
    const customProp = defineProperty<string>('custom', {
      codec: codecs.string,
      defaultValue: '',
      changeScope: ChangeScope.BlockDefault,
      fieldId: schemaBlockId,
    })
    env = await setup({extraSchemas: [customProp]})
    await createRoot(env.repo, 'parent')

    await env.repo.mutate.createChild({
      id: 'custom-field-row',
      parentId: 'parent',
      content: '',
    })
    await env.repo.mutate.setContent({
      id: 'custom-field-row',
      content: '((63a14fa0-2f07-4793-a8e1-151f3775cb2c))',
    })
    await env.repo.mutate.createChild({
      id: 'custom-value-row',
      parentId: 'custom-field-row',
      content: 'Filled',
    })

    const [field] = await rawLiveChildren(env.h, 'parent')
    expect(field).toMatchObject({
      id: 'custom-field-row',
      content: '((63a14fa0-2f07-4793-a8e1-151f3775cb2c))',
      reference_target_id: schemaBlockId,
    })
    expect(env.repo.cache.getSnapshot('parent')?.properties.custom).toBe('Filled')
  })

  it('materializes default child rows for properties declared by a newly added type', async () => {
    env = await setup()
    await createRoot(env.repo, 'parent')

    await env.repo.addType('parent', PAGE_TYPE)

    expect(env.repo.cache.getSnapshot('parent')?.properties.alias).toBeUndefined()

    const children = await rawLiveChildren(env.h, 'parent')
    const aliasField = children.find(child => child.reference_target_id === aliasesProp.fieldId)
    expect(aliasField).toMatchObject({
      content: '[[alias]]',
      reference_target_id: aliasesProp.fieldId,
    })
    await expect(rawLiveChildren(env.h, aliasField!.id)).resolves.toEqual([])
  })

  it('reprojects both parents when a property child is moved', async () => {
    env = await setup()
    await createRoot(env.repo, 'source')
    await createRoot(env.repo, 'target')
    await env.repo.mutate.setProperty({
      id: 'source',
      schema: env.statusProp,
      value: 'Blocked',
    })
    const childId = (await rawLiveChildren(env.h, 'source'))[0]!.id

    await env.repo.mutate.move({
      id: childId,
      parentId: 'target',
      position: {kind: 'last'},
    })

    expect(env.repo.cache.getSnapshot('source')?.properties.status).toBeUndefined()
    expect(env.repo.cache.getSnapshot('target')?.properties.status).toBe('Blocked')
  })

  it('deletes the backing child when a child-backed property is deleted from the panel action', async () => {
    env = await setup()
    await createRoot(env.repo, 'parent')
    await env.repo.mutate.setProperty({
      id: 'parent',
      schema: env.statusProp,
      value: 'Doing',
    })

    await deleteProperty({
      block: env.repo.block('parent'),
      properties: env.repo.cache.getSnapshot('parent')!.properties,
      schemas: env.repo.propertySchemas,
      uis: new Map(),
      name: 'status',
    })

    expect(env.repo.cache.getSnapshot('parent')?.properties.status).toBeUndefined()
    expect(await rawLiveChildren(env.h, 'parent')).toEqual([])
  })
})

describe('UserSchemasService child-backed field identity', () => {
  it('uses the schema block id as field identity and reprojects parent cache on schema rename', async () => {
    env = await setup({registerStatusProp: false})
    await getOrCreatePropertiesPage(env.repo, WS)
    env.dispose = env.repo.userSchemas.start()
    const schema = await env.repo.userSchemas.addSchema({name: 'status', presetId: 'string'})
    const schemaBlockId = env.repo.userSchemas.getSchemaBlockId('status')!
    await createRoot(env.repo, 'parent')

    await env.repo.mutate.setProperty({
      id: 'parent',
      schema,
      value: 'Doing',
    })

    const child = (await rawLiveChildren(env.h, 'parent'))[0]!
    expect(child.reference_target_id).toBe(schemaBlockId)

    await env.repo.tx(async tx => {
      await tx.setProperty(schemaBlockId, propertyNameProp, 'state')
    }, {scope: ChangeScope.BlockDefault})

    await vi.waitFor(() => {
      expect(env.repo.cache.getSnapshot('parent')?.properties.status).toBeUndefined()
      expect(env.repo.cache.getSnapshot('parent')?.properties.state).toBe('Doing')
    })
  })

  it('renders user-schema block-ref field definitions created by editing an existing child', async () => {
    env = await setup({registerStatusProp: false})
    await getOrCreatePropertiesPage(env.repo, WS)
    env.dispose = env.repo.userSchemas.start()
    const schema = await env.repo.userSchemas.addSchema({name: 'custom-checkbox', presetId: 'boolean'})
    const schemaBlockId = env.repo.userSchemas.getSchemaBlockId(schema.name)!
    await createRoot(env.repo, 'parent')

    await env.repo.mutate.createChild({
      id: 'custom-field-row',
      parentId: 'parent',
      content: '',
    })
    await env.repo.mutate.setContent({
      id: 'custom-field-row',
      content: `((${schemaBlockId}))`,
    })
    await env.repo.mutate.createChild({
      id: 'custom-value-row',
      parentId: 'custom-field-row',
      content: 'true',
    })

    const [field] = await rawLiveChildren(env.h, 'parent')
    expect(field).toMatchObject({
      id: 'custom-field-row',
      content: `((${schemaBlockId}))`,
      reference_target_id: schemaBlockId,
    })
    expect(env.repo.userSchemas.getSchemaForBlockId(schemaBlockId)?.name).toBe('custom-checkbox')
    expect(env.repo.cache.getSnapshot('parent')?.properties['custom-checkbox']).toBe(true)
  })

})
