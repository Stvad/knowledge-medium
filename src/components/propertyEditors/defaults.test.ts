// @vitest-environment node
/**
 * Pure-function tests for the §5.6.1 lookup chain. Cover the three
 * paths that drive `BlockProperties`'s rendering decision:
 *   1. Schema known + custom UI contribution → use the contribution.
 *   2. Schema known + no UI contribution → fall back to default for kind.
 *   3. Schema unknown → infer kind from the value, ad-hoc schema.
 */

import { describe, expect, it } from 'vitest'
import { createElement, type JSX } from 'react'
import {
  ChangeScope,
  codecs,
  defineProperty,
  definePropertyUi,
  type AnyPropertySchema,
  type AnyPropertyUiContribution,
} from '@/data/api'
import { adhocSchema, defaultValueForKind, inferKindFromValue, resolvePropertyDisplay } from './defaults'
import { RefListPropertyEditor, RefPropertyEditor } from './RefPropertyEditor'

const schemasMap = (entries: AnyPropertySchema[]): ReadonlyMap<string, AnyPropertySchema> =>
  new Map(entries.map(s => [s.name, s]))

const uisMap = (entries: AnyPropertyUiContribution[]): ReadonlyMap<string, AnyPropertyUiContribution> =>
  new Map(entries.map(u => [u.name, u]))

/** Test-only Editor that returns a real fragment element so it satisfies
 *  `PropertyEditor<T>`'s `JSX.Element` return contract. */
const noopEditor = (): JSX.Element => createElement('span', null, null)

describe('inferKindFromValue', () => {
  it('returns the right kind for each JSON shape', () => {
    expect(inferKindFromValue('hi')).toBe('string')
    expect(inferKindFromValue(42)).toBe('number')
    expect(inferKindFromValue(true)).toBe('boolean')
    expect(inferKindFromValue([])).toBe('list')
    expect(inferKindFromValue([1, 2])).toBe('list')
    expect(inferKindFromValue({a: 1})).toBe('object')
    // null falls through to string per the kernel's lossy-inference contract.
    expect(inferKindFromValue(null)).toBe('string')
    expect(inferKindFromValue(undefined)).toBe('string')
  })
})

describe('defaultValueForKind', () => {
  it('returns the right starting value per kind', () => {
    expect(defaultValueForKind('string')).toBe('')
    expect(defaultValueForKind('number')).toBe(0)
    expect(defaultValueForKind('boolean')).toBe(false)
    expect(defaultValueForKind('list')).toEqual([])
    expect(defaultValueForKind('ref')).toBe('')
    expect(defaultValueForKind('refList')).toEqual([])
    expect(defaultValueForKind('object')).toEqual({})
    expect(defaultValueForKind('date')).toBeUndefined()
  })
})

describe('adhocSchema', () => {
  it('builds a PropertySchema with the requested kind and BlockDefault scope', () => {
    const schema = adhocSchema('rogue', 'number')
    expect(schema.name).toBe('rogue')
    expect(schema.kind).toBe('number')
    expect(schema.changeScope).toBe(ChangeScope.BlockDefault)
    expect(schema.defaultValue).toBe(0)
    // Identity codec — encoded shape passes through unchanged.
    expect(schema.codec.encode(7)).toBe(7)
    expect(schema.codec.decode(7)).toBe(7)
  })

  it('lists wrap unsafeIdentity in a list combinator (encode/decode is array-aware)', () => {
    const schema = adhocSchema('tags', 'list')
    expect(Array.isArray(schema.codec.encode(['a', 'b']))).toBe(true)
    expect(schema.codec.decode([1, 2])).toEqual([1, 2])
  })
})

