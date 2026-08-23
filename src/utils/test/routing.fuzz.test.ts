// @vitest-environment node
/**
 * Fuzz suite for the panel-layout hash-route grammar, which `routing.ts`
 * states in its own header. See `src/test/fuzz.ts` for smoke/deep tier
 * mechanics and `docs/fuzzing.md` for conventions. `routing.test.ts` pins
 * hand-picked cases for the same laws; this suite fuzzes around them rather
 * than duplicating them.
 *
 * Each property's law is in its `describe` name.
 */
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, utf16UnitArb } from '@/test/fuzz'
import {
  parseLayout,
  parseAppHash,
  buildLayoutFromSlots,
  flattenSlots,
  RESERVED_SLOT_CONTEXT_KEYS,
  type LayoutSlot,
} from '../routing'

// ──── Shared charset generators ────

// BLOCK_ID_RE = /^[A-Za-z0-9._-]+$/.
const BLOCK_ID_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-'.split('')
const blockIdArb: fc.Arbitrary<string> =
  fc.string({unit: fc.constantFrom(...BLOCK_ID_CHARS), minLength: 1, maxLength: 8})

// Guaranteed to fail BLOCK_ID_RE: '%' is outside the charset, and the regex
// is anchored to the start, so no suffix can rescue it.
const invalidBlockIdArb: fc.Arbitrary<string> =
  fc.string({unit: fc.constantFrom(...BLOCK_ID_CHARS), maxLength: 4}).map(s => `%${s}`)

// CONTEXT_ENTRY_RE key group = /^[a-z][a-z0-9-]*/, minus the reserved keys.
// Excluded via routing's registration DATA, never via isReservedSlotContextKey
// — filtering by the predicate under test would make the round-trip property
// blind to it over-classifying an ordinary key (routing would strip that key
// from `rest` and the generator would stop producing it, in lockstep).
const REST_KEY_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')
const restKeyArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
    fc.string({unit: fc.constantFrom(...REST_KEY_CHARS), maxLength: 5}),
  )
  .map(([first, rest]) => first + rest)
  .filter(key => !RESERVED_SLOT_CONTEXT_KEYS.includes(key))

// REST_ENTRY_RE value group = /[A-Za-z0-9%._~-]*/.
const REST_VALUE_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789%._~-'.split('')
const restValueArb: fc.Arbitrary<string> =
  fc.string({unit: fc.constantFrom(...REST_VALUE_CHARS), maxLength: 5})

const restEntryArb: fc.Arbitrary<string> = fc
  .tuple(restKeyArb, fc.option(restValueArb, {nil: undefined}))
  .map(([key, value]) => (value === undefined ? key : `${key}=${value}`))

const entryKey = (entry: string): string => entry.split('=')[0]
const sortByKey = (entries: readonly string[]): string[] =>
  [...entries].sort((a, b) => (entryKey(a) < entryKey(b) ? -1 : entryKey(a) > entryKey(b) ? 1 : 0))

// Unique by key: parseContextEntries dedups on first-valid-wins per key
//, so a generator with colliding keys wouldn't
// exercise these properties any differently — dedup keeps the AST/build
// side aligned with what a parse would actually produce.
const uniqueRestEntriesArb: fc.Arbitrary<string[]> =
  fc.uniqueArray(restEntryArb, {selector: entryKey, minLength: 0, maxLength: 4})

// ──── Property 1: totality ────

const soupFragmentArb = fc.oneof(
  fc.constantFrom('#', '/', ',', '(', ')', ';', '=', '%', '?', '&'),
  fc.constantFrom(...BLOCK_ID_CHARS),
  fc.integer({min: 0, max: 0x1f}).map(n => String.fromCharCode(n)), // control chars
  fc.string({unit: 'binary', maxLength: 4}), // whole code points, astral included
  fc.string({unit: utf16UnitArb, maxLength: 4}), // ill-formed UTF-16: lone surrogates
)
const soupArb: fc.Arbitrary<string> = fc
  .array(soupFragmentArb, {maxLength: 20})
  .map(frags => `#${frags.join('')}`)

