import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'
import { formatQuery } from '../query/format'
import { parseQuery, type CompareOp, type QueryProperty, type QueryTerm } from '../query/parse'
import { ALIASES, PROPERTIES, TYPES, localDayStart, resolver } from './queryFixtures'

const SELF = '0190a0c0-0000-7000-8000-00000000000c'
const options = {selfId: SELF, localDayStart}
const parse = (text: string) => parseQuery(text, resolver, options)

type Unspanned = QueryTerm extends infer T ? T extends unknown ? Omit<T, 'start' | 'end'> : never : never

const withoutSpans = (term: QueryTerm): Unspanned => {
  const rest: Record<string, unknown> = {...term}
  delete rest.start
  delete rest.end
  if (term.kind === 'anyOf') rest.alternatives = term.alternatives.map(withoutSpans)
  return rest as Unspanned
}

const prop = (name: string) => PROPERTIES.find(p => p.name === name)!
const EQUALITY: readonly CompareOp[] = ['eq', 'ne']
const ORDERED: readonly CompareOp[] = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte']

const dateOnly = fc.date({min: new Date('1900-01-01T00:00:00Z'), max: new Date('2999-12-31T00:00:00Z'), noInvalidDate: true})
  .map(date => date.toISOString().slice(0, 10))
const instant = fc.date({min: new Date('1900-01-01T00:00:00Z'), max: new Date('2999-12-31T00:00:00Z'), noInvalidDate: true})
  .map(date => date.toISOString())
const reference = fc.constantFrom(...Object.entries(ALIASES).flatMap(([alias, id]) => [
  {kind: 'ref' as const, id, spelling: `[[${alias}]]`},
  {kind: 'ref' as const, id, spelling: `((${id}))`},
  {kind: 'ref' as const, id, spelling: `[label](((${id})))`},
]))
const text = (value: fc.Arbitrary<string>) => value.map(v => ({kind: 'text' as const, value: v}))

/** A compare term on a property, with an operator and operand its codec admits. */
const compareOn = (property: QueryProperty, ops: readonly CompareOp[], operand: fc.Arbitrary<QueryTerm & {kind: 'compare'} extends infer T ? T extends {operand: infer O} ? O : never : never>) =>
  fc.record({kind: fc.constant('compare' as const), property: fc.constant(property), op: fc.constantFrom(...ops), operand})

const compare = (ops: (all: readonly CompareOp[]) => readonly CompareOp[]) => fc.oneof(
  compareOn(prop('status'), ops(EQUALITY), text(fc.constantFrom('open', 'closed', 'two words'))),
  compareOn(prop('rating'), ops(ORDERED), text(fc.oneof(fc.integer(), fc.double({noNaN: true, noDefaultInfinity: true})).map(String))),
  compareOn(prop('label'), ops(EQUALITY), text(fc.string({maxLength: 8}))),
  compareOn(prop('due date'), ops(EQUALITY), text(fc.string({maxLength: 8}))),
  compareOn(prop('under'), ops(EQUALITY), text(fc.string({maxLength: 8}))),
  compareOn(prop('done'), ops(EQUALITY), text(fc.constantFrom('true', 'false'))),
  compareOn(prop('due'), ops(ORDERED), text(fc.oneof(dateOnly, instant))),
  compareOn(prop('tags'), ops(EQUALITY), text(fc.string({maxLength: 8}))),
  compareOn(prop('assignee'), ops(EQUALITY), reference),
  compareOn(prop('related'), ops(EQUALITY), reference),
)

const positive = (all: readonly CompareOp[]) => all.filter(op => op !== 'ne')
const presence = fc.record({kind: fc.constant('presence' as const), property: fc.constantFrom(...PROPERTIES), present: fc.boolean()})
const field = (ops: readonly CompareOp[]) => fc.record({
  kind: fc.constant('field' as const), field: fc.constantFrom('created', 'updated'), op: fc.constantFrom(...ops),
  operand: fc.oneof(dateOnly, instant),
})
const oneType = fc.constantFrom(...TYPES).map(type => [type])
const types = fc.record({kind: fc.constant('types' as const), negated: fc.constant(false), types: fc.uniqueArray(fc.constantFrom(...TYPES), {minLength: 1, maxLength: 3})})
const notType = fc.record({kind: fc.constant('types' as const), negated: fc.constant(true), types: oneType})
const refs = fc.record({kind: fc.constant('refs' as const), target: reference})
const under = fc.record({kind: fc.constant('under' as const), target: reference})
const childof = fc.record({kind: fc.constant('childof' as const), target: fc.oneof(fc.constant('self' as const), reference)})

