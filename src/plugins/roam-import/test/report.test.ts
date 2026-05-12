// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { linkRoamUidMentions } from '../report'

describe('linkRoamUidMentions', () => {
  it('replaces every diagnostic Roam uid shape with an imported block reference', () => {
    const uidMap = new Map([
      ['badSrsUid', 'block-bad-srs'],
      ['pageUid', 'block-page'],
      ['parentUid', 'block-parent'],
      ['childUid', 'block-child'],
      ['dupUid', 'block-dup'],
      ['readwiseUid', 'block-readwise'],
    ])

    expect(linkRoamUidMentions(
      'Roam SRS marker on uid badSrsUid has interval/factor but no parseable daily review date.',
      uidMap,
    )).toBe(
      'Roam SRS marker on block ((block-bad-srs)) has interval/factor but no parseable daily review date.',
    )

    expect(linkRoamUidMentions(
      'Non-standard page_alias on [[Page]] (uid pageUid) was not used for alias-rule merging.',
      uidMap,
    )).toBe(
      'Non-standard page_alias on [[Page]] ((block-page)) was not used for alias-rule merging.',
    )

    expect(linkRoamUidMentions(
      'Multiple marker-only Roam SRS children under uid parentUid; promoted latest due date June 8th, 2026 (childUid) and preserved 1 additional marker block(s) literally.',
      uidMap,
    )).toBe(
      'Multiple marker-only Roam SRS children under block ((block-parent)); promoted latest due date June 8th, 2026 ((block-child)) and preserved 1 additional marker block(s) literally.',
    )

    expect(linkRoamUidMentions(
      'Duplicate Roam uid dupUid (2 occurrences, parent/page); kept first.',
      uidMap,
    )).toBe(
      'Duplicate Roam block ((block-dup)) (2 occurrences, parent/page); kept first.',
    )

    expect(linkRoamUidMentions(
      'Readwise property extraction on uid readwiseUid: blank author.',
      uidMap,
    )).toBe(
      'Readwise property extraction on block ((block-readwise)): blank author.',
    )

    expect(linkRoamUidMentions(
      'Duplicate Roam uid weirdness: 3 uid(s) appeared.',
      uidMap,
    )).toBe(
      'Duplicate Roam uid weirdness: 3 uid(s) appeared.',
    )
  })
})