describe('totality: parseLayout / parseAppHash never throw on grammar-alphabet + adversarial soup', () => {
  it('parseLayout never throws and blockIds is always flattenSlots(slots)', () => {
    fc.assert(
      fc.property(soupArb, raw => {
        let result: ReturnType<typeof parseLayout> | undefined
        expect(() => {
          result = parseLayout(raw)
        }).not.toThrow()
        expect(Array.isArray(result!.slots)).toBe(true)
        expect(Array.isArray(result!.blockIds)).toBe(true)
        // parseLayout derives blockIds from slots via flattenSlots, so the
        // two must always agree.
        expect(result!.blockIds).toEqual(flattenSlots(result!.slots))
      }),
      fuzzParams(200),
    )
  })

  it('parseAppHash never throws', () => {
    fc.assert(
      fc.property(soupArb, raw => {
        expect(() => parseAppHash(raw)).not.toThrow()
      }),
      fuzzParams(200),
    )
  })
})

// ──── Property 2: fixed point ────

describe('fixed point: parse∘build∘parse', () => {
  it('holds for arbitrary hash strings', () => {
    fc.assert(
      fc.property(soupArb, raw => {
        const first = parseLayout(raw)
        // wsContext is threaded through like the slots: parse canonicalizes
        // the ws-token entries, build re-emits them, so the composition is a
        // fixed point over the WHOLE route — id, ws-context, and slots.
        const rebuilt = buildLayoutFromSlots(first.workspaceId ?? '', first.slots, first.wsContext)
        const second = parseLayout(rebuilt)
        expect(second).toEqual(first)
      }),
      fuzzParams(200),
    )
  })

  it('rest-entry URL order does not affect the parsed result', () => {
    const orderedPairArb = uniqueRestEntriesArb.chain(entries =>
      fc.tuple(
        fc.constant(entries),
        fc.shuffledSubarray(entries, {minLength: entries.length, maxLength: entries.length}),
        fc.shuffledSubarray(entries, {minLength: entries.length, maxLength: entries.length}),
      ),
    )

    fc.assert(
      fc.property(blockIdArb, orderedPairArb, (blockId, [, orderA, orderB]) => {
        const hashA = `#ws/${[blockId, ...orderA].join(';')}`
        const hashB = `#ws/${[blockId, ...orderB].join(';')}`
        const parsedA = parseLayout(hashA)
        const parsedB = parseLayout(hashB)

        // Same entries, different URL order -> identical parsed result.
        expect(parsedA).toEqual(parsedB)

        const leaf = parsedA.slots[0]
        if (leaf.kind === 'leaf' && leaf.rest) expect(leaf.rest).toEqual(sortByKey(leaf.rest))

        // And it's a fixed point under build/reparse too.
        const rebuilt = buildLayoutFromSlots('ws', parsedA.slots)
        expect(parseLayout(rebuilt)).toEqual(parsedA)
      }),
      fuzzParams(150),
    )
  })
})

// ──── Property 3: structural round-trip on a bounded-depth AST ────

type Leaf = Extract<LayoutSlot, {kind: 'leaf'}>

const leafArb: fc.Arbitrary<Leaf> = fc.record({
  kind: fc.constant('leaf' as const),
  blockId: blockIdArb,
  viewMode: fc.option(fc.string({minLength: 1, maxLength: 10}), {nil: undefined}),
  active: fc.boolean(),
  maximized: fc.boolean(),
  rest: uniqueRestEntriesArb,
})

const MAX_DEPTH = 3

