// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest'
import { resolveFacetRuntimeSync } from '@/extensions/facet'
import { ChangeScope } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { kernelPropertyUiExtension } from '@/components/propertyEditors/typesPropertyUi'
import { kernelValuePresetsExtension } from '@/components/propertyEditors/kernelValuePresets'
import {
  blockTypeLabelProp,
  blockTypePropertiesProp,
  getBlockTypes,
  typesProp,
} from '@/data/properties'
import { BLOCK_TYPE_TYPE, PAGE_TYPE } from '@/data/blockTypes'
import { getOrCreatePropertiesPage } from '@/data/propertiesPage'
import { getOrCreateTypesPage } from '@/data/typesPage'
import { Repo } from '@/data/repo'
import {
  TypeRegistrationTimeout,
  createTypeBlock,
  findCandidatesByPropertyShape,
  retagBlocks,
} from '@/data/typeExtraction'

const WS = 'ws-type-extraction'

interface Harness {
  h: TestDb
  repo: Repo
  dispose: () => void
}

const setup = async (): Promise<Harness> => {
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
  repo.setActiveWorkspaceId(WS)
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    kernelPropertyUiExtension,
    kernelValuePresetsExtension,
  ]))
  await getOrCreatePropertiesPage(repo, WS)
  await getOrCreateTypesPage(repo, WS)
  const disposeUserSchemas = repo.userSchemas.start()
  const disposeUserTypes = repo.userTypes.start()
  const dispose = (): void => {
    disposeUserTypes()
    disposeUserSchemas()
  }
  return {h, repo, dispose}
}

const createBlock = async (env: Harness, content: string, properties: Record<string, unknown> = {}): Promise<string> => {
  const id = await env.repo.mutate.createChild({parentId: env.repo.typesPageId!})
  await env.repo.tx(async tx => {
    const block = await tx.get(id)
    if (!block) throw new Error(`createChild missed: ${id}`)
    await tx.update(id, {
      content,
      properties: {...block.properties, ...properties},
    })
  }, {scope: ChangeScope.BlockDefault})
  return id
}

let env: Harness
afterEach(async () => {
  env.dispose()
  await env.h.cleanup()
})

// ──── createTypeBlock ───────────────────────────────────────────────

