import { ChangeScope } from '@/data/api'
import { getBlockTypes } from '@/data/properties.js'
import type { Repo } from '@/data/repo'
import {
  SRS_SM25_TYPE,
  srsArchivedProp,
  srsFactorProp,
  srsGradeProp,
  srsIntervalProp,
  srsNextReviewDateProp,
  srsReviewCountProp,
  srsSnapshotHistoryProp,
} from './schema.ts'

const SRS_PROPERTY_NAMES = [
  srsIntervalProp.name,
  srsFactorProp.name,
  srsNextReviewDateProp.name,
  srsReviewCountProp.name,
  srsGradeProp.name,
  srsArchivedProp.name,
  srsSnapshotHistoryProp.name,
] as const

/** Move the SRS SM-2.5 type and all SRS field values from one block to
 *  another, in a single transaction. After the move the source block no
 *  longer has the SRS type and none of the SRS fields, and the target
 *  has exactly the SRS state the source had (any prior SRS state on the
 *  target is wholly replaced — this is move, not merge). */
export const moveSrsState = async (
  repo: Repo,
  sourceBlockId: string,
  targetBlockId: string,
): Promise<void> => {
  if (sourceBlockId === targetBlockId) return
  if (repo.isReadOnly) return

  const typeSnapshot = repo.snapshotTypeRegistries()

  // Deliberate raw property-bag writes (not tx.setProperties): this MOVES the
  // source's already-ENCODED SRS values verbatim onto the target. The typed
  // primitives take DECODED values and re-encode internally, so routing this
  // bulk transfer through them would force a decode→re-encode round-trip on
  // live SRS scheduling state for zero correctness gain — every
  // SRS_PROPERTY_NAMES entry is a registered schema, so in a flipped workspace
  // MATERIALIZE reconciles the net cell diff (keys added on the target, removed
  // from the source) into field children. The whole-bag spread is NOT a clobber:
  // it deletes only the SRS names before re-adding the moved ones, so the
  // target's unrelated properties are preserved.
  await repo.tx(async tx => {
    const source = await tx.get(sourceBlockId)
    if (!source) return
    if (!getBlockTypes(source).includes(SRS_SM25_TYPE)) return

    const target = await tx.get(targetBlockId)
    if (!target) return

    const moved: Record<string, unknown> = {}
    for (const name of SRS_PROPERTY_NAMES) {
      const encoded = source.properties[name]
      if (encoded !== undefined) moved[name] = encoded
    }

    if (!getBlockTypes(target).includes(SRS_SM25_TYPE)) {
      await repo.addTypeInTx(tx, targetBlockId, SRS_SM25_TYPE, {}, typeSnapshot)
    }

    const targetAfter = await tx.get(targetBlockId)
    if (!targetAfter) return
    const nextTarget: Record<string, unknown> = {...targetAfter.properties}
    for (const name of SRS_PROPERTY_NAMES) delete nextTarget[name]
    for (const [name, value] of Object.entries(moved)) nextTarget[name] = value
    await tx.update(targetBlockId, {properties: nextTarget})

    await repo.removeTypeInTx(tx, sourceBlockId, SRS_SM25_TYPE)
    const sourceAfter = await tx.get(sourceBlockId)
    if (!sourceAfter) return
    const nextSource: Record<string, unknown> = {...sourceAfter.properties}
    let changed = false
    for (const name of SRS_PROPERTY_NAMES) {
      if (nextSource[name] !== undefined) {
        delete nextSource[name]
        changed = true
      }
    }
    if (changed) {
      await tx.update(sourceBlockId, {properties: nextSource})
    }
  }, {scope: ChangeScope.BlockDefault, description: 'srs move state'})
}
