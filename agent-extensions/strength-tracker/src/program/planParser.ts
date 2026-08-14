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
  AltOption,
  ExerciseConfig,
  ExerciseVideo,
  Milestone,
  ProgramConfig,
  ReentryTier,
  SessionType,
} from '../engine/types'
import {altOptionKey} from '../engine/types'
import {ALT_GROUP_TYPE, EXERCISE_DEF_TYPE, FIELD, REENTRY_TIER_TYPE} from '../km/fields'
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
  /** The block's own property map, when the caller has one. Structured
   *  props (see the `strength:*` readers below) win over anything the
   *  prose regexes would otherwise infer from `content`. */
  properties?: Record<string, unknown>
}

export interface PlanOverlay {
  exercises?: readonly ExerciseConfig[]
  reentry?: readonly ReentryTier[]
  milestones?: readonly Milestone[]
  sessionNotes?: Partial<Record<SessionType, readonly string[]>>
  /** or-group key → the default option's key (its block id, or its name for
   *  an untyped plan), for every `or`-group the plan declared.
   *  `configFromPlan` resolves each group down to one exercise using this
   *  (overridable by an explicit runtime choice). */
  altDefaults?: Record<string, string>
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

// Typed property readers: undefined whenever the key is absent or holds the
// wrong type, so a mis-typed prop falls back to prose rather than throwing
// or silently coercing.
const numProp = (properties: Record<string, unknown> | undefined, key: string): number | undefined => {
  const value = properties?.[key]
  return typeof value === 'number' ? value : undefined
}
const strProp = (properties: Record<string, unknown> | undefined, key: string): string | undefined => {
  const value = properties?.[key]
  return typeof value === 'string' ? value : undefined
}
const boolProp = (properties: Record<string, unknown> | undefined, key: string): boolean | undefined => {
  const value = properties?.[key]
  return typeof value === 'boolean' ? value : undefined
}

/** The block's type membership. Read straight off the raw property map (the
 *  app stores types there) rather than via the runtime helper, to keep this
 *  module free of `@/` imports and testable in plain node. */
const nodeTypes = (node: PlanNode): readonly string[] => {
  const raw = node.properties?.[FIELD.blockTypes]
  return Array.isArray(raw) ? raw.filter((t): t is string => typeof t === 'string') : []
}

/** A block that *declares* itself an exercise — as opposed to one the prose
 *  rules merely read as one. A declaration is a promise the line is
 *  quantified, so failing to parse it is worth a warning. */
export const isExerciseDef = (node: PlanNode): boolean => nodeTypes(node).includes(EXERCISE_DEF_TYPE)

/** Parse one exercise block: structured `strength:*` properties first,
 *  prose (the `content` line, via the same regexes as before) filling in
 *  whatever a property didn't state. The description (`note`) and videos
 *  additionally pull from the node's own children, so a plan can carry a
 *  cue or a demo link as a sub-bullet instead of cramming it onto the line. */
export const parseExercise = (
  node: PlanNode,
  session: SessionType,
  increments: {upper: number; lower: number},
): ExerciseConfig | null => {
  const text = plainText(node.content)
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
  const proseSets = range || single || bare ? Number(range?.[1] ?? single?.[1] ?? bare?.[1]) : undefined
  const proseRepMin = range ? Number(range[2]) : single ? Number(single[2]) : undefined
  const proseRepMax = range ? Number(range[3]) : single ? Number(single[2]) : undefined

  const props = node.properties
  const sets = numProp(props, FIELD.targetSets) ?? proseSets
  // No sets from either source means there's nothing to prescribe — decline
  // rather than guess, same as the prose-only parser did.
  if (sets === undefined) return null

  const repMin = numProp(props, FIELD.repMin) ?? proseRepMin
  const repMax = numProp(props, FIELD.repMax) ?? proseRepMax
  const increment = numProp(props, FIELD.increment) ?? incrementFor(name, increments.upper, increments.lower)
  const perSide = boolProp(props, FIELD.perSide) ?? PER_SIDE.test(rest)
  const kind = strProp(props, FIELD.kind)
  const freeform = kind === 'carry' || kind === 'bodyweight' ? true : repMax === undefined || FREEFORM.test(rest)

  // Description: the line's own prose tail, plus every child's plain text —
  // a description sub-bullet ("light, knee-friendly") or a demo link lives
  // as a child rather than crowding the exercise line.
  const childNotes = node.children.map(child => plainText(child.content)).filter(Boolean)
  const noteParts = [rest, ...childNotes].filter(Boolean)

  // Videos come from the raw content (plainText collapses markdown links to
  // their labels) AND from every child's raw content.
  const videos = [...extractVideos(node.content), ...node.children.flatMap(child => extractVideos(child.content))]

  return {
    name,
    session,
    sets,
    repMin,
    repMax,
    increment,
    perSide,
    freeform,
    note: noteParts.length > 0 ? noteParts.join('\n') : undefined,
    catchUpIncrement: numProp(props, FIELD.catchUpIncrement),
    catchUpRpe: numProp(props, FIELD.catchUpRpe),
    videos: videos.length > 0 ? videos : undefined,
    // Only a real block can be referenced back to; the line-only wrapper
    // below passes an empty id and gets no definition link.
    defId: node.id || undefined,
  }
}

/** Thin prose-only wrapper kept for callers (and tests) that only have a
 *  line of text, no block/properties. */
export const parseExerciseLine = (
  content: string,
  session: SessionType,
  increments: {upper: number; lower: number},
): ExerciseConfig | null => parseExercise({id: '', content, children: []}, session, increments)

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

/** An `or`-group bullet names alternatives rather than a single exercise —
 *  its children are the options. Recognized by the block's type first, then
 *  by the older `strength:kind: alt-group` marker, then by prose. */
const isAltGroup = (node: PlanNode, text: string): boolean =>
  nodeTypes(node).includes(ALT_GROUP_TYPE) ||
  strProp(node.properties, FIELD.kind) === 'alt-group' ||
  /^(or|either)\b/i.test(text)

/** The option blocks of an `or`-group. Once any child declares itself an
 *  exercise definition, only the declared ones are options — that's what
 *  lets a group carry its own description bullet without it being read as a
 *  nameless third alternative. Untyped groups keep the old "every child is
 *  an option" rule. */
const altOptionNodes = (group: PlanNode): readonly PlanNode[] => {
  const declared = group.children.filter(isExerciseDef)
  return declared.length > 0 ? declared : group.children
}

/** Resolve a stored choice or default (`strength:default`, `altChoices`) to
 *  one option. A block id wins; a bare name still matches, so a hand-written
 *  plan — and anything chosen before the outline was typed — keeps working. */
const matchOption = <T extends AltOption>(
  options: readonly T[],
  wanted: string | undefined,
): T | undefined =>
  wanted === undefined || wanted === ''
    ? undefined
    : options.find(o => o.defId === wanted) ?? options.find(o => o.name === wanted)

const parseSessions = (
  root: PlanNode,
  increments: {upper: number; lower: number},
  warnings: string[],
): {
  exercises: ExerciseConfig[]
  notes: Partial<Record<SessionType, readonly string[]>>
  altDefaults: Record<string, string>
} => {
  const exercises: ExerciseConfig[] = []
  const notes: Partial<Record<SessionType, readonly string[]>> = {}
  const altDefaults: Record<string, string> = {}

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

      if (isAltGroup(child, text)) {
        // Every child is an option; all get parsed and emitted (each tagged
        // with the group key), and one is picked as the default. The flat
        // list carries every option through — resolving down to one
        // exercise per slot happens later, in configFromPlan, where an
        // explicit runtime choice can also override the default.
        const optionNodes = altOptionNodes(child)
        const options = optionNodes
          .map(option => parseExercise(option, session, increments))
          .filter((e): e is ExerciseConfig => e !== null)
        // An option that DECLARES itself an exercise but can't be read would
        // otherwise disappear from the switcher without a word — same reason a
        // declared exercise outside a group warns.
        for (const option of optionNodes) {
          if (!isExerciseDef(option)) continue
          if (parseExercise(option, session, increments)) continue
          warnings.push(
            `Session ${session}: or-group option "${plainText(option.content)}" could not be read — dropped from the choices.`,
          )
        }
        if (options.length === 0) {
          sessionNotes.push(text)
          if (quantified) {
            warnings.push(`Session ${session}: or-group "${text}" had no readable options — kept as a note.`)
          }
          continue
        }
        const optionRefs: AltOption[] = options.map(o => ({name: o.name, defId: o.defId}))
        const requestedDefault = strProp(child.properties, FIELD.altDefault)
        altDefaults[child.id] = altOptionKey(matchOption(optionRefs, requestedDefault) ?? optionRefs[0])
        for (const option of options) {
          exercises.push({...option, altGroupKey: child.id, altOptions: optionRefs})
          parsed += 1
        }
        continue
      }

      const exercise = parseExercise(child, session, increments)
      if (exercise) {
        exercises.push(exercise)
        parsed += 1
      } else {
        sessionNotes.push(text)
        // A block typed as an exercise definition is a claim that it *is*
        // one, so an unreadable line is worth flagging even on the mini day,
        // where unquantified prose is otherwise expected.
        if (quantified || isExerciseDef(child)) {
          warnings.push(`Session ${session}: could not read sets/reps from "${text}" — kept as a note.`)
        }
      }
    }
    if (parsed === 0 && quantified) {
      warnings.push(`Session ${session}: no exercises parsed — keeping the built-in list.`)
    }
    if (sessionNotes.length > 0) notes[session] = sessionNotes
  }

  return {exercises, notes, altDefaults}
}

