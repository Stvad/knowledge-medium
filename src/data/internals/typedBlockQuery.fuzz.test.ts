// @vitest-environment node
/**
 * Differential fuzz suite for the typed-block query compiler
 * (`typedBlockQuery.ts`) — see `src/test/fuzz.ts` for the smoke/deep tier
 * mechanics and `docs/fuzzing.md` for suite conventions.
 *
 * Random block forests with typed properties are written RAW into a real
 * test DB (the shape a sync-applied row has: the trigger-maintained
 * `block_types` / `block_references` indexes are populated, no processor
 * runs), random `TypedBlockQuery` specs run through every SQL path, and each
 * result is diffed against `QueryModel` — a pure-JS interpreter written from
 * the DOCUMENTED semantics in `src/data/api/typedBlockQuery.ts`, never from
 * the SQL builder. A transliteration of the compiler would agree with it on
 * every bug, so the model shares nothing with it but the codecs' documented
 * `where.encode` contract: it reads the raw generated rows (not the derived
 * index tables), walks parents in JS, and evaluates predicates in plain
 * two-valued logic.
 *
 * SQL paths diffed per spec, all against the same model answer:
 *   - `compileTypedBlockQuery` with each projection (`rows` / `ids` /
 *     `count`), executed directly;
 *   - the Repo resolvers (`repo.query.typedBlocks` / `typedBlockIds` /
 *     `typedBlockCount`), which add the single-type fast path
 *     (`SELECT_BLOCKS_BY_TYPE_SQL`), normalization, and the ancestor-dep
 *     walk (`declareAncestorDeps`) that runs its own SQL before the query.
 * Ordering is compared exactly (the spec defines `created_at` then `id`);
 * `count` against the model's cardinality.
 *
 * ──── Semantics the model encodes ────
 *
 * From the `TypedBlockQuery` / `BlockPredicate` / `WhereOperator` docblocks;
 * where those are silent, the reading chosen here is marked (chosen).
 *
 * - Visibility: only `deleted = 0` rows in the query's workspace are
 *   candidates. A soft-deleted row is invisible everywhere — as a target of
 *   `target`, and as an ancestor: the walk cannot pass THROUGH a deleted
 *   parent, so nothing above one is an ancestor either (chosen).
 * - `types`: "contains any of these type ids"; query ids are trimmed and
 *   empties dropped, and an empty list means no type filter. A block's type
 *   ids are the strings in its `types` property.
 * - `where[name]`: `null` and `{exists: false}` mean unset (missing OR JSON
 *   null); `{exists: true}` means set — so `''`, `[]`, `0` and `false` are
 *   all SET. A comparator (`eq`/bare value/`lt`/`lte`/`gt`/`gte`/`between`,
 *   inclusive) holds only when the stored cell is a value the property's
 *   codec could have written (`WhereStorage`) AND the comparison holds
 *   between the `where.encode`d forms; an unset cell matches no comparator.
 *   Strings compare by code point, dates chronologically within years
 *   0000–9999: a date cell outside them matches no comparator, and a query
 *   with an operand outside them is refused.
 * - `target`: the ref (or any refList member) names a LIVE block in the
 *   same workspace whose properties satisfy the inner where-map; `{}` means
 *   "names a live block". A refList cell that is not an array names nothing,
 *   as in `decodeRefListIds`.
 * - `referencedBy {id, sourceField?}`: some reference entry of the block
 *   names `id`, with `sourceField` matching when given (`''` = a content
 *   reference with no field). Ancestor-as-tag: in ancestor scope, with no
 *   `sourceField`, an ancestor that IS `id` also matches.
 * - Predicates: sub-fields AND; ancestor scope = some single
 *   block-or-ancestor satisfies ALL of them. `match` ANDs; `exclude` NORs —
 *   a block is excluded only when a predicate definitely matches, so an
 *   unknown (unset property) never excludes — SQL's NULL is not FALSE.
 * - A predicate with no `id`, `referencedBy` or `where` entry is ignored, in
 *   `exclude` as in `match` (an empty backlinks-filter chip filters
 *   nothing; chosen). A literal reading of NOR would make `exclude: [{}]`
 *   remove every row.
 * - The ancestor-walk gate: an ancestor-scoped predicate with no
 *   candidate-bounding filter (types, `referencedBy`, or a selective
 *   self-scope where / match predicate — `null` and `{exists: false}` are
 *   not selective) is REJECTED, and the model predicts which specs are.
 *
 * ──── Generator emphasis: the NULL class ────
 *
 * Every property cell is drawn from absent / JSON null / a canonical value
 * / the type's "empty" value ('' / [] / 0 / false) / a value of another
 * shape (what a re-type leaves behind), and every where value
 * from null / exists / comparators / between / nested target — so a
 * comparison on an absent or foreign value, a negated predicate over it, an
 * exclude of an unset property, and a `target` through a missing / dangling /
 * deleted / cross-workspace ref are all common. Blocks carry 0..n type
 * tags (multi-type blocks exercise the join's DISTINCT), a fraction are
 * soft-deleted, parents form forests with the occasional cycle or dangling
 * parent, and `created_at` collides often so the `id` tiebreak is
 * exercised.
 *
 * ──── Deliberately NOT covered ────
 *
 * - A date cell in the canonical SHAPE with impossible fields
 *   (`2026-13-45T…`): the compiler tests the shape, not the calendar, so it
 *   would compare as text where the model calls it foreign. Accepted.
 * - The ancestor walk's depth cap (100): generated chains are short.
 * - Cross-workspace PARENT links (a broken invariant the rest of the data
 *   layer audits); cross-workspace REF targets are generated.
 * - Validation errors other than the gate (unknown operator, multi-key
 *   operator object, comparator on a non-where-queryable codec): every
 *   generated spec is well-formed, and the example tests pin those.
 * - Lone UTF-16 surrogates in strings: the driver folds them at the bind /
 *   storage boundary, which would fail the property for a reason unrelated
 *   to the compiler. Astral and high-BMP code points ARE generated (they
 *   order differently in UTF-16 than in UTF-8).
 * - Invalidation / dep wiring (`kernelInvalidation.fuzz.test.ts` and
 *   `queryHandles.fuzz.test.ts` own reactivity); this suite only checks
 *   what one load returns.
 */
