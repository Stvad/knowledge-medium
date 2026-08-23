/**
 * Durable per-workspace record of the property definitions this DEVICE has
 * ACCOUNTED FOR — the "before" side the registry-PRIME diff needs (#780).
 *
 * The facet bridge detects a definition change by diffing the previous
 * in-memory registry snapshot against the incoming one, and has no comparable
 * previous snapshot on PRIME. This is the before-state that survives a
 * workspace switch and a reload.
 *
 * ── The baseline advances on ADD or on APPLY, never on mere observation ──
 *
 * `observePropertyDefinitions` folds in only the fieldIds the baseline doesn't
 * know yet. A fieldId whose observed fact DIFFERS is left exactly as it was:
 * that difference IS the drift, and it has to stay visible to every subsequent
 * prime until a migration actually re-keys the cells, at which point
 * `recordAppliedPropertyDefinitions` writes the new fact.
 *
 * Getting this wrong is subtle, and two weaker shapes were measured failing.
 * Suppressing the drift for the one rebuild that observes it is not enough —
 * the NEXT rebuild's in-memory previous snapshot already carries the new name,
 * sees no change, and folds it in. Recording at DETECTION time rather than at
 * apply time is not enough either: the deferred pass runs 10–30s later on deep
 * idle and may never run at all (tab closed, batch threw, workspace not flipped
 * yet, repo read-only), and the change would be absorbed as though handled.
 * Both restore #780's silent loss. Only "the baseline says what this device has
 * DONE" is stable under an arbitrary number of intervening rebuilds.
 *
 * It also makes every refusal downstream self-healing for free: a contested
 * rename, an unresolvable fieldId, an un-flipped workspace — none of them
 * record, so each is re-detected at the next prime and applies as soon as the
 * obstacle clears.
 *
 * Storage is one JSON row per workspace in `client_schema_state`, local and
 * unsynced: this records what THIS device has done, not shared state.
 *
 * A MISSING baseline means "migrate nothing", not "everything changed": with no
 * observed before-state, re-keying would run off a diff this device never made.
 * Nor does that swallow a rename — the device that performed it re-keyed its
 * own cells in the editing tx and synced them, so a first-time reader receives
 * correct rows.
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

/** Stored shape: `{fields: {[fieldId]: {name, codecType?}}}`. Unparseable or
 *  unrecognized reads as absent and is replaced — the blob is derived,
 *  device-local and rebuilt by the next registry build, so the worst a bad read
 *  costs is one redundant no-op migration pass. */
const parseBaseline = (raw: string | null): Map<string, PropertyDefinitionFacts> | null => {
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const fields = (parsed as {fields?: unknown} | null)?.fields
  if (typeof fields !== 'object' || fields === null) return null
  const facts = new Map<string, PropertyDefinitionFacts>()
  for (const [fieldId, entry] of Object.entries(fields as Record<string, {
    name?: unknown
    codecType?: unknown
  }>)) {
    if (typeof entry?.name !== 'string') continue
    facts.set(fieldId, typeof entry.codecType === 'string'
      ? {name: entry.name, codecType: entry.codecType}
      : {name: entry.name})
  }
  return facts
}

const serializeBaseline = (facts: PropertyDefinitionFactsByFieldId): string => {
  const fields: Record<string, PropertyDefinitionFacts> = {}
  // Sorted so an unchanged baseline serializes byte-identically whatever order
  // the registry iterated in — that equality is what skips the write.
  for (const fieldId of [...facts.keys()].sort()) fields[fieldId] = facts.get(fieldId)!
  return JSON.stringify({fields})
}

export interface BaselineTx {
  getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>
  execute(sql: string, params?: unknown[]): Promise<unknown>
}

/** Minimal `client_schema_state` access surface, structurally typed so this is
 *  unit-testable without a full Repo / PowerSync. A transaction, not a read
 *  plus a write: see `updateBaseline`. */
export interface BaselineDb {
  writeTransaction<R>(fn: (tx: BaselineTx) => Promise<R>): Promise<R>
}

const baselineKey = (workspaceId: string) => `${PROPERTY_DEFINITION_BASELINE_PREFIX}${workspaceId}`

/**
 * Read-modify-write the workspace's baseline, returning the state BEFORE the
 * update.
 *
 * One transaction, because the row is shared by every tab's Repo: an update
 * that merged against a process-local mirror and then wrote the whole blob
 * would delete the fieldIds only the OTHER tab had seen — reachable today,
 * since a `?safeMode` tab's registry is a strict subset.
 */
const updateBaseline = async (
  db: BaselineDb,
  workspaceId: string,
  update: (next: Map<string, PropertyDefinitionFacts>) => void,
): Promise<PropertyDefinitionFactsByFieldId | null> =>
  db.writeTransaction(async tx => {
    const row = await tx.getOptional<{value: string | null}>(
      SELECT_PROPERTY_DEFINITION_BASELINE_SQL, [baselineKey(workspaceId)],
    )
    const stored = row?.value ?? null
    const previous = parseBaseline(stored)
    const next = new Map(previous ?? [])
    update(next)
    const serialized = serializeBaseline(next)
    if (serialized !== stored) {
      await tx.execute(
        RECORD_PROPERTY_DEFINITION_BASELINE_SQL, [baselineKey(workspaceId), serialized],
      )
    }
    return previous
  })

/**
 * Fold a registry build's `facts` in and return the baseline as it was before —
 * the caller's "previous" for its drift diff.
 *
 * ADD-only: a fieldId the baseline already knows keeps its recorded fact, even
 * when this build observed a different one. See the module header for why that
 * is the design and not a conservatism.
 */
export const observePropertyDefinitions = (
  db: BaselineDb,
  workspaceId: string,
  facts: PropertyDefinitionFactsByFieldId,
): Promise<PropertyDefinitionFactsByFieldId | null> =>
  updateBaseline(db, workspaceId, next => {
    for (const [fieldId, observed] of facts) {
      if (!next.has(fieldId)) next.set(fieldId, observed)
    }
  })

/** Record definitions whose migration has APPLIED — the only way a known
 *  fieldId's recorded fact ever changes. */
export const recordAppliedPropertyDefinitions = async (
  db: BaselineDb,
  workspaceId: string,
  facts: PropertyDefinitionFactsByFieldId,
): Promise<void> => {
  if (facts.size === 0) return
  await updateBaseline(db, workspaceId, next => {
    for (const [fieldId, applied] of facts) next.set(fieldId, applied)
  })
}
