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
 *    status!=open                            not equal (an unset value matches)
 *    snooze  !snooze                         property set / unset
 *    assignee=[[Mary]]  owner=((id))         a reference property pointing at a block
 *    refs=[[Mary]]                           references the block through any field
 *    childof=self  childof=[[X]]  under=[[X]] direct parent / ancestor
 *    created>2026-01-01                      a queryable field; a date means the local day
 *    status=open | priority>=3               one or-group
 *
 *  Names are bare for hand and agent writing; `name^fieldId` (and `#label^typeId`)
 *  is the saved form, the id authoritative and the name decoration. */
import { isRefCodec, isRefListCodec, type AnyPropertySchema, type BlockPredicate, type TypedBlockQuery } from '@/data/api'

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
  typeByLabel(label: string): QueryType | undefined
  typeById(id: string): QueryType | undefined
  /** A queryable field (`created`, `updated`, a plugin's). */
  isField(name: string): boolean
  blockIdByAlias(alias: string): string | undefined
}

export interface ParseOptions {
  /** The block `childof=self` names. */
  readonly selfId?: string
  /** Epoch ms of local midnight starting the given calendar day (month 1-12),
   *  for date-only operands on fields. Defaults to this runtime's time zone. */
  readonly localDayStart?: (year: number, month: number, day: number) => number
}

export interface QueryTermError {
  readonly start: number
  readonly end: number
  readonly message: string
}

export type QueryClauses = Pick<TypedBlockQuery, 'types' | 'parentId' | 'match' | 'anyOf' | 'exclude'>

export type CompareOp = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'

export type Operand =
  | {readonly kind: 'text'; readonly value: string}
  | {readonly kind: 'ref'; readonly id: string; readonly spelling: string}

interface Span { readonly start: number; readonly end: number }

export type QueryTerm = Span & (
  | {readonly kind: 'types'; readonly negated: boolean; readonly types: readonly QueryType[]}
  | {readonly kind: 'compare'; readonly property: QueryProperty; readonly op: CompareOp; readonly operand: Operand}
  | {readonly kind: 'presence'; readonly property: QueryProperty; readonly present: boolean}
  | {readonly kind: 'field'; readonly field: string; readonly op: CompareOp; readonly operand: string}
  | {readonly kind: 'refs'; readonly target: Operand & {kind: 'ref'}}
  | {readonly kind: 'childof'; readonly target: 'self' | (Operand & {kind: 'ref'})}
  | {readonly kind: 'under'; readonly target: Operand & {kind: 'ref'}}
  | {readonly kind: 'anyOf'; readonly alternatives: readonly QueryTerm[]}
)

export interface ParsedQuery {
  readonly query: QueryClauses
  readonly errors: readonly QueryTermError[]
  /** The terms that compiled, in text order. */
  readonly terms: readonly QueryTerm[]
}

/** Keys that are structure, not properties. Address a property with one of
 *  these names through its saved form, `under^fieldId`. */
export const RESERVED_KEYS = ['refs', 'childof', 'under'] as const

const OPS: ReadonlyArray<readonly [string, CompareOp]> = [
  ['!=', 'ne'], ['<=', 'lte'], ['>=', 'gte'], ['=', 'eq'], ['<', 'lt'], ['>', 'gt'],
]
export const OP_TEXT: Readonly<Record<CompareOp, string>> = {eq: '=', ne: '!=', lt: '<', lte: '<=', gt: '>', gte: '>='}

