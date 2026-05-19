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

export const staticAppExtensions = ({repo}: {repo: Repo}): AppExtension[] => [
  // kernelDataExtension contributes KERNEL_MUTATORS and core data
  // registries. repo.setFacetRuntime REPLACES those registries, so the
  // kernel contribution must be present in every static runtime.
  kernelDataExtension,
  kernelPropertyUiExtension,
  kernelValuePresetsExtension,
  defaultRenderersExtension,
  toastAppMountExtension,
  dialogAppMountExtension,
  breadcrumbsPlugin,
  defaultEditorInteractionExtension,
  defaultActionsExtension({repo}),
  // dailyNotesPlugin contributes both the workspace-landing resolver
  // (used by App.tsx pre-mount) and the open_today / prev / next
  // shortcut actions. Order vs other landing-contributing plugins:
  // higher-precedence resolvers should be appended LATER so the
  // facet's "last wins" arrangement does the right thing without an
  // explicit precedence number.
  dailyNotesPlugin({repo}),
  leftSidebarPlugin,
  workspaceHeaderPlugin,
  commandPalettePlugin,
  quickFindPlugin,
  themeTogglePlugin,
  accountHeaderPlugin,
  plainOutlinerPlugin,
  mobileBottomNavPlugin,
  mobileKeyboardToolbarPlugin,
  swipeQuickActionsPlugin,
  visualNavigationPlugin,
  vimNormalModePlugin({repo}),
  videoPlayerPlugin,
  referencesPlugin,
  aliasPlugin,
  // The backlinks-view coordinator reads variants registered by
  // `backlinksPlugin` and `groupedBacklinksPlugin`. Order matters only
  // for the picker UI (variants render in registration order); the
  // selection itself is driven by `backlinksViewProp`.
  backlinksPlugin,
  groupedBacklinksPlugin,
  backlinksViewPlugin,
  todoPlugin,
  blockTaggingPlugin,
  srsReschedulingPlugin,
  syncStatusPlugin,
  updateIndicatorPlugin,
  agentRuntimePlugin,
  roamImportPlugin({repo}),
  // appIntentsPlugin's bootstrap effect resolves the layout-session
  // block via getUIStateBlock + getLayoutSessionBlock and then
  // dispatches any PWA-shortcut / share-target / note-taker intent
  // captured in the URL. Registered last so it runs after every
  // other plugin's data-layer setup is in place — the dispatch may
  // call appendTodayDailyBlockInStack, which depends on the
  // daily-notes data extension being live.
  appIntentsPlugin,
]
