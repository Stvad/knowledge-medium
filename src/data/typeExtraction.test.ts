// @vitest-environment node

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { kernelPropertyUiExtension } from '@/components/propertyEditors/typesPropertyUi'
import { kernelValuePresetsExtension } from '@/components/propertyEditors/kernelValuePresets'
import {
  aliasesProp,
  blockTypeLabelProp,
  blockTypePropertiesProp,
  getBlockTypes,
  typesProp,
} from '@/data/properties'
import { BLOCK_TYPE_TYPE, PAGE_TYPE } from '@/data/blockTypes'
import { getOrCreatePropertiesPage } from '@/data/propertiesPage'
import { getOrCreateTypesPage, typesPageBlockId } from '@/data/typesPage'
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
  // Shared DB opened once per file, reset between tests; fresh Repo per test.
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const { repo } = createTestRepo({
    db: h.db,
    user: {id: 'user-1'},
    extensions: [
      kernelPropertyUiExtension,
      kernelValuePresetsExtension,
    ],
  })
  repo.setActiveWorkspaceId(WS)
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

/** Test-only helper: create a block carrying a refList property AND
 *  the corresponding `references_json` entries (one per target id,
 *  with the same sourceField).
 *
 *  Production keeps `references_json` in sync with refList properties
 *  via `parseReferencesProcessor` (post-commit, in the references
 *  plugin). The kernel-only test harness here doesn't load that
 *  plugin, so refList writes alone wouldn't populate `block_references`
 *  — and the `referencedBy`-based query under test would return nothing.
 *  Writing the references explicitly stands in for the missing
 *  processor. */
