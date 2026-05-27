// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveFacetRuntimeSync } from '@/extensions/facet'
import { ChangeScope, codecs, defineProperty, type AnyPropertySchema } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { propertySchemasFacet } from '@/data/facets'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { propertyNameProp, rendererProp } from '@/data/properties'
import { getOrCreatePropertiesPage } from '@/data/propertiesPage'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
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
} = {}): Promise<Harness> => {
  const {
    registerStatusProp = true,
    extraSchemas = [],
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
  repo.setActiveWorkspaceId(WS)
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
})
