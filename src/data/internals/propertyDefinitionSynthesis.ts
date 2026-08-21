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
  presetConfigProp,
  presetIdProp,
  propertyHiddenProp,
  propertyNameProp,
} from '@/data/properties'
import { getOrCreatePropertiesPage, propertiesPageBlockId } from '@/data/propertiesPage'
import { isGrammarShapedLabel, isRoundTrippableReferenceLabel } from '@/data/referenceBlock'
import type { Repo } from '@/data/repo'
import { readWorkspaceEncryptionMode } from '@/data/workspaceSchema'
import { getModePin } from '@/sync/keys/modePin'
import { OBJECT_BAG, keyOf, scanPropertyKeys } from './propertyKeyScan'

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

/** Per-key tally of what JSON types the cells actually hold. */
export interface ValueTypeCounts {
  booleans: number
  numbers: number
  texts: number
  /** null, array, object — everything a scalar preset cannot carry. */
  others: number
}

/**
 * Which preset can carry every value this key already holds?
 *
 * The criterion is NOT "what does this data look like" but "which codec can
 * read every stored value back out unchanged". A synthesized definition is
 * applied retroactively to values written before it existed, and once the
 * workspace is flipped the cell is re-derived from the children — so a codec
 * whose round trip rewrites the value silently rewrites the user's data.
 *
 * That is why `date` is not inferred, though the design lists it: `codecs.date`
 * decodes `"2026-08-20"` to a Date and re-encodes it as
 * `"2026-08-20T00:00:00.000Z"`, so every ISO-looking cell in the workspace
 * would be rewritten by a definition nobody asked for — and `new Date()` is
 * lenient enough ("2026", "Sat Aug 20 2026") that the class it would claim is
 * wider than it looks. Date-shaped keys come out as `string`, which is exact;
 * switching the definition's preset afterwards is one click, and the
 * definition is minted hidden precisely so it gets that look.
 *
 * Mixed and structured values fall to `raw-json` (identity in, identity out).
 */
export const inferPresetId = (counts: ValueTypeCounts): SynthesizedPresetId => {
  if (counts.others > 0) return 'raw-json'
  const populated = [counts.booleans, counts.numbers, counts.texts].filter(n => n > 0)
  if (populated.length !== 1) return 'raw-json'
  if (counts.booleans > 0) return 'boolean'
  if (counts.numbers > 0) return 'number'
  return 'string'
}

/** A key synthesis will mint a definition for. */
export interface SynthesisCandidate {
  key: string
  cells: number
  presetId: SynthesizedPresetId
  /** Storable as-is, but worth an operator's eye. Never a refusal. */
  notes: string[]
}

/** A key no definition can ever back, so the workspace must not flip until it
 *  is deleted or remapped. */
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
  if (isGrammarShapedLabel(key)) {
    return `${JSON.stringify(key)} reads as a block reference, not a name. A definition is ` +
      'addressed as `[[name]]` wherever it is named, so this one would point at another ' +
      'block — and a `::`-marked form would turn that row into property machinery'
  }
  return null
}

/** Things about the name an operator may want to fix later. Deliberately not
 *  refusals: field rows are `::((fieldId))`, so a name that fails the wikilink
 *  round trip is still a perfectly good definition name and cell key — it
 *  merely cannot gain the `[[name]]` affordance. The name is kept VERBATIM
 *  for the same reason `addSchema` is not the path here: it trims, which would
 *  mint `"foo"` for the cell key `" foo "` and leave the original still
 *  definition-less. */
const nameNotes = (key: string): string[] => {
  const notes: string[] = []
  if (key !== key.trim()) {
    notes.push('has leading or trailing whitespace, kept verbatim so it still matches the cell key')
  }
  if (!isRoundTrippableReferenceLabel(key.trim())) {
    notes.push('cannot be written as a `[[name]]` link (a `]]` is lossy there)')
  }
  return notes
}

interface ValueTypeRow {
  property: string | null
  booleans: number
  numbers: number
  texts: number
  others: number
}

/** What JSON types each of `keys` is stored as, across the workspace's live
 *  blocks. Restricted to the candidate keys rather than grouping the whole
 *  graph: the key list is already known and the tally is only needed for the
 *  handful being minted. */
