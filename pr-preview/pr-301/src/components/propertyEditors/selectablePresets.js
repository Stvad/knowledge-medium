//#region src/components/propertyEditors/selectablePresets.ts
var selectablePresets = (presets, keepId) => Array.from(presets.values()).filter((preset) => !preset.hideFromPicker || preset.id === keepId).sort((a, b) => a.label.localeCompare(b.label));
//#endregion
export { selectablePresets };

//# sourceMappingURL=selectablePresets.js.map