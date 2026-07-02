import { completionKeymap } from "../../node_modules/@codemirror/autocomplete/dist/index.js";
//#region src/utils/codemirrorCompletion.ts
var handlesEscape = (binding) => binding.key === "Escape" || binding.mac === "Escape" || binding.linux === "Escape" || binding.win === "Escape";
var completionKeymapWithEscapeFallthrough = completionKeymap.filter((binding) => !handlesEscape(binding)).map((binding) => ({
	...binding,
	stopPropagation: true
}));
//#endregion
export { completionKeymapWithEscapeFallthrough };

//# sourceMappingURL=codemirrorCompletion.js.map