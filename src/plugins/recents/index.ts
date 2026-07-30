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
import { getOrCreateRecentsPage } from '@/data/recentsPage.js'
import { navigateFromGlobalCommand } from '@/utils/navigation.js'
import type { Repo } from '@/data/repo'
import { RecentsHeaderItem } from './HeaderItem.tsx'
import { RecentsPageBlockRenderer } from './RecentsPageBlockRenderer.tsx'

export const OPEN_RECENTS_ACTION_ID = 'open_recents'

// Resolves the LIVE Recents page (issue #378: the raw deterministic id can be
// a tombstone, e.g. after a live block adopted the canonical alias) rather
// than navigating straight to `recentsPageBlockId`. Get-or-create both adopts
// an existing claimant and creates the page if bootstrap never ran, so this
// can never land on a dead id.
export const openRecents = async (repo: Repo): Promise<void> => {
  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId) return
  const page = await getOrCreateRecentsPage(repo, workspaceId)
  navigateFromGlobalCommand(repo, {blockId: page.id, workspaceId})
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
