import type {BlockData} from '@/data/api'
import {devAssertionsEnabled} from '@/data/internals/devAssertions'
import type {TxDb} from '@/data/internals/txEngine'
import {deriveReferenceColumns, type ReferenceTargetLookups} from '@/data/internals/referenceTargetProcessor'
import {MAX_IDS_PER_IN_CLAUSE} from '@/data/internals/sqlBinds'
import {parseExactReferenceBlockContent} from '@/data/referenceBlock'
import type {MaterializeDeps, SyncSnapshot} from './materialize'

interface Stamp {
  id: string
  before: BlockData | null
  after: BlockData
}

/** All upserts have fired their alias-index triggers before this pass. Its
 *  local-column writes stay inside that transaction, before invalidation.
 *  Never open a repo.tx here: it would deadlock the write lock and upload. */
export const deriveReferenceTargetsAtArrival = async (
  tx: TxDb,
  snapshots: Map<string, SyncSnapshot>,
  deps: MaterializeDeps,
): Promise<string[]> => {
  if (!deps.referenceTargetLookups || ![...snapshots.values()].some(snapshot => snapshot.after)) return []
  const lookups = deps.referenceTargetLookups(tx)
  const changed: Stamp[] = []
  const aliasesByWorkspace = new Map<string, Set<string>>()
  const quarantined: string[] = []
  const quarantine = (id: string, error: unknown) => {
    console.warn(`[arrivalProcessors] sync.deriveReferenceTargetAtArrival quarantined ${id}:`, error)
    quarantined.push(id)
  }
  for (const [id, {before, after}] of snapshots) {
    if (!after) continue
    // The upsert preserves these local columns, including when derivation fails.
    snapshots.set(id, {before, after: {
      ...after, referenceTargetId: before?.referenceTargetId ?? null,
      isFieldForm: before?.isFieldForm ?? false,
    }})
    if (before && before.content === after.content) continue
    try {
      const exact = parseExactReferenceBlockContent(after.content)
      if (exact?.kind === 'alias') {
        const aliases = aliasesByWorkspace.get(after.workspaceId) ?? new Set<string>()
        aliases.add(exact.alias)
        aliasesByWorkspace.set(after.workspaceId, aliases)
      }
      changed.push({id, before, after})
    } catch (error) {
      quarantine(id, error)
    }
  }

  const cached = new Map<string, Map<string, Promise<string | null>>>()
  for (const [workspaceId, aliases] of aliasesByWorkspace) {
    const values = new Map<string, Promise<string | null>>()
    cached.set(workspaceId, values)
    if (lookups.aliasTargetIds) {
      try {
        const targets = await lookups.aliasTargetIds([...aliases], workspaceId)
        for (const [alias, id] of targets) values.set(alias, Promise.resolve(id))
      } catch {
        // A failed bulk read falls back to isolated lookups below.
      }
    }
  }
  const memoized: ReferenceTargetLookups = {
    aliasTargetId: (alias, workspaceId) => {
      const values = cached.get(workspaceId)!
      let value = values.get(alias)
      if (!value) {
        value = lookups.aliasTargetId(alias, workspaceId)
        values.set(alias, value)
      }
      return value
    },
  }
  const stamps: Stamp[] = []
  for (const {id, before, after} of changed) {
    try {
      const derived = await deriveReferenceColumns(after.content, after.workspaceId, memoized)
      const targetId = derived.targetId ?? null
      if (targetId !== (before?.referenceTargetId ?? null) || derived.isFieldForm !== (before?.isFieldForm ?? false)) {
        stamps.push({id, before, after: {...after, referenceTargetId: targetId, isFieldForm: derived.isFieldForm}})
      }
    } catch (error) {
      quarantine(id, error)
    }
  }

  const write = async (rows: readonly Stamp[]): Promise<void> => {
    // RAISE(FAIL) can leave earlier rows changed. Roll back the whole statement
    // before isolating a bad row, including its audit-trigger side effects.
    await tx.execute('SAVEPOINT sync_arrival_derivation')
    try {
      await tx.execute(`
        WITH stamps(id, target_id, field_form) AS (VALUES ${rows.map(() => '(?, ?, ?)').join(', ')})
        UPDATE blocks SET reference_target_id = stamps.target_id, is_field_form = stamps.field_form
        FROM stamps WHERE blocks.id = stamps.id
      `, rows.flatMap(row => [row.id, row.after.referenceTargetId ?? null, row.after.isFieldForm ? 1 : null]))
    } catch (error) {
      await tx.execute('ROLLBACK TO sync_arrival_derivation')
      await tx.execute('RELEASE sync_arrival_derivation')
      if (rows.length === 1) quarantine(rows[0]!.id, error)
      else for (const row of rows) await write([row])
      return
    }
    await tx.execute('RELEASE sync_arrival_derivation')
    for (const {id, before, after} of rows) snapshots.set(id, {before, after})
  }
  const rowsPerStamp = Math.floor(MAX_IDS_PER_IN_CLAUSE / 3)
  for (let i = 0; i < stamps.length; i += rowsPerStamp) await write(stamps.slice(i, i + rowsPerStamp))

  if (devAssertionsEnabled()) {
    const context = await tx.getOptional<{source: string | null}>('SELECT source FROM tx_context WHERE id = 1')
    if (context?.source != null) {
      throw new Error('[arrivalProcessors] sync.deriveReferenceTargetAtArrival left tx_context.source set — arrival derivation must write only device-local columns')
    }
  }
  return quarantined
}
