/** Query text to {@link TypedBlockQuery}. Pure: names resolve through the
 *  caller's {@link QueryResolver}, and nothing is evaluated here. A term that
 *  does not resolve, or that the engine cannot express, becomes a
 *  {@link QueryTermError} carrying its span, and the rest of the query still
 *  compiles; an empty table never stands in for an error.
 *
 *  Terms AND by juxtaposition; `|` joins terms into one `anyOf` group:
 *
 *    #book  #book|#article  !#archived       type, any of these types, not this type
 *    status=open  rating>=3  label=""        a property compared with a value
 *    status!=open                            not equal
 *    snooze  !snooze                         property stored / not stored
 *    assignee=[[Mary]]  owner=((id))         a reference property pointing at a block
 *    scheduled>=2026-01-05                  compare a reference through the target's registered date property
 *    refs=[[Mary]]                           references the block through any field
 *    childof=self  childof=[[X]]  under=[[X]] direct parent / ancestor
 *    created>2026-01-01  plugin:score>3       a queryable field; on created/updated a date means the local day
 *    status=open | priority>=3               one or-group
 *
 *  Terms read what is stored, as the engine compares it: a property's default
 *  is never assumed for a block that does not store it; `''` and `[]` are
 *  stored values, so they count as set; a value stored in the wrong shape for
 *  its codec matches no comparison and does match `!=`, as an unset one does;
 *  text equality is exact, case included.
 *
 *  Names are bare for hand and agent writing; `name^fieldId` (and `#label^typeId`)
 *  is the saved form, the id authoritative and the name decoration. */
import { isEnumCodec, isRefCodec, isRefListCodec, type AnyPropertySchema, type BlockPredicate, type TypedBlockQuery, type WhereCapability } from '@/data/api'
import { UUID_RE_SOURCE, aliasedBlockRefSpanSource, blockRefSpanSource } from '@/data/referenceBlock'
import { MAX_ALIAS_LENGTH, parseOutermostReferences } from '@/plugins/references/referenceParser'

export interface QueryProperty {
  /** The name `where` keys and `sourceField` use. */
  readonly name: string
  readonly fieldId: string
  readonly schema: AnyPropertySchema
}

export interface QueryType {
  readonly id: string
  readonly label: string
}

/** What the parser asks of the workspace. Each lookup answers for this device:
 *  a name it does not know is a term error, never an empty result. */
export interface QueryResolver {
  propertyByName(name: string): QueryProperty | undefined
  propertyById(fieldId: string): QueryProperty | undefined
  /** Scalar target property through which a reference can compare a value. */
  refValueTarget(schema: AnyPropertySchema): AnyPropertySchema | undefined
  typeByLabel(label: string): QueryType | undefined
  typeById(id: string): QueryType | undefined
  /** A queryable field (`created`, `updated`, a plugin's), and how it takes an operand. */
  field(name: string): QueryField | undefined
  blockIdByAlias(alias: string): string | undefined
}

export type QueryField =
  /** A timestamp (`created`, `updated`): a date-only operand means the local day. */
  | {readonly kind: 'instant'}
  /** Any other field: its own encoder decides the operand, tried as text, then as a number. */
  | {readonly kind: 'value'; readonly encode: (operand: unknown) => unknown}

export interface ParseOptions {
  /** The block `childof=self` names. */
  readonly selfId?: string
  /** Epoch ms of local midnight starting the given calendar day (month 1-12),
   *  for date-only operands on fields. Defaults to this runtime's time zone. */
  readonly localDayStart?: DayStart
}

type DayStart = (year: number, month: number, day: number) => number

export interface QueryTermError {
  readonly start: number
  readonly end: number
  readonly message: string
}

export type QueryClauses = Pick<TypedBlockQuery, 'types' | 'parentId' | 'match' | 'anyOf' | 'exclude'>

export type CompareOp = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'

export interface RefOperand {
  readonly kind: 'ref'
  readonly id: string
  /** As written: `[[alias]]`, `((id))`, `[label](((id)))`, or `self`. */
  readonly spelling: string
}
export type Operand = {readonly kind: 'text'; readonly value: string} | RefOperand

