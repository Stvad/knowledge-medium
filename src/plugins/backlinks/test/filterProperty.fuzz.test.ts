// @vitest-environment node
/**
 * Fuzz suite for the stored backlinks filter codec (`../filterProperty.ts`).
 * See `src/test/fuzz.ts` for smoke/deep tier mechanics and `docs/fuzzing.md`
 * for conventions.
 *
 * The filter is a per-page property the user edits through the filter chips,
 * so a write followed by a read must give the filter back:
 *
 * 1. Round trip: any filter the codec encodes decodes, through JSON storage,
 *    to the same encoded value.
 * 2. Decode is total and stable on arbitrary stored JSON (a hand-edited or
 *    older value): it never throws, keeps only predicates that filter
 *    something, and decoding its own output changes nothing.
 */
import fc from 'fast-check'
import {describe, expect, it} from 'vitest'
import type {BlockPredicate} from '@/data/api'
import {fuzzParams, fuzzTestTimeout} from '@/test/fuzz'
import {backlinksFilterCodec} from '../filterProperty'

const whereArb = fc.dictionary(fc.string({maxLength: 6}), fc.jsonValue({maxDepth: 2}), {maxKeys: 3})

const predicateArb: fc.Arbitrary<BlockPredicate> = fc.record({
  scope: fc.constantFrom('self' as const, 'ancestor' as const),
  id: fc.string({maxLength: 8}),
  where: whereArb,
  referencedBy: fc.record({id: fc.string({maxLength: 8}), sourceField: fc.string({maxLength: 6})}, {requiredKeys: ['id']}),
}, {requiredKeys: []})

const filterArb = fc.record({
  include: fc.array(predicateArb, {maxLength: 4}),
  exclude: fc.array(predicateArb, {maxLength: 4}),
})

const filters = (value: {include: BlockPredicate[]; exclude: BlockPredicate[]}) => [...value.include, ...value.exclude]

const filtersSomething = (p: BlockPredicate) =>
  p.id !== undefined || p.referencedBy !== undefined || (p.where !== undefined && Object.keys(p.where).length > 0)

describe('backlinks filter codec fuzz', () => {
  it('decodes what it encodes, through JSON storage', () => {
    fc.assert(fc.property(filterArb, filter => {
      // Storage is JSON, which is also what reads `-0` back as `0`.
      const stored: unknown = JSON.parse(JSON.stringify(backlinksFilterCodec.encode(filter)))
      expect(backlinksFilterCodec.decode(stored)).toEqual(stored)
    }), fuzzParams(300))
  }, fuzzTestTimeout())

  it('decodes any stored JSON to a stable filter of meaningful predicates', () => {
    const storedArb = fc.oneof(
      fc.jsonValue({maxDepth: 4}),
      filterArb.map(filter => JSON.parse(JSON.stringify(filter)) as unknown),
    )
    fc.assert(fc.property(storedArb, stored => {
      const decoded = backlinksFilterCodec.decode(stored)
      expect(filters(decoded).every(filtersSomething)).toBe(true)
      expect(backlinksFilterCodec.decode(decoded)).toEqual(decoded)
    }), fuzzParams(300))
  }, fuzzTestTimeout())
})
