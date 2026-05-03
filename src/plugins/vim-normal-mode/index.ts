import {
  blockClickHandlersFacet,
  blockContentSurfacePropsFacet,
  shortcutSurfaceActivationsFacet,
} from '@/extensions/blockInteraction.ts'
import { AppExtension } from '@/extensions/facet.ts'
import { Repo } from '../../data/repo'
import { vimNormalModeActionsExtension } from './actions.ts'
import {
  vimBlockClickBehavior,
  vimContentSurfaceBehavior,
  vimNormalModeActivation,
} from './interactions.ts'

export const vimNormalModeInteractionExtension: AppExtension = [
  blockClickHandlersFacet.of(vimBlockClickBehavior, {
    precedence: 100,
    source: 'vim-normal-mode',
  }),
  blockContentSurfacePropsFacet.of(vimContentSurfaceBehavior, {
    precedence: 100,
    source: 'vim-normal-mode',
  }),
  shortcutSurfaceActivationsFacet.of(vimNormalModeActivation, {
    precedence: 100,
    source: 'vim-normal-mode',
  }),
]

export const vimNormalModePlugin = ({repo}: { repo: Repo }): AppExtension => [
  vimNormalModeInteractionExtension,
  vimNormalModeActionsExtension({repo}),
]
