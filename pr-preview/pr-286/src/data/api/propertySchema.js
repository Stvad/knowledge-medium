//#region src/data/api/propertySchema.ts
/** Canonical narrowing of `PropertyEditorProps.block` (an opaque `unknown`)
*  to "is this block's repo read-only?". Several config editors otherwise
*  re-derive this identical guard. */
var isReadOnlyBlock = (block) => {
	if (!block || typeof block !== "object") return false;
	return block.repo?.isReadOnly === true;
};
/** Helper for plugin authors to define a schema with full type inference
*  on `defaultValue`. */
var defineProperty = (name, schema) => ({
	name,
	...schema
});
/** Helper for the rare property that needs a per-name editor override.
*  Most plugins should NOT reach for this — registering an override is
*  the outlier path. The common path is a codec-type-based ValuePreset. */
var definePropertyEditorOverride = (override) => override;
//#endregion
export { defineProperty, definePropertyEditorOverride, isReadOnlyBlock };

//# sourceMappingURL=propertySchema.js.map