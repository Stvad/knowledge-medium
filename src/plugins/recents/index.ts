import { Clock } from 'lucide-react'
import {
  actionsFacet,
  blockRenderersFacet,
  headerItemsFacet,
  type HeaderItemContribution,
} from '@/extensions/core.js'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.js'
import { getOrCreateRecentsPage, recentsPageBlockId } from '@/data/recentsPage.js'
import { activeWorkspaceIdPreferringHash, navigateFromGlobalCommand } from '@/utils/navigation.js'
import type { Repo } from '@/data/repo'
import { RecentsHeaderItem } from './HeaderItem.tsx'
import { RecentsPageBlockRenderer } from './RecentsPageBlockRenderer.tsx'

export const OPEN_RECENTS_ACTION_ID = 'open_recents'

// `recentsPageBlockId` derives an id; it does not promise a row. Materialise the
// page as part of the navigation so a workspace whose bootstrap never ran —
// or where the page was since deleted — lands on Recents rather than nothing.
// `skipUndo` because the user asked to navigate, not to create: a lone entry on
// the stack makes their next cmd-Z delete this page, and discards their redo.
const openRecents = async (repo: Repo): Promise<void> => {
  const workspaceId = activeWorkspaceIdPreferringHash(repo)
  if (!workspaceId) return
  await navigateFromGlobalCommand(
    repo,
    {blockId: recentsPageBlockId(workspaceId), workspaceId},
    {ensureTarget: ws => getOrCreateRecentsPage(repo, ws, {skipUndo: true})},
  )
}

export const openRecentsAction = (repo: Repo): ActionConfig<typeof ActionContextTypes.GLOBAL> => ({
  id: OPEN_RECENTS_ACTION_ID,
  description: 'Open Recents — recently edited blocks',
  context: ActionContextTypes.GLOBAL,
  icon: Clock,
  handler: () => openRecents(repo),
})

export const recentsHeaderItem: HeaderItemContribution = {
  id: 'recents.header',
  region: 'start',
  component: RecentsHeaderItem,
}

export const recentsPlugin = ({repo}: {repo: Repo}): AppExtension =>
  systemToggle({
    id: 'system:recents',
    name: 'Recents',
    description: 'Tana-style view of recently-edited blocks in the workspace.',
  }).of([
    blockRenderersFacet.of(
      {id: 'recentsPage', renderer: RecentsPageBlockRenderer},
      {source: 'recents'},
    ),
    // Precedence 35 places this after the dialog-launcher buttons
    // (quick-find at 10, command-palette at 20), keeping action /
    // navigation items together in the header's start region.
    headerItemsFacet.of(recentsHeaderItem, {source: 'recents', precedence: 35}),
    actionsFacet.of(openRecentsAction(repo), {source: 'recents'}),
  ])
