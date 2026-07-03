import { ChangeScope } from "../../data/api/changeScope.js";
import "../../data/api/index.js";
import { Button } from "../../components/ui/button.js";
import { dismissToast, showError } from "../../utils/toast.js";
import { useSyncExternalStore } from "react";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/srs-rescheduling/RescheduleToast.tsx
/** Predicate: clicking Undo right now would revert exactly this
*  reschedule. True only when the reschedule's workspace is active and
*  the reschedule is still that workspace's top BlockDefault entry —
*  mirroring what `repo.undo()` (per-workspace, issue #186) will do.
*  `repo.undoManager` resolves to the active workspace's manager, so the
*  active-workspace check gates which manager `peekUndo` reads. */
var wouldUndoThisReschedule = (repo, workspaceId, txId) => repo.activeWorkspaceId === workspaceId && repo.undoManager.peekUndo(ChangeScope.BlockDefault)?.txId === txId;
/** Custom toast body for SRS reschedule feedback. The Undo button
*  reactively disables itself once another `BlockDefault` tx lands on
*  top of the reschedule's workspace — at that point `repo.undo()` would
*  revert the wrong action, so the toast hands the user off to cmd-Z.
*  Invoked via `showRescheduleToast` in the SRS plugin entry. */
var RescheduleToast = (t0) => {
	const $ = c(21);
	const { toastId, message, txId, workspaceId, repo } = t0;
	let t1;
	if ($[0] !== repo.undoManager) {
		t1 = (cb) => repo.undoManager.subscribe(ChangeScope.BlockDefault, cb);
		$[0] = repo.undoManager;
		$[1] = t1;
	} else t1 = $[1];
	let t2;
	let t3;
	if ($[2] !== repo || $[3] !== txId || $[4] !== workspaceId) {
		t2 = () => wouldUndoThisReschedule(repo, workspaceId, txId);
		t3 = () => wouldUndoThisReschedule(repo, workspaceId, txId);
		$[2] = repo;
		$[3] = txId;
		$[4] = workspaceId;
		$[5] = t2;
		$[6] = t3;
	} else {
		t2 = $[5];
		t3 = $[6];
	}
	const isTopOfStack = useSyncExternalStore(t1, t2, t3);
	let t4;
	if ($[7] !== repo || $[8] !== toastId || $[9] !== txId || $[10] !== workspaceId) {
		t4 = () => {
			if (!wouldUndoThisReschedule(repo, workspaceId, txId)) {
				dismissToast(toastId);
				return;
			}
			repo.undo().catch(_temp);
			dismissToast(toastId);
		};
		$[7] = repo;
		$[8] = toastId;
		$[9] = txId;
		$[10] = workspaceId;
		$[11] = t4;
	} else t4 = $[11];
	const handleUndo = t4;
	let t5;
	if ($[12] !== message) {
		t5 = /* @__PURE__ */ jsx("span", {
			className: "flex-1",
			children: message
		});
		$[12] = message;
		$[13] = t5;
	} else t5 = $[13];
	const t6 = !isTopOfStack;
	const t7 = isTopOfStack ? "Undo this reschedule" : "Another action ran since — use cmd-Z to step back";
	let t8;
	if ($[14] !== handleUndo || $[15] !== t6 || $[16] !== t7) {
		t8 = /* @__PURE__ */ jsx(Button, {
			variant: "ghost",
			size: "sm",
			disabled: t6,
			onClick: handleUndo,
			title: t7,
			children: "Undo"
		});
		$[14] = handleUndo;
		$[15] = t6;
		$[16] = t7;
		$[17] = t8;
	} else t8 = $[17];
	let t9;
	if ($[18] !== t5 || $[19] !== t8) {
		t9 = /* @__PURE__ */ jsxs("div", {
			className: "flex w-full min-w-[260px] items-center gap-3 rounded-md border bg-background px-4 py-3 text-sm shadow-lg",
			children: [t5, t8]
		});
		$[18] = t5;
		$[19] = t8;
		$[20] = t9;
	} else t9 = $[20];
	return t9;
};
function _temp(err) {
	showError(err instanceof Error ? err.message : "Could not undo reschedule");
}
//#endregion
export { RescheduleToast };

//# sourceMappingURL=RescheduleToast.js.map