/**
 * Per-workspace, per-device record of the property definitions this client
 * last SAW (issue #780).
 *
 * The facet bridge detects a definition rename / codec change by diffing the
 * PREVIOUS in-memory registry snapshot against the incoming one. That diff is
 * structurally blind on PRIME: coming back to a workspace, the previous
 * snapshot is null (first prime of the run) or belongs to a different
 * workspace, so `changedPropertyDefinitions` refuses it and a change that
 * landed while this device wasn't looking at that workspace — a synced-in
 * rename, which runs no `repo.tx` here and so never reaches the same-tx rename
 * processor — is never migrated. Cells stay keyed by a name nothing resolves.
 *
 * This store is the durable "previous" the prime case needs: a JSON blob per
 * workspace in `client_schema_state`, holding each definition's name and codec
 * type by durable fieldId. Local-only — it describes what THIS device has
 * observed, not shared state.
 *
 * ── What a MISSING baseline means ──
 *
 * Nothing to migrate, not "everything changed". A device that has never
 * recorded a baseline for a workspace has no before-state to compare against,
 * and treating the whole registry as new would re-key every cell in the graph
 * off a diff it never actually observed. The state it can't see is also not
 * its to repair: the device that made the rename re-keyed its own cells in the
 * editing tx and synced them, so a first-time reader receives already-correct
 * rows. What genuinely survives that — a cell written under the old name on a
 * THIRD device that was offline across the rename — is a content-level
 * divergence between cells and their field rows, which no baseline can detect
 * and which belongs to slice C's reconcile.
 *
 * ── What a baseline is INVALIDATED by ──
 *
 * Nothing revokes it; every registry build for a workspace merges its facts in
 * (see `merge`). Wiping `client_schema_state` (a local DB reset) returns the
 * device to the missing-baseline case above. A blob written by a future
 * version reads as missing rather than as a diff, so a shape change never
 * migrates against a misparsed before-state.
 */

import type {PropertyDefinitionRegistrySnapshot} from '@/data/propertyDefinitionRegistry'
import {
  PROPERTY_DEFINITION_BASELINE_PREFIX,
  RECORD_PROPERTY_DEFINITION_BASELINE_SQL,
  SELECT_PROPERTY_DEFINITION_BASELINE_SQL,
} from './clientSchema'

/** The identity-stable facts a definition-migration diff compares, per durable
 *  fieldId. `codecType` is absent when the registry carried the definition's
 *  metadata but no resolved schema (a definition block with no preset). */
export interface PropertyDefinitionFacts {
  readonly name: string
  readonly codecType?: string
}

export type PropertyDefinitionFactsByFieldId = ReadonlyMap<string, PropertyDefinitionFacts>

/** The diff inputs a registry snapshot contributes, by durable fieldId. */
export const propertyDefinitionFacts = (
  snapshot: PropertyDefinitionRegistrySnapshot,
): Map<string, PropertyDefinitionFacts> => {
  const facts = new Map<string, PropertyDefinitionFacts>()
  for (const [fieldId, metadata] of snapshot.definitionsByFieldId) {
    const codecType = snapshot.schemasByFieldId.get(fieldId)?.codec.type
    facts.set(fieldId, codecType === undefined ? {name: metadata.name} : {name: metadata.name, codecType})
  }
  return facts
}

/** Stored shape. Versioned so a future change reads as "no baseline" (record
 *  and move on) rather than as a diff against a misparsed before-state. */
interface StoredBaseline {
  readonly version: 1
  readonly fields: Record<string, {readonly name: string; readonly codecType?: string}>
}

const CURRENT_VERSION = 1

