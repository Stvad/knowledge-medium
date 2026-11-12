/**
 * The operator step that moves materialized property seed rows to the hidden
 * tier after their declarations did — or back out of it.
 *
 * `materializeSeeds` only creates and restores, so a declaration's `hidden` bump
 * reaches new workspaces and nothing else; the stored `property-schema:hidden`
 * on each existing row stays the authority the registry reads. This rewrites
 * exactly that cell and `seed:revision` on the rows named, in the ACTIVE
 * workspace, when a person runs it. Never scheduled: it uploads source-of-truth
 * rows, so one device runs it and the rest receive them.
 *
 * Re-running is a no-op: each row is re-read inside the writing tx and written
 * only from the exact before-state its direction expects.
 */

import { ChangeScope, type BlockData } from '@/data/api'
import { parseBlockRow, type BlockRow } from '@/data/blockSchema'
import { propertyDefinitionBlockId, seededDefinitionKey } from '@/data/definitionSeeds'
import { propertyHiddenProp, seedRevisionProp } from '@/data/properties'
import type { Repo } from '@/data/repo'

/** A seed the pass covers, at the revision its declaration now carries. */
export interface SeedHiddenTierTarget {
  readonly seedKey: string
  readonly revision: number
}

/** `hide`: stored hidden false at a trailing revision → hidden true at the
 *  declared revision. `unhide` is its recovery: stored hidden true → false, at a
 *  revision past both the stored one and the declaration's, so a later `hide`
 *  run reads the row as deliberately diverged instead of re-hiding it. */
export type SeedHiddenTierDirection = 'hide' | 'unhide'

export type SeedHiddenTierStatus = 'upgraded' | 'already-current' | 'skipped-diverged' | 'absent'

export interface SeedHiddenTierRow {
  readonly seedKey: string
  readonly blockId: string
  readonly status: SeedHiddenTierStatus
  /** Why a row is skipped or absent; absent for `upgraded` / `already-current`. */
  readonly reason?: string
  readonly storedRevision?: number
  readonly storedHidden?: boolean
  /** The revision an `upgraded` row is (or, on a dry run, would be) written at. */
  readonly writeRevision?: number
}

export interface SeedHiddenTierResult {
  readonly workspaceId: string
  readonly direction: SeedHiddenTierDirection
  /** False on a dry run: `upgraded` then counts the rows a write WOULD change. */
  readonly applied: boolean
  readonly counts: Readonly<Record<'upgraded' | 'alreadyCurrent' | 'skippedDiverged' | 'absent', number>>
  readonly seeds: readonly SeedHiddenTierRow[]
}

const decodeOrUndefined = <T>(decode: (raw: unknown) => T, raw: unknown): T | undefined => {
  if (raw === undefined) return undefined
  try {
    return decode(raw)
  } catch {
    return undefined
  }
}

/** The one decision both the dry run and the write make, from a row read in
 *  their own context. */
const classify = (
  target: SeedHiddenTierTarget,
  blockId: string,
  row: BlockData | null,
  direction: SeedHiddenTierDirection,
): SeedHiddenTierRow => {
  const base = {seedKey: target.seedKey, blockId}
  if (row === null) return {...base, status: 'absent', reason: 'no row'}
  if (row.deleted) return {...base, status: 'absent', reason: 'tombstoned'}
  if (seededDefinitionKey(row) !== target.seedKey) {
    return {...base, status: 'skipped-diverged', reason: 'row is not seed-provenanced for this key'}
  }
  const storedRevision = decodeOrUndefined(seedRevisionProp.codec.decode, row.properties[seedRevisionProp.name])
  const storedHidden = decodeOrUndefined(propertyHiddenProp.codec.decode, row.properties[propertyHiddenProp.name])
  const stored = {...base, storedRevision, storedHidden}
  if (storedRevision === undefined || storedHidden === undefined) {
    return {...stored, status: 'skipped-diverged', reason: 'stored revision or hidden is missing or undecodable'}
  }
  if (direction === 'hide') {
    if (storedHidden && storedRevision >= target.revision) return {...stored, status: 'already-current'}
    if (!storedHidden && storedRevision < target.revision) {
      return {...stored, status: 'upgraded', writeRevision: target.revision}
    }
    return {
      ...stored,
      status: 'skipped-diverged',
      reason: storedHidden
        ? `hidden at revision ${storedRevision}, below the declared ${target.revision}`
        : `visible at revision ${storedRevision}, not below the declared ${target.revision}`,
    }
  }
  if (!storedHidden) return {...stored, status: 'already-current'}
  return {...stored, status: 'upgraded', writeRevision: Math.max(storedRevision, target.revision) + 1}
}