const alternative = fc.oneof(
  fc.record({kind: fc.constant('types' as const), negated: fc.constant(false), types: oneType}),
  compare(positive), presence, field(positive(ORDERED)), refs, under,
)
const anyOf = fc.array(alternative, {minLength: 2, maxLength: 3})
  .filter(alternatives => !alternatives.every(term => term.kind === 'types'))
  .map(alternatives => ({kind: 'anyOf' as const, alternatives}))

const bounding = (term: Unspanned): boolean => term.kind === 'anyOf'
  ? term.alternatives.every(t => bounding(withoutSpans(t)))
  : term.kind === 'types' ? !term.negated
    : term.kind === 'compare' ? term.op !== 'ne'
      : term.kind === 'presence' ? term.present
        : term.kind === 'refs' || term.kind === 'childof'
const hasUnder = (term: Unspanned): boolean =>
  term.kind === 'under' || (term.kind === 'anyOf' && term.alternatives.some(t => t.kind === 'under'))

/** Terms one query can hold: one childof=, one | group, and a bound for under=. */
const terms = fc.tuple(
  fc.array(fc.oneof(types, notType, compare(all => all), presence, field(ORDERED), refs, under), {maxLength: 5}),
  fc.option(childof, {nil: undefined}),
  fc.option(anyOf, {nil: undefined}),
).map(([items, parent, group]) => [...items, ...(parent ? [parent] : []), ...(group ? [group] : [])] as Unspanned[])
  .filter(list => !list.some(hasUnder) || list.some(bounding))

const TOKENS = ['#', '!', '=', '!=', '<', '<=', '>', '>=', '|', '(', ')', '"', '\\', '[[', ']]', '((', '))', '^', ' ', '\n',
  'status', 'open', 'label', 'rating', '3', 'Mary', '[[Mary]]', '[[Nobody]]', 'created', '2026-01-01', 'Book', 'under',
  'childof', 'self', 'refs', 'f-status', 't-book', '0190a0c0-0000-7000-8000-00000000000a']
const noise = fc.array(fc.oneof(fc.constantFrom(...TOKENS), fc.string({maxLength: 3})), {maxLength: 20}).map(parts => parts.join(''))

describe('query parser', () => {
  it('never throws, and every error span lies inside the text', () => {
    fc.assert(fc.property(noise, input => {
      const {errors} = parse(input)
      for (const error of errors) {
        expect(error.start).toBeGreaterThanOrEqual(0)
        expect(error.start).toBeLessThanOrEqual(error.end)
        expect(error.end).toBeLessThanOrEqual(input.length)
        expect(error.message).not.toBe('')
      }
    }), fuzzParams(300))
  }, fuzzTestTimeout())

  it('reads the saved form back as the same terms', () => {
    fc.assert(fc.property(terms, generated => {
      const saved = formatQuery(generated as QueryTerm[])
      const parsed = parse(saved)
      expect(parsed.errors).toEqual([])
      expect(parsed.terms.map(withoutSpans)).toEqual(generated)
      expect(formatQuery(parsed.terms)).toBe(saved)
    }), fuzzParams(200))
  }, fuzzTestTimeout())

  it('gives every term of a saved query a span holding its own text', () => {
    fc.assert(fc.property(terms, generated => {
      const saved = formatQuery(generated as QueryTerm[])
      // under= alone needs a bound it no longer has, so it is checked in place only.
      for (const term of parse(saved).terms.filter(t => !hasUnder(withoutSpans(t)))) {
        expect(parse(saved.slice(term.start, term.end)).terms.map(withoutSpans)).toEqual([withoutSpans(term)])
      }
    }), fuzzParams(100))
  }, fuzzTestTimeout())
})
