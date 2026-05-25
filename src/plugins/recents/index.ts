import { Clock } from 'lucide-react'
import {
  actionsFacet,
  blockRenderersFacet,
  headerItemsFacet,
  type HeaderItemContribution,
} from '@/extensions/core.js'
import type { AppExtension } from '@/extensions/facet.js'
import { systemToggle } from '@/extensions/togglable.js'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.js'
import { recentsPageBlockId } from '@/data/recentsPage.js'
import { navigateFromGlobalCommand } from '@/utils/navigation.js'
import type { Repo } from '@/data/repo'
import { RecentsHeaderItem } from './HeaderItem.tsx'
import { RecentsPageBlockRenderer } from './RecentsPageBlockRenderer.tsx'

export const OPEN_RECENTS_ACTION_ID = 'open_recents'

const openRecents = (repo: Repo) => {
  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId) return
  navigateFromGlobalCommand(repo, {blockId: recentsPageBlockId(workspaceId)})
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
  region: 'end',
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
    // Precedence 35 places this just before the sync-status indicator
    // (precedence 40), grouping the "workspace state" cluster together
    // and keeping the dialog-launcher buttons (quick-find ⌘P at 10,
    // command-palette ⌘K at 20) contiguous on their own.
    headerItemsFacet.of(recentsHeaderItem, {source: 'recents', precedence: 35}),
    actionsFacet.of(openRecentsAction(repo), {source: 'recents'}),
  ])
