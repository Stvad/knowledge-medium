/**
 * §9 orphan-definition synthesis: give every definition-less cell key a
 * definition block, so "every key resolves a definition" can be an INVARIANT
 * rather than a branch every consumer has to carry.
 *
 * A key nothing declares — historic residue, a plugin disabled before the
 * unification's cutover, a dormant dynamic extension, a raw bag writer — is
 * the one class of property data a flipped workspace cannot make
 * child-backed: `materializePropertyChildrenForExistingRow` resolves the name,
 * gets nothing, and correctly skips the cell rather than inventing data. Left
 * alone the key rides the cell forever, which the §11 column drop can't allow.
 *
 * So the minting happens HERE instead, as an explicit operator step before
 * the flip — where it can refuse the keys it must not mint for, report the
 * ones it fudged, and be looked at before anything irreversible happens.
 *
 * ORDER MATTERS, and it is the operator's to get right: if an EXTENSION owns a
 * key, install/enable it first so its seed materializes the definition — for a
 * SEED owner. Doing it the other way round leaves two definitions in the
 * winner machinery, with field rows stranded on the loser's fieldId.
 *
 * A `defineProperty` owner (a plain schema with no definition block — one of
 * the exact shapes that produces an orphan key) is different: `allowUnregisteredPlainSchemas`
 * admits its writes while nothing claims the name, but once a definition
 * exists `resolveBoundary` finds a winner that isn't the caller's schema and
 * every write starts failing `shadowed`. Enabling it first does NOT help here:
 * `resolveName` sees only definition blocks and seeds, so a live plain schema
 * stays invisible and the key stays a candidate either way — there is no
 * registry of plain-schema owners to consult, that being what makes them
 * plain. The gap is tracked separately; the ordering advice above is honest
 * only for SEED owners.
 *
 * `audit-properties` names the owner where it can.
 */

import {
  ChangeScope, propertyValue,
  type AnyPropertySchema, type AnyValuePresetCore, type BlockData,
} from '@/data/api'
import { PROPERTY_SCHEMA_TYPE } from '@/data/blockTypes'
import { classifyOccupant, derivedBlockId } from '@/data/derivedIds'
import { kernelValuePresetCoresById } from '@/data/kernelValuePresetCores'
import { keyAtEnd } from '@/data/orderKey'
import { parsePropertyDefinitionMetadata } from '@/data/propertyDefinitionMetadata'
import {
  presetConfigProp,
  presetIdProp,
  propertyDefaultProp,
  propertyHiddenProp,
  propertyNameProp,
} from '@/data/properties'
import { getOrCreatePropertiesPage, propertiesPageBlockId } from '@/data/propertiesPage'
import { peekRowProperty } from '@/data/rowProperty'
import { isGrammarShapedLabel } from '@/data/referenceBlock'
import type { PropertyDefinitionRegistrySnapshot } from '@/data/propertyDefinitionRegistry'
import type { Repo } from '@/data/repo'
import { readWorkspaceEncryptionMode } from '@/data/workspaceSchema'
import { getModePin } from '@/sync/keys/modePin'
import { jsonValuesEqual } from '@/data/internals/jsonCanonical'
import {
  encodedPropertyValueToChildContent, propertyChildContentToEncodedValue,
} from '@/data/propertyChildren'
import {
  OBJECT_BAG, keyOf, requirePropertyRegistryFor, scanPropertyKeys,
  type UnresolvedPropertyKey,
} from './propertyKeyScan'

/** Namespace for synthesized property definitions. Deliberately NOT
 *  `DEFINITION_SEED_NS`: that one hashes `${workspaceId}:${seedKey}` and its
 *  disjointness proof rests on the two seed-key grammars. A synthesized key
 *  is a raw cell key with no grammar at all — one literally spelled
 *  `system:todo/property/done` would land on that seed's id. */
const SYNTHESIZED_DEFINITION_NS = 'b1d6b0c7-6a2a-4c1e-9a19-2f0f7b6b3c41'

/** Where a synthesized definition for `key` lives, on every device.
 *
 *  Deterministic so a re-run converges on the same block instead of minting a
 *  second definition for a name that now has one — and so two devices running
 *  the gesture concurrently agree, rather than producing same-named rivals
 *  whose loser strands whatever field rows bound to it. */
export const synthesizedPropertyDefinitionBlockId = (
  workspaceId: string,
  key: string,
): string => derivedBlockId({
  namespace: SYNTHESIZED_DEFINITION_NS,
  // Both halves escaped, per `derivedIds.ts`'s rule for a key carrying
  // user-supplied text: the cell key IS user text and `:` is the separator, so
  // unescaped, workspace `a:b` + key `c` and workspace `a` + key `b:c` hash to
  // one id. Unreachable while workspace ids are UUIDs — the same defensive
  // encoding `modePin.ts` applies for the same reason.
  key: `${encodeURIComponent(workspaceId)}:${encodeURIComponent(key)}`,
})

/** The presets synthesis will pick — chosen because each round-trips a stored
 *  value unchanged through `encodedValueToContent` → `contentToEncodedValue`;
 *  see {@link provePresetId} for why that is the selection criterion.
 *
 *  One exception, tracked in #688 and not this module's to fix: a `string`
 *  value that is itself field-form content round-trips to nothing. Synthesis
 *  widens the set that can bite, because these keys come from writers nothing
 *  vetted. */
export type SynthesizedPresetId = 'boolean' | 'number' | 'string' | 'raw-json'

/** Tried narrowest-first; the first that carries every stored value wins.
 *  `raw-json` is last and is the widest, but it is not a catch-all: it cannot
 *  express a non-finite number, and it is only ever selected by the same proof
 *  as the rest. */
const PRESET_LADDER: readonly SynthesizedPresetId[] =
  ['boolean', 'number', 'string', 'raw-json']

