import { describe, expect, it } from 'vitest'
import type { BlockData } from '@/data/api'
import { typesProp } from '@/data/properties'
import {
  SRS_SM25_TYPE,
  srsArchivedProp,
  srsFactorProp,
  srsGradeProp,
  srsIntervalProp,
  srsNextReviewDateProp,
  srsReviewCountProp,
  srsSnapshotHistoryProp,
} from '@/plugins/srs-rescheduling'
import { dailyNoteDateProp } from '@/plugins/daily-notes/schema.js'
import {
  UNRESOLVED_TAG_ID,
  buildDueCardsQuery,
  buildTaggedCandidatesQuery,
  dueBoundary,
  selectNewCards,
} from '../dueQuery.ts'

// `dueBoundary` itself is pinned where it now lives —
// `src/plugins/daily-notes/test/dueQuery.test.ts`. What matters here is that
// this plugin's query is still built ON it.

describe('buildDueCardsQuery', () => {
  const ws = 'ws-1'

  it('filters SRS cards by due date via a ref-traversal into the daily note', () => {
    const now = new Date(2026, 5, 1)
    const q = buildDueCardsQuery({workspaceId: ws, now})
    expect(q.types).toEqual([SRS_SM25_TYPE])
    expect(q.where).toEqual({
      [srsNextReviewDateProp.name]: {
        target: {[dailyNoteDateProp.name]: {lt: dueBoundary(now)}},
      },
    })
  })

  it('excludes archived cards rather than matching archived:false', () => {
    // An unset `archived` never equals `false` in SQL, so matching
    // would drop every never-archived card — exclusion is the only
    // correct shape here.
    const q = buildDueCardsQuery({workspaceId: ws})
    expect(q.exclude).toEqual([
      {scope: 'self', where: {[srsArchivedProp.name]: true}},
    ])
  })

  it('adds an ancestor-scoped tag filter only when a tag id is given', () => {
    const withTag = buildDueCardsQuery({workspaceId: ws, tagBlockId: 'tag-1'})
    expect(withTag.match).toEqual([{scope: 'ancestor', referencedBy: {id: 'tag-1'}}])

    const allDue = buildDueCardsQuery({workspaceId: ws})
    expect(allDue.match).toBeUndefined()
  })

  it('honours an explicit self scope for the tag filter', () => {
    const q = buildDueCardsQuery({workspaceId: ws, tagBlockId: 'tag-1', scope: 'self'})
    expect(q.match).toEqual([{scope: 'self', referencedBy: {id: 'tag-1'}}])
  })

  it('targets an unresolvable id so a missing tag yields zero, not all cards', () => {
    const q = buildDueCardsQuery({workspaceId: ws, tagBlockId: UNRESOLVED_TAG_ID})
    expect(q.match).toEqual([{scope: 'ancestor', referencedBy: {id: UNRESOLVED_TAG_ID}}])
  })
})

describe('buildTaggedCandidatesQuery', () => {
  const ws = 'ws-1'

  it('scopes enrolment to blocks tagged themselves, never a tagged ancestor', () => {
    // The deck's DUE query is ancestor-scoped, so an existing card inherits
    // membership from its page. Enrolment must not: ancestor scope here
    // would turn every bullet under a tagged page — answers included — into
    // a new card.
    const q = buildTaggedCandidatesQuery({workspaceId: ws, tagBlockId: 'tag-1'})
    expect(q.referencedBy).toEqual({id: 'tag-1', sourceField: ''})
    expect(q.match).toBeUndefined()
  })

  it('counts only content refs, so a typed ref property never enrols a block', () => {
    // `block_references` carries a row per typed ref property too, with
    // `source_field` set to the property name. Without this filter a block
    // whose unrelated `project` ref points at the page being used as a deck
    // tag would be enrolled — and enrolment writes.
    expect(buildTaggedCandidatesQuery({workspaceId: ws, tagBlockId: 'tag-1'}).referencedBy)
      .toMatchObject({sourceField: ''})
  })

  it('matches nothing for the untagged all-due deck', () => {
    // No tag means no "tagged for SRS" set to collect from. Keeping the
    // filter (pointed at the sentinel) is what stops it degrading into
    // "every block in the workspace".
    expect(buildTaggedCandidatesQuery({workspaceId: ws, tagBlockId: null}).referencedBy)
      .toMatchObject({id: UNRESOLVED_TAG_ID})
  })
})

