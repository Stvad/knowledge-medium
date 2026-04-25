import { Repo } from '@/data/repo.ts'
import { actionsFacet } from '@/extensions/core.ts'
import { AppExtension } from '@/extensions/facet.ts'
import { getDefaultActionGroups } from '@/shortcuts/defaultShortcuts.ts'
import { ActionConfig } from '@/shortcuts/types.ts'

export const vimNormalModeActionsExtension = ({repo}: { repo: Repo }): AppExtension =>
  getDefaultActionGroups({repo}).vimNormalModeActions.map(action =>
    actionsFacet.of(action as ActionConfig, {source: 'vim-normal-mode'}),
  )
