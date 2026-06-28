import type { Repo } from '@/data/repo'
import { kernelDataExtension } from '@/data/kernelDataExtension.js'
import { defaultRenderersExtension } from '@/extensions/defaultRenderers.js'
import { toastAppMountExtension } from '@/extensions/toastAppMount.js'
import { appUpdatePromptExtension } from '@/extensions/appUpdateMount.js'
import { defaultEditorInteractionExtension } from '@/editor/defaultInteractions.js'
import {
  defaultActionContextsExtension,
  defaultActionsExtension,
} from '@/shortcuts/defaultShortcuts.js'
import { kernelPropertyUiExtension } from '@/components/propertyEditors/typesPropertyUi.js'
import { kernelValuePresetsExtension } from '@/components/propertyEditors/kernelValuePresets.js'
import { accountHeaderPlugin } from '@/plugins/account-header'
import { commandPalettePlugin } from '@/plugins/command-palette'
import { dailyNotesPlugin } from '@/plugins/daily-notes'
import { findReplacePlugin } from '@/plugins/find-replace'
import { quickFindPlugin } from '@/plugins/quick-find'
import { recentsPlugin } from '@/plugins/recents'
import { defaultThemesPlugin } from '@/plugins/default-themes'
import { themeTogglePlugin } from '@/plugins/theme-toggle'
import { workspaceHeaderPlugin } from '@/plugins/workspace-header'
import { plainOutlinerPlugin } from '@/plugins/plain-outliner'
import { breadcrumbsPlugin } from '@/plugins/breadcrumbs'
import { leftSidebarPlugin } from '@/plugins/left-sidebar'
import { mobileBottomNavPlugin } from '@/plugins/mobile-bottom-nav'
import { mobileKeyboardToolbarPlugin } from '@/plugins/mobile-keyboard-toolbar'
import { swipeQuickActionsPlugin } from '@/plugins/swipe-quick-actions'
import { spatialNavigationPlugin } from '@/plugins/spatial-navigation'
import { vimNormalModePlugin } from '@/plugins/vim-normal-mode'
import { onboardingPlugin } from '@/plugins/onboarding'
import { videoPlayerPlugin } from '@/plugins/video-player'
import { attachmentsPlugin } from '@/plugins/attachments'
import { aliasPlugin } from '@/plugins/alias'
import { mergeBlocksPlugin } from '@/plugins/merge-blocks'
import { referencesPlugin } from '@/plugins/references'
import { geoPlugin } from '@/plugins/geo'
import { backlinksPlugin } from '@/plugins/backlinks'
import { groupedBacklinksPlugin } from '@/plugins/grouped-backlinks'
import { backlinksViewPlugin } from '@/plugins/backlinks-view'
import { updateIndicatorPlugin } from '@/plugins/update-indicator'
import { agentRuntimePlugin } from '@/plugins/agent-runtime'
import { appIntentsPlugin } from '@/plugins/app-intents'
import { roamImportPlugin } from '@/plugins/roam-import'
import { blockTaggingPlugin } from '@/plugins/block-tagging'
import { srsReschedulingPlugin } from '@/plugins/srs-rescheduling'
import { srsReviewPlugin } from '@/plugins/srs-review'
import { todoPlugin } from '@/plugins/todo'
import { systemStatusPlugin } from '@/plugins/system-status'
import { storagePersistencePlugin } from '@/plugins/storage-persistence'
import { dataIntegrityPlugin } from '@/plugins/data-integrity'
import { dbMaintenancePlugin } from '@/plugins/db-maintenance'
import { startupMetricsPlugin } from '@/plugins/startup-metrics'
import { extensionsSettingsPlugin } from '@/plugins/extensions-settings'
import { keybindingsSettingsPlugin } from '@/plugins/keybindings-settings'
import { extractTypePlugin } from '@/plugins/extract-type'
import { birthdayPlugin } from '@/plugins/birthday'
import { characterCounterPlugin } from '@/plugins/character-counter'
import type { AppExtension } from '@/facets/facet.js'