interface Span { readonly start: number; readonly end: number }

export type QueryTerm = Span & (
  | {readonly kind: 'types'; readonly negated: boolean; readonly types: readonly QueryType[]}
  | {
    readonly kind: 'compare'; readonly property: QueryProperty; readonly op: CompareOp; readonly operand: Operand
    readonly target?: AnyPropertySchema
  }
  | {readonly kind: 'presence'; readonly property: QueryProperty; readonly present: boolean}
  | {
    readonly kind: 'field'; readonly field: string; readonly op: CompareOp; readonly operand: string
    /** What a value field compares the operand as; absent for an instant field. */
    readonly encoded?: string | number
  }
  | {readonly kind: 'refs' | 'under'; readonly target: RefOperand}
  | {readonly kind: 'childof'; readonly target: RefOperand}
  | {readonly kind: 'anyOf'; readonly alternatives: readonly AlternativeTerm[]}
)

type TermOf<K extends QueryTerm['kind']> = Extract<QueryTerm, {kind: K}>
/** A term that is one positive predicate, so it can be one side of `|`. */
export type AlternativeTerm = Exclude<QueryTerm, TermOf<'anyOf' | 'childof'>>

export interface ParsedQuery {
  readonly query: QueryClauses
  readonly errors: readonly QueryTermError[]
  /** The terms that compiled, in text order. */
  readonly terms: readonly QueryTerm[]
}

/** Keys that are structure, not properties. Address a property with one of
 *  these names through its saved form, `under^fieldId`. */
export const RESERVED_KEYS = ['refs', 'childof', 'under'] as const
type ReservedKey = typeof RESERVED_KEYS[number]
const isReservedKey = (name: string): name is ReservedKey => (RESERVED_KEYS as readonly string[]).includes(name)

const OPS: ReadonlyArray<readonly [string, CompareOp]> = [
  ['!=', 'ne'], ['<=', 'lte'], ['>=', 'gte'], ['=', 'eq'], ['<', 'lt'], ['>', 'gt'],
]
export const OP_TEXT: Readonly<Record<CompareOp, string>> = {eq: '=', ne: '!=', lt: '<', lte: '<=', gt: '>', gte: '>='}

/** Characters that end a bare word. Text holding one is written quoted. */
export const BREAK = /[\s"|()!=<>#^[\]]/
/** Characters that end a failed term while recovering: the next term starts after them. */
const TERM_END = /[\s|()]/
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
/** The one instant spelling the engine admits: `toISOString()` with a four-digit year. */
const INSTANT_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
/** An instant in that spelling that names a real moment: `Date` reads it back as itself. */
const isInstant = (text: string): boolean => {
  if (!INSTANT_SHAPE.test(text)) return false
  const ms = Date.parse(text)
  return Number.isFinite(ms) && new Date(ms).toISOString() === text
}
const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i
// Sticky, so reading one at a position never copies the rest of the text.
const LABELLED_BLOCK_REF = new RegExp(aliasedBlockRefSpanSource(UUID_RE_SOURCE), 'iy')
const BLOCK_REF = new RegExp(blockRefSpanSource(UUID_RE_SOURCE), 'iy')

class TermError extends Error {
  constructor(readonly start: number, readonly end: number, message: string) { super(message) }
}

/** Where a quote opened at `start` closes, past its `\"` and `\\` escapes; -1 if it never does. */
export const closingQuote = (text: string, start: number): number => {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) i++
    else if (text[i] === '"') return i
  }
  return -1
}

