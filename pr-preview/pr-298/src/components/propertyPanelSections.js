//#region src/components/propertyPanelSections.ts
var buildPropertyPanelSections = (args) => {
	const hasProperty = (name) => Object.hasOwn(args.properties, name);
	const assigned = /* @__PURE__ */ new Set();
	const sections = [];
	const seenTypeIds = /* @__PURE__ */ new Set();
	for (const typeId of args.blockTypes) {
		if (seenTypeIds.has(typeId)) continue;
		seenTypeIds.add(typeId);
		const contribution = args.typesRegistry.get(typeId);
		if (!contribution) continue;
		const rows = [];
		for (const declared of contribution.properties ?? []) {
			if (assigned.has(declared.name)) continue;
			const active = args.schemas.get(declared.name);
			if (!active) continue;
			assigned.add(declared.name);
			const isSet = hasProperty(active.name);
			rows.push({
				name: active.name,
				encodedValue: args.properties[active.name],
				isSet
			});
		}
		if (rows.length > 0) sections.push({
			id: `type:${typeId}`,
			label: contribution.label ?? typeId,
			description: contribution.description,
			rows
		});
	}
	const otherRows = [];
	const unregisteredRows = [];
	const addLooseRow = (row) => {
		if (assigned.has(row.name)) return;
		if (args.schemas.has(row.name)) otherRows.push(row);
		else unregisteredRows.push(row);
	};
	for (const name of Object.keys(args.properties)) {
		if (assigned.has(name)) continue;
		addLooseRow({
			name,
			encodedValue: args.properties[name],
			isSet: true
		});
	}
	for (const row of args.syntheticRows ?? []) {
		if (hasProperty(row.name)) continue;
		addLooseRow(row);
	}
	if (otherRows.length > 0) sections.push({
		id: "other",
		label: "Other",
		rows: otherRows
	});
	if (unregisteredRows.length > 0) sections.push({
		id: "unregistered",
		label: "Unregistered",
		rows: unregisteredRows
	});
	return sections;
};
//#endregion
export { buildPropertyPanelSections };

//# sourceMappingURL=propertyPanelSections.js.map