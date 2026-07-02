import { propertySchemasFacet, typesFacet } from "../../data/facets.js";
import { charLimitProp } from "./properties.js";
import { CHAR_COUNTER_TYPE_CONTRIBUTIONS } from "./blockType.js";
//#region src/plugins/character-counter/dataExtension.ts
/** Data-layer contributions for the character-counter plugin — the
*  `char-counter` block type and its `char:limit` property schema.
*  Composed into the user-facing `characterCounterPlugin` in `./index.ts`. */
var characterCounterDataExtension = [CHAR_COUNTER_TYPE_CONTRIBUTIONS.map((t) => typesFacet.of(t, { source: "character-counter" })), propertySchemasFacet.of(charLimitProp, { source: "character-counter" })];
//#endregion
export { characterCounterDataExtension };

//# sourceMappingURL=dataExtension.js.map