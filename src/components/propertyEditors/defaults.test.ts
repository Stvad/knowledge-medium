// @vitest-environment node
/**
 * Pure-function tests for the §5.6.1 lookup chain. Cover the three
 * paths that drive `BlockProperties`'s rendering decision:
 *   1. Schema known + custom UI contribution → use the contribution.
 *   2. Schema known + no UI contribution → fall back via schema/codec match.
 *   3. Schema unknown → infer shape from the value, ad-hoc schema, fallback match.
 */

import { describe, expect, it } from 'vitest'
import { createElement, type JSX } from 'react'
import {
  ChangeScope,
  codecs,
  defineProperty,
  definePropertyUi,
  isListCodec,
  isNumberCodec,
  isRefCodec,
  isRefListCodec,
  isStringCodec,
  type AnyPropertyEditorFallbackContribution,
  type AnyPropertySchema,
  type AnyPropertyUiContribution,
} from '@/data/api'
import {
  adhocSchema,
  defaultValueForShape,
  inferShapeFromValue,
  ListPropertyEditor,
  NumberPropertyEditor,
  resolvePropertyDisplay,
  StringPropertyEditor,
} from './defaults'
import { RefListPropertyEditor, RefPropertyEditor } from './RefPropertyEditor'

const schemasMap = (entries: AnyPropertySchema[]): ReadonlyMap<string, AnyPropertySchema> =>
  new Map(entries.map(s => [s.name, s]))

const uisMap = (entries: AnyPropertyUiContribution[]): ReadonlyMap<string, AnyPropertyUiContribution> =>
  new Map(entries.map(u => [u.name, u]))

/** Test-only Editor that returns a real fragment element so it satisfies
 *  `PropertyEditor<T>`'s `JSX.Element` return contract. */
const noopEditor = (): JSX.Element => createElement('span', null, null)

const editorFallbacks: readonly AnyPropertyEditorFallbackContribution[] = [
  {
    id: 'test.ref',
    priority: 100,
    matches: schema => isRefCodec(schema.codec),
    Editor: RefPropertyEditor,
  },
  {
    id: 'test.refList',
    priority: 100,
    matches: schema => isRefListCodec(schema.codec),
    Editor: RefListPropertyEditor,
  },
  {
    id: 'test.list',
    priority: 0,
    matches: schema => isListCodec(schema.codec),
    Editor: ListPropertyEditor,
  },
  {
    id: 'test.number',
    priority: 0,
    matches: schema => isNumberCodec(schema.codec),
    Editor: NumberPropertyEditor,
  },
  {
    id: 'test.string',
    priority: 0,
    matches: schema => isStringCodec(schema.codec),
    Editor: StringPropertyEditor,
  },
]

describe('inferShapeFromValue', () => {
  it('returns the right shape for each JSON shape', () => {
    expect(inferShapeFromValue('hi')).toBe('string')
    expect(inferShapeFromValue(42)).toBe('number')
    expect(inferShapeFromValue(true)).toBe('boolean')
    expect(inferShapeFromValue([])).toBe('list')
    expect(inferShapeFromValue([1, 2])).toBe('list')
    expect(inferShapeFromValue({a: 1})).toBe('object')
    // null falls through to string per the kernel's lossy-inference contract.
    expect(inferShapeFromValue(null)).toBe('string')
    expect(inferShapeFromValue(undefined)).toBe('string')
  })
})

describe('defaultValueForShape', () => {
  it('returns the right starting value per shape', () => {
    expect(defaultValueForShape('string')).toBe('')
    expect(defaultValueForShape('number')).toBe(0)
    expect(defaultValueForShape('boolean')).toBe(false)
    expect(defaultValueForShape('list')).toEqual([])
    expect(defaultValueForShape('object')).toEqual({})
    expect(defaultValueForShape('date')).toBeUndefined()
  })
})