/** A block that declares itself a row of the re-entry table. */
export const isReentryTier = (node: PlanNode): boolean =>
  nodeTypes(node).includes(REENTRY_TIER_TYPE)

interface TierRule {
  ok: (value: number) => boolean
  expected: string
}

const FRACTION: TierRule = {ok: v => v > 0 && v <= 1, expected: 'a fraction above 0 and at most 1 (90% is 0.9)'}
const RAMP: TierRule = {ok: v => v >= 0 && v <= 1, expected: 'a fraction from 0 to 1 (+5% per session is 0.05)'}
const COUNT: TierRule = {ok: v => Number.isInteger(v) && v > 0, expected: 'a whole number above 0'}
const DAYS: TierRule = {ok: v => v > 0, expected: 'a number of days above 0'}
const TALLY: TierRule = {ok: v => Number.isInteger(v) && v >= 0, expected: 'a whole number, 0 or more'}

/** One number off a tier row, with the three states kept apart.
 *
 *  ABSENT is a statement — "this row changes no set count" — and resolves to
 *  `absent`, which is the neutral value. PRESENT BUT OUT OF RANGE is a row we
 *  cannot read, and resolves to `base`: the built-in row's value, the same
 *  answer a contradiction gets and for the same reason. Collapsing the two
 *  would make a typo silently mean "no change", and for `strength:reentryPct`
 *  that is the direction that puts pre-break weight back on the bar.
 *
 *  Every field needs this because the seeded properties are plain number
 *  editors: nothing between the outline and here rejects `90` for a fraction,
 *  and the engine's own clamps then hide it. `factorFor` takes
 *  `Math.min(1, pct + …)`, so a percentage typed the way the row DISPLAYS it
 *  (`90`, from "90% of last weights") clamps to 1 and applies no cut at all —
 *  reading as "same weights" in the banner while the row says 90%. A negative
 *  `strength:setsDelta` inverts instead of clamping: `setsFor` computes
 *  `config.sets - delta`, so "-1" (a plausible way to write "one fewer") ADDS
 *  a set on the first session back. A fractional one survives all the way to
 *  the block expansion, where `i < 2.5` quietly stamps three. */
