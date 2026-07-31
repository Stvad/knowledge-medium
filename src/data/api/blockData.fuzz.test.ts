// @vitest-environment node
/**
 * Fuzz suite for `normalizeReferences` (`src/data/api/blockData.ts:82-108`)
 * plus two cheap `blockSchema.ts` row-parser oracles — see `src/test/fuzz.ts`
 * for the smoke/deep tier mechanics.
 *
 * `normalizeReferences` is documented (blockData.ts:71-81) to: sort by
 * `(sourceField, id, alias)` with `sourceField` defaulted to `''`; collapse
 * *exact* duplicates; and be independent of writer-side iteration order so
 * "downstream equality checks reduce to text compare".
 *
 * A note on the dedup key, since it looks collision-prone at a glance: the
 * key is built as `` `${sourceField} ${ref.id} ${ref.alias}` ``
 * (blockData.ts:89). Read as source text that *looks* like a plain-space
 * join, which would let two distinct tuples collide when `sourceField`/`id`
 * embeds a space (e.g. `('a', 'b c', 'd')` vs `('a b', 'c', 'd')` both
 * rendering "a b c d"). A byte-level check of the file
 * (`git show HEAD:src/data/api/blockData.ts | python3 -c "..."`) shows the
 * separator is actually U+0000 (NUL), not U+0020 (space) — it just displays
 * as whitespace in editors/terminals. NUL is not reachable through normal
 * content (block text, wikilink aliases, property names), so the join is
 * effectively unambiguous for realistic inputs; a manual reproduction that
 * used a literal space instead of NUL produced an apparent collision that
 * does not occur against the real function (verified by calling it
 * directly, not by re-deriving the key by hand) — a wrong-oracle mistake on
 * the test-writing side, not a product bug. No generator narrowing is
 * needed here as a result.
 */
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, quarantinedFuzzParams } from '@/test/fuzz'
import { normalizeReferences } from './blockData'
import type { BlockReference } from './blockData'
import {
  BLOCK_LOCAL_COLUMNS,
  BLOCK_STORAGE_COLUMNS,
  blockToRowParams,
  parseBlockRow,
  type BlockRow,
} from '../blockSchema'
import type { BlockData } from './blockData'

// ──── normalizeReferences ────

// NUL is excluded EXPLICITLY (not just by fc.string's default
// grapheme-ascii unit, verified to emit no control chars over 50k
// samples): normalizeReferences keys tuples by a NUL join
// (blockData.ts:89), so NUL-bearing fields would make two distinct
// tuples collide by construction — out of the supported domain, per the
// docblock above. The filter keeps that exclusion true even if fc's
// default charset ever widens.
const fieldArb = fc.oneof(
  {arbitrary: fc.constantFrom('', ' ', '  ', '\t', 'related', 'reviewer'), weight: 2},
  {arbitrary: fc.string({maxLength: 10}).filter(s => !s.includes('\0')), weight: 3},
)

const refArb: fc.Arbitrary<BlockReference> = fc.record(
  {
    sourceField: fieldArb,
    id: fieldArb,
    alias: fieldArb,
  },
  {requiredKeys: ['id', 'alias']},
)

// Draw from a small pool and index into it so duplicate entries (both
// exact dupes and same-id-different-alias) show up often, not just as a
// generation-probability accident.
const refsArb: fc.Arbitrary<BlockReference[]> = fc
  .array(refArb, {minLength: 1, maxLength: 5})
  .chain(pool =>
    fc
      .array(fc.integer({min: 0, max: pool.length - 1}), {minLength: 0, maxLength: 15})
      .map(indices => indices.map(i => pool[i])),
  )

const tupleKey = (r: BlockReference) => JSON.stringify([r.sourceField ?? '', r.id, r.alias])

