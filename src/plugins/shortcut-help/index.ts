import {
  actionsFacet,
  appMountsFacet,
  type AppMountContribution,
} from '@/extensions/core.js'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.js'
import { hasEditableTarget } from '@/shortcuts/utils.js'
import { Keyboard } from 'lucide-react'
import { ShortcutHelpOverlay } from './ShortcutHelpOverlay.tsx'
import { shortcutHelpToggle } from './toggleStore.ts'

export { ShortcutHelpOverlay } from './ShortcutHelpOverlay.tsx'

export const SHORTCUT_HELP_ACTION_ID = 'shortcut_help'

export const shortcutHelpMount: AppMountContribution = {
  id: 'shortcut-help.overlay',
  component: ShortcutHelpOverlay,
}

/** `?` opens the overlay. Both spellings are bound because tinykeys
 *  modifier-matching is exact-set: `Shift+?` is what a US-style layout
 *  produces (Shift+/ reports key '?'), while layouts with an unshifted
 *  `?` deliver it bare.
 *
 *  The handler DECLINES (sync `false`) when the chord arrives from an
 *  editable target. The coordinator's default typing filter alone does
 *  not cover this: an active context's `eventFilter` (EDIT_MODE_CM opts
 *  in every keydown inside `.cm-editor`) green-lights the WHOLE dispatch,
 *  so without the decline, typing `?` in a note would open the overlay
 *  and eat the character. Declining falls through to no candidate, the
 *  event keeps its default, and the `?` is typed. From edit mode the
 *  overlay is reached via the command palette. */
export const shortcutHelpAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: SHORTCUT_HELP_ACTION_ID,
  description: 'Show keyboard shortcuts',
  context: ActionContextTypes.GLOBAL,
  icon: Keyboard,
  handler: (_deps, trigger) => {
    if (trigger instanceof KeyboardEvent && hasEditableTarget(trigger)) return false
    shortcutHelpToggle.toggle()
  },
  defaultBinding: {
    keys: ['Shift+?', '?'],
  },
}

export const shortcutHelpPlugin: AppExtension = systemToggle({
  id: 'system:shortcut-help',
  name: 'Shortcut help',
  description: "'?' overlay listing the currently-active keyboard shortcuts by context; press any chord while it's open to inspect what it would run.",
}).of([
  appMountsFacet.of(shortcutHelpMount, {source: 'shortcut-help'}),
  actionsFacet.of(shortcutHelpAction, {source: 'shortcut-help'}),
])
