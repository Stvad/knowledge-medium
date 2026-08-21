/**
 * §9 orphan-definition synthesis: give every definition-less cell key a
 * definition block, so "every key resolves a definition" can be an INVARIANT
 * rather than a branch every consumer has to carry.
 *
 * A key nothing declares — historic residue, a plugin disabled before the
 * unification's cutover, a dormant dynamic extension, a raw bag writer — is
 * the one class of property data a flipped workspace cannot make
 * child-backed: `materializePropertyChildrenForExistingRow` resolves the name,
 * gets nothing, and skips the cell (correctly; inventing a definition there
 * would be the migration making up data). Left alone such a key rides the
 * cell forever, which is what the §11 column drop cannot allow.
 *
 * So the minting happens HERE instead, as an explicit operator step before
 * the flip — where it can refuse the keys it must not mint for, report the
 * ones it fudged, and be looked at before anything irreversible happens.
 *
 * ORDER MATTERS, and it is the operator's to get right: if an EXTENSION owns a
 * key, install/enable it first so its seed materializes the definition. Doing it
 * the other way round breaks in two different ways depending on what the owner
 * uses, and only the first is about rival definitions:
 *
 *  - a SEED owner ends up with two definitions in the winner machinery, and
 *    field rows stranded on the loser's fieldId;
 *  - a `defineProperty` owner (a plain schema, no definition block — one of the
 *    exact shapes that produces an orphan key in the first place) starts
 *    THROWING. `allowUnregisteredPlainSchemas` admits its writes while nothing
 *    claims the name; once a definition exists, `resolveBoundary` finds a winner
 *    that is not the caller's schema and every write fails `shadowed`. Measured,
 *    not theorised. Same instruction, very different symptom to recognise.
 *
 * `audit-properties` names the owner where it can.
 */

