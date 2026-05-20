/** Properties-page bootstrap. Each workspace has one Properties page;
 *  user-defined property-schema blocks live as its children. Created on
 *  first launch with a deterministic id (uuid v5 derived from
 *  workspaceId) so two clients booting offline converge on the same row
 *  on the next sync (mirrors getOrCreateJournalBlock). */

import { v5 as uuidv5 } from 'uuid'
import { ChangeScope } from '@/data/api'
import { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { aliasesProp, hasBlockType } from '@/data/properties'
import { PAGE_TYPE, PROPERTIES_PAGE_TYPE } from '@/data/blockTypes'

const PROPERTIES_PAGE_NS = '94f9a6d9-c651-4b75-aef3-a5c1bbef0e1a'

const PROPERTIES_ALIAS = 'Properties'
const PROPERTIES_ALIASES: readonly string[] = [PROPERTIES_ALIAS]

const stringListProperty = (raw: unknown): readonly string[] =>
  Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []

export const propertiesPageBlockId = (workspaceId: string): string =>
  uuidv5(workspaceId, PROPERTIES_PAGE_NS)

const includesAll = (existing: readonly string[], expected: readonly string[]): boolean =>
  expected.every(value => existing.includes(value))

const mergeStrings = (values: readonly string[]): string[] => Array.from(new Set(values))

/** Get-or-create the workspace's Properties page. Idempotent across
 *  offline launches; soft-deleted rows are restored. */
export const getOrCreatePropertiesPage = async (
  repo: Repo,
  workspaceId: string,
): Promise<Block> => {
  const id = propertiesPageBlockId(workspaceId)
  const live = await repo.load(id)
  if (live && !live.deleted) {
    const aliases = stringListProperty(live.properties[aliasesProp.name])
    const needsRepair =
      !hasBlockType(live, PAGE_TYPE) ||
      !hasBlockType(live, PROPERTIES_PAGE_TYPE) ||
      !includesAll(aliases, PROPERTIES_ALIASES)
    if (!needsRepair) return repo.block(id)

    const typeSnapshot = repo.snapshotTypeRegistries()
    await repo.tx(async tx => {
      const current = await tx.get(id)
      if (!current || current.deleted) return
      const currentAliases = stringListProperty(current.properties[aliasesProp.name])
      if (!includesAll(currentAliases, PROPERTIES_ALIASES)) {
        await tx.setProperty(id, aliasesProp, mergeStrings([...PROPERTIES_ALIASES, ...currentAliases]))
      }
      await repo.addTypeInTx(tx, id, PAGE_TYPE, {[aliasesProp.name]: PROPERTIES_ALIASES}, typeSnapshot)
      await repo.addTypeInTx(tx, id, PROPERTIES_PAGE_TYPE, {[aliasesProp.name]: PROPERTIES_ALIASES}, typeSnapshot)
    }, {scope: ChangeScope.BlockDefault})
    return repo.block(id)
  }

  const typeSnapshot = repo.snapshotTypeRegistries()
  await repo.tx(async tx => {
    const existing = await tx.get(id)
    if (existing && !existing.deleted) return
    if (existing && existing.deleted) {
      await tx.restore(id, {content: PROPERTIES_ALIAS})
      await tx.setProperty(id, aliasesProp, [...PROPERTIES_ALIASES])
      await repo.addTypeInTx(tx, id, PAGE_TYPE, {[aliasesProp.name]: PROPERTIES_ALIASES}, typeSnapshot)
      await repo.addTypeInTx(tx, id, PROPERTIES_PAGE_TYPE, {[aliasesProp.name]: PROPERTIES_ALIASES}, typeSnapshot)
      return
    }
    await tx.create({
      id,
      workspaceId,
      parentId: null,
      orderKey: 'a0',
      content: PROPERTIES_ALIAS,
    })
    await repo.addTypeInTx(tx, id, PAGE_TYPE, {[aliasesProp.name]: PROPERTIES_ALIASES}, typeSnapshot)
    await repo.addTypeInTx(tx, id, PROPERTIES_PAGE_TYPE, {[aliasesProp.name]: PROPERTIES_ALIASES}, typeSnapshot)
  }, {scope: ChangeScope.BlockDefault})

  return repo.block(id)
}
