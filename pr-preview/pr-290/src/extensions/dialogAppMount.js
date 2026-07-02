import { appMountsFacet } from "./core.js";
import { getDialogQueue, subscribeDialogs } from "../utils/dialogs.js";
import { useSyncExternalStore } from "react";
import { c } from "react/compiler-runtime";
import { Fragment as Fragment$1, jsx } from "react/jsx-runtime";
//#region src/extensions/dialogAppMount.tsx
/**
* App-mount contribution that hosts dialogs opened via
* `utils/dialogs.openDialog`.
*
* Mounted once via `appMountsFacet`. Subscribes to the module-level
* dialog queue, renders each pending entry, and threads the host's
* finalize callback into the entry's `resolve` / `cancel` props.
*
* Same placement story as `toastAppMount`: dialogs surfaced before
* the runtime is up wouldn't render here — those callers should
* fall back to a built-in confirm / alert. Anything that runs from
* an action handler, post-commit processor, or user-initiated UI
* path happens after the runtime mounts and lands here cleanly.
*/
var DialogHost = () => {
	const $ = c(4);
	const queue = useSyncExternalStore(subscribeDialogs, getDialogQueue, getDialogQueue);
	let t0;
	if ($[0] !== queue) {
		t0 = queue.map(_temp);
		$[0] = queue;
		$[1] = t0;
	} else t0 = $[1];
	let t1;
	if ($[2] !== t0) {
		t1 = /* @__PURE__ */ jsx(Fragment$1, { children: t0 });
		$[2] = t0;
		$[3] = t1;
	} else t1 = $[3];
	return t1;
};
var dialogAppMountExtension = [appMountsFacet.of({
	id: "core.dialogs",
	component: DialogHost
}, { source: "core" })];
function _temp(entry) {
	const Component = entry.Component;
	return /* @__PURE__ */ jsx(Component, {
		...entry.props,
		resolve: (value) => entry.finalize(value),
		cancel: () => entry.finalize(null)
	}, entry.id);
}
//#endregion
export { DialogHost, dialogAppMountExtension };

//# sourceMappingURL=dialogAppMount.js.map