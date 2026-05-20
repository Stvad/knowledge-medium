import type { Repo } from '@/data/repo'
import { kernelDataExtension } from '@/data/kernelDataExtension.ts'
import { defaultRenderersExtension } from '@/extensions/defaultRenderers.tsx'
import { toastAppMountExtension } from '@/extensions/toastAppMount.tsx'
import { dialogAppMountExtension } from '@/extensions/dialogAppMount.tsx'
import { defaultEditorInteractionExtension } from '@/extensions/defaultEditorInteractions.ts'
import { defaultActionsExtension } from '@/shortcuts/defaultShortcuts.ts'
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
import type { AppExtension } from '@/extensions/facet.ts'
import { systemToggle } from '@/extensions/togglable.ts'

/** Local helper to keep the catalog readable. `essential` defaults
 *  to false — only kernel-level items and the recovery affordance
 *  (command palette) set it true. */
const sys = (
  id: string,
  name: string,
  ext: AppExtension,
  opts: {essential?: boolean; description?: string} = {},
): AppExtension => systemToggle({id: `system:${id}`, name, ...opts}).of(ext)

export const staticAppExtensions = ({repo}: {repo: Repo}): AppExtension[] => [
  // kernelDataExtension contributes KERNEL_MUTATORS and core data
  // registries. repo.setFacetRuntime REPLACES those registries, so the
  // kernel contribution must be present in every static runtime.
  sys('kernel-data', 'Kernel data', kernelDataExtension, {essential: true}),
  sys('kernel-property-ui', 'Property editors', kernelPropertyUiExtension, {essential: true}),
  sys('kernel-value-presets', 'Property value presets', kernelValuePresetsExtension, {essential: true}),
  sys('default-renderers', 'Default renderers', defaultRenderersExtension, {essential: true}),
  sys('toast-mount', 'Toasts', toastAppMountExtension, {essential: true}),
  sys('dialog-mount', 'Dialogs', dialogAppMountExtension, {essential: true}),
  sys('breadcrumbs', 'Breadcrumbs', breadcrumbsPlugin),
  sys('default-editor-interactions', 'Default editor interactions', defaultEditorInteractionExtension, {essential: true}),
  sys('default-actions', 'Default keyboard shortcuts', defaultActionsExtension({repo}), {essential: true}),
  // dailyNotesPlugin contributes both the workspace-landing resolver
  // (used by App.tsx pre-mount) and the open_today / prev / next
  // shortcut actions. Order vs other landing-contributing plugins:
  // higher-precedence resolvers should be appended LATER so the
  // facet's "last wins" arrangement does the right thing without an
  // explicit precedence number.
  sys('daily-notes', 'Daily notes', dailyNotesPlugin({repo})),
  sys('left-sidebar', 'Left sidebar', leftSidebarPlugin),
  sys('workspace-header', 'Workspace header', workspaceHeaderPlugin),
  // Command palette is the recovery affordance — disabling everything
  // else still leaves a way to run actions, so it stays essential.
  sys('command-palette', 'Command palette', commandPalettePlugin, {essential: true}),
  sys('quick-find', 'Quick find', quickFindPlugin),
  sys('find-replace', 'Find and replace', findReplacePlugin),
  sys('theme-toggle', 'Theme toggle', themeTogglePlugin),
  sys('account-header', 'Account header', accountHeaderPlugin),
  sys('plain-outliner', 'Plain outliner', plainOutlinerPlugin),
  sys('mobile-bottom-nav', 'Mobile bottom nav', mobileBottomNavPlugin),
  sys('mobile-keyboard-toolbar', 'Mobile keyboard toolbar', mobileKeyboardToolbarPlugin),
  sys('swipe-quick-actions', 'Swipe quick actions', swipeQuickActionsPlugin),
  sys('visual-navigation', 'Visual navigation', visualNavigationPlugin),
  sys('vim-normal-mode', 'Vim normal mode', vimNormalModePlugin({repo})),
  sys('video-player', 'Video player', videoPlayerPlugin),
  sys('references', 'References', referencesPlugin),
  sys('alias', 'Aliases', aliasPlugin),
  sys('merge-blocks', 'Merge blocks', mergeBlocksPlugin),
  // The backlinks-view coordinator reads variants registered by
  // `backlinksPlugin` and `groupedBacklinksPlugin`. Order matters only
  // for the picker UI (variants render in registration order); the
  // selection itself is driven by `backlinksViewProp`.
  sys('backlinks', 'Backlinks', backlinksPlugin),
  sys('grouped-backlinks', 'Grouped backlinks', groupedBacklinksPlugin),
  sys('backlinks-view', 'Backlinks view', backlinksViewPlugin),
  sys('todo', 'Todo', todoPlugin),
  sys('block-tagging', 'Block tagging', blockTaggingPlugin),
  sys('srs-rescheduling', 'SRS rescheduling', srsReschedulingPlugin),
  sys('sync-status', 'Sync status', syncStatusPlugin),
  sys('update-indicator', 'Update indicator', updateIndicatorPlugin),
  sys('agent-runtime', 'Agent runtime', agentRuntimePlugin),
  sys('roam-import', 'Roam import', roamImportPlugin({repo})),
  // appIntentsPlugin's bootstrap effect resolves the layout-session
  // block via getUIStateBlock + getLayoutSessionBlock and then
  // dispatches any PWA-shortcut / share-target / note-taker intent
  // captured in the URL. Registered last so it runs after every
  // other plugin's data-layer setup is in place — the dispatch may
  // call appendTodayDailyBlockInStack, which depends on the
  // daily-notes data extension being live.
  sys('app-intents', 'App intents', appIntentsPlugin, {essential: true}),
]
