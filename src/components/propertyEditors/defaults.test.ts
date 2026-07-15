// @vitest-environment node
/**
 * Pure-function tests for the property-display lookup chain. Cover the
 * three paths that drive `BlockProperties`'s rendering decision:
 *   1. Schema known + seed-identity editor override → use the override.
 *   2. Schema known + no override → use the matching ValuePreset.Editor
 *      (keyed by codec.type).
 *   3. Schema unknown → infer a primitive type from the value, build an
 *      ad-hoc schema, use the matching preset's editor.
 */

import { describe, expect, it } from 'vitest'
import { createElement, type JSX } from 'react'
import {
  ChangeScope,
  codecs,
  defineProperty,
  type AnyJoinedValuePreset,
  type AnyPropertyEditorOverride,
  type AnyPropertySchema,
  type JoinedValuePreset,
  type PropertyEditor,
} from '@/data/api'
import {
  defaultValueForShape,
  degradedFallbackSchema,
  inferTypeFromValue,
  ListPropertyEditor,
  NumberPropertyEditor,
  resolvePropertyDisplay,
  StringPropertyEditor,
} from './defaults'
import { RefListPropertyEditor, RefPropertyEditor } from './RefPropertyEditor'

const schemasMap = (entries: AnyPropertySchema[]): ReadonlyMap<string, AnyPropertySchema> =>
  new Map(entries.map(s => [s.name, s]))

/** Local join-preset builder standing in for the removed `definePreset`
 *  identity helper — these display-lookup fixtures are already joined
 *  (core + presentation) shapes. */
const definePreset = <TValue>(preset: JoinedValuePreset<TValue>): JoinedValuePreset<TValue> => preset

const presetsMap = (entries: readonly AnyJoinedValuePreset[]): ReadonlyMap<string, AnyJoinedValuePreset> =>
  new Map(entries.map(p => [p.id, p]))

/** Test-only Editor that returns a real fragment element so it satisfies
 *  `PropertyEditor<T>`'s `JSX.Element` return contract. */
const noopEditor = (): JSX.Element => createElement('span', null, null)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asEditor = <T>(editor: PropertyEditor<any>): PropertyEditor<T> =>
  editor as unknown as PropertyEditor<T>

const presets: readonly AnyJoinedValuePreset[] = [
  definePreset<string>({
    id: 'string',
    label: 'Plain text',
    build: () => codecs.string,
    defaultValue: '',
    Editor: asEditor<string>(StringPropertyEditor),
  }),
  definePreset<number>({
    id: 'number',
    label: 'Number',
    build: () => codecs.number,
    defaultValue: 0,
    Editor: asEditor<number>(NumberPropertyEditor),
  }),
  definePreset<unknown[]>({
    id: 'list',
    label: 'Options',
    build: () => codecs.list(codecs.unsafeIdentity()),
    defaultValue: [],
    Editor: asEditor<unknown[]>(ListPropertyEditor),
  }),
  definePreset<string>({
    id: 'ref',
    label: 'Reference',
    build: () => codecs.ref(),
    defaultValue: '',
    Editor: asEditor<string>(RefPropertyEditor),
  }),
  definePreset<readonly string[]>({
    id: 'refList',
    label: 'References',
    build: () => codecs.refList(),
    defaultValue: [],
    Editor: asEditor<readonly string[]>(RefListPropertyEditor),
  }),
]

describe('inferTypeFromValue', () => {
  it('returns the right type for each JSON shape', () => {
    expect(inferTypeFromValue('hi')).toBe('string')
    expect(inferTypeFromValue(42)).toBe('number')
    expect(inferTypeFromValue(true)).toBe('boolean')
    expect(inferTypeFromValue([])).toBe('list')
    expect(inferTypeFromValue([1, 2])).toBe('list')
    expect(inferTypeFromValue({a: 1})).toBe('object')
    // null falls through to string per the kernel's lossy-inference contract.
    expect(inferTypeFromValue(null)).toBe('string')
    expect(inferTypeFromValue(undefined)).toBe('string')
  })
})

describe('defaultValueForShape', () => {
  it('returns the right starting value per type', () => {
    expect(defaultValueForShape('string')).toBe('')
    expect(defaultValueForShape('number')).toBe(0)
    expect(defaultValueForShape('boolean')).toBe(false)
    expect(defaultValueForShape('list')).toEqual([])
    expect(defaultValueForShape('object')).toEqual({})
    expect(defaultValueForShape('date')).toBeUndefined()
  })
})

describe('degradedFallbackSchema', () => {
  it('builds a PropertySchema with the requested type and BlockDefault scope', () => {
    const schema = degradedFallbackSchema('rogue', 'number')
    expect(schema.name).toBe('rogue')
    expect(schema.codec.type).toBe('number')
    expect(schema.changeScope).toBe(ChangeScope.BlockDefault)
    expect(schema.defaultValue).toBe(0)
    // Identity codec — encoded shape passes through unchanged.
    expect(schema.codec.encode(7)).toBe(7)
    expect(schema.codec.decode(7)).toBe(7)
  })

  it('lists wrap unsafeIdentity in a list combinator (encode/decode is array-aware)', () => {
    const schema = degradedFallbackSchema('tags', 'list')
    expect(Array.isArray(schema.codec.encode(['a', 'b']))).toBe(true)
    expect(schema.codec.decode([1, 2])).toEqual([1, 2])
  })
})