import { isDeepStrictEqual } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout, statefulFuzzGuard } from '@/test/fuzz'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import {
  ChangeScope,
  seedProperty,
  type AnyCodec,
  type BlockPredicate,
  type ResolvedTypedBlockQuery,
  type TypedBlockQueryReferenceFilter,
} from '@/data/api'
import { typesProp } from '@/data/properties'
import { definitionSeedsFacet } from '../facets'
import type { Repo } from '../repo'
import { compileTypedBlockQuery, type TypedBlockQueryProjection } from './typedBlockQuery'

const WS = 'ws-a'
const OTHER_WS = 'ws-b'
const GATE_ERROR = /require at least one candidate filter/
const DATE_RANGE_ERROR = /date in years 0000-9999/

// ──── Property universe ────

type Kind = 'string' | 'number' | 'boolean' | 'date' | 'ref' | 'refList' | 'list'

const prop = (key: string, name: string, preset: string) =>
  seedProperty({
    seedKey: `test/property/tbq-fuzz-${key}`, revision: 1, name,
    preset: preset as 'string', changeScope: ChangeScope.BlockDefault,
  })

interface PropSpec {
  readonly name: string
  readonly kind: Kind
  readonly codec: AnyCodec
}

const SEEDS = [
  {key: 'str', kind: 'string', seed: prop('str', 'tbq:str', 'string')},
  {key: 'num', kind: 'number', seed: prop('num', 'tbq:num', 'number')},
  {key: 'bool', kind: 'boolean', seed: prop('bool', 'tbq:bool', 'boolean')},
  {key: 'date', kind: 'date', seed: prop('date', 'tbq:date', 'date')},
  {key: 'ref', kind: 'ref', seed: prop('ref', 'tbq:ref', 'ref')},
  {key: 'refs', kind: 'refList', seed: prop('refs', 'tbq:refs', 'refList')},
  {key: 'labels', kind: 'list', seed: prop('labels', 'tbq:labels', 'string-list')},
  // JSON-path quoting: `"`, `'`, `\`, `.` and a space in one name. The model
  // reads the key verbatim, so any path-escaping slip shows as a divergence
  // (or a SQL error) rather than as an empty result nobody notices.
  {key: 'quoted', kind: 'string', seed: prop('quoted', `tbq:say "hi" it's a\\b.c`, 'string')},
] as const

const PROPS: readonly PropSpec[] = [
  ...SEEDS.map(s => ({name: s.seed.name, kind: s.kind as Kind, codec: s.seed.codec as AnyCodec})),
  {name: typesProp.name, kind: 'list', codec: typesProp.codec as AnyCodec},
]
const PROP_BY_NAME = new Map(PROPS.map(p => [p.name, p]))

// ──── Value pools ────
// Overlapping stored / operand pools so equality and range edges actually
// hit. Strings mix ASCII case, numeric-looking text, a high-BMP private-use
// char and an astral emoji (U+E000 sorts AFTER 😀 in UTF-16 code units but
// BEFORE it in code points / UTF-8 bytes).
const STRINGS = ['', 'a', 'A', 'b', 'ab', 'a ', '0', '10', '9', 'é', '\uE000', '\u{1F600}', 'null']
const NUMBERS = [0, 1, -1, 2, 1.5, -0.5, 10, 1e21, 123456789]
const ISO_DATES = [
  '0000-01-01T00:00:00.000Z',
  '1969-12-31T23:59:59.999Z',
  '1970-01-01T00:00:00.000Z',
  '2026-01-01T00:00:00.000Z',
  '2026-05-18T12:00:00.000Z',
  '9999-12-31T23:59:59.999Z',
]
/** What `toISOString()` writes outside years 0000–9999: a signed six-digit
 *  year, which sorts before every four-digit one as text. Stored, they match
 *  no comparator; as operands, they refuse the query. */
const EXTENDED_DATES = ['+010000-01-01T00:00:00.000Z', '-000001-12-31T23:59:59.999Z']
/** Date-only operand spellings: `where.encode` accepts any parseable string
 *  (JSON-revived predicates) and normalizes it to the canonical ISO form. */
const DATE_ONLY = ['2026-01-01', '1970-01-01']
const STORED_TYPES = ['todo', 'task', 'Todo', ' todo']
const QUERY_TYPES = ['todo', 'task', 'Todo', ' todo ', '', '  ', 'none']
const SOURCE_FIELDS = [undefined, '', 'tbq:ref', 'other'] as const

