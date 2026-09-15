// @vitest-environment node
/**
 * Fuzz suite pinning `materializePropertyChildrenForExistingRow`
 * (`src/data/internals/propertyChildrenProcessor.ts:363-394`): a raw
 * `tx.update({properties})` whose value does NOT decode under its schema's
 * codec must abort the WHOLE transaction, never silently skip the bad key
 * (the old behavior left the cell holding the junk while a pre-existing
 * value child kept its stale value, diverging PERMANENTLY — PROJECT
 * watches `content`, not `properties`, so it never reconciles). See
 * docs/fuzzing.md for tier mechanics.
 * `src/data/propertyChildren.test.ts:164-190` pins ONE fixed example (a
 * `null` cell value against the `string` codec) — this suite generalizes
 * across the whole codec zoo (string/url/date/number/boolean/ref/enum) and
 * across "no prior value" vs "a prior valid value already materialized".
 *
 * Oracle, grounded in propertyChildrenProcessor.ts:363-394:
 *  - The write REJECTS with a message matching `/does not decode/` (the
 *    thrown `Error` there).
 *  - Atomicity: since the processor throw propagates out of the SQL
 *    transaction (repo.tx wraps one DB transaction), the row's cell reverts
 *    to EXACTLY its pre-write bag — including an unrelated sibling key
 *    added in the SAME raw write, which proves the abort is a whole-TX
 *    rollback, not a per-key catch that still lets the rest of the bag
 *    land.
 *  - No partial materialization: the field/value children for the bad
 *    key are exactly what they were before the attempt (untouched if a
 *    prior valid value existed; absent if it didn't).
 *  - A companion deterministic case (not fuzzed) additionally proves a
 *    DIFFERENT, otherwise-valid key named in the SAME bag write is rolled
 *    back too — even though `materializePropertyChildrenForExistingRow`
 *    would have successfully materialized it had it been processed first
 *    (:341-449 processes `names` in iteration order) — "the whole tx",
 *    not just the offending key.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout, statefulFuzzGuard } from '@/test/fuzz'
import { ChangeScope, codecs, defineProperty, type AnyPropertySchema } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { projectedPropertyDefinitionsFacet } from '@/data/facets'
import type { Repo } from '@/data/repo'

const WS = 'ws-pcp-reject-fuzz'

const stringSchema = defineProperty<string>('str', {
  codec: codecs.string, defaultValue: '', changeScope: ChangeScope.BlockDefault,
})
const urlSchema = defineProperty<string>('url', {
  codec: codecs.url, defaultValue: '', changeScope: ChangeScope.BlockDefault,
})
const dateSchema = defineProperty<Date | undefined>('date', {
  codec: codecs.date, defaultValue: undefined, changeScope: ChangeScope.BlockDefault,
})
const numberSchema = defineProperty<number>('num', {
  codec: codecs.number, defaultValue: 0, changeScope: ChangeScope.BlockDefault,
})
const booleanSchema = defineProperty<boolean>('bool', {
  codec: codecs.boolean, defaultValue: false, changeScope: ChangeScope.BlockDefault,
})
const refSchema = defineProperty<string>('ref', {
  codec: codecs.ref(), defaultValue: '', changeScope: ChangeScope.BlockDefault,
})
const enumOptions = ['open', 'done', 'archived'] as const
const enumSchema = defineProperty<typeof enumOptions[number]>('enum', {
  codec: codecs.enum([...enumOptions]), defaultValue: 'open', changeScope: ChangeScope.BlockDefault,
})

type Kind = 'string' | 'url' | 'date' | 'number' | 'boolean' | 'ref' | 'enum'
const SCHEMAS: Record<Kind, {schema: AnyPropertySchema; fieldId: string}> = {
  string: {schema: stringSchema, fieldId: 'field-str'},
  url: {schema: urlSchema, fieldId: 'field-url'},
  date: {schema: dateSchema, fieldId: 'field-date'},
  number: {schema: numberSchema, fieldId: 'field-num'},
  boolean: {schema: booleanSchema, fieldId: 'field-bool'},
  ref: {schema: refSchema, fieldId: 'field-ref'},
  enum: {schema: enumSchema, fieldId: 'field-enum'},
}
const KINDS = Object.keys(SCHEMAS) as Kind[]

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'
const idArb = fc.array(fc.constantFrom(...ID_ALPHABET), {minLength: 1, maxLength: 16})
  .map(cs => cs.join(''))
const finiteArb = fc.double({noNaN: true, noDefaultInfinity: true}).filter(n => !Object.is(n, -0))

/** A DECODED value in the schema's own domain, for establishing a prior
 *  valid state via `tx.setProperty` (the codec-encode boundary). */
