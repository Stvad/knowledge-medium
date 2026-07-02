//#region src/facets/runtimeEvents.ts
var appRuntimeUpdateEvent = "app-runtime-update";
var refreshAppRuntime = () => {
	window.dispatchEvent(new CustomEvent(appRuntimeUpdateEvent, { detail: (/* @__PURE__ */ new Date()).toISOString() }));
};
//#endregion
export { appRuntimeUpdateEvent, refreshAppRuntime };

//# sourceMappingURL=runtimeEvents.js.map