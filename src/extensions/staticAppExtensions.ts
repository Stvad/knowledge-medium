import type { Repo } from '@/data/repo'
import { kernelDataExtension } from '@/data/kernelDataExtension.ts'
import { defaultRenderersExtension } from '@/extensions/defaultRenderers.tsx'
import { toastAppMountExtension } from '@/extensions/toastAppMount.tsx'
import { defaultEditorInteractionExtension } from '@/extensions/defaultEditorInteractions.ts'
import {
  defaultActionContextsExtension,
  defaultActionsExtension,
} from '@/shortcuts/defaultShortcuts.ts'
import { kernelPropertyUiExtension } from '@/components/propertyEditors/typesPropertyUi.ts'
import { kernelValuePresetsExtension } from '@/components/propertyEditors/kernelValuePresets.ts'
import { accountHeaderPlugin } from '@/plugins/account-header'
import { commandPalettePlugin } from '@/plugins/command-palette'
import { dailyNotesPlugin } from '@/plugins/daily-notes'
import { findReplacePlugin } from '@/plugins/find-replace'
import { quickFindPlugin } from '@/plugins/quick-find'
import { themeTogglePlugin } from '@/plugins/theme-toggle'
import { workspaceHeaderPlugin } from '@/plugins/workspace-header'
import { plainOutlinerPlugin } from '@/plugins/plain-outliner'
import { breadcrumbsPlugin } from '@/plugins/breadcrumbs'
import { leftSidebarPlugin } from '@/plugins/left-sidebar'
import { mobileBottomNavPlugin } from '@/plugins/mobile-bottom-nav'
import { mobileKeyboardToolbarPlugin } from '@/plugins/mobile-keyboard-toolbar'
import { swipeQuickActionsPlugin } from '@/plugins/swipe-quick-actions'
import { visualNavigationPlugin } from '@/plugins/visual-navigation'
import { vimNormalModePlugin } from '@/plugins/vim-normal-mode'
import { videoPlayerPlugin } from '@/plugins/video-player'
import { aliasPlugin } from '@/plugins/alias'
import { mergeBlocksPlugin } from '@/plugins/merge-blocks'
import { referencesPlugin } from '@/plugins/references'
import { backlinksPlugin } from '@/plugins/backlinks'
import { groupedBacklinksPlugin } from '@/plugins/grouped-backlinks'
import { backlinksViewPlugin } from '@/plugins/backlinks-view'
import { updateIndicatorPlugin } from '@/plugins/update-indicator'
import { agentRuntimePlugin } from '@/plugins/agent-runtime'
import { appIntentsPlugin } from '@/plugins/app-intents'
import { roamImportPlugin } from '@/plugins/roam-import'
import { blockTaggingPlugin } from '@/plugins/block-tagging'
import { srsReschedulingPlugin } from '@/plugins/srs-rescheduling'
import { todoPlugin } from '@/plugins/todo'
import { syncStatusPlugin } from '@/plugins/sync-status'
import { extensionsSettingsPlugin } from '@/plugins/extensions-settings'
import { extractTypePlugin } from '@/plugins/extract-type'
import type { AppExtension } from '@/extensions/facet.ts'
import {
  getSystemExtensionMetadata,
  systemToggle,
} from '@/extensions/togglable.ts'

/** Local helper to keep the catalog readable. `essential` defaults
 *  to false — only items whose absence would break the data layer or
 *  fundamental rendering (kernel data, default renderers, action
 *  context validation, toast + dialog hosts, default editor
 *  interactions, recovery UI like the workspace header + command
 *  palette, the extensions-settings meta-plugin itself, app-intents
 *  bootstrap) set it true. Most user-facing surfaces and default
 *  keyboard shortcuts are toggleable: the user pays the consequence
 *  (no hotkeys) but the rest of the runtime stays intact. */
const sys = (
  id: string,
  ext: AppExtension,
  opts: {essential?: boolean} = {},
): AppExtension => {
  const metadata = getSystemExtensionMetadata(ext)
  if (!metadata) {
    throw new Error(`System extension ${id} is missing internal metadata`)
  }
  return systemToggle({id: `system:${id}`, ...metadata, ...opts}).of(ext)
}

