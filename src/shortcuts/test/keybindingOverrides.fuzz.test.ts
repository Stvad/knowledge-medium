// @vitest-environment node
/**
 * Fuzz suite for the canonical-chord collision-strip contract between
 * `applyKeybindingOverrides` (src/shortcuts/applyKeybindingOverrides.ts)
 * and `keybindingConflicts` (src/shortcuts/keybindingConflicts.ts). See
 * `src/test/fuzz.ts` for smoke/deep tier mechanics and `docs/fuzzing.md`
 * for conventions.
 *
 * ──── Contract, grounded at the cited lines ────
 *
 * `applyKeybindingOverrides.ts:14-20` documents rule 2: "When some
 * override claims chord X for action B, any *other* action A whose
 * default binding includes X — in an overlapping context — loses that
 * chord." "Includes X" is a semantic (canonical-chord) statement, not a
 * textual one — `findKeybindingConflicts` (keybindingConflicts.ts:46-58)
 * buckets by `canonicalizeChord(chord)` specifically so that
 * alias-equivalent spellings ("the same chord authored two different
 * ways") land together; `applyKeybindingOverrides` is the other half of
 * the same contract (its own docblock cross-references "chord ⌘K" the
 * same way findKeybindingConflicts's comment does), so a spelling
 * difference must not let a collision survive undetected on either
 * side.
 *
 * `canonicalizeChord.ts` defines the equivalence classes this suite
 * exercises: modifier alias folding (`cmd`→`$mod` unconditionally;
 * `ctrl`/`control`→`Control`; `option`/`alt`→`Alt`; `meta`/`os`→`Meta`
 * off-Mac, i.e. always in this `@vitest-environment node` file, since
 * `platformPrimaryIsMeta()` reads `navigator` — canonicalizeChord.ts:80-83,
 * 106-108), case-insensitive modifier tokens (`resolveModifier` lowercases
 * before matching — canonicalizeChord.ts:110), a stable modifier *order*
 * regardless of authored order (`MODIFIER_ORDER` filter — canonicalizeChord.ts:
 * 103,142-144), and token-position independence within a press
 * (`parsePress` collects modifiers wherever they appear —
 * canonicalizeChord.ts:130-141). The final key's case folds to
 * lowercase for logical keys (tinykeys' `event.key` comparison is
 * case-insensitive) but is preserved for `event.code`-only tokens
 * (`CODE_ONLY_KEY` — `Digit1`/`Space`/`KeyA`/… dispatch through the
 * case-SENSITIVE `event.code` path, so their case is identity). The
 * generators below hold the key token fixed per canonical press and
 * only vary modifier spelling/order/case, which is sound under either
 * fold rule.
 *
 * ──── Properties ────
 *
 * 1-2. Warm-up: `canonicalizeChord` is idempotent on its own output, and
 *      folds every spelling of the same chord (mod alias/case/order,
 *      space-separated sequences) to one canonical string.
 * 3. Positive control: a directly-overridden action always ends up with
 *    the NORMALISED form of its override's binding
 *    (`normalizeChordSequence` — dispatch-live modifier names, key case
 *    preserved), regardless of any collision (rule 1 always wins).
 *    Normalised, not verbatim: rule 2's strip index buckets claims
 *    canonically, so a verbatim install let a dispatch-dead spelling
 *    (`ctrl+x` — tinykeys knows `Control`, not `ctrl`) strip a live
 *    `Control+x` default while itself never firing (issue #388, fixed
 *    by normalising at install). The 2b warm-up pins the seam this
 *    relies on: normalising never changes a chord's canonical bucket.
 * 4. The differential this suite exists for: no action that did NOT
 *    receive a direct override may keep a default chord that
 *    canonically collides — via `canonicalizeChord`, not raw string
 *    equality — with a chord some other override claims in an
 *    overlapping context (applyKeybindingOverrides.ts:14-20, context
 *    overlap per keybindingConflicts.ts's exported `contextsOverlap`,
 *    same rule as applyKeybindingOverrides.ts:44-45).
 *
 * ──── FIXED (fuzz): real product bug, found by this suite ────
 *
 * Property 4 was RED at authoring time. `applyKeybindingOverrides.ts`
 * built and queried `claimedByChord` using the RAW chord string as the
 * map key — `claimedByChord.set(chord, ...)` / `.get(chord)` at what
 * were then lines 85-97 and 138 — never calling `canonicalizeChord`.
 * `findKeybindingConflicts` (the sibling module implementing the *same*
 * documented collision notion) explicitly canonicalizes first
 * (keybindingConflicts.ts:54: `const key = canonicalizeChord(chord)`)
 * for exactly this reason, per its own comment: "alias-equivalent
 * chords (`Cmd+K` and `$mod+k`, or a reordered `Shift+$mod+k`) land
 * together" (keybindingConflicts.ts:46-47).
 *
 * Net effect: if an override claimed a chord for action B using a
 * different spelling than action A's default (case/order/alias — e.g.
 * default `Cmd+K`, override `$mod+K`), A's default survived
 * unstripped, and — since `findKeybindingConflicts` runs on the
 * post-override *effective* action list and correctly canonicalizes —
 * the settings UI's own conflict detector then reported A and B as
 * conflicting on that chord. That was precisely the state rule 2 exists
 * to prevent (`applyKeybindingOverrides.ts:14-20`): "any *other* action
 * A whose default binding includes [the claimed chord] ... loses that
 * chord."
 *
 * Minimal repro (hand-verified before writing the generators below,
 * pre-fix):
 *   actions: [{id: 'a', context: 'normal-mode', defaultBinding: {keys: 'Cmd+K'}},
 *             {id: 'b', context: 'normal-mode', defaultBinding: {keys: 'ctrl+x'}}]
 *   overrides: [{actionId: 'b', context: 'normal-mode', source: 'user-prefs',
 *                binding: {keys: '$mod+K'}}]
 *   applyKeybindingOverrides(actions, overrides)[0].defaultBinding
 *     → {keys: 'Cmd+K'}  (BUG: should have been stripped to `undefined`,
 *        since '$mod+K' canonicalizes identically to 'Cmd+K')
 *   findKeybindingConflicts(applyKeybindingOverrides(actions, overrides))
 *     → one conflict, chord 'Cmd+K', actions ['a','b']
 *       (the exact "both survive and collide" state rule 2 forbids)
 *
 * Fixed in `applyKeybindingOverrides.ts` (commit 4cae0fc2): both sides
 * of the `claimedByChord` index/lookup are now keyed by
 * `canonicalizeChord(chord)` instead of the raw string, the same way
 * `findKeybindingConflicts` does. Property 4 is green and now doubles
 * as the regression pin for this bug — a future red run here is a real
 * regression, not a documented known-red.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams } from '@/test/fuzz'
import { applyKeybindingOverrides } from '../applyKeybindingOverrides.ts'
import {
  KEYBINDING_OVERRIDE_USER_SOURCE,
  isKeyOverrideUnbound,
  type KeybindingOverride,
} from '../keybindingOverrides.ts'
import { canonicalizeChord, normalizeChordSequence, toChordArray } from '../canonicalizeChord.ts'
import { contextsOverlap, findKeybindingConflicts } from '../keybindingConflicts.ts'
import { ActionContextTypes, type ActionConfig, type ActionContextType } from '../types.ts'

// ──── Canonical-press model + spelling generators ────

type ModFamily = '$mod' | 'Control' | 'Alt' | 'Shift' | 'Meta'
const MODIFIER_FAMILIES: readonly ModFamily[] = ['$mod', 'Control', 'Alt', 'Shift', 'Meta']

/** Alias words per canonical family (canonicalizeChord.ts:110-122).
 *  `meta`/`os` fold to `Meta` here (not `$mod`) because this file runs
 *  `@vitest-environment node`, where `navigator` is undefined and
 *  `platformPrimaryIsMeta()` (canonicalizeChord.ts:80-83) is always
 *  false. */