/** Distinct values we will read per key to prove a preset.
 *
 *  Not a sampling cap — sampling would put the guessing back. A key with more
 *  distinct values than this is not checked and so is not proven, which makes
 *  it a blocker: this module hands out no codec it has not run. Measured on a
 *  ~360k-cell production graph the heaviest key of any kind has ~26k distinct
 *  values and the unregistered ones had 23 between them, so this bounds a case
 *  that does not arise rather than trimming one that does. */
export const PROVE_DISTINCT_VALUE_LIMIT = 10_000

/**
 * Which preset can carry every value this key already holds — PROVEN, by
 * running the round trip, not inferred from what the values look like.
 *
 * The criterion is "which codec reads every stored value back out UNCHANGED":
 * the definition is applied retroactively, and past the flip the cell is
 * re-derived from the children, so a lossy round trip rewrites the user's data.
 *
 * Do NOT replace this with a histogram of JSON types: what breaks a round trip
 * is not something a value LOOKS like. `date` needs no special case here, for
 * instance — it simply fails, because `codecs.date` re-encodes `"2026-08-20"`
 * as `"2026-08-20T00:00:00.000Z"`.
 *
 * WHAT THIS DOES NOT PROVE: only the JS half. Content that survives here can
 * still be transformed at the database text boundary or by a processor —
 * see #688 — which is why that stays tracked separately rather than papered
 * over here.
 *
 * And it proves things about values AS JAVASCRIPT SEES THEM. Anything the
 * JSON-to-JS boundary has already collapsed is invisible here — and equally
 * invisible to the rest of the app, which reads the same cells through the same
 * boundary. Measured: a stored `9007199254740993` arrives from both `json_each`
 * and `json_extract` as `9007199254740992`, so no reader can tell the two
 * apart. Reproducing that distinction here would mean parsing numeric tokens
 * out of the raw JSON text, to refuse a key over a difference nothing in this
 * app can observe. Accepted deliberately, tracked as #712. Do not add a fourth
 * value-shape special case without checking which side of this line it falls
 * on — see `containsNonFinite` and its `-0` note below for where that line
 * runs today.
 */
export const provePresetId = (
  values: readonly unknown[],
  usable: readonly SynthesizedPresetId[] = PRESET_LADDER,
): SynthesizedPresetId | undefined => {
  for (const presetId of usable) {
    // The name is irrelevant here: the child round trip keys on `codec.type`.
    const schema = schemaFor('probe', kernelValuePresetCoresById[presetId])
    if (values.every(value => survivesChildRoundTrip(schema, value))) return presetId
  }
  // Undefined, NOT a `raw-json` fallback. `raw-json` is `JSON.stringify` /
  // `JSON.parse`, so reaching here means no codec in this app carries these
  // values — a key whose only honest answer is that it cannot be migrated
  // faithfully, not one to hand a codec that will quietly change it.
  return undefined
}

/** Does this preset id still MEAN the kernel core this pass reasons about?
 *
 *  `valuePresetCoresFacet` is last-wins, so an extension contributing `string`
 *  leaves the projector rebuilding a definition row with ITS codec — while
 *  everything here, from the round-trip proof to the schema it publishes, is
 *  built from the kernel core. Both the mint path and the converged path have
 *  to ask, so they ask the same question here. */
const isKernelPreset = (repo: Repo, id: string): boolean =>
  repo.valuePresetCores.get(id) ===
    (kernelValuePresetCoresById as Record<string, AnyValuePresetCore>)[id]

/** The ladder entries that still mean what the proof runs against. An
 *  overridden id is dropped from the ladder rather than refused
 *  workspace-wide: an override of a preset no candidate selects is nobody's
 *  problem, and gating the whole gesture on it stopped clean workspaces
 *  migrating. */
const usablePresets = (repo: Repo): SynthesizedPresetId[] =>
  PRESET_LADDER.filter(id => isKernelPreset(repo, id))

/** Is there a non-finite number ANYWHERE in this value?
 *
 *  The proof's own blind spot, asked before the proof runs. `jsonValuesEqual`
 *  compares canonical JSON, where `Infinity` and `null` both read as "null" —
 *  so a value carrying one certifies a round trip that actually replaced it
 *  with null. `1e400` parses to `Infinity` at every boundary that reaches us
 *  (SQLite's and `JSON.parse`'s alike), and no codec here carries one.
 *  Recursive because nesting is the same bug, not a special case of it:
 *  `{"n": 1e400}` re-encodes as `{"n": null}` and compares equal too.
 *
 *  `-0` is deliberately NOT rejected, though it round trips to `0` by the same
 *  mechanism: the two are `===`, render identically, and no property means one
 *  and not the other — blocking the key would cost more than the change does. */
const containsNonFinite = (value: unknown): boolean => {
  if (typeof value === 'number') return !Number.isFinite(value)
  if (Array.isArray(value)) return value.some(containsNonFinite)
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some(containsNonFinite)
  }
  return false
}

/** Does one stored value come back byte-identical through the child machinery
 *  this preset would use? */
const survivesChildRoundTrip = (schema: AnyPropertySchema, encoded: unknown): boolean => {
  if (containsNonFinite(encoded)) return false
  try {
    const content = encodedPropertyValueToChildContent(schema, encoded)
    return jsonValuesEqual(propertyChildContentToEncodedValue(schema, content), encoded)
  } catch {
    return false
  }
}

/** A key synthesis will mint a definition for. */
export interface SynthesisCandidate {
  key: string
  cells: number
  presetId: SynthesizedPresetId
}

/** A key no definition can ever back.
 *
 *  The consequence, stated once here rather than at every site that reads this:
 *  such a key makes "every cell key resolves a definition" unsatisfiable
 *  FOREVER, and at `cell-off` the column drop would take the value's only
 *  carrier with it. So it blocks the flip, and only the flip — minting the
 *  other keys' definitions is useful either way. */
export interface SynthesisBlocker {
  key: string
  cells: number
  reason: string
}

