import { invalidationRulesFacet, localSchemaFacet, postCommitProcessorsFacet, sameTxProcessorsFacet } from "../../data/facets.js";
import { referencesPostCommitProcessors } from "./referencesProcessor.js";
import { renamePostCommitProcessors } from "./renameProcessor.js";
import { referencesSameTxProcessors } from "./mergeRetargetProcessor.js";
import { referencesLocalSchema } from "./localSchema.js";
import { referencesInvalidationRule } from "./invalidation.js";
//#region src/plugins/references/dataExtension.ts
var referencesDataExtension = [
	localSchemaFacet.of(referencesLocalSchema, { source: "references" }),
	invalidationRulesFacet.of(referencesInvalidationRule, { source: "references" }),
	referencesSameTxProcessors.map((processor) => sameTxProcessorsFacet.of(processor, { source: "references" })),
	[...referencesPostCommitProcessors, ...renamePostCommitProcessors].map((processor) => postCommitProcessorsFacet.of(processor, { source: "references" }))
];
//#endregion
export { referencesDataExtension };

//# sourceMappingURL=dataExtension.js.map