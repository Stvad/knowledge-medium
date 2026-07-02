import { systemToggle } from "../../facets/togglable.js";
import { diagnosticsFacet } from "../diagnostics/facet.js";
import { REQUEST_PERSISTENCE_ACTION_ID, persistenceDiagnosticSource } from "./persistenceStatus.js";
import { requestPersistenceActionContribution } from "./requestAction.js";
//#region src/plugins/storage-persistence/index.ts
/** Surfaces an ambient reminder (via the diagnostics seam → status chip) when
*  the origin's local storage isn't persistent, with a one-tap "Protect"
*  request. The boot-time silent attempt lives in src/requestPersistentStorage.ts;
*  this plugin is the contextual, user-initiated path. */
var storagePersistencePlugin = systemToggle({
	id: "system:storage-persistence",
	name: "Storage persistence",
	description: "Reminds you when local data can be evicted under storage pressure and offers a one-tap request to make it persistent."
}).of([diagnosticsFacet.of(persistenceDiagnosticSource, { source: "storage-persistence" }), requestPersistenceActionContribution]);
//#endregion
export { REQUEST_PERSISTENCE_ACTION_ID, storagePersistencePlugin };

//# sourceMappingURL=index.js.map