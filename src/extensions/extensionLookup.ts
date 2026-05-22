/**
 * Find an installed extension block by id or by one of its labels.
 *
 * Direct SQL is the right primitive here: `repo.query.findExtensionBlocks`
 * goes through the cached query layer, which doesn't reliably observe a
 * freshly installed block when the kernel invalidation processors aren't
 * active (e.g. in unit-test repos). enable / disable / uninstall happen
 * immediately after install in the bridge flow, so the lookup needs to
 * see the just-written row without waiting for cache invalidation.
 */

import type {BlockData} from '@/data/api'
import type {Repo} from '@/data/repo'
import {EXTENSION_TYPE} from '@/data/blockTypes'
import type {BlockProperties} from '@/types.js'
import {extensionAliasValues} from '@/extensions/togglable.js'

export interface ExtensionHandle {
  /** Extension block id. Either `id` or `label` is required. */
  id?: string
  /** Extension alias / extension:name (the label passed at install time). */
  label?: string
}

export interface ExtensionLookupResult {
  block: BlockData
  /** Best human-readable label (first alias that isn't the block id). */
  label: string | null
}

export const findExtensionBlock = async (
  repo: Repo,
  workspaceId: string,
  handle: ExtensionHandle,
): Promise<ExtensionLookupResult | null> => {
  const idHint = handle.id?.trim()
  const labelHint = handle.label?.trim()
  if (!idHint && !labelHint) {
    throw new Error('findExtensionBlock requires `id` or `label`')
  }

  const rows = await repo.db.getAll<{id: string, properties_json: string}>(
    `SELECT b.id, b.properties_json
       FROM blocks b
       JOIN block_types bt ON bt.block_id = b.id AND bt.workspace_id = b.workspace_id
      WHERE b.workspace_id = ? AND b.deleted = 0 AND bt.type = ?`,
    [workspaceId, EXTENSION_TYPE],
  )
  const candidates: BlockData[] = rows.map(row => {
    const properties = (() => {
      try { return JSON.parse(row.properties_json) as BlockProperties } catch { return {} }
    })()
    return {id: row.id, workspaceId, properties} as BlockData
  })
  const match = idHint
    ? candidates.find(block => block.id === idHint) ?? null
    : candidates.find(block => extensionAliasValues(block).includes(labelHint!)) ?? null
  if (!match) return null
  const label = extensionAliasValues(match).find(value => value !== match.id) ?? null
  return {block: match, label}
}
