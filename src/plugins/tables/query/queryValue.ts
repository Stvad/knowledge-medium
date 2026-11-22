/** Opening the host's query for editing. */
import { ChangeScope } from '@/data/api'
import { openPropertyValue } from '@/data/internals/propertyValueEdits'
import type { Repo } from '@/data/repo'
import { fencedQuery } from './source'

/** The host's query value block, made with an empty fence if the host has
 *  none. A value it already holds is opened as it is: the projection the
 *  caller decided from can lag the value rows, and their text must survive. */
export const openQueryValue = (repo: Repo, hostId: string, fieldId: string): Promise<string> =>
  repo.tx(async tx => {
    const opened = await openPropertyValue(tx, hostId, fieldId)
    if (opened.created) await tx.update(opened.valueId, {content: fencedQuery('')})
    return opened.valueId
  }, {scope: ChangeScope.BlockDefault, description: 'add table query'})
