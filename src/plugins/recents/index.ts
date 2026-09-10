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
import { navigateFromGlobalCommand } from '@/utils/navigation.js'
import type { Repo } from '@/data/repo'
import { RecentsHeaderItem } from './HeaderItem.tsx'
import { RecentsPageBlockRenderer } from './RecentsPageBlockRenderer.tsx'

export const OPEN_RECENTS_ACTION_ID = 'open_recents'

/** Same `ensure` as the header button, for the same reason: `ensureSystemPages`
 *  may have SKIPPED this page, and navigating to its derived id would then land
 *  on a row that does not exist (#931).
 *
 *  Carried on the input rather than awaited first, so the intent policy decides
 *  before anything is written — an ensure run ahead of resolution creates the
 *  page even for a command the policy vetoes. */
const openRecents = async (repo: Repo): Promise<void> => {
  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId) return
  await navigateFromGlobalCommand(repo, {
    blockId: recentsPageBlockId(workspaceId),
    workspaceId,
    ensure: () => getOrCreateRecentsPage(repo, workspaceId),
  })
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
