import {describe, expect, it} from 'vitest'
import type {AnyPropertySchema} from '@/data/api'
import {typeDefinitionBlockId} from '@/data/definitionSeeds'
import type {TypeDefinitionMetadata} from '@/data/typeDefinitionMetadata'
import {seedType} from '@/data/typeSeeds'
import {
  buildTypeDefinitionRegistry,
  type ProjectedTypeDefinition,
} from '@/data/typeDefinitionRegistry'

const WS = 'ws-type-registry'

const projected = (
  over: Partial<TypeDefinitionMetadata> & {blockId: string},
  properties: readonly AnyPropertySchema[] = [],
): ProjectedTypeDefinition => ({
  metadata: {
    typeId: over.typeId ?? over.blockId,
    blockId: over.blockId,
    workspaceId: over.workspaceId ?? WS,
    createdAt: over.createdAt ?? 100,
    label: over.label ?? 'Label',
    hideFromCompletion: over.hideFromCompletion ?? false,
    hideFromBlockDisplay: over.hideFromBlockDisplay ?? false,
    ...(over.description !== undefined ? {description: over.description} : {}),
    ...(over.color !== undefined ? {color: over.color} : {}),
    ...(over.seedKey !== undefined ? {seedKey: over.seedKey} : {}),
  },
  properties,
})

const asMap = (defs: readonly ProjectedTypeDefinition[]) =>
  new Map(defs.map(d => [d.metadata.blockId, d]))

const PAGE_KEY = 'system:kernel-data/type/page'