describe('adhocSchema', () => {
  it('builds a PropertySchema with the requested shape and BlockDefault scope', () => {
    const schema = adhocSchema('rogue', 'number')
    expect(schema.name).toBe('rogue')
    expect(schema.codec.shape).toBe('number')
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
  })

  const exactEditor = noopEditor
  const titleUi = definePropertyUi<string>({
    name: 'title',
    label: 'Title',
    Editor: exactEditor,
  })

  it('schema known + UI contribution registered → returns the contribution Editor', () => {
    const display = resolvePropertyDisplay({
      name: 'title',
      encodedValue: 'Hello',
      schemas: schemasMap([titleSchema]),
      uis: uisMap([titleUi]),
      editorFallbacks,
    })
    expect(display.isKnown).toBe(true)
    expect(display.schema).toBe(titleSchema)
    expect(display.shape).toBe('string')
    expect(display.Editor).toBe(exactEditor)
  })

  it('schema known + no UI contribution → uses the matching fallback editor', () => {
    const display = resolvePropertyDisplay({
      name: 'title',
      encodedValue: 'Hello',
      schemas: schemasMap([titleSchema]),
      uis: uisMap([]),
      editorFallbacks,
    })
    expect(display.isKnown).toBe(true)
    expect(display.schema).toBe(titleSchema)
    expect(display.Editor).toBe(StringPropertyEditor)
  })

  it('schema known + ref codec → uses the higher-priority ref editor fallback', () => {
    const refSchema = defineProperty<string>('reviewer', {
      codec: codecs.ref(),
      defaultValue: '',
      changeScope: ChangeScope.BlockDefault,
    })
    const display = resolvePropertyDisplay({
      name: 'reviewer',
      encodedValue: 'target-1',
      schemas: schemasMap([refSchema]),
      uis: uisMap([]),
      editorFallbacks,
    })
    expect(display.shape).toBe('string')
    expect(display.Editor).toBe(RefPropertyEditor)
  })

  it('schema known + refList codec → uses the higher-priority ref-list editor fallback', () => {
    const refListSchema = defineProperty<readonly string[]>('related', {
      codec: codecs.refList(),
      defaultValue: [],
      changeScope: ChangeScope.BlockDefault,
    })
    const display = resolvePropertyDisplay({
      name: 'related',
      encodedValue: ['target-1'],
      schemas: schemasMap([refListSchema]),
      uis: uisMap([]),
      editorFallbacks,
    })
    expect(display.shape).toBe('list')
    expect(display.Editor).toBe(RefListPropertyEditor)
  })

  it('schema unknown → infers shape from value, returns an ad-hoc schema, uses fallback editor', () => {
    const display = resolvePropertyDisplay({
      name: 'newish-prop',
      encodedValue: [1, 2, 3],
      schemas: schemasMap([]),
      uis: uisMap([]),
      editorFallbacks,
    })
    expect(display.isKnown).toBe(false)
    expect(display.schema.name).toBe('newish-prop')
    expect(display.schema.codec.shape).toBe('list')
    expect(display.shape).toBe('list')
    expect(display.Editor).toBe(ListPropertyEditor)
  })

  it('schema unknown + UI contribution registered → ignores orphan UI and uses fallback', () => {
    // A UI contribution without a matching schema is ignored — the
    // facet join key is the schema name. Only-UI registrations from
    // an inattentive plugin author shouldn't accidentally apply to
    // every unknown property; the panel infers + uses fallback editors.
    const display = resolvePropertyDisplay({
      name: 'orphan-prop',
      encodedValue: 'x',
      schemas: schemasMap([]),
      uis: uisMap([titleUi]),
      editorFallbacks,
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
      schemas: schemasMap([titleSchema, otherSchema]),
      uis: uisMap([titleUi]),
      editorFallbacks,
    })
    expect(display.schema).toBe(otherSchema)
    expect(display.shape).toBe('number')
    expect(display.Editor).toBe(NumberPropertyEditor)
  })

  it('returns undefined Editor when no exact UI or fallback contribution matches', () => {
    const display = resolvePropertyDisplay({
      name: 'title',
      encodedValue: 'Hello',
      schemas: schemasMap([titleSchema]),
      uis: uisMap([]),
      editorFallbacks: [],
    })
    expect(display.Editor).toBeUndefined()
  })
})