/** Cells of every JSON shape, most of which the property's codec could not
 *  have written under any one kind — what a re-type leaves behind in the old
 *  encoding. SQLite orders values across storage classes, so each one is a
 *  cell a bare comparison would order against the operand. `'["b0"]'`,
 *  `['b0']` and `{id: 'b0'}` all spell a real row id, so a fan-out that reads
 *  one as a list is visible; the date-like strings are not what the date
 *  codec writes, one of them only past an embedded NUL. */
const FOREIGN_CELLS: readonly unknown[] = [
  '', 'x', '10', '2026-01-01', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00.000Z\u0000x', '["b0"]',
  0, 1, 1767225600000, true, false, [], ['b0'], {}, {id: 'b0'},
]

// ──── Generated world ────

interface RefEntry {
  readonly id: string
  readonly alias: string
  readonly sourceField?: string
}

interface Row {
  readonly id: string
  readonly workspaceId: string
  readonly parentId: string | null
  readonly deleted: boolean
  readonly createdAt: number
  readonly properties: Readonly<Record<string, unknown>>
  readonly references: readonly RefEntry[]
}

/** An index into the generated rows, resolved `% (n + 1)`; the extra slot is
 *  a ghost id no row carries (dangling refs / parents / predicate ids).
 *  Resolving by modulo keeps every reference valid under shrinking. */
type IdRef = number
const GHOST_ID = 'ghost'
const idOf = (ids: readonly string[], ref: IdRef): string => {
  const k = ref % (ids.length + 1)
  return k === ids.length ? GHOST_ID : ids[k]!
}

/** Biased toward the first few rows so ref cells, reference entries,
 *  `referencedBy` filters and predicate ids collide often. */
const idRefArb = fc.oneof(
  {arbitrary: fc.nat({max: 3}), weight: 3},
  {arbitrary: fc.nat({max: 40}), weight: 1},
)

/** `arb` with probability `present / (present + absent)`, else undefined. */
const sometimes = <T>(arb: fc.Arbitrary<T>, present: number, absent: number) =>
  fc.oneof(
    {arbitrary: arb, weight: present},
    {arbitrary: fc.constant(undefined), weight: absent},
  )

const dropUndefined = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

const EMPTY_VALUE: Readonly<Record<Kind, {readonly v: unknown} | undefined>> = {
  string: {v: ''}, number: {v: 0}, boolean: {v: false}, date: undefined,
  ref: {v: ''}, refList: {v: []}, list: {v: []},
}

/** A cell value before id resolution: ref ids are still `IdRef`s. */
type RawCell =
  | {readonly t: 'absent'}
  | {readonly t: 'null'}
  | {readonly t: 'value'; readonly v: unknown}
  | {readonly t: 'ref'; readonly v: IdRef}
  | {readonly t: 'refs'; readonly v: readonly IdRef[]}

const cellArb = (kind: Kind, name: string): fc.Arbitrary<RawCell> => {
  const absent = fc.constant<RawCell>({t: 'absent'})
  const nul = fc.constant<RawCell>({t: 'null'})
  const value = (arb: fc.Arbitrary<unknown>): fc.Arbitrary<RawCell> => arb.map(v => ({t: 'value', v}))
  const canonical: fc.Arbitrary<RawCell> = (() => {
    switch (kind) {
      case 'string': return value(fc.constantFrom(...STRINGS))
      case 'number': return value(fc.constantFrom(...NUMBERS))
      case 'boolean': return value(fc.boolean())
      case 'date': return value(fc.oneof(
        {arbitrary: fc.constantFrom(...ISO_DATES), weight: 4},
        {arbitrary: fc.constantFrom(...EXTENDED_DATES), weight: 1},
      ))
      case 'ref': return idRefArb.map(v => ({t: 'ref', v}))
      case 'refList': return fc.array(idRefArb, {maxLength: 3}).map(v => ({t: 'refs', v}))
      case 'list': return name === typesProp.name
        ? value(fc.uniqueArray(fc.constantFrom(...STORED_TYPES), {maxLength: 3}))
        : value(fc.array(fc.constantFrom(...STRINGS.slice(0, 4)), {maxLength: 2}))
    }
  })()
  // SET but falsy: what a `NOT`, a `COALESCE` or a JS truthiness check
  // confuses with unset. A date has no empty value — it stores JSON null.
  const empty = EMPTY_VALUE[kind]
  // `types` stays well-formed: its trigger indexes a bare string as a type,
  // which is the index's reading, not this compiler's.
  const foreign = name !== typesProp.name
  return fc.oneof(
    {arbitrary: absent, weight: 4},
    {arbitrary: nul, weight: 2},
    {arbitrary: canonical, weight: 5},
    ...(empty === undefined ? [] : [{arbitrary: value(fc.constant(empty.v)), weight: 2}]),
    ...(foreign ? [{arbitrary: value(fc.constantFrom(...FOREIGN_CELLS)), weight: 3}] : []),
  )
}

const refEntryArb = fc.record({
  target: idRefArb,
  alias: fc.constantFrom('al', 'al2'),
  sourceField: fc.constantFrom(...SOURCE_FIELDS),
})

/** Mostly a recent row of the same workspace (`back` 0 = the nearest one) so
 *  chains grow deep; occasionally any row or the ghost, which is how cycles
 *  and dangling parents arise. */
