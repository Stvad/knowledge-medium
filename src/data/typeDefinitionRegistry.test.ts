import {describe, expect, it} from 'vitest'
import type {AnyPropertySchema} from '@/data/api'
import type {TypeDefinitionMetadata} from '@/data/typeDefinitionMetadata'
import type {TypeSeedDeclaration} from '@/data/typeSeeds'
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

describe('buildTypeDefinitionRegistry', () => {
  it('publishes each user row under its own type id (typeId == blockId)', () => {
    const reg = buildTypeDefinitionRegistry({
      workspaceId: WS,
      projectedDefinitions: asMap([
        projected({blockId: 'a', label: 'Alpha'}),
        projected({blockId: 'b', label: 'Beta'}),
      ]),
      seeds: [],
    })

    expect(reg.typesById.get('a')).toMatchObject({id: 'a', label: 'Alpha'})
    expect(reg.typesById.get('b')).toMatchObject({id: 'b', label: 'Beta'})
    expect(reg.blockIdByTypeId.get('a')).toBe('a')
    expect(reg.definitionsByBlockId.get('a')?.label).toBe('Alpha')
    expect(reg.definitionsByBlockId.size).toBe(2)
  })

  it('resolves competing claims for one type id to the earliest createdAt', () => {
    // Two rows both claim 'page' (a real seed + a later import). The early one
    // wins; the late import must not hijack the id.
    const reg = buildTypeDefinitionRegistry({
      workspaceId: WS,
      projectedDefinitions: asMap([
        projected({blockId: 'late', typeId: 'page', label: 'Impostor', createdAt: 300}),
        projected({blockId: 'early', typeId: 'page', label: 'Real Page', createdAt: 100}),
      ]),
      seeds: [],
    })

    expect(reg.typesById.get('page')).toMatchObject({id: 'page', label: 'Real Page'})
    expect(reg.blockIdByTypeId.get('page')).toBe('early')
    // The loser is still retained by its durable block id (for provenance /
    // read-only gates), just not published as the winner.
    expect(reg.definitionsByBlockId.get('late')?.label).toBe('Impostor')
    expect(reg.definitionsByBlockId.size).toBe(2)
  })

  it('breaks a createdAt tie deterministically by block id (never insertion order)', () => {
    const winner = buildTypeDefinitionRegistry({
      workspaceId: WS,
      projectedDefinitions: asMap([
        projected({blockId: 'zzz', typeId: 'dup', label: 'Z', createdAt: 100}),
        projected({blockId: 'aaa', typeId: 'dup', label: 'A', createdAt: 100}),
      ]),
      seeds: [],
    })
    expect(winner.blockIdByTypeId.get('dup')).toBe('aaa')
    // Insertion-order-independent: reversing input gives the same winner.
    const reversed = buildTypeDefinitionRegistry({
      workspaceId: WS,
      projectedDefinitions: asMap([
        projected({blockId: 'aaa', typeId: 'dup', label: 'A', createdAt: 100}),
        projected({blockId: 'zzz', typeId: 'dup', label: 'Z', createdAt: 100}),
      ]),
      seeds: [],
    })
    expect(reversed.blockIdByTypeId.get('dup')).toBe('aaa')
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

  it('carries display fields and resolved properties onto the contribution, omitting falsy ones', () => {
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
    // Falsy display fields are omitted, not stored as undefined/false.
    const bare = reg.typesById.get('bare')!
    expect(bare).toEqual({id: 'bare', label: 'Bare', properties: []})
    expect(bare).not.toHaveProperty('description')
    expect(bare).not.toHaveProperty('hideFromCompletion')
  })

  it('indexes declared seeds by key, keeping the first on a duplicate key', () => {
    const seed = (over: Partial<TypeSeedDeclaration> & {seedKey: string; id: string}): TypeSeedDeclaration => ({
      id: over.id,
      label: over.label ?? over.id,
      seedKey: over.seedKey,
      revision: over.revision ?? 1,
    })
    const reg = buildTypeDefinitionRegistry({
      workspaceId: WS,
      projectedDefinitions: new Map(),
      seeds: [
        seed({seedKey: 'system:kernel-data/type/page', id: 'page', label: 'Page'}),
        seed({seedKey: 'system:kernel-data/type/todo', id: 'todo', label: 'Todo'}),
        seed({seedKey: 'system:kernel-data/type/page', id: 'page', label: 'Duplicate'}),
      ],
    })
    expect(reg.seedsByKey.size).toBe(2)
    expect(reg.seedsByKey.get('system:kernel-data/type/page')?.label).toBe('Page')
  })
})
