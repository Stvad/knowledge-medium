/** Read the plan outline into program config.
 *
 *  The plan blocks are canonical and human-editable; this extension never
 *  writes to them. What it does is derive the machine-readable half —
 *  exercise lists, rep ranges, increments, the re-entry percentages — so
 *  "edit the program by editing your notes" actually works, both at first
 *  seed and later via re-sync.
 *
 *  The parser is deliberately conservative. Prose drifts; a regex that
 *  half-reads a line and silently overwrites a good value is worse than one
 *  that declines. So every rule is overlay-only: it emits a field just when
 *  it is confident, the caller merges the overlay over
 *  {@link DEFAULT_CONFIG}, and everything unparsed keeps its plan-faithful
 *  fallback. Anything skipped surfaces as a warning rather than vanishing.
 */

import type {
  ExerciseConfig,
  ExerciseVideo,
  Milestone,
  ProgramConfig,
  ReentryTier,
  SessionType,
} from '../engine/types'
import {DEFAULT_CONFIG} from './defaults'

const MD_LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g

/** Pull markdown links (`[label](https://…)`) out of a plan line as videos.
 *  The plan appends demo/technique links to exercise lines; we surface them
 *  as tappable links rather than raw URL text. */
export const extractVideos = (content: string): ExerciseVideo[] => {
  const videos: ExerciseVideo[] = []
  for (const m of content.matchAll(MD_LINK)) {
    videos.push({label: m[1].trim(), url: m[2]})
  }
  return videos
}

export interface PlanNode {
  id: string
  content: string
  children: readonly PlanNode[]
}

export interface PlanOverlay {
  exercises?: readonly ExerciseConfig[]
  reentry?: readonly ReentryTier[]
  milestones?: readonly Milestone[]
  sessionNotes?: Partial<Record<SessionType, readonly string[]>>
  warnings: readonly string[]
}

const DASH = '[—–-]'
/** `3×6–10`, `2×8–12/leg` */
const SETS_RANGE = new RegExp(String.raw`(\d+)\s*[×x]\s*(\d+)\s*${DASH}\s*(\d+)`)
/** `3×8`, `3×3–5` handled above first */
const SETS_SINGLE = /(\d+)\s*[×x]\s*(\d+)/
const BARE_SETS = /(\d+)\s+(?:sets?|rounds?|lengths?)\b/i
const PER_SIDE = /\/\s*leg|per\s+side|one\s+arm|each\s+side/i
const FREEFORM = /\brounds?\b|\blengths?\b|carry|carries/i
const LOWER_BODY = /squat|deadlift|rdl|hinge|lunge|leg press/i

/** Strip the outline's presentation syntax so matching sees plain prose.
 *  Markdown links collapse to their label (the URL is extracted separately as
 *  a video), wikilinks to their text, block refs drop out. */
export const plainText = (content: string): string =>
  content
    .replace(/\[([^\]]+)\]\((?:https?:\/\/[^)\s]+)\)/g, '$1')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\(\([^)]+\)\)/g, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const splitLine = (text: string): {name: string; rest: string} | null => {
  const match = new RegExp(String.raw`^(.+?)\s+${DASH}\s+(.*)$`).exec(text)
  if (!match) return null
  return {name: match[1].trim(), rest: match[2].trim()}
}

const findChild = (root: PlanNode, pattern: RegExp): PlanNode | undefined =>
  root.children.find(child => pattern.test(plainText(child.content)))

/** Increment is stated once in the plan ("+5 lb upper / 10 lb lower"), not
 *  per exercise, so classification is by movement name. */
const incrementFor = (name: string, upper: number, lower: number): number =>
  LOWER_BODY.test(name) ? lower : upper

export const parseExerciseLine = (
  content: string,
  session: SessionType,
  increments: {upper: number; lower: number},
): ExerciseConfig | null => {
  const text = plainText(content)
  if (/^warm-?up\b/i.test(text)) return null
  const split = splitLine(text)
  const rawName = split?.name ?? text
  if (!rawName) return null
  let rest = split?.rest ?? ''

  // Strip a trailing parenthetical from the name ("Waiter carry (one arm,
  // overhead)" → "Waiter carry") so the canonical name matches the defaults
  // and milestones; keep the cue by folding it into the note. Without this,
  // the plan's parenthetical cues would fork every such lift onto a name the
  // rest of the config never references.
  const paren = /\(([^)]*)\)\s*$/.exec(rawName)
  const name = rawName.replace(/\s*\([^)]*\)\s*$/, '').trim()
  if (!name) return null
  if (paren) rest = [paren[1].trim(), rest].filter(Boolean).join(' — ')

  const range = SETS_RANGE.exec(rest)
  const single = range ? null : SETS_SINGLE.exec(rest)
  const bare = range || single ? null : BARE_SETS.exec(rest)
  if (!range && !single && !bare) return null

  const sets = Number(range?.[1] ?? single?.[1] ?? bare?.[1])
  const repMin = range ? Number(range[2]) : single ? Number(single[2]) : undefined
  const repMax = range ? Number(range[3]) : single ? Number(single[2]) : undefined

  // Videos come from the raw content (plainText has already collapsed the
  // markdown links to their labels in `rest`).
  const videos = extractVideos(content)

  return {
    name,
    session,
    sets,
    repMin,
    repMax,
    increment: incrementFor(name, increments.upper, increments.lower),
    perSide: PER_SIDE.test(rest),
    freeform: repMax === undefined || FREEFORM.test(rest),
    note: rest || undefined,
    videos: videos.length > 0 ? videos : undefined,
  }
}

