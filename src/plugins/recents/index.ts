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
import { navigateAsyncFromGlobalCommand } from '@/utils/navigation.js'
import type { Repo } from '@/data/repo'
import { RecentsHeaderItem } from './HeaderItem.tsx'
import { RecentsPageBlockRenderer } from './RecentsPageBlockRenderer.tsx'

export const OPEN_RECENTS_ACTION_ID = 'open_recents'

// Resolved at navigation time, not from `recentsPageBlockId`: the derived id is
// not the live page and can name a tombstone or nothing. Routed through the
// async global-command path so the intent policy decides BEFORE the page is
// materialised — see `navigateAsyncFromGlobalCommand`.
export const openRecents = async (repo: Repo): Promise<void> => {
  await navigateAsyncFromGlobalCommand(
    repo,
    async workspaceId => ({blockId: (await getOrCreateRecentsPage(repo, workspaceId)).id}),
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
