import { describe, expect, it } from 'vitest'
import type { BlockData } from '@/data/api'
import { typesProp } from '@/data/properties'
import { SRS_SM25_TYPE, srsArchivedProp } from '@/plugins/srs-rescheduling'
import { dailyNoteDateProp } from '@/plugins/daily-notes/schema.js'
import { srsNextReviewDateProp } from '@/plugins/srs-rescheduling'
import {
  UNRESOLVED_TAG_ID,
  buildDueCardsQuery,
  buildTaggedCandidatesQuery,
  dueBoundary,
  selectNewCards,
} from '../dueQuery.ts'

describe('dueBoundary', () => {
  it('is UTC midnight of the day after the local date (matching daily-note storage)', () => {
    // Daily notes store `daily-note:date` at UTC midnight, so the cutoff
    // must be UTC midnight of tomorrow's local date — not local
    // midnight, which west of UTC would include tomorrow's cards.
    const boundary = dueBoundary(new Date(2026, 5, 1, 14, 30))
    expect(boundary.toISOString()).toBe('2026-06-02T00:00:00.000Z')
  })
})

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
    expect(q.referencedBy).toEqual({id: 'tag-1'})
    expect(q.match).toBeUndefined()
  })

  it('matches nothing for the untagged all-due deck', () => {
    // No tag means no "tagged for SRS" set to collect from. Keeping the
    // filter (pointed at the sentinel) is what stops it degrading into
    // "every block in the workspace".
    expect(buildTaggedCandidatesQuery({workspaceId: ws, tagBlockId: null}).referencedBy)
      .toEqual({id: UNRESOLVED_TAG_ID})
  })
})

describe('selectNewCards', () => {
  const block = (id: string, types: string[]): BlockData => ({
    id,
    workspaceId: 'ws-1',
    properties: {[typesProp.name]: typesProp.codec.encode(types)},
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
})