const parseIncrements = (root: PlanNode): {upper: number; lower: number} => {
  const section = findChild(root, /^progression rules/i)
  const fallbackUpper = 5
  const fallbackLower = 10
  if (!section) return {upper: fallbackUpper, lower: fallbackLower}
  for (const child of section.children) {
    const text = plainText(child.content)
    const match = /add\s+(\d+)\s*lb\s*\(upper\)\s*\/\s*(\d+)\s*lb\s*\(lower\)/i.exec(text)
    if (match) return {upper: Number(match[1]), lower: Number(match[2])}
  }
  return {upper: fallbackUpper, lower: fallbackLower}
}

const SESSION_HEADINGS: ReadonlyArray<{session: SessionType; pattern: RegExp}> = [
  {session: 'A', pattern: /^session a\b/i},
  {session: 'B', pattern: /^session b\b/i},
  {session: 'mini', pattern: /^mini day\b/i},
]

const parseSessions = (
  root: PlanNode,
  increments: {upper: number; lower: number},
  warnings: string[],
): {exercises: ExerciseConfig[]; notes: Partial<Record<SessionType, readonly string[]>>} => {
  const exercises: ExerciseConfig[] = []
  const notes: Partial<Record<SessionType, readonly string[]>> = {}

  for (const {session, pattern} of SESSION_HEADINGS) {
    const section = findChild(root, pattern)
    if (!section) {
      warnings.push(`No "${session}" session block found in the plan — keeping the built-in list.`)
      continue
    }
    // The mini day is the maintenance floor — deliberately freeform ("must
    // feel easy", carries, a couple of easy sets). Unquantified lines there
    // are expected, not parse failures, so we don't warn and we keep the
    // built-in mini list.
    const quantified = session !== 'mini'
    const sessionNotes: string[] = []
    let parsed = 0
    for (const child of section.children) {
      const text = plainText(child.content)
      if (/^warm-?up\b/i.test(text) || /^only rule\b/i.test(text)) {
        sessionNotes.push(text)
        continue
      }
      const exercise = parseExerciseLine(child.content, session, increments)
      if (exercise) {
        exercises.push(exercise)
        parsed += 1
      } else {
        sessionNotes.push(text)
        if (quantified) {
          warnings.push(`Session ${session}: could not read sets/reps from "${text}" — kept as a note.`)
        }
      }
    }
    if (parsed === 0 && quantified) {
      warnings.push(`Session ${session}: no exercises parsed — keeping the built-in list.`)
    }
    if (sessionNotes.length > 0) notes[session] = sessionNotes
  }

  return {exercises, notes}
}

const TIER_PATTERNS: ReadonlyArray<{id: string; pattern: RegExp}> = [
  {id: 'missed-1', pattern: /missed\s+1\s+session/i},
  {id: '1-2w', pattern: /^1\s*[–—-]\s*2\s+weeks?/i},
  {id: '2-4w', pattern: /^2\s*[–—-]\s*4\s+weeks?/i},
  {id: '1-2mo', pattern: /^1\s*[–—-]\s*2\s+months?/i},
  {id: '2mo\\+', pattern: /^2\+\s*months?/i},
]

/** Percentages, set counts and rep windows come from the plan text; the day
 *  boundaries and ramp lengths stay on the defaults, because the plan states
 *  gaps in weeks and never spells out either. */
const parseReentry = (root: PlanNode, warnings: string[]): ReentryTier[] | undefined => {
  const section = findChild(root, /^re-?entry protocol/i)
  if (!section) {
    warnings.push('No re-entry protocol block found — keeping the built-in table.')
    return undefined
  }

  const byId = new Map(DEFAULT_CONFIG.reentry.map(tier => [tier.id, tier]))
  let matched = 0

  for (const child of section.children) {
    const text = plainText(child.content)
    const arrow = text.split(/→|->/)
    if (arrow.length < 2) continue
    const [head, ...tailParts] = arrow
    const tail = tailParts.join(' ')
    const spec = TIER_PATTERNS.find(t => t.pattern.test(head.trim()))
    if (!spec) continue
    const id = spec.id.replace('\\', '')
    const base = byId.get(id)
    if (!base) continue

    const pct = /(\d+)%/.exec(tail)
    const setsOverride = /(\d+)\s+sets?\b/i.exec(tail)
    const setsDelta = /drop\s+(\d+)\s+set/i.exec(tail)
    const reps = new RegExp(String.raw`reps?\s+(\d+)\s*${DASH}\s*(\d+)`, 'i').exec(tail)
    const ramp = new RegExp(String.raw`(?:\+|ramp\s+)(\d+)(?:\s*${DASH}\s*(\d+))?%`, 'i').exec(tail)

    byId.set(id, {
      ...base,
      guidance: tail.trim() || base.guidance,
      pct: pct ? Number(pct[1]) / 100 : base.pct,
      setsOverride: setsOverride ? Number(setsOverride[1]) : base.setsOverride,
      setsDelta: setsDelta ? Number(setsDelta[1]) : base.setsDelta,
      repMin: reps ? Number(reps[1]) : base.repMin,
      repMax: reps ? Number(reps[2]) : base.repMax,
      rampPerSession: ramp
        // "5–10% per session" → take the midpoint; a single "+5%" is used as-is.
        ? (ramp[2] ? (Number(ramp[1]) + Number(ramp[2])) / 2 : Number(ramp[1])) / 100
        : base.rampPerSession,
    })
    matched += 1
  }

  if (matched === 0) {
    warnings.push('Re-entry rows did not match the expected "gap → prescription" shape.')
    return undefined
  }
  return [...byId.values()]
}