type RawParent = {readonly back: number} | {readonly any: IdRef} | null

const rawRowArb = fc.record({
  otherWorkspace: fc.integer({min: 0, max: 3}).map(n => n === 0),
  parent: fc.oneof(
    {arbitrary: fc.constant<RawParent>(null), weight: 2},
    {arbitrary: fc.nat({max: 2}).map((back): RawParent => ({back})), weight: 7},
    {arbitrary: idRefArb.map((any): RawParent => ({any})), weight: 1},
  ),
  deleted: fc.integer({min: 0, max: 4}).map(n => n === 0),
  createdAt: fc.integer({min: 0, max: 4}),
  cells: fc.tuple(...PROPS.map(p => cellArb(p.kind, p.name))),
  references: fc.array(refEntryArb, {maxLength: 3}),
})

type RawRow = typeof rawRowArb extends fc.Arbitrary<infer R> ? R : never

const resolveRows = (raw: readonly RawRow[]): Row[] => {
  const ids = raw.map((_, i) => `b${i}`)
  const wsOf = (i: number) => (raw[i]!.otherWorkspace ? OTHER_WS : WS)
  /** The `back`-th earlier row (0 = nearest) in row i's workspace, or -1. */
  const sameWorkspaceBefore = (i: number, back: number) => {
    let seen = 0
    for (let j = i - 1; j >= 0; j--) {
      if (wsOf(j) === wsOf(i) && seen++ === back) return j
    }
    return -1
  }
  return raw.map((r, i) => {
    const properties: Record<string, unknown> = {}
    PROPS.forEach((p, k) => {
      const cell = r.cells[k]!
      switch (cell.t) {
        case 'absent': return
        case 'null': properties[p.name] = null; return
        case 'value': properties[p.name] = cell.v; return
        case 'ref': properties[p.name] = idOf(ids, cell.v); return
        case 'refs': properties[p.name] = cell.v.map(v => idOf(ids, v)); return
      }
    })
    // Parents stay inside the row's own workspace (see the module doc);
    // cycles and dangling parents are allowed.
    let parentId: string | null = null
    if (r.parent !== null) {
      const k = 'back' in r.parent
        ? sameWorkspaceBefore(i, r.parent.back)
        : r.parent.any % (raw.length + 1)
      if (k === raw.length) parentId = GHOST_ID
      else if (k >= 0 && wsOf(k) === wsOf(i)) parentId = ids[k]!
    }
    return {
      id: ids[i]!,
      workspaceId: wsOf(i),
      parentId,
      deleted: r.deleted,
      createdAt: r.createdAt,
      properties,
      references: r.references.map(e => ({
        id: idOf(ids, e.target),
        alias: e.alias,
        ...(e.sourceField === undefined ? {} : {sourceField: e.sourceField}),
      })),
    }
  })
}

// ──── Query specs ────

/** Where values before id resolution; `IdRef`s appear only in predicate ids
 *  and referencedBy, never inside where values (ref comparators are not
 *  where-queryable — `target` is the only operator on a ref). */
type WhereMap = Record<string, unknown>

/** Rarely out of range: such an operand refuses the whole query. */
const dateOperandArb = fc.oneof(
  {arbitrary: fc.constantFrom(...ISO_DATES).map(s => new Date(s)), weight: 4},
  {arbitrary: fc.constantFrom(...ISO_DATES), weight: 4},
  {arbitrary: fc.constantFrom(...DATE_ONLY), weight: 4},
  {arbitrary: fc.constantFrom(...EXTENDED_DATES).map(s => new Date(s)), weight: 1},
)

const scalarOperandArb = (kind: Kind): fc.Arbitrary<unknown> => {
  switch (kind) {
    case 'string': return fc.constantFrom(...STRINGS)
    case 'number': return fc.constantFrom(...NUMBERS)
    case 'boolean': return fc.boolean()
    case 'date': return dateOperandArb
    default: throw new Error(`no scalar operand for ${kind}`)
  }
}

const presenceArb = fc.constantFrom<unknown>(null, {exists: true}, {exists: false})

const whereValueArb = (p: PropSpec, depth: number): fc.Arbitrary<unknown> => {
  switch (p.kind) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'date': {
      const op = scalarOperandArb(p.kind)
      return fc.oneof(
        {arbitrary: presenceArb, weight: 2},
        {arbitrary: op, weight: 2},
        {
          arbitrary: fc.tuple(fc.constantFrom('eq', 'lt', 'lte', 'gt', 'gte'), op)
            .map(([k, v]) => ({[k]: v})),
          weight: 4,
        },
        {arbitrary: fc.tuple(op, op).map(([lo, hi]) => ({between: [lo, hi]})), weight: 1},
      )
    }
    case 'ref':
    case 'refList':
      return depth <= 0
        ? presenceArb
        : fc.oneof(
          {arbitrary: presenceArb, weight: 1},
          {arbitrary: whereMapArb(depth - 1, 0).map(inner => ({target: inner})), weight: 3},
        )
    case 'list':
      return presenceArb
  }
}

const whereMapArb = (depth: number, minLength: number): fc.Arbitrary<WhereMap> =>
  fc.array(
    fc.oneof(...PROPS.map(p => fc.tuple(fc.constant(p.name), whereValueArb(p, depth)))),
    {minLength, maxLength: 2},
  ).map(entries => Object.fromEntries(entries))

