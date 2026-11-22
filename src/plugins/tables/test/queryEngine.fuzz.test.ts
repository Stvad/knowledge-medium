// @vitest-environment node
/** Differential: a parsed query run by the engine returns exactly the blocks a
 *  plain model of its terms selects, over random blocks that include unset and
 *  wrongly shaped values, references, nesting and creation times either side of
 *  a local midnight. */
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { fuzzParams, fuzzTestTimeout, statefulFuzzGuard } from '@/test/fuzz'
import { formatQuery } from '../query/format'
import { parseQuery, type CompareOp, type QueryTerm } from '../query/parse'
import { DB_PROPERTIES, WS, createQueryRepo, dbResolver, writeBlocks, type RawBlock } from './queryDb'
import { MARY, PROJECTS, TYPES, localDayStart } from './queryFixtures'

const options = {localDayStart}
const prop = (name: string) => DB_PROPERTIES.find(p => p.name === name)!
const DAY = Date.parse('2026-01-05T00:00:00.000Z')
const HOUR = 3_600_000

// ---- blocks -------------------------------------------------------------

const maybe = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, {nil: undefined})
const instantNear = fc.integer({min: -30, max: 30}).map(hours => DAY + hours * HOUR)
const blockValues = fc.record({
  types: fc.subarray(TYPES.map(type => type.id)),
  status: maybe(fc.constantFrom<unknown>('open', 'closed', 'two words', 42)),
  rating: maybe(fc.constantFrom<unknown>(-2, 0, 1, 3, 'x')),
  label: maybe(fc.constantFrom<unknown>('', 'a', 'A', 'b c', true)),
  done: maybe(fc.constantFrom<unknown>(true, false, 'true')),
  due: maybe(fc.oneof(instantNear.map(ms => new Date(ms).toISOString() as unknown), fc.constant<unknown>('soon'))),
  tags: maybe(fc.constantFrom<unknown>([], ['a'], ['a', 'b'], 'a')),
  assignee: maybe(fc.constantFrom(MARY, PROJECTS)),
  related: maybe(fc.subarray([MARY, PROJECTS])),
  extraRef: fc.boolean(),
  createdAt: instantNear,
})
const blocks = fc.array(fc.tuple(blockValues, fc.nat()), {minLength: 1, maxLength: 8}).map(rows => {
  const out: RawBlock[] = [{id: PROJECTS}, {id: MARY}]
  rows.forEach(([values, parentPick], index) => {
    const parents = [null, PROJECTS, ...out.slice(2).map(block => block.id)]
    const properties: Record<string, unknown> = {}
    const references: {id: string; alias: string; sourceField?: string}[] = []
    for (const name of ['status', 'rating', 'label', 'done', 'due', 'tags'] as const) {
      if (values[name] !== undefined) properties[name] = values[name]
    }
    if (values.assignee !== undefined) {
      properties.assignee = values.assignee
      references.push({id: values.assignee, alias: values.assignee, sourceField: 'assignee'})
    }
    if (values.related !== undefined) {
      properties.related = values.related
      for (const id of values.related) references.push({id, alias: id, sourceField: 'related'})
    }
    if (values.extraRef) references.push({id: MARY, alias: 'Mary'})
    out.push({
      id: `b${index}`, parentId: parents[parentPick % parents.length], types: values.types,
      properties, references, createdAt: values.createdAt,
    })
  })
  return out
})

// ---- terms (saved form) --------------------------------------------------

const EQ: readonly CompareOp[] = ['eq', 'ne']
const ALL: readonly CompareOp[] = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte']
const dateText = fc.oneof(
  fc.constantFrom('2026-01-04', '2026-01-05', '2026-01-06'),
  instantNear.map(ms => new Date(ms).toISOString()),
)
const ref = fc.constantFrom(`[[Mary]]`, `((${PROJECTS}))`)
const op = (ops: readonly CompareOp[]) => fc.constantFrom(...ops)
const compare = (name: string, ops: readonly CompareOp[], operand: fc.Arbitrary<{kind: 'text'; value: string} | {kind: 'ref'; id: string; spelling: string}>) =>
  fc.record({kind: fc.constant('compare' as const), property: fc.constant(prop(name)), op: op(ops), operand})
const text = (...values: string[]) => fc.constantFrom(...values).map(value => ({kind: 'text' as const, value}))
const refOperand = ref.map(spelling => ({kind: 'ref' as const, id: spelling === '[[Mary]]' ? MARY : PROJECTS, spelling}))

