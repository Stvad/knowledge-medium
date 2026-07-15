import {describe, expect, it} from 'vitest'
import {ChangeScope, seedProperty} from '@/data/api'
import {
  isTypeSeedDeclaration,
  isTypeSeedKey,
  seedType,
  type TypeSeedDeclaration,
} from '@/data/typeSeeds'
import {typeSeedsFacet} from '@/data/facets'
import {propertyDefinitionBlockId, typeDefinitionBlockId} from '@/data/definitionSeeds'
import {resolveFacetRuntimeSync} from '@/facets/facet'

const KEY = 'system:kernel-data/type/page'

describe('seedType', () => {
  it('builds a TypeContribution carrying seed provenance', () => {
    const decl = seedType({seedKey: KEY, revision: 1, id: 'page', label: 'Page'})
    expect(decl.id).toBe('page')
    expect(decl.label).toBe('Page')
    expect(decl.seedKey).toBe(KEY)
    expect(decl.revision).toBe(1)
  })

  it('omits absent optional fields (byte-identical to defineBlockType)', () => {
    const decl = seedType({seedKey: KEY, revision: 1, id: 'page', label: 'Page'})
    expect(Object.keys(decl).sort()).toEqual(['id', 'label', 'revision', 'seedKey'])
  })

  it('carries the optional TypeContribution fields when provided', () => {
    const prop = seedProperty({
      seedKey: 'system:kernel-data/property/block-type-label',
      revision: 1,
      name: 'block-type:label',
      preset: 'string',
      changeScope: ChangeScope.BlockDefault,
    })
    const decl = seedType({
      seedKey: 'plugin:geo/type/place',
      revision: 2,
      id: 'place',
      label: 'Place',
      description: 'A location',
      hideFromCompletion: true,
      hideFromBlockDisplay: true,
      color: 'tomato',
      properties: [prop],
    })
    expect(decl.description).toBe('A location')
    expect(decl.hideFromCompletion).toBe(true)
    expect(decl.hideFromBlockDisplay).toBe(true)
    expect(decl.color).toBe('tomato')
    expect(decl.properties).toEqual([prop])
  })

  it('rejects a property-style seed key at module evaluation', () => {
    expect(() =>
      seedType({seedKey: 'system:kernel-data/property/page', revision: 1, id: 'page', label: 'Page'}),
    ).toThrow(/<owner>\/type\/<stable-key>/)
  })

  it('rejects an empty id, empty label, or non-positive revision', () => {
    expect(() => seedType({seedKey: KEY, revision: 1, id: '  ', label: 'Page'})).toThrow(/id is required/)
    expect(() => seedType({seedKey: KEY, revision: 1, id: 'page', label: ' '})).toThrow(/label is required/)
    expect(() => seedType({seedKey: KEY, revision: 0, id: 'page', label: 'Page'})).toThrow(/revision/)
  })
})

describe('isTypeSeedKey', () => {
  it('accepts the /type/ grammar and rejects /property/ + malformed', () => {
    expect(isTypeSeedKey('system:kernel-data/type/page')).toBe(true)
    expect(isTypeSeedKey('plugin:geo/type/place')).toBe(true)
    expect(isTypeSeedKey('system:kernel-data/property/page')).toBe(false)
    expect(isTypeSeedKey('page')).toBe(false)
    expect(isTypeSeedKey('owner/type/a/b')).toBe(false)
    expect(isTypeSeedKey(42)).toBe(false)
  })
})

describe('isTypeSeedDeclaration', () => {
  const valid = seedType({seedKey: KEY, revision: 1, id: 'page', label: 'Page'})

  it('accepts a well-formed type seed', () => {
    expect(isTypeSeedDeclaration(valid)).toBe(true)
  })

  it('rejects a property seed declaration (no id/label, /property/ key)', () => {
    const prop = seedProperty({
      seedKey: 'system:kernel-data/property/types',
      revision: 1,
      name: 'types',
      preset: 'string-list',
      changeScope: ChangeScope.BlockDefault,
    })
    expect(isTypeSeedDeclaration(prop)).toBe(false)
  })

  it('rejects malformed contributions', () => {
    expect(isTypeSeedDeclaration(null)).toBe(false)
    expect(isTypeSeedDeclaration({...valid, id: ''})).toBe(false)
    expect(isTypeSeedDeclaration({...valid, label: ''})).toBe(false)
    expect(isTypeSeedDeclaration({...valid, seedKey: 'bad'})).toBe(false)
    expect(isTypeSeedDeclaration({...valid, revision: 0})).toBe(false)
    expect(isTypeSeedDeclaration({...valid, color: 5})).toBe(false)
  })
})

describe('typeSeedsFacet', () => {
  it('keeps well-formed contributions and drops malformed ones', () => {
    const valid = seedType({seedKey: KEY, revision: 1, id: 'page', label: 'Page'})
    const runtime = resolveFacetRuntimeSync([
      typeSeedsFacet.of({id: 'x'} as unknown as TypeSeedDeclaration),
      typeSeedsFacet.of(valid),
    ])
    expect(runtime.read(typeSeedsFacet)).toEqual([valid])
  })
})

describe('typeDefinitionBlockId', () => {
  it('is deterministic per (workspace, seedKey)', () => {
    expect(typeDefinitionBlockId('ws-1', KEY)).toBe(typeDefinitionBlockId('ws-1', KEY))
    expect(typeDefinitionBlockId('ws-1', KEY)).not.toBe(typeDefinitionBlockId('ws-2', KEY))
    expect(typeDefinitionBlockId('ws-1', KEY))
      .not.toBe(typeDefinitionBlockId('ws-1', 'plugin:geo/type/place'))
  })

  it('never collides with a property block id despite the shared namespace', () => {
    // Disjoint key grammars (/type/ vs /property/) guarantee non-collision.
    expect(typeDefinitionBlockId('ws-1', 'system:kernel-data/type/page'))
      .not.toBe(propertyDefinitionBlockId('ws-1', 'system:kernel-data/property/page'))
  })
})
