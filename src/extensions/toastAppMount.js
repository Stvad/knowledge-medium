import { systemToggle } from "../facets/togglable.js";
import { appMountsFacet } from "./core.js";
import { Toaster } from "../../node_modules/sonner/dist/index.js";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/extensions/toastAppMount.tsx
/**
* App-mount contribution that renders the sonner `<Toaster />`.
*
* Mounted once via `appMountsFacet` so toast surfaces (long-running
* import progress, alias-collision rejections, etc.) are themed
* consistently and the lib choice stays a single grep target.
*
* Placement note: app mounts render inside `AppRuntimeProvider`,
* which is itself inside the React tree once the user is signed in
* and the Repo has bootstrapped. Toasts surfaced during bootstrap
* (e.g. a Login failure) wouldn't render here — those go through
* `ErrorBoundary` / `BootstrapErrorFallback` in `main.tsx`. The
* trade is worth it: any toast that comes from a `repo.tx`
* processor rejection or a user-initiated action only fires after
* the runtime is up.
*/
var ToastAppMount = () => {
	const $ = c(1);
	let t0;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t0 = /* @__PURE__ */ jsx(Toaster, {
			position: "top-center",
			richColors: true,
			closeButton: true
		});
		$[0] = t0;
	} else t0 = $[0];
	return t0;
};
var toastAppMountExtension = systemToggle({
	id: "system:toast-mount",
	name: "Toasts",
	description: "Mount point for transient notifications. Disabling silently drops every toast.",
	essential: true
}).of([appMountsFacet.of({
	id: "core.toast",
	component: ToastAppMount
}, { source: "core" })]);
//#endregion
export { ToastAppMount, toastAppMountExtension };

//# sourceMappingURL=toastAppMount.js.map