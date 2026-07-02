import { kernelDataExtension } from "../data/kernelDataExtension.js";
import { aliasDataExtension } from "../plugins/alias/dataExtension.js";
import { backlinksDataExtension } from "../plugins/backlinks/dataExtension.js";
import { characterCounterDataExtension } from "../plugins/character-counter/dataExtension.js";
import { dailyNotesDataExtension } from "../plugins/daily-notes/dataExtension.js";
import { findReplaceDataExtension } from "../plugins/find-replace/dataExtension.js";
import { geoDataExtension } from "../plugins/geo/dataExtension.js";
import { groupedBacklinksDataExtension } from "../plugins/grouped-backlinks/dataExtension.js";
import { referencesDataExtension } from "../plugins/references/dataExtension.js";
import { srsReschedulingDataExtension } from "../plugins/srs-rescheduling/dataExtension.js";
import { todoDataExtension } from "../plugins/todo/dataExtension.js";
//#region src/extensions/staticDataExtensions.ts
/** Static data facets that must be available before the React app runtime
*  resolves. Keep this list UI-free so repo bootstrap can install plugin
*  data ownership without importing component trees.
*
*  This is the registry the onboarding tutorial seeds against at bootstrap
*  (before the app runtime is applied): it tags demo blocks with the todo /
*  char-counter / srs / place / map types, so those plugins' data extensions
*  must be here. */
var staticDataExtensions = [
	kernelDataExtension,
	dailyNotesDataExtension,
	findReplaceDataExtension,
	referencesDataExtension,
	aliasDataExtension,
	backlinksDataExtension,
	groupedBacklinksDataExtension,
	srsReschedulingDataExtension,
	todoDataExtension,
	characterCounterDataExtension,
	geoDataExtension
];
//#endregion
export { staticDataExtensions };

//# sourceMappingURL=staticDataExtensions.js.map