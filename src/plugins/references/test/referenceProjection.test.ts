import { describe, it, expect } from 'vitest'
import {
  ChangeScope,
  codecs,
  defineProperty,
  type AnyPropertySchema,
} from '@/data/api'
import { projectPropertyReferences } from '../referenceProjection'

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

  it('a wholly wrong-shape refList value (non-array) still projects nothing', () => {
    expect(
      projectPropertyReferences(
        { properties: { related: 'not-an-array' } },
        schemas(relatedProp),
      ),
    ).toEqual([])
  })
})