describe('buildTypeDefinitionRegistry', () => {
  it('publishes each user row under its own block id (typeId == blockId)', () => {
    const reg = buildTypeDefinitionRegistry({
      workspaceId: WS,
      projectedDefinitions: asMap([
        projected({blockId: 'a', label: 'Alpha'}),
        projected({blockId: 'b', label: 'Beta'}),
      ]),
      seeds: [],
    })
    expect(reg.typesById.get('a')).toMatchObject({id: 'a', label: 'Alpha'})
    expect(reg.blockIdByTypeId.get('b')).toBe('b')
    expect(reg.definitionsByBlockId.size).toBe(2)
  })

  it('synthesizes a declared seed even with no materialized row', () => {
    // A fresh/read-only client has the code declaration but no backing block yet;
    // the built-in type must still be present, at its deterministic backing id.
    const reg = buildTypeDefinitionRegistry({
      workspaceId: WS,
      projectedDefinitions: new Map(),
      seeds: [seedType({seedKey: PAGE_KEY, revision: 1, id: 'page', label: 'Page'})],
    })
    expect(reg.typesById.get('page')).toMatchObject({id: 'page', label: 'Page'})
    expect(reg.blockIdByTypeId.get('page')).toBe(typeDefinitionBlockId(WS, PAGE_KEY))
  })

  it('binds a materialized seed mirror to its declared id, ignoring a drifted stored claim', () => {
    // The row is a valid seed mirror (its seedKey is a live declaration) but its
    // stored block-type:type-id drifted to 'stale' (stale/tampered sync). The
    // declaration owns the membership id; the row only supplies its blockId.
    const blockId = typeDefinitionBlockId(WS, PAGE_KEY)
    const reg = buildTypeDefinitionRegistry({
      workspaceId: WS,
      projectedDefinitions: asMap([
        projected({blockId, typeId: 'stale', seedKey: PAGE_KEY, label: 'Stale mirror'}),
      ]),
      seeds: [seedType({seedKey: PAGE_KEY, revision: 1, id: 'page', label: 'Page'})],
    })
    expect(reg.typesById.get('page')).toMatchObject({id: 'page', label: 'Page'})
    expect(reg.typesById.has('stale')).toBe(false)
    expect(reg.blockIdByTypeId.get('page')).toBe(blockId)
    // The row is still retained by its durable id for provenance / read-only gates.
    expect(reg.definitionsByBlockId.get(blockId)?.seedKey).toBe(PAGE_KEY)
  })

  it('publishes the DECLARED contribution for a seed, not the (stale) block mirror', () => {
    // The block mirror is stale (hideFromCompletion cleared, wrong label); a
    // deploy that changed the declaration must win so downstream validation uses
    // the current type shape.
    const blockId = typeDefinitionBlockId(WS, PAGE_KEY)
    const reg = buildTypeDefinitionRegistry({
      workspaceId: WS,
      projectedDefinitions: asMap([
        projected({blockId, seedKey: PAGE_KEY, label: 'Old Label', hideFromCompletion: false}),
      ]),
      seeds: [seedType({seedKey: PAGE_KEY, revision: 2, id: 'page', label: 'Page', hideFromCompletion: true})],
    })
    expect(reg.typesById.get('page')).toMatchObject({label: 'Page', hideFromCompletion: true})
  })

  it('refuses a claim whose seed key is not a current declaration (forged/foreign)', () => {
    // A forged row sits at the deterministic id for an invented /type/ key and
    // claims 'page'. Its key isn't declared, so it is demoted to its block id —
    // it must not hijack 'page'.
    const forgedKey = 'evil/type/x'
    const blockId = typeDefinitionBlockId(WS, forgedKey)
    const reg = buildTypeDefinitionRegistry({
      workspaceId: WS,
      projectedDefinitions: asMap([
        projected({blockId, typeId: 'page', seedKey: forgedKey, label: 'Impostor'}),
      ]),
      seeds: [],
    })
    expect(reg.typesById.has('page')).toBe(false)
    expect(reg.typesById.get(blockId)).toMatchObject({id: blockId, label: 'Impostor'})
    expect(reg.blockIdByTypeId.get(blockId)).toBe(blockId)
  })

  it('excludes rows from a foreign workspace', () => {
    const reg = buildTypeDefinitionRegistry({
      workspaceId: WS,
      projectedDefinitions: asMap([
        projected({blockId: 'here'}),
        projected({blockId: 'there', workspaceId: 'other-ws'}),
      ]),
      seeds: [],
    })
    expect(reg.definitionsByBlockId.has('here')).toBe(true)
    expect(reg.definitionsByBlockId.has('there')).toBe(false)
    expect(reg.typesById.has('there')).toBe(false)
  })

  it('carries display fields and resolved properties onto a user contribution, omitting falsy ones', () => {
    const schema = {name: 'due'} as unknown as AnyPropertySchema
    const reg = buildTypeDefinitionRegistry({
      workspaceId: WS,
      projectedDefinitions: asMap([
        projected(
          {blockId: 'full', label: 'Task', description: 'A task', color: 'tomato', hideFromCompletion: true},
          [schema],
        ),
        projected({blockId: 'bare', label: 'Bare'}),
      ]),
      seeds: [],
    })
    expect(reg.typesById.get('full')).toEqual({
      id: 'full',
      label: 'Task',
      description: 'A task',
      color: 'tomato',
      hideFromCompletion: true,
      properties: [schema],
    })
    const bare = reg.typesById.get('bare')!
    expect(bare).toEqual({id: 'bare', label: 'Bare', properties: []})
    expect(bare).not.toHaveProperty('description')
  })

  it('fails closed on two seeds claiming one membership id (keeps the first)', () => {
    // A plugin/dynamic seed reusing a built-in id must be observable, not a
    // silent last-wins hijack of the published type shape.
    const reg = buildTypeDefinitionRegistry({
      workspaceId: WS,
      projectedDefinitions: new Map(),
      seeds: [
        seedType({seedKey: PAGE_KEY, revision: 1, id: 'page', label: 'Real Page'}),
        seedType({seedKey: 'evil/type/page', revision: 1, id: 'page', label: 'Impostor Page'}),
      ],
    })
    expect(reg.typesById.get('page')).toMatchObject({label: 'Real Page'})
    expect(reg.blockIdByTypeId.get('page')).toBe(typeDefinitionBlockId(WS, PAGE_KEY))
  })

  it('does not bind a seed to a non-seed row squatting its deterministic backing id', () => {
    // A poisoned row sits at the seed's backing id without valid seed provenance.
    // The declared seed stays published, but must not be bound to that row —
    // getTypeBlockId('page') must not resolve to a non-seed block.
    const backingId = typeDefinitionBlockId(WS, PAGE_KEY)
    const reg = buildTypeDefinitionRegistry({
      workspaceId: WS,
      projectedDefinitions: asMap([projected({blockId: backingId, label: 'Poison'})]),
      seeds: [seedType({seedKey: PAGE_KEY, revision: 1, id: 'page', label: 'Page'})],
    })
    expect(reg.typesById.get('page')).toMatchObject({label: 'Page'})
    expect(reg.blockIdByTypeId.has('page')).toBe(false)
    // The squatter is still published as an ordinary type under its own id.
    expect(reg.typesById.get(backingId)).toMatchObject({id: backingId, label: 'Poison'})
  })

  it('indexes declared seeds by key, keeping the first on a duplicate key', () => {
    const reg = buildTypeDefinitionRegistry({
      workspaceId: WS,
      projectedDefinitions: new Map(),
      seeds: [
        seedType({seedKey: PAGE_KEY, revision: 1, id: 'page', label: 'Page'}),
        seedType({seedKey: 'system:kernel-data/type/todo', revision: 1, id: 'todo', label: 'Todo'}),
        seedType({seedKey: PAGE_KEY, revision: 1, id: 'page', label: 'Duplicate'}),
      ],
    })
    expect(reg.seedsByKey.size).toBe(2)
    expect(reg.seedsByKey.get(PAGE_KEY)?.label).toBe('Page')
    expect(reg.typesById.get('page')).toMatchObject({label: 'Page'})
  })
})
