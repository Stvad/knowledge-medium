import {
  shortcutSurfaceActivationsFacet,
} from '@/extensions/blockInteraction.js'
import { actionsFacet, actionTransformsFacet } from '@/extensions/core.js'
import { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { Repo } from '../../data/repo'
import { colemakKeybindingsPlugin } from '@/plugins/colemak-keybindings'
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
  // `defaultEnabled: false` — vim is opt-in. A fresh workspace lands in
  // the plain click-to-edit experience (single-click a block to type);
  // toggle vim on via the "Manage extensions" command. NORMAL_MODE is
  // activated solely by this plugin, so with it off the focused-block
  // keymap (`j`/`k`, `z`, `t`, yank, …) is simply absent.
  systemToggle({
    id: 'system:vim-normal-mode',
    name: 'Vim normal mode',
    description: 'Vim-style normal-mode keybindings inside the editor.',
    defaultEnabled: false,
  }).of([
    vimNormalModeInteractionExtension,
    vimNormalModeActionsExtension({repo}),
    // Nested sub-toggle: Colemak remaps of the vim movement keys. Lives
    // here (not top-level) so it's gated by vim — with normal mode off the
    // remaps have nothing to act on, and the settings UI shows it under Vim.
    colemakKeybindingsPlugin,
  ])