const validDecodedArbFor = (kind: Kind): fc.Arbitrary<unknown> => {
  switch (kind) {
    case 'string': case 'url': return fc.string({maxLength: 20})
    case 'date': return fc.option(fc.date({noInvalidDate: true}), {nil: undefined})
    case 'number': return finiteArb
    case 'boolean': return fc.boolean()
    case 'ref': return idArb
    case 'enum': return fc.constantFrom(...enumOptions)
  }
}

/** A raw (encoded-position) value guaranteed to fail `schema.codec.decode` —
 *  the mistake `setProperty` can't produce, per propertyChildrenProcessor.ts:366. */
const undecodableArbFor = (kind: Kind): fc.Arbitrary<unknown> => {
  const nonString = fc.oneof(
    fc.integer(), fc.boolean(), fc.constant(null),
    fc.array(fc.integer(), {maxLength: 2}), fc.object({maxDepth: 1}),
  )
  switch (kind) {
    case 'string': case 'url': case 'ref': case 'enum':
      return nonString // decode requires typeof === 'string'
    case 'number':
      return fc.oneof(
        fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
        fc.string(), fc.boolean(), fc.constant(null), fc.array(fc.integer(), {maxLength: 2}),
      )
    case 'boolean':
      return fc.oneof(fc.string(), fc.integer(), fc.constant(null), fc.array(fc.integer(), {maxLength: 2}))
    case 'date':
      // Excludes null/undefined deliberately — those decode successfully
      // (absence), so they are NOT undecodable for this absence-aware codec.
      return fc.oneof(
        fc.integer(), fc.boolean(), fc.array(fc.integer(), {maxLength: 2}),
        fc.constantFrom('not-a-date', '2023-13-40T00:00:00.000Z', ''),
      )
  }
}

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => {
  await guard.barrier()
  await sharedDb.cleanup()
})
const guard = statefulFuzzGuard()

const seedWorkspace = async (): Promise<void> => {
  await sharedDb.db.execute(
    `INSERT INTO workspaces
       (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
     VALUES (?, ?, ?, 1, 1, 'none', NULL, 'children')`,
    [WS, 'ws', 'user-1'],
  )
}

const setup = (): Repo => {
  const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
  repo.setActiveWorkspaceId(WS)
  for (const {schema, fieldId} of Object.values(SCHEMAS)) {
    repo.setRuntimeContributions(
      projectedPropertyDefinitionsFacet,
      `test-${schema.name}-definition`,
      [{
        metadata: {
          fieldId, workspaceId: WS, createdAt: 1, name: schema.name,
          changeScope: schema.changeScope, hidden: false, origin: 'user' as const,
        },
        schema,
      }],
      {workspaceId: WS},
    )
  }
  return repo
}

const cellBag = async (id: string): Promise<Record<string, unknown>> => {
  const row = await sharedDb.db.get<{properties_json: string}>(
    'SELECT properties_json FROM blocks WHERE id = ?', [id])
  return JSON.parse(row.properties_json) as Record<string, unknown>
}

