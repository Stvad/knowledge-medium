import { createContext, useContext } from "react";
//#region src/extensions/runtimeContext.ts
var AppRuntimeContext = createContext(void 0);
var AppRuntimeContextProvider = AppRuntimeContext;
function useAppRuntime() {
	const runtime = useContext(AppRuntimeContext);
	if (!runtime) throw new Error("useAppRuntime must be used within an AppRuntimeProvider");
	return runtime;
}
//#endregion
export { AppRuntimeContextProvider, useAppRuntime };

//# sourceMappingURL=runtimeContext.js.map