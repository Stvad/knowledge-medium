import { editorSelection, focusBlock, requestEditorFocus } from "../data/properties.js";
import { propertyEditorOverridesFacet, typesFacet, valuePresetsFacet } from "../data/facets.js";
import { Button } from "./ui/button.js";
import { useChildIds, useHandle } from "../hooks/block.js";
import { useAppRuntime } from "../extensions/runtimeContext.js";
import { EyeOff } from "../../node_modules/lucide-react/dist/esm/icons/eye-off.js";
import { Eye } from "../../node_modules/lucide-react/dist/esm/icons/eye.js";
import { usePropertySchemas } from "../hooks/propertySchemas.js";
import { useBlockContext } from "../context/block.js";
import { useUIStateBlock, useUserPage } from "../data/globalState.js";
import { nextVisibleBlock } from "../utils/selection.js";
import { focusAdjacentPropertyRow } from "../utils/propertyNavigation.js";
import { useNavigate } from "../utils/navigation.js";
import { AddPropertyForm } from "./propertyPanel/AddPropertyForm.js";
import { addProperty, deleteProperty, renameProperty, writeProperty } from "./propertyPanel/actions.js";
import { buildPropertyPanelModel } from "./propertyPanel/model.js";
import { PropertyRow } from "./propertyPanel/PropertyRow.js";
import { MetadataRow, PropertySectionLabel } from "./propertyPanel/Rows.js";
import { useEffect, useRef, useState } from "react";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/components/BlockProperties.tsx
/**
* Property panel shell. The lookup chain/model lives in
* `propertyPanel/model.ts`; row actions live in `propertyPanel/actions.ts`;
* row/add/config UI lives under `propertyPanel/`.
*/
var EMPTY_PROPERTIES = {};
function BlockProperties(t0) {
	const $ = c(67);
	const { block } = t0;
	let t1;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = { selector: _temp };
		$[0] = t1;
	} else t1 = $[0];
	const blockData = useHandle(block, t1);
	const childIds = useChildIds(block);
	const updatedByUser = useUserPage(blockData?.updatedBy ?? "");
	const uiStateBlock = useUIStateBlock();
	const runtime = useAppRuntime();
	const { panelId, scopeRootId, renderScopeId, isNestedSurface } = useBlockContext();
	const navigate = useNavigate();
	const [showHiddenFields, setShowHiddenFields] = useState(false);
	let t2;
	if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
		t2 = [];
		$[1] = t2;
	} else t2 = $[1];
	const [syntheticProperties, setSyntheticProperties] = useState(t2);
	const [recentlyMaterializedName, setRecentlyMaterializedName] = useState(null);
	const flashTimerRef = useRef(null);
	let t3;
	let t4;
	if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
		t3 = () => () => {
			if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
		};
		t4 = [];
		$[2] = t3;
		$[3] = t4;
	} else {
		t3 = $[2];
		t4 = $[3];
	}
	useEffect(t3, t4);
	const flashRecent = (name) => {
		setRecentlyMaterializedName(name);
		if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
		flashTimerRef.current = setTimeout(() => {
			setRecentlyMaterializedName((curr) => curr === name ? null : curr);
			flashTimerRef.current = null;
		}, 4e3);
	};
	const schemas = usePropertySchemas();
	let t5;
	if ($[4] !== runtime) {
		t5 = runtime.read(propertyEditorOverridesFacet);
		$[4] = runtime;
		$[5] = t5;
	} else t5 = $[5];
	const uis = t5;
	let t6;
	if ($[6] !== runtime) {
		t6 = runtime.read(valuePresetsFacet);
		$[6] = runtime;
		$[7] = t6;
	} else t6 = $[7];
	const presets = t6;
	let t7;
	if ($[8] !== runtime) {
		t7 = runtime.read(typesFacet);
		$[8] = runtime;
		$[9] = t7;
	} else t7 = $[9];
	const typesRegistry = t7;
	const properties = blockData?.properties ?? EMPTY_PROPERTIES;
	const readOnly = block.repo.isReadOnly;
	let t8;
	if ($[10] !== block.id || $[11] !== properties || $[12] !== schemas || $[13] !== syntheticProperties) {
		let t9;
		if ($[15] !== block.id || $[16] !== properties || $[17] !== schemas) {
			t9 = (ref) => ref.blockId === block.id && !Object.hasOwn(properties, ref.name) && schemas.has(ref.name);
			$[15] = block.id;
			$[16] = properties;
			$[17] = schemas;
			$[18] = t9;
		} else t9 = $[18];
		t8 = syntheticProperties.filter(t9).map(_temp2);
		$[10] = block.id;
		$[11] = properties;
		$[12] = schemas;
		$[13] = syntheticProperties;
		$[14] = t8;
	} else t8 = $[14];
	const syntheticRows = t8;
	let t9;
	if ($[19] !== blockData || $[20] !== presets || $[21] !== properties || $[22] !== schemas || $[23] !== syntheticRows || $[24] !== typesRegistry || $[25] !== uis || $[26] !== updatedByUser) {
		t9 = blockData ? buildPropertyPanelModel({
			blockId: blockData.id,
			updatedAt: blockData.userUpdatedAt,
			updatedBy: updatedByUser.name,
			updatedByBlockId: updatedByUser.blockId,
			properties,
			schemas,
			uis,
			presets,
			typesRegistry,
			syntheticRows
		}) : null;
		$[19] = blockData;
		$[20] = presets;
		$[21] = properties;
		$[22] = schemas;
		$[23] = syntheticRows;
		$[24] = typesRegistry;
		$[25] = uis;
		$[26] = updatedByUser;
		$[27] = t9;
	} else t9 = $[27];
	const model = t9;
	if (!blockData || !model) return null;
	let t10;
	if ($[28] !== renderScopeId || $[29] !== uiStateBlock) {
		t10 = async (target, selection) => {
			await uiStateBlock.set(editorSelection, {
				blockId: target.id,
				...selection
			});
			await focusBlock(uiStateBlock, target.id, {
				edit: true,
				...typeof renderScopeId === "string" ? { renderScopeId } : {}
			});
			requestEditorFocus(uiStateBlock);
		};
		$[28] = renderScopeId;
		$[29] = uiStateBlock;
		$[30] = t10;
	} else t10 = $[30];
	const focusBlockEditor = t10;
	let t11;
	if ($[31] !== block || $[32] !== focusBlockEditor) {
		t11 = async () => {
			await focusBlockEditor(block, { start: (block.peek() ?? await block.load())?.content.length ?? 0 });
		};
		$[31] = block;
		$[32] = focusBlockEditor;
		$[33] = t11;
	} else t11 = $[33];
	const focusThisBlockContentEnd = t11;
	let t12;
	if ($[34] !== block || $[35] !== focusBlockEditor || $[36] !== isNestedSurface || $[37] !== scopeRootId) {
		t12 = async () => {
			if (!scopeRootId) return;
			const next = await nextVisibleBlock(block, scopeRootId, !isNestedSurface);
			if (!next) return;
			await next.load();
			await focusBlockEditor(next, { start: 0 });
		};
		$[34] = block;
		$[35] = focusBlockEditor;
		$[36] = isNestedSurface;
		$[37] = scopeRootId;
		$[38] = t12;
	} else t12 = $[38];
	const focusAfterProperties = t12;
	let t13;
	if ($[39] !== block.id || $[40] !== focusAfterProperties || $[41] !== focusThisBlockContentEnd) {
		t13 = (event, direction) => {
			if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
			event.preventDefault();
			event.stopPropagation();
			const row = event.currentTarget;
			if (focusAdjacentPropertyRow(block.id, row, direction)) return;
			if (direction < 0) focusThisBlockContentEnd();
			else focusAfterProperties();
		};
		$[39] = block.id;
		$[40] = focusAfterProperties;
		$[41] = focusThisBlockContentEnd;
		$[42] = t13;
	} else t13 = $[42];
	const handlePropertyRowKeyDown = t13;
	let t14;
	if ($[43] !== navigate || $[44] !== panelId) {
		t14 = (schemaBlockId) => {
			navigate({
				blockId: schemaBlockId,
				target: "new-panel",
				sourcePanelId: panelId
			});
		};
		$[43] = navigate;
		$[44] = panelId;
		$[45] = t14;
	} else t14 = $[45];
	const openSchemaPanel = t14;
	const handleConfigure = async (row_0) => {
		const existingId = block.repo.userSchemas.getSchemaBlockId(row_0.name);
		if (existingId) {
			openSchemaPanel(existingId);
			return;
		}
		if (row_0.schemaUnknown) {
			try {
				await block.repo.userSchemas.addSchema({
					name: row_0.name,
					presetId: row_0.shape
				});
				const newId = block.repo.userSchemas.getSchemaBlockId(row_0.name);
				if (newId) {
					flashRecent(row_0.name);
					openSchemaPanel(newId);
				}
			} catch (t15) {
				const err = t15;
				console.error(`[BlockProperties] failed to register schema for "${row_0.name}":`, err);
			}
			return;
		}
	};
	const renderPropertyRow = (sectionId, row_1) => {
		return /* @__PURE__ */ jsx(PropertyRow, {
			row: row_1,
			block,
			readOnly,
			canConfigure: row_1.schemaUnknown || block.repo.userSchemas.getSchemaBlockId(row_1.name) !== void 0,
			recentlyMaterialized: recentlyMaterializedName === row_1.name,
			onNavigate: handlePropertyRowKeyDown,
			onConfigure: () => void handleConfigure(row_1),
			onChange: (next_0) => {
				writeProperty(block, row_1.schema, next_0).then(() => {
					setSyntheticProperties((refs) => refs.filter((ref_1) => ref_1.blockId !== block.id || ref_1.name !== row_1.name));
				});
			},
			onRename: (newName) => void renameProperty({
				block,
				properties,
				schemas,
				uis,
				oldName: row_1.name,
				newName
			}),
			onDelete: () => void deleteProperty({
				block,
				properties,
				schemas,
				uis,
				name: row_1.name
			})
		}, `${sectionId}:${row_1.name}`);
	};
	const t16 = `tm-property-fields mt-1.5 max-w-[46rem] space-y-0.5 pb-1 pl-1 ${childIds.length ? "mb-1" : ""}`;
	const t17 = model.pinnedRows.length > 0 && /* @__PURE__ */ jsx("div", {
		className: "space-y-0.5",
		children: model.pinnedRows.map((row_2) => renderPropertyRow("pinned", row_2))
	});
	const t18 = showHiddenFields && /* @__PURE__ */ jsxs("div", {
		className: "space-y-0.5",
		children: [
			/* @__PURE__ */ jsx(PropertySectionLabel, { section: model.hiddenSection }),
			model.metadataRows.map(_temp3),
			model.hiddenSection.rows.map((row_4) => renderPropertyRow(model.hiddenSection.id, row_4))
		]
	});
	const t19 = model.sections.map((section) => /* @__PURE__ */ jsxs("div", {
		className: "space-y-0.5",
		title: section.description,
		children: [model.showSectionLabels && /* @__PURE__ */ jsx(PropertySectionLabel, { section }), section.rows.map((row_5) => renderPropertyRow(section.id, row_5))]
	}, section.id));
	let t20;
	if ($[46] !== block || $[47] !== flashRecent || $[48] !== openSchemaPanel || $[49] !== readOnly || $[50] !== schemas || $[51] !== uis) {
		t20 = !readOnly && /* @__PURE__ */ jsx(AddPropertyForm, {
			block,
			onAdd: async (args) => {
				const schema = await addProperty(block, schemas, uis, args);
				if (!schema) return;
				setSyntheticProperties((refs_0) => refs_0.some((ref_2) => ref_2.blockId === block.id && ref_2.name === schema.name) ? refs_0 : [...refs_0, {
					blockId: block.id,
					name: schema.name
				}]);
			},
			onConfigureNewSchema: async (t21) => {
				const { name: name_0, presetId } = t21;
				const trimmed = name_0.trim();
				if (!trimmed) return;
				const existingId_0 = block.repo.userSchemas.getSchemaBlockId(trimmed);
				if (existingId_0) {
					openSchemaPanel(existingId_0);
					return schemas.get(trimmed);
				}
				const kernelSchema = schemas.get(trimmed);
				if (kernelSchema) return kernelSchema;
				try {
					const schema_0 = await block.repo.userSchemas.addSchema({
						name: trimmed,
						presetId
					});
					const newId_0 = block.repo.userSchemas.getSchemaBlockId(trimmed);
					if (newId_0) {
						flashRecent(trimmed);
						openSchemaPanel(newId_0);
					}
					return schema_0;
				} catch (t22) {
					const err_0 = t22;
					console.error(`[BlockProperties] failed to register schema for "${trimmed}":`, err_0);
					return;
				}
			}
		}, block.id);
		$[46] = block;
		$[47] = flashRecent;
		$[48] = openSchemaPanel;
		$[49] = readOnly;
		$[50] = schemas;
		$[51] = uis;
		$[52] = t20;
	} else t20 = $[52];
	let t21;
	let t22;
	if ($[53] !== showHiddenFields) {
		t21 = () => setShowHiddenFields(!showHiddenFields);
		t22 = showHiddenFields ? /* @__PURE__ */ jsx(EyeOff, { className: "h-3.5 w-3.5" }) : /* @__PURE__ */ jsx(Eye, { className: "h-3.5 w-3.5" });
		$[53] = showHiddenFields;
		$[54] = t21;
		$[55] = t22;
	} else {
		t21 = $[54];
		t22 = $[55];
	}
	const t23 = showHiddenFields ? "Hide hidden fields" : `Show hidden fields (${model.hiddenCount})`;
	let t24;
	if ($[56] !== t21 || $[57] !== t22 || $[58] !== t23) {
		t24 = /* @__PURE__ */ jsxs(Button, {
			variant: "ghost",
			size: "sm",
			type: "button",
			className: "ml-5 h-7 w-fit gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground",
			onClick: t21,
			children: [t22, t23]
		});
		$[56] = t21;
		$[57] = t22;
		$[58] = t23;
		$[59] = t24;
	} else t24 = $[59];
	let t25;
	if ($[60] !== t16 || $[61] !== t17 || $[62] !== t18 || $[63] !== t19 || $[64] !== t20 || $[65] !== t24) {
		t25 = /* @__PURE__ */ jsxs("div", {
			className: t16,
			children: [
				t17,
				t18,
				t19,
				t20,
				t24
			]
		});
		$[60] = t16;
		$[61] = t17;
		$[62] = t18;
		$[63] = t19;
		$[64] = t20;
		$[65] = t24;
		$[66] = t25;
	} else t25 = $[66];
	return t25;
}
function _temp3(row_3) {
	return /* @__PURE__ */ jsx(MetadataRow, { row: row_3 }, row_3.label);
}
function _temp2(ref_0) {
	return {
		name: ref_0.name,
		encodedValue: void 0,
		isSet: false
	};
}
function _temp(data) {
	return data ? {
		id: data.id,
		content: data.content,
		properties: data.properties,
		userUpdatedAt: data.userUpdatedAt,
		updatedBy: data.updatedBy
	} : void 0;
}
//#endregion
export { BlockProperties };

//# sourceMappingURL=BlockProperties.js.map