const positiveOps = (ops: readonly CompareOp[]) => ops.filter(o => o !== 'ne')
const termOf = (ops: (all: readonly CompareOp[]) => readonly CompareOp[]) => fc.oneof(
  compare('status', ops(EQ), text('open', 'closed', 'two words')),
  compare('rating', ops(ALL), text('-2', '0', '1', '2', '3')),
  compare('label', ops(EQ), text('', 'a', 'A', 'b c')),
  compare('done', ops(EQ), text('true', 'false')),
  compare('due', ops(ALL), dateText.map(value => ({kind: 'text' as const, value}))),
  compare('tags', ops(EQ), text('a', 'b')),
  compare('assignee', ops(EQ), refOperand),
  compare('related', ops(EQ), refOperand),
  fc.record({kind: fc.constant('presence' as const), property: fc.constantFrom(...DB_PROPERTIES.slice(0, 8)), present: fc.boolean()}),
  fc.record({kind: fc.constant('field' as const), field: fc.constantFrom('created', 'updated'), op: op(ops(ALL)), operand: dateText}),
  fc.record({kind: fc.constant('types' as const), negated: fc.constant(false), types: fc.constantFrom(...TYPES).map(t => [t])}),
  fc.record({kind: fc.constant('refs' as const), target: refOperand}),
  fc.record({kind: fc.constant('under' as const), target: refOperand}),
)
const queryTerms = fc.tuple(
  fc.array(fc.oneof(
    termOf(all => all),
    fc.record({kind: fc.constant('types' as const), negated: fc.boolean(), types: fc.constantFrom(...TYPES).map(t => [t])}),
    fc.record({kind: fc.constant('childof' as const), target: refOperand}),
  ), {minLength: 1, maxLength: 3}),
  fc.option(fc.array(termOf(positiveOps), {minLength: 2, maxLength: 3}), {nil: undefined}),
).map(([items, group]) => {
  const parents = items.filter(term => term.kind === 'childof')
  const kept: unknown[] = [...items.filter(term => term.kind !== 'childof'), ...parents.slice(0, 1)]
  const alternatives = group?.filter(term => term.kind !== 'types')
  return [...kept, ...(alternatives && alternatives.length >= 2 ? [{kind: 'anyOf' as const, alternatives}] : [])]
})

// ---- model ---------------------------------------------------------------

type Block = RawBlock & {properties: Record<string, unknown>}

const cmp = (op: CompareOp, a: number, b: number) =>
  op === 'eq' ? a === b : op === 'lt' ? a < b : op === 'lte' ? a <= b : op === 'gt' ? a > b : op === 'gte' ? a >= b : a !== b
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/** Does an instant `t` satisfy `op` against a date-only day or an instant? */
const timeMatches = (op: CompareOp, t: number, operand: string, dayStart: (y: number, m: number, d: number) => number): boolean => {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(operand)
  if (!day) return op === 'ne' ? t !== Date.parse(operand) : cmp(op, t, Date.parse(operand))
  const [y, m, d] = [Number(day[1]), Number(day[2]), Number(day[3])]
  const start = dayStart(y, m, d)
  const next = dayStart(y, m, d + 1)
  switch (op) {
    case 'eq': return t >= start && t < next
    case 'ne': return !(t >= start && t < next)
    case 'lt': return t < start
    case 'lte': return t < next
    case 'gt': return t >= next
    case 'gte': return t >= start
  }
}

const ancestorsOf = (block: Block, byId: Map<string, Block>): string[] => {
  const chain: string[] = []
  for (let parent = block.parentId; parent; parent = byId.get(parent)?.parentId ?? null) chain.push(parent)
  return chain
}

const modelMatches = (term: QueryTerm, block: Block, byId: Map<string, Block>): boolean => {
  const refs = block.references ?? []
  switch (term.kind) {
    case 'types': {
      const any = term.types.some(type => (block.types ?? []).includes(type.id))
      return term.negated ? !any : any
    }
    case 'presence': {
      const value = block.properties[term.property.name]
      return (value !== undefined && value !== null) === term.present
    }
    case 'refs': return refs.some(r => r.id === term.target.id)
    case 'childof': return block.parentId === term.target.id
    case 'under': return block.id === term.target.id || ancestorsOf(block, byId).includes(term.target.id)
    case 'anyOf': return term.alternatives.some(alternative => modelMatches(alternative, block, byId))
    case 'field': return timeMatches(term.op, block.createdAt ?? 1, term.operand, localDayStart)
    case 'compare': {
      const {property, op, operand} = term
      const value = block.properties[property.name]
      const positive = op === 'ne' ? 'eq' : op
      let hit: boolean
      if (operand.kind === 'ref') hit = refs.some(r => r.id === operand.id && r.sourceField === property.name)
      else if (property.name === 'tags') hit = Array.isArray(value) && value.includes(operand.value)
      else if (property.name === 'rating') hit = typeof value === 'number' && cmp(positive, value, Number(operand.value))
      else if (property.name === 'done') hit = typeof value === 'boolean' && value === (operand.value === 'true')
      else if (property.name === 'due') hit = typeof value === 'string' && ISO.test(value) && timeMatches(positive, Date.parse(value), operand.value, (y, m, d) => Date.UTC(y, m - 1, d))
      else hit = typeof value === 'string' && value === operand.value
      return op === 'ne' ? !hit : hit
    }
  }
}

// ---- property -----------------------------------------------------------

let db: TestDb
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })

describe('parsed queries in the engine', () => {
  const guard = statefulFuzzGuard()
  it('select exactly the blocks the terms describe', async () => {
    await fc.assert(fc.asyncProperty(blocks, queryTerms, (rows, terms) => guard.run(null, async () => {
      const text = formatQuery(terms as QueryTerm[])
      const parsed = parseQuery(text, dbResolver, options)
      // A generated under= may lack a bounding term; that is a term error, checked in the parser's own tests.
      fc.pre(parsed.errors.length === 0)
      const repo = await createQueryRepo(db)
      await writeBlocks(db, rows)
      const byId = new Map(rows.map(block => [block.id, {...block, properties: block.properties ?? {}}]))
      const expected = [...byId.values()]
        .filter(block => parsed.terms.every(term => modelMatches(term, block, byId)))
        .map(block => block.id).sort()
      const actual = [...await repo.query.typedBlockIds({workspaceId: WS, ...parsed.query}).load()].sort()
      expect(actual, text).toEqual(expected)
    })), fuzzParams(150))
  }, fuzzTestTimeout())
})
