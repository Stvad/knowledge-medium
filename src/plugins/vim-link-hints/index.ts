import { actionsFacet, appMountsFacet } from '@/extensions/core.js'
import { systemToggle } from '@/facets/togglable.js'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.js'
import { LinkHints } from './LinkHints.tsx'
import { alwaysShowLinkHintsFacet, linkHintsToggle } from './settings.ts'

const toggleLinkHintsAction: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: 'vim.block.toggle-link-hints',
  description: 'Toggle link hints',
  context: ActionContextTypes.NORMAL_MODE,
  defaultBinding: {keys: 'f'},
  handler: (_deps, trigger) => {
    if (trigger instanceof KeyboardEvent && trigger.repeat) return
    linkHintsToggle.toggle()
  },
}

export const vimLinkHintsPlugin = systemToggle({
  id: 'system:vim-link-hints',
  name: 'Link hints',
  description: 'Label links in the focused block with keys that follow them.',
}).of([
  actionsFacet.of(toggleLinkHintsAction, {source: 'vim-link-hints'}),
  appMountsFacet.of({id: 'vim-link-hints', component: LinkHints}),
  systemToggle({
    id: 'system:vim-link-hints/always-show',
    name: 'Always show link hints',
    description: 'Show link hints when a block gains focus. On touchscreens, hints appear while using a keyboard. Toggle link hints hides them until you move.',
    defaultEnabled: false,
  }).of(alwaysShowLinkHintsFacet.of(true)),
])
