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
 * ORDER MATTERS, and it is the operator's to get right: if an EXTENSION owns
 * a key, install/enable it first so its seed materializes the definition.
 * Synthesizing first and enabling the owner later puts two definitions in the
 * winner machinery and strands field rows on the loser's fieldId.
 * `audit-properties` names the owner where it can.
 */

import { ChangeScope, type AnyPropertySchema } from '@/data/api'
import { PROPERTY_SCHEMA_TYPE } from '@/data/blockTypes'
import { classifyOccupant, derivedBlockId } from '@/data/derivedIds'
import { createChild as createChildMutator } from '@/data/mutators'
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
  key: `${workspaceId}:${key}`,
})

/** The presets synthesis will pick. Every one of them round-trips a stored
 *  value unchanged through `encodedValueToContent` → `contentToEncodedValue`;
 *  see {@link inferPresetId} for why that is the selection criterion. */
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
  /** Non-null means this device could not vouch for its view of the graph.
   *  Synthesis WRITES, and a device that has not seen a definition yet would
   *  mint a rival for it — so this is a refusal, not an FYI. */
  syncGap: string | null
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
 * E2EE is the one case, and it is about the ID rather than the content:
 * synthesized definition ids are `uuidv5(workspaceId, key)` and block ids sync
 * in PLAINTEXT, so a server holding one could confirm a guessed private
 * property name (`health`, `client:ssn`) by recomputing the hash — precisely
 * the edge metadata §8 encrypts. The design's answer is a namespace derived
 * from workspace key material, which the key-holders can all compute and
 * nobody else can; until that exists, refusing is the only honest option, and
 * it costs nothing today because the server trigger refuses an e2ee flip
 * anyway.
 *
 * An ABSENT local `workspaces` row refuses too. Reading it as "not encrypted"
 * would fail open on a privacy question, for a device that has simply not
 * caught up.
 */
export const propertySynthesisWorkspaceRefusal = async (
  repo: Repo,
  workspaceId: string,
): Promise<string | null> => {
  const mode = await readWorkspaceEncryptionMode(repo.db, workspaceId)
  if (mode === null) {
    return 'this device has no workspace row for it yet, so its encryption mode is unknown ' +
      '— wait for sync to catch up'
  }
  if (mode === 'e2ee') {
    return 'end-to-end encrypted workspaces cannot synthesize definitions yet: the ' +
      'deterministic id would let the server confirm a guessed property name. They also ' +
      'cannot flip to property blocks yet, so nothing is lost by waiting'
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

  return {workspaceId, refusal, syncGap: scan.syncGap, candidates, blockers,
          brokenDefinitions}
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
): string | null => {
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

export interface SynthesisResult {
  created: number
  restored: number
  /** Candidates whose deterministic id was occupied by something this pass
   *  will not write through. Reported rather than forced. */
  skipped: Array<{key: string; reason: string}>
}

/**
 * Mint the planned definitions. One transaction, so the workspace either has
 * every definition this plan promised or none of them.
 *
 * Deliberately says nothing about `plan.blockers`. A blocker blocks the FLIP —
 * it is a key no definition can ever back, so the workspace can never reach
 * "no definition-less keys" — and minting the OTHER keys' definitions is
 * useful either way, including on a workspace that is already flipped and has
 * no irreversible step left to guard. {@link flipBlockedBySynthesis} is where
 * that decision lives.
 */
export const applyPropertyDefinitionSynthesis = async (
  repo: Repo,
  plan: PropertyDefinitionSynthesisPlan,
): Promise<SynthesisResult> => {
  const {workspaceId} = plan
  if (repo.isReadOnly) {
    throw new Error('[propertyDefinitionSynthesis] this workspace is read-only')
  }
  const skipped: SynthesisResult['skipped'] = []
  if (plan.candidates.length === 0) return {created: 0, restored: 0, skipped}

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

  // `tx.create` enforces `requireParentInWorkspace`, and this pass can run on
  // a workspace whose Properties page has not been materialized yet.
  await getOrCreatePropertiesPage(repo, workspaceId)
  const parentId = propertiesPageBlockId(workspaceId)

  let created = 0
  let restored = 0
  const registrations: Array<{schema: AnyPropertySchema; blockId: string}> = []

  await repo.tx(async tx => {
    for (const candidate of plan.candidates) {
      const preset = repo.valuePresetCores.get(candidate.presetId)
      if (!preset) {
        // Only kernel presets are ever inferred, so this is a broken runtime
        // rather than a data problem — and minting the rest while silently
        // dropping one would leave the gate unsatisfiable with no record.
        throw new Error(
          `[propertyDefinitionSynthesis] no preset registered for ${JSON.stringify(candidate.presetId)}`,
        )
      }
      const id = synthesizedPropertyDefinitionBlockId(workspaceId, candidate.key)
      const existing = await tx.get(id)
      const {verdict} = classifyOccupant(existing, {workspaceId})
      if (verdict === 'foreign') {
        skipped.push({key: candidate.key,
                      reason: `block ${id} belongs to another workspace`})
        continue
      }
      if (verdict === 'ours') {
        // Live, ours, and the key still doesn't resolve — so this row is not
        // serving as the key's definition (renamed, retyped, metadata broken).
        // Overwriting it would destroy whatever it became.
        skipped.push({key: candidate.key,
                      reason: `block ${id} already exists and is not this key's definition`})
        continue
      }
      if (verdict === 'tombstoned') {
        // A previous synthesis minted it and someone deleted it, while the key
        // is still on live blocks. Restore rather than mint a rival at a fresh
        // id: the deterministic id IS this key's definition, and the bag it
        // kept is more likely right than a fresh guess.
        await tx.restore(id)
        restored += 1
        continue
      }
      // Shaped exactly like `addSchema`'s write, down to the order: create,
      // lift type membership through `addTypeInTx` (so the `block_types` row
      // and the `types` property stay consistent), then the definition's own
      // fields. Content stays EMPTY — a definition's name lives in
      // `property:name`, never in its content; only code SEEDS mirror the two,
      // and a synthesized definition is user-origin.
      await tx.run(createChildMutator, {id, parentId, position: {kind: 'last'}})
      await repo.addTypeInTx(tx, id, PROPERTY_SCHEMA_TYPE, {})
      await tx.setProperty(id, propertyNameProp, candidate.key)
      await tx.setProperty(id, presetIdProp, candidate.presetId)
      await tx.setProperty(id, presetConfigProp, {})
      // Nothing chose these names or these codecs on purpose, so they stay out
      // of the property panel until someone has looked at them.
      await tx.setProperty(id, propertyHiddenProp, true)
      created += 1
      registrations.push({
        blockId: id,
        schema: {
          name: candidate.key,
          codec: preset.build(undefined as never),
          defaultValue: preset.defaultValue,
          changeScope: ChangeScope.BlockDefault,
        },
      })
    }
  }, {scope: ChangeScope.BlockDefault, description: 'synthesize property definitions'})

  // Publish synchronously, the same reason `addSchema` does: the caller's very
  // next step is the backfill, which asks the registry to resolve these names.
  // Waiting for the projector's subscription tick would let that pass skip
  // every key this one just fixed and report success.
  for (const {schema, blockId} of registrations) {
    repo.userSchemas.appendUserSchema(schema, blockId, workspaceId)
  }

  return {created, restored, skipped}
}