const tierNumber = <Fallback extends number | undefined>(
  props: Record<string, unknown> | undefined,
  key: string,
  rule: TierRule,
  // Generic over the fallbacks so the result is only optional when one of them
  // is: `maxGapDays` and `sessionsToNormal` fall back to a built-in row that
  // always states them, and the caller should not have to re-assert that with
  // a `?? 0` that can never fire.
  fallback: {id: string; base: Fallback; absent: Fallback},
  warnings: string[],
): number | Fallback => {
  const value = numProp(props, key)
  if (value === undefined) return fallback.absent
  if (!rule.ok(value)) {
    warnings.push(
      `Re-entry row "${fallback.id}": \`${key}\` is ${value}, expected ${rule.expected} — `
      + 'ignored, and the built-in row\'s value used instead.',
    )
    return fallback.base
  }
  return value
}

/** The re-entry table, read from the rows' properties.
 *
 *  Nothing here reads the sentence for a number, and that is the point. The
 *  prose form of this table said "drop 1 set per lift", which is a delta by
 *  intent and an absolute "1 set" by pattern; the two regexes that looked for
 *  each matched the same five words, and the absolute won — so a 3×6–10 press
 *  came back from a two-week trip prescribing a single set. There is no
 *  wording that makes that phrase unambiguous, so the numbers moved onto
 *  properties and the sentence became a label.
 *
 *  What a declared row states, it owns: an absent percentage means "same
 *  weights", an absent set field means "no change to the lift's own target".
 *  Deleting `strength:setsDelta` from a row removes the set cut rather than
 *  quietly restoring the built-in one — the outline is the program, so a
 *  field you can see is empty has to mean what it looks like. The exceptions
 *  are the two bounds the plan never spells out (it says "1–2 weeks", not a
 *  day count): `maxGapDays` and `sessionsToNormal` fall back to the built-in
 *  row of the same id. */
