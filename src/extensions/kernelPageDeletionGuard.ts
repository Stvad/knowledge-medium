import {systemPagesFacet} from '@/data/facets'
import {kernelPageBlockId} from '@/data/kernelPage'
import type {BlockDeletionGuard} from './core'

/** UI targets only: a kernel page moved under another block still follows that ancestor's cascade. */
export const kernelPageDeletionGuard: BlockDeletionGuard = block => {
  const data = block.peek()
  if (!data) return null
  for (const {spec} of block.repo.facetRuntime?.read(systemPagesFacet) ?? []) {
    if (block.id !== kernelPageBlockId(data.workspaceId, spec.namespace)) continue
    return `${spec.alias} is a system page and can\u2019t be deleted \u2014 it\u2019s recreated automatically, and deleting it would hide everything filed under it.`
  }
  return null
}