interface RawRefFilter {
  readonly target: IdRef
  readonly sourceField: string | undefined
}

/** No `sourceField` is the common filter (and the only one ancestor-as-tag
 *  applies to), so it outweighs each field spelling. */
const refFilterArb: fc.Arbitrary<RawRefFilter> = fc.record({
  target: idRefArb,
  sourceField: fc.oneof(
    {arbitrary: fc.constant(undefined), weight: 3},
    {arbitrary: fc.constantFrom(...SOURCE_FIELDS.slice(1)), weight: 2},
  ),
})

interface RawPredicate {
  readonly scope?: 'self' | 'ancestor'
  readonly id?: IdRef
  readonly where?: WhereMap
  readonly referencedBy?: RawRefFilter
}

/** Mostly ONE constraint per predicate — stacking `id` + `referencedBy` +
 *  `where` on every predicate leaves almost every result empty, which is
 *  where no divergence can show. The free-form record keeps the
 *  combinations reachable; the empty predicate, which must be ignored, gets
 *  its own weight. */
const predicateBodyArb: fc.Arbitrary<Omit<RawPredicate, 'scope'>> = fc.oneof(
  {arbitrary: fc.constantFrom<Omit<RawPredicate, 'scope'>>({}, {where: {}}), weight: 1},
  {arbitrary: whereMapArb(1, 1).map(where => ({where})), weight: 5},
  {arbitrary: refFilterArb.map(referencedBy => ({referencedBy})), weight: 3},
  {arbitrary: idRefArb.map(id => ({id})), weight: 3},
  {
    arbitrary: fc.record(
      {id: idRefArb, where: whereMapArb(1, 0), referencedBy: refFilterArb},
      {requiredKeys: []},
    ),
    weight: 1,
  },
)

const predicateArb: fc.Arbitrary<RawPredicate> = fc.tuple(
  fc.constantFrom<'self' | 'ancestor' | undefined>(undefined, 'self', 'ancestor', 'ancestor'),
  predicateBodyArb,
).map(([scope, body]) => dropUndefined({scope, ...body}))

/** Top-level filters stay light: every one of them runs before `match` /
 *  `exclude` and discards rows, and a row that never reaches an exclude
 *  predicate cannot expose its NULL handling. */
const rawQueryArb = fc.record({
  workspaceId: fc.constantFrom(WS, WS, WS, WS, WS, OTHER_WS),
  types: sometimes(fc.subarray(QUERY_TYPES, {maxLength: 3}), 1, 2),
  where: sometimes(whereMapArb(1, 0), 1, 2),
  referencedBy: sometimes(refFilterArb, 1, 6),
  match: sometimes(fc.array(predicateArb, {maxLength: 2}), 1, 1),
  exclude: sometimes(fc.array(predicateArb, {minLength: 1, maxLength: 2}), 2, 1),
  order: sometimes(fc.constantFrom<'created-asc' | 'created-desc'>('created-asc', 'created-desc'), 2, 1),
}).map(dropUndefined)

type RawQuery = typeof rawQueryArb extends fc.Arbitrary<infer Q> ? Q : never

const resolveRefFilter = (ids: readonly string[], r: RawRefFilter): TypedBlockQueryReferenceFilter => ({
  id: idOf(ids, r.target),
  ...(r.sourceField === undefined ? {} : {sourceField: r.sourceField}),
})

const resolvePredicate = (ids: readonly string[], p: RawPredicate): BlockPredicate => ({
  ...(p.scope === undefined ? {} : {scope: p.scope}),
  ...(p.id === undefined ? {} : {id: idOf(ids, p.id)}),
  ...(p.where === undefined ? {} : {where: p.where}),
  ...(p.referencedBy === undefined ? {} : {referencedBy: resolveRefFilter(ids, p.referencedBy)}),
})

const resolveQuery = (ids: readonly string[], q: RawQuery): ResolvedTypedBlockQuery => ({
  workspaceId: q.workspaceId,
  ...(q.types === undefined ? {} : {types: q.types}),
  ...(q.where === undefined ? {} : {where: q.where}),
  ...(q.referencedBy === undefined ? {} : {referencedBy: resolveRefFilter(ids, q.referencedBy)}),
  ...(q.match === undefined ? {} : {match: q.match.map(p => resolvePredicate(ids, p))}),
  ...(q.exclude === undefined ? {} : {exclude: q.exclude.map(p => resolvePredicate(ids, p))}),
  ...(q.order === undefined ? {} : {order: q.order}),
})

// ──── The reference interpreter ────

type ModelResult =
  | {readonly kind: 'ok'; readonly ids: readonly string[]}
  | {readonly kind: 'error'; readonly error: RegExp}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date)

const isUnset = (cell: unknown) => cell === undefined || cell === null

/** SET, but easy to mistake for unset: '' / [] / 0 / false. */
const isEmptyValue = (cell: unknown) =>
  cell === '' || cell === 0 || cell === false || (Array.isArray(cell) && cell.length === 0)

/** `null` and `{exists: false}` only admit rows LACKING the property, so they
 *  cannot bound a candidate set. */
const isSelective = (value: unknown) =>
  !(value === null || (isPlainObject(value) && Object.keys(value).length === 1 && value.exists === false))

