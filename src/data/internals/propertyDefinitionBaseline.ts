/**
 * Durable per-workspace record of the property-definition CODEC TYPES this
 * DEVICE has accounted for — the "before" side the registry-PRIME diff needs
 * (#780).
 *
 * The facet bridge detects a definition change by diffing the previous
 * in-memory registry snapshot against the incoming one, and has no comparable
 * previous snapshot on PRIME. This is the before-state that survives a
 * workspace switch and a reload.
 *
 * ── Why only codecs ──
 *
 * Sync carries a definition change WITH its consequences: the device that
 * renamed re-keyed every consuming cell in the same tx, and those rows upload
 * like any other write. A receiving device therefore gets correct cells and has
 * nothing to re-key. What survives is a row the originating device never had,
 * or lost LWW on — a block created or edited offline across the change. That is
 * a divergence between a cell and its field rows, which the slice C reconcile
 * detects from CONTENT, on whichever device holds the stale row and whether or
 * not it ever recorded a before-state. A baseline is a strictly weaker answer
 * there, so renames are left to it.
 *
 * A CODEC change is the case content comparison cannot see: cells and field
 * rows agree, and only the stored encoding is stale. Detecting that needs a
 * before-state, which is what this is.
 *
 * ── The baseline advances on ADD or on APPLY, never on mere observation ──
 *
 * `observePropertyDefinitionCodecs` folds in only the fieldIds it doesn't know
 * yet — including one whose codec resolves for the first time, since a
 * definition first seen while its preset plugin was loading has none. A fieldId
 * whose observed codec DIFFERS is left as it was: that difference IS the drift,
 * and has to stay visible to every prime until a migration re-encodes the
 * values.
 *
 * Two simplifications are wrong. Suppressing the drift for the rebuild that
 * observes it: the NEXT rebuild's in-memory previous already carries the new
 * codec, sees no change, and folds it in. Recording at DETECTION time: the
 * deferred pass runs 10–30s later on deep idle and may never run at all (tab
 * closed, batch threw, workspace un-flipped, repo read-only).
 *
 * A consequence worth not undoing: every refusal downstream is self-healing. An
 * unresolvable fieldId, an un-flipped workspace — neither records, so each
 * re-detects at the next prime and applies once the obstacle clears. Nothing
 * here needs retry logic.
 *
 * Storage is one JSON row per workspace in `client_schema_state`, local and
 * unsynced: this records what THIS device has done, not shared state.
 *
 * A MISSING baseline means "migrate nothing", not "everything changed": with no
 * observed before-state, re-encoding would run off a diff this device never
 * made.
 */

import {
  PROPERTY_DEFINITION_BASELINE_PREFIX,
  RECORD_PROPERTY_DEFINITION_BASELINE_SQL,
  SELECT_PROPERTY_DEFINITION_BASELINE_SQL,
} from './clientSchema'

/** fieldId → codec type. A definition whose schema hasn't resolved is absent
 *  rather than recorded with a placeholder, so the first build that DOES
 *  resolve one adds it instead of reading as a change. */
export type PropertyDefinitionCodecTypes = ReadonlyMap<string, string>

/** Stored shape: `{codecs: {[fieldId]: codecType}}`. Unparseable reads as
 *  absent and is replaced: with no before-state there is nothing to diff, so a
 *  corrupt blob costs one absorbed drift — the same boundary, and the same
 *  reasoning, as a missing baseline. */
const parseBaseline = (raw: string | null): Map<string, string> | null => {
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const codecs = (parsed as {codecs?: unknown} | null)?.codecs
  if (typeof codecs !== 'object' || codecs === null) return null
  const types = new Map<string, string>()
  for (const [fieldId, codecType] of Object.entries(codecs as Record<string, unknown>)) {
    if (typeof codecType === 'string') types.set(fieldId, codecType)
  }
  return types
}

const serializeBaseline = (types: PropertyDefinitionCodecTypes): string => {
  const codecs: Record<string, string> = {}
  // Canonical key order, so the blob is diffable and two devices that observed
  // the same definitions in different orders store the same bytes. (The
  // write-skip below does not depend on it: the stored blob fixes iteration
  // order, and an update only re-sets existing keys or appends.)
  for (const fieldId of [...types.keys()].sort()) codecs[fieldId] = types.get(fieldId)!
  return JSON.stringify({codecs})
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
 *
 * One write transaction per registry rebuild is accepted: the serialize-compare
 * skips the INSERT in the overwhelmingly common no-change case, and rebuilds
 * are definition/preset/workspace-pin events, not typing.
 */
const updateBaseline = async (
  db: BaselineDb,
  workspaceId: string,
  update: (next: Map<string, string>) => void,
): Promise<PropertyDefinitionCodecTypes | null> =>
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
 * Fold a registry build's codec types in and return the baseline as it was
 * before — the caller's "previous" for its drift diff.
 *
 * ADD-only: a fieldId the baseline already knows keeps its recorded codec, even
 * when this build observed a different one. See the module header for why that
 * is the design and not a conservatism.
 */
export const observePropertyDefinitionCodecs = (
  db: BaselineDb,
  workspaceId: string,
  types: PropertyDefinitionCodecTypes,
): Promise<PropertyDefinitionCodecTypes | null> =>
  updateBaseline(db, workspaceId, next => {
    for (const [fieldId, codecType] of types) {
      if (!next.has(fieldId)) next.set(fieldId, codecType)
    }
  })

/** Record definitions whose re-encode has APPLIED — the only way a known
 *  fieldId's recorded codec ever changes. */
export const recordAppliedPropertyDefinitionCodecs = async (
  db: BaselineDb,
  workspaceId: string,
  types: PropertyDefinitionCodecTypes,
): Promise<void> => {
  // Unreachable from the current caller (a batch with no plans returns earlier),
  // but not a no-op: without it an empty call on a workspace with no row writes
  // `{}`, turning "no baseline" into "present but empty" — and those two mean
  // opposite things to the diff.
  if (types.size === 0) return
  await updateBaseline(db, workspaceId, next => {
    for (const [fieldId, codecType] of types) next.set(fieldId, codecType)
  })
}
