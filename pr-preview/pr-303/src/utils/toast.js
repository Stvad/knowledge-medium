import { toast } from "../../node_modules/sonner/dist/index.js";
//#region src/utils/toast.ts
var buildAction = (action) => action ? {
	label: action.label,
	onClick: action.onClick
} : void 0;
var showError = (message, opts = {}) => toast.error(message, {
	duration: opts.duration ?? 6e3,
	action: buildAction(opts.action),
	cancel: buildAction(opts.cancel),
	id: opts.id
});
var showInfo = (message, opts = {}) => toast(message, {
	duration: opts.duration ?? 4e3,
	action: buildAction(opts.action),
	cancel: buildAction(opts.cancel),
	id: opts.id
});
var showSuccess = (message, opts = {}) => toast.success(message, {
	duration: opts.duration ?? 4e3,
	action: buildAction(opts.action),
	cancel: buildAction(opts.cancel),
	id: opts.id
});
/** Render a fully custom toast (JSX). Use when the toast needs internal
*  reactive state — e.g. a button whose enabled-state depends on a live
*  subscription — that the standard `action` shape can't express. The
*  render fn receives the sonner toast id so the JSX can dismiss itself
*  on user action. */
var showCustom = (render, opts = {}) => toast.custom(render, {
	duration: opts.duration ?? 4e3,
	...opts.id !== void 0 ? { id: opts.id } : {}
});
/** Start a progress toast. Returns a handle for incremental updates
*  and terminal resolution. Implemented on top of sonner's id-reuse
*  pattern: subsequent `toast.success` / `toast.error` calls with
*  the same id replace the loading toast in place. */
var showProgress = (initial) => {
	const id = toast.loading(initial, { duration: Number.POSITIVE_INFINITY });
	return {
		update: (message) => {
			toast.loading(message, {
				id,
				duration: Number.POSITIVE_INFINITY
			});
		},
		done: (finalMessage) => {
			if (finalMessage === void 0) {
				toast.dismiss(id);
				return;
			}
			toast.success(finalMessage, {
				id,
				duration: 2500
			});
		},
		fail: (message) => {
			toast.error(message, {
				id,
				duration: 6e3
			});
		}
	};
};
/** Dismiss a specific toast by id, or all toasts when `id` is
*  omitted. */
var dismissToast = (id) => {
	if (id === void 0) toast.dismiss();
	else toast.dismiss(id);
};
//#endregion
export { dismissToast, showCustom, showError, showInfo, showProgress, showSuccess };

//# sourceMappingURL=toast.js.map