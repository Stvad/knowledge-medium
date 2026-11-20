import type {Repo} from '@/data/repo'
import {resolveFacetRuntimeSync, type AppExtension} from '@/facets/facet'
import {createAgentRuntimeContext} from '../commands'
import type {AgentRuntimeContext} from '../protocol'

/**
 * Install `extensions` as `repo`'s runtime, pin `workspaceId`, and return the
 * context bridge commands run against.
 *
 * Takes a built `Repo` because that is where test files differ (user, id
 * generator, sync gate, a `withTxContext` facade). `extensions` is required so a
 * deliberately minimal runtime stays stated at its call site and this module
 * pulls in no plugins. Calling it again on the same repo swaps the runtime.
 */
export const createTestAgentContext = (
  repo: Repo,
  workspaceId: string,
  extensions: AppExtension | readonly AppExtension[],
): AgentRuntimeContext => {
  const runtime = resolveFacetRuntimeSync(extensions, {repo, workspaceId, safeMode: false})
  repo.setFacetRuntime(runtime)
  repo.setActiveWorkspaceId(workspaceId)
  return createAgentRuntimeContext({repo, runtime, safeMode: false})
}