const createBlockWithRefs = async (
  env: Harness,
  content: string,
  sourceField: string,
  targetIds: readonly string[],
): Promise<string> => {
  const id = await env.repo.mutate.createChild({parentId: env.repo.typesPageId!})
  await env.repo.tx(async tx => {
    const block = await tx.get(id)
    if (!block) throw new Error(`createChild missed: ${id}`)
    await tx.update(id, {
      content,
      properties: {...block.properties, [sourceField]: targetIds},
      references: targetIds.map(targetId => ({id: targetId, alias: targetId, sourceField})),
    })
  }, {scope: ChangeScope.BlockDefault})
  return id
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
afterEach(() => {
  // Dispose the per-test services; the shared DB is closed once in afterAll.
  // (Each test calls `env = await setup()`, which resets the DB first.)
  env.dispose()
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
    // The type doubles as its `[[Task]]` page — it claims the label as
    // an alias.
    expect(row!.properties[aliasesProp.name]).toEqual(['Task'])
  })

  it('claims the label as an alias so [[label]] resolves to the type block', async () => {
    env = await setup()
    const typeId = await createTypeBlock(env.repo, {
      workspaceId: WS,
      label: 'Task',
      propertySchemaIds: [],
    })

    // The alias index is trigger-maintained; `[[Task]]` resolution
    // (aliasLookup) must land on the type-definition block rather than
    // minting a separate alias-seat page.
    const resolved = await env.repo.query
      .aliasLookup({workspaceId: WS, alias: 'Task'})
      .load()
    expect(resolved?.id).toBe(typeId)
  })

  it('rejects when the label collides with an existing page alias', async () => {
    env = await setup()
    // A prior `[[Task]]` reference (or create-page UI) already left a
    // live block claiming the alias in this workspace.
    const pageId = await env.repo.mutate.createChild({parentId: env.repo.typesPageId!})
    await env.repo.tx(async tx => {
      await tx.update(pageId, {content: 'Task'})
      await tx.setProperty(pageId, aliasesProp, ['Task'])
    }, {scope: ChangeScope.BlockDefault})

    await expect(createTypeBlock(env.repo, {
      workspaceId: WS,
      label: 'Task',
      propertySchemaIds: [],
    })).rejects.toMatchObject({code: 'alias.collision'})
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
    // Distinct labels: each type claims its label as a workspace-unique
    // alias, so two same-named types can't coexist (covered separately).
    // The property under test is that repeat calls mint fresh block ids
    // rather than reusing a deterministic one.
    const a = await createTypeBlock(env.repo, {workspaceId: WS, label: 'Task', propertySchemaIds: []})
    const b = await createTypeBlock(env.repo, {workspaceId: WS, label: 'Project', propertySchemaIds: []})
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
    // throwIfAborted() rejects with signal.reason — an AbortError
    // DOMException. Pin the abort contract so a swap to some unrelated
    // error (or a rejection with undefined) is caught.
    await expect(createTypeBlock(env.repo, {
      workspaceId: WS,
      label: 'Task',
      propertySchemaIds: [],
      signal: controller.signal,
    })).rejects.toMatchObject({name: 'AbortError'})
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

  it('parents under args.workspaceId\'s Types page, not the active workspace', async () => {
    // Guard against the regression where createTypeBlock used
    // `repo.typesPageId` (derived from `activeWorkspaceId`) instead of
    // `args.workspaceId`. With only `WS` bootstrapped, asking for a
    // type in some other workspace must surface the missing-Types-page
    // error rather than silently parenting under WS.
    env = await setup()
    await expect(createTypeBlock(env.repo, {
      workspaceId: 'ws-other-no-bootstrap',
      label: 'Task',
      propertySchemaIds: [],
    })).rejects.toThrow(/no Types page for workspace ws-other-no-bootstrap/)
  })
})

// ──── block-type typeify processor ──────────────────────────────────

/** Tag a fresh block `block-type` — the state EVERY tagging path lands
 *  in (`#type`, the picker, programmatic, import). The kernel
 *  `blockTypeTypeify` same-tx processor completes it in this same tx:
 *  adopt content→label, add PAGE_TYPE, claim the label alias. */
const tagBlockType = async (
  env: Harness,
  content: string,
  extraProps: Record<string, unknown> = {},
): Promise<string> => {
  const id = await env.repo.mutate.createChild({parentId: env.repo.typesPageId!})
  await env.repo.tx(async tx => {
    await tx.update(id, {content, properties: extraProps})
    await env.repo.addTypeInTx(tx, id, BLOCK_TYPE_TYPE, {}, env.repo.snapshotTypeRegistries())
  }, {scope: ChangeScope.BlockDefault})
  return id
}

describe('block-type typeify processor', () => {
  it('adopts content as the label, tags PAGE_TYPE, and claims the alias', async () => {
    env = await setup()
    const id = await tagBlockType(env, 'Book')

    const row = await env.repo.load(id)
    expect(row!.properties[blockTypeLabelProp.name]).toBe('Book')
    expect(getBlockTypes(row!)).toContain(PAGE_TYPE)
    expect(row!.properties[aliasesProp.name]).toEqual(['Book'])
    // `[[Book]]` resolves to this block, not a duplicate seat.
    const resolved = await env.repo.query.aliasLookup({workspaceId: WS, alias: 'Book'}).load()
    expect(resolved?.id).toBe(id)
  })

  it('claims the type name even when the block already carries another alias', async () => {
    // Regression: an only-if-empty gate left the type name unclaimed when
    // the block held any other alias, so `[[Book]]` minted a duplicate
    // seat. Ensure-present appends the name to the existing set instead.
    env = await setup()
    const id = await tagBlockType(env, 'Book', {[aliasesProp.name]: ['MyNote']})

    const row = await env.repo.load(id)
    expect(row!.properties[aliasesProp.name]).toEqual(['MyNote', 'Book'])
    const resolved = await env.repo.query.aliasLookup({workspaceId: WS, alias: 'Book'}).load()
    expect(resolved?.id).toBe(id)
  })

  it('is idempotent — re-tagging block-type does not clobber or duplicate', async () => {
    env = await setup()
    const id = await tagBlockType(env, 'Book')
    await env.repo.tx(async tx => {
      await env.repo.addTypeInTx(tx, id, BLOCK_TYPE_TYPE, {}, env.repo.snapshotTypeRegistries())
    }, {scope: ChangeScope.BlockDefault})

    const row = await env.repo.load(id)
    expect(row!.properties[blockTypeLabelProp.name]).toBe('Book')
    expect(row!.properties[aliasesProp.name]).toEqual(['Book'])
    expect(getBlockTypes(row!).filter(t => t === PAGE_TYPE)).toHaveLength(1)
  })

  it('never overwrites an explicitly-set label/alias (createTypeBlock-style)', async () => {
    env = await setup()
    // Label already set to something other than content; alias already
    // claimed. The processor must leave both untouched.
    const id = await tagBlockType(env, 'Book', {
      [blockTypeLabelProp.name]: 'Custom',
      [aliasesProp.name]: ['Custom'],
    })

    const row = await env.repo.load(id)
    expect(row!.properties[blockTypeLabelProp.name]).toBe('Custom')
    expect(row!.properties[aliasesProp.name]).toEqual(['Custom'])
  })

  it('leaves a blank block unnamed (no label/alias) but still a page', async () => {
    env = await setup()
    const id = await tagBlockType(env, '   ')

    const row = await env.repo.load(id)
    expect(row!.properties[blockTypeLabelProp.name]).toBeUndefined()
    expect(row!.properties[aliasesProp.name]).toBeUndefined()
    expect(getBlockTypes(row!)).toContain(PAGE_TYPE)
  })

  it('rejects when the adopted name collides with an existing page alias', async () => {
    env = await setup()
    const pageId = await env.repo.mutate.createChild({parentId: env.repo.typesPageId!})
    await env.repo.tx(async tx => {
      await tx.update(pageId, {content: 'Book'})
      await tx.setProperty(pageId, aliasesProp, ['Book'])
    }, {scope: ChangeScope.BlockDefault})

    await expect(tagBlockType(env, 'Book')).rejects.toMatchObject({code: 'alias.collision'})
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
    })).rejects.toMatchObject({name: 'AbortError'})
    const row = await env.repo.load(id)
    expect(getBlockTypes(row!)).not.toContain(typeId)
  })

  it('silently skips instance ids that live in a different workspace', async () => {
    // Guard against the regression where retagBlocks trusted every
    // supplied instanceId without enforcing the type's workspace. A
    // stale caller (e.g. candidate list built before a sync-applied
    // move) could otherwise tag a cross-workspace block, breaking the
    // type-stays-in-its-workspace invariant.
    env = await setup()
    const typeId = await createTypeBlock(env.repo, {workspaceId: WS, label: 'Task', propertySchemaIds: []})

    // Plant a real block in a foreign workspace by bootstrapping its
    // Types page — that creates a kernel page row under `WS_OTHER`.
    // The page id is a perfectly valid block id from retagBlocks's
    // perspective, but its workspaceId is `WS_OTHER` (not `WS`).
    const WS_OTHER = 'ws-other'
    await getOrCreateTypesPage(env.repo, WS_OTHER)
    const foreignBlockId = typesPageBlockId(WS_OTHER)
    const foreignRow = await env.repo.load(foreignBlockId)
    expect(foreignRow?.workspaceId).toBe(WS_OTHER)

    // A same-workspace instance for the positive control.
    const liveId = await createBlock(env, 'A')

    await retagBlocks(env.repo, {
      typeId,
      instanceIds: [liveId, foreignBlockId],
    })

    const live = await env.repo.load(liveId)
    const foreign = await env.repo.load(foreignBlockId)
    expect(getBlockTypes(live!)).toContain(typeId)
    expect(getBlockTypes(foreign!)).not.toContain(typeId)
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

  it('targetIds: permissive refList match — block ⊇ targetIds counts', async () => {
    env = await setup()
    await env.repo.userSchemas.addSchema({name: 'tags', presetId: 'refList'})

    const person = await createBlock(env, 'Person')
    const friend = await createBlock(env, 'Friend')
    const stranger = await createBlock(env, 'Stranger')

    const onlyPerson = await createBlockWithRefs(env, 'OnlyPerson', 'tags', [person])
    const personAndFriend = await createBlockWithRefs(env, 'PersonAndFriend', 'tags', [person, friend])
    const onlyStranger = await createBlockWithRefs(env, 'OnlyStranger', 'tags', [stranger])

    const candidates = await findCandidatesByPropertyShape(env.repo, {
      workspaceId: WS,
      shape: [{name: 'tags', targetIds: [person]}],
    })

    expect(candidates).toContain(onlyPerson)
    expect(candidates).toContain(personAndFriend)
    expect(candidates).not.toContain(onlyStranger)
  })

  it('targetIds with multiple ids ANDs them — refList must be a superset', async () => {
    env = await setup()
    await env.repo.userSchemas.addSchema({name: 'tags', presetId: 'refList'})

    const a = await createBlock(env, 'A')
    const b = await createBlock(env, 'B')

    const hasA = await createBlockWithRefs(env, 'HasA', 'tags', [a])
    const hasB = await createBlockWithRefs(env, 'HasB', 'tags', [b])
    const hasBoth = await createBlockWithRefs(env, 'HasBoth', 'tags', [a, b])

    const candidates = await findCandidatesByPropertyShape(env.repo, {
      workspaceId: WS,
      shape: [{name: 'tags', targetIds: [a, b]}],
    })

    expect(candidates).toContain(hasBoth)
    expect(candidates).not.toContain(hasA)
    expect(candidates).not.toContain(hasB)
  })

  it('targetIds: empty array is treated as presence-only', async () => {
    env = await setup()
    await env.repo.userSchemas.addSchema({name: 'tags', presetId: 'refList'})

    const tag = await createBlock(env, 'Tag')
    const tagged = await createBlockWithRefs(env, 'Tagged', 'tags', [tag])
    const untagged = await createBlock(env, 'Untagged')

    const candidates = await findCandidatesByPropertyShape(env.repo, {
      workspaceId: WS,
      shape: [{name: 'tags', targetIds: []}],
    })

    expect(candidates).toContain(tagged)
    expect(candidates).not.toContain(untagged)
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