export const staticAppExtensions = ({repo}: {repo: Repo}): AppExtension[] => [
  // kernelDataExtension contributes KERNEL_MUTATORS and core data
  // registries. repo.setFacetRuntime REPLACES those registries, so the
  // kernel contribution must be present in every static runtime.
  // Extensions meta-plugin owns the overrides map + cache sync.
  // Essential: if disabled, the cache would never refresh and toggle
  // changes wouldn't take effect.
  sys('extensions-settings', extensionsSettingsPlugin, {
    essential: true,
  }),
  sys('kernel-data', kernelDataExtension, {
    essential: true,
  }),
  sys('kernel-property-ui', kernelPropertyUiExtension),
  sys('kernel-value-presets', kernelValuePresetsExtension, {
    essential: true,
  }),
  sys('default-renderers', defaultRenderersExtension, {
    essential: true,
  }),
  sys('toast-mount', toastAppMountExtension, {
    essential: true,
  }),
  // The dialog mount (DialogHost reading the openDialog queue) is no
  // longer a top-level toggle — it's pulled in by every dialog-using
  // plugin (block-tagging, daily-notes) inside its own AppExtension
  // array. Dedup by FacetContribution reference means a single
  // appMountsFacet contribution is registered no matter how many
  // plugins reference it; if every dialog-using plugin is disabled
  // the mount drops out automatically. This avoids a "shared infra"
  // toggle the user has no real reason to flip independently.
  sys('breadcrumbs', breadcrumbsPlugin),
  sys('default-editor-interactions', defaultEditorInteractionExtension, {
    essential: true,
  }),
  sys('action-contexts', defaultActionContextsExtension, {
    essential: true,
  }),
  sys('default-actions', defaultActionsExtension({repo})),
  // dailyNotesPlugin contributes both the workspace-landing resolver
  // (used by App.tsx pre-mount) and the open_today / prev / next
  // shortcut actions. Order vs other landing-contributing plugins:
  // higher-precedence resolvers should be appended LATER so the
  // facet's "last wins" arrangement does the right thing without an
  // explicit precedence number.
  sys('daily-notes', dailyNotesPlugin({repo})),
  sys('left-sidebar', leftSidebarPlugin),
  sys('workspace-header', workspaceHeaderPlugin, {
    essential: true,
  }),
  sys('command-palette', commandPalettePlugin, {
    essential: true,
  }),
  sys('quick-find', quickFindPlugin),
  sys('find-replace', findReplacePlugin),
  sys('theme-toggle', themeTogglePlugin),
  sys('account-header', accountHeaderPlugin),
  sys('plain-outliner', plainOutlinerPlugin),
  sys('mobile-bottom-nav', mobileBottomNavPlugin),
  sys('mobile-keyboard-toolbar', mobileKeyboardToolbarPlugin),
  sys('swipe-quick-actions', swipeQuickActionsPlugin),
  sys('visual-navigation', visualNavigationPlugin),
  sys('vim-normal-mode', vimNormalModePlugin({repo})),
  sys('video-player', videoPlayerPlugin),
  sys('references', referencesPlugin),
  sys('alias', aliasPlugin),
  sys('merge-blocks', mergeBlocksPlugin),
  // The backlinks-view coordinator reads variants registered by
  // `backlinksPlugin` and `groupedBacklinksPlugin`. Order matters only
  // for the picker UI (variants render in registration order); the
  // selection itself is driven by `backlinksViewProp`.
  sys('backlinks', backlinksPlugin),
  sys('grouped-backlinks', groupedBacklinksPlugin),
  sys('backlinks-view', backlinksViewPlugin),
  sys('todo', todoPlugin),
  sys('block-tagging', blockTaggingPlugin),
  sys('extract-type', extractTypePlugin),
  sys('srs-rescheduling', srsReschedulingPlugin),
  sys('sync-status', syncStatusPlugin),
  sys('update-indicator', updateIndicatorPlugin),
  sys('agent-runtime', agentRuntimePlugin),
  sys('roam-import', roamImportPlugin({repo})),
  // appIntentsPlugin's bootstrap effect resolves the layout-session
  // block via getUIStateBlock + getLayoutSessionBlock and then
  // dispatches any PWA-shortcut / share-target / note-taker intent
  // captured in the URL. Registered last so it runs after every
  // other plugin's data-layer setup is in place — the dispatch may
  // call appendTodayDailyBlockInStack, which depends on the
  // daily-notes data extension being live.
  sys('app-intents', appIntentsPlugin, {
    essential: true,
  }),
]