// `depth` = remaining allowed paren-nesting levels from this point; a
// sublayout consumes exactly one level for its own columns. Stack cells
// (kind: 'leaf' | 'sublayout' only) and columns
// mirror the actual grammar shapes parseColumn/parseSublayout produce.
function genCell(depth: number): fc.Arbitrary<LayoutSlot> {
  return depth > 0
    ? fc.oneof({weight: 2, arbitrary: leafArb}, {weight: 1, arbitrary: genSublayout(depth)})
    : leafArb
}

function genStack(depth: number): fc.Arbitrary<LayoutSlot> {
  return fc
    .array(genCell(depth), {minLength: 2, maxLength: 3})
    .map((children): LayoutSlot => ({kind: 'stack', children}))
}

function genSublayout(depth: number): fc.Arbitrary<LayoutSlot> {
  return fc
    .array(genColumn(depth - 1), {minLength: 1, maxLength: 3})
    .map((columns): LayoutSlot => ({kind: 'sublayout', columns}))
}

function genColumn(depth: number): fc.Arbitrary<LayoutSlot> {
  return depth > 0
    ? fc.oneof(
      {weight: 3, arbitrary: leafArb},
      {weight: 1, arbitrary: genStack(depth)},
      {weight: 1, arbitrary: genSublayout(depth)},
    )
    : leafArb
}

const slotsArb: fc.Arbitrary<LayoutSlot[]> =
  fc.array(genColumn(MAX_DEPTH), {minLength: 0, maxLength: 4})

/** Mirrors buildContextSuffix / parseContextEntries' canonicalization: falsy
 *  flags, empty `rest`, and empty/absent `viewMode` are all dropped; `rest` is
 *  sorted by key. One arm per flag in FLAG_SLOT_CONTEXT_KEYS. */
const canonicalizeSlot = (slot: LayoutSlot): LayoutSlot => {
  if (slot.kind === 'leaf') {
    const rest = sortByKey(slot.rest ?? [])
    return {
      kind: 'leaf',
      blockId: slot.blockId,
      ...(slot.viewMode ? {viewMode: slot.viewMode} : {}),
      ...(slot.active ? {active: true} : {}),
      ...(slot.maximized ? {maximized: true} : {}),
      ...(rest.length > 0 ? {rest} : {}),
    }
  }
  if (slot.kind === 'stack') return {kind: 'stack', children: slot.children.map(canonicalizeSlot)}
  return {kind: 'sublayout', columns: slot.columns.map(canonicalizeSlot)}
}

describe('structural round-trip: bounded-depth LayoutSlot AST', () => {
  it('buildLayoutFromSlots -> parseLayout recovers the canonicalized input AST', () => {
    fc.assert(
      fc.property(blockIdArb, slotsArb, (ws, slots) => {
        const hash = buildLayoutFromSlots(ws, slots)
        const parsed = parseLayout(hash)
        expect(parsed.workspaceId).toBe(ws)
        expect(parsed.slots).toEqual(slots.map(canonicalizeSlot))
      }),
      fuzzParams(150),
    )
  })
})

// ──── Property 4: paren atomicity ────

describe('paren atomicity: one invalid segment drops the WHOLE group', () => {
  it('corrupting one leaf inside a paren group drops the group; sibling top-level columns survive untouched', () => {
    fc.assert(
      fc.property(
        blockIdArb,
        leafArb,
        leafArb,
        fc.array(blockIdArb, {minLength: 1, maxLength: 3}),
        fc.nat(),
        invalidBlockIdArb,
        (ws, siblingA, siblingB, sublayoutBlockIds, rawIndex, badId) => {
          const idx = rawIndex % sublayoutBlockIds.length
          const badColumns: LayoutSlot[] = sublayoutBlockIds.map((blockId, i): LayoutSlot => ({
            kind: 'leaf',
            blockId: i === idx ? badId : blockId,
          }))
          const mutatedSlots: LayoutSlot[] = [siblingA, {kind: 'sublayout', columns: badColumns}, siblingB]
          const mutatedHash = buildLayoutFromSlots(ws, mutatedSlots)

          const parsed = parseLayout(mutatedHash)
          // The whole sublayout column is gone; the two valid siblings
          // survive, canonicalized exactly as property 3 predicts.
          expect(parsed.slots).toEqual([siblingA, siblingB].map(canonicalizeSlot))
        },
      ),
      fuzzParams(100),
    )
  })
})

