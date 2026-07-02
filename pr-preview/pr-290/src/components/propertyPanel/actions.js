import { ChangeScope } from "../../data/api/changeScope.js";
import "../../data/api/index.js";
import { typesProp } from "../../data/properties.js";
import { isPropertyPanelHiddenProperty } from "./visibility.js";
//#region src/components/propertyPanel/actions.ts
var writeProperty = (block, schema, decodedValue) => block.set(schema, decodedValue);
/** AddPropertyForm submit handler: adopt a registered schema if the
*  user picked one, or have UserSchemasService.addSchema register a
*  new one synchronously. The returned schema lets the caller render an
*  unset row without writing the schema default as stored data. Refuses
*  hidden / reserved names. */
var addProperty = async (block, schemas, uis, args) => {
	const name = args.name.trim();
	if (!name) return void 0;
	if (isPropertyPanelHiddenProperty(name, schemas, uis)) return void 0;
	if (args.adopted) return args.adopted;
	const existing = schemas.get(name);
	if (existing) return existing;
	try {
		return await block.repo.userSchemas.addSchema({
			name,
			presetId: args.presetId
		});
	} catch (err) {
		console.error(`[addProperty] failed to register schema for "${name}":`, err);
		return;
	}
};
var renameProperty = async (args) => {
	const nextName = args.newName.trim();
	if (!nextName || nextName === args.oldName) return;
	if (args.oldName === typesProp.name || nextName === typesProp.name) return;
	if (args.schemas.has(args.oldName) || args.schemas.has(nextName)) return;
	if (isPropertyPanelHiddenProperty(args.oldName, args.schemas, args.uis)) return;
	if (isPropertyPanelHiddenProperty(nextName, args.schemas, args.uis)) return;
	const value = args.properties[args.oldName];
	if (value === void 0 || !Object.hasOwn(args.properties, args.oldName)) return;
	await args.block.repo.tx(async (tx) => {
		const next = { ...args.properties };
		delete next[args.oldName];
		next[nextName] = value;
		await tx.update(args.block.id, { properties: next });
	}, {
		scope: ChangeScope.BlockDefault,
		description: `rename property ${args.oldName} to ${nextName}`
	});
};
var deleteProperty = async (args) => {
	if (args.name === typesProp.name) return;
	if (isPropertyPanelHiddenProperty(args.name, args.schemas, args.uis)) return;
	if (!Object.hasOwn(args.properties, args.name)) return;
	const next = { ...args.properties };
	delete next[args.name];
	const schema = args.schemas.get(args.name);
	await args.block.repo.tx(async (tx) => {
		await tx.update(args.block.id, { properties: next });
	}, {
		scope: schema?.changeScope ?? ChangeScope.BlockDefault,
		description: `delete property ${args.name}`
	});
};
//#endregion
export { addProperty, deleteProperty, renameProperty, writeProperty };

//# sourceMappingURL=actions.js.map