/** Only the two barbell dance-lift milestones are stated numerically enough
 *  to read. Everything else (heavy carries) keeps its default. */
const parseMilestones = (root: PlanNode): Milestone[] | undefined => {
  const section = findChild(root, /^dance-?lift prep/i)
  if (!section) return undefined
  const byId = new Map(DEFAULT_CONFIG.milestones.map(m => [m.id, m]))
  let matched = 0

  const readTarget = (text: string): {weight: number; reps: number} | null => {
    const m = new RegExp(String.raw`(\d+)(?:\s*${DASH}\s*(\d+))?\s*[×x]\s*(\d+)`).exec(text)
    if (!m) return null
    // Range targets ("115–120×3") take the low end: the milestone is hit at
    // the bottom of the band, not the top.
    return {weight: Number(m[1]), reps: Number(m[3])}
  }

  for (const child of section.children) {
    const text = plainText(child.content)
    if (/strict ohp/i.test(text)) {
      const target = readTarget(text.slice(text.search(/strict ohp/i)))
      const base = byId.get('ohp-strict')
      if (target && base) {
        byId.set('ohp-strict', {...base, ...target, label: text})
        matched += 1
      }
    }
    if (/push press/i.test(text)) {
      const target = readTarget(text.slice(text.search(/milestone/i) < 0 ? 0 : text.search(/milestone/i)))
      const base = byId.get('push-press')
      if (target && base) {
        byId.set('push-press', {...base, ...target, label: text})
        matched += 1
      }
    }
  }
  return matched > 0 ? [...byId.values()] : undefined
}

export const parsePlan = (root: PlanNode): PlanOverlay => {
  const warnings: string[] = []
  const increments = parseIncrements(root)
  const {exercises, notes} = parseSessions(root, increments, warnings)
  return {
    exercises: exercises.length > 0 ? exercises : undefined,
    reentry: parseReentry(root, warnings),
    milestones: parseMilestones(root),
    sessionNotes: Object.keys(notes).length > 0 ? notes : undefined,
    warnings,
  }
}

/** Merge an overlay over the defaults. Rep ranges are only taken from the
 *  plan when the parse produced a real window (`repMin < repMax`) — a line
 *  like "3 sets, add weight at 3×8" states a ceiling, not a range, and
 *  clamping the lift to a single rep count would quietly break double
 *  progression. */
export const mergePlan = (overlay: PlanOverlay, base: ProgramConfig = DEFAULT_CONFIG): ProgramConfig => {
  // Per-session replacement: the plan is authoritative for a session it
  // describes, so a parsed session's exercise list wholly replaces that
  // session's defaults — but a session the plan didn't parse (commonly the
  // freeform mini day) keeps its built-in list rather than being wiped.
  const overlaySessions = new Set((overlay.exercises ?? []).map(e => e.session))
  const merged = (overlay.exercises ?? []).map(parsed => {
    const fallback = base.exercises.find(e => e.name === parsed.name)
    if (!fallback) return parsed
    const hasRange =
      parsed.repMin !== undefined && parsed.repMax !== undefined && parsed.repMin < parsed.repMax
    return {
      ...fallback,
      ...parsed,
      repMin: hasRange ? parsed.repMin : fallback.repMin,
      repMax: hasRange ? parsed.repMax : fallback.repMax,
      note: parsed.note ?? fallback.note,
    }
  })
  const untouched = base.exercises.filter(e => !overlaySessions.has(e.session))
  const exercises = overlay.exercises ? [...merged, ...untouched] : base.exercises

  return {
    ...base,
    exercises,
    reentry: overlay.reentry ?? base.reentry,
    milestones: overlay.milestones ?? base.milestones,
    sessionNotes: {...base.sessionNotes, ...overlay.sessionNotes},
  }
}

export const configFromPlan = (root: PlanNode): {config: ProgramConfig; warnings: readonly string[]} => {
  const overlay = parsePlan(root)
  return {config: mergePlan(overlay), warnings: overlay.warnings}
}
