import { PROPERTY_SCHEMA_TYPE } from '@/data/blockTypes'
import { propertyNameProp, typesProp } from '@/data/properties'
import {
  typedBlocksReferenceKey,
  type ChangeSnapshotSide,
  type InvalidationRule,
} from '@/data/invalidation'

export const BACKLINK_PRESENTATION_CHANNEL = 'backlinks.presentation'
export const backlinkPresentationTargetKey = typedBlocksReferenceKey

type Side = ChangeSnapshotSide | null
const isDefinition = (side: Side): boolean => {
  const types = side?.properties?.[typesProp.name]
  return Array.isArray(types) && types.includes(PROPERTY_SCHEMA_TYPE)
}

/** Membership can change without reference edges changing: an equal list
 *  member moves out, a field is unmarked, or its definition is renamed. */
export const backlinkPresentationInvalidation: InvalidationRule = {
  id: 'backlinks.presentation-invalidation',
  collectFromSnapshots: (snapshots, emit) => {
    for (const {before, after} of snapshots.values()) {
      const placementChanged = before?.parentId !== after?.parentId
        || before?.workspaceId !== after?.workspaceId
        || before?.deleted !== after?.deleted
        || before?.isFieldForm !== after?.isFieldForm
      const fieldChanged = (before?.isFieldForm || after?.isFieldForm)
        && (placementChanged || before?.referenceTargetId !== after?.referenceTargetId)
      const definitionChanged = (isDefinition(before) || isDefinition(after))
        && (isDefinition(before) !== isDefinition(after) || placementChanged
          || before?.properties?.[propertyNameProp.name] !== after?.properties?.[propertyNameProp.name])
      if (fieldChanged || definitionChanged) {
        for (const side of [before, after]) {
          if (side) emit(BACKLINK_PRESENTATION_CHANNEL, side.workspaceId)
        }
      }
      if (!placementChanged && before?.content === after?.content) continue
      for (const side of [before, after]) {
        if (!side) continue
        for (const ref of side.references ?? []) {
          if (!ref.sourceField && side.content === `((${ref.id}))`) {
            emit(BACKLINK_PRESENTATION_CHANNEL, backlinkPresentationTargetKey(side.workspaceId, ref.id))
          }
        }
      }
    }
  },
}
