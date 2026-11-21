import type {Repo} from '@/data/repo.js'
import {resolveAliasSeatNamespaces} from '@/data/aliasSeatNamespace.js'
import {resolvePropertyChildNamespace} from '@/data/internals/propertyChildMint.js'

/** Run after access and sync gates, with the active workspace and role set.
 * Hosts can await the returned namespace reads. The tab leaves them pending
 * because an IndexedDB key read can hang. */
export const openWorkspaceData = async (
  repo: Repo,
  workspaceId: string,
  freshlyCreated = false,
  onNamespacesStarted?: (workspaceId: string) => void,
): Promise<readonly Promise<unknown>[]> => {
  // A stored definition can shadow a seed. Wait for the complete projector
  // snapshot before starting any bootstrap work that could synthesize one.
  await repo.whenPropertyDefinitionsReady(workspaceId)

  // In-transaction writers cannot fetch K_id. Start both reads pre-lock and
  // retain their rejection for callers that require the namespace to be ready.
  const aliasSeats = resolveAliasSeatNamespaces(repo, workspaceId)
  void aliasSeats.catch(err => {
    console.warn(`[bootstrap] alias-seat namespace for ${workspaceId} is unresolved`, err)
  })
  const propertyChild = resolvePropertyChildNamespace(repo, workspaceId)
  void propertyChild.catch(err => {
    console.warn(`[bootstrap] property-child namespace for ${workspaceId} is unresolved`, err)
  })

  onNamespacesStarted?.(workspaceId)
  repo.scheduleWorkspaceBackfills(workspaceId)
  // A workspace may share a ref-typed name with the previous one, leaving no
  // facet diff to trigger a scan of its own rows.
  repo.scheduleWorkspaceRefBackfill(workspaceId)
  repo.scheduleReferenceTargetDerivePass(workspaceId)
  repo.scheduleReconcileRescan(workspaceId)

  // The seed definitions need their parent pages. The tab's landing resolver
  // also needs their reserved aliases to exist before seeding any wiki-links.
  await repo.ensureSystemPages(workspaceId)
  repo.scheduleWorkspaceSeedMaterialization(workspaceId, freshlyCreated)
  return [aliasSeats, propertyChild]
}