describe('selectNewCards', () => {
  const block = (
    id: string,
    types: string[],
    extraProps: Record<string, unknown> = {},
  ): BlockData => ({
    id,
    workspaceId: 'ws-1',
    properties: {[typesProp.name]: typesProp.codec.encode(types), ...extraProps},
  } as unknown as BlockData)

  it('keeps tagged blocks that carry no SRS type', () => {
    expect(selectNewCards([block('plain', []), block('todo', ['todo'])]).map(b => b.id))
      .toEqual(['plain', 'todo'])
  })

  it('drops enrolled cards, including ones not due today', () => {
    // A card scheduled for next month is still a card — re-collecting it as
    // "new" would reset it to the SM-2.5 defaults on the next grade.
    expect(selectNewCards([block('card', [SRS_SM25_TYPE])])).toEqual([])
  })

  it('drops a de-typed card that still carries scheduling state (history guard)', () => {
    // Removing the `srs-sm2.5` chip in the generic type editor rewrites ONLY
    // the types array — `interval`, `factor` and `snapshot-history` survive,
    // as does the deck tag. Enrolling that as "new" is destructive: the first
    // grade runs `basisFromBlock`, which ignores stored properties when the
    // type is absent, and reschedules from the SM-2.5 defaults — replacing a
    // real review history with one fresh snapshot.
    const deTyped = block('was-a-card', [], {
      [srsIntervalProp.name]: srsIntervalProp.codec.encode(45),
      [srsFactorProp.name]: srsFactorProp.codec.encode(2.7),
      [srsSnapshotHistoryProp.name]: srsSnapshotHistoryProp.codec.encode([
        {reviewedAt: 'daily-1', grade: 4, interval: 30, factor: 2.7, reviewCount: 11},
      ]),
    })
    expect(selectNewCards([deTyped])).toEqual([])
  })

  it.each([
    ['interval', srsIntervalProp],
    ['factor', srsFactorProp],
    ['review-count', srsReviewCountProp],
    ['grade', srsGradeProp],
    ['archived', srsArchivedProp],
  ] as const)('drops a de-typed card carrying only %s', (_name, prop) => {
    // Each scheduling property independently proves prior enrolment — one
    // surviving value is enough, so no single-property gap reopens the guard.
    const partial = block('partial', [], {
      [prop.name]: prop.codec.encode(prop.defaultValue as never),
    })
    expect(selectNewCards([partial])).toEqual([])
  })

  it('survives a malformed types value instead of taking the whole deck down', () => {
    // Unlike every other `getBlockTypes` caller, this one runs over ARBITRARY
    // user blocks — the candidates query returns everything referencing the
    // tag. `getBlockTypes` decodes strictly, so one legacy/imported/raw-written
    // row would throw during `useReviewDeckCards`' render and the deck would
    // never open. A raw (un-encoded) value is exactly what such a row looks
    // like at rest.
    const malformed = {
      id: 'broken',
      workspaceId: 'ws-1',
      properties: {[typesProp.name]: '{not-a-types-list'},
    } as unknown as BlockData

    expect(() => selectNewCards([malformed])).not.toThrow()
    // Excluded, not enrolled: being invisible to the deck is recoverable,
    // enrolling a block we couldn't classify is not.
    expect(selectNewCards([malformed, block('plain', [])]).map(b => b.id)).toEqual(['plain'])
  })
})
