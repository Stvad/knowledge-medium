// @vitest-environment node
//
// End-to-end coverage for the SRS due-cards query against a real DB.
// The sibling `dueQuery.test.ts` only asserts the query *shape*, which
// is why it never caught that a never-archived card was silently
// excluded — the bug lived in the query engine's three-valued handling
// of `exclude`, not in the query we build. These tests run the actual
// query so that regression stays caught.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, type BlockReference } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { typesProp } from '@/data/properties'
import { propertySchemasFacet, typesFacet } from '@/data/facets'
import { Repo } from '@/data/repo'
import { dailyNoteDateProp, dailyNoteType, DAILY_NOTE_TYPE } from '@/plugins/daily-notes/schema.ts'
import {
  SRS_SM25_TYPE,
  srsSm25Type,
  srsNextReviewDateProp,
  srsArchivedProp,
} from '@/plugins/srs-rescheduling/schema.ts'
import { buildDueCardsQuery } from '../dueQuery.ts'

const WS = 'ws-1'
const NOW = new Date('2026-06-02T12:00:00')

interface Harness { h: TestDb; repo: Repo }

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const { repo } = createTestRepo({
    db: h.db,
    user: {id: 'user-1'},
    newId: () => `gen-${++idCursor}`,
    // No live sync observer (the sanctioned deterministic-timing pattern).
    // This suite does explicit local writes + queries and never needs
    // materialization. With it on, a prior test's async observer write — whose
    // tx_id comes from the per-test `newId` counter (reset to gen-1 each test)
    // — could land after this test's resetTestDb cleared command_events and
    // collide on the UNIQUE command_events.tx_id under full-suite load.
    startSyncObserver: false,
    extensions: [
      typesFacet.of(dailyNoteType, {source: 'test'}),
      typesFacet.of(srsSm25Type, {source: 'test'}),
      propertySchemasFacet.of(dailyNoteDateProp, {source: 'test'}),
      propertySchemasFacet.of(srsNextReviewDateProp, {source: 'test'}),
      propertySchemasFacet.of(srsArchivedProp, {source: 'test'}),
    ],
  })
  repo.setActiveWorkspaceId(WS)
  return {h, repo}
}

let sharedDb: TestDb
let env: Harness
// Monotonic across the whole file (NOT reset per test). The suite shares one
// PowerSync DB; tx_id comes from this counter, and an awaited write's
// command_events insert can land just after the next test's resetTestDb (PS
// write-behind). A per-test reset to gen-1 made those late ids collide with
// the next test's own ids on the UNIQUE command_events.tx_id; keeping it
// monotonic means a leaked id is always lower than the live test's, so it
// can never collide. Nothing here asserts on generated ids (blocks use
// explicit ids), so the values themselves don't matter.
let idCursor = 0
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })

const create = async (args: {
  id: string
  parentId?: string | null
  types?: readonly string[]
  properties?: Record<string, unknown>
  references?: BlockReference[]
}) => {
  const properties = {...(args.properties ?? {})}
  if (args.types !== undefined) {
    properties[typesProp.name] = typesProp.codec.encode(args.types)
  }
  await env.repo.tx(tx => tx.create({
    id: args.id,
    workspaceId: WS,
    parentId: args.parentId ?? null,
    orderKey: `k-${args.id}`,
    properties,
    references: args.references ?? [],
  }), {scope: ChangeScope.BlockDefault})
}

const dailyNote = (id: string, iso: string) =>
  create({
    id,
    types: [DAILY_NOTE_TYPE],
    properties: {
      alias: [iso],
      [dailyNoteDateProp.name]: dailyNoteDateProp.codec.encode(new Date(`${iso}T00:00:00.000Z`)),
    },
  })

const card = (id: string, dueNoteId: string, opts: {parentId?: string | null; archived?: boolean} = {}) =>
  create({
    id,
    parentId: opts.parentId ?? null,
    types: [SRS_SM25_TYPE],
    properties: {
      [srsNextReviewDateProp.name]: srsNextReviewDateProp.codec.encode(dueNoteId),
      ...(opts.archived === undefined
        ? {}
        : {[srsArchivedProp.name]: srsArchivedProp.codec.encode(opts.archived)}),
    },
    references: [{id: dueNoteId, alias: dueNoteId, sourceField: srsNextReviewDateProp.name}],
  })

const runIds = async (...args: Parameters<typeof buildDueCardsQuery>) =>
  (await env.repo.queryBlocks(buildDueCardsQuery(...args))).map(b => b.id)

describe('SRS due cards (end-to-end)', () => {
  it('surfaces a never-archived card whose review date is in the past', async () => {
    await dailyNote('dn-past', '2026-05-01')
    await card('card1', 'dn-past') // archived never set — the common case

    expect(await runIds({workspaceId: WS, tagBlockId: null, now: NOW})).toEqual(['card1'])
  })

  it('keeps due cards but drops the archived one', async () => {
    await dailyNote('dn-past', '2026-05-01')
    await card('live', 'dn-past')
    await card('archived', 'dn-past', {archived: true})

    expect(await runIds({workspaceId: WS, tagBlockId: null, now: NOW})).toEqual(['live'])
  })

  it('excludes cards whose review date is today-or-later', async () => {
    await dailyNote('dn-past', '2026-05-01')
    await dailyNote('dn-future', '2026-07-01')
    await card('due', 'dn-past')
    await card('not-due', 'dn-future')

    expect(await runIds({workspaceId: WS, tagBlockId: null, now: NOW})).toEqual(['due'])
  })

  it('scopes to a page-as-tag via ancestor scope', async () => {
    await create({id: 'roam-page', types: [DAILY_NOTE_TYPE], properties: {alias: ['Roam']}})
    await dailyNote('dn-past', '2026-05-01')
    await card('on-roam', 'dn-past', {parentId: 'roam-page'})
    await card('off-roam', 'dn-past')

    expect(await runIds({workspaceId: WS, tagBlockId: 'roam-page', now: NOW})).toEqual(['on-roam'])
  })
})
