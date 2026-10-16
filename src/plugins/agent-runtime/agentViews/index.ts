import type { Repo } from '@/data/repo'
import type { KnownAgentCommand } from '@knowledge-medium/agent-cli/protocol'
import { buildBlockView, renderBlockView } from './block.ts'
import { buildOutlineView, renderOutlineView } from './outline.ts'
import {
  buildBacklinksView,
  buildGroupedBacklinksView,
  renderBacklinksView,
  renderGroupedBacklinksView,
} from './backlinks.ts'
import { buildSearchView, renderSearchView } from './search.ts'
import { viewWorkspace } from './shared.ts'

export { BlockRefError, resolveBlockRef, shortIds, type ResolveBlockRefOptions } from './resolveRef.ts'

type ViewCommand = Extract<KnownAgentCommand, {type: `view-${string}`}>

/** Answer a `view-*` command: the rendered text, or with `format: 'json'`
 *  the structured view it was rendered from (same bounds either way).
 *  `namedWorkspaceId` is the workspace the call names, if any. */
export const runViewCommand = async (
  repo: Repo,
  command: ViewCommand,
  namedWorkspaceId: string | undefined,
): Promise<unknown> => {
  const workspaceId = viewWorkspace(repo, namedWorkspaceId)
  const json = command.format === 'json'
  switch (command.type) {
    case 'view-block': {
      const view = await buildBlockView(repo, workspaceId, command)
      return json ? view : renderBlockView(view)
    }
    case 'view-outline': {
      const view = await buildOutlineView(repo, workspaceId, command)
      return json ? view : renderOutlineView(view)
    }
    case 'view-backlinks': {
      const view = await buildBacklinksView(repo, workspaceId, command)
      return json ? view : renderBacklinksView(view)
    }
    case 'view-grouped-backlinks': {
      const view = await buildGroupedBacklinksView(repo, workspaceId, command)
      return json ? view : renderGroupedBacklinksView(view)
    }
    case 'view-search': {
      const view = await buildSearchView(repo, workspaceId, command)
      return json ? view : renderSearchView(view)
    }
  }
}