// ──── Property 5: splitTopLevel(s, sep).join(sep) === s, via real callers ────

// `splitTopLevel` is module-private with no exported binding, so each of its
// four call sites is driven through the public API instead, with inputs whose
// parsed AST names the split pieces 1:1 (no loss/reorder/dedup) — recovering
// the real function's split decisions from its output. Exporting the helper to
// call it directly is the obvious simplification and is wrong: it tests the
// split in isolation and stops covering what each call site splits on.
describe('splitTopLevel join law, driven through its real callers', () => {
  it('comma split: parseColumn recovers cells 1:1', () => {
    fc.assert(
      fc.property(fc.array(blockIdArb, {minLength: 1, maxLength: 5}), pieces => {
        const text = pieces.join(',')
        const parsed = parseLayout(`#ws/${text}`)
        expect(parsed.slots).toHaveLength(1)
        const slot = parsed.slots[0]
        const recovered = slot.kind === 'leaf'
          ? [slot.blockId]
          : (slot as Extract<LayoutSlot, {kind: 'stack'}>).children
            .map(c => (c as Leaf).blockId)
        expect(recovered).toEqual(pieces)
        expect(recovered.join(',')).toBe(text)
      }),
      fuzzParams(100),
    )
  })

  it('top-level slash split: parseLayout recovers workspaceId + column pieces 1:1', () => {
    fc.assert(
      fc.property(blockIdArb, fc.array(blockIdArb, {minLength: 0, maxLength: 5}), (ws, pieces) => {
        const text = [ws, ...pieces].join('/')
        const parsed = parseLayout(`#${text}`)
        expect(parsed.workspaceId).toBe(ws)
        const recoveredColumns = parsed.slots.map(s => (s as Leaf).blockId)
        expect(recoveredColumns).toEqual(pieces)
        expect([parsed.workspaceId, ...recoveredColumns].join('/')).toBe(text)
      }),
      fuzzParams(100),
    )
  })

  it('paren-inner slash split: parseSublayout recovers columns 1:1', () => {
    fc.assert(
      fc.property(fc.array(blockIdArb, {minLength: 1, maxLength: 4}), pieces => {
        const inner = pieces.join('/')
        const parsed = parseLayout(`#ws/(${inner})`)
        expect(parsed.slots).toHaveLength(1)
        const slot = parsed.slots[0]
        expect(slot.kind).toBe('sublayout')
        const columns = (slot as Extract<LayoutSlot, {kind: 'sublayout'}>).columns
        const recovered = columns.map(c => (c as Leaf).blockId)
        expect(recovered).toEqual(pieces)
        expect(recovered.join('/')).toBe(inner)
      }),
      fuzzParams(100),
    )
  })

  it('semicolon split: parseSlotCell recovers [blockId, ...rest] 1:1 when already key-sorted', () => {
    const sortedUniqueRestEntriesArb = uniqueRestEntriesArb.map(sortByKey)
    fc.assert(
      fc.property(blockIdArb, sortedUniqueRestEntriesArb, (blockId, entries) => {
        const text = [blockId, ...entries].join(';')
        const parsed = parseLayout(`#ws/${text}`)
        expect(parsed.slots).toHaveLength(1)
        const leaf = parsed.slots[0] as Leaf
        expect(leaf.kind).toBe('leaf')
        const recovered = [leaf.blockId, ...(leaf.rest ?? [])]
        expect(recovered).toEqual([blockId, ...entries])
        expect(recovered.join(';')).toBe(text)
      }),
      fuzzParams(100),
    )
  })
})
