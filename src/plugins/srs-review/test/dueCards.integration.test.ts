// @vitest-environment node
//
// End-to-end coverage for the SRS due-cards query against a real DB.
// The sibling `dueQuery.test.ts` only asserts the query *shape*, which
// is why it never caught that a never-archived card was silently
// excluded — the bug lived in the query engine's three-valued handling
// of `exclude`, not in the query we build. These tests run the actual
// query so that regression stays caught.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveFacetRuntimeSync } from '@/extensions/facet'
import { ChangeScope, type BlockReference } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { typesProp } from '@/data/properties'
import { propertySchemasFacet, typesFacet } from '@/data/facets'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { Repo } from '@/data/repo'
import { dailyNoteDateProp, dailyNoteType, DAILY_NOTE_TYPE } from '@/plugins/daily-notes/schema.ts'
import {
  SRS_SM25_TYPE,
  srsSm25Type,
  srsNextReviewDateProp,
  srsArchivedProp,
} from '@/plugins/srs-rescheduling/schema.ts'
import { UNRESOLVED_TAG_ID, buildDueCardsQuery } from '../dueQuery.ts'

const WS = 'ws-1'
const NOW = new Date('2026-06-02T12:00:00')

interface Harness { h: TestDb; repo: Repo }

const setup = async (): Promise<Harness> => {
  const h = await createTestDb()
  const cache = new BlockCache()
  let timeCursor = 1700_000_000_000
  let idCursor = 0
  const repo = new Repo({
    db: h.db,
    cache,
    user: {id: 'user-1'},
    now: () => ++timeCursor,
    newId: () => `gen-${++idCursor}`,
    registerKernelProcessors: false,
  })
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    typesFacet.of(dailyNoteType, {source: 'test'}),
    typesFacet.of(srsSm25Type, {source: 'test'}),
    propertySchemasFacet.of(dailyNoteDateProp, {source: 'test'}),
    propertySchemasFacet.of(srsNextReviewDateProp, {source: 'test'}),
    propertySchemasFacet.of(srsArchivedProp, {source: 'test'}),
  ]))
  repo.setActiveWorkspaceId(WS)
  return {h, repo}
}

let env: Harness
beforeEach(async () => { env = await setup() })
afterEach(async () => { await env.h.cleanup() })

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

  it('self scope matches the card itself, not just an ancestor page', async () => {
    // The default ancestor scope treats "card lives under page X" as a
    // tag hit; self scope is stricter — only a card that *itself*
    // references the tag counts.
    await create({id: 'roam-page', types: [DAILY_NOTE_TYPE], properties: {alias: ['Roam']}})
    await dailyNote('dn-past', '2026-05-01')
    await create({
      id: 'direct',
      types: [SRS_SM25_TYPE],
      properties: {[srsNextReviewDateProp.name]: srsNextReviewDateProp.codec.encode('dn-past')},
      references: [
        {id: 'dn-past', alias: 'dn-past', sourceField: srsNextReviewDateProp.name},
        {id: 'roam-page', alias: 'Roam', sourceField: 'body'},
      ],
    })
    await card('under-page-only', 'dn-past', {parentId: 'roam-page'})

    expect(await runIds({workspaceId: WS, tagBlockId: 'roam-page', scope: 'self', now: NOW}))
      .toEqual(['direct'])
  })

  it('a named-but-missing tag yields zero, not every due card', async () => {
    // useDueCards maps an unresolvable tag name to UNRESOLVED_TAG_ID so
    // a typo'd / not-yet-created tag page reports an empty deck instead
    // of falling through to the unfiltered "all due" set.
    await dailyNote('dn-past', '2026-05-01')
    await card('c1', 'dn-past')
    await card('c2', 'dn-past')

    expect(await runIds({workspaceId: WS, tagBlockId: UNRESOLVED_TAG_ID, now: NOW})).toEqual([])
  })
})
