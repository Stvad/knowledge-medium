import { extensionDescriptionProp, extensionNameProp } from "../data/properties.js";
import { userToggle } from "../facets/togglable.js";
//#region src/extensions/extensionToggles.ts
/** Decode a string-valued extension property (name/description) from a
*  block, returning undefined when absent, empty, or malformed. */
function blockStringProperty(block, schema) {
	const encoded = block.properties[schema.name];
	if (encoded === void 0) return void 0;
	try {
		const value = schema.codec.decode(encoded).trim();
		return value.length > 0 ? value : void 0;
	} catch {
		return;
	}
}
/** Resolve a display name from block-level data only — no module
*  compilation. Uses the explicit `extension:name`, falling back to a
*  block-id snippet (rendered as a link in the settings UI). */
function blockOnlyName(block) {
	const name = extensionName(block);
	if (name) return name;
	return `Extension ${block.id.slice(0, 8)}`;
}
/** The label that identifies this extension block: its explicit
*  `extension:name` (set at install time). The agent bridge uses this to
*  resolve `enable-extension <name>` / `uninstall-extension <name>` to a
*  block; the settings UI uses `blockOnlyName` (above) for display.
*  Undefined when absent/empty/malformed. */
function extensionName(block) {
	return blockStringProperty(block, extensionNameProp);
}
/** Build a user-extension togglable from a block: decode the display
*  metadata, then delegate to the kernel's `userToggle` (which locks
*  `essential`/`kind` and forces `defaultEnabled: false`). */
function userExtensionToggle(block) {
	return userToggle({
		id: block.id,
		name: blockOnlyName(block),
		description: blockStringProperty(block, extensionDescriptionProp)
	});
}
/** Disabled-shell variant. Same decode + factory: all metadata is
*  block-local, so no module compilation is needed. */
function userExtensionShellToggle(block) {
	return userExtensionToggle(block);
}
//#endregion
export { extensionName, userExtensionShellToggle, userExtensionToggle };

//# sourceMappingURL=extensionToggles.js.map