export interface PropertyDefinitionSynthesisPlan {
  workspaceId: string
  /** Non-null when this workspace must not be synthesized into at all — see
   *  {@link propertySynthesisWorkspaceRefusal}. `candidates` is still filled
   *  in, because a refusal only matters when there is something to mint. */
  refusal: string | null
  /** Live blocks whose property bag is not a JSON object, so the scan could
   *  not read their keys. NOT a count of bad data — a measure of how much of
   *  this plan is UNKNOWN. */
  unreadableBlocks: number
  /** Set when rows were still waiting to be materialized WHEN THE SCAN RAN, so
   *  the key survey was taken over a partial graph. The same kind of hole as
   *  {@link unreadableBlocks}, and it needs its own field because the gap can
   *  open and drain between the caller's eligibility checks — leaving both of
   *  those clean either side of a plan that never saw the arriving keys. */
  scanSyncGap: string | null
  candidates: SynthesisCandidate[]
  blockers: SynthesisBlocker[]
  /** Unresolved keys that DO have a definition block — broken, not missing.
   *  Adding a second definition is exactly the wrong repair, so these are
   *  reported and left alone. */
  brokenDefinitions: Array<{key: string; cells: number}>
}

/**
 * Why this WORKSPACE cannot be synthesized into, or null.
 *
 * E2EE, about the ID not the content: block ids sync in PLAINTEXT, so
 * `uuidv5("<workspaceId>:<key>")` under a namespace constant here lets a
 * server confirm a guessed private property name by recomputing the hash.
 * §8's answer is a namespace derived from workspace key material.
 *
 * Two rules that look like belt-and-braces and are not:
 *  - ASK THE MODE PIN, never `workspaces.encryption_mode` — that column is the
 *    server's, is `NOT NULL DEFAULT 'none'` locally, and `modePin.ts` exists so
 *    it can't silently downgrade a pinned workspace (an upgrading device would
 *    else read a genuinely encrypted one as plaintext).
 *  - ALLOWLIST, not denylist: a missing pin, unknown mode, or absent row must
 *    each refuse. Costs nothing real — `workspaceAccess.ts` pins every
 *    workspace at first encounter.
 */
export const propertySynthesisWorkspaceRefusal = async (
  repo: Repo,
  workspaceId: string,
): Promise<string | null> => {
  if (getModePin(repo.user.id, workspaceId) !== 'plaintext') {
    return 'this device has not confirmed the workspace is unencrypted, and an ' +
      'end-to-end encrypted one cannot synthesize definitions yet: the deterministic id ' +
      'would let the server confirm a guessed property name. Encrypted workspaces also ' +
      'cannot switch to property blocks yet, so nothing is lost by waiting'
  }
  // The pin says plaintext and the server says otherwise: a contradiction, and
  // on a privacy question a contradiction resolves closed. Cheap, and the only
  // thing standing between a corrupted pin and a published name-derived id.
  const mode = await readWorkspaceEncryptionMode(repo.db, workspaceId)
  if (mode !== 'none') {
    return `this device has the workspace pinned as unencrypted but its row reads ` +
      `${JSON.stringify(mode)} — resolve that before migrating anything`
  }
  return null
}

/** Why this key can never have a definition of any kind, or null.
 *
 *  The single authority on that question: synthesis refuses to mint for such a
 *  key, `flipBlockedBySynthesis` refuses the flip over it, and
 *  `audit-properties` marks it `blocksFlip` — three surfaces that must never
 *  disagree about which keys are hopeless.
 *
 *  DELIBERATELY NOT `propertySchemaNameRejection`: it judges a name a human is
 *  CHOOSING and can send back for another pick, but a cell key is already in
 *  the data — refusing it only makes the workspace permanently unable to
 *  flip. Its `isRoundTrippableReferenceLabel` rule is dropped for that reason:
 *  it also rejects any padding (`" padded "` fails it, told to "rename without
 *  \"]]\""), which would turn a padded import key into a permanent blocker for
 *  a benefit that's already bounded (field rows have been id-addressed since
 *  §7). Minting the trimmed name instead doesn't fix it either — `addSchema`
 *  trims, so it would define `"padded"` and leave the cell key `" padded "`
 *  still definition-less, the same unsatisfiable state by a longer route. */
export const keyCannotBeDefined = (key: string): string | null => {
  if (key === '') {
    return 'the empty property key: a definition with no name is unusable ' +
      '(`parsePropertyDefinitionMetadata` rejects it), so no definition can ever back it'
  }
  // The key as SQLite handed it back may not be the key the data holds: a lone
  // UTF-16 surrogate is emitted by `json_each` as ill-formed UTF-8 and arrives
  // here as replacement characters (measured: `"\ud800"` → three U+FFFD).
  // Minting for the mangled spelling would leave the real key orphaned while
  // the flip gate counted it covered, so any key carrying U+FFFD is one this
  // pass cannot identify — and a key that genuinely contains U+FFFD is itself
  // corruption, so refusing it either way is the right answer.
  if (key.includes('\uFFFD')) {
    return 'this key contains a Unicode replacement character, so what the database ' +
      'returned may not be the key the data actually holds (a lone surrogate reads back ' +
      'this way) — a definition minted for it would leave the real key behind'
  }
  if (isGrammarShapedLabel(key)) {
    return `${JSON.stringify(key)} reads as a block reference, not a name. A definition is ` +
      'addressed as `[[name]]` wherever it is named, so this one would point at another ' +
      'block — and a `::`-marked form would turn that row into property machinery'
  }
  return null
}

interface DistinctValueRow {
  property: string | null
  type: string
  value: unknown
}

/** Rebuild the stored JSON value from `json_each`'s (type, value) pair.
 *  `json_each` hands back SQL-typed scalars and JSON TEXT for containers, so
 *  the type column is what says which of the two this is. */
const jsonValueOf = (row: DistinctValueRow): unknown => {
  switch (row.type) {
    case 'true': return true
    case 'false': return false
    case 'null': return null
    case 'object':
    case 'array': return JSON.parse(String(row.value))
    default: return row.value
  }
}

