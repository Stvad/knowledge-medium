/** Opening the host's query for editing. */
import { ChangeScope } from '@/data/api'
import { openPropertyValue } from '@/data/internals/propertyValueEdits'
import type { Repo } from '@/data/repo'

/** The host's query value block, made empty if the host has none. A value it
 *  already holds is opened as it is: the projection the caller decided from
 *  can lag the value rows, and their text must survive. */
export const openQueryValue = (repo: Repo, hostId: string, fieldId: string): Promise<string> =>
  repo.tx(async tx => (await openPropertyValue(tx, hostId, fieldId)).valueId, {scope: ChangeScope.BlockDefault, description: 'add table query'})