const ALIAS_WORDS: Record<ModFamily, readonly string[]> = {
  '$mod': ['$mod', 'cmd'],
  Control: ['ctrl', 'control'],
  Alt: ['alt', 'option'],
  Shift: ['shift'],
  Meta: ['meta', 'os'],
}

/** `resolveModifier` lowercases the token before matching
 *  (canonicalizeChord.ts:110), so any casing of an alias word resolves
 *  the same — these three variants exercise that fold. */
const caseVariants = (word: string): readonly string[] => {
  const lower = word.toLowerCase()
  const upper = word.toUpperCase()
  const title = lower.length > 0 ? lower[0]!.toUpperCase() + lower.slice(1) : lower
  return Array.from(new Set([lower, upper, title]))
}

const ALIAS_SPELLINGS: Record<ModFamily, readonly string[]> = Object.fromEntries(
  MODIFIER_FAMILIES.map(family => [family, ALIAS_WORDS[family].flatMap(caseVariants)]),
) as unknown as Record<ModFamily, readonly string[]>

/** Keys held fixed across spellings of "the same" press. Logical keys
 *  now case-fold (so varying case WOULD stay equivalent for them), but
 *  `CODE_ONLY_KEY` tokens don't — holding the token fixed keeps the
 *  generator sound for every pool entry without special-casing. */
