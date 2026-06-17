import { describe, expect, it } from 'vitest'
import {
  ChangeScope,
  codecs,
  defineProperty,
  type AnyPropertySchema,
} from '@/data/api'
import { makeBlockData } from '@/data/test/factories'
import {
  latestRefProjectionSchema,
  projectedRefsForField,
  refCodecKind,
} from '@/data/internals/refProjection'

// Pure helpers behind the reprojection / per-block ref projection. They're
// exercised end-to-end by referencesProcessor.test.ts; these unit tests pin the
// contract directly — most importantly the absence-RETAIN branch of
// `latestRefProjectionSchema` (a parked scan must keep the scheduled schema when
// the live registry no longer knows the name, so it re-adds rather than strips).

const refProp = defineProperty<string>('reviewer', {
  codec: codecs.ref(),
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})
const refPropOther = defineProperty<string>('approver', {
  codec: codecs.ref(),
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})
const refListProp = defineProperty<readonly string[]>('related', {
  codec: codecs.refList(),
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
})
const stringProp = defineProperty<string>('reviewer', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

const block = (properties: Record<string, unknown>) =>
  makeBlockData({ id: 'b', workspaceId: 'ws', properties })

describe('refCodecKind', () => {
  it('classifies ref / refList / non-ref / absent', () => {
    expect(refCodecKind(refProp)).toBe('ref')
    expect(refCodecKind(refListProp)).toBe('refList')
    expect(refCodecKind(stringProp)).toBeUndefined()
    expect(refCodecKind(undefined)).toBeUndefined()
  })
})

describe('projectedRefsForField', () => {
  it('returns [] when the schema is undefined (absent)', () => {
    expect(projectedRefsForField(block({ reviewer: 'target-a' }), undefined, 'reviewer')).toEqual([])
  })

  it('returns [] when the field is not present on the block', () => {
    expect(projectedRefsForField(block({}), refProp, 'reviewer')).toEqual([])
  })

  it('projects a single ref-typed value with sourceField and alias === id', () => {
    expect(projectedRefsForField(block({ reviewer: 'target-a' }), refProp, 'reviewer')).toEqual([
      { id: 'target-a', alias: 'target-a', sourceField: 'reviewer' },
    ])
  })

  it('projects every id of a refList value', () => {
    expect(projectedRefsForField(block({ related: ['target-b', 'target-c'] }), refListProp, 'related')).toEqual([
      { id: 'target-b', alias: 'target-b', sourceField: 'related' },
      { id: 'target-c', alias: 'target-c', sourceField: 'related' },
    ])
  })

  it('dedupes repeated ids within a refList', () => {
    expect(projectedRefsForField(block({ related: ['x', 'x'] }), refListProp, 'related')).toEqual([
      { id: 'x', alias: 'x', sourceField: 'related' },
    ])
  })

  it('skips empty / whitespace-only ids', () => {
    expect(projectedRefsForField(block({ reviewer: '   ' }), refProp, 'reviewer')).toEqual([])
    expect(projectedRefsForField(block({ related: ['', 'target-b'] }), refListProp, 'related')).toEqual([
      { id: 'target-b', alias: 'target-b', sourceField: 'related' },
    ])
  })

  it('returns [] when the value fails to decode (malformed)', () => {
    // ref expects a string; refList expects an array of strings.
    expect(projectedRefsForField(block({ reviewer: 42 }), refProp, 'reviewer')).toEqual([])
    expect(projectedRefsForField(block({ related: 'not-an-array' }), refListProp, 'related')).toEqual([])
  })

  it('returns [] for a present but non-ref schema', () => {
    expect(projectedRefsForField(block({ reviewer: 'target-a' }), stringProp, 'reviewer')).toEqual([])
  })
})

describe('latestRefProjectionSchema', () => {
  const map = (schema?: AnyPropertySchema): ReadonlyMap<string, AnyPropertySchema> =>
    new Map(schema ? [['p', schema]] : [])

  it('keeps the scheduled schema when the live registry no longer knows the name (absence ⇒ retain)', () => {
    // The guard that closes the parked-scan strip: live absent ⇒ project against
    // the scheduled schema so the scan re-adds (retains) instead of stripping.
    expect(latestRefProjectionSchema(map(refProp), map(), 'p')).toBe(refProp)
    expect(latestRefProjectionSchema(map(refListProp), map(), 'p')).toBe(refListProp)
  })

  it('returns undefined when the name is absent from both registries', () => {
    expect(latestRefProjectionSchema(map(), map(), 'p')).toBeUndefined()
  })

  it('keeps the scheduled schema when ref-ness still matches the live registry', () => {
    // Same ref-ness (both ref) ⇒ return the scheduled object, not the live one.
    expect(latestRefProjectionSchema(map(refProp), map(refPropOther), 'p')).toBe(refProp)
  })

  it('projects against the live schema on a present ref→non-ref redefine (so it strips)', () => {
    expect(latestRefProjectionSchema(map(refProp), map(stringProp), 'p')).toBe(stringProp)
  })

  it('projects against the live schema on a present non-ref→ref change', () => {
    expect(latestRefProjectionSchema(map(stringProp), map(refProp), 'p')).toBe(refProp)
  })

  it('projects against the live schema when ref kind changes (ref → refList)', () => {
    expect(latestRefProjectionSchema(map(refProp), map(refListProp), 'p')).toBe(refListProp)
  })
})