describe('resolvePropertyDisplay (§5.6.1 lookup chain)', () => {
  const titleSchema = defineProperty<string>('title', {
    codec: codecs.string,
    defaultValue: '',
    changeScope: ChangeScope.BlockDefault,
    kind: 'string',
  })

  const customEditor = noopEditor
  const titleUi = definePropertyUi<string>({
    name: 'title',
    label: 'Title',
    Editor: customEditor,
  })

  it('schema known + UI contribution registered → returns the contribution Editor', () => {
    const display = resolvePropertyDisplay({
      name: 'title',
      encodedValue: 'Hello',
      schemas: schemasMap([titleSchema]),
      uis: uisMap([titleUi]),
    })
    expect(display.isKnown).toBe(true)
    expect(display.schema).toBe(titleSchema)
    expect(display.kind).toBe('string')
    expect(display.customEditor).toBe(customEditor)
  })

  it('schema known + no UI contribution → customEditor undefined, caller falls back to default', () => {
    const display = resolvePropertyDisplay({
      name: 'title',
      encodedValue: 'Hello',
      schemas: schemasMap([titleSchema]),
      uis: uisMap([]),
    })
    expect(display.isKnown).toBe(true)
    expect(display.schema).toBe(titleSchema)
    expect(display.customEditor).toBeUndefined()
  })

  it('schema known + ref kind → uses the kernel ref editor fallback', () => {
    const refSchema = defineProperty<string>('reviewer', {
      codec: codecs.ref(),
      defaultValue: '',
      changeScope: ChangeScope.BlockDefault,
      kind: 'ref',
    })
    const display = resolvePropertyDisplay({
      name: 'reviewer',
      encodedValue: 'target-1',
      schemas: schemasMap([refSchema]),
      uis: uisMap([]),
    })
    expect(display.customEditor).toBe(RefPropertyEditor)
  })

  it('schema known + refList kind → uses the kernel ref-list editor fallback', () => {
    const refListSchema = defineProperty<readonly string[]>('related', {
      codec: codecs.refList(),
      defaultValue: [],
      changeScope: ChangeScope.BlockDefault,
      kind: 'refList',
    })
    const display = resolvePropertyDisplay({
      name: 'related',
      encodedValue: ['target-1'],
      schemas: schemasMap([refListSchema]),
      uis: uisMap([]),
    })
    expect(display.customEditor).toBe(RefListPropertyEditor)
  })

  it('schema unknown → infers kind from value, returns an ad-hoc schema, isKnown=false', () => {
    const display = resolvePropertyDisplay({
      name: 'newish-prop',
      encodedValue: [1, 2, 3],
      schemas: schemasMap([]),
      uis: uisMap([]),
    })
    expect(display.isKnown).toBe(false)
    expect(display.schema.name).toBe('newish-prop')
    expect(display.schema.kind).toBe('list')
    expect(display.kind).toBe('list')
    expect(display.customEditor).toBeUndefined()
  })

  it('schema unknown + UI contribution registered → still falls through (no schema = no real editor)', () => {
    // A UI contribution without a matching schema is ignored — the
    // facet join key is the schema name. Only-UI registrations from
    // an inattentive plugin author shouldn't accidentally apply to
    // every unknown property; the panel infers + uses defaults.
    const display = resolvePropertyDisplay({
      name: 'orphan-prop',
      encodedValue: 'x',
      schemas: schemasMap([]),
      uis: uisMap([titleUi]),
    })
    expect(display.isKnown).toBe(false)
    expect(display.customEditor).toBeUndefined()
  })

  it('multiple schemas registered → only the matching name is consulted', () => {
    const otherSchema = defineProperty<number>('count', {
      codec: codecs.number,
      defaultValue: 0,
      changeScope: ChangeScope.BlockDefault,
      kind: 'number',
    })
    const display = resolvePropertyDisplay({
      name: 'count',
      encodedValue: 7,
      schemas: schemasMap([titleSchema, otherSchema]),
      uis: uisMap([titleUi]),
    })
    expect(display.schema).toBe(otherSchema)
    expect(display.kind).toBe('number')
    expect(display.customEditor).toBeUndefined()
  })
})