const valueTypeCounts = async (
  repo: Repo,
  workspaceId: string,
  keys: readonly string[],
): Promise<Map<string, ValueTypeCounts>> => {
  if (keys.length === 0) return new Map()
  const rows = await repo.db.getAll<ValueTypeRow>(
    `SELECT j.key AS property,
            SUM(j.type IN ('true','false')) AS booleans,
            SUM(j.type IN ('integer','real')) AS numbers,
            SUM(j.type = 'text') AS texts,
            SUM(j.type NOT IN ('true','false','integer','real','text')) AS others
       FROM blocks b, json_each(${OBJECT_BAG}) j
      WHERE b.workspace_id = ? AND b.deleted = 0
        AND j.key IN (SELECT value FROM json_each(?))
      GROUP BY j.key`,
    [workspaceId, JSON.stringify(keys)],
  )
  return new Map(rows.map(row => [keyOf(row.property), {
    booleans: row.booleans,
    numbers: row.numbers,
    texts: row.texts,
    others: row.others,
  }] as const))
}

/**
 * What synthesis would do to this workspace. Reads only.
 *
 * Separate from the write so the operator gesture can refuse on the blockers
 * BEFORE it flips anything — a blocker makes the "no definition-less keys"
 * gate unsatisfiable forever, and past `cell-off` the column drop would take
 * the value's only carrier with it.
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
  const mintable: Array<{key: string; cells: number}> = []

  for (const entry of scan.unresolved) {
    // A definition block already exists for this name and still doesn't
    // resolve, so the definition is BROKEN (an unloaded preset provider,
    // metadata that fails to parse). A second one would collide in the winner
    // machinery rather than fix anything.
    if (entry.definitionBlocks > 0) {
      brokenDefinitions.push({key: entry.property, cells: entry.cells})
      continue
    }
    const reason = keyCannotBeDefined(entry.property)
    if (reason !== null) {
      blockers.push({key: entry.property, cells: entry.cells, reason})
      continue
    }
    mintable.push({key: entry.property, cells: entry.cells})
  }

  const counts = await valueTypeCounts(repo, workspaceId, mintable.map(e => e.key))
  const candidates: SynthesisCandidate[] = mintable.map(entry => ({
    key: entry.key,
    cells: entry.cells,
    // A key present in the scan always has at least one cell, so a missing
    // tally means the two reads disagree (a concurrent delete between them).
    // `raw-json` is the answer that cannot be wrong about data it did not see.
    presetId: inferPresetId(counts.get(entry.key)
      ?? {booleans: 0, numbers: 0, texts: 0, others: 0}),
    notes: nameNotes(entry.key),
  }))

  return {workspaceId, refusal, unreadableBlocks: scan.unreadableBlocks, candidates,
          blockers, brokenDefinitions}
}

/**
 * Why this workspace must not be flipped to child-backed properties yet, or
 * null.
 *
 * A blocker is a key no definition can EVER back, so it makes the "every cell
 * key resolves a definition" invariant unsatisfiable forever — and past
 * `cell-off` the column drop would take the value's only carrier with it. A
 * workspace refusal (e2ee) blocks only when there is actually something to
 * mint; otherwise the invariant already holds.
 *
 * Advisory for an ALREADY-flipped workspace, where there is no irreversible
 * step left to guard — the backfill should still fill in everything else.
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
  properties: {
    ...stored,
    [propertyNameProp.name]: propertyNameProp.codec.encode(candidate.key),
    [presetIdProp.name]: presetIdProp.codec.encode(candidate.presetId),
    [presetConfigProp.name]: presetConfigProp.codec.encode({}),
    [propertyHiddenProp.name]: propertyHiddenProp.codec.encode(true),
  },
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
 * Deliberately says nothing about `plan.blockers`. A blocker blocks the FLIP —
 * it is a key no definition can ever back — and minting the OTHER keys'
 * definitions is useful either way, including on a workspace that is already
 * flipped and has no irreversible step left to guard.
 * {@link flipBlockedBySynthesis} is where that decision lives.
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
        converged += 1
        registrations.push({blockId: id, schema: schemaFor(candidate.key, preset)})
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
        await tx.restore(id, restoredDefinitionProperties(occupancy.block.properties, candidate))
        restored += 1
        registrations.push({blockId: id, schema: schemaFor(candidate.key, preset)})
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
      // Nothing chose these names or these codecs on purpose, so they stay out
      // of the property panel until someone has looked at them.
      await tx.setProperty(id, propertyHiddenProp, true)
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

