import { describe, expect, it } from 'vitest'
import type { BlockData } from '@/data/api'
import { typesProp } from '@/data/properties'
import {
  SRS_SM25_TYPE,
  srsArchivedProp,
  srsNextReviewDateProp,
} from '@/plugins/srs-rescheduling'
import { decideGrade, isLiveSrsCard } from '../gradeDecision.ts'

const block = (
  types: string[],
  extraProps: Record<string, unknown> = {},
): BlockData => ({
  id: 'b1',
  workspaceId: 'ws-1',
  properties: {[typesProp.name]: typesProp.codec.encode(types), ...extraProps},
} as unknown as BlockData)

const enrolled = block([SRS_SM25_TYPE], {
  [srsNextReviewDateProp.name]: srsNextReviewDateProp.codec.encode('daily-1'),
})
const untyped = block([])

describe('decideGrade', () => {
  it('grades an enrolled card whether or not the queries have settled', () => {
    // Its own properties prove membership — nothing to wait for.
    expect(decideGrade(enrolled, {isNew: false, ready: false})).toBe('grade')
    expect(decideGrade(enrolled, {isNew: false, ready: true})).toBe('grade')
  })

  it('grades an unenrolled block that is in the deck\'s new set', () => {
    expect(decideGrade(untyped, {isNew: true, ready: true})).toBe('grade')
  })

  it('waits rather than dropping an unenrolled card before the queries settle', () => {
    // THE restored-session race: a resumed session restores its queue, index
    // and `revealed` flag synchronously, so the grade controls are live on the
    // first render — while `newIds` is still empty because the candidates
    // query hasn't resolved. A genuine new card is indistinguishable from an
    // untagged one here, and dropping it would skip a valid card, claim it is
    // "no longer in spaced repetition", and never enrol it.
    expect(decideGrade(untyped, {isNew: false, ready: false})).toBe('wait')
  })

  it('drops an unenrolled card once the queries have settled without it', () => {
    // Same inputs as above except `ready` — now the empty new set is evidence
    // rather than an unfinished load, so the card really did leave the deck.
    expect(decideGrade(untyped, {isNew: false, ready: true})).toBe('drop')
  })

  it('drops a block that cannot be loaded at all, settled or not', () => {
    expect(decideGrade(null, {isNew: false, ready: false})).toBe('drop')
    expect(decideGrade(undefined, {isNew: true, ready: true})).toBe('drop')
  })
})

describe('isLiveSrsCard', () => {
  it('rejects an archived card and one with no next-review date', () => {
    expect(isLiveSrsCard(block([SRS_SM25_TYPE]))).toBe(false)
    expect(isLiveSrsCard(block([SRS_SM25_TYPE], {
      [srsNextReviewDateProp.name]: srsNextReviewDateProp.codec.encode('daily-1'),
      [srsArchivedProp.name]: srsArchivedProp.codec.encode(true),
    }))).toBe(false)
  })

  it('treats an unreadable row as not-live instead of throwing out of the handler', () => {
    // `getBlockTypes` decodes strictly; a malformed `types` value reaching a
    // grade handler would otherwise escape as an exception mid-write rather
    // than routing to the conservative branch.
    const malformed = {
      id: 'b1',
      workspaceId: 'ws-1',
      properties: {[typesProp.name]: '{not-a-types-list'},
    } as unknown as BlockData
    expect(() => isLiveSrsCard(malformed)).not.toThrow()
    expect(isLiveSrsCard(malformed)).toBe(false)
    // …and the decision built on it still resolves, rather than propagating.
    expect(decideGrade(malformed, {isNew: false, ready: true})).toBe('drop')
  })
})
