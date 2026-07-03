import { kernelDataExtension } from "../data/kernelDataExtension.js";
import { defaultRenderersExtension } from "./defaultRenderers.js";
import { toastAppMountExtension } from "./toastAppMount.js";
import { appUpdatePromptExtension } from "./appUpdateMount.js";
import { defaultEditorInteractionExtension } from "../editor/defaultInteractions.js";
import { defaultActionContextsExtension, defaultActionsExtension } from "../shortcuts/defaultShortcuts.js";
import { kernelPropertyUiExtension } from "../components/propertyEditors/typesPropertyUi.js";
import { kernelValuePresetsExtension } from "../components/propertyEditors/kernelValuePresets.js";
import { accountHeaderPlugin } from "../plugins/account-header/index.js";
import { swipeQuickActionsPlugin } from "../plugins/swipe-quick-actions/index.js";
import { commandPalettePlugin } from "../plugins/command-palette/index.js";
import { shortcutHelpPlugin } from "../plugins/shortcut-help/index.js";
import { dailyNotesPlugin } from "../plugins/daily-notes/index.js";
import { findReplacePlugin } from "../plugins/find-replace/index.js";
import { quickFindPlugin } from "../plugins/quick-find/index.js";
import { recentsPlugin } from "../plugins/recents/index.js";
import { themeTogglePlugin } from "../plugins/theme-toggle/index.js";
import { defaultThemesPlugin } from "../plugins/default-themes/index.js";
import { leftSidebarPlugin } from "../plugins/left-sidebar/index.js";
import { workspaceHeaderPlugin } from "../plugins/workspace-header/index.js";
import { plainOutlinerPlugin } from "../plugins/plain-outliner/index.js";
import { breadcrumbsPlugin } from "../plugins/breadcrumbs/index.js";
import { mobileBottomNavPlugin } from "../plugins/mobile-bottom-nav/index.js";
import { mobileKeyboardToolbarPlugin } from "../plugins/mobile-keyboard-toolbar/index.js";
import { spatialNavigationPlugin } from "../plugins/spatial-navigation/index.js";
import { vimNormalModePlugin } from "../plugins/vim-normal-mode/index.js";
import { onboardingPlugin } from "../plugins/onboarding/index.js";
import { videoPlayerPlugin } from "../plugins/video-player/index.js";
import { attachmentsPlugin } from "../plugins/attachments/index.js";
import { aliasPlugin } from "../plugins/alias/index.js";
import { mergeBlocksPlugin } from "../plugins/merge-blocks/index.js";
import { referencesPlugin } from "../plugins/references/index.js";
import { geoPlugin } from "../plugins/geo/index.js";
import { backlinksPlugin } from "../plugins/backlinks/index.js";
import { groupedBacklinksPlugin } from "../plugins/grouped-backlinks/index.js";
import { backlinksViewPlugin } from "../plugins/backlinks-view/index.js";
import { updateIndicatorPlugin } from "../plugins/update-indicator/index.js";
import { agentRuntimePlugin } from "../plugins/agent-runtime/index.js";
import { appIntentsPlugin } from "../plugins/app-intents/index.js";
import { roamImportPlugin } from "../plugins/roam-import/plugin.js";
import "../plugins/roam-import/index.js";
import { blockTaggingPlugin } from "../plugins/block-tagging/index.js";
import { srsReschedulingPlugin } from "../plugins/srs-rescheduling/index.js";
import { srsReviewPlugin } from "../plugins/srs-review/index.js";
import { todoPlugin } from "../plugins/todo/index.js";
import { systemStatusPlugin } from "../plugins/system-status/index.js";
import { storagePersistencePlugin } from "../plugins/storage-persistence/index.js";
import { dataIntegrityPlugin } from "../plugins/data-integrity/index.js";
import { dbMaintenancePlugin } from "../plugins/db-maintenance/plugin.js";
import "../plugins/db-maintenance/index.js";
import { startupMetricsPlugin } from "../plugins/startup-metrics/index.js";
import { extensionsSettingsPlugin } from "../plugins/extensions-settings/index.js";
import { keybindingsSettingsPlugin } from "../plugins/keybindings-settings/index.js";
import { extractTypePlugin } from "../plugins/extract-type/index.js";
import { birthdayPlugin } from "../plugins/birthday/index.js";
import { characterCounterPlugin } from "../plugins/character-counter/index.js";
//#region src/extensions/staticAppExtensions.ts
var staticAppExtensions = ({ repo }) => [
	extensionsSettingsPlugin,
	keybindingsSettingsPlugin,
	kernelDataExtension,
	kernelPropertyUiExtension,
	kernelValuePresetsExtension,
	defaultRenderersExtension,
	toastAppMountExtension,
	appUpdatePromptExtension,
	breadcrumbsPlugin,
	defaultEditorInteractionExtension,
	defaultActionContextsExtension,
	defaultActionsExtension({ repo }),
	dailyNotesPlugin({ repo }),
	onboardingPlugin({ repo }),
	leftSidebarPlugin,
	workspaceHeaderPlugin,
	commandPalettePlugin,
	shortcutHelpPlugin,
	quickFindPlugin,
	recentsPlugin({ repo }),
	findReplacePlugin,
	themeTogglePlugin,
	defaultThemesPlugin,
	accountHeaderPlugin,
	plainOutlinerPlugin,
	mobileBottomNavPlugin,
	mobileKeyboardToolbarPlugin,
	swipeQuickActionsPlugin,
	spatialNavigationPlugin,
	vimNormalModePlugin({ repo }),
	videoPlayerPlugin,
	attachmentsPlugin,
	referencesPlugin,
	geoPlugin,
	characterCounterPlugin,
	aliasPlugin,
	mergeBlocksPlugin,
	backlinksPlugin,
	groupedBacklinksPlugin,
	backlinksViewPlugin,
	todoPlugin,
	blockTaggingPlugin,
	extractTypePlugin,
	srsReschedulingPlugin,
	srsReviewPlugin({ repo }),
	systemStatusPlugin,
	storagePersistencePlugin,
	dataIntegrityPlugin({ repo }),
	dbMaintenancePlugin({ repo }),
	startupMetricsPlugin,
	updateIndicatorPlugin,
	agentRuntimePlugin,
	roamImportPlugin({ repo }),
	birthdayPlugin,
	appIntentsPlugin
];
//#endregion
export { staticAppExtensions };

//# sourceMappingURL=staticAppExtensions.js.map