/** Years 0000–9999: the range in which date comparators are defined. */
const inDateRange = (date: Date) => date.getUTCFullYear() >= 0 && date.getUTCFullYear() <= 9999

/** Every comparator operand in a where-map, nested `target` maps included. */
const comparatorOperands = (where: WhereMap | undefined): {p: PropSpec; operand: unknown}[] =>
  Object.entries(where ?? {}).flatMap(([name, value]) => {
    const p = PROP_BY_NAME.get(name)!
    if (value === null) return []
    if (!isPlainObject(value)) return [{p, operand: value}]
    const [op, operand] = Object.entries(value)[0]!
    if (op === 'exists') return []
    if (op === 'target') return comparatorOperands(operand as WhereMap)
    if (op === 'between') return (operand as unknown[]).map(o => ({p, operand: o}))
    return [{p, operand}]
  })

const codePointCompare = (a: string, b: string) =>
  Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))

const compare = (a: number | string, b: number | string): number => {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0
  if (typeof a === 'string' && typeof b === 'string') return codePointCompare(a, b)
  throw new Error(`model compared mixed kinds ${typeof a} / ${typeof b}`)
}

/** Model-side counters for the non-vacuity canary: each names a case the
 *  generators are supposed to reach. Nothing in the property reads them. */
const COVERAGE_KEYS = [
  'non-empty result',
  'gate rejection',
  'comparator on an unset cell',
  'comparator on a foreign cell',
  'comparator on an out-of-range date cell',
  'query refused for an out-of-range date operand',
  'exclude kept a row over an unset cell',
  'exclude kept a row over a foreign cell',
  'exclude removed a row',
  'exists:true on an empty value',
  'match through a proper ancestor',
  'ancestor-as-tag',
  'ancestor walk cut at a deleted parent',
  'target hit',
  'target named a dead / foreign / ghost row',
  'row carrying two requested types',
  'created_at tie in a result',
] as const
type CoverageKey = typeof COVERAGE_KEYS[number]

class QueryModel {
  private readonly byId: ReadonlyMap<string, Row>
  /** Set when a comparator meets an unset cell during the current predicate. */
  private sawUnknown = false
  /** Set when a comparator meets a set cell its codec could not have written. */
  private sawForeign = false

  constructor(
    private readonly rows: readonly Row[],
    private readonly coverage?: Map<CoverageKey, number>,
  ) {
    this.byId = new Map(rows.map(r => [r.id, r]))
  }

  private hit(key: CoverageKey) {
    this.coverage?.set(key, (this.coverage.get(key) ?? 0) + 1)
  }

  private cell(row: Row, name: string): unknown {
    return Object.hasOwn(row.properties, name) ? row.properties[name] : undefined
  }

  private typeIds(row: Row): ReadonlySet<string> {
    const cell = this.cell(row, typesProp.name)
    return new Set(Array.isArray(cell) ? cell.filter((t): t is string => typeof t === 'string') : [])
  }

  /** The comparable form of a stored cell, or undefined when it is unset or
   *  is not a value the codec could have written (`encode(decode(cell))`
   *  must reproduce the cell). */
  private comparable(p: PropSpec, cell: unknown): number | string | undefined {
    if (isUnset(cell)) return undefined
    let decoded: unknown
    try {
      decoded = p.codec.decode(cell)
    } catch {
      return undefined
    }
    if (decoded === undefined || !isDeepStrictEqual(p.codec.encode(decoded), cell)) return undefined
    if (p.kind !== 'date') return p.codec.where!.encode(decoded)
    if (!inDateRange(decoded as Date)) {
      this.hit('comparator on an out-of-range date cell')
      return undefined
    }
    return (decoded as Date).getTime()
  }

  private operand(p: PropSpec, value: unknown): number | string {
    const encoded = p.codec.where!.encode(value)
    return p.kind === 'date' ? Date.parse(encoded as string) : encoded
  }

  private targets(p: PropSpec, cell: unknown): string[] {
    if (p.kind === 'ref') return typeof cell === 'string' ? [cell] : []
    if (p.kind === 'refList') return Array.isArray(cell) ? cell.filter((t): t is string => typeof t === 'string') : []
    throw new Error(`target on ${p.kind}`)
  }

  private whereEntry(row: Row, name: string, value: unknown): boolean {
    const p = PROP_BY_NAME.get(name)
    if (!p) throw new Error(`model: unknown property ${name}`)
    const cell = this.cell(row, name)
    if (value === null) return isUnset(cell)
    const comparable = () => {
      const v = this.comparable(p, cell)
      if (isUnset(cell)) {
        this.sawUnknown = true
        this.hit('comparator on an unset cell')
      } else if (v === undefined) {
        this.sawForeign = true
        this.hit('comparator on a foreign cell')
      }
      return v
    }
    if (isPlainObject(value)) {
      const [op, operand] = Object.entries(value)[0]!
      switch (op) {
        case 'exists': {
          if (operand && isEmptyValue(cell)) this.hit('exists:true on an empty value')
          return operand ? !isUnset(cell) : isUnset(cell)
        }
        case 'target': return this.targets(p, cell).some(id => {
          const target = this.byId.get(id)
          const live = target !== undefined && !target.deleted &&
            target.workspaceId === row.workspaceId
          if (!live) this.hit('target named a dead / foreign / ghost row')
          const holds = live && this.whereMap(target, operand as WhereMap)
          if (holds) this.hit('target hit')
          return holds
        })
        case 'between': {
          const v = comparable()
          const [lo, hi] = operand as [unknown, unknown]
          return v !== undefined &&
            compare(this.operand(p, lo), v) <= 0 && compare(v, this.operand(p, hi)) <= 0
        }
        default: {
          const v = comparable()
          if (v === undefined) return false
          const c = compare(v, this.operand(p, operand))
          switch (op) {
            case 'eq': return c === 0
            case 'lt': return c < 0
            case 'lte': return c <= 0
            case 'gt': return c > 0
            case 'gte': return c >= 0
          }
          throw new Error(`model: unknown operator ${op}`)
        }
      }
    }
    const v = comparable()
    return v !== undefined && compare(v, this.operand(p, value)) === 0
  }

