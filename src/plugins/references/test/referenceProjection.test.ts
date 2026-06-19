import { describe, it, expect } from 'vitest'
import {
  ChangeScope,
  CodecError,
  codecs,
  defineProperty,
  type AnyPropertySchema,
  type RefListCodec,
} from '@/data/api'
import { projectPropertyReferences } from '../referenceProjection'
import { assertRefListDeriveIsAddOnly } from '@/data/test/derivedDataContract'

// `projectPropertyReferences` is the post-commit references processor's
// per-block projection (the site named in issue #189). The whole-field strip
// it used to suffer — one malformed `refList` element discarding every backlink
// the field contributed — is the bug these tests pin against.

const relatedProp = defineProperty<readonly string[]>('related', {
  codec: codecs.refList(),
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
})
const reviewerProp = defineProperty<string>('reviewer', {
  codec: codecs.ref(),
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

// A refList codec authored against the pre-`decodeValid` public interface — an
// external/older plugin that still satisfies `isRefListCodec` (discriminator
// only) but has no `decodeValid` method.
const legacyRefListCodec: RefListCodec = {
  type: 'refList',
  targetTypes: [],
  encode: v => v.map(item => item),
  decode: j => {
    if (!Array.isArray(j)) throw new CodecError('array', j)
    return j.map(item => {
      if (typeof item !== 'string') throw new CodecError('string', item)
      return item
    })
  },
}
const legacyRelatedProp = defineProperty<readonly string[]>('related', {
  codec: legacyRefListCodec,
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
})

const schemas = (...props: AnyPropertySchema[]): ReadonlyMap<string, AnyPropertySchema> =>
  new Map(props.map(p => [p.name, p]))

describe('projectPropertyReferences', () => {
  it('keeps the well-formed ids when one refList element is malformed (#189)', () => {
    // ['valid-1','valid-2',42] previously decoded to [] — both valid backlinks
    // lost. Now only the malformed 42 is dropped.
    expect(
      projectPropertyReferences(
        { properties: { related: ['valid-1', 'valid-2', 42] } },
        schemas(relatedProp),
      ),
    ).toEqual([
      { id: 'valid-1', alias: 'valid-1', sourceField: 'related' },
      { id: 'valid-2', alias: 'valid-2', sourceField: 'related' },
    ])
  })

  it('a malformed refList field does not block another well-formed ref field', () => {
    expect(
      projectPropertyReferences(
        { properties: { related: ['ok', {}], reviewer: 'target-a' } },
        schemas(relatedProp, reviewerProp),
      ),
    ).toEqual([
      { id: 'ok', alias: 'ok', sourceField: 'related' },
      { id: 'target-a', alias: 'target-a', sourceField: 'reviewer' },
    ])
  })

  it('satisfies the element-wise refList decode contract (#189)', () => {
    assertRefListDeriveIsAddOnly(value =>
      projectPropertyReferences({ properties: { related: value } }, schemas(relatedProp)).map(r => r.id),
    )
  })

  it('a wholly wrong-shape refList value (non-array) still projects nothing', () => {
    expect(
      projectPropertyReferences(
        { properties: { related: 'not-an-array' } },
        schemas(relatedProp),
      ),
    ).toEqual([])
  })

  it('a refList codec lacking decodeValid does not abort the block projection', () => {
    // Regression for the #214 follow-up: removing the property-local try/catch
    // meant a refList codec without `decodeValid` would throw
    // `decodeValid is not a function`, stripping the whole block's refs
    // (including the other well-formed ref field). It must recover the good
    // ids instead and leave the other field's ref intact.
    expect(
      projectPropertyReferences(
        { properties: { related: ['ok', 42], reviewer: 'target-a' } },
        schemas(legacyRelatedProp, reviewerProp),
      ),
    ).toEqual([
      { id: 'ok', alias: 'ok', sourceField: 'related' },
      { id: 'target-a', alias: 'target-a', sourceField: 'reviewer' },
    ])
  })
})