const countRows = (rows: readonly SeedHiddenTierRow[]): SeedHiddenTierResult['counts'] => ({
  upgraded: rows.filter(row => row.status === 'upgraded').length,
  alreadyCurrent: rows.filter(row => row.status === 'already-current').length,
  skippedDiverged: rows.filter(row => row.status === 'skipped-diverged').length,
  absent: rows.filter(row => row.status === 'absent').length,
})

const assertUniqueTargets = (targets: readonly SeedHiddenTierTarget[]): void => {
  const keys = new Set(targets.map(target => target.seedKey))
  if (keys.size !== targets.length) throw new Error('setSeedHiddenTier: duplicate seed key in targets')
}

const assertActive = (repo: Repo, workspaceId: string): void => {
  if (repo.activeWorkspaceId !== workspaceId) {
    throw new Error(
      `setSeedHiddenTier: workspace ${workspaceId} is not the active workspace ` +
      `(${repo.activeWorkspaceId ?? 'none'}); open it and re-run.`,
    )
  }
}

const assertMayWrite = (repo: Repo, workspaceId: string): void => {
  assertActive(repo, workspaceId)
  // Automation scope is admitted in a read-only workspace, so the role is
  // asked here rather than left to the commit gate.
  if (repo.isReadOnly) throw new Error(`setSeedHiddenTier: workspace ${workspaceId} is read-only here`)
}

export const setSeedHiddenTier = async (
  repo: Repo,
  workspaceId: string,
  targets: readonly SeedHiddenTierTarget[],
  options: {readonly direction: SeedHiddenTierDirection; readonly apply: boolean},
): Promise<SeedHiddenTierResult> => {
  assertUniqueTargets(targets)
  assertActive(repo, workspaceId)
  const {direction, apply} = options
  const idFor = (target: SeedHiddenTierTarget) => propertyDefinitionBlockId(workspaceId, target.seedKey)

  const planned: SeedHiddenTierRow[] = []
  for (const target of targets) {
    const id = idFor(target)
    // Tombstones included: `repo.load` reads them as missing.
    const row = await repo.db.getOptional<BlockRow>('SELECT * FROM blocks WHERE id = ?', [id])
    planned.push(classify(target, id, row === null ? null : parseBlockRow(row), direction))
  }
  // The plan is only a read; the write re-classifies every row inside its tx.
  if (!apply || !planned.some(row => row.status === 'upgraded')) {
    return {workspaceId, direction, applied: apply, counts: countRows(planned), seeds: planned}
  }

  const seeds: SeedHiddenTierRow[] = []
  // Automation: not undoable, and the seed-row guard keeps these rows out of
  // every BlockDefault undo entry, so there is no history to drop.
  await repo.tx(async tx => {
    const writes: Array<{row: BlockData; revision: number}> = []
    for (const target of targets) {
      const id = idFor(target)
      const current = await tx.get(id)
      const classified = classify(target, id, current, direction)
      seeds.push(classified)
      if (classified.status === 'upgraded') writes.push({row: current!, revision: classified.writeRevision!})
    }
    assertMayWrite(repo, workspaceId)
    for (const {row, revision} of writes) {
      // The whole bag, as materialization writes it: `setProperty` would
      // refuse, its BlockDefault scope differing in policy from this tx's.
      await tx.update(row.id, {
        properties: {
          ...row.properties,
          [propertyHiddenProp.name]: propertyHiddenProp.codec.encode(direction === 'hide'),
          [seedRevisionProp.name]: seedRevisionProp.codec.encode(revision),
        },
      }, {skipMetadata: true})
    }
  }, {
    scope: ChangeScope.Automation,
    description: direction === 'hide' ? 'move seed definitions to hidden tier' : 'move seed definitions out of hidden tier',
  })
  return {workspaceId, direction, applied: true, counts: countRows(seeds), seeds}
}