export const staticAppExtensions = ({repo}: {repo: Repo}): AppExtension[] => [
  // kernelDataExtension contributes KERNEL_MUTATORS and core data
  // registries. repo.setFacetRuntime REPLACES those registries, so the
  // kernel contribution must be present in every static runtime.
  // Extensions meta-plugin owns the overrides map + cache sync.
  extensionsSettingsPlugin,
  // Keybindings meta-plugin owns the user shortcut-override map + cache.
  // Registered after extensions-settings so its prefs sub-block sits
  // below "Extensions" in the Preferences tree; functionally
  // independent (no shared facet contributions).
  keybindingsSettingsPlugin,
  kernelDataExtension,
  kernelPropertyUiExtension,
  kernelValuePresetsExtension,
  defaultRenderersExtension,
  toastAppMountExtension,
  appUpdatePromptExtension,
  // The dialog mount (DialogHost reading the openDialog queue) is no
  // longer a top-level toggle — it's pulled in by every dialog-using
  // plugin (block-tagging, daily-notes) inside its own AppExtension
  // array. Dedup by FacetContribution reference means a single
  // appMountsFacet contribution is registered no matter how many
  // plugins reference it; if every dialog-using plugin is disabled
  // the mount drops out automatically. This avoids a "shared infra"
  // toggle the user has no real reason to flip independently.
  breadcrumbsPlugin,
  defaultEditorInteractionExtension,
  defaultActionContextsExtension,
  defaultActionsExtension({repo}),
  // dailyNotesPlugin contributes both the workspace-landing resolver
  // (used by App.tsx pre-mount) and the open_today / prev / next
  // shortcut actions. Order vs other landing-contributing plugins:
  // higher-precedence resolvers should be appended LATER so the
  // facet's "last wins" arrangement does the right thing without an
  // explicit precedence number.
  dailyNotesPlugin({repo}),
  // Onboarding seeds first-run content via its own higher-precedence
  // landing resolver, then defers the landing target to daily-notes
  // above. Depends on daily-notes (get-or-create of today's note).
  onboardingPlugin,
  leftSidebarPlugin,
  workspaceHeaderPlugin,
  commandPalettePlugin,
  quickFindPlugin,
  recentsPlugin({repo}),
  findReplacePlugin,
  themeTogglePlugin,
  defaultThemesPlugin,
  accountHeaderPlugin,
  plainOutlinerPlugin,
  mobileBottomNavPlugin,
  mobileKeyboardToolbarPlugin,
  swipeQuickActionsPlugin,
  spatialNavigationPlugin,
  vimNormalModePlugin({repo}),
  videoPlayerPlugin,
  attachmentsPlugin,
  referencesPlugin,
  geoPlugin,
  characterCounterPlugin,
  aliasPlugin,
  mergeBlocksPlugin,
  // The backlinks-view coordinator reads variants registered by
  // `backlinksPlugin` and `groupedBacklinksPlugin`. Order matters only
  // for the picker UI (variants render in registration order); the
  // selection itself is driven by each block's `backlinksViewProp`
  // override, falling back to a block-derived default.
  backlinksPlugin,
  groupedBacklinksPlugin,
  backlinksViewPlugin,
  todoPlugin,
  blockTaggingPlugin,
  extractTypePlugin,
  srsReschedulingPlugin,
  srsReviewPlugin({repo}),
  systemStatusPlugin,
  storagePersistencePlugin,
  dataIntegrityPlugin({repo}),
  dbMaintenancePlugin({repo}),
  startupMetricsPlugin,
  updateIndicatorPlugin,
  agentRuntimePlugin,
  roamImportPlugin({repo}),
  birthdayPlugin,
  // appIntentsPlugin's bootstrap effect resolves the layout-session
  // block via getUIStateBlock + getLayoutSessionBlock and then
  // dispatches any PWA-shortcut / share-target / note-taker intent
  // captured in the URL. Registered last so it runs after every
  // other plugin's data-layer setup is in place — the dispatch may
  // call appendTodayDailyBlockInStack, which depends on the
  // daily-notes data extension being live.
  appIntentsPlugin,
]