/** Every distinct value each candidate key holds, for the keys small enough to
 *  check. A key over the limit is ABSENT from the map, which the caller reads
 *  as unproven and therefore as a blocker — not as a cue to guess a codec; see
 *  {@link PROVE_DISTINCT_VALUE_LIMIT}. */
const distinctValuesByKey = async (
  repo: Repo,
  workspaceId: string,
  keys: readonly string[],
): Promise<Map<string, unknown[]>> => {
  const out = new Map<string, unknown[]>()
  if (keys.length === 0) return out
  const keysJson = JSON.stringify(keys)
  // Counted first so an oversized key is never READ. A LIMIT on the value
  // query instead would silently truncate one key's values and prove a preset
  // against a subset, which is the guessing this replaced.
  const counts = await repo.db.getAll<{property: string | null; distinctValues: number}>(
    `SELECT j.key AS property, COUNT(DISTINCT j.value) AS distinctValues
       FROM blocks b, json_each(${OBJECT_BAG}) j
      WHERE b.workspace_id = ? AND b.deleted = 0
        AND j.key IN (SELECT value FROM json_each(?))
      GROUP BY j.key`,
    [workspaceId, keysJson],
  )
  const provable = counts
    .filter(row => row.distinctValues <= PROVE_DISTINCT_VALUE_LIMIT)
    .map(row => keyOf(row.property))
  if (provable.length === 0) return out

  const rows = await repo.db.getAll<DistinctValueRow>(
    `SELECT j.key AS property, j.type AS type, j.value AS value
       FROM blocks b, json_each(${OBJECT_BAG}) j
      WHERE b.workspace_id = ? AND b.deleted = 0
        AND j.key IN (SELECT value FROM json_each(?))
      GROUP BY j.key, j.type, j.value`,
    [workspaceId, JSON.stringify(provable)],
  )
  for (const row of rows) {
    const key = keyOf(row.property)
    const bucket = out.get(key) ?? []
    bucket.push(jsonValueOf(row))
    out.set(key, bucket)
  }
  return out
}

/**
 * What synthesis would do to this workspace. Reads only.
 *
 * Separate from the write so the gesture can refuse BEFORE it flips anything.
 */
export const planPropertyDefinitionSynthesis = async (
  repo: Repo,
  workspaceId: string,
): Promise<PropertyDefinitionSynthesisPlan> => {
  // Scanned even when the workspace is refused: "e2ee, and it has no orphan
  // keys anyway" and "e2ee, and it has twelve" are different situations, and
  // only the second one blocks anything.
  const refusal = await propertySynthesisWorkspaceRefusal(repo, workspaceId)
  const scan = await scanPropertyKeys(repo, workspaceId)

  const blockers: SynthesisBlocker[] = []
  const brokenDefinitions: Array<{key: string; cells: number}> = []
  const mintable: UnresolvedPropertyKey[] = []

  for (const entry of scan.unresolved) {
    // HOPELESS FIRST, and the order is the whole point. A key no definition can
    // ever back is a hard flip blocker; a key whose definition is merely broken
    // is repairable and deliberately does not block. Asking "is a definition
    // block present?" first collapses the two: a `property-schema` row storing
    // an EMPTY name counts as a definition block for the empty cell key, which
    // would file the one key that can never be defined under the bucket that
    // waves the flip through.
    const reason = keyCannotBeDefined(entry.property)
    if (reason !== null) {
      blockers.push({key: entry.property, cells: entry.cells, reason})
      continue
    }
    // A definition block already exists for this name and still doesn't
    // resolve, so the definition is BROKEN (an unloaded preset provider,
    // metadata that fails to parse). A second one would collide in the winner
    // machinery rather than fix anything.
    if (entry.definitionBlocks > 0) {
      brokenDefinitions.push({key: entry.property, cells: entry.cells})
      continue
    }
    mintable.push(entry)
  }

  const valuesByKey = await distinctValuesByKey(repo, workspaceId,
                                                mintable.map(entry => entry.property))
  const usable = usablePresets(repo)
  const candidates: SynthesisCandidate[] = []
  for (const entry of mintable) {
    const values = valuesByKey.get(entry.property)
    if (values === undefined) {
      // Too many distinct values to read, so nothing was PROVEN about this
      // key — and an unproven key is a blocker like any other. `raw-json` is
      // not the answer here: it cannot express a non-finite number, and on this
      // path the values were never looked at, so the claim would be
      // unfalsifiable too. Declaring the property by hand is the recovery.
      blockers.push({key: entry.property, cells: entry.cells,
                     reason: `holds more than ${PROVE_DISTINCT_VALUE_LIMIT.toLocaleString()} `
                       + 'distinct values, too many to check one at a time — create a '
                       + 'property definition for it by hand instead'})
      continue
    }
    const presetId = provePresetId(values, usable)
    if (presetId === undefined) {
      blockers.push({key: entry.property, cells: entry.cells,
                     reason: 'no value type available on this device carries every value this '
                       + 'key already holds without changing it — an unrepresentable number, or '
                       + 'an extension has replaced the preset that would have carried it'})
      continue
    }
    candidates.push({key: entry.property, cells: entry.cells, presetId})
  }

  return {workspaceId, refusal, unreadableBlocks: scan.unreadableBlocks,
          scanSyncGap: scan.syncGap, candidates,
          blockers, brokenDefinitions}
}

/**
 * Why this workspace must not be flipped to child-backed properties yet, or
 * null. See {@link SynthesisBlocker} for what makes a key hopeless.
 *
 * A workspace refusal (e2ee) blocks only when there is something to mint;
 * otherwise the invariant already holds. Advisory for an ALREADY-flipped
 * workspace, where no irreversible step is left to guard.
 */
