import { describe, expect, it } from 'vitest'
import { SRS_SM25_TYPE, srsArchivedProp } from '@/plugins/srs-rescheduling'
import { dailyNoteDateProp } from '@/plugins/daily-notes/schema.js'
import { srsNextReviewDateProp } from '@/plugins/srs-rescheduling'
import { UNRESOLVED_TAG_ID, buildDueCardsQuery, dueBoundary } from '../dueQuery.ts'

describe('dueBoundary', () => {
  it('is the start of the day after `now`, at local midnight', () => {
    const boundary = dueBoundary(new Date(2026, 5, 1, 14, 30))
    expect(boundary).toEqual(new Date(2026, 5, 2, 0, 0, 0, 0))
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