/** Characters that end a bare word. */
const BREAK = /[\s"|()!=<>#^[\]]/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i

class TermError extends Error {
  constructor(readonly start: number, readonly end: number, message: string) { super(message) }
}

/** A cursor over the text. Every read method throws {@link TermError} with the
 *  span it was reading, and the caller skips to the end of the term. */
class Reader {
  i = 0
  constructor(readonly text: string) {}
  get done() { return this.i >= this.text.length }
  peek(n = 0) { return this.text[this.i + n] ?? '' }
  startsWith(s: string) { return this.text.startsWith(s, this.i) }
  skipSpace() { while (!this.done && /\s/.test(this.peek())) this.i++ }
  fail(start: number, message: string, end = this.i): never {
    throw new TermError(start, Math.min(Math.max(end, start + 1), this.text.length), message)
  }

  bareWord(): string {
    const start = this.i
    while (!this.done && !BREAK.test(this.peek())) this.i++
    return this.text.slice(start, this.i)
  }

  /** `"…"` with `\"` and `\\` escapes. */
  quoted(): string {
    const start = this.i
    this.i++
    let value = ''
    while (!this.done) {
      const ch = this.peek()
      if (ch === '"') { this.i++; return value }
      if (ch === '\\' && (this.peek(1) === '"' || this.peek(1) === '\\')) { value += this.peek(1); this.i += 2; continue }
      value += ch
      this.i++
    }
    return this.fail(start, 'Unclosed quote')
  }

  name(): string {
    if (this.peek() === '"') return this.quoted()
    return this.bareWord()
  }

  /** `^id` after a name, if present. */
  savedId(): string | undefined {
    if (this.peek() !== '^') return undefined
    this.i++
    const id = this.bareWord()
    if (!id) this.fail(this.i - 1, 'Expected an id after ^')
    return id
  }

  /** `[[alias]]`, `((id))` or `[label](((id)))`, or undefined if none starts here. */
  reference(resolver: QueryResolver): (Operand & {kind: 'ref'}) | undefined {
    const start = this.i
    if (this.startsWith('[[')) {
      const close = this.text.indexOf(']]', this.i + 2)
      if (close < 0) this.fail(start, 'Unclosed [[', this.text.length)
      this.i = close + 2
      const alias = this.text.slice(start + 2, close)
      const id = resolver.blockIdByAlias(alias)
      if (!id) this.fail(start, `No page named [[${alias}]]`)
      return {kind: 'ref', id, spelling: this.text.slice(start, this.i)}
    }
    const labelled = /^\[[^\]\n]*\]\(\(\(([0-9a-f-]{36})\)\)\)/i.exec(this.text.slice(this.i))
    const plain = /^\(\(([0-9a-f-]{36})\)\)/i.exec(this.text.slice(this.i))
    const match = labelled ?? plain
    if (!match) {
      if (this.startsWith('((') || this.startsWith('[')) this.fail(start, 'Expected [[page]] or ((block id))', this.i + 2)
      return undefined
    }
    if (!UUID.test(match[1])) this.fail(start, 'Not a block id', this.i + match[0].length)
    this.i += match[0].length
    return {kind: 'ref', id: match[1].toLowerCase(), spelling: match[0]}
  }

  operator(): CompareOp | undefined {
    for (const [text, op] of OPS) {
      if (this.startsWith(text)) { this.i += text.length; return op }
    }
    return undefined
  }
}

const isComparable = (schema: AnyPropertySchema) => {
  const storage = schema.codec.where?.storage
  return storage === 'number' || storage === 'iso-date'
}

const encodes = (encode: ((value: never) => unknown) | undefined, value: unknown): boolean => {
  try {
    encode?.(value as never)
    return encode !== undefined
  } catch {
    return false
  }
}

const describeOptions = (schema: AnyPropertySchema): string => {
  const options = (schema.codec as {options?: readonly {value: string}[]}).options
  return options ? `: one of ${options.map(option => option.value).join(', ')}` : ''
}

/** A scalar operand as the codec's `where` takes it, or an error message. */
const scalarOperand = (property: QueryProperty, text: string): {value: unknown} | {error: string} => {
  const {schema} = property
  const storage = schema.codec.where?.storage
  if (storage === 'number') {
    const value = Number(text)
    return NUMBER.test(text) && Number.isFinite(value) ? {value} : {error: `${property.name} takes a number`}
  }
  if (storage === 'boolean') {
    return text === 'true' || text === 'false' ? {value: text === 'true'} : {error: `${property.name} takes true or false`}
  }
  if (storage === 'iso-date') {
    return calendarDay(text) || isInstant(text)
      ? {value: new Date(text).toISOString()}
      : {error: `${property.name} takes a date like 2026-01-31 or an ISO instant`}
  }
  return encodes(schema.codec.where!.encode, text) ? {value: text} : {error: `"${text}" is not a value of ${property.name}${describeOptions(schema)}`}
}

const defaultLocalDayStart = (year: number, month: number, day: number) => new Date(year, month - 1, day).getTime()
const utcDayStart = (year: number, month: number, day: number) => Date.UTC(year, month - 1, day)

/** A day as a range of instants: `=` is the whole day, `<=` ends at the next
 *  midnight, `>` starts there. `ne` is `eq`'s range, negated by the caller. */