const unquote = (inner: string) => inner.replace(/\\(["\\])/g, '$1')

/** A cursor over the text. Every read method throws {@link TermError} with the
 *  span it was reading; the caller recovers at the next term. */
class Reader {
  i = 0
  constructor(readonly text: string, readonly resolver: QueryResolver, readonly options: ParseOptions) {}
  get done() { return this.i >= this.text.length }
  peek(n = 0) { return this.text[this.i + n] ?? '' }
  startsWith(s: string) { return this.text.startsWith(s, this.i) }
  skipSpace() { while (!this.done && /\s/.test(this.peek())) this.i++ }

  /** Spans stay inside the text and are never empty: one at the very end points at its last character. */
  fail(start: number, message: string, end = this.i): never {
    const length = this.text.length
    const from = Math.min(start, Math.max(length - 1, 0))
    throw new TermError(from, Math.min(Math.max(end, from + 1), length), message)
  }

  bareWord(): string {
    const start = this.i
    while (!this.done && !BREAK.test(this.peek())) this.i++
    return this.text.slice(start, this.i)
  }

  /** `"…"` with `\"` and `\\` escapes. */
  quoted(): string {
    const start = this.i
    const close = closingQuote(this.text, start)
    if (close < 0) this.fail(start, 'Unclosed quote', start + 1)
    this.i = close + 1
    return unquote(this.text.slice(start + 1, close))
  }

  name(): string {
    return this.peek() === '"' ? this.quoted() : this.bareWord()
  }

  /** `^id` after a name, if present. */
  savedId(): string | undefined {
    if (this.peek() !== '^') return undefined
    this.i++
    const id = this.name()
    if (!id) this.fail(this.i - 1, 'Expected an id after ^')
    return id
  }

  /** `[[alias]]` as the reference grammar reads it, `((id))` or `[label](((id)))`;
   *  undefined if none starts here. */
  reference(): RefOperand | undefined {
    const start = this.i
    if (this.startsWith('[[')) {
      const ref = this.wikilinkAt(start)
      if (!ref) return this.fail(start, 'Unclosed [[', start + 2)
      this.i = start + ref.endIndex
      const id = this.resolver.blockIdByAlias(ref.alias)
      if (!id) this.fail(start, `No page named [[${ref.alias}]]`)
      return {kind: 'ref', id, spelling: this.text.slice(start, this.i)}
    }
    for (const [pattern, group] of [[LABELLED_BLOCK_REF, 2], [BLOCK_REF, 1]] as const) {
      pattern.lastIndex = start
      const match = pattern.exec(this.text)
      if (!match) continue
      this.i = start + match[0].length
      return {kind: 'ref', id: match[group].toLowerCase(), spelling: match[0]}
    }
    if (this.startsWith('((') || this.startsWith('[')) this.fail(start, 'Expected [[page]] or ((block id))', start + 2)
    return undefined
  }

  /** The `[[…]]` starting at `start`, read by the reference grammar over the
   *  shortest slice that can hold it: up to each `]]` run in turn, so a nested
   *  link grows the slice and nothing past the link is scanned. */
  private wikilinkAt(start: number) {
    let end = start
    while (end - start <= MAX_ALIAS_LENGTH + 4) {
      const close = this.text.indexOf(']]', end)
      if (close < 0) return undefined
      end = close + 2
      while (this.text[end] === ']') end++
      const [ref] = parseOutermostReferences(this.text.slice(start, end))
      if (ref?.startIndex === 0) return ref
    }
    return undefined
  }

  operator(): CompareOp | undefined {
    for (const [text, op] of OPS) {
      if (this.startsWith(text)) { this.i += text.length; return op }
    }
    return undefined
  }

  /** Puts the cursor past a term that failed, without consuming the `|` or `)`
   *  that ends it. A closed quote is stepped over whole; an unclosed one is one character. */
  recover(termStart: number) {
    this.i = termStart
    while (!this.done && !TERM_END.test(this.peek())) {
      const close = this.peek() === '"' ? closingQuote(this.text, this.i) : -1
      this.i = close < 0 ? this.i + 1 : close + 1
    }
    // A term that failed on its first character (a stray `(` inside a group) must still move on.
    if (this.i === termStart && !this.done && this.peek() !== '|' && this.peek() !== ')') this.i++
  }
}

const isComparable = (schema: AnyPropertySchema) => {
  const storage = schema.codec.where?.storage
  return storage === 'number' || storage === 'iso-date'
}

const encodes = (encode: (value: never) => unknown, value: unknown): boolean => {
  try {
    encode(value as never)
    return true
  } catch {
    return false
  }
}

/** `[year, month, day]` of a date-only operand that names a real calendar day. */
const calendarDay = (text: string): [number, number, number] | undefined => {
  const match = DATE_ONLY.exec(text)
  if (!match) return undefined
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  // Date rolls a day that does not exist (2026-02-30) over into the next month.
  const check = new Date(Date.UTC(year, month - 1, day))
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day
    ? [year, month, day]
    : undefined
}

/** The day's first and last millisecond by `dayStart`'s clock. The last, not
 *  the next day's first: 9999-12-31 has no representable next day. */
const dayBounds = (text: string, dayStart: DayStart): [number, number] | undefined => {
  const day = calendarDay(text)
  return day && [dayStart(...day), dayStart(day[0], day[1], day[2] + 1) - 1]
}

/** A day as an instant range: `=` is the whole day, `<=` ends with it, `>` starts after it.
 *  `ne` is `eq`'s range, negated by the caller. */
const dayRange = <T>(op: CompareOp, [first, last]: [number, number], encode: (ms: number) => T): Record<string, unknown> => {
  switch (op) {
    case 'eq': case 'ne': return {between: [encode(first), encode(last)]}
    case 'lt': return {lt: encode(first)}
    case 'lte': return {lte: encode(last)}
    case 'gt': return {gt: encode(last)}
    case 'gte': return {gte: encode(first)}
  }
}

const utcDayStart: DayStart = (year, month, day) => Date.UTC(year, month - 1, day)
const defaultLocalDayStart: DayStart = (year, month, day) => new Date(year, month - 1, day).getTime()
const isoOf = (ms: number) => new Date(ms).toISOString()

/** The value an operand compares as under a `where` or list-member capability,
 *  or undefined if the codec refuses it. The reader validates with this and
 *  compiling reads it, so the two cannot disagree. */
const capabilityValue = (capability: WhereCapability<unknown>, text: string): unknown => {
  const value = (() => {
    switch (capability.storage) {
      case 'number': return NUMBER.test(text) && Number.isFinite(Number(text)) ? Number(text) : undefined
      case 'boolean': return text === 'true' ? true : text === 'false' ? false : undefined
      case 'iso-date': return calendarDay(text) || isInstant(text) ? isoOf(Date.parse(text)) : undefined
      case 'text': return text
    }
  })()
  return value !== undefined && encodes(capability.encode, value) ? value : undefined
}

/** The capability an operand on this property compares through: its scalar
 *  `where`, or, for a list, its member's. */
const operandCapability = (schema: AnyPropertySchema): WhereCapability<unknown> | undefined =>
  schema.codec.where ?? schema.codec.contains

/** Whether `name=value` can be written for this property; otherwise only its presence can be tested. */
export const takesOperand = (schema: AnyPropertySchema): boolean =>
  isRefCodec(schema.codec) || isRefListCodec(schema.codec) || operandCapability(schema) !== undefined

const operandProblem = (name: string, schema: AnyPropertySchema, text: string): string => {
  const {codec} = schema
  switch (operandCapability(schema)?.storage) {
    case 'number': return `${name} takes a number`
    case 'boolean': return `${name} takes true or false`
    case 'iso-date': return `${name} takes a date like 2026-01-31 or an ISO instant`
    default: return `"${text}" is not ${codec.where ? 'a value' : 'a member value'} of ${name}${isEnumCodec(codec) ? `: one of ${codec.options.map(option => option.value).join(', ')}` : ''}`
  }
}

/** The stored value a positive `=` term names, which a new row is given so the
 *  query selects it; undefined for any other term. */
export const impliedValue = (term: QueryTerm): unknown => {
  if (term.kind !== 'compare' || term.op !== 'eq' || term.target) return undefined
  const {schema} = term.property
  if (term.operand.kind === 'ref') return isRefListCodec(schema.codec) ? [term.operand.id] : term.operand.id
  const capability = operandCapability(schema)
  const value = capability && capabilityValue(capability, term.operand.value)
  return value === undefined || schema.codec.where ? value : [value]
}

const operatorValue = (op: CompareOp, value: unknown): Record<string, unknown> =>
  op === 'ne' ? {eq: value} : {[op]: value}

/** The predicate a positive or negated term contributes, and where it goes. */
type Placement = {to: 'match' | 'exclude'; predicate: BlockPredicate}

const compareTerm = ({property, op, operand, target}: TermOf<'compare'>): Placement => {
  const to = op === 'ne' ? 'exclude' : 'match'
  if (operand.kind === 'ref') return {to, predicate: {referencedBy: {id: operand.id, sourceField: property.name}}}
  const schema = target ?? property.schema
  const {codec} = schema
  const capability = operandCapability(schema)!
  if (!codec.where) return {to, predicate: {where: {[property.name]: {contains: capabilityValue(capability, operand.value)}}}}
  const day = codec.where.storage === 'iso-date' ? dayBounds(operand.value, utcDayStart) : undefined
  const comparison = day ? dayRange(op, day, isoOf) : operatorValue(op, capabilityValue(capability, operand.value))
  return {to, predicate: {where: {[property.name]: target ? {target: {[target.name]: comparison}} : comparison}}}
}

const placementOf = (term: AlternativeTerm, options: ParseOptions): Placement => {
  switch (term.kind) {
    case 'types': return {to: term.negated ? 'exclude' : 'match', predicate: {types: term.types.map(type => type.id)}}
    case 'compare': return compareTerm(term)
    case 'presence': return {to: 'match', predicate: {where: {[term.property.name]: {exists: term.present}}}}
    case 'field': {
      const to = term.op === 'ne' ? 'exclude' : 'match'
      if (term.encoded !== undefined) return {to, predicate: {where: {[term.field]: operatorValue(term.op, term.encoded)}}}
      const day = dayBounds(term.operand, options.localDayStart ?? defaultLocalDayStart)
      const where = day ? dayRange(term.op, day, ms => ms) : operatorValue(term.op, Date.parse(term.operand))
      return {to, predicate: {where: {[term.field]: where}}}
    }
    case 'refs': return {to: 'match', predicate: {referencedBy: {id: term.target.id}}}
    case 'under': return {to: 'match', predicate: {scope: 'ancestor', id: term.target.id}}
  }
}

/** Does this term narrow the candidates enough to bound an ancestor walk? */
const bounds = (term: QueryTerm): boolean => {
  switch (term.kind) {
    case 'types': return !term.negated
    case 'compare': return term.op !== 'ne'
    case 'presence': return term.present
    case 'refs': case 'childof': return true
    case 'field': case 'under': return false
    case 'anyOf': return term.alternatives.every(bounds)
  }
}

const hasUnder = (term: QueryTerm): boolean =>
  term.kind === 'under' || (term.kind === 'anyOf' && term.alternatives.some(hasUnder))

const readType = (reader: Reader, negated: boolean, start: number): QueryTerm => {
  reader.i++
  const label = reader.name()
  const id = reader.savedId()
  if (!label && id === undefined) reader.fail(start, 'Expected a type name after #')
  const type = id !== undefined ? reader.resolver.typeById(id) : reader.resolver.typeByLabel(label)
  if (!type) return reader.fail(start, id !== undefined ? `No type with id ${id}` : `No type named ${label}`)
  return {kind: 'types', negated, types: [type], start, end: reader.i}
}

const readTarget = (reader: Reader, key: string, start: number): RefOperand => {
  const target = reader.reference()
  if (!target) return reader.fail(start, `${key}= takes [[page]] or ((block id))`, reader.i + reader.bareWord().length)
  return target
}

const readStructural = (reader: Reader, key: ReservedKey, negated: boolean, op: CompareOp | undefined, start: number): QueryTerm => {
  if (negated) reader.fail(start, `${key}= cannot be negated`)
  if (op !== 'eq') reader.fail(start, `${key} takes =`)
  if (key === 'childof' && reader.startsWith('self') && TERM_END.test(reader.peek(4) || ' ')) {
    reader.i += 4
    const {selfId} = reader.options
    if (!selfId) return reader.fail(start, 'childof=self needs a table to belong to')
    return {kind: 'childof', target: {kind: 'ref', id: selfId, spelling: 'self'}, start, end: reader.i}
  }
  const target = readTarget(reader, key, start)
  return key === 'childof' ? {kind: key, target, start, end: reader.i} : {kind: key, target, start, end: reader.i}
}

/** The operand a value field's encoder takes: the text, or failing that its number. */
const fieldValue = (encode: (operand: unknown) => unknown, text: string): string | number | undefined => {
  if (encodes(encode, text)) return text
  return NUMBER.test(text) && Number.isFinite(Number(text)) && encodes(encode, Number(text)) ? Number(text) : undefined
}

const readFieldTerm = (reader: Reader, name: string, field: QueryField, op: CompareOp, start: number): QueryTerm => {
  const operandStart = reader.i
  if (field.kind === 'instant') {
    const text = reader.bareWord()
    if (!calendarDay(text) && !isInstant(text)) reader.fail(operandStart, `${name} takes a date like 2026-01-31 or an ISO instant`)
    return {kind: 'field', field: name, op, operand: text, start, end: reader.i}
  }
  const text = reader.name()
  if (reader.i === operandStart) reader.fail(start, `Expected a value after ${OP_TEXT[op]}`)
  const encoded = fieldValue(field.encode, text)
  if (encoded === undefined) reader.fail(operandStart, `"${text}" is not a value of ${name}`)
  return {kind: 'field', field: name, op, operand: text, encoded, start, end: reader.i}
}

const readCompare = (reader: Reader, property: QueryProperty, op: CompareOp, start: number): QueryTerm => {
  const operandStart = reader.i
  const {codec: propertyCodec} = property.schema
  const equality = op === 'eq' || op === 'ne'
  const reference = isRefCodec(propertyCodec) || isRefListCodec(propertyCodec)
  const identity = equality && (reader.peek() === '[' || reader.startsWith('(('))
  const inner = reference && !identity ? reader.resolver.refValueTarget(property.schema) : undefined
  const target = inner && isComparable(inner) ? inner : undefined
  if (reference && !target) {
    if (equality) {
      return {kind: 'compare', property, op, operand: readTarget(reader, property.name, operandStart), start, end: reader.i}
    }
    reader.fail(start, `${property.name} is a reference; compare it with = or !=`)
  }
  const schema = target ?? property.schema
  const {codec} = schema
  if (!target && (reader.startsWith('[[') || reader.startsWith('(('))) {
    reader.fail(operandStart, `${property.name} is not a reference property; quote the text to compare it`, reader.i + 2)
  }
  const value = reader.name()
  if (reader.i === operandStart) reader.fail(start, `Expected a value after ${OP_TEXT[op]}`)
  const capability = operandCapability(schema)
  if (!capability) reader.fail(start, `${property.name} can only be tested for presence: ${property.name} or !${property.name}`)
  if (!codec.where && !equality) reader.fail(start, `${property.name} is a list; test a member with = or !=`)
  if (!equality && !reference && !isComparable(schema)) reader.fail(start, `${property.name} compares with = or != only`)
  if (capabilityValue(capability, value) === undefined) reader.fail(operandStart, operandProblem(property.name, schema, value))
  return {kind: 'compare', property, op, operand: {kind: 'text', value}, ...(target && {target}), start, end: reader.i}
}

/** The engine keys a property term by name, so a name that is both a property's
 *  and a field's cannot be queried, however the property is addressed. */
export const isPropertyAndField = (resolver: QueryResolver, name: string): boolean =>
  resolver.field(name) !== undefined && resolver.propertyByName(name) !== undefined

const readKeyed = (reader: Reader, negated: boolean, start: number): QueryTerm => {
  const quotedName = reader.peek() === '"'
  const name = reader.name()
  const savedId = reader.savedId()
  if (!name && savedId === undefined) reader.fail(start, `Unexpected ${JSON.stringify(reader.peek())}`, start + 1)
  if (!reader.done && !/[\s|()=<>!]/.test(reader.peek())) {
    reader.fail(start, `Unexpected ${JSON.stringify(reader.peek())} in a name`, reader.i + 1)
  }
  const keyEnd = reader.i
  const op = reader.operator()

  if (savedId === undefined && !quotedName && isReservedKey(name)) return readStructural(reader, name, negated, op, start)

  const {resolver} = reader
  const property = savedId !== undefined ? resolver.propertyById(savedId) : resolver.propertyByName(name)
  const field = savedId === undefined ? resolver.field(name) : undefined
  if (property && isPropertyAndField(resolver, property.name)) {
    reader.fail(start, `${property.name} is both a property and a field; rename the property to query it`, keyEnd)
  }
  if (field) {
    if (op === undefined) {
      reader.fail(start, field.kind === 'instant'
        ? `${name} is always set; compare it, as in ${name}>2026-01-01`
        : `${name} is a field; compare it with a value, as in ${name}=x`, keyEnd)
    }
    if (negated) reader.fail(start, 'Write != instead of a leading !')
    return readFieldTerm(reader, name, field, op, start)
  }
  if (!property) {
    return reader.fail(start, savedId !== undefined ? `No property with id ${savedId}` : `No property or field named ${name}`, keyEnd)
  }
  if (op === undefined) return {kind: 'presence', property, present: !negated, start, end: reader.i}
  if (negated) reader.fail(start, 'Write != instead of a leading !')
  return readCompare(reader, property, op, start)
}

/** A quoted string with no key after it is a text search. */
const isTextSearch = (reader: Reader): boolean => {
  if (reader.peek() !== '"') return false
  const close = closingQuote(reader.text, reader.i)
  return close >= 0 && !/[\^=!<>]/.test(reader.text[close + 1] ?? '')
}

const readTerm = (reader: Reader): QueryTerm => {
  const start = reader.i
  const negated = reader.peek() === '!' && reader.peek(1) !== '='
  if (negated) reader.i++
  if (reader.peek() === '#') return readType(reader, negated, start)
  if (isTextSearch(reader)) {
    reader.quoted()
    reader.fail(start, 'Text search is not supported yet')
  }
  return readKeyed(reader, negated, start)
}

/** Positive type terms or'd together are one type term. */
const mergeTypeAlternatives = (alternatives: readonly QueryTerm[], start: number, end: number): QueryTerm | undefined => {
  const types: QueryType[] = []
  for (const term of alternatives) {
    if (term.kind !== 'types' || term.negated) return undefined
    types.push(...term.types)
  }
  return {kind: 'types', negated: false, types, start, end}
}

const isAlternative = (term: QueryTerm): term is AlternativeTerm => {
  switch (term.kind) {
    case 'types': return !term.negated
    case 'compare': case 'field': return term.op !== 'ne'
    case 'presence': case 'refs': case 'under': return true
    case 'childof': case 'anyOf': return false
  }
}

/** Reads one item: a term, or `a | b | …`, optionally in parentheses. Errors
 *  inside are collected; the item is undefined if it has nothing usable. */
const readItem = (reader: Reader, errors: QueryTermError[]): QueryTerm | undefined => {
  const start = reader.i
  const parenthesized = reader.peek() === '('
  if (parenthesized) reader.i++
  const alternatives: QueryTerm[] = []
  let failed = false
  for (;;) {
    reader.skipSpace()
    const termStart = reader.i
    try {
      if (reader.peek() === '(') reader.fail(termStart, 'Groups do not nest', termStart + 1)
      if (reader.done || reader.peek() === ')' || reader.peek() === '|') reader.fail(termStart, 'Expected a term', termStart + 1)
      alternatives.push(readTerm(reader))
      if (!reader.done && !TERM_END.test(reader.peek())) {
        reader.fail(reader.i, `Unexpected ${JSON.stringify(reader.peek())}`, reader.i + 1)
      }
    } catch (error) {
      if (!(error instanceof TermError)) throw error
      errors.push({start: error.start, end: error.end, message: error.message})
      failed = true
      reader.recover(termStart)
    }
    const beforeSpace = reader.i
    reader.skipSpace()
    if (reader.peek() === '|') { reader.i++; continue }
    if (parenthesized) {
      if (reader.peek() === ')') { reader.i++; break }
      if (reader.done) { errors.push({start, end: start + 1, message: 'Unclosed ('}); failed = true; break }
      // Terms side by side inside a group would mean AND inside OR, which one group cannot hold.
      errors.push({start: reader.i, end: reader.i + 1, message: 'Join the terms of a group with |'})
      failed = true
      continue
    }
    reader.i = beforeSpace
    break
  }
  const end = reader.i
  if (failed) return undefined
  if (alternatives.length === 1) return alternatives[0]
  const types = mergeTypeAlternatives(alternatives, start, end)
  if (types) return types
  const unsupported = alternatives.find(term => !isAlternative(term))
  if (unsupported) {
    errors.push({start: unsupported.start, end: unsupported.end, message: 'A negated or childof term cannot be one side of |'})
    return undefined
  }
  return {kind: 'anyOf', alternatives: alternatives.filter(isAlternative), start, end}
}

const UNBOUNDED_UNDER = 'under= needs another term that narrows the rows, such as a #type or a property value'

/** The terms one query can hold: one `childof=`, one `|` group, and `under=`
 *  only beside a term that bounds it, counted among the terms that stay. */
const survivors = (terms: readonly QueryTerm[], errors: QueryTermError[]): QueryTerm[] => {
  const kept: QueryTerm[] = []
  let parent = false
  let group = false
  for (const term of terms) {
    if (term.kind === 'childof' && parent) { errors.push({...term, message: 'Only one childof= per query'}); continue }
    if (term.kind === 'anyOf' && group) { errors.push({...term, message: 'Only one | group per query'}); continue }
    parent ||= term.kind === 'childof'
    group ||= term.kind === 'anyOf'
    kept.push(term)
  }
  if (kept.some(bounds)) return kept
  return kept.filter(term => {
    if (!hasUnder(term)) return true
    errors.push({...term, message: UNBOUNDED_UNDER})
    return false
  })
}

const compile = (terms: readonly QueryTerm[], options: ParseOptions): QueryClauses => {
  let types: string[] | undefined
  let parentId: string | undefined
  let anyOf: BlockPredicate[] | undefined
  const match: BlockPredicate[] = []
  const exclude: BlockPredicate[] = []
  for (const term of terms) {
    if (term.kind === 'childof') parentId = term.target.id
    else if (term.kind === 'anyOf') anyOf = term.alternatives.map(alternative => placementOf(alternative, options).predicate)
    else if (term.kind === 'types' && !term.negated && types === undefined) types = term.types.map(type => type.id)
    else {
      const {to, predicate} = placementOf(term, options)
      ;(to === 'match' ? match : exclude).push(predicate)
    }
  }
  return {
    ...(types ? {types} : {}),
    ...(parentId !== undefined ? {parentId} : {}),
    ...(match.length ? {match} : {}),
    ...(anyOf ? {anyOf} : {}),
    ...(exclude.length ? {exclude} : {}),
  }
}

export const parseQuery = (text: string, resolver: QueryResolver, options: ParseOptions = {}): ParsedQuery => {
  const reader = new Reader(text, resolver, options)
  const errors: QueryTermError[] = []
  const terms: QueryTerm[] = []
  for (;;) {
    reader.skipSpace()
    if (reader.done) break
    if (reader.peek() === ')' || reader.peek() === '|') {
      errors.push({start: reader.i, end: reader.i + 1, message: `Unexpected ${reader.peek()}`})
      reader.i++
      continue
    }
    const item = readItem(reader, errors)
    if (item) terms.push(item)
  }
  const kept = survivors(terms, errors)
  errors.sort((a, b) => a.start - b.start || a.end - b.end)
  return {query: compile(kept, options), errors, terms: kept}
}
