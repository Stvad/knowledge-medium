import { getBlockTypes, typesProp } from "../../data/properties.js";
import { isPropertyPanelHiddenProperty } from "./visibility.js";
import { buildPropertyPanelSections } from "../propertyPanelSections.js";
import { resolvePropertyDisplay } from "../propertyEditors/defaults.js";
//#region src/components/propertyPanel/model.ts
var EMPTY_BLOCK_TYPES = [];
var HIDDEN_SECTION = {
	id: "hidden",
	label: "Hidden",
	rows: []
};
var DECODE_FAILED = Symbol("decode-failed");
var safeDecode = (schema, encoded) => {
	try {
		return schema.codec.decode(encoded);
	} catch {
		return DECODE_FAILED;
	}
};
var readBlockTypes = (properties) => {
	try {
		return getBlockTypes({ properties });
	} catch {
		return EMPTY_BLOCK_TYPES;
	}
};
var partitionProperties = (properties, schemas, uis) => {
	const visibleProperties = {};
	const hiddenProperties = {};
	for (const [name, value] of Object.entries(properties)) if (isPropertyPanelHiddenProperty(name, schemas, uis)) hiddenProperties[name] = value;
	else visibleProperties[name] = value;
	return {
		visibleProperties,
		hiddenProperties
	};
};
var resolveModelRow = (row, args) => {
	const display = resolvePropertyDisplay({
		name: row.name,
		encodedValue: row.isSet ? row.encodedValue : void 0,
		schemas: args.schemas,
		uis: args.uis,
		presets: args.presets
	});
	if (!row.isSet && !display.isKnown) return null;
	const decodedValue = row.isSet ? display.isKnown ? safeDecode(display.schema, row.encodedValue) : row.encodedValue : display.schema.defaultValue;
	const decodeFailed = row.isSet && display.isKnown && decodedValue === DECODE_FAILED;
	const ui = args.uis.get(row.name);
	const isTypeMembershipRow = row.name === typesProp.name;
	return {
		name: row.name,
		encodedValue: row.encodedValue,
		isSet: row.isSet,
		labelText: ui?.label ?? row.name,
		shape: display.shape,
		schema: display.schema,
		schemaUnknown: !display.isKnown,
		decodeFailed,
		value: decodeFailed ? row.encodedValue : decodedValue,
		Editor: display.Editor,
		Glyph: display.Glyph,
		canRename: !args.hidden && !display.isKnown,
		canDelete: !args.hidden && row.isSet && !isTypeMembershipRow,
		canChangeShape: !args.hidden && !display.isKnown,
		isHidden: args.hidden
	};
};
var resolveSection = (section, args) => {
	const rows = section.rows.map((row) => resolveModelRow(row, args)).filter((row) => row !== null);
	if (rows.length === 0) return null;
	return {
		id: section.id,
		label: section.label,
		description: section.description,
		rows
	};
};
var buildPropertyPanelModel = (args) => {
	const blockTypes = readBlockTypes(args.properties);
	const { visibleProperties, hiddenProperties } = partitionProperties(args.properties, args.schemas, args.uis);
	const pinnedRawRows = [{
		name: typesProp.name,
		encodedValue: Object.hasOwn(visibleProperties, typesProp.name) ? visibleProperties[typesProp.name] : typesProp.codec.encode(blockTypes),
		isSet: true
	}];
	const sectionProperties = { ...visibleProperties };
	delete sectionProperties[typesProp.name];
	const pinnedRows = pinnedRawRows.map((row) => resolveModelRow(row, {
		schemas: args.schemas,
		uis: args.uis,
		presets: args.presets,
		hidden: false
	})).filter((row) => row !== null);
	const sections = buildPropertyPanelSections({
		properties: sectionProperties,
		blockTypes,
		typesRegistry: args.typesRegistry,
		schemas: args.schemas,
		syntheticRows: args.syntheticRows
	}).map((section) => resolveSection(section, {
		schemas: args.schemas,
		uis: args.uis,
		presets: args.presets,
		hidden: false
	})).filter((section) => section !== null);
	const hiddenRows = Object.keys(hiddenProperties).sort().map((name) => ({
		name,
		encodedValue: hiddenProperties[name],
		isSet: true
	}));
	const hiddenSection = resolveSection({
		...HIDDEN_SECTION,
		rows: hiddenRows
	}, {
		schemas: args.schemas,
		uis: args.uis,
		presets: args.presets,
		hidden: true
	}) ?? {
		...HIDDEN_SECTION,
		rows: []
	};
	const metadataRows = [
		{
			label: "ID",
			value: args.blockId
		},
		{
			label: "Last changed",
			value: new Date(args.updatedAt).toLocaleString()
		},
		{
			label: "Changed by",
			value: args.updatedBy,
			linkToBlockId: args.updatedByBlockId
		}
	];
	return {
		blockTypes,
		pinnedRows,
		sections,
		hiddenSection,
		metadataRows,
		hiddenCount: metadataRows.length + hiddenSection.rows.length,
		showSectionLabels: sections.length > 1
	};
};
//#endregion
export { HIDDEN_SECTION, buildPropertyPanelModel };

//# sourceMappingURL=model.js.map