const dayRange = <T>(op: CompareOp, start: number, next: number, encode: (ms: number) => T): Record<string, unknown> => {
  switch (op) {
    case 'eq': case 'ne': return {between: [encode(start), encode(next - 1)]}
    case 'lt': return {lt: encode(start)}
    case 'lte': return {lt: encode(next)}
    case 'gt': return {gte: encode(next)}
    case 'gte': return {gte: encode(start)}
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

/** The day's first instant and the next day's, by `dayStart`'s clock. */
const dayBounds = (text: string, dayStart: (y: number, m: number, d: number) => number): [number, number] | undefined => {
  const day = calendarDay(text)
  return day && [dayStart(...day), dayStart(day[0], day[1], day[2] + 1)]
}

const isInstant = (text: string) => {
  const ms = Date.parse(text)
  return Number.isFinite(ms) && new Date(ms).toISOString() === text
}

const operatorValue = (op: CompareOp, value: unknown): Record<string, unknown> =>
  op === 'ne' ? {eq: value} : {[op]: value}

/** The predicate a positive or negated term contributes, and where it goes. */
type Placement = {to: 'match' | 'exclude'; predicate: BlockPredicate}

const compareTerm = (term: QueryTerm & {kind: 'compare'}): Placement => {
  const {property, op, operand} = term
  const to = op === 'ne' ? 'exclude' : 'match'
  if (operand.kind === 'ref') return {to, predicate: {referencedBy: {id: operand.id, sourceField: property.name}}}
  const {codec} = property.schema
  if (!codec.where && codec.contains) return {to, predicate: {where: {[property.name]: {contains: operand.value}}}}
  if (codec.where?.storage === 'iso-date') {
    const bounds = dayBounds(operand.value, utcDayStart)
    if (bounds) return {to, predicate: {where: {[property.name]: dayRange(op, bounds[0], bounds[1], ms => new Date(ms).toISOString())}}}
  }
  const scalar = scalarOperand(property, operand.value) as {value: unknown}
  return {to, predicate: {where: {[property.name]: operatorValue(op, scalar.value)}}}
}

const placementOf = (term: QueryTerm, options: ParseOptions): Placement => {
  switch (term.kind) {
    case 'types': return {to: term.negated ? 'exclude' : 'match', predicate: {types: term.types.map(type => type.id)}}
    case 'compare': return compareTerm(term)
    case 'presence': return {to: 'match', predicate: {where: {[term.property.name]: {exists: term.present}}}}
    case 'field': {
      const bounds = dayBounds(term.operand, options.localDayStart ?? defaultLocalDayStart)
      const where = bounds
        ? dayRange(term.op, bounds[0], bounds[1], ms => ms)
        : operatorValue(term.op, Date.parse(term.operand))
      return {to: term.op === 'ne' ? 'exclude' : 'match', predicate: {where: {[term.field]: where}}}
    }
    case 'refs': return {to: 'match', predicate: {referencedBy: {id: term.target.id}}}
    case 'under': return {to: 'match', predicate: {scope: 'ancestor', id: term.target.id}}
    case 'childof': case 'anyOf': throw new Error(`${term.kind} has no single predicate`)
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

interface TermParser {
  reader: Reader
  resolver: QueryResolver
  options: ParseOptions
}

const readType = ({reader, resolver}: TermParser, negated: boolean, start: number): QueryTerm => {
  reader.i++
  const label = reader.name()
  const id = reader.savedId()
  if (!label && !id) reader.fail(start, 'Expected a type name after #')
  const type = id !== undefined ? resolver.typeById(id) : resolver.typeByLabel(label)
  if (!type) return reader.fail(start, id !== undefined ? `No type with id ${id}` : `No type named ${label}`)
  return {kind: 'types', negated, types: [type], start, end: reader.i}
}

const readTarget = (parser: TermParser, key: string, start: number) => {
  const target = parser.reader.reference(parser.resolver)
  if (!target) parser.reader.fail(start, `${key}= takes [[page]] or ((block id))`, parser.reader.i + parser.reader.bareWord().length)
  return target
}

const readKeyed = (parser: TermParser, negated: boolean, start: number): QueryTerm => {
  const {reader, resolver} = parser
  const quotedName = reader.peek() === '"'
  const name = reader.name()
  const savedId = reader.savedId()
  if (!name && savedId === undefined) reader.fail(start, `Unexpected ${JSON.stringify(reader.peek())}`, start + 1)
  if (name && !quotedName && savedId === undefined && !reader.done && !/[\s|()=<>!]/.test(reader.peek())) {
    reader.fail(start, `Unexpected ${JSON.stringify(reader.peek())} in a name`, reader.i + 1)
  }
  const keyEnd = reader.i
  const op = reader.operator()

  if (savedId === undefined && (RESERVED_KEYS as readonly string[]).includes(name) && !quotedName) {
    if (negated) reader.fail(start, `${name}= cannot be negated`)
    if (op !== 'eq') reader.fail(start, `${name} takes =`)
    if (name === 'childof' && reader.startsWith('self') && !/[^\s|()]/.test(reader.peek(4) || ' ')) {
      reader.i += 4
      if (!parser.options.selfId) reader.fail(start, 'childof=self needs a table to belong to')
      return {kind: 'childof', target: 'self', start, end: reader.i}
    }
    const target = readTarget(parser, name, start)
    return {kind: name as 'refs' | 'childof' | 'under', target, start, end: reader.i} as QueryTerm
  }

  const property = savedId !== undefined ? resolver.propertyById(savedId) : resolver.propertyByName(name)
  const field = savedId === undefined && resolver.isField(name)
  if (property && field) reader.fail(start, `${name} is both a property and a field; write ${name}^<field id>`, keyEnd)
  if (!property && !field) {
    reader.fail(start, savedId !== undefined ? `No property with id ${savedId}` : `No property or field named ${name}`, keyEnd)
  }

  if (op === undefined) {
    if (field) reader.fail(start, `${name} is always set; compare it, as in ${name}>2026-01-01`, keyEnd)
    return {kind: 'presence', property: property!, present: !negated, start, end: reader.i}
  }
  if (negated) reader.fail(start, 'Write != instead of a leading !')
  const operandStart = reader.i

  if (field) {
    const text = reader.bareWord()
    if (!calendarDay(text) && !isInstant(text)) reader.fail(operandStart, `${name} takes a date like 2026-01-31 or an ISO instant`)
    return {kind: 'field', field: name, op, operand: text, start, end: reader.i}
  }

  const prop = property!
  const {codec} = prop.schema
  if (isRefCodec(codec) || isRefListCodec(codec)) {
    if (op !== 'eq' && op !== 'ne') reader.fail(start, `${prop.name} is a reference; compare it with = or !=`, reader.i)
    const target = readTarget(parser, prop.name, operandStart)
    return {kind: 'compare', property: prop, op, operand: target, start, end: reader.i}
  }
  if (reader.startsWith('[[') || reader.startsWith('((')) {
    reader.fail(operandStart, `${prop.name} is not a reference property; quote the text to compare it`, reader.i + 2)
  }
  const value = reader.peek() === '"' ? reader.quoted() : reader.bareWord()
  if (reader.i === operandStart) reader.fail(start, `Expected a value after ${OP_TEXT[op]}`)

  if (!codec.where && !codec.contains) reader.fail(start, `${prop.name} can only be tested for presence: ${prop.name} or !${prop.name}`)
  if (!codec.where) {
    if (op !== 'eq' && op !== 'ne') reader.fail(start, `${prop.name} is a list; test a member with = or !=`)
    if (!encodes(codec.contains!.encode, value)) reader.fail(operandStart, `"${value}" is not a member value of ${prop.name}`)
  } else {
    if (op !== 'eq' && op !== 'ne' && !isComparable(prop.schema)) {
      reader.fail(start, `${prop.name} compares with = or != only`)
    }
    const scalar = scalarOperand(prop, value)
    if ('error' in scalar) reader.fail(operandStart, scalar.error)
  }
  return {kind: 'compare', property: prop, op, operand: {kind: 'text', value}, start, end: reader.i}
}

const readTerm = (parser: TermParser): QueryTerm => {
  const {reader} = parser
  const start = reader.i
  const negated = reader.peek() === '!' && reader.peek(1) !== '='
  if (negated) reader.i++
  if (reader.peek() === '#') return readType(parser, negated, start)
  if (reader.peek() === '"') {
    const save = reader.i
    reader.quoted()
    const next = reader.peek()
    reader.i = save
    if (next !== '^' && next !== '=' && next !== '!' && next !== '<' && next !== '>') {
      reader.quoted()
      reader.fail(start, 'Text search is not supported yet')
    }
  }
  return readKeyed(parser, negated, start)
}

/** Skip the rest of a term that failed, so the next term starts clean. */
const skipTerm = (reader: Reader) => {
  while (!reader.done && !/[\s|()]/.test(reader.peek())) {
    if (reader.peek() === '"') {
      try { reader.quoted() } catch { reader.i = reader.text.length }
    } else reader.i++
  }
}

/** Positive type terms or'd together are one type term. */
const mergeTypeAlternatives = (alternatives: readonly QueryTerm[], start: number, end: number): QueryTerm | undefined => {
  if (!alternatives.every(term => term.kind === 'types' && !term.negated)) return undefined
  const types = alternatives.flatMap(term => (term as QueryTerm & {kind: 'types'}).types)
  return {kind: 'types', negated: false, types, start, end}
}

const ALTERNATIVE_KINDS = new Set<QueryTerm['kind']>(['types', 'compare', 'presence', 'field', 'refs', 'under'])

/** Reads one item: a term, or `a | b | …`, optionally in parentheses. Errors
 *  inside are collected; the item is undefined if it has nothing usable. */
const readItem = (parser: TermParser, errors: QueryTermError[]): QueryTerm | undefined => {
  const {reader} = parser
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
      alternatives.push(readTerm(parser))
      if (!reader.done && !/[\s|()]/.test(reader.peek())) {
        reader.fail(reader.i, `Unexpected ${JSON.stringify(reader.peek())}`, reader.i + 1)
      }
    } catch (error) {
      if (!(error instanceof TermError)) throw error
      errors.push({start: error.start, end: error.end, message: error.message})
      failed = true
      if (reader.i === termStart) reader.i++
      skipTerm(reader)
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
  const unsupported = alternatives.find(term => !ALTERNATIVE_KINDS.has(term.kind) ||
    (term.kind === 'types' && term.negated) || ((term.kind === 'compare' || term.kind === 'field') && term.op === 'ne'))
  if (unsupported) {
    errors.push({start: unsupported.start, end: unsupported.end, message: 'A negated or childof term cannot be one side of |'})
    return undefined
  }
  return {kind: 'anyOf', alternatives, start, end}
}

const compile = (terms: readonly QueryTerm[], options: ParseOptions, errors: QueryTermError[]): {query: QueryClauses; kept: QueryTerm[]} => {
  let types: string[] | undefined
  let parentId: string | undefined
  let anyOf: BlockPredicate[] | undefined
  const match: BlockPredicate[] = []
  const exclude: BlockPredicate[] = []
  const kept: QueryTerm[] = []
  for (const term of terms) {
    if (term.kind === 'childof') {
      if (parentId !== undefined) { errors.push({...term, message: 'Only one childof= per query'}); continue }
      parentId = term.target === 'self' ? options.selfId! : term.target.id
    } else if (term.kind === 'anyOf') {
      if (anyOf) { errors.push({...term, message: 'Only one | group per query'}); continue }
      anyOf = term.alternatives.map(alternative => placementOf(alternative, options).predicate)
    } else if (term.kind === 'types' && !term.negated && types === undefined) {
      types = term.types.map(type => type.id)
    } else {
      const {to, predicate} = placementOf(term, options)
      ;(to === 'match' ? match : exclude).push(predicate)
    }
    kept.push(term)
  }
  const unbounded = kept.find(term => term.kind === 'under' ||
    (term.kind === 'anyOf' && term.alternatives.some(alternative => alternative.kind === 'under')))
  if (unbounded && !kept.some(bounds)) {
    errors.push({...unbounded, message: 'under= needs another term that narrows the rows, such as a #type or a property value'})
    return compile(kept.filter(term => term !== unbounded), options, errors)
  }
  return {
    query: {
      ...(types ? {types} : {}),
      ...(parentId !== undefined ? {parentId} : {}),
      ...(match.length ? {match} : {}),
      ...(anyOf ? {anyOf} : {}),
      ...(exclude.length ? {exclude} : {}),
    },
    kept,
  }
}

export const parseQuery = (text: string, resolver: QueryResolver, options: ParseOptions = {}): ParsedQuery => {
  const reader = new Reader(text)
  const parser: TermParser = {reader, resolver, options}
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
    const item = readItem(parser, errors)
    if (item) terms.push(item)
  }
  const {query, kept} = compile(terms, options, errors)
  errors.sort((a, b) => a.start - b.start || a.end - b.end)
  return {query, errors, terms: kept}
}