export const flipBlockedBySynthesis = (
  plan: PropertyDefinitionSynthesisPlan,
  outcome?: SynthesisResult,
): string | null => {
  // Asked AGAIN after the write, with its outcome — `plan` is what we expected
  // to be able to do, `outcome.skipped` is what we could not. A key that came
  // back skipped is one the flip must not step over: the backfill excludes
  // unregistered keys from its work list, so the pass would report `ran` with
  // zero failures over a key it silently could not migrate.
  if (outcome && outcome.skipped.length > 0) {
    const named = outcome.skipped.map(s => `${JSON.stringify(s.key)} (${s.reason})`).join('; ')
    return `${outcome.skipped.length} property key(s) still have no definition after trying ` +
      `to add one: ${named}. Nothing was switched over; resolve these and run this again.`
  }
  // An unreadable bag is not "some bad data over there" — it is a hole in the
  // scan this decision is made from, so "every cell key resolves a definition"
  // is UNVERIFIED rather than satisfied. Refusing an irreversible step on an
  // incomplete survey is the whole reason the count is reported at all.
  if (plan.unreadableBlocks > 0) {
    return `${plan.unreadableBlocks} block(s) have a property bag this device cannot read, so ` +
      'their property keys are invisible here and this check cannot vouch for them. That ' +
      'means local database corruption — investigate before migrating anything.'
  }
  // The same hole from the other direction: rows still staged when the survey
  // ran are keys it could not see. Read off the PLAN rather than asked again
  // here, because a gap that has since drained is exactly the dangerous case —
  // the caller's checks either side of the plan both come back clean while the
  // plan itself was built without the keys that arrived.
  if (plan.scanSyncGap !== null) {
    return `The property survey ran while this device was still catching up (${plan.scanSyncGap}), `
      + 'so keys that arrived during it are missing from it. Run this again once sync is idle.'
  }
  if (plan.blockers.length > 0) {
    const named = plan.blockers.map(b => `${JSON.stringify(b.key)} (${b.reason})`).join('; ')
    return `${plan.blockers.length} property key(s) cannot be given a definition, so this ` +
      `workspace can never finish the migration while they exist: ${named}. Delete or ` +
      'remap them, then run this again.'
  }
  // Whether or not there is anything to mint: "is there something to
  // synthesize" and "may this workspace flip at all" are different questions.
  // The refusal means this device cannot vouch that a flip here is safe — and
  // for the case it exists for, e2ee, the server trigger refuses every flip
  // outright, so proceeding buys a dialog and a PATCH that can only fail.
  if (plan.refusal !== null) {
    return plan.candidates.length > 0
      ? `${plan.candidates.length} property key(s) have no definition, and ${plan.refusal}.`
      : `This workspace cannot be switched to property blocks: ${plan.refusal}.`
  }
  return null
}

/** The runtime schema for a synthesized definition, for the synchronous
 *  registry publish. Every inferrable preset is config-less
 *  (`kernelValuePresetCores.ts`), so `build` takes nothing. */
const schemaFor = (key: string, preset: AnyValuePresetCore): AnyPropertySchema => ({
  name: key,
  codec: preset.build(undefined as never),
  defaultValue: preset.defaultValue,
  changeScope: ChangeScope.BlockDefault,
})

export interface SynthesisResult {
  created: number
  /** Already this key's definition when we got here — another device, or an
   *  earlier run. Converged, not a problem; re-registered all the same. */
  converged: number
  /** Candidates this pass did NOT leave with a resolvable definition.
   *
   *  NON-EMPTY MEANS THE INVARIANT DOES NOT HOLD, which is the whole reason
   *  the caller runs this before a one-way flip — so it is a refusal input,
   *  not a log line. {@link flipBlockedBySynthesis} reads it back.
   *
   *  Each entry is a key still orphaned after the attempt: its deterministic
   *  id is occupied by something we will not write through, or the name was
   *  claimed by someone else between the plan and the write. */
  skipped: Array<{key: string; reason: string}>
}

/** The kernel preset core a live definition block stores, when it is one this
 *  pass can reproduce faithfully — undefined otherwise, since the point of
 *  reading it is to publish the block's OWN behavior, not a guess.
 *
 *  CONFIG-LESS ONLY — the load-bearing clause: {@link schemaFor} builds with
 *  `build(undefined)`, which THROWS for `enum`/`strict-enum` (dereferences
 *  `config.options`, rolling back every other key's definition in the same
 *  transaction) and silently drops target types for `ref`/`refList`. Skipping
 *  such a definition costs only a re-run once the projector catches up. An id
 *  an extension has REPLACED is the same situation — see {@link isKernelPreset}. */
const storedPresetCore = (block: BlockData, repo: Repo): AnyValuePresetCore | undefined => {
  const raw = peekRowProperty(block, presetIdProp)
  if (typeof raw !== 'string') return undefined
  const core = (kernelValuePresetCoresById as Record<string, AnyValuePresetCore>)[raw]
  if (core === undefined || core.configCodec !== undefined) return undefined
  return isKernelPreset(repo, raw) ? core : undefined
}

/** The definition block's own stored default, decoded through the preset it
 *  declares — or the preset's default when there is none, or when the stored
 *  one no longer fits (a stale value left by a preset change, which is a stale
 *  VALUE rather than a broken definition; `userSchemasService` treats it the
 *  same way). */
const storedDefaultValue = (block: BlockData, preset: AnyValuePresetCore): unknown => {
  const raw = block.properties[propertyDefaultProp.name]
  // Stated rather than left to the catch below, which reaches the same answer
  // for all four inferrable presets today — three throw on `undefined` and
  // `raw-json`'s own default IS undefined. Deleting this changes nothing and no
  // test fails; it is here so "no stored default" reads as a case rather than
  // as an exception.
  if (raw === undefined) return preset.defaultValue
  try {
    return preset.build(undefined as never).decode(raw)
  } catch {
    return preset.defaultValue
  }
}