const KEY_POOL = ['k', 'a', 'x', 'q', '1', 'ArrowUp', 'F2'] as const

interface CanonicalPress {
  readonly mods: readonly ModFamily[]
  readonly key: string
}

const canonicalPressArb: fc.Arbitrary<CanonicalPress> = fc.record({
  mods: fc.uniqueArray(fc.constantFrom(...MODIFIER_FAMILIES), {maxLength: 3}),
  key: fc.constantFrom(...KEY_POOL),
})

/** One textual spelling of `press`: a random alias+case per modifier,
 *  in random token order — `parsePress` collects modifiers wherever
 *  they appear in the `+`-joined tokens and reorders them into
 *  `MODIFIER_ORDER` (canonicalizeChord.ts:124-144), so authored order
 *  must not affect the canonical result. Two independent draws of this
 *  arbitrary for the same `press` are, by `canonicalizeChord`'s own
 *  contract, canonically equal but very likely textually different. */
const spellPressArb = (press: CanonicalPress): fc.Arbitrary<string> =>
  fc.tuple(...press.mods.map(m => fc.constantFrom(...ALIAS_SPELLINGS[m])))
    .chain(modTokens => fc.shuffledSubarray([...modTokens, press.key], {
      minLength: modTokens.length + 1,
      maxLength: modTokens.length + 1,
    }))
    .map(tokens => tokens.join('+'))

/** A chord *sequence* (space-separated presses, e.g. `'g g'` or
 *  `'Cmd+K Cmd+S'`) — canonicalizeChord.ts:146-147 splits on space
 *  before canonicalizing each press, which is the gap the module's own
 *  docblock says used to be mishandled by a naive `+`-only split. */
const canonicalChordArb: fc.Arbitrary<readonly CanonicalPress[]> =
  fc.array(canonicalPressArb, {minLength: 1, maxLength: 3})

const spellChordArb = (presses: readonly CanonicalPress[]): fc.Arbitrary<string> =>
  fc.tuple(...presses.map(p => spellPressArb(p))).map(spellings => spellings.join(' '))

// ──── Property 1-2: canonicalizeChord warm-up ────

