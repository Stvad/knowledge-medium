import { mutatorsFacet, sameTxProcessorsFacet } from "../../data/facets.js";
import { aliasCollisionMutators } from "./collisionMerge.js";
import { aliasSameTxProcessors } from "./syncProcessor.js";
//#region src/plugins/alias/dataExtension.ts
var aliasDataExtension = [aliasSameTxProcessors.map((processor) => sameTxProcessorsFacet.of(processor, { source: "alias" })), aliasCollisionMutators.map((mutator) => mutatorsFacet.of(mutator, { source: "alias" }))];
//#endregion
export { aliasDataExtension };

//# sourceMappingURL=dataExtension.js.map