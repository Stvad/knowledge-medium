//#region src/components/propertyPanel/shapes.ts
/** Property "type" vocabulary surfaced in panel UI. Codec types are
*  open strings (`'string' | 'number' | 'list' | 'url' | 'ref' | …`),
*  so `propertyShapeLabel` accepts arbitrary strings and falls back to
*  the raw type for plugin-contributed types without a kernel preset. */
var KERNEL_TYPE_LABELS = {
	string: "Plain",
	list: "Options",
	date: "Date",
	number: "Number",
	boolean: "Checkbox",
	object: "Object",
	enum: "Choice",
	url: "URL",
	ref: "Reference",
	refList: "References"
};
var propertyShapeLabel = (type) => KERNEL_TYPE_LABELS[type] ?? type;
//#endregion
export { propertyShapeLabel };

//# sourceMappingURL=shapes.js.map