describe('canonicalizeChord', () => {
  it('is idempotent on its own output (canonicalizeChord.ts:159-168 — re-canonicalizing an already-canonical string is a no-op)', () => {
    fc.assert(
      fc.property(
        canonicalChordArb.chain(presses => spellChordArb(presses)),
        raw => {
          const once = canonicalizeChord(raw)
          expect(canonicalizeChord(once)).toBe(once)
        },
      ),
      fuzzParams(200),
    )
  })

  it('folds every spelling of the same chord to one canonical key — modifier alias/case/order, sequence-aware (canonicalizeChord.ts:96-108,124-147,159-168)', () => {
    fc.assert(
      fc.property(
        canonicalChordArb.chain(presses =>
          fc.record({
            rawA: spellChordArb(presses),
            rawB: spellChordArb(presses),
          }),
        ),
        ({rawA, rawB}) => {
          expect(canonicalizeChord(rawA)).toBe(canonicalizeChord(rawB))
        },
      ),
      fuzzParams(200),
    )
  })

  // 2b. The install seam rule 1 relies on (see property 3): normalising a
  // chord for install never moves it to a different canonical bucket, so
  // what rule 2's strip index claims is exactly what dispatch receives.
  it('normalizeChordSequence is canonical-preserving: canonicalizeChord(normalizeChordSequence(c)) === canonicalizeChord(c)', () => {
    fc.assert(
      fc.property(
        canonicalChordArb.chain(presses => spellChordArb(presses)),
        raw => {
          expect(canonicalizeChord(normalizeChordSequence(raw))).toBe(canonicalizeChord(raw))
        },
      ),
      fuzzParams(200),
    )
  })
})

// ──── Property 3-4 generators: actions + overrides ────

const CONTEXT_POOL: readonly ActionContextType[] = [
  ActionContextTypes.GLOBAL,
  ActionContextTypes.NORMAL_MODE,
  ActionContextTypes.EDIT_MODE_CM,
  'plugin-scope-x',
]
const contextArb: fc.Arbitrary<ActionContextType> = fc.constantFrom(...CONTEXT_POOL)

interface GenPress {
  readonly canonical: CanonicalPress
  readonly raw: string
}

interface GenAction {
  readonly id: string
  readonly context: ActionContextType
  readonly presses: readonly GenPress[]
}

/** `n` actions with distinct ids (one context per id — the "same id,
 *  multiple contexts" fallback path in applyKeybindingOverrides.ts:70-81
 *  is a separate, already-covered concern; keeping ids 1:1 with actions
 *  here keeps this suite's oracle focused on the canonical-chord axis). */
const genActionsArb = (n: number): fc.Arbitrary<readonly GenAction[]> =>
  fc.tuple(...Array.from({length: n}, (_, i) =>
    fc.record({context: contextArb, pressCount: fc.integer({min: 0, max: 2})}).chain(
      ({context, pressCount}) =>
        fc.array(
          canonicalPressArb.chain(canonical => spellPressArb(canonical).map(raw => ({canonical, raw}))),
          {minLength: pressCount, maxLength: pressCount},
        ).map((presses): GenAction => ({id: `action-${i}`, context, presses})),
    ),
  ))

/** A plain no-op stands in for the handler — never invoked by
 *  `applyKeybindingOverrides` (a pure rewrite of the binding metadata),
 *  and a `vi.fn()` per generated action would register a spy per fast-check
 *  case; over a deep-tier run's iteration count that leaks (OOMs) via
 *  vitest's mock-restore registry, so a plain function is the right tool
 *  here, not a style regression from the example-based tests' `vi.fn()`. */
const noopHandler = (): void => {}

const toActionConfig = (a: GenAction): ActionConfig => ({
  id: a.id,
  context: a.context,
  description: a.id,
  handler: noopHandler,
  defaultBinding: a.presses.length === 0 ? undefined : {
    keys: a.presses.length === 1 ? a.presses[0]!.raw : a.presses.map(p => p.raw),
  },
})

interface OverrideSpec {
  readonly targetIndex: number
  readonly explicitContext: ActionContextType | undefined
  readonly unbound: boolean
  readonly press: CanonicalPress
}

