import {
  shortcutSurfaceActivationsFacet,
} from '@/extensions/blockInteraction.js'
import { actionsFacet, actionTransformsFacet } from '@/extensions/core.js'
import { AppExtension } from '@/extensions/facet.js'
import { systemToggle } from '@/extensions/togglable.js'
import { Repo } from '../../data/repo'
import { vimNormalModeActionsExtension } from './actions.ts'
import {
  enterBlockEditModeOnGestureAction,
  vimClickToFocusTransform,
  vimNormalModeActivation,
} from './interactions.ts'

export const vimNormalModeInteractionExtension: AppExtension = [
  actionTransformsFacet.of(vimClickToFocusTransform, {
    source: 'vim-normal-mode',
  }),
  actionsFacet.of(enterBlockEditModeOnGestureAction, {
    source: 'vim-normal-mode',
  }),
  shortcutSurfaceActivationsFacet.of(vimNormalModeActivation, {
    precedence: 100,
    source: 'vim-normal-mode',
  }),
]

export const vimNormalModePlugin = ({repo}: { repo: Repo }): AppExtension =>
  systemToggle({
    id: 'system:vim-normal-mode',
    name: 'Vim normal mode',
    description: 'Vim-style normal-mode keybindings inside the editor.',
  }).of([
    vimNormalModeInteractionExtension,
    vimNormalModeActionsExtension({repo}),
  ])
