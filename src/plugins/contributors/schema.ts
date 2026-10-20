import {ChangeScope, seedProperty, seedType, type BlockData} from '@/data/api'
import {USER_TYPE} from '@/data/blockTypes'
import {hasBlockType} from '@/data/properties'

export const CONTRIBUTOR_TYPE = 'contributor:profile'

export type ContributorKind = 'human' | 'agent' | 'automation'

export const contributorKindProp = seedProperty<ContributorKind>({
  seedKey: 'system:contributors/property/contributor-kind',
  revision: 1,
  name: 'contributor:kind',
  preset: 'strict-enum',
  config: {options: [
    {value: 'human', label: 'human'},
    {value: 'agent', label: 'agent'},
    {value: 'automation', label: 'automation'},
  ]},
  defaultValue: 'agent',
  changeScope: ChangeScope.BlockDefault,
})

// User identity takes precedence over an editable contributor kind.
export const contributorKindOf = (row: Pick<BlockData, 'properties'> | null | undefined): ContributorKind => {
  if (row && hasBlockType(row, USER_TYPE)) return 'human'
  return contributorKindProp.codec.decode(row?.properties[contributorKindProp.name] ?? 'agent')
}

export const contributorRoleProp = seedProperty({
  seedKey: 'system:contributors/property/contributor-role',
  revision: 1,
  name: 'contributor:role',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const contributorForProp = seedProperty({
  seedKey: 'system:contributors/property/contributor-for',
  revision: 1,
  name: 'contributor:for',
  preset: 'optional-ref',
  config: {targetTypes: [CONTRIBUTOR_TYPE]},
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

// Lists allow hand-recorded coauthorship; automatic creation adds one contributor.
export const attributionCreatorsProp = seedProperty({
  seedKey: 'system:contributors/property/attribution-creators',
  revision: 1,
  name: 'attribution:creators',
  preset: 'refList',
  config: {targetTypes: [CONTRIBUTOR_TYPE]},
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
})

export const attributionEditorsProp = seedProperty({
  seedKey: 'system:contributors/property/attribution-editors',
  revision: 1,
  name: 'attribution:editors',
  preset: 'refList',
  config: {targetTypes: [CONTRIBUTOR_TYPE]},
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
})

// Contributor profiles are ordinary pages. The profile creation helper adds
// PAGE_TYPE alongside CONTRIBUTOR_TYPE, so each profile remains navigable.
export const contributorProfileType = seedType({
  seedKey: 'system:contributors/type/profile',
  revision: 1,
  id: CONTRIBUTOR_TYPE,
  label: 'Contributor profile',
  properties: [contributorKindProp, contributorRoleProp, contributorForProp],
})