interface ChildRow {id: string; content: string; deleted: number; reference_target_id: string | null}
const liveFieldRows = async (parentId: string, fieldId: string): Promise<ChildRow[]> =>
  (await sharedDb.db.getAll<ChildRow>(
    `SELECT id, content, deleted, reference_target_id FROM blocks
       WHERE parent_id = ? ORDER BY order_key, id`,
    [parentId],
  )).filter(r => r.deleted === 0 && r.reference_target_id === fieldId)

const runCase = async (
  {kind, hasPrior, priorValue, badValue}:
  {kind: Kind; hasPrior: boolean; priorValue: unknown; badValue: unknown},
): Promise<void> => {
  await resetTestDb(sharedDb.db)
  await seedWorkspace()
  const repo = setup()
  await repo.tx(async tx => {
    await tx.create({id: 'p', workspaceId: WS, parentId: null, orderKey: 'a0', content: ''})
  }, {scope: ChangeScope.BlockDefault})

  const {schema, fieldId} = SCHEMAS[kind]
  if (hasPrior) {
    await repo.tx(tx => tx.setProperty('p', schema, priorValue), {scope: ChangeScope.BlockDefault})
  }
  const bagBefore = await cellBag('p')
  const fieldsBefore = await liveFieldRows('p', fieldId)

  const bagWithSibling = {...bagBefore, [schema.name]: badValue, sibling: 'kept'}
  await expect(
    repo.tx(tx => tx.update('p', {properties: bagWithSibling}), {scope: ChangeScope.BlockDefault}),
    `kind=${kind} badValue=${JSON.stringify(badValue)}`,
  ).rejects.toThrow(/does not decode/)

  // Whole-tx rollback: the cell is back to EXACTLY its pre-attempt bag —
  // the sibling key never landed either.
  expect(await cellBag('p')).toEqual(bagBefore)
  // No partial materialization: the field row (if any existed) is untouched.
  expect(await liveFieldRows('p', fieldId)).toEqual(fieldsBefore)
}

describe('materializePropertyChildrenForExistingRow: undecodable raw cell write rejection', () => {
  it('rejects with "does not decode" and rolls back the whole tx, across the codec zoo', async () => {
    const caseArb = fc.constantFrom(...KINDS).chain(kind => fc.record({
      kind: fc.constant(kind),
      hasPrior: fc.boolean(),
      priorValue: validDecodedArbFor(kind),
      badValue: undecodableArbFor(kind),
      prngSeed: fc.integer({min: 1, max: 2 ** 31 - 2}),
    }))
    await fc.assert(
      fc.asyncProperty(caseArb, ({kind, hasPrior, priorValue, badValue, prngSeed}) =>
        guard.run(prngSeed, () => runCase({kind, hasPrior, priorValue, badValue}))),
      fuzzParams(30),
    )
  }, fuzzTestTimeout())

  // Deterministic companion: a DIFFERENT, otherwise-valid key in the SAME
  // bag write must also be rolled back — not just the offending key. Proves
  // "the whole tx", since `materializePropertyChildrenForExistingRow`
  // processes `names` in iteration order (:341) and would have happily
  // materialized the valid key had it come first.
  it('a sibling key with a genuinely NEW valid value in the same bag is also rolled back, not materialized', async () => {
    await guard.barrier()
    await resetTestDb(sharedDb.db)
    await seedWorkspace()
    const repo = setup()
    await repo.tx(async tx => {
      await tx.create({id: 'p', workspaceId: WS, parentId: null, orderKey: 'a0', content: ''})
    }, {scope: ChangeScope.BlockDefault})

    await expect(
      repo.tx(tx => tx.update('p', {
        properties: {[stringSchema.name]: 'a brand new valid value', [numberSchema.name]: null},
      }), {scope: ChangeScope.BlockDefault}),
    ).rejects.toThrow(/does not decode/)

    expect(await cellBag('p')).toEqual({})
    expect(await liveFieldRows('p', SCHEMAS.string.fieldId)).toEqual([])
    expect(await liveFieldRows('p', SCHEMAS.number.fieldId)).toEqual([])
  })
})