/** The name a live definition row currently answers to, computed the way
 *  `buildPropertyDefinitionRegistry` computes it: a valid seed row answers to
 *  the seed's DECLARED name, everyone else to their stored one.
 *
 *  Read from the ROW, not the registry — the caller is checking a fact the
 *  registry may be stale about — but through the SAME rule, or a seed row
 *  whose stored name has drifted would read as serving a name nothing uses.
 *  Undefined when the row is no longer a usable definition at all (deleted,
 *  un-typed, metadata that stopped parsing).
 *
 *  The seed branch is UNPINNED, for the same reason as the rival filter's:
 *  seed names are non-renamable through the API, so drift arrives only by raw
 *  write or sync and neither reaches the test harness's projector. The rule is
 *  `buildPropertyDefinitionRegistry`'s; this is the third site that needs it. */
const effectiveDefinitionName = (
  block: BlockData,
  registry: PropertyDefinitionRegistrySnapshot,
): string | undefined => {
  const metadata = parsePropertyDefinitionMetadata(block)
  if (metadata === null) return undefined
  // The rewrite applies to SEED rows only. For an ordinary user definition the
  // stored name IS the effective one — and it is fresher than the registry's
  // copy, which is the direction that matters: a user definition renamed TO
  // this key after the plan is a real rival that the registry still files under
  // its old name.
  return metadata.seedKey === undefined
    ? metadata.name
    : registry.seedsByKey.get(metadata.seedKey)?.name
}

/** Does this row currently build behaviour, or only metadata?
 *
 *  A definition whose preset is not registered here parses perfectly well —
 *  `parsePropertyDefinitionMetadata` never consults the preset registry — and
 *  is absent from `schemas`, so the NAME resolves nothing. Separate from
 *  {@link effectiveDefinitionName} because the two questions have different
 *  answers for the same row and different callers need each: a row like that
 *  still OCCUPIES its name (so it is a rival) but does not SERVE it (so it is
 *  not convergence). */
const providesSchema = (block: BlockData, repo: Repo): boolean => {
  const presetId = peekRowProperty(block, presetIdProp)
  return typeof presetId === 'string' && repo.valuePresetCores.has(presetId)
}

/** A live definition block already serving as `key`'s definition — the only
 *  occupant this pass may adopt.
 *
 *  Without this, `classifyOccupant` answers a question one step too shallow:
 *  the deterministic id is "ours and live" whatever the block has since
 *  BECOME — so a synthesized definition the user had renamed read as converged.
 *
 *  LIVE rows only. `classifyOccupant` ranks `tombstoned` above `adoptable`, so
 *  this is never asked about a tombstone. */
const servesAsDefinitionFor = (key: string) => (block: BlockData): boolean =>
  parsePropertyDefinitionMetadata(block)?.name === key

/**
 * Mint the planned definitions. One transaction, so the workspace either has
 * every definition this plan promised or none of them.
 *
 * THE PLAN IS A SNAPSHOT AND THIS IS THE WRITE, so "is the key still orphaned"
 * and "is the deterministic id still ours to write through" are re-asked HERE,
 * inside the tx, as one question — asking them separately mints a rival for a
 * name that gained a definition while the dialog was open. Not a corner case:
 * see the file header's ORDER MATTERS note for exactly how that window opens.
 *
 * Deliberately says nothing about `plan.blockers` — {@link flipBlockedBySynthesis}
 * owns that decision.
 */