describe('normalizeReferences', () => {
  it('is idempotent: f(f(x)) deep-equals f(x)', () => {
    fc.assert(
      fc.property(refsArb, refs => {
        const once = normalizeReferences(refs)
        const twice = normalizeReferences(once)
        expect(twice).toEqual(once)
      }),
      fuzzParams(150),
    )
  })

  it('output is sorted by (sourceField default \'\', id, alias)', () => {
    fc.assert(
      fc.property(refsArb, refs => {
        const out = normalizeReferences(refs)
        for (let i = 1; i < out.length; i++) {
          const a = out[i - 1]
          const b = out[i]
          const aSf = a.sourceField ?? ''
          const bSf = b.sourceField ?? ''
          const cmp =
            aSf !== bSf ? (aSf < bSf ? -1 : 1)
            : a.id !== b.id ? (a.id < b.id ? -1 : 1)
            : a.alias !== b.alias ? (a.alias < b.alias ? -1 : 1)
            : 0
          expect(cmp).toBeLessThanOrEqual(0)
        }
      }),
      fuzzParams(150),
    )
  })

  it('output has no duplicate (sourceField, id, alias) tuples', () => {
    fc.assert(
      fc.property(refsArb, refs => {
        const out = normalizeReferences(refs)
        const keys = out.map(tupleKey)
        expect(new Set(keys).size).toBe(keys.length)
      }),
      fuzzParams(150),
    )
  })

  it('output tuple set EQUALS the unique input tuple set (nothing invented, nothing dropped)', () => {
    // Set equality, not just subset: subset alone is satisfied by an
    // implementation that drops everything — a dedup regression losing a
    // non-duplicate ref would have passed every other property here
    // (Codex review on PR #371).
    fc.assert(
      fc.property(refsArb, refs => {
        const out = normalizeReferences(refs)
        const inputKeys = new Set(refs.map(tupleKey))
        const outputKeys = new Set(out.map(tupleKey))
        expect([...outputKeys].sort()).toEqual([...inputKeys].sort())
      }),
      fuzzParams(150),
    )
  })

  it('is permutation-invariant: f(shuffle(x)) deep-equals f(x)', () => {
    const withShuffleArb = refsArb.chain(refs =>
      fc.tuple(
        fc.constant(refs),
        fc.shuffledSubarray(refs, {minLength: refs.length, maxLength: refs.length}),
      ),
    )
    fc.assert(
      fc.property(withShuffleArb, ([refs, shuffled]) => {
        expect(normalizeReferences(shuffled)).toEqual(normalizeReferences(refs))
      }),
      fuzzParams(150),
    )
  })
})

// ──── blockSchema.ts row-parser oracles (cheap to add here; imports are
// clean from src/data/api/) ────

