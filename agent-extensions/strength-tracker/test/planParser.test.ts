import {describe, expect, it} from 'vitest'

import {
  configFromPlan,
  extractVideos,
  mergePlan,
  parseExerciseLine,
  parsePlan,
  type PlanNode,
} from '../src/program/planParser'

const node = (content: string, children: PlanNode[] = []): PlanNode => ({
  id: content.slice(0, 8),
  content,
  children,
})

/** A trimmed but faithful copy of the live plan outline's shape. */
const samplePlan = (): PlanNode =>
  node('**Strength Plan v2** — designed around interruptions', [
    node('**Session A (Thu, upper-lean)**', [
      node('Warm-up: 3–5 min shoulder prep — band external rotations'),
      node('Bench press — 3×6–10, double progression'),
      node('Bent-over row — 3×6–10'),
      node('Split squat / RFESS — 2×8–12/leg, light (knee-friendly)'),
      node('Face pulls or band pull-aparts — 2×15–20'),
      node('Pallof press or suitcase carry — 2 rounds'),
    ]),
    node('**Session B (Sun late, lower-lean)**', [
      node('Squat — 3×6–10, double progression'),
      node('Overhead press — 3×6–10'),
      node('Deadlift — 2×5–8'),
      node('Pull-ups — 3 sets, add weight at 3×8'),
      node('Waiter carry (one arm, overhead) — 2 lengths per side'),
    ]),
    node('**Mini day (Tue, optional)**', [
      node('Shoulder prep circuit + light cuff/scap sets'),
      node('Only rule: must feel easy'),
    ]),
    node('**Progression rules (double progression)**', [
      node('Each main lift lives in a rep range (6–10). Same weight until top of range on ALL sets → add 5 lb (upper) / 10 lb (lower) next session'),
    ]),
    node('**Re-entry protocol**', [
      node('Missed 1 session → repeat last session\'s weights'),
      node('1–2 weeks off → same weights, drop 1 set per lift first session'),
      node('2–4 weeks → 90% of last weights, normal sets; resume progression after 2 sessions'),
      node('1–2 months → 80%, 2 sets per lift week one, +5% per session until back'),
      node('2+ months / post-injury → 60%, 2 sets, reps 8–12, ramp 5–10%/session'),
    ]),
    node('**Dance-lift prep** — target: lift a ~120lb+ person', [
      node('Phase 1: Milestones: strict OHP 115–120×3, heavy waiter carries'),
      node('Phase 2: add push press. Milestone: ~135–150×2'),
    ]),
  ])

describe('parseExerciseLine', () => {
  it('reads sets and a rep range', () => {
    expect(parseExerciseLine('Bench press — 3×6–10, double progression', 'A', {upper: 5, lower: 10}))
      .toMatchObject({name: 'Bench press', sets: 3, repMin: 6, repMax: 10, increment: 5, freeform: false})
  })

  it('classifies lower-body lifts for the 10 lb increment', () => {
    expect(parseExerciseLine('Squat — 3×6–10', 'B', {upper: 5, lower: 10})?.increment).toBe(10)
    expect(parseExerciseLine('Deadlift — 2×5–8', 'B', {upper: 5, lower: 10})?.increment).toBe(10)
  })

  it('flags per-side work', () => {
    expect(parseExerciseLine('Split squat / RFESS — 2×8–12/leg', 'A', {upper: 5, lower: 10})?.perSide).toBe(true)
    expect(parseExerciseLine('Waiter carry — 2 lengths per side', 'B', {upper: 5, lower: 10})?.perSide).toBe(true)
  })

  it('strips a trailing parenthetical into the note, keeping the canonical name', () => {
    const waiter = parseExerciseLine('Waiter carry (one arm, overhead) — 2 lengths per side', 'B', {upper: 5, lower: 10})
    expect(waiter?.name).toBe('Waiter carry')
    expect(waiter?.perSide).toBe(true)
    expect(waiter?.note).toContain('one arm, overhead')
  })

  it('treats rounds/lengths work as freeform', () => {
    expect(parseExerciseLine('Pallof press — 2 rounds', 'A', {upper: 5, lower: 10})?.freeform).toBe(true)
  })

  it('skips warm-up lines', () => {
    expect(parseExerciseLine('Warm-up: shoulder prep', 'A', {upper: 5, lower: 10})).toBeNull()
  })

  it('lifts video links off the line and keeps prose clean', () => {
    const ex = parseExerciseLine(
      'Split squat / RFESS — 2×8–12/leg, light (knee-friendly) — [video](https://www.youtube.com/watch?v=lG3MsPmEQQk)',
      'A',
      {upper: 5, lower: 10},
    )
    expect(ex?.videos).toEqual([{label: 'video', url: 'https://www.youtube.com/watch?v=lG3MsPmEQQk'}])
    // the raw URL must not leak into the shown note
    expect(ex?.note).not.toContain('http')
    expect(ex?.note).toContain('video')
  })

  it('has no videos when the line has none', () => {
    expect(parseExerciseLine('Bench press — 3×6–10', 'A', {upper: 5, lower: 10})?.videos).toBeUndefined()
  })
})