import { ChangeScope, type AnyPropertySchema, type AnyValuePresetCore, type BlockData } from '@/data/api'
import { PROPERTY_SCHEMA_TYPE } from '@/data/blockTypes'
import { classifyOccupant, derivedBlockId } from '@/data/derivedIds'
import { kernelValuePresetCoresById } from '@/data/kernelValuePresetCores'
import { orderKeyForInsert } from '@/data/mutators'
import { parsePropertyDefinitionMetadata } from '@/data/propertyDefinitionMetadata'
import {
  addBlockTypeToProperties,
  presetConfigProp,
  presetIdProp,
  propertyChangeScopeProp,
  propertyHiddenProp,
  propertyNameProp,
} from '@/data/properties'
import { getOrCreatePropertiesPage, propertiesPageBlockId } from '@/data/propertiesPage'
import { isGrammarShapedLabel } from '@/data/referenceBlock'
import type { Repo } from '@/data/repo'
import { readWorkspaceEncryptionMode } from '@/data/workspaceSchema'
import { getModePin } from '@/sync/keys/modePin'
import { jsonValuesEqual } from '@/data/internals/jsonCanonical'
import {
  encodedPropertyValueToChildContent, propertyChildContentToEncodedValue,
} from '@/data/propertyChildren'
import {
  OBJECT_BAG, keyOf, scanPropertyKeys, type UnresolvedPropertyKey,
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
 *  see {@link inferPresetId} for why that is the selection criterion.
 *
 *  One exception, tracked in #688 and not this module's to fix: a `string`
 *  value that is itself field-form content round-trips to nothing. Synthesis
 *  widens the set that can bite, because these keys come from writers nothing
 *  vetted. */
export type SynthesizedPresetId = 'boolean' | 'number' | 'string' | 'raw-json'

/** Tried narrowest-first; the first that carries every stored value wins.
 *  `raw-json` is last and is the identity codec, so it is the answer whenever
 *  nothing narrower is provable — including for a key too large to check. */
const PRESET_LADDER: readonly SynthesizedPresetId[] =
  ['boolean', 'number', 'string', 'raw-json']

/** Distinct values we will read per key to prove a preset.
 *
 *  Not a sampling cap — sampling would put the guessing back. A key with more
 *  distinct values than this is not CHECKED, it is answered `raw-json`, which
 *  is exact for every JSON value. Measured on a ~360k-cell production graph the
 *  heaviest key of any kind has ~26k distinct values and the unregistered ones
 *  had 23 between them, so this bounds a case that does not arise rather than
 *  trimming one that does. */
export const PROVE_DISTINCT_VALUE_LIMIT = 10_000

/**
 * Which preset can carry every value this key already holds — PROVEN, by
 * running the round trip, not inferred from what the values look like.
 *
 * The criterion was always "which codec reads every stored value back out
 * UNCHANGED": a synthesized definition is applied retroactively to values
 * written before it existed, and once the workspace is flipped the cell is
 * re-derived from the children, so a codec whose round trip rewrites a value
 * silently rewrites the user's data. An earlier revision approximated that from
 * a histogram of JSON types, and every review round found another shape the
 * histogram could not see — dates canonicalising, oversized integers, and so
 * on. Each was a real hole and each fix was one more term in a proxy.
 *
 * So the check is the actual round trip. `date` needs no special case now: it
 * simply fails, because `codecs.date` re-encodes `"2026-08-20"` as
 * `"2026-08-20T00:00:00.000Z"` — and any future codec that does the same fails
 * for the same reason without anyone having to notice it first.
 *
 * WHAT THIS DOES NOT PROVE: only the JS half. Content that survives here can
 * still be transformed at the database text boundary or by a processor —
 * see #688 — which is why that stays tracked separately rather than papered
 * over here.
 */
export const provePresetId = (values: readonly unknown[]): SynthesizedPresetId => {
  for (const presetId of PRESET_LADDER) {
    const schema = schemaFor('probe', kernelValuePresetCoresById[presetId])
    if (values.every(value => survivesChildRoundTrip(schema, value))) return presetId
  }
  // `raw-json` is `JSON.stringify`/`JSON.parse`, so reaching here means a value
  // no codec in this app can carry.
  return 'raw-json'
}

/** Does one stored value come back byte-identical through the child machinery
 *  this preset would use? */
const survivesChildRoundTrip = (schema: AnyPropertySchema, encoded: unknown): boolean => {
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
 * E2EE is the case, and it is about the ID rather than the content:
 * synthesized definition ids are `uuidv5("<workspaceId>:<key>")` under a
 * namespace constant in this repo, and block ids sync in PLAINTEXT — so a
 * server holding one can confirm a guessed private property name (`health`,
 * `client:ssn`) by recomputing the hash, precisely the edge metadata §8
 * encrypts. §8's answer is a namespace derived from workspace key material;
 * until that ships this refuses.
 *
 * ASKS THE MODE PIN, NOT `workspaces.encryption_mode`. The column is the
 * server's, and this repo treats it as a UX hint that a hostile or buggy server
 * may lie in exactly the dangerous direction: `modePin.ts` exists so "a server
 * that flips its `encryption_mode` flag can't silently downgrade a pinned
 * workspace", and `workspaceAccess.ts` trusts server `'e2ee'` while refusing to
 * trust server `'none'`. The column is also `NOT NULL DEFAULT 'none'` locally,
 * so an upgrading device reads `'none'` for a genuinely encrypted workspace
 * until PowerSync replays the real value — the likeliest way to get this wrong,
 * and it fails in the leaking direction.
 *
 * ALLOWLIST, not a denylist. Only an affirmative "this device confirmed the
 * workspace plaintext" proceeds; a missing pin, an unrecognized mode string, and
 * an absent local row all refuse. A `mode === 'e2ee'` denylist would fail OPEN
 * on every one of those — the same mistake in three new ways. Requiring the pin
 * costs nothing real: `workspaceAccess.ts` puts every unpinned workspace through
 * the first-encounter gate, and confirming plaintext there pins it, so any
 * workspace the operator has open is pinned.
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
 *  disagree about which keys are hopeless. */
export const keyCannotBeDefined = (key: string): string | null => {
  if (key === '') {
    return 'the empty property key: a definition with no name is unusable ' +
      '(`parsePropertyDefinitionMetadata` rejects it), so no definition can ever back it'
  }
  // The key as SQLite handed it back is not the key the data holds. A property
  // key containing a lone UTF-16 surrogate is emitted by `json_each` as
  // ill-formed UTF-8 and arrives here as replacement characters (measured:
  // `"\ud800"` comes back as three U+FFFD). Minting for the mangled spelling
  // would leave the real key orphaned while the flip gate counted it covered —
  // so the safe reading is that any key carrying U+FFFD is one this pass cannot
  // identify. A key that genuinely contains U+FFFD is itself corruption, and
  // refusing it is the same right answer.
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
 *  check. A key over the limit is absent from the map and answered `raw-json`
 *  rather than sampled — see {@link PROVE_DISTINCT_VALUE_LIMIT}. */
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
  const candidates: SynthesisCandidate[] = mintable.map(entry => ({
    key: entry.property,
    cells: entry.cells,
    // No entry means the key had too many distinct values to read, so nothing
    // was proven about it: `raw-json` is exact for every JSON value, which is
    // the conservative answer rather than a sampled guess.
    presetId: (values => values === undefined ? 'raw-json' : provePresetId(values))(
      valuesByKey.get(entry.property)),
  }))

  return {workspaceId, refusal, unreadableBlocks: scan.unreadableBlocks, candidates,
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
  if (plan.blockers.length > 0) {
    const named = plan.blockers.map(b => `${JSON.stringify(b.key)} (${b.reason})`).join('; ')
    return `${plan.blockers.length} property key(s) cannot be given a definition, so this ` +
      `workspace can never finish the migration while they exist: ${named}. Delete or ` +
      'remap them, then run this again.'
  }
  if (plan.refusal !== null && plan.candidates.length > 0) {
    return `${plan.candidates.length} property key(s) have no definition, and ${plan.refusal}.`
  }
  return null
}

/** Restore patch for a tombstoned definition: the four fields this pass owns,
 *  re-asserted OVER the row's stored bag.
 *
 *  MERGED, not replaced — `tx.restore`'s `properties` patch overwrites the
 *  whole bag (`txEngine.ts`), so building it from the four fields alone would
 *  drop the `types` entry and un-type the definition, leaving
 *  `parsePropertyDefinitionMetadata` with nothing to parse and the key orphaned
 *  by the very write meant to fix it.
 *
 *  Re-asserted rather than trusted, because the stored copy is whatever the row
 *  had when it was deleted: a preset the operator had switched to `date` came
 *  back as `date` and rewrote every value of the key on the next backfill. */
const restoredDefinitionProperties = (
  stored: Readonly<Record<string, unknown>>,
  candidate: SynthesisCandidate,
): {properties: Record<string, unknown>} => ({
  properties: addBlockTypeToProperties({
    ...stored,
    [propertyNameProp.name]: propertyNameProp.codec.encode(candidate.key),
    [presetIdProp.name]: presetIdProp.codec.encode(candidate.presetId),
    [presetConfigProp.name]: presetConfigProp.codec.encode({}),
    [propertyHiddenProp.name]: propertyHiddenProp.codec.encode(false),
    // EVERY field the metadata parser requires, including the ones a
    // synthesized definition never sets deliberately. A stored change-scope a
    // raw write corrupted is exactly as fatal as a missing type: the row
    // restores, `parsePropertyDefinitionMetadata` rejects it, and the publish
    // throws after the transaction has already committed.
    [propertyChangeScopeProp.name]:
      propertyChangeScopeProp.codec.encode(ChangeScope.BlockDefault),
  }, PROPERTY_SCHEMA_TYPE),
})

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
  restored: number
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

/** The definition name stored on a row, live or tombstoned.
 *
 *  `parsePropertyDefinitionMetadata` returns null for a DELETED row, so the
 *  restore path — which by definition looks at a tombstone — has to read the
 *  bag directly. Returns undefined when the row carries no readable name. */
const storedDefinitionName = (block: BlockData): string | undefined => {
  const raw = block.properties[propertyNameProp.name]
  if (raw === undefined) return undefined
  try {
    return propertyNameProp.codec.decode(raw)
  } catch {
    return undefined
  }
}

/** The kernel preset core a live definition block stores, when it is one this
 *  pass can reproduce faithfully. Undefined for anything else, because the
 *  point of reading it is to publish the block's OWN behavior rather than a
 *  guess — and a guess is all we could offer for the rest.
 *
 *  CONFIG-LESS ONLY, and that is the load-bearing clause: {@link schemaFor}
 *  builds with `build(undefined)`, which for `enum`/`strict-enum` dereferences
 *  `config.options` and THROWS — rolling back every other key's definition in
 *  the same transaction — and for `ref`/`refList` silently drops the stored
 *  target types. A definition on one of those is a definition this pass cannot
 *  republish; skipping it costs a re-run once the projector catches up, which
 *  is the cheap half of the trade. */
const storedPresetCore = (block: BlockData): AnyValuePresetCore | undefined => {
  const raw = block.properties[presetIdProp.name]
  if (typeof raw !== 'string') return undefined
  const core = (kernelValuePresetCoresById as Record<string, AnyValuePresetCore>)[raw]
  return core?.configCodec === undefined ? core : undefined
}

/** A live definition block already serving as `key`'s definition — the only
 *  occupant this pass may adopt.
 *
 *  Without this, `classifyOccupant` answers a question one step too shallow:
 *  the deterministic id is "ours and live" whatever the block has since
 *  BECOME. Measured consequences of the shallower check: a synthesized
 *  definition the user renamed was reported identically to a genuinely
 *  converged one, both invisibly.
 *
 *  Note this predicate covers the LIVE row only — `classifyOccupant` ranks
 *  `tombstoned` above `adoptable` deliberately ("`adoptable` runs last, so it
 *  is never asked about a tombstone"), so the restore path checks the name
 *  itself. */
const servesAsDefinitionFor = (key: string) => (block: BlockData): boolean =>
  parsePropertyDefinitionMetadata(block)?.name === key

/**
 * Mint the planned definitions. One transaction, so the workspace either has
 * every definition this plan promised or none of them.
 *
 * THE PLAN IS A SNAPSHOT AND THIS IS THE WRITE, so every decision that depends
 * on live state is taken again HERE, inside the tx: whether the key is still
 * orphaned, and whether the deterministic id is still ours to write through.
 * Those two are one question — "does this key have a definition?" — and asking
 * them separately is what let an earlier revision mint a rival for a name that
 * had gained a definition while the confirmation dialog was open. That is not a
 * corner case: the runbook this migration prints tells the operator to enable a
 * key's owning extension FIRST, which is exactly the write that lands in that
 * window.
 *
 * Deliberately says nothing about `plan.blockers` — {@link flipBlockedBySynthesis}
 * owns that decision.
 */
export const applyPropertyDefinitionSynthesis = async (
  repo: Repo,
  plan: PropertyDefinitionSynthesisPlan,
): Promise<SynthesisResult> => {
  const {workspaceId} = plan
  const skipped: SynthesisResult['skipped'] = []
  if (plan.candidates.length === 0) return {created: 0, restored: 0, converged: 0, skipped}
  // Defence in depth, and labelled as such: `repo.tx` re-reads `isReadOnly` at
  // commit time and rejects `ChangeScope.BlockDefault` there
  // (`commitPipeline.ts`), so a role change mid-flight is already caught. This
  // only turns it into a message that names the workspace instead of a
  // scope-rejection from the engine. Below the empty-plan return so an empty
  // plan is a no-op rather than a throw.
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
  let restored = 0
  let converged = 0
  const registrations: Array<{schema: AnyPropertySchema; blockId: string}> = []

  await repo.tx(async tx => {
    // Taken INSIDE the tx, once: the registry is a lagging projection of the
    // definition blocks, and the plan's copy is a dialog older still.
    const registry = repo.propertyDefinitions
    const resolver = repo.propertySchemaResolverFor(workspaceId)
    // One read for the whole batch, inside the lock — see the mint site below.
    const liveDefinitionNames = await tx.livePropertyDefinitionNames(
      workspaceId, plan.candidates.map(candidate => candidate.key),
    )
    for (const candidate of plan.candidates) {
      // The kernel core BY IDENTITY, never `repo.valuePresetCores.get(id)`:
      // that map is a `keyedMapFacet` keyed on preset id, so an extension
      // contributing `string` REPLACES the kernel one. `inferPresetId`'s whole
      // criterion is the round-trip behaviour of these four specific codecs —
      // registering a different codec under the id we persist would apply an
      // unvetted one to every historical value of the key.
      const preset = kernelValuePresetCoresById[candidate.presetId]
      const id = synthesizedPropertyDefinitionBlockId(workspaceId, candidate.key)

      // Has the key gained a definition since the plan was taken? Whose it is
      // does not matter — the invariant is "this key resolves a definition",
      // and minting a second one for a name that already has one is the rival
      // this whole re-check exists to prevent. Not answerable from
      // `tx.get(id)`: OUR id is vacant no matter who else claimed the name.
      if (resolver.resolve(candidate.key).status === 'resolved') {
        converged += 1
        continue
      }
      // DEFENCE IN DEPTH — no test pins it, because the resolve check above
      // catches every seed whose own definition is healthy. What is left is the
      // narrow case where a kept seed HOLDS the name but publishes no schema
      // (its preset comes from an extension that is not loaded here — the
      // situation `audit-properties` calls out as the common one): the name
      // then resolves nothing, while `buildPropertyDefinitionRegistry` still
      // excludes any user definition that collides with it. Minting there
      // reports success over a key that can never resolve.
      const claimedBySeed = registry?.workspaceId === workspaceId
        && registry.seedsByName.has(candidate.key)
      if (claimedBySeed) {
        skipped.push({key: candidate.key,
                      reason: 'a code seed declares this name, so a user definition for it can '
                        + 'never resolve — install or repair the seed\'s own definition instead'})
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
        // The definition block is already here and carries this key's name, yet
        // the name did not resolve above — the registry is a projection and has
        // not caught up (another device's row just arrived, or an earlier run of
        // this gesture). Nothing to write; publishing is the whole fix, and the
        // caller's next step reads the registry rather than the database.
        //
        // Published from the BLOCK's preset, never the plan's inferred one. The
        // block is live and may have been retyped deliberately; publishing the
        // plan's guess would have the backfill read historical values under one
        // codec and the projector replace it with another moments later. If its
        // preset is not one this pass can reproduce, skip rather than guess —
        // the flip then refuses and a re-run picks it up once the projector has
        // caught up.
        const storedPreset = storedPresetCore(occupancy.block)
        if (!storedPreset) {
          skipped.push({key: candidate.key,
                        reason: `block ${id} defines this key with a preset this pass cannot `
                          + 'reproduce; re-run once it is registered'})
          continue
        }
        converged += 1
        registrations.push({blockId: id, schema: schemaFor(candidate.key, storedPreset)})
        continue
      }
      if (occupancy.verdict === 'tombstoned') {
        // The name is checked HERE, not by `adoptable`: `classifyOccupant`
        // ranks `tombstoned` above it on purpose, so the predicate is never
        // asked about a tombstone. Without this check a definition renamed and
        // then deleted came back resurrected under the name the user chose, was
        // counted as a definition added, and left the original key with none.
        if (storedDefinitionName(occupancy.block) !== candidate.key) {
          skipped.push({key: candidate.key,
                        reason: `deleted block ${id} is a definition for a different name`})
          continue
        }
        // Someone deleted a synthesized definition while its key is still on
        // live blocks. Restore rather than mint a rival at a fresh id — but
        // restore-WITH-PATCH, re-asserting every field: `tx.restore(id)` alone
        // brings back the STORED bag, which measurably meant a definition
        // whose preset had been switched to `date` came back as `date` and
        // rewrote every value of the key on the next backfill, defeating
        // `inferPresetId`'s entire selection criterion.
        // ASSERT THE OUTCOME, don't enumerate the requirements. Restoring a
        // tombstone means adopting a bag some other writer last touched, and
        // any single field the metadata parser needs — the type, a valid
        // change-scope, whatever it requires next — is equally fatal in the
        // same way: the row restores, the parser rejects it, `appendUserSchema`
        // throws AFTER the transaction has committed, and every later run reads
        // the now-live occupant as `rejected`. Stuck, and unreachable by re-run.
        //
        // Two fields of that set were each found and patched a review round
        // apart, which is the tell that listing them is the wrong shape. So the
        // patch is also checked against the parser ITSELF before it is written:
        // if the restored row would not be a usable definition for this key,
        // skip and let the flip refuse rather than commit a row nothing can fix.
        //
        // DEFENCE IN DEPTH, and unpinned by design — deleting this check fails
        // no test, because the resets above already satisfy every requirement
        // the parser has TODAY. It exists for the requirement it gains
        // tomorrow, so that the next such field is a skipped key and a refused
        // flip instead of a third round of this.
        const patch = restoredDefinitionProperties(occupancy.block.properties, candidate)
        const restoredMetadata = parsePropertyDefinitionMetadata(
          {...occupancy.block, deleted: false, properties: patch.properties},
        )
        if (restoredMetadata?.name !== candidate.key) {
          skipped.push({key: candidate.key,
                        reason: `deleted block ${id} cannot be restored into a usable `
                          + 'definition for this key; repair or remove it'})
          continue
        }
        await tx.restore(id, patch)
        // The bag above carries the type, which is what the parser reads; this
        // maintains the `block_types` ROW that queries by type read.
        await repo.addTypeInTx(tx, id, PROPERTY_SCHEMA_TYPE, {})
        restored += 1
        registrations.push({blockId: id, schema: schemaFor(candidate.key, preset)})
        continue
      }
      // ABOUT TO MINT, so this is the last point a rival can be detected — and
      // the question is asked of the DATABASE, not the registry. The registry is
      // a projector-driven projection: a definition applied by sync commits in
      // its own transaction and is invisible to it until the tick, so both the
      // resolver above and its name index can miss one that is already there.
      // Minting then creates a rival, and when the projector catches up the
      // older row wins by creation time, leaving every field row the backfill
      // just bound to the loser's fieldId stranded. Inside the write lock no
      // other writer can commit, so this read holds for the rest of the tx.
      //
      // It also catches the definition that PARSED but supplies no behavior (an
      // unknown preset, a config its codec rejects): absent from `schemas`, so
      // the name resolved nothing above, yet perfectly real in `blocks`.
      //
      // Checked HERE rather than at the top of the loop because our own
      // converged definition is a live row for this name too.
      //
      // This skips — and so blocks the flip — where the plan-time equivalent
      // lands in `brokenDefinitions`, which deliberately does not block. The
      // asymmetry is consent: a broken definition the operator saw counted in
      // the dialog is one they agreed to migrate around; one that arrived after
      // they confirmed is not, and re-running shows it to them.
      if (liveDefinitionNames.has(candidate.key)) {
        skipped.push({key: candidate.key,
                      reason: 'a definition block for this name already exists and supplies '
                        + 'no behavior — repair it rather than adding a second'})
        continue
      }
      // `createOrGet` + `systemMint`, like every other deterministic-id creator
      // in `src/` — `createChild` cannot pass `systemMint`
      // (`mutators.ts`), and without it two devices minting this id in the same
      // millisecond write equal nonzero stamps from different writes and the
      // loser strands. The follow-up shaping writes hold `updated_at` at 0, so
      // the whole mint uploads as one pristine default.
      await tx.createOrGet({
        id,
        workspaceId,
        parentId,
        orderKey: await orderKeyForInsert(tx, parentId, workspaceId, {kind: 'last'}),
        // Content stays EMPTY, matching `addSchema` — a definition's name lives
        // in `property:name`, never in its content; only code SEEDS mirror the
        // two, and a synthesized definition is user-origin.
        content: '',
      }, {systemMint: true})
      await repo.addTypeInTx(tx, id, PROPERTY_SCHEMA_TYPE, {})
      await tx.setProperty(id, propertyNameProp, candidate.key)
      await tx.setProperty(id, presetIdProp, candidate.presetId)
      await tx.setProperty(id, presetConfigProp, {})
      // VISIBLE, deliberately. The first cut minted these hidden on the theory
      // that nothing chose these names or codecs on purpose so they shouldn't
      // crowd the panel — which had it backwards (Vlad's call): the whole point
      // is that a human triages them, and a hidden property is one nobody is
      // ever prompted to look at. Written explicitly rather than left to the
      // default so the intent is on the record.
      await tx.setProperty(id, propertyHiddenProp, false)
      created += 1
      registrations.push({blockId: id, schema: schemaFor(candidate.key, preset)})
    }
  }, {
    scope: ChangeScope.BlockDefault,
    description: 'synthesize property definitions',
    // The gesture clears the workspace's undo stack at the flip, and on the
    // already-flipped path the backfill clears it on its first batch — but a
    // run can end between the two (a peer holds the claim, the pass defers),
    // leaving these as the only committed write with a live undo entry. A
    // cmd-Z would then delete definitions whose keys are already migrating.
    skipUndo: true,
  })

  // Publish synchronously, the same reason `addSchema` does: the caller's very
  // next step is the backfill, which freezes ONE resolver for the whole
  // multi-minute run. Waiting for the projector's subscription tick would let
  // that pass skip every key this one just fixed and report success.
  for (const {schema, blockId} of registrations) {
    repo.userSchemas.appendUserSchema(schema, blockId, workspaceId)
  }

  return {created, restored, converged, skipped}
}

