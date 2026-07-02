import { codeMirrorExtensionsFacet } from "./codeMirrorExtensions.js";
import { keymap } from "../../node_modules/@codemirror/view/dist/index.js";
import { autocompletion } from "../../node_modules/@codemirror/autocomplete/dist/index.js";
import { completionKeymapWithEscapeFallthrough } from "../utils/codemirrorCompletion.js";
//#region src/editor/autocomplete.ts
/** Central autocompletion installer.
*
*  Calls `autocompletion()` exactly once per editor. No `override` —
*  sources are collected from CodeMirror's `EditorState.languageData`
*  facet (the `autocomplete` field on each data entry), which plugins
*  contribute to via their own `codeMirrorExtensionsFacet` registration.
*  This is the CM-native contributory path; multiple language-data
*  callbacks just concat. */
var editorAutocompleteContribution = () => [autocompletion({
	defaultKeymap: false,
	icons: false,
	tooltipClass: () => "tm-reference-autocomplete"
}), keymap.of(completionKeymapWithEscapeFallthrough)];
var editorAutocompleteExtension = codeMirrorExtensionsFacet.of(editorAutocompleteContribution, { source: "editor-autocomplete" });
//#endregion
export { editorAutocompleteExtension };

//# sourceMappingURL=autocomplete.js.map