export const applyPropertyDefinitionSynthesis = async (
  repo: Repo,
  plan: PropertyDefinitionSynthesisPlan,
): Promise<SynthesisResult> => {
  const {workspaceId} = plan
  // The same precondition `scanPropertyKeys` opens with, and for a sharper
  // reason here: a registry belonging to another workspace makes the resolver
  // report every key unresolved AND makes the seed check fail open. Both errors
  // point the same way — toward minting.
  requirePropertyRegistryFor(repo, workspaceId)
  const skipped: SynthesisResult['skipped'] = []
  if (plan.candidates.length === 0) return {created: 0, converged: 0, skipped}
  // Defence in depth, labelled as such: `repo.tx` re-reads `isReadOnly` at
  // commit time and rejects `ChangeScope.BlockDefault` there
  // (`commitPipeline.ts`) regardless — this only turns that into a message
  // naming the workspace. Below the empty-plan return, so an empty plan is
  // a no-op rather than a throw.
  if (repo.isReadOnly) {
    throw new Error('[propertyDefinitionSynthesis] this workspace is read-only')
  }

  // Re-read rather than trust the plan's snapshot: the operator has seen a
  // dialog since. A device that has fallen behind would mint a rival for a
  // definition it simply has not received yet, and the loser strands every
  // field row that bound to it.
  const syncGap = await repo.syncViewGap()
  if (syncGap !== null) {
    throw new Error(`[propertyDefinitionSynthesis] ${syncGap}`)
  }
  // Re-read for the same reason, and because the plan may have been built
  // before this device received the workspace row that says it is encrypted.
  const refusal = await propertySynthesisWorkspaceRefusal(repo, workspaceId)
  if (refusal !== null) {
    throw new Error(`[propertyDefinitionSynthesis] ${refusal}`)
  }

  // Commits its OWN transaction, before the one below — so a synthesis that
  // then throws can leave a freshly-created Properties page behind. Harmless
  // (bootstrap creates the same page at the same deterministic id) but it is
  // why the atomicity claim above is scoped to the definitions.
  await getOrCreatePropertiesPage(repo, workspaceId)
  const parentId = propertiesPageBlockId(workspaceId)

  let created = 0
  let converged = 0
  const registrations: Array<{schema: AnyPropertySchema; blockId: string}> = []
  let lastOrderKey: string | null = null

  await repo.tx(async tx => {
    // Taken INSIDE the tx, once: the registry is a lagging projection of the
    // definition blocks, and the plan's copy is a dialog older still.
    const registry = requirePropertyRegistryFor(repo, workspaceId)
    const resolver = repo.propertySchemaResolverFor(workspaceId)
    // Read once, inside the lock, and chained forward per candidate rather
    // than re-derived — see the mint site below for why.
    lastOrderKey = (await tx.childrenOf(parentId, workspaceId)).at(-1)?.orderKey ?? null
    const liveDefinitionNames = await tx.livePropertyDefinitionNames(
      workspaceId, plan.candidates.map(candidate => candidate.key),
    )
    for (const candidate of plan.candidates) {
      // The kernel core BY IDENTITY, never `repo.valuePresetCores.get(id)`:
      // that map is a `keyedMapFacet` keyed on preset id, so an extension
      // contributing `string` REPLACES the kernel one. `provePresetId`'s whole
      // criterion is the round-trip behaviour of these four specific codecs —
      // registering a different codec under the id we persist would apply an
      // unvetted one to every historical value of the key.
      const preset = kernelValuePresetCoresById[candidate.presetId]
      const id = synthesizedPropertyDefinitionBlockId(workspaceId, candidate.key)

      // Has the key gained a definition since the plan was taken (whoever's)?
      // Not answerable from `tx.get(id)`: OUR id is vacant no matter who else
      // claimed the name. So resolve by NAME, then re-verify the resolver's
      // answer against the row directly — the resolver is a projection and may
      // be one tick out of date (deleted, renamed, un-typed, or broken
      // metadata since). Located by FIELD ID and judged by EFFECTIVE name so a
      // seed-backed row whose stored name has drifted is still found and still
      // recognised as serving this key.
      // Every row that currently HOLDS this name, minus the ones the caller
      // already accounts for. Asked of the DATABASE (the registry lags a
      // sync-applied definition until the projector ticks — see
      // `Tx.livePropertyDefinitionNames`), so it also catches a definition that
      // PARSED but supplies no behaviour: absent from `schemas`, real in
      // `blocks`.
      //
      // `effective` is the seed-rewrite rule from `effectiveDefinitionName`
      // above — without it a healthy seed row sitting under a drifted stored
      // name would read as a rival and block the flip forever. UNPINNED for the
      // same reason as there: the drift path (raw write or sync) never reaches
      // the test harness's projector.
      const liveRivals = async (...accounted: string[]): Promise<string[]> => {
        const found: string[] = []
        for (const other of liveDefinitionNames.get(candidate.key) ?? []) {
          if (accounted.includes(other)) continue
          const row = await tx.get(other)
          if (row === null) continue
          const effective = effectiveDefinitionName(row, registry)
          if (effective === undefined || effective === candidate.key) found.push(other)
        }
        return found
      }

      const resolution = resolver.resolve(candidate.key)
      if (resolution.status === 'resolved') {
        const selected = await tx.get(resolution.schema.fieldId)
        if (selected !== null
            && effectiveDefinitionName(selected, registry) === candidate.key
            && providesSchema(selected, repo)) {
          // Converged only if the row the projection picked is the ONLY one
          // holding the name. The winner is decided by creation time, so a
          // second row the projector has not reached yet can take the name on
          // the next rebuild — and the backfill is about to bind field rows to
          // whichever fieldId is published NOW. Vouching here strands them on
          // the loser; deferring costs a re-run once the projector catches up.
          //
          // ONLY the selection is excluded — NOT our deterministic id, which the
          // mint path below excludes because that is where it is about to write.
          // Here we write nothing, and a sync-applied row at that id is the one
          // contender guaranteed to win: `systemMint` births it at `createdAt`
          // 0 and `buildPropertyDefinitionRegistry` sorts ascending.
          const contenders = await liveRivals(resolution.schema.fieldId)
          if (contenders.length === 0) {
            converged += 1
            continue
          }
          skipped.push({key: candidate.key,
                        reason: `more than one definition block holds this name (${
                          [resolution.schema.fieldId, ...contenders].join(', ')}); the winner is `
                          + 'decided by creation time, so resolve the duplicate before migrating'})
          continue
        }
      }
      // DEFENCE IN DEPTH — no test pins it; the resolve check above already
      // catches every seed whose own definition is healthy. What's left is a
      // kept seed that HOLDS the name but publishes no schema (its preset comes
      // from an extension not loaded here, per `audit-properties`'s common
      // case): the name resolves nothing, yet `buildPropertyDefinitionRegistry`
      // still excludes any user definition colliding with it — minting there
      // would report success over a key that can never resolve.
      if (registry.seedsByName.has(candidate.key)) {
        skipped.push({key: candidate.key,
                      reason: 'a code seed declares this name, so a user definition for it can '
                        + 'never resolve — install or repair the seed\'s own definition instead'})
        continue
      }

      // Skipping here BLOCKS the flip, where the plan-time equivalent
      // (`brokenDefinitions`) deliberately does not: a broken definition the
      // operator saw and consented to in the dialog is different from one that
      // arrived after they confirmed.
      const rivals = await liveRivals(id)
      if (rivals.length > 0) {
        skipped.push({key: candidate.key,
                      reason: 'a definition block for this name already exists and supplies '
                        + 'no behavior — repair it rather than adding a second'})
        continue
      }

      const occupancy = classifyOccupant(await tx.get(id), {
        workspaceId, adoptable: servesAsDefinitionFor(candidate.key),
      })
      if (occupancy.verdict === 'foreign') {
        skipped.push({key: candidate.key,
                      reason: `block ${id} belongs to another workspace`})
        continue
      }
      if (occupancy.verdict === 'rejected') {
        // Live and ours, but it is no longer this key's definition — renamed,
        // retyped, or its metadata stopped parsing. Overwriting would destroy
        // whatever it became, and the key genuinely still has nothing.
        skipped.push({key: candidate.key,
                      reason: `block ${id} exists but is no longer this key's definition`})
        continue
      }
      if (occupancy.verdict === 'ours') {
        // Already here and carries this key's name, yet didn't resolve above —
        // the registry is a projection that hasn't caught up (another device's
        // row just arrived, or an earlier run of this gesture). Nothing to
        // write; publishing is the whole fix.
        //
        // Published from the BLOCK's own preset, never the plan's inferred one:
        // the block may have been retyped deliberately, and publishing the
        // plan's guess would have the backfill read history under one codec
        // while the projector replaces it with another moments later. If the
        // stored preset isn't one this pass can reproduce, skip rather than
        // guess — the flip refuses and a re-run picks it up once caught up.
        const storedPreset = storedPresetCore(occupancy.block, repo)
        const storedMetadata = parsePropertyDefinitionMetadata(occupancy.block)
        if (!storedPreset || !storedMetadata) {
          skipped.push({key: candidate.key,
                        reason: `block ${id} defines this key with a preset this pass cannot `
                          + 'reproduce; re-run once it is registered'})
          continue
        }
        converged += 1
        // The block's OWN behavior, not this pass's defaults. Publishing
        // `BlockDefault` and the preset's default for a definition that stores
        // `UiState` and a default of its own would route writes to sync and
        // apply the wrong undo policy until the projector replaces it.
        registrations.push({blockId: id, schema: {
          ...schemaFor(candidate.key, storedPreset),
          changeScope: storedMetadata.changeScope,
          defaultValue: storedDefaultValue(occupancy.block, storedPreset),
        }})
        continue
      }
      if (occupancy.verdict === 'tombstoned') {
        // Deliberately NOT restored: a deletion is an instruction, and
        // resurrecting it silently undoes what the user did. (Why the faithful
        // restore was abandoned rather than fixed is in the migration doc.)
        skipped.push({key: candidate.key,
                      reason: `a definition for this key was deleted (block ${id}); undo that `
                        + 'deletion, or delete the key, then run this again'})
        continue
      }
      // Asked AGAIN, of the runtime: `usablePresets` filtered this ladder
      // pre-dialog, and a user-length pause is enough for an extension to load
      // (the dialog itself may have told the operator to enable one) and
      // replace the core behind this id. Minting anyway persists an id whose
      // codec the projector will rebuild from the extension while the backfill
      // encodes history with the kernel one.
      //
      // POSITION IS LOAD-BEARING: below the converged and occupancy checks, not
      // above them. Convergence does not depend on this pass's chosen preset at
      // all, so refusing earlier would skip a key that already HAS a definition
      // and block the flip over nothing.
      if (!isKernelPreset(repo, candidate.presetId)) {
        skipped.push({key: candidate.key,
                      reason: `an extension replaced the '${candidate.presetId}' value type `
                        + 'after this migration was planned; run it again to re-check the '
                        + 'values against what that type does now'})
        continue
      }
      // Raw `tx.createOrGet`, not the `createChild` mutator, which can't pass
      // `systemMint` (`mutators.ts`): without it, two devices minting this id
      // in the same millisecond write equal nonzero stamps and the loser
      // strands. The follow-up shaping writes hold `updated_at` at 0, so the
      // mint uploads as one pristine default. Chained locally, not re-derived
      // per candidate: the parent (the Properties page) holds EVERY definition
      // in the workspace, and `orderKeyForInsert` re-reads and re-parses all
      // of its children per call — minting N keys would cost N scans of a
      // list this pass is itself growing.
      lastOrderKey = keyAtEnd(lastOrderKey)
      await tx.createOrGet({
        id,
        workspaceId,
        parentId,
        orderKey: lastOrderKey,
        // Content stays EMPTY, matching `addSchema` — a definition's name lives
        // in `property:name`, never in its content; only code SEEDS mirror the
        // two, and a synthesized definition is user-origin.
        content: '',
      }, {systemMint: true})
      await repo.addTypeInTx(tx, id, PROPERTY_SCHEMA_TYPE, {})
      // One batched delta rather than four `setProperty` calls: `setProperties`
      // resolves and scope-checks the whole set up front and rewrites the bag
      // once, which on an already-flipped workspace is one child reconciliation
      // instead of four. (`addSchema` still writes these sequentially; this is
      // the newer primitive its own docs point callers at.)
      await tx.setProperties(id, {set: [
        propertyValue(propertyNameProp, candidate.key),
        propertyValue(presetIdProp, candidate.presetId),
        propertyValue(presetConfigProp, {}),
        // VISIBLE, deliberately (owner's call): a hidden property is one nobody
        // is ever prompted to triage, which is the whole job these exist for.
        propertyValue(propertyHiddenProp, false),
      ]})
      created += 1
      registrations.push({blockId: id, schema: schemaFor(candidate.key, preset)})
    }
  }, {
    scope: ChangeScope.BlockDefault,
    description: 'synthesize property definitions',
    // The gesture clears the undo stack at the flip (or, already-flipped, the
    // backfill clears it on its first batch) — but a run can end between the
    // two (peer holds the claim, pass defers), leaving these as the only
    // committed write with a live undo entry that cmd-Z would delete.
    skipUndo: true,
  })

  // Publish synchronously, same reason as `addSchema`: the caller's next step
  // is the backfill, which freezes ONE resolver for the whole multi-minute
  // run — waiting for the projector would let it skip every key just fixed.
  //
  // Caught and reported as a SKIP, not thrown: the transaction already
  // committed, so throwing here would lose a durable outcome and tell the
  // user nothing was migrated, when the flip-refusal path already exists for
  // exactly "this key did not end up resolvable". Per registration, not
  // around the loop, so one failure doesn't cost the others their publish.
  for (const {schema, blockId} of registrations) {
    try {
      repo.userSchemas.appendUserSchema(schema, blockId, workspaceId)
    } catch (err) {
      console.error('[propertyDefinitionSynthesis] could not publish', schema.name, err)
      skipped.push({key: schema.name,
                    reason: `its definition block was written (${blockId}) but could not be `
                      + 'registered on this device; run this again once the projector has '
                      + 'caught up'})
    }
  }

  return {created, converged, skipped}
}