describe('createTypeBlock', () => {
  it('materializes a fresh block-type block on the Types page with label + properties refList', async () => {
    env = await setup()
    const schema = await env.repo.userSchemas.addSchema({name: 'status', presetId: 'string'})
    const schemaBlockId = env.repo.userSchemas.getSchemaBlockId(schema.name)!

    const typeId = await createTypeBlock(env.repo, {
      workspaceId: WS,
      label: 'Task',
      propertySchemaIds: [schemaBlockId],
    })

    const row = await env.repo.load(typeId)
    expect(row).not.toBeNull()
    const types = getBlockTypes(row!)
    expect(types).toContain(BLOCK_TYPE_TYPE)
    expect(types).toContain(PAGE_TYPE)
    expect(row!.properties[blockTypeLabelProp.name]).toBe('Task')
    expect(row!.properties[blockTypePropertiesProp.name]).toEqual([schemaBlockId])
    expect(row!.parentId).toBe(env.repo.typesPageId)
    expect(row!.content).toBe('Task')
  })

  it('returns a typeId that is registered in repo.types by the time the promise resolves', async () => {
    env = await setup()
    const typeId = await createTypeBlock(env.repo, {
      workspaceId: WS,
      label: 'Task',
      propertySchemaIds: [],
    })
    expect(env.repo.types.has(typeId)).toBe(true)
    expect(env.repo.types.get(typeId)?.label).toBe('Task')
  })

  it('returns distinct ids on repeat calls (no in-place collision)', async () => {
    env = await setup()
    const a = await createTypeBlock(env.repo, {workspaceId: WS, label: 'Task', propertySchemaIds: []})
    const b = await createTypeBlock(env.repo, {workspaceId: WS, label: 'Task', propertySchemaIds: []})
    expect(a).not.toBe(b)
    expect(env.repo.types.has(a)).toBe(true)
    expect(env.repo.types.has(b)).toBe(true)
  })

  it('throws when label is blank', async () => {
    env = await setup()
    await expect(createTypeBlock(env.repo, {
      workspaceId: WS,
      label: '   ',
      propertySchemaIds: [],
    })).rejects.toThrow(/label must be a non-empty string/)
  })

  it('throws when a propertySchemaId does not resolve to a live block', async () => {
    env = await setup()
    await expect(createTypeBlock(env.repo, {
      workspaceId: WS,
      label: 'Task',
      propertySchemaIds: ['nonexistent-schema'],
    })).rejects.toThrow(/doesn't resolve to a live block/)
  })

  it('honors an aborted signal pre-flight', async () => {
    env = await setup()
    const controller = new AbortController()
    controller.abort()
    await expect(createTypeBlock(env.repo, {
      workspaceId: WS,
      label: 'Task',
      propertySchemaIds: [],
      signal: controller.signal,
    })).rejects.toBeDefined()
  })

  it('TypeRegistrationTimeout has the expected shape', () => {
    const err = new TypeRegistrationTimeout('type-id', 'Task', 1500)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('TypeRegistrationTimeout')
    expect(err.typeBlockId).toBe('type-id')
    expect(err.typeLabel).toBe('Task')
    expect(err.timeoutMs).toBe(1500)
    expect(err.message).toContain('did not appear in the runtime registry within 1500ms')
  })
})

// ──── retagBlocks ───────────────────────────────────────────────────

describe('retagBlocks', () => {
  it('applies the type to every instance id in one tx', async () => {
    env = await setup()
    const typeId = await createTypeBlock(env.repo, {workspaceId: WS, label: 'Task', propertySchemaIds: []})
    const a = await createBlock(env, 'Block A')
    const b = await createBlock(env, 'Block B')
    const c = await createBlock(env, 'Block C')

    await retagBlocks(env.repo, {typeId, instanceIds: [a, b, c]})

    for (const id of [a, b, c]) {
      const row = await env.repo.load(id)
      expect(getBlockTypes(row!)).toContain(typeId)
    }
  })

  it('is idempotent — re-tagging an already-tagged block is a no-op', async () => {
    env = await setup()
    const typeId = await createTypeBlock(env.repo, {workspaceId: WS, label: 'Task', propertySchemaIds: []})
    const id = await createBlock(env, 'A')
    await retagBlocks(env.repo, {typeId, instanceIds: [id]})
    await retagBlocks(env.repo, {typeId, instanceIds: [id]})
    const row = await env.repo.load(id)
    const tagged = getBlockTypes(row!).filter(t => t === typeId)
    expect(tagged).toHaveLength(1)
  })

  it('silently skips ids that are missing or tombstoned', async () => {
    env = await setup()
    const typeId = await createTypeBlock(env.repo, {workspaceId: WS, label: 'Task', propertySchemaIds: []})
    const liveId = await createBlock(env, 'Live')

    // Should not throw on a mix of live + missing ids.
    await retagBlocks(env.repo, {typeId, instanceIds: [liveId, 'missing-id']})

    const live = await env.repo.load(liveId)
    expect(getBlockTypes(live!)).toContain(typeId)
  })

  it('throws when the type is not registered', async () => {
    env = await setup()
    const id = await createBlock(env, 'A')
    await expect(retagBlocks(env.repo, {
      typeId: 'not-a-type',
      instanceIds: [id],
    })).rejects.toThrow(/type not-a-type is not registered/)
  })

  it('is a no-op when instanceIds is empty', async () => {
    env = await setup()
    const typeId = await createTypeBlock(env.repo, {workspaceId: WS, label: 'Task', propertySchemaIds: []})
    await expect(retagBlocks(env.repo, {typeId, instanceIds: []})).resolves.toBeUndefined()
  })

  it('honors an aborted signal pre-flight', async () => {
    env = await setup()
    const typeId = await createTypeBlock(env.repo, {workspaceId: WS, label: 'Task', propertySchemaIds: []})
    const id = await createBlock(env, 'A')
    const controller = new AbortController()
    controller.abort()
    await expect(retagBlocks(env.repo, {
      typeId,
      instanceIds: [id],
      signal: controller.signal,
    })).rejects.toBeDefined()
    const row = await env.repo.load(id)
    expect(getBlockTypes(row!)).not.toContain(typeId)
  })
})

// ──── findCandidatesByPropertyShape ─────────────────────────────────

describe('findCandidatesByPropertyShape', () => {
  it('returns blocks whose properties_json carries every named property', async () => {
    env = await setup()
    const statusSchema = await env.repo.userSchemas.addSchema({name: 'status', presetId: 'string'})
    const dueSchema = await env.repo.userSchemas.addSchema({name: 'due', presetId: 'string'})
    void statusSchema
    void dueSchema

    const hasBoth = await createBlock(env, 'Both', {status: 'open', due: '2026-05-20'})
    const hasOnlyStatus = await createBlock(env, 'OnlyStatus', {status: 'open'})
    const hasOnlyDue = await createBlock(env, 'OnlyDue', {due: '2026-05-20'})
    const hasNeither = await createBlock(env, 'Neither')

    const candidates = await findCandidatesByPropertyShape(env.repo, {
      workspaceId: WS,
      shape: [{name: 'status'}, {name: 'due'}],
    })

    expect(candidates).toContain(hasBoth)
    expect(candidates).not.toContain(hasOnlyStatus)
    expect(candidates).not.toContain(hasOnlyDue)
    expect(candidates).not.toContain(hasNeither)
  })

  it('respects per-property value filters', async () => {
    env = await setup()
    await env.repo.userSchemas.addSchema({name: 'status', presetId: 'string'})

    const open = await createBlock(env, 'Open', {status: 'open'})
    const done = await createBlock(env, 'Done', {status: 'done'})

    const candidates = await findCandidatesByPropertyShape(env.repo, {
      workspaceId: WS,
      shape: [{name: 'status', value: 'open'}],
    })

    expect(candidates).toContain(open)
    expect(candidates).not.toContain(done)
  })

  it('excludes ids passed in `exclude` (typical: the prototype itself)', async () => {
    env = await setup()
    await env.repo.userSchemas.addSchema({name: 'status', presetId: 'string'})

    const prototype = await createBlock(env, 'Prototype', {status: 'open'})
    const sibling = await createBlock(env, 'Sibling', {status: 'open'})

    const candidates = await findCandidatesByPropertyShape(env.repo, {
      workspaceId: WS,
      shape: [{name: 'status'}],
      exclude: [prototype],
    })

    expect(candidates).not.toContain(prototype)
    expect(candidates).toContain(sibling)
  })

  it('returns an empty array when shape is empty (no implicit "everything" match)', async () => {
    env = await setup()
    await createBlock(env, 'A')
    const candidates = await findCandidatesByPropertyShape(env.repo, {
      workspaceId: WS,
      shape: [],
    })
    expect(candidates).toEqual([])
  })

  it('caps results at the limit when given', async () => {
    env = await setup()
    await env.repo.userSchemas.addSchema({name: 'status', presetId: 'string'})
    for (let i = 0; i < 5; i++) {
      await createBlock(env, `B${i}`, {status: 'open'})
    }
    const candidates = await findCandidatesByPropertyShape(env.repo, {
      workspaceId: WS,
      shape: [{name: 'status'}],
      limit: 3,
    })
    expect(candidates).toHaveLength(3)
  })
})

// ──── Composition: extract-type-from-prototype flow ─────────────────

describe('extract-type-from-prototype composition', () => {
  it('createTypeBlock + findCandidatesByPropertyShape + retagBlocks compose end-to-end', async () => {
    env = await setup()
    const statusSchema = await env.repo.userSchemas.addSchema({name: 'status', presetId: 'string'})
    const dueSchema = await env.repo.userSchemas.addSchema({name: 'due', presetId: 'string'})
    const statusBlockId = env.repo.userSchemas.getSchemaBlockId(statusSchema.name)!
    const dueBlockId = env.repo.userSchemas.getSchemaBlockId(dueSchema.name)!

    // Prototype: a block with the property shape the user wants to canonize.
    const prototype = await createBlock(env, 'Buy milk', {status: 'open', due: '2026-05-20'})
    // Other blocks with the same shape — should become candidates.
    const otherA = await createBlock(env, 'Call mom', {status: 'open', due: '2026-05-21'})
    const otherB = await createBlock(env, 'Pay rent', {status: 'done', due: '2026-05-01'})
    // Off-shape block — should not be a candidate.
    const unrelated = await createBlock(env, 'Random', {})

    // Step 1: user names the type, picks the property subset → create the type definition.
    const typeId = await createTypeBlock(env.repo, {
      workspaceId: WS,
      label: 'Task',
      propertySchemaIds: [statusBlockId, dueBlockId],
    })

    // Step 2: find candidates with the same property shape, excluding the prototype.
    const candidates = await findCandidatesByPropertyShape(env.repo, {
      workspaceId: WS,
      shape: [{name: 'status'}, {name: 'due'}],
      exclude: [prototype],
    })

    expect(new Set(candidates)).toEqual(new Set([otherA, otherB]))
    expect(candidates).not.toContain(unrelated)
    expect(candidates).not.toContain(prototype)

    // Step 3: user confirms; retag the picked instances.
    await retagBlocks(env.repo, {typeId, instanceIds: candidates})

    for (const id of candidates) {
      const row = await env.repo.load(id)
      expect(getBlockTypes(row!)).toContain(typeId)
    }
    // Prototype was excluded — not retagged.
    const prototypeRow = await env.repo.load(prototype)
    expect(getBlockTypes(prototypeRow!)).not.toContain(typeId)
    // Unrelated was filtered by shape — also not retagged.
    const unrelatedRow = await env.repo.load(unrelated)
    expect(getBlockTypes(unrelatedRow!)).not.toContain(typeId)
  })
})

// ──── typesProp shape preservation ──────────────────────────────────

describe('retagBlocks preserves existing types', () => {
  it('appends rather than replacing', async () => {
    env = await setup()
    const typeId = await createTypeBlock(env.repo, {workspaceId: WS, label: 'Task', propertySchemaIds: []})
    const id = await createBlock(env, 'A')
    // Stamp an unrelated synthetic type id first.
    await env.repo.tx(async tx => {
      const row = await tx.get(id)
      if (!row) throw new Error('missing')
      await tx.update(id, {
        properties: {...row.properties, [typesProp.name]: ['some-other-type']},
      })
    }, {scope: ChangeScope.BlockDefault})

    await retagBlocks(env.repo, {typeId, instanceIds: [id]})

    const row = await env.repo.load(id)
    const types = getBlockTypes(row!)
    expect(types).toContain('some-other-type')
    expect(types).toContain(typeId)
  })
})
