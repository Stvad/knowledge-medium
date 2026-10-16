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
 *  `namedWorkspaceId` is the workspace the call names, if any.
 *
 *  Accepted for every view, unless the result would misdirect a write, cross
 *  a user or workspace, or break a cost bound:
 *  - rows only sync can produce (an id spelling `[[x]]` or `field:…`, an
 *    alias two pages claim, a malformed list entry) render as they are,
 *    beyond never cutting an id;
 *  - data changing between a view's reads: within one response, counts and
 *    rows may disagree by what changed. Kept regardless: no count is below
 *    what is shown, the workspace is bound in SQL, and no offset is offered
 *    that cannot be read. One read snapshot per view would end this: #1250. */
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