const parseReentry = (root: PlanNode, warnings: string[]): ReentryTier[] | undefined => {
  const section = findChild(root, /^re-?entry protocol/i)
  if (!section) {
    warnings.push('No re-entry protocol block found — keeping the built-in table.')
    return undefined
  }

  const rows = section.children.filter(isReentryTier)
  if (rows.length === 0) {
    warnings.push(
      `No re-entry row is typed \`${REENTRY_TIER_TYPE}\` — keeping the built-in table.`,
    )
    return undefined
  }

  const byId = new Map(DEFAULT_CONFIG.reentry.map(tier => [tier.id, tier]))
  let matched = 0

  for (const row of rows) {
    const text = plainText(row.content)
    const [head, ...tailParts] = text.split(/→|->/)
    const tail = tailParts.join(' ').trim()
    const props = row.properties

    // A typed row is a declaration, so a missing identity is worth a warning
    // rather than a silent skip — same rule as `isExerciseDef`.
    const id = strProp(props, FIELD.tierId)?.trim()
    if (!id) {
      warnings.push(`Re-entry row "${text}" has no \`${FIELD.tierId}\` — ignored.`)
      continue
    }
    // A row RE-STATES one of the built-in tiers; it cannot invent one.
    //
    // Inventing tiers was in the first draft of this and it earned its removal:
    // every field then had a "what if there is no built-in row to fall back
    // to" branch, and each one resolved to a neutral value — which for
    // `strength:reentryPct` means no load cut at all. A tier that exists to
    // reduce weight after a break, defaulting to reducing nothing, is the
    // exact silent direction this whole file is about. Nothing has ever
    // declared a custom tier, so the branch was carrying only risk.
    //
    // Nothing is lost that anyone was using: every number on all five rows is
    // editable, `maxGapDays` included, so "make 1–2 weeks end at 12 days" is
    // still one property. If a genuinely new row is ever wanted, add it to
    // `DEFAULT_REENTRY_TIERS` — a real instance can then say what a custom
    // tier's missing fields should mean, which is what this branch was
    // guessing at.
    const base = byId.get(id)
    if (!base) {
      warnings.push(
        `Re-entry row "${id}" is not one of the built-in tiers `
        + `(${[...byId.keys()].join(', ')}) — ignored. A row states the numbers for one of those.`,
      )
      continue
    }

    const maxGapDays = tierNumber(props, FIELD.maxGapDays, DAYS, {id, base: base.maxGapDays, absent: base.maxGapDays}, warnings)

    // Two ways to say how many sets, and a row states one. Resolving a row
    // that says both by precedence is how the original bug hid: the losing
    // statement stayed on screen, describing a prescription nobody got.
    const setsOverride = tierNumber(props, FIELD.targetSets, COUNT, {id, base: base.setsOverride, absent: undefined}, warnings)
    const setsDelta = tierNumber(props, FIELD.setsDelta, TALLY, {id, base: base.setsDelta, absent: undefined}, warnings)
    const contradicts = setsOverride !== undefined && setsDelta !== undefined
    if (contradicts) {
      warnings.push(
        `Re-entry row "${id}" states both \`${FIELD.targetSets}\` and \`${FIELD.setsDelta}\` — `
        + 'they mean different things (an absolute count vs. one dropped from each lift\'s own target), '
        + 'so the set counts come from the built-in row instead. Everything else this row states '
        + 'still applies. Keep one.',
      )
    }
    // Unreadable is not the same as absent: an absent field is a statement
    // ("no set change"), a contradiction is a pair of fields we cannot read.
    // So this one falls back to the built-in rather than to neutral — the
    // direction that keeps a cut in force instead of quietly removing one.
    //
    // Scoped to the set fields, and the warning says so. The row's percentage,
    // rep window and ramp are each individually readable, and dropping the
    // whole row over a set-field mistake would throw away a load cut the user
    // DID state — deciding what weight goes on a bar from an error in an
    // unrelated field.
    const sets = contradicts
      ? {
        setsOverride: base.setsOverride,
        setsOverrideSessions: base.setsOverrideSessions,
        setsDelta: base.setsDelta,
      }
      : {
        setsOverride,
        setsOverrideSessions: tierNumber(props, FIELD.setsOverrideSessions, TALLY, {id, base: base.setsOverrideSessions, absent: undefined}, warnings),
        setsDelta,
      }

    // A rep window is a PAIR, and each half passing on its own says nothing
    // about the pair. `mergePlan` already refuses an exercise range unless
    // `repMin < repMax`; a tier that overrides the window reached `repsFor`
    // with no such check, so 12–8 stamped sets at 8 while the row claimed 12.
    // Same fallback rule as everywhere here: unreadable takes the built-in.
    const statedRepMin = tierNumber(props, FIELD.repMin, COUNT, {id, base: base.repMin, absent: undefined}, warnings)
    const statedRepMax = tierNumber(props, FIELD.repMax, COUNT, {id, base: base.repMax, absent: undefined}, warnings)
    const invertedWindow = statedRepMin !== undefined && statedRepMax !== undefined
      && statedRepMin >= statedRepMax
    if (invertedWindow) {
      warnings.push(
        `Re-entry row "${id}": \`${FIELD.repMin}\` is ${statedRepMin} and \`${FIELD.repMax}\` is `
        + `${statedRepMax}, which is not a rising range — the built-in row's window used instead.`,
      )
    }

    byId.set(id, {
      id,
      label: head.trim() || base.label || id,
      maxGapDays,
      guidance: tail || base.guidance || '',
      pct: tierNumber(props, FIELD.layoffPct, FRACTION, {id, base: base.pct, absent: 1}, warnings),
      ...sets,
      repMin: invertedWindow ? base.repMin : statedRepMin,
      repMax: invertedWindow ? base.repMax : statedRepMax,
      sessionsToNormal: tierNumber(props, FIELD.sessionsToNormal, TALLY, {id, base: base.sessionsToNormal, absent: base.sessionsToNormal}, warnings),
      rampPerSession: tierNumber(props, FIELD.rampPerSession, RAMP, {id, base: base.rampPerSession, absent: 0}, warnings),
    })
    matched += 1
  }

  if (matched === 0) return undefined
  const table = [...byId.values()]

  // Two rows ending on the same day make one of them dead. `tierFor` sorts by
  // the bound and takes the FIRST match, and `Array#sort` is stable, so the
  // row earlier in this list wins every gap the other could have answered —
  // silently, and in the direction of whichever row happens to come first
  // rather than whichever is deeper. Editing `strength:maxGapDays` is how a
  // row ends up here (set 1–2w to 34 and it swallows 2–4w whole), which is a
  // plausible edit with an invisible outcome, so it is worth naming.
  const byBound = new Map<number, string>()
  for (const tier of table) {
    const first = byBound.get(tier.maxGapDays)
    if (first === undefined) byBound.set(tier.maxGapDays, tier.id)
    else {
      warnings.push(
        `Re-entry rows "${first}" and "${tier.id}" both end at ${tier.maxGapDays} days, so `
        + `"${tier.id}" can never be selected — every gap that reaches it is answered by `
        + `"${first}" first. Give them different \`${FIELD.maxGapDays}\` bounds.`,
      )
    }
  }
  return table
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
  const {exercises, notes, altDefaults} = parseSessions(root, increments, warnings)
  return {
    exercises: exercises.length > 0 ? exercises : undefined,
    reentry: parseReentry(root, warnings),
    milestones: parseMilestones(root),
    sessionNotes: Object.keys(notes).length > 0 ? notes : undefined,
    altDefaults: Object.keys(altDefaults).length > 0 ? altDefaults : undefined,
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

/** Resolve every `or`-group down to exactly one exercise per slot — the
 *  engine and the workout UI both want one prescription per session slot,
 *  not a menu. Preference order: an explicit runtime choice (`altChoices`,
 *  keyed by the group id), else the plan's own `strength:default`/first-
 *  option default (`altDefaults`), else the first option — each looked up by
 *  block id, falling back to name. The chosen exercise keeps its
 *  `altGroupKey`/`altOptions` so the UI can still offer a switch; the rest
 *  of the group is dropped. Order is preserved by keeping the winner at the
 *  group's first-appearance position. */
const resolveAltGroups = (
  config: ProgramConfig,
  altDefaults: Record<string, string>,
  altChoices: Record<string, string>,
): ProgramConfig => {
  const groups = new Map<string, ExerciseConfig[]>()
  for (const exercise of config.exercises) {
    if (!exercise.altGroupKey) continue
    const group = groups.get(exercise.altGroupKey)
    if (group) group.push(exercise)
    else groups.set(exercise.altGroupKey, [exercise])
  }
  if (groups.size === 0) return config

  const resolvedGroups = new Set<string>()
  const exercises = config.exercises.flatMap(exercise => {
    const key = exercise.altGroupKey
    if (!key) return [exercise]
    if (resolvedGroups.has(key)) return []
    resolvedGroups.add(key)

    const options = groups.get(key)!
    return [matchOption(options, altChoices[key]) ?? matchOption(options, altDefaults[key]) ?? options[0]]
  })

  return {...config, exercises}
}

export const configFromPlan = (
  root: PlanNode,
  altChoices: Record<string, string> = {},
): {config: ProgramConfig; warnings: readonly string[]} => {
  const overlay = parsePlan(root)
  const config = resolveAltGroups(mergePlan(overlay), overlay.altDefaults ?? {}, altChoices)
  return {config, warnings: overlay.warnings}
}