describe('parseBlockRow / blockToRowParams (blockSchema.ts)', () => {
  // JSON can't distinguish -0 from 0 (`JSON.stringify(-0) === '0'`, and
  // `JSON.parse('0')` is `+0`) — that's lossy-by-design JSON behavior, not a
  // blockSchema defect, so keep -0 out of the round-trip domain rather than
  // asserting an equality JSON itself doesn't preserve.
  const hasNegativeZero = (v: unknown): boolean => {
    if (typeof v === 'number') return Object.is(v, -0)
    if (Array.isArray(v)) return v.some(hasNegativeZero)
    if (v && typeof v === 'object') return Object.values(v).some(hasNegativeZero)
    return false
  }
  const jsonPropsArb = fc
    .dictionary(fc.string({minLength: 1, maxLength: 10}), fc.jsonValue({maxDepth: 2}))
    .filter(props => !hasNegativeZero(props))
  const refArb2 = fc.record(
    {id: fc.string({maxLength: 10}), alias: fc.string({maxLength: 10}), sourceField: fc.string({maxLength: 10})},
    {requiredKeys: ['id', 'alias']},
  )
  const blockDataArb: fc.Arbitrary<BlockData> = fc.record({
    id: fc.string({minLength: 1, maxLength: 20}),
    workspaceId: fc.string({minLength: 1, maxLength: 20}),
    parentId: fc.option(fc.string({minLength: 1, maxLength: 20}), {nil: null}),
    orderKey: fc.string({minLength: 1, maxLength: 10}),
    content: fc.string({maxLength: 40}),
    properties: jsonPropsArb,
    references: fc.array(refArb2, {maxLength: 5}),
    createdAt: fc.integer({min: 0, max: 2 ** 33}),
    updatedAt: fc.integer({min: 0, max: 2 ** 33}),
    userUpdatedAt: fc.integer({min: 0, max: 2 ** 33}),
    createdBy: fc.string({maxLength: 20}),
    updatedBy: fc.string({maxLength: 20}),
    deleted: fc.boolean(),
    referenceTargetId: fc.option(fc.string({minLength: 1, maxLength: 20}), {nil: null}),
    isFieldForm: fc.boolean(),
  })

  // PR #288 slice A: `blockToRowParams` returns storage columns followed by
  // the local-only columns (`reference_target_id`, `is_field_form`) — mirror
  // that order here so the round-trip covers the local columns too.
  const ROW_COLUMNS = [...BLOCK_STORAGE_COLUMNS, ...BLOCK_LOCAL_COLUMNS]

  const rowFromParams = (params: ReturnType<typeof blockToRowParams>): BlockRow => {
    const row: Record<string, unknown> = {}
    ROW_COLUMNS.forEach((column, index) => {
      row[column.name] = params[index]
    })
    return row as unknown as BlockRow
  }

  it('blockToRowParams -> parseBlockRow round-trips an arbitrary BlockData', () => {
    // QUARANTINED from the deep tier (issue #391; upstream nodejs/node#63785,
    // our dup #64546) — `quarantinedFuzzParams`, not `fuzzParams`. A V8 bug
    // caches decoded property keys that contain escape sequences: a prior parse
    // whose key decodes to `\` (an escaped-backslash key `"\\"`) poisons the
    // cache, so a later escaped key reads back the cached `\`. In this suite the
    // deep tier parses such a `\\`-key object before an input with a `"` key,
    // and the `"` decodes to `\`. Not a blockSchema defect — the functions are
    // correct by construction. Minimal repro (no fast-check, no flags):
    //   JSON.parse('{"h":[],"\\\\":0}')
    //   Object.keys(JSON.parse('{"h":1,"\\"":2}'))[1]  // '\' not '"'
    // Reproduces on Node 24 (V8 13.6) and 26 (V8 14.6); open upstream. Deep-
    // fuzzing a JSON round-trip adds ~nothing (its logic is exercised by the
    // bounded sample), so we pin it rather than let the engine bug flip the
    // nightly red. Restore `fuzzParams` once the upstream fix lands (and ships
    // in a Node we run). See docs/fuzzing.md → "counterexample passes on replay".
    fc.assert(
      fc.property(blockDataArb, blockData => {
        const decoded = parseBlockRow(rowFromParams(blockToRowParams(blockData)))
        expect(decoded).toEqual(blockData)
      }),
      quarantinedFuzzParams(150),
    )
  })

  it('parseBlockRow never throws on malformed properties_json/references_json', () => {
    const junkJsonStringArb = fc.oneof(
      fc.string({maxLength: 20}),
      fc.constantFrom('', 'null', 'undefined', '{', '[', '"unterminated', '42', 'true', 'NaN'),
      fc.jsonValue({maxDepth: 2}).map(v => JSON.stringify(v)),
    )
    fc.assert(
      fc.property(blockDataArb, junkJsonStringArb, junkJsonStringArb, (blockData, propsJunk, refsJunk) => {
        const row = rowFromParams(blockToRowParams(blockData))
        const malformed: BlockRow = {...row, properties_json: propsJunk, references_json: refsJunk}
        expect(() => parseBlockRow(malformed)).not.toThrow()
      }),
      fuzzParams(150),
    )
  })
})
