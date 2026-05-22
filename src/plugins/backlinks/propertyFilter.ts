/** Resolves how a registered property is filtered in the backlinks UI.
 *
 *  Pulls together three sources of truth and presents a single shape
 *  the filter form consumes:
 *    - the codec's `where` capability (is this storage-comparable?),
 *    - the codec's `type` discriminator (date/number get richer
 *      comparison operators; everything else with `where` is eq-only),
 *    - the `refTargetFilterDefaultsFacet` (a ref/refList to a known
 *      target type is presented as a filter on the target's default
 *      inner property — daily-notes contributes daily-note:date).
 *
 *  Keeps domain-specific knowledge (daily-note-as-date) in the
 *  contributing plugin. The UI never special-cases a property name. */
import {
  isRefCodec,
  isRefListCodec,
  type AnyPropertySchema,
  type BlockPredicate,
} from '@/data/api'
import type { RefTargetFilterDefault } from '@/data/facets.js'

export type PropertyFilterOperatorId =
  | 'eq' | 'lt' | 'lte' | 'gt' | 'gte' | 'between'
  | 'exists-true' | 'exists-false'

export type PropertyFilterInputKind = 'date' | 'number' | 'boolean' | 'text'

export interface PropertyFilterAffordance {
  /** Operator menu surfaced in the filter form for this property. */
  readonly operators: readonly PropertyFilterOperatorId[]
  /** Input control to render for value rows. `exists-*` operators
   *  render zero inputs regardless. */
  readonly inputKind: PropertyFilterInputKind
  /** Parse a raw `<input>` string into the operand the predicate
   *  builder expects. Returning `undefined` means "no value yet" — the
   *  builder treats that as incomplete input. */
  parse(raw: string): unknown
  /** Build a complete `BlockPredicate` for the given operator + values.
   *  Returns `null` when the input is incomplete (e.g. missing operand
   *  on a comparison). */
  build(propertyName: string, operator: PropertyFilterOperatorId, values: readonly string[]): BlockPredicate | null
}

const COMPARISON_OPERATORS: readonly PropertyFilterOperatorId[] = [
  'eq', 'lt', 'lte', 'gt', 'gte', 'between', 'exists-true', 'exists-false',
]

const EQ_OPERATORS: readonly PropertyFilterOperatorId[] = ['eq', 'exists-true', 'exists-false']

const PRESENCE_OPERATORS: readonly PropertyFilterOperatorId[] = ['exists-true', 'exists-false']

const operatorArity = (op: PropertyFilterOperatorId): 0 | 1 | 2 =>
  op === 'exists-true' || op === 'exists-false' ? 0 : op === 'between' ? 2 : 1

/** Affordance for a scalar codec, keyed by the codec's `type`
 *  discriminator. Date and number get the full comparison menu; other
 *  where-capable codecs (string/url/boolean) keep eq-only. */
const scalarAffordance = (codecType: string, whereCapable: boolean): PropertyFilterAffordance => {
  const operators = !whereCapable
    ? PRESENCE_OPERATORS
    : codecType === 'date' || codecType === 'number'
      ? COMPARISON_OPERATORS
      : EQ_OPERATORS
  const inputKind: PropertyFilterInputKind =
    codecType === 'date' ? 'date'
      : codecType === 'number' ? 'number'
        : codecType === 'boolean' ? 'boolean'
          : 'text'

  const parse = (raw: string): unknown => {
    if (raw === '') return undefined
    if (codecType === 'date') {
      // <input type="date"> yields `YYYY-MM-DD`; pin to UTC midnight
      // so encoded values line up with stored ISO strings byte-for-byte.
      const d = new Date(`${raw}T00:00:00.000Z`)
      return Number.isNaN(d.getTime()) ? undefined : d
    }
    if (codecType === 'number') {
      const n = Number(raw)
      return Number.isFinite(n) ? n : undefined
    }
    if (codecType === 'boolean') return raw === 'true'
    return raw
  }

  const build = (
    propertyName: string,
    operator: PropertyFilterOperatorId,
    values: readonly string[],
  ): BlockPredicate | null => {
    const whereValue = buildScalarWhereValue(operator, values, parse)
    if (whereValue === INCOMPLETE) return null
    return {scope: 'ancestor', where: {[propertyName]: whereValue}}
  }

  return {operators, inputKind, parse, build}
}

const INCOMPLETE = Symbol('incomplete')

const buildScalarWhereValue = (
  operator: PropertyFilterOperatorId,
  values: readonly string[],
  parse: (raw: string) => unknown,
): unknown | typeof INCOMPLETE => {
  if (operator === 'exists-true') return {exists: true}
  if (operator === 'exists-false') return null
  if (operator === 'between') {
    const lo = parse(values[0] ?? '')
    const hi = parse(values[1] ?? '')
    if (lo === undefined || hi === undefined) return INCOMPLETE
    return {between: [lo, hi]}
  }
  const operand = parse(values[0] ?? '')
  if (operand === undefined) {
    // Empty input on `=` keeps the legacy "empty = match unset"
    // sugar so existing user mental model isn't disrupted.
    return operator === 'eq' ? null : INCOMPLETE
  }
  return {[operator]: operand}
}

/** Wrap a scalar affordance with the typed-query `target` traversal so
 *  a ref/refList property surfaces the inner property's UX. */
const targetTraversalAffordance = (
  inner: PropertyFilterAffordance,
  innerPropertyName: string,
): PropertyFilterAffordance => ({
  operators: inner.operators,
  inputKind: inner.inputKind,
  parse: inner.parse,
  build: (propertyName, operator, values) => {
    if (operator === 'exists-true') {
      // ref points to a live target row, regardless of inner props.
      return {scope: 'ancestor', where: {[propertyName]: {target: {}}}}
    }
    if (operator === 'exists-false') {
      return {scope: 'ancestor', where: {[propertyName]: null}}
    }
    const inner_ = buildScalarWhereValue(operator, values, inner.parse)
    if (inner_ === INCOMPLETE) return null
    return {
      scope: 'ancestor',
      where: {[propertyName]: {target: {[innerPropertyName]: inner_}}},
    }
  },
})

const presenceOnlyAffordance: PropertyFilterAffordance = {
  operators: PRESENCE_OPERATORS,
  inputKind: 'text',
  parse: () => undefined,
  build: (propertyName, operator) => {
    if (operator === 'exists-true') {
      return {scope: 'ancestor', where: {[propertyName]: {exists: true}}}
    }
    if (operator === 'exists-false') {
      return {scope: 'ancestor', where: {[propertyName]: null}}
    }
    return null
  },
}

export const resolvePropertyFilter = (
  schema: AnyPropertySchema,
  schemas: ReadonlyMap<string, AnyPropertySchema>,
  refTargetDefaults: ReadonlyMap<string, RefTargetFilterDefault>,
): PropertyFilterAffordance => {
  if (isRefCodec(schema.codec) || isRefListCodec(schema.codec)) {
    for (const targetType of schema.codec.targetTypes) {
      const entry = refTargetDefaults.get(targetType)
      if (!entry) continue
      const innerSchema = schemas.get(entry.property)
      if (!innerSchema) continue
      const inner = resolvePropertyFilter(innerSchema, schemas, refTargetDefaults)
      return targetTraversalAffordance(inner, entry.property)
    }
    // ref/refList without a matching target default: presence-only.
    return presenceOnlyAffordance
  }
  return scalarAffordance(schema.codec.type, schema.codec.where !== undefined)
}

export const propertyFilterOperatorArity = operatorArity
