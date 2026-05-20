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
import type { AppExtension } from '@/extensions/facet.ts'
import { systemToggle } from '@/extensions/togglable.ts'

/** Local helper to keep the catalog readable. `essential` defaults
 *  to false — only items whose absence would break the data layer or
 *  fundamental rendering (kernel data, default renderers, action
 *  context validation, toast + dialog hosts, default editor
 *  interactions, the extensions-settings meta-plugin itself,
 *  app-intents bootstrap) set it true. User-facing surfaces like the
 *  command palette or default keyboard shortcuts are toggleable: the
 *  user pays the consequence (no hotkeys) but the rest of the runtime
 *  stays intact. */
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
  // Extensions meta-plugin owns the overrides map + cache sync.
  // Essential: if disabled, the cache would never refresh and toggle
  // changes wouldn't take effect.
  sys('extensions-settings', 'Extensions (toggle storage)', extensionsSettingsPlugin, {
    essential: true,
    description: 'Stores the overrides map and syncs each change into the localStorage cache so toggles take effect across reloads.',
  }),
  sys('kernel-data', 'Kernel data', kernelDataExtension, {
    essential: true,
    description: 'Mutators, queries, post-commit processors, and invalidation rules the data layer requires.',
  }),
  sys('kernel-property-ui', 'Property editors', kernelPropertyUiExtension, {
    description: 'Editors for kernel property schemas (types, etc) and the hidden-property list for the property panel.',
  }),
  sys('kernel-value-presets', 'Property value presets', kernelValuePresetsExtension, {
    essential: true,
    description: "Default editor + glyph for each codec type, used by any property that doesn't ship a per-name override.",
  }),
  sys('default-renderers', 'Default renderers', defaultRenderersExtension, {
    essential: true,
    description: 'Block renderer registry and the fallback renderer used when no plugin claims a block.',
  }),
  sys('toast-mount', 'Toasts', toastAppMountExtension, {
    essential: true,
    description: 'Mount point for transient notifications. Disabling silently drops every toast.',
  }),
  // The dialog mount (DialogHost reading the openDialog queue) is no
  // longer a top-level toggle — it's pulled in by every dialog-using
  // plugin (block-tagging, daily-notes) inside its own AppExtension
  // array. Dedup by FacetContribution reference means a single
  // appMountsFacet contribution is registered no matter how many
  // plugins reference it; if every dialog-using plugin is disabled
  // the mount drops out automatically. This avoids a "shared infra"
  // toggle the user has no real reason to flip independently.
  sys('breadcrumbs', 'Breadcrumbs', breadcrumbsPlugin, {
    description: 'Ancestor chain rendered above each panel.',
  }),
  sys('default-editor-interactions', 'Default editor interactions', defaultEditorInteractionExtension, {
    essential: true,
    description: 'Baseline block-interaction handlers (click-to-edit, selection, focus transitions).',
  }),
  sys('action-contexts', 'Action contexts', defaultActionContextsExtension, {
    essential: true,
    description: 'Registers the built-in shortcut contexts (global, normal mode, edit mode, property editing, multi-select) so activation validation remains available.',
  }),
  sys('default-actions', 'Default keyboard shortcuts', defaultActionsExtension({repo}), {
    description: 'Built-in shortcuts (Enter/Tab/Cmd+K-style). Disabling removes the default bindings; user-defined ones still work.',
  }),
  // dailyNotesPlugin contributes both the workspace-landing resolver
  // (used by App.tsx pre-mount) and the open_today / prev / next
  // shortcut actions. Order vs other landing-contributing plugins:
  // higher-precedence resolvers should be appended LATER so the
  // facet's "last wins" arrangement does the right thing without an
  // explicit precedence number.
  sys('daily-notes', 'Daily notes', dailyNotesPlugin({repo}), {
    description: 'Date-keyed pages, the workspace-landing resolver that opens today on app open, and the prev/next/today shortcuts.',
  }),
  sys('left-sidebar', 'Left sidebar', leftSidebarPlugin, {
    description: 'Collapsible sidebar with section contributions from other plugins.',
  }),
  sys('workspace-header', 'Workspace header', workspaceHeaderPlugin, {
    description: 'Top-of-app header with the workspace switcher.',
  }),
  sys('command-palette', 'Command palette', commandPalettePlugin, {
    description: 'Cmd+K palette listing every registered action.',
  }),
  sys('quick-find', 'Quick find', quickFindPlugin, {
    description: 'Cmd+P jump-to-block by alias, content, or relative date.',
  }),
  sys('find-replace', 'Find and replace', findReplacePlugin, {
    description: 'Cmd+Shift+F search-and-replace across the workspace.',
  }),
  sys('theme-toggle', 'Theme toggle', themeTogglePlugin, {
    description: 'Switch between light and dark colour scheme.',
  }),
  sys('account-header', 'Account header', accountHeaderPlugin, {
    description: 'User identity badge and logout entry in the header.',
  }),
  sys('plain-outliner', 'Plain outliner', plainOutlinerPlugin, {
    description: 'Editable text content renderer + click-to-edit behaviour used for plain text blocks.',
  }),
  sys('mobile-bottom-nav', 'Mobile bottom nav', mobileBottomNavPlugin, {
    description: 'Bottom navigation bar shown on mobile viewports.',
  }),
  sys('mobile-keyboard-toolbar', 'Mobile keyboard toolbar', mobileKeyboardToolbarPlugin, {
    description: 'Editing toolbar that floats above the on-screen keyboard on mobile.',
  }),
  sys('swipe-quick-actions', 'Swipe quick actions', swipeQuickActionsPlugin, {
    description: 'Swipe gesture on a block to reveal a quick-action menu.',
  }),
  sys('visual-navigation', 'Visual navigation', visualNavigationPlugin, {
    description: 'Spatial keyboard navigation between blocks based on visible layout.',
  }),
  sys('vim-normal-mode', 'Vim normal mode', vimNormalModePlugin({repo}), {
    description: 'Vim-style normal-mode keybindings inside the editor.',
  }),
  sys('video-player', 'Video player', videoPlayerPlugin, {
    description: 'Inline playback for blocks whose content is a video URL.',
  }),
  sys('references', 'References', referencesPlugin, {
    description: 'Wikilink + block-ref parsing and the wikilink display decorator.',
  }),
  sys('alias', 'Aliases', aliasPlugin, {
    description: 'Alias property + sync processor so blocks can be referenced by name.',
  }),
  sys('merge-blocks', 'Merge blocks', mergeBlocksPlugin, {
    description: 'Block-merge actions (Backspace at start of a block merges into the previous one).',
  }),
  // The backlinks-view coordinator reads variants registered by
  // `backlinksPlugin` and `groupedBacklinksPlugin`. Order matters only
  // for the picker UI (variants render in registration order); the
  // selection itself is driven by `backlinksViewProp`.
  sys('backlinks', 'Backlinks', backlinksPlugin, {
    description: 'Flat list of incoming references to the focused block.',
  }),
  sys('grouped-backlinks', 'Grouped backlinks', groupedBacklinksPlugin, {
    description: 'Backlinks grouped by a configurable property (defaults to the type of the source block).',
  }),
  sys('backlinks-view', 'Backlinks view', backlinksViewPlugin, {
    description: 'Picker that switches between the flat and grouped backlinks renderings.',
  }),
  sys('todo', 'Todo', todoPlugin, {
    description: 'Checkbox / done-state property on blocks.',
  }),
  sys('block-tagging', 'Block tagging', blockTaggingPlugin, {
    description: 'Add-tag action and the per-workspace tag-list preference.',
  }),
  sys('srs-rescheduling', 'SRS rescheduling', srsReschedulingPlugin, {
    description: 'Spaced-repetition scheduling for blocks with a next-review date.',
  }),
  sys('sync-status', 'Sync status', syncStatusPlugin, {
    description: 'Header indicator showing online / syncing / error state of the data sync.',
  }),
  sys('update-indicator', 'Update indicator', updateIndicatorPlugin, {
    description: 'Subtle indicator when a new app build has been deployed since this tab loaded.',
  }),
  sys('agent-runtime', 'Agent runtime', agentRuntimePlugin, {
    description: 'Bridge that lets external agents drive the app through a typed command protocol (also exposes per-token management UI).',
  }),
  sys('roam-import', 'Roam import', roamImportPlugin({repo}), {
    description: 'Import a Roam .json export into the current workspace.',
  }),
  // appIntentsPlugin's bootstrap effect resolves the layout-session
  // block via getUIStateBlock + getLayoutSessionBlock and then
  // dispatches any PWA-shortcut / share-target / note-taker intent
  // captured in the URL. Registered last so it runs after every
  // other plugin's data-layer setup is in place — the dispatch may
  // call appendTodayDailyBlockInStack, which depends on the
  // daily-notes data extension being live.
  sys('app-intents', 'App intents', appIntentsPlugin, {
    essential: true,
    description: 'Bootstrap that dispatches PWA-shortcut / share-target / note-taker URL intents on app open.',
  }),
]
