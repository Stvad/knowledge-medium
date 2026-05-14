import { describe, expect, it } from 'vitest'
import {
  pickBestInDirection,
  scoreCandidate,
  type Rect,
} from './spatialNavigation'

const rect = (top: number, left: number, height = 20, width = 200): Rect => ({
  top,
  left,
  bottom: top + height,
  right: left + width,
})

describe('scoreCandidate', () => {
  it('returns null for candidates not in the travel direction', () => {
    const anchor = rect(100, 100)
    expect(scoreCandidate(anchor, rect(100, 0), 'right')).toBeNull()
    expect(scoreCandidate(anchor, rect(100, 200), 'left')).toBeNull()
    expect(scoreCandidate(anchor, rect(0, 100), 'down')).toBeNull()
    expect(scoreCandidate(anchor, rect(200, 100), 'up')).toBeNull()
  })

  it('returns null for a candidate behind the anchor in travel axis', () => {
    const anchor = rect(100, 100, 20, 200)
    // candidate ends before anchor's left edge → "right" of anchor's right
    // is impossible, candidate.left=150 < anchor.right=300 → travel < 0
    expect(scoreCandidate(anchor, rect(100, 150, 20, 100), 'right')).toBeNull()
  })

  it('admits adjacent edge-touching candidates (siblings)', () => {
    const anchor = rect(100, 100, 20, 200)
    // candidate's top exactly equals anchor.bottom — outliner bullet case
    expect(scoreCandidate(anchor, rect(120, 100, 20, 200), 'down')).toBe(0)
  })

  it('scores by travel distance when perpendicular ranges overlap', () => {
    const anchor = rect(100, 100)
    // both candidates have y-range overlapping anchor (y=100..120)
    const near = rect(110, 400)   // 100px to the right
    const far = rect(110, 600)    // 300px to the right
    const nearScore = scoreCandidate(anchor, near, 'right')!
    const farScore = scoreCandidate(anchor, far, 'right')!
    expect(nearScore).toBeLessThan(farScore)
    // perpendicular gap is 0 → pure travel distance
    expect(nearScore).toBe(100)
    expect(farScore).toBe(300)
  })

  it('penalizes perpendicular misalignment', () => {
    const anchor = rect(100, 100)
    const aligned = rect(110, 400)   // y overlaps anchor
    const offset = rect(300, 400)    // y far from anchor (gap = 300 - 120 = 180)
    const alignedScore = scoreCandidate(anchor, aligned, 'right')!
    const offsetScore = scoreCandidate(anchor, offset, 'right')!
    expect(offsetScore).toBeGreaterThan(alignedScore)
  })

  it('prefers vertically-aligned candidate over a closer-but-offset one', () => {
    // Classic case: jumping right from panel A. Candidate B is at the
    // same y; candidate C is closer horizontally but in a different row.
    const anchor = rect(100, 100, 20, 200)
    const sameRow = rect(105, 400, 20, 200)   // dx=100, perp gap=0
    const aboveCloser = rect(0, 350, 20, 200) // dx=50, perp gap=80
    const sameRowScore = scoreCandidate(anchor, sameRow, 'right')!
    const aboveScore = scoreCandidate(anchor, aboveCloser, 'right')!
    expect(sameRowScore).toBeLessThan(aboveScore)
  })

  it('works symmetrically for up/down/left', () => {
    const anchor = rect(200, 200, 20, 200)
    // down
    expect(scoreCandidate(anchor, rect(300, 250), 'down')).toBeLessThan(
      scoreCandidate(anchor, rect(400, 250), 'down')!,
    )
    // up
    expect(scoreCandidate(anchor, rect(100, 250), 'up')).toBeLessThan(
      scoreCandidate(anchor, rect(0, 250), 'up')!,
    )
    // left
    expect(scoreCandidate(anchor, rect(205, 0, 20, 100), 'left')).not.toBeNull()
    expect(scoreCandidate(anchor, rect(205, 500), 'left')).toBeNull()
  })
})

describe('pickBestInDirection', () => {
  it('returns null when no candidate makes progress', () => {
    const anchor = rect(100, 100)
    const result = pickBestInDirection(
      anchor,
      [{target: 'behind', rect: rect(100, 0)}],
      'right',
    )
    expect(result).toBeNull()
  })

  it('picks the closest candidate that makes progress', () => {
    const anchor = rect(100, 100)
    const result = pickBestInDirection(
      anchor,
      [
        {target: 'far', rect: rect(110, 800)},
        {target: 'near', rect: rect(110, 400)},
        {target: 'behind', rect: rect(110, 0)},
      ],
      'right',
    )
    expect(result?.target).toBe('near')
  })

  it('crosses a panel boundary cleanly when y-aligned candidate exists', () => {
    // Anchor in panel A. Two candidates: one further down in panel A
    // (below the anchor), one to the right in panel B at similar y.
    // For "right", only the B candidate is valid; for "down", only the
    // A candidate is.
    const anchor = rect(100, 100, 20, 200)
    const belowInA = rect(150, 105, 20, 200)
    const rightInB = rect(105, 400, 20, 200)
    const candidates = [
      {target: 'belowInA', rect: belowInA},
      {target: 'rightInB', rect: rightInB},
    ]
    expect(pickBestInDirection(anchor, candidates, 'right')?.target).toBe('rightInB')
    expect(pickBestInDirection(anchor, candidates, 'down')?.target).toBe('belowInA')
  })
})
