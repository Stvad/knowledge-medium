import { ChangeScope } from "../../data/api/changeScope.js";
import "../../data/api/index.js";
import { presetConfigProp, presetIdProp, propertyNameProp } from "../../data/properties.js";
import { valuePresetsFacet } from "../../data/facets.js";
import { Input } from "../ui/input.js";
import { Button } from "../ui/button.js";
import { useHandle } from "../../hooks/block.js";
import { useAppRuntime } from "../../extensions/runtimeContext.js";
import { ChevronDown } from "../../../node_modules/lucide-react/dist/esm/icons/chevron-down.js";
import { PropertyShapeGlyph } from "../propertyPanel/shapeUi.js";
import { selectablePresets } from "../propertyEditors/selectablePresets.js";
import { DefaultBlockRenderer } from "./DefaultBlockRenderer.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Fragment as Fragment$1, jsx, jsxs } from "react/jsx-runtime";
//#region src/components/renderer/PropertySchemaBlockRenderer.tsx
/** Renderer for `'property-schema'` blocks. Wraps the default block
*  layout (so the block keeps normal indentation, children, focus,
*  drag, hover, etc.) and only replaces the content area with a
*  schema editor — name input, preset picker, dispatched
*  `preset.ConfigEditor`, and a delete button. See
*  user-defined-properties.md §4a. */
var renderConfigEditor = (preset, value, onChange) => {
	if (!preset.ConfigEditor) return null;
	const ConfigEditor = preset.ConfigEditor;
	return /* @__PURE__ */ jsx(ConfigEditor, {
		value,
		onChange
	});
};
var PropertySchemaContentRenderer = ({ block }) => {
	const data = useHandle(block, { selector: (d) => d ? {
		id: d.id,
		workspaceId: d.workspaceId,
		properties: d.properties
	} : void 0 });
	const presets = useAppRuntime().read(valuePresetsFacet);
	const readOnly = block.repo.isReadOnly;
	const presetId = useMemo(() => {
		if (!data) return "";
		const raw = data.properties[presetIdProp.name];
		return raw === void 0 ? presetIdProp.defaultValue : presetIdProp.codec.decode(raw);
	}, [data]);
	const propertyName = useMemo(() => {
		if (!data) return "";
		const raw_0 = data.properties[propertyNameProp.name];
		return raw_0 === void 0 ? propertyNameProp.defaultValue : propertyNameProp.codec.decode(raw_0);
	}, [data]);
	const persistedConfig = useMemo(() => {
		if (!data) return {};
		const raw_1 = data.properties[presetConfigProp.name];
		return raw_1 === void 0 ? presetConfigProp.defaultValue : presetConfigProp.codec.decode(raw_1);
	}, [data]);
	const preset = presets.get(presetId) ?? null;
	const decodedConfig = useMemo(() => {
		if (!preset?.configCodec) return void 0;
		try {
			return preset.configCodec.decode(persistedConfig);
		} catch {
			return preset.defaultConfig;
		}
	}, [persistedConfig, preset]);
	const [draftName, setDraftName] = useState(propertyName);
	const [committedName, setCommittedName] = useState(propertyName);
	if (propertyName !== committedName) {
		setCommittedName(propertyName);
		setDraftName(propertyName);
	}
	const writeName = useCallback(async (next) => {
		if (next === propertyName) return;
		await block.set(propertyNameProp, next);
	}, [block, propertyName]);
	const writePresetId = useCallback(async (next_0) => {
		if (next_0 === presetId) return;
		const target = presets.get(next_0);
		if (!target) return;
		await block.repo.tx(async (tx) => {
			await tx.update(block.id, { properties: {
				...data.properties,
				[presetIdProp.name]: presetIdProp.codec.encode(next_0),
				[presetConfigProp.name]: presetConfigProp.codec.encode(target.configCodec ? target.configCodec.encode(target.defaultConfig) : {})
			} });
		}, {
			scope: ChangeScope.BlockDefault,
			description: `change preset to ${next_0}`
		});
	}, [
		block,
		data,
		presetId,
		presets
	]);
	const writeConfig = useCallback(async (next_1) => {
		if (!preset?.configCodec) return;
		let encoded;
		try {
			encoded = preset.configCodec.encode(next_1);
		} catch (err) {
			console.warn(`[PropertySchemaContentRenderer] cannot encode config:`, err);
			return;
		}
		await block.set(presetConfigProp, encoded);
	}, [block, preset]);
	const [pendingDelete, setPendingDelete] = useState(null);
	const [scanningUsers, setScanningUsers] = useState(false);
	const cancelTimerRef = useRef(null);
	useEffect(() => () => {
		if (cancelTimerRef.current !== null) clearTimeout(cancelTimerRef.current);
	}, []);
	const performDelete = useCallback(async () => {
		await block.repo.mutate.delete({ id: block.id });
	}, [block]);
	const handleDeleteClick = useCallback(async () => {
		if (pendingDelete) {
			setPendingDelete(null);
			await performDelete();
			return;
		}
		if (!propertyName.trim()) {
			await performDelete();
			return;
		}
		setScanningUsers(true);
		try {
			const userCount = await block.repo.countBlocksUsingProperty(propertyName, data?.workspaceId);
			if (userCount === 0) {
				await performDelete();
				return;
			}
			setPendingDelete({ userCount });
			if (cancelTimerRef.current !== null) clearTimeout(cancelTimerRef.current);
			cancelTimerRef.current = setTimeout(() => setPendingDelete(null), 6e3);
		} finally {
			setScanningUsers(false);
		}
	}, [
		block,
		data,
		pendingDelete,
		performDelete,
		propertyName
	]);
	if (!data) return null;
	const presetEntries = selectablePresets(presets, presetId);
	return /* @__PURE__ */ jsxs("div", {
		className: "w-full space-y-2 py-1",
		children: [
			/* @__PURE__ */ jsxs("div", {
				className: "flex items-center gap-2",
				children: [/* @__PURE__ */ jsx(PropertyShapeGlyph, {
					shape: presetId,
					Glyph: preset?.Glyph,
					className: preset ? "text-fuchsia-500" : "text-muted-foreground"
				}), /* @__PURE__ */ jsx(Input, {
					value: draftName,
					placeholder: "property name",
					readOnly,
					onChange: (e) => setDraftName(e.target.value),
					onBlur: () => {
						writeName(draftName.trim());
					},
					onKeyDown: (e_0) => {
						if (e_0.key === "Enter") {
							e_0.preventDefault();
							e_0.target.blur();
						}
					},
					className: "h-8 max-w-md text-base font-semibold"
				})]
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "grid grid-cols-[6rem,minmax(0,1fr)] items-center gap-3",
				children: [/* @__PURE__ */ jsx("label", {
					className: "text-xs font-semibold text-muted-foreground",
					children: "Type"
				}), /* @__PURE__ */ jsxs("div", {
					className: "relative max-w-xs",
					children: [/* @__PURE__ */ jsxs("select", {
						className: "h-9 w-full appearance-none rounded-md border border-input bg-background px-2 pr-9 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60",
						value: presetId,
						disabled: readOnly,
						onChange: (e_1) => {
							writePresetId(e_1.target.value);
						},
						children: [presetEntries.map((p) => /* @__PURE__ */ jsx("option", {
							value: p.id,
							children: p.label
						}, p.id)), !preset && presetId !== "" && /* @__PURE__ */ jsxs("option", {
							value: presetId,
							children: [presetId, " (unknown)"]
						})]
					}), /* @__PURE__ */ jsx(ChevronDown, { className: `pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 ${readOnly ? "text-muted-foreground/45" : "text-foreground/70"}` })]
				})]
			}),
			preset?.ConfigEditor && /* @__PURE__ */ jsxs("div", {
				className: "grid grid-cols-[6rem,minmax(0,1fr)] gap-3",
				children: [/* @__PURE__ */ jsx("label", {
					className: "pt-1 text-xs font-semibold text-muted-foreground",
					children: "Config"
				}), /* @__PURE__ */ jsx("div", { children: renderConfigEditor(preset, decodedConfig, writeConfig) })]
			}),
			!preset && presetId !== "" && /* @__PURE__ */ jsxs("div", {
				className: "text-xs text-muted-foreground",
				children: [
					"The plugin contributing preset ",
					/* @__PURE__ */ jsx("code", {
						className: "font-mono",
						children: presetId
					}),
					" is not loaded. Schemas using this preset stay registered when the plugin loads."
				]
			}),
			!readOnly && /* @__PURE__ */ jsxs("div", {
				className: "flex flex-wrap items-center gap-2",
				children: [/* @__PURE__ */ jsx(Button, {
					type: "button",
					variant: "ghost",
					size: "sm",
					disabled: scanningUsers,
					className: "h-7 text-xs text-destructive hover:text-destructive",
					onClick: () => {
						handleDeleteClick();
					},
					children: pendingDelete ? `Really delete? (${pendingDelete.userCount} ${pendingDelete.userCount === 1 ? "block uses" : "blocks use"} this)` : scanningUsers ? "Checking…" : "Delete schema"
				}), pendingDelete && /* @__PURE__ */ jsxs(Fragment$1, { children: [/* @__PURE__ */ jsx(Button, {
					type: "button",
					variant: "ghost",
					size: "sm",
					className: "h-7 text-xs",
					onClick: () => setPendingDelete(null),
					children: "Cancel"
				}), /* @__PURE__ */ jsx("span", {
					className: "text-xs text-muted-foreground",
					children: "Their values stay; the editor falls back to an inferred type."
				})] })]
			})
		]
	});
};
PropertySchemaContentRenderer.displayName = "PropertySchemaContentRenderer";
/** Outer wrapper: keeps the default block layout (children,
*  indentation, drag handle, focus chrome) and swaps in the
*  schema-editing content renderer. */
var PropertySchemaBlockRenderer = Object.assign((props) => /* @__PURE__ */ jsx(DefaultBlockRenderer, {
	...props,
	ContentRenderer: PropertySchemaContentRenderer,
	EditContentRenderer: PropertySchemaContentRenderer
}), {
	canRender: ({ block }) => {
		const data = block.peek();
		if (!data) return false;
		const types = data.properties.types;
		return Array.isArray(types) && types.includes("property-schema");
	},
	priority: () => 100
});
PropertySchemaBlockRenderer.displayName = "PropertySchemaBlockRenderer";
//#endregion
export { PropertySchemaBlockRenderer };

//# sourceMappingURL=PropertySchemaBlockRenderer.js.map