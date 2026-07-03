import { systemToggle } from "../../facets/togglable.js";
import { charLimitProp } from "./properties.js";
import { CHAR_COUNTER_TYPE } from "./blockType.js";
import { characterCounterDataExtension } from "./dataExtension.js";
import { blockContentDecoratorsFacet } from "../../extensions/blockInteraction.js";
import { charCountDisplay } from "./charCount.js";
import { characterCountDecoratorContribution } from "./CharacterCountDecorator.js";
//#region src/plugins/character-counter/index.ts
/** Character-counter plugin — tag a block "Character counter" to show a
*  live character count below its content, with an optional per-block
*  limit. The count is purely additive (a decorator over the existing
*  renderer) and the limit is visual-only; neither ever blocks editing. */
var characterCounterPlugin = systemToggle({
	id: "system:character-counter",
	name: "Character counter",
	description: "Tag a block \"Character counter\" to show a live character count below it, with an optional limit."
}).of([characterCounterDataExtension, blockContentDecoratorsFacet.of(characterCountDecoratorContribution, { source: "character-counter" })]);
//#endregion
export { CHAR_COUNTER_TYPE, charCountDisplay, charLimitProp, characterCounterPlugin };

//# sourceMappingURL=index.js.map