/** `m` overrides targeting random existing actions. The chord pool
 *  favours reusing a `CanonicalPress` already present in some action's
 *  default (to actually generate canonical-collision cases — the
 *  scenario property 4 exists to check) but also draws fresh presses
 *  (noise / no-collision cases), and re-spells whatever press is picked
 *  independently, so it's very likely a different spelling than
 *  wherever else that press occurs. */
const overridesArb = (actions: readonly GenAction[], m: number): fc.Arbitrary<readonly KeybindingOverride[]> => {
  const pool = actions.flatMap(a => a.presses.map(p => p.canonical))
  const pressArb: fc.Arbitrary<CanonicalPress> = pool.length > 0
    ? fc.oneof(fc.constantFrom(...pool), canonicalPressArb)
    : canonicalPressArb

  return fc.array(
    fc.record({
      targetIndex: fc.integer({min: 0, max: actions.length - 1}),
      explicitContext: fc.option(contextArb, {nil: undefined}),
      unbound: fc.boolean(),
      press: pressArb,
    }).chain((spec: OverrideSpec) =>
      spec.unbound
        ? fc.constant({...spec, raw: undefined as string | undefined})
        : spellPressArb(spec.press).map(raw => ({...spec, raw})),
    ),
    {minLength: 0, maxLength: m},
  ).map(specs => specs.map((spec): KeybindingOverride => ({
    actionId: actions[spec.targetIndex]!.id,
    context: spec.explicitContext,
    source: KEYBINDING_OVERRIDE_USER_SOURCE,
    binding: spec.unbound ? {unbound: true} : {keys: spec.raw!},
  })))
}

interface FuzzCase {
  readonly genActions: readonly GenAction[]
  readonly overrides: readonly KeybindingOverride[]
}

const caseArb: fc.Arbitrary<FuzzCase> = fc.integer({min: 1, max: 5}).chain(n =>
  genActionsArb(n).chain(genActions =>
    fc.integer({min: 0, max: 5}).chain(m =>
      overridesArb(genActions, m).map((overrides): FuzzCase => ({genActions, overrides})),
    ),
  ),
)

/** Last matching entry wins (applyKeybindingOverrides.ts:112-117). */
const directOverrideFor = (
  overrides: readonly KeybindingOverride[],
  action: Pick<ActionConfig, 'id' | 'context'>,
): KeybindingOverride | undefined => {
  let direct: KeybindingOverride | undefined
  for (const o of overrides) {
    if (o.actionId === action.id && (o.context === undefined || o.context === action.context)) direct = o
  }
  return direct
}

// ──── Property 3: positive control ────

describe('applyKeybindingOverrides', () => {
  it('a directly-overridden action always gets the normalised form of its override\'s binding, regardless of any collision (rule 1 + issue #388: normalised install, never verbatim)', () => {
    fc.assert(
      fc.property(caseArb, ({genActions, overrides}) => {
        const actionConfigs = genActions.map(toActionConfig)
        const out = applyKeybindingOverrides(actionConfigs, overrides)
        const outById = new Map(out.map(a => [a.id, a]))

        for (const action of actionConfigs) {
          const direct = directOverrideFor(overrides, action)
          if (!direct) continue
          const result = outById.get(action.id)!
          if (isKeyOverrideUnbound(direct.binding)) {
            expect(result.defaultBinding).toBeUndefined()
          } else {
            // Normalised install is the #388 contract: the installed form
            // shares the raw spelling's canonical bucket (property 2b) and
            // uses dispatch-live modifier names, so a rule-2 claim can
            // never out-live its own binding's liveness.
            expect(toChordArray(result.defaultBinding!.keys))
              .toEqual(toChordArray(direct.binding.keys).map(chord => normalizeChordSequence(chord)))
          }
        }
      }),
      fuzzParams(300),
    )
  })

  // ──── Property 4: the differential this suite exists for ────
  //
  // FIXED (fuzz): was RED at authoring — real product bug, see the
  // docblock at the top of this file for the confirmed root cause,
  // minimal repro, and the fix (applyKeybindingOverrides.ts, commit
  // 4cae0fc2: `claimedByChord` now keys by `canonicalizeChord(chord)`).
  // Green since; now the regression pin for that bug.
  it('no non-directly-overridden action keeps a default chord that canonically collides with an override-claimed chord in an overlapping context (applyKeybindingOverrides.ts:14-20; canonical + overlap rule per keybindingConflicts.ts:46-58,31-32)', () => {
    fc.assert(
      fc.property(caseArb, ({genActions, overrides}) => {
        const actionConfigs = genActions.map(toActionConfig)
        const out = applyKeybindingOverrides(actionConfigs, overrides)
        const contextById = new Map(genActions.map(a => [a.id, a.context] as const))

        for (const action of out) {
          if (directOverrideFor(overrides, action)) continue
          if (!action.defaultBinding) continue

          for (const survivorChord of toChordArray(action.defaultBinding.keys)) {
            const survivorCanon = canonicalizeChord(survivorChord)

            for (const o of overrides) {
              if (isKeyOverrideUnbound(o.binding)) continue
              const claimCtx = o.context ?? contextById.get(o.actionId)
              if (claimCtx === undefined || !contextsOverlap(claimCtx, action.context)) continue

              for (const claimedChord of toChordArray(o.binding.keys)) {
                if (canonicalizeChord(claimedChord) !== survivorCanon) continue
                throw new Error(
                  `action "${action.id}" (context ${String(action.context)}) kept default chord ` +
                  `"${survivorChord}" (canonical "${survivorCanon}"), but override on ` +
                  `"${o.actionId}" (claim context ${String(claimCtx)}) claims the canonically-equal ` +
                  `chord "${claimedChord}" in an overlapping context — should have been stripped ` +
                  `per applyKeybindingOverrides.ts:14-20.`,
                )
              }
            }
          }
        }
      }),
      fuzzParams(300),
    )
  })

  // Sanity: findKeybindingConflicts on the SAME buggy output corroborates
  // property 4's finding independently — when it fires, the settings UI's
  // own (correctly canonicalizing) conflict detector sees the collision
  // that survived. Not an independent oracle on `applyKeybindingOverrides`
  // (it shares `canonicalizeChord`/`contextsOverlap` with property 4's
  // model) — kept as a documented cross-check, not a fifth assertion of
  // the same fact under a different name.
  it('regression cross-check: a differently-spelled override strips the canonical-equal default, so the settings UI sees no conflict', () => {
    // The fuzz suite's original minimized find: b's override '$mod+K'
    // is canonically Cmd+K, so a's default 'Cmd+K' must be stripped
    // (rule 2, applyKeybindingOverrides.ts:14-20). Pre-fix the claim map
    // compared raw strings, both bindings stayed live, and
    // findKeybindingConflicts (which canonicalizes) reported the
    // collision the strip pass exists to prevent.
    const actions: ActionConfig[] = [
      {id: 'a', context: ActionContextTypes.NORMAL_MODE, description: 'a', handler: noopHandler, defaultBinding: {keys: 'Cmd+K'}},
      {id: 'b', context: ActionContextTypes.NORMAL_MODE, description: 'b', handler: noopHandler, defaultBinding: {keys: 'ctrl+x'}},
    ]
    const overrides: KeybindingOverride[] = [{
      actionId: 'b',
      context: ActionContextTypes.NORMAL_MODE,
      source: KEYBINDING_OVERRIDE_USER_SOURCE,
      binding: {keys: '$mod+K'},
    }]
    const out = applyKeybindingOverrides(actions, overrides)
    expect(out[0]!.defaultBinding, "a's canonical-equal default is stripped").toBeUndefined()
    expect(findKeybindingConflicts(out)).toHaveLength(0)
  })
})