  private whereMap(row: Row, where: WhereMap | undefined): boolean {
    return Object.entries(where ?? {}).every(([name, value]) => this.whereEntry(row, name, value))
  }

  private references(row: Row, filter: TypedBlockQueryReferenceFilter): boolean {
    return row.references.some(r =>
      r.id === filter.id &&
      (filter.sourceField === undefined || (r.sourceField ?? '') === filter.sourceField))
  }

  /** The block itself, then each live parent up to the first missing,
   *  deleted or already-visited one. */
  private chain(row: Row): Row[] {
    const out = [row]
    const seen = new Set([row.id])
    let current = row
    while (current.parentId !== null) {
      const parent = this.byId.get(current.parentId)
      if (parent?.deleted) this.hit('ancestor walk cut at a deleted parent')
      if (parent === undefined || parent.deleted || seen.has(parent.id)) break
      out.push(parent)
      seen.add(parent.id)
      current = parent
    }
    return out
  }

  private holdsOn(row: Row, p: BlockPredicate, ancestorAsTag: boolean): boolean {
    if (p.id !== undefined && row.id !== p.id) return false
    if (!this.whereMap(row, p.where)) return false
    const rb = p.referencedBy
    if (rb === undefined) return true
    if (this.references(row, rb)) return true
    const asTag = ancestorAsTag && rb.sourceField === undefined && row.id === rb.id
    if (asTag) this.hit('ancestor-as-tag')
    return asTag
  }

  private predicate(row: Row, p: BlockPredicate): boolean {
    if ((p.scope ?? 'self') === 'self') return this.holdsOn(row, p, false)
    const holder = this.chain(row).findIndex(a => this.holdsOn(a, p, true))
    if (holder > 0) this.hit('match through a proper ancestor')
    return holder >= 0
  }

  private excluded(row: Row, exclude: readonly BlockPredicate[]): boolean {
    return exclude.some(p => {
      this.sawUnknown = false
      this.sawForeign = false
      const holds = this.predicate(row, p)
      if (holds) this.hit('exclude removed a row')
      else {
        if (this.sawUnknown) this.hit('exclude kept a row over an unset cell')
        if (this.sawForeign) this.hit('exclude kept a row over a foreign cell')
      }
      return holds
    })
  }

  run(query: ResolvedTypedBlockQuery): ModelResult {
    const types = [...new Set((query.types ?? []).map(t => t.trim()).filter(Boolean))]
    const constrains = (p: BlockPredicate) =>
      p.id !== undefined || p.referencedBy !== undefined || Object.keys(p.where ?? {}).length > 0
    const match = (query.match ?? []).filter(constrains)
    const exclude = (query.exclude ?? []).filter(constrains)

    const walks = [...match, ...exclude].some(p => p.scope === 'ancestor')
    const bounded =
      query.referencedBy !== undefined ||
      types.length > 0 ||
      Object.values(query.where ?? {}).some(isSelective) ||
      match.some(p => (p.scope ?? 'self') === 'self' && (
        p.id !== undefined || p.referencedBy !== undefined ||
        Object.values(p.where ?? {}).some(isSelective)))
    if (walks && !bounded) {
      this.hit('gate rejection')
      return {kind: 'error', error: GATE_ERROR}
    }
    const refused = [query.where, ...match.map(p => p.where), ...exclude.map(p => p.where)]
      .flatMap(comparatorOperands)
      .some(({p, operand}) => p.kind === 'date' && !inDateRange(new Date(operand as string | Date)))
    if (refused) {
      this.hit('query refused for an out-of-range date operand')
      return {kind: 'error', error: DATE_RANGE_ERROR}
    }

    const hits = this.rows.filter(row => {
      if (row.deleted || row.workspaceId !== query.workspaceId) return false
      if (types.length > 0) {
        const own = this.typeIds(row)
        const held = types.filter(t => own.has(t)).length
        if (held === 0) return false
        if (held > 1) this.hit('row carrying two requested types')
      }
      if (!this.whereMap(row, query.where)) return false
      if (query.referencedBy !== undefined && !this.references(row, query.referencedBy)) return false
      return match.every(p => this.predicate(row, p)) && !this.excluded(row, exclude)
    })
    const desc = query.order === 'created-desc'
    hits.sort((a, b) =>
      (desc ? b.createdAt - a.createdAt : a.createdAt - b.createdAt) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    if (hits.length > 0) this.hit('non-empty result')
    if (hits.some((r, i) => i > 0 && hits[i - 1]!.createdAt === r.createdAt)) {
      this.hit('created_at tie in a result')
    }
    return {kind: 'ok', ids: hits.map(r => r.id)}
  }
}

// ──── DB plumbing ────

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => {
  await sharedDb.cleanup()
})

