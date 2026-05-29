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

  it('logs migration batch timing and throughput', async () => {
    env = await setup({activateWorkspace: false})
    await seedLegacyPropertiesRow(env.h, 'legacy-parent', 'a0', {
      [env.statusProp.name]: env.statusProp.codec.encode('Doing'),
    })
    const messages = await (async (): Promise<string[]> => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {})
      try {
        await env.repo.backfillPropertyChildrenFromProperties({
          workspaceId: WS,
          respectCompletionMarkers: false,
          logProgress: true,
        })
        return info.mock.calls.map(([message]) => String(message))
      } finally {
        info.mockRestore()
      }
    })()

    expect(messages.some(message => message.includes('parentBatchSize=row-target'))).toBe(true)
    expect(messages.some(message => message.includes('targetInsertRows=120'))).toBe(true)
    const batchMessage = messages.find(message => message.includes('property children migration batch 1'))
    expect(batchMessage).toEqual(expect.stringContaining('properties=1'))
    expect(batchMessage).toEqual(expect.stringContaining('estimatedInsertRows=2'))
    expect(batchMessage).toEqual(expect.stringContaining('writeMode=single'))
    expect(batchMessage).toEqual(expect.stringContaining('bulkParents=1'))
    expect(batchMessage).toEqual(expect.stringContaining('fallbackParents=0'))
    expect(batchMessage).toEqual(expect.stringContaining('createdFieldRows=1'))
    expect(batchMessage).toEqual(expect.stringContaining('createdValueRows=1'))
    expect(batchMessage).toEqual(expect.stringContaining('parentChildrenReads=0'))
    expect(batchMessage).toEqual(expect.stringContaining('txUserFnMs='))
    expect(batchMessage).toEqual(expect.stringContaining('txSameTxMs=0'))
    expect(batchMessage).toEqual(expect.stringContaining('txSameTxRows=0'))
    expect(batchMessage).toEqual(expect.stringContaining('txSnapshots='))
    expect(batchMessage).toEqual(expect.stringContaining('sameTxProcessors=none'))
    expect(batchMessage).toEqual(expect.stringContaining('dbDelta='))
    expect(batchMessage).toEqual(expect.stringContaining('scanMs='))
    expect(batchMessage).toEqual(expect.stringContaining('writeMs='))
    expect(batchMessage).toEqual(expect.stringContaining('batchMs='))
    expect(batchMessage).toEqual(expect.stringContaining('candidatesPerSecond='))
    expect(batchMessage).toEqual(expect.stringContaining('propertiesPerSecond='))
    const completeMessage = messages.find(message => message.includes('property children migration complete'))
    expect(completeMessage).toEqual(expect.stringContaining('candidatesPerSecond='))
  })

  it('uses an estimated insert-row budget for default full backfill batches', async () => {
    env = await setup({activateWorkspace: false})
    for (let index = 0; index < 3; index += 1) {
      await seedLegacyPropertiesRow(env.h, `legacy-parent-${index}`, `a${index}`, {
        [env.statusProp.name]: env.statusProp.codec.encode(`Doing ${index}`),
      })
    }

    const messages = await (async (): Promise<string[]> => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {})
      try {
        await expect(env.repo.backfillPropertyChildrenFromProperties({
          workspaceId: WS,
          targetInsertRows: 4,
          respectCompletionMarkers: false,
          logProgress: true,
        })).resolves.toBe(3)
        return info.mock.calls.map(([message]) => String(message))
      } finally {
        info.mockRestore()
      }
    })()

    expect(messages.some(message => message.includes('targetInsertRows=4'))).toBe(true)
    const batchMessages = messages.filter(message => message.includes('property children migration batch'))
    expect(batchMessages).toHaveLength(2)
    expect(batchMessages[0]).toEqual(expect.stringContaining('blocks=2'))
    expect(batchMessages[0]).toEqual(expect.stringContaining('properties=2'))
    expect(batchMessages[0]).toEqual(expect.stringContaining('estimatedInsertRows=4'))
    expect(batchMessages[1]).toEqual(expect.stringContaining('blocks=1'))
    expect(batchMessages[1]).toEqual(expect.stringContaining('properties=1'))
    expect(batchMessages[1]).toEqual(expect.stringContaining('estimatedInsertRows=2'))
  })

  it('backfills as a system migration without adding user undo entries', async () => {
    env = await setup()
    await seedLegacyPropertiesRow(env.h, 'legacy-parent', 'a0', {
      [env.statusProp.name]: env.statusProp.codec.encode('Doing'),
    })

    await env.repo.backfillPropertyChildrenFromProperties({
      workspaceId: WS,
      batchSize: 1,
      respectCompletionMarkers: false,
    })

    const [field] = await rawLiveChildren(env.h, 'legacy-parent')
    expect(field).toMatchObject({
      content: '[[status]]',
      reference_target_id: env.statusProp.fieldId,
    })
    const [value] = await rawLiveChildren(env.h, field!.id)
    expect(value).toMatchObject({content: 'Doing'})

    await expect(env.repo.undo(ChangeScope.BlockDefault)).resolves.toBe(false)
    await expect(rawLiveChildren(env.h, 'legacy-parent')).resolves.toHaveLength(1)

    const rowEvents = await env.h.db.getAll<{kind: string; source: string; tx_id: string | null}>(
      `
        SELECT kind, source, tx_id
        FROM row_events
        WHERE block_id IN (?, ?)
        ORDER BY id
      `,
      [field!.id, value!.id],
    )
    expect(rowEvents).toEqual([
      {kind: 'create', source: 'user', tx_id: expect.any(String)},
      {kind: 'create', source: 'user', tx_id: expect.any(String)},
    ])

    const queuedUploads = await env.h.db.getAll<{tx_id: number | null; data: string}>(
      `SELECT tx_id, data FROM ps_crud ORDER BY id`,
    )
    expect(queuedUploads).toHaveLength(2)
    expect(new Set(queuedUploads.map(row => row.tx_id))).toHaveLength(1)
    expect(queuedUploads.map(row => JSON.parse(row.data).id)).toEqual([field!.id, value!.id])
  })

  it('logs short-write context and retries the failed migration batch in smaller transactions', async () => {
    env = await setup({activateWorkspace: false})
    await seedLegacyPropertiesRow(env.h, 'legacy-parent-a', 'a0', {
      [env.statusProp.name]: env.statusProp.codec.encode('Doing'),
    })
    await seedLegacyPropertiesRow(env.h, 'legacy-parent-b', 'a1', {
      [env.statusProp.name]: env.statusProp.codec.encode('Done'),
    })
    const repoInternals = env.repo as unknown as {
      _runAndDispatch: (...args: unknown[]) => Promise<unknown>
    }
    const originalRunAndDispatch = repoInternals._runAndDispatch.bind(env.repo)
    const runAndDispatch = vi.spyOn(repoInternals, '_runAndDispatch')
    runAndDispatch.mockImplementationOnce(async () => {
      throw new Error('short write')
    })
    runAndDispatch.mockImplementation((...args) => originalRunAndDispatch(...args))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    try {
      await expect(env.repo.backfillPropertyChildrenFromProperties({
        workspaceId: WS,
        batchSize: 2,
        respectCompletionMarkers: false,
        logProgress: true,
      })).resolves.toBe(2)

      expect(runAndDispatch).toHaveBeenCalledTimes(3)
      expect(warn).toHaveBeenCalledWith(
        '[Repo] property children migration write failed',
        expect.objectContaining({
          blocks: 2,
          properties: 2,
          configuredParentBatchSize: 2,
          targetInsertRows: 120,
          scanBatchSize: 2,
          estimatedInsertRows: 4,
          retryBatchSize: 1,
          error: {name: 'Error', message: 'short write'},
          storageEstimate: null,
        }),
      )
      expect(info.mock.calls.map(([message]) => String(message)).some(message =>
        message.includes('property children migration retry 1.1/2'),
      )).toBe(true)
    } finally {
      runAndDispatch.mockRestore()
      warn.mockRestore()
      info.mockRestore()
    }

    await expect(rawLiveChildren(env.h, 'legacy-parent-a')).resolves.toHaveLength(1)
    await expect(rawLiveChildren(env.h, 'legacy-parent-b')).resolves.toHaveLength(1)
  })

  it('retries disk I/O migration failures in smaller transactions', async () => {
    env = await setup({activateWorkspace: false})
    await seedLegacyPropertiesRow(env.h, 'legacy-parent-a', 'a0', {
      [env.statusProp.name]: env.statusProp.codec.encode('Doing'),
    })
    await seedLegacyPropertiesRow(env.h, 'legacy-parent-b', 'a1', {
      [env.statusProp.name]: env.statusProp.codec.encode('Done'),
    })
    const repoInternals = env.repo as unknown as {
      _runAndDispatch: (...args: unknown[]) => Promise<unknown>
    }
    const originalRunAndDispatch = repoInternals._runAndDispatch.bind(env.repo)
    const runAndDispatch = vi.spyOn(repoInternals, '_runAndDispatch')
    runAndDispatch.mockImplementationOnce(async () => {
      throw new Error('disk I/O error')
    })
    runAndDispatch.mockImplementation((...args) => originalRunAndDispatch(...args))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    try {
      await expect(env.repo.backfillPropertyChildrenFromProperties({
        workspaceId: WS,
        batchSize: 2,
        respectCompletionMarkers: false,
        logProgress: true,
      })).resolves.toBe(2)

      expect(runAndDispatch).toHaveBeenCalledTimes(3)
      expect(warn).toHaveBeenCalledWith(
        '[Repo] property children migration write failed',
        expect.objectContaining({
          blocks: 2,
          properties: 2,
          configuredParentBatchSize: 2,
          targetInsertRows: 120,
          scanBatchSize: 2,
          estimatedInsertRows: 4,
          retryBatchSize: 1,
          error: {name: 'Error', message: 'disk I/O error'},
        }),
      )
      const messages = info.mock.calls.map(([message]) => String(message))
      expect(messages.some(message => message.includes('property children migration retry 1.1/2'))).toBe(true)
      expect(messages.some(message => message.includes('writeMode=storage-write-retry'))).toBe(true)
    } finally {
      runAndDispatch.mockRestore()
      warn.mockRestore()
      info.mockRestore()
    }

    await expect(rawLiveChildren(env.h, 'legacy-parent-a')).resolves.toHaveLength(1)
    await expect(rawLiveChildren(env.h, 'legacy-parent-b')).resolves.toHaveLength(1)
  })

  it('keeps splitting retried storage-write chunks when a smaller retry still fails', async () => {
    env = await setup({activateWorkspace: false})
    const ids = Array.from({length: 12}, (_, index) => `legacy-parent-${index}`)
    for (const [index, id] of ids.entries()) {
      await seedLegacyPropertiesRow(env.h, id, `a${String(index).padStart(2, '0')}`, {
        [env.statusProp.name]: env.statusProp.codec.encode(`Doing ${index}`),
      })
    }
    const repoInternals = env.repo as unknown as {
      _runAndDispatch: (...args: unknown[]) => Promise<unknown>
    }
    const originalRunAndDispatch = repoInternals._runAndDispatch.bind(env.repo)
    const runAndDispatch = vi.spyOn(repoInternals, '_runAndDispatch')
    runAndDispatch
      .mockImplementationOnce(async () => { throw new Error('disk I/O error') })
      .mockImplementationOnce(async () => { throw new Error('disk I/O error') })
    runAndDispatch.mockImplementation((...args) => originalRunAndDispatch(...args))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    try {
      await expect(env.repo.backfillPropertyChildrenFromProperties({
        workspaceId: WS,
        batchSize: 12,
        respectCompletionMarkers: false,
        logProgress: true,
      })).resolves.toBe(12)

      const failureLogs = warn.mock.calls
        .filter(([message]) => String(message) === '[Repo] property children migration write failed')
        .map(([, context]) => context as {blocks: number; retryBatchSize: number | null})
      expect(failureLogs).toEqual([
        expect.objectContaining({blocks: 12, retryBatchSize: 5}),
        expect.objectContaining({blocks: 5, retryBatchSize: 2}),
      ])
      const messages = info.mock.calls.map(([message]) => String(message))
      expect(messages.some(message => message.includes('property children migration retry 1.1.1/3'))).toBe(true)
      expect(messages.some(message => message.includes('writeMode=storage-write-retry'))).toBe(true)
    } finally {
      runAndDispatch.mockRestore()
      warn.mockRestore()
      info.mockRestore()
    }

    for (const id of ids) {
      await expect(rawLiveChildren(env.h, id)).resolves.toHaveLength(1)
    }
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