describe('extractVideos', () => {
  it('pulls every markdown link as a label + url', () => {
    const videos = extractVideos(
      'Warm-up: [band ER](https://youtu.be/8UZT_SElGlc), [pull-aparts](https://www.youtube.com/watch?v=mHWlgqPvyxI)',
    )
    expect(videos).toEqual([
      {label: 'band ER', url: 'https://youtu.be/8UZT_SElGlc'},
      {label: 'pull-aparts', url: 'https://www.youtube.com/watch?v=mHWlgqPvyxI'},
    ])
  })

  it('ignores wikilinks and non-http bracket text', () => {
    expect(extractVideos('Squat [[health]] — heavy [see notes](notes)')).toEqual([])
  })
})

describe('parsePlan', () => {
  it('reads every session exercise from the outline', () => {
    const overlay = parsePlan(samplePlan())
    const names = overlay.exercises!.map(e => e.name)
    expect(names).toContain('Bench press')
    expect(names).toContain('Squat')
    expect(names).toContain('Overhead press')
    expect(overlay.exercises!.find(e => e.name === 'Squat')?.session).toBe('B')
  })

  it('reads the increments from the progression rules', () => {
    const overlay = parsePlan(samplePlan())
    expect(overlay.exercises!.find(e => e.name === 'Bench press')?.increment).toBe(5)
    expect(overlay.exercises!.find(e => e.name === 'Squat')?.increment).toBe(10)
  })

  it('reads the re-entry percentages from the table', () => {
    const overlay = parsePlan(samplePlan())
    const byId = new Map(overlay.reentry!.map(t => [t.id, t]))
    expect(byId.get('2-4w')?.pct).toBe(0.9)
    expect(byId.get('1-2mo')?.pct).toBe(0.8)
    expect(byId.get('2mo+')?.pct).toBe(0.6)
    expect(byId.get('2mo+')?.repMin).toBe(8)
    expect(byId.get('2mo+')?.repMax).toBe(12)
  })

  it('reads the milestone targets at the low end of a range', () => {
    const overlay = parsePlan(samplePlan())
    const ohp = overlay.milestones!.find(m => m.id === 'ohp-strict')
    expect(ohp).toMatchObject({weight: 115, reps: 3})
    const pushPress = overlay.milestones!.find(m => m.id === 'push-press')
    expect(pushPress).toMatchObject({weight: 135, reps: 2})
  })

  it('does not warn on a clean plan', () => {
    expect(parsePlan(samplePlan()).warnings).toHaveLength(0)
  })

  it('keeps the built-in list and warns when a session block is missing', () => {
    const plan = node('**Strength Plan v2**', [node('**Progression rules**', [])])
    const overlay = parsePlan(plan)
    expect(overlay.warnings.some(w => /session/i.test(w))).toBe(true)
  })
})

describe('mergePlan / configFromPlan', () => {
  it('produces a config the engine can consume', () => {
    const {config, warnings} = configFromPlan(samplePlan())
    expect(warnings).toHaveLength(0)
    expect(config.exercises.some(e => e.name === 'Bench press')).toBe(true)
    // Re-entry day boundaries are not in the plan, so the defaults survive.
    expect(config.reentry.find(t => t.id === '2-4w')?.maxGapDays).toBe(34)
  })

  it('does not clamp a lift to a single rep count when the plan states only a ceiling', () => {
    // "Pull-ups — 3 sets, add weight at 3×8" parses sets=3, reps 8/8 — a
    // ceiling, not a range. The 6–10 default window must survive.
    const {config} = configFromPlan(samplePlan())
    const pullups = config.exercises.find(e => e.name === 'Pull-ups')!
    expect(pullups.repMin).toBe(5)
    expect(pullups.repMax).toBe(8)
    expect(pullups.repMin! < pullups.repMax!).toBe(true)
  })

  it('overlays parsed fields over defaults, keeping unparsed fields', () => {
    const overlay = {
      exercises: [{name: 'Bench press', session: 'A' as const, sets: 4, repMin: 5, repMax: 8, increment: 5, perSide: false, freeform: false}],
      warnings: [],
    }
    const config = mergePlan(overlay)
    const bench = config.exercises.find(e => e.name === 'Bench press')!
    expect(bench.sets).toBe(4)
    expect(bench.repMax).toBe(8)
    // A lift the overlay didn't mention keeps its default.
    expect(config.exercises.some(e => e.name === 'Squat')).toBe(true)
  })
})
