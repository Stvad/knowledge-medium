import {ChangeScope, seedProperty, seedType} from '@/data/api'

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