const parseBaseline = (raw: string | null): Map<string, PropertyDefinitionFacts> | null => {
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (
    typeof parsed !== 'object' || parsed === null
    || (parsed as StoredBaseline).version !== CURRENT_VERSION
  ) return null
  const fields = (parsed as StoredBaseline).fields
  if (typeof fields !== 'object' || fields === null) return null
  const facts = new Map<string, PropertyDefinitionFacts>()
  for (const [fieldId, entry] of Object.entries(fields)) {
    if (typeof entry?.name !== 'string') continue
    facts.set(fieldId, typeof entry.codecType === 'string'
      ? {name: entry.name, codecType: entry.codecType}
      : {name: entry.name})
  }
  return facts
}

const serializeBaseline = (facts: PropertyDefinitionFactsByFieldId): string => {
  const fields: StoredBaseline['fields'] = {}
  // Sorted so an unchanged baseline serializes byte-identically regardless of
  // registry iteration order — that equality is what skips the write.
  for (const fieldId of [...facts.keys()].sort()) fields[fieldId] = facts.get(fieldId)!
  return JSON.stringify({version: CURRENT_VERSION, fields} satisfies StoredBaseline)
}

/** Minimal `client_schema_state` access surface, structurally typed so the
 *  store is unit-testable without a full Repo / PowerSync (mirrors
 *  `MarkerDb`). */
export interface BaselineDb {
  getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>
  execute(sql: string, params?: unknown[]): Promise<unknown>
}

const baselineKey = (workspaceId: string) => `${PROPERTY_DEFINITION_BASELINE_PREFIX}${workspaceId}`

/** Lazy per-workspace mirror of the stored baselines: one SELECT per workspace
 *  per lifetime, then in-memory. */
export class PropertyDefinitionBaselineStore {
  /** Workspace → last known facts. A present key with a `null` value is a
   *  workspace we have READ and found no baseline for — distinct from one we
   *  haven't read yet, which is what makes "missing" a decidable state rather
   *  than an unread cache. */
  private readonly cache = new Map<string, Map<string, PropertyDefinitionFacts> | null>()
  /** Last serialization written per workspace, so an unchanged merge is free. */
  private readonly written = new Map<string, string>()

  constructor(private readonly db: BaselineDb) {}

  /** This workspace's stored baseline, or null when none has been recorded on
   *  this device (see the module header for why that means "migrate nothing"). */
  async read(workspaceId: string): Promise<PropertyDefinitionFactsByFieldId | null> {
    if (!this.cache.has(workspaceId)) {
      const row = await this.db.getOptional<{value: string | null}>(
        SELECT_PROPERTY_DEFINITION_BASELINE_SQL, [baselineKey(workspaceId)],
      )
      const parsed = parseBaseline(row?.value ?? null)
      this.cache.set(workspaceId, parsed)
      if (parsed !== null && row?.value != null) this.written.set(workspaceId, row.value)
    }
    return this.cache.get(workspaceId) ?? null
  }

  /** Fold `facts` into this workspace's baseline. UNION, not replace: a
   *  registry build can legitimately observe a subset (a projector re-priming,
   *  a plugin's seeds not yet loaded), and forgetting a fieldId would make its
   *  reappearance look like a brand-new definition — silently swallowing a
   *  rename that happened in between. Writes only when the result changed. */
  async merge(workspaceId: string, facts: PropertyDefinitionFactsByFieldId): Promise<void> {
    const merged = new Map(await this.read(workspaceId) ?? [])
    for (const [fieldId, entry] of facts) merged.set(fieldId, entry)
    const serialized = serializeBaseline(merged)
    this.cache.set(workspaceId, merged)
    if (this.written.get(workspaceId) === serialized) return
    await this.db.execute(
      RECORD_PROPERTY_DEFINITION_BASELINE_SQL, [baselineKey(workspaceId), serialized],
    )
    this.written.set(workspaceId, serialized)
  }

  /** Drop the in-memory mirror so the next read re-reads the table. For tests /
   *  migrations that mutate `client_schema_state` out of band (mirrors
   *  `MarkerStore.reset`). */
  reset(): void {
    this.cache.clear()
    this.written.clear()
  }
}