describe('resolvePropertyDisplay (preset-driven lookup chain)', () => {
  const titleSchema = defineProperty<string>('title', {
    codec: codecs.string,
    defaultValue: '',
    changeScope: ChangeScope.BlockDefault,
  })

  const exactEditor = noopEditor
  // `resolvePropertyDisplay` now takes a pre-resolved override (the seedKey
  // join happens in the caller via `resolveEditorOverride`), so a literal is
  // enough here — the seedKey is not consulted on this path.
  const titleUi: AnyPropertyEditorOverride = {
    seedKey: 'test/property/title',
    label: 'Title',
    Editor: exactEditor,
  }

  it('schema known + editor override registered → returns the override Editor', () => {
    const display = resolvePropertyDisplay({
      name: 'title',
      encodedValue: 'Hello',
      schemas: schemasMap([titleSchema]),
      override: titleUi,
      presets: presetsMap(presets),
    })
    expect(display.isKnown).toBe(true)
    expect(display.schema).toBe(titleSchema)
    expect(display.shape).toBe('string')
    expect(display.Editor).toBe(exactEditor)
  })

  it('schema known + no editor override → uses the matching preset editor', () => {
    const display = resolvePropertyDisplay({
      name: 'title',
      encodedValue: 'Hello',
      schemas: schemasMap([titleSchema]),
      override: undefined,
      presets: presetsMap(presets),
    })
    expect(display.isKnown).toBe(true)
    expect(display.schema).toBe(titleSchema)
    expect(display.Editor).toBe(StringPropertyEditor)
  })

  it('schema known + ref codec → uses the ref preset editor', () => {
    const refSchema = defineProperty<string>('reviewer', {
      codec: codecs.ref(),
      defaultValue: '',
      changeScope: ChangeScope.BlockDefault,
    })
    const display = resolvePropertyDisplay({
      name: 'reviewer',
      encodedValue: 'target-1',
      schemas: schemasMap([refSchema]),
      override: undefined,
      presets: presetsMap(presets),
    })
    expect(display.shape).toBe('ref')
    expect(display.Editor).toBe(RefPropertyEditor)
  })

  it('schema known + refList codec → uses the refList preset editor', () => {
    const refListSchema = defineProperty<readonly string[]>('related', {
      codec: codecs.refList(),
      defaultValue: [],
      changeScope: ChangeScope.BlockDefault,
    })
    const display = resolvePropertyDisplay({
      name: 'related',
      encodedValue: ['target-1'],
      schemas: schemasMap([refListSchema]),
      override: undefined,
      presets: presetsMap(presets),
    })
    expect(display.shape).toBe('refList')
    expect(display.Editor).toBe(RefListPropertyEditor)
  })

  it('schema unknown → infers type from value, builds ad-hoc schema, uses preset editor', () => {
    const display = resolvePropertyDisplay({
      name: 'newish-prop',
      encodedValue: [1, 2, 3],
      schemas: schemasMap([]),
      override: undefined,
      presets: presetsMap(presets),
    })
    expect(display.isKnown).toBe(false)
    expect(display.schema.name).toBe('newish-prop')
    expect(display.schema.codec.type).toBe('list')
    expect(display.shape).toBe('list')
    expect(display.Editor).toBe(ListPropertyEditor)
  })

  it('schema unknown + editor override supplied → ignores it and uses preset', () => {
    // An override is only applied on the known-schema path; when the schema is
    // unknown the resolver infers a type and uses the preset editor, so an
    // override handed in for an unknown property never applies.
    const display = resolvePropertyDisplay({
      name: 'orphan-prop',
      encodedValue: 'x',
      schemas: schemasMap([]),
      override: titleUi,
      presets: presetsMap(presets),
    })
    expect(display.isKnown).toBe(false)
    expect(display.Editor).toBe(StringPropertyEditor)
  })

  it('multiple schemas registered → only the matching name is consulted', () => {
    const otherSchema = defineProperty<number>('count', {
      codec: codecs.number,
      defaultValue: 0,
      changeScope: ChangeScope.BlockDefault,
    })
    const display = resolvePropertyDisplay({
      name: 'count',
      encodedValue: 7,
      // The caller resolves the override per definition; `count` resolves to
      // none even though a `title` override exists elsewhere.
      schemas: schemasMap([titleSchema, otherSchema]),
      override: undefined,
      presets: presetsMap(presets),
    })
    expect(display.schema).toBe(otherSchema)
    expect(display.shape).toBe('number')
    expect(display.Editor).toBe(NumberPropertyEditor)
  })

  it('returns undefined Editor when no override or preset matches', () => {
    const display = resolvePropertyDisplay({
      name: 'title',
      encodedValue: 'Hello',
      schemas: schemasMap([titleSchema]),
      override: undefined,
      presets: presetsMap([]),
    })
    expect(display.Editor).toBeUndefined()
  })
})
