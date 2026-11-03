import type {TxDb} from './txEngine'
import type {ReferenceTargetLookups} from './referenceTargetProcessor'
import {selectAliasTargetIdsSql} from './kernelQueries'
import {MAX_IDS_PER_IN_CLAUSE} from './sqlBinds'

/** Bind resolution to the reader holding the current alias-index snapshot. */
export const referenceTargetLookupsVia = (reader: Pick<TxDb, 'getAll'>): ReferenceTargetLookups => {
  const aliasTargetIds = async (aliases: readonly string[], workspaceId: string) => {
    const result = new Map<string, string | null>()
    if (!workspaceId) return result
    const unique = [...new Set(aliases)].filter(alias => alias !== '')
    // One additional bind selects the workspace.
    const chunkSize = MAX_IDS_PER_IN_CLAUSE - 1
    for (let i = 0; i < unique.length; i += chunkSize) {
      const chunk = unique.slice(i, i + chunkSize)
      const rows = await reader.getAll<{alias: string; id: string | null}>(
        selectAliasTargetIdsSql(chunk.length), [...chunk, workspaceId],
      )
      for (const row of rows) result.set(row.alias, row.id)
    }
    return result
  }
  return {
    aliasTargetIds,
    aliasTargetId: async (alias, workspaceId) => (await aliasTargetIds([alias], workspaceId)).get(alias) ?? null,
  }
}
