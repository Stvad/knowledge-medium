//#region src/shortcuts/pointerAction.ts
var dispatcher = null;
/** Installed by <HotkeyReconciler/> on mount; torn down on unmount so stray
*  callers fail soft (no pointer action) rather than against a stale runtime. */
var setPointerActionDispatcher = (next) => {
	dispatcher = next;
};
/** Module-level entry point so non-React callers (and the block shell) can
*  dispatch a pointer gesture without threading the runtime. No-op returning
*  false before the coordinator mounts. */
var dispatchPointerAction = (event, suppliedDeps) => dispatcher ? dispatcher(event, suppliedDeps) : false;
//#endregion
export { dispatchPointerAction, setPointerActionDispatcher };

//# sourceMappingURL=pointerAction.js.map