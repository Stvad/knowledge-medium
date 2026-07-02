import { ChangeScope } from "../../data/api/changeScope.js";
import { codecs } from "../../data/api/codecs.js";
import { defineProperty } from "../../data/api/propertySchema.js";
import "../../data/api/index.js";
//#region src/plugins/character-counter/properties.ts
/** Character-counter plugin property schemas.
*
*  `char:limit` is the single, optional per-block limit. Undefined ≡ "no
*  limit" → the counter shows a bare count. When set to a positive number
*  the counter renders `count / limit` and flags the over-limit state.
*  Visual only — the limit never blocks typing (see CharacterCountDecorator). */
var charLimitProp = defineProperty("char:limit", {
	codec: codecs.optionalNumber,
	defaultValue: void 0,
	changeScope: ChangeScope.BlockDefault
});
//#endregion
export { charLimitProp };

//# sourceMappingURL=properties.js.map