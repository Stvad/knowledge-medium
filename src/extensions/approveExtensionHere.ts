import {ChangeScope} from '@/data/api'
import type {ExtensionApprovalStatus} from './dynamicExtensions.js'
import {refreshAppRuntime} from '@/facets/runtimeEvents.js'
import {
  approveExtension,
  hashExtensionSource,
  lookupApproval,
} from '@/extensions/compileExtensionModule.js'
import type {Repo} from '@/data/repo'
import {showError} from '@/utils/toast.js'

export const approveExtensionHere = async (
  repo: Repo,
  blockId: string,
  {name, kind, liveSource, liveHash}: Pick<ExtensionApprovalStatus, 'name' | 'kind' | 'liveSource' | 'liveHash'>,
): Promise<boolean> => {
  try {
    // A read failure may hide an existing pin.
    if ((await lookupApproval(blockId)).status === 'unreadable') {
      showError(
        `Couldn't enable "${name}" — couldn't read its approval state. Try again.`,
      )
      return false
    }
    const block = await repo.load(blockId)
    if (!block || block.deleted) {
      showError(`Couldn't enable "${name}" — its definition block wasn't found.`)
      return false
    }
    const changed = () => {
      refreshAppRuntime()
      showError(`“${name}” changed. Review the new version before approving it.`)
      return false
    }
    if (block.content !== liveSource || await hashExtensionSource(liveSource) !== liveHash) return changed()
    if (kind === 'imports-unpinned') {
      const {pinExtensionImports} = await import('@knowledge-medium/agent-cli/freezeExtensionImports')
      const pinned = await pinExtensionImports(liveSource)
      const written = await repo.tx(async tx => {
        const current = await tx.get(blockId)
        if (current?.content !== liveSource || current.deleted) return false
        await tx.update(blockId, {content: pinned.source})
        return true
      }, {scope: ChangeScope.BlockDefault, description: 'Pin extension imports'})
      if (!written) return changed()
      await approveExtension(blockId, pinned.source, undefined, pinned.vendored)
    } else {
      await approveExtension(blockId, liveSource)
    }
    return true
  } catch (error) {
    console.error(`Failed to approve extension ${blockId}`, error)
    showError(
      `Couldn't enable "${name}" — ${
        error instanceof Error ? error.message : 'approval could not be saved'
      }.`,
    )
    return false
  }
}