/** Every case resets and rewrites the shared DB; no `Math.random` pin is
 *  needed (rows are written raw with explicit order keys), so the guard is
 *  barrier-only. */
const guard = statefulFuzzGuard()

const seedExtensions = SEEDS.map(s => definitionSeedsFacet.of(s.seed, {source: 'test'}))

const insertRows = async (rows: readonly Row[]) => {
  await sharedDb.db.writeTransaction(async tx => {
    for (const row of rows) {
      await tx.execute(
        `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json,
           references_json, created_at, updated_at, user_updated_at, created_by, updated_by, deleted)
         VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, 'u', 'u', ?)`,
        [row.id, row.workspaceId, row.parentId, `a${row.id}`, JSON.stringify(row.properties),
          JSON.stringify(row.references), row.createdAt, row.createdAt, row.createdAt,
          row.deleted ? 1 : 0],
      )
    }
  })
}

type Outcome = {readonly ok: readonly string[] | number} | {readonly error: string}

const attempt = async (fn: () => Promise<readonly string[] | number>): Promise<Outcome> => {
  try {
    return {ok: await fn()}
  } catch (error) {
    return {error: error instanceof Error ? error.message : String(error)}
  }
}

const runAllPaths = async (
  repo: Repo,
  query: ResolvedTypedBlockQuery,
): Promise<Record<string, Outcome>> => {
  const direct = (projection: TypedBlockQueryProjection) => async () => {
    const compiled = compileTypedBlockQuery(query, repo.propertySchemas, {projection})
    if (projection === 'count') {
      const row = await sharedDb.db.get<{count: number}>(compiled.sql, [...compiled.params])
      return row.count
    }
    const rows = await sharedDb.db.getAll<{id: string}>(compiled.sql, [...compiled.params])
    return rows.map(r => r.id)
  }
  return {
    'compiled rows': await attempt(direct('rows')),
    'compiled ids': await attempt(direct('ids')),
    'compiled count': await attempt(direct('count')),
    'repo typedBlocks': await attempt(async () =>
      (await repo.query.typedBlocks(query).load()).map(b => b.id)),
    'repo typedBlockIds': await attempt(() => repo.query.typedBlockIds(query).load()),
    'repo typedBlockCount': await attempt(() => repo.query.typedBlockCount(query).load()),
  }
}

const expectedOutcomes = (model: ModelResult, paths: readonly string[]) =>
  Object.fromEntries(paths.map(path => [
    path,
    model.kind === 'error'
      ? {error: expect.stringMatching(model.error)}
      : {ok: path.endsWith('Count') || path.endsWith('count') ? model.ids.length : model.ids},
  ]))

/** Many queries per world: the DB reset + insert dominates a case's cost,
 *  and each extra query over the same rows is nearly free. */
const worldArb = fc.record({
  rows: fc.array(rawRowArb, {minLength: 2, maxLength: 16}),
  queries: fc.array(rawQueryArb, {minLength: 12, maxLength: 30}),
})

describe('compileTypedBlockQuery — differential vs a JS reference interpreter', () => {
  it('every SQL path returns exactly what the documented semantics select', async () => {
    await fc.assert(
      fc.asyncProperty(worldArb, async ({rows: rawRows, queries: rawQueries}) => {
        await guard.run(null, async () => {
          await resetTestDb(sharedDb.db)
          const rows = resolveRows(rawRows)
          const ids = rows.map(r => r.id)
          await insertRows(rows)
          const model = new QueryModel(rows)
          // One Repo per world: its handle cache is keyed by query args, and
          // the rows do not change between this world's queries.
          const {repo} = createTestRepo({db: sharedDb.db, extensions: seedExtensions})
          for (const raw of rawQueries) {
            const query = resolveQuery(ids, raw)
            const actual = await runAllPaths(repo, query)
            expect({query, actual}).toEqual({
              query,
              actual: expectedOutcomes(model.run(query), Object.keys(actual)),
            })
          }
          // Precondition: nothing but the generated rows is in the table —
          // a Repo materializing seed definitions here would put rows the
          // model never saw into every unfiltered result.
          const {n} = await sharedDb.db.get<{n: number}>('SELECT COUNT(*) AS n FROM blocks')
          expect(n).toBe(rows.length)
        })
      }),
      fuzzParams(60),
    )
  }, fuzzTestTimeout())

  it('the generators reach every case the property is meant to cover (non-vacuity canary)', () => {
    // Model-only, fixed seed: a generator tweak that silently stops producing
    // one of these (an unset cell under an exclude, a proper-ancestor match, a
    // dead ref target, …) would leave the property green over a smaller domain.
    const coverage = new Map<CoverageKey, number>()
    for (const world of fc.sample(worldArb, {seed: 20261015, numRuns: 300})) {
      const rows = resolveRows(world.rows)
      const ids = rows.map(r => r.id)
      const model = new QueryModel(rows, coverage)
      for (const raw of world.queries) model.run(resolveQuery(ids, raw))
    }
    const missing = COVERAGE_KEYS.filter(key => !coverage.has(key))
    expect(missing).toEqual([])
  })
})
