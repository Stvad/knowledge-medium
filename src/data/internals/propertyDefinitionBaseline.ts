/**
 * Durable per-workspace record of the property definitions this DEVICE has
 * accounted for — the "before" side the registry-PRIME diff needs (#780).
 *
 * The facet bridge detects a definition change by diffing the previous
 * in-memory registry snapshot against the incoming one. On PRIME there is no
 * comparable previous snapshot (it is null, or belongs to another workspace),
 * so a change that landed while this device was looking elsewhere is invisible
 * — and, having run no `repo.tx` here, invisible to the same-tx rename
 * processor too. This store is the before-state that survives both a workspace
 * switch and a reload.
 *
 * Storage is one JSON row per workspace in `client_schema_state`, which is
 * local and unsynced: this records what THIS device has seen, not shared state.
 *
 * ── Missing baseline means "migrate nothing" ──
 *
 * Not "everything changed": with no observed before-state, re-keying would run
 * off a diff this device never made. Nor is a rename swallowed — the device
 * that performed it re-keyed its own cells in the editing tx and synced them,
 * so a first-time reader receives correct rows. What survives that is a cell
 * that diverged from its field rows on a third device, which is a content-level
 * reconcile no baseline can detect.
 *
 * Nothing revokes a baseline; every registry build folds its facts in. Wiping
 * `client_schema_state` returns the device to the missing case above.
 */

import type {
  PropertyDefinitionFacts,
  PropertyDefinitionFactsByFieldId,
} from './propertyDefinitionMigrations'
import {
  PROPERTY_DEFINITION_BASELINE_PREFIX,
  RECORD_PROPERTY_DEFINITION_BASELINE_SQL,
  SELECT_PROPERTY_DEFINITION_BASELINE_SQL,
} from './clientSchema'

/** Stored shape. Versioned so a blob written by a LATER build is recognized as
 *  unreadable rather than misparsed — and then left alone rather than
 *  overwritten, so an old tab open across a deploy can't cost the new one a
 *  generation of observations. */
interface StoredBaseline {
  readonly version: 1
  readonly fields: Record<string, {readonly name: string; readonly codecType?: string}>
}

const CURRENT_VERSION = 1

type BaselineRead =
  /** No row, or one this build should replace (unparseable / wrong shape). */
  | {readonly kind: 'absent'}
  | {readonly kind: 'facts'; readonly facts: Map<string, PropertyDefinitionFacts>}
  /** A version this build doesn't know: don't diff against it, don't clobber it. */
  | {readonly kind: 'foreign'}

const readBaseline = (raw: string | null): BaselineRead => {
  if (raw === null) return {kind: 'absent'}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {kind: 'absent'}
  }
  if (typeof parsed !== 'object' || parsed === null) return {kind: 'absent'}
  const {version, fields} = parsed as StoredBaseline
  if (version !== CURRENT_VERSION) {
    return typeof version === 'number' ? {kind: 'foreign'} : {kind: 'absent'}
  }
  if (typeof fields !== 'object' || fields === null) return {kind: 'absent'}
  const facts = new Map<string, PropertyDefinitionFacts>()
  for (const [fieldId, entry] of Object.entries(fields)) {
    if (typeof entry?.name !== 'string') continue
    facts.set(fieldId, typeof entry.codecType === 'string'
      ? {name: entry.name, codecType: entry.codecType}
      : {name: entry.name})
  }
  return {kind: 'facts', facts}
}

const serializeBaseline = (facts: PropertyDefinitionFactsByFieldId): string => {
  const fields: StoredBaseline['fields'] = {}
  // Sorted so an unchanged baseline serializes byte-identically whatever order
  // the registry iterated in — that equality is what skips the write.
  for (const fieldId of [...facts.keys()].sort()) fields[fieldId] = facts.get(fieldId)!
  return JSON.stringify({version: CURRENT_VERSION, fields} satisfies StoredBaseline)
}

/** Fold one observation into what we already knew about a fieldId.
 *
 *  A build can observe a definition's METADATA without a schema — its preset
 *  plugin hasn't loaded, or its config is invalid, and `userSchemasService`
 *  publishes metadata-only. Replacing the fact wholesale would ERASE the codec
 *  we already knew, and the next build that does resolve a schema would diff
 *  against a codec-less baseline, report no codec change, and silently swallow
 *  the re-encode. */
const foldFact = (
  known: PropertyDefinitionFacts | undefined,
  observed: PropertyDefinitionFacts,
): PropertyDefinitionFacts =>
  observed.codecType === undefined && known?.codecType !== undefined
    ? {name: observed.name, codecType: known.codecType}
    : observed

/** Minimal `client_schema_state` access surface, structurally typed so the
 *  store is unit-testable without a full Repo / PowerSync. A transaction, not
 *  a read plus a write: see `foldIn`. */
export interface BaselineDb {
  writeTransaction<R>(fn: (tx: {
    getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>
    execute(sql: string, params?: unknown[]): Promise<unknown>
  }) => Promise<R>): Promise<R>
}

const baselineKey = (workspaceId: string) => `${PROPERTY_DEFINITION_BASELINE_PREFIX}${workspaceId}`

export class PropertyDefinitionBaselineStore {
  constructor(private readonly db: BaselineDb) {}

  /**
   * Fold `facts` into this workspace's stored baseline and return the baseline
   * AS IT WAS before the fold (null when this device has recorded none, or when
   * the row was written by a build this one can't read).
   *
   * Read and write are ONE call, and one transaction, for two reasons. The
   * caller's diff needs the pre-fold state, so exposing them separately would
   * make an ordering requirement a convention. And the row is shared by every
   * tab: each tab is its own Repo, so a store that unioned against a process-
   * local mirror and then wrote the whole blob would delete the fieldIds only
   * the OTHER tab had seen — which is #780 again, since the next prime reads a
   * missing fieldId as a brand-new definition and swallows its rename. That is
   * reachable today: a `?safeMode` tab's registry is a strict subset.
   *
   * The fold is a UNION over fieldIds, not a replace: a build can legitimately
   * observe a subset, and forgetting a fieldId would make its return look like
   * a brand-new definition.
   */
  async foldIn(
    workspaceId: string,
    facts: PropertyDefinitionFactsByFieldId,
  ): Promise<PropertyDefinitionFactsByFieldId | null> {
    return this.db.writeTransaction(async tx => {
      const row = await tx.getOptional<{value: string | null}>(
        SELECT_PROPERTY_DEFINITION_BASELINE_SQL, [baselineKey(workspaceId)],
      )
      const stored = row?.value ?? null
      const read = readBaseline(stored)
      if (read.kind === 'foreign') return null
      const previous = read.kind === 'facts' ? read.facts : null
      const merged = new Map(previous ?? [])
      for (const [fieldId, observed] of facts) {
        merged.set(fieldId, foldFact(merged.get(fieldId), observed))
      }
      const serialized = serializeBaseline(merged)
      if (serialized !== stored) {
        await tx.execute(
          RECORD_PROPERTY_DEFINITION_BASELINE_SQL, [baselineKey(workspaceId), serialized],
        )
      }
      return previous
    })
  }
}
