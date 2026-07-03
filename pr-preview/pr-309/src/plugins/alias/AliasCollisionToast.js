import { MergeIntoDescendantError } from "../../data/api/errors.js";
import "../../data/api/index.js";
import { Button } from "../../components/ui/button.js";
import { ALIAS_COLLISION_MERGE_MUTATOR } from "./collisionMerge.js";
import { getLayoutSessionBlock, getUIStateBlock } from "../../data/stateBlocks.js";
import { truncate } from "../../utils/string.js";
import { dismissToast, showError } from "../../utils/toast.js";
import { getLayoutSessionId } from "../../utils/layoutSessionId.js";
import { retargetPanelBlockIds } from "../../utils/panelLayoutProjection.js";
import { navigate } from "../../utils/navigation.js";
import { useState } from "react";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/alias/AliasCollisionToast.tsx
/**
* Custom toast body for `alias.collision` rejections. Two affordances:
*   - "Open" navigates to the existing block (same as the legacy
*     single-button toast) so the user can review what's there before
*     deciding whether to merge.
*   - "Merge into …" folds the rejected source into the existing block
*     via the alias-collision merge mutator. Source is soft-deleted,
*     target content is kept, and rename-origin metadata decides which
*     source alias should be rewritten to the colliding alias.
*
* The merge is one-click — no confirmation step — because (a) the user
* explicitly picked "Merge" knowing what it does, (b) `repo.undo()`
* (and Cmd-Z) revert the whole tx if they change their mind. Mirrors
* `RescheduleToast`'s direct-action-with-Undo philosophy.
*/
var AliasCollisionToast = (t0) => {
	const $ = c(35);
	const { toastId, message, alias, attemptedOn, conflictingBlockId, conflictingBlockTitle, workspaceId, dropSourceAliases, offerMerge, repo } = t0;
	const [pending, setPending] = useState(false);
	const [mergeBlocked, setMergeBlocked] = useState(false);
	let t1;
	if ($[0] !== conflictingBlockId || $[1] !== repo || $[2] !== toastId || $[3] !== workspaceId) {
		t1 = () => {
			navigate(repo, {
				target: "main",
				blockId: conflictingBlockId,
				workspaceId
			});
			dismissToast(toastId);
		};
		$[0] = conflictingBlockId;
		$[1] = repo;
		$[2] = toastId;
		$[3] = workspaceId;
		$[4] = t1;
	} else t1 = $[4];
	const openExisting = t1;
	let t2;
	if ($[5] !== alias || $[6] !== attemptedOn || $[7] !== conflictingBlockId || $[8] !== conflictingBlockTitle || $[9] !== dropSourceAliases || $[10] !== pending || $[11] !== repo || $[12] !== toastId || $[13] !== workspaceId) {
		t2 = async () => {
			if (pending) return;
			setPending(true);
			try {
				await repo.run(ALIAS_COLLISION_MERGE_MUTATOR, {
					intoId: conflictingBlockId,
					fromId: attemptedOn,
					collisionAlias: alias,
					dropSourceAliases
				});
				const layoutSessionBlock = await getLayoutSessionBlock(await getUIStateBlock(repo, workspaceId, repo.user, {}), getLayoutSessionId());
				try {
					await retargetPanelBlockIds(repo, layoutSessionBlock, attemptedOn, conflictingBlockId);
				} catch (t4) {
					console.error("[AliasCollisionToast] Failed to retarget panels after merge", t4);
					showError("Merge completed, but panel update failed");
				}
				dismissToast(toastId);
			} catch (t3) {
				const error = t3;
				if (error instanceof MergeIntoDescendantError) {
					setMergeBlocked(true);
					setPending(false);
					showError(`Can't merge into "${truncate(conflictingBlockTitle.trim() === "" ? alias : conflictingBlockTitle.trim(), 30)}" — it's nested inside the page you're renaming. Open it to move the content manually.`);
					return;
				}
				showError(error instanceof Error ? error.message : "Merge failed");
				setPending(false);
			}
		};
		$[5] = alias;
		$[6] = attemptedOn;
		$[7] = conflictingBlockId;
		$[8] = conflictingBlockTitle;
		$[9] = dropSourceAliases;
		$[10] = pending;
		$[11] = repo;
		$[12] = toastId;
		$[13] = workspaceId;
		$[14] = t2;
	} else t2 = $[14];
	const mergeIntoExisting = t2;
	let t3;
	if ($[15] !== alias || $[16] !== conflictingBlockTitle) {
		t3 = conflictingBlockTitle.trim() === "" ? `Merge into "${alias}"` : `Merge into "${truncate(conflictingBlockTitle, 30)}"`;
		$[15] = alias;
		$[16] = conflictingBlockTitle;
		$[17] = t3;
	} else t3 = $[17];
	const mergeLabel = t3;
	let t4;
	if ($[18] !== message) {
		t4 = /* @__PURE__ */ jsx("span", {
			className: "text-foreground",
			children: message
		});
		$[18] = message;
		$[19] = t4;
	} else t4 = $[19];
	let t5;
	if ($[20] !== openExisting || $[21] !== pending) {
		t5 = /* @__PURE__ */ jsx(Button, {
			variant: "ghost",
			size: "sm",
			disabled: pending,
			onClick: openExisting,
			children: "Open"
		});
		$[20] = openExisting;
		$[21] = pending;
		$[22] = t5;
	} else t5 = $[22];
	let t6;
	if ($[23] !== mergeBlocked || $[24] !== mergeIntoExisting || $[25] !== mergeLabel || $[26] !== offerMerge || $[27] !== pending) {
		t6 = offerMerge && !mergeBlocked && /* @__PURE__ */ jsx(Button, {
			variant: "default",
			size: "sm",
			disabled: pending,
			onClick: () => {
				mergeIntoExisting();
			},
			children: pending ? "Merging…" : mergeLabel
		});
		$[23] = mergeBlocked;
		$[24] = mergeIntoExisting;
		$[25] = mergeLabel;
		$[26] = offerMerge;
		$[27] = pending;
		$[28] = t6;
	} else t6 = $[28];
	let t7;
	if ($[29] !== t5 || $[30] !== t6) {
		t7 = /* @__PURE__ */ jsxs("div", {
			className: "flex justify-end gap-2",
			children: [t5, t6]
		});
		$[29] = t5;
		$[30] = t6;
		$[31] = t7;
	} else t7 = $[31];
	let t8;
	if ($[32] !== t4 || $[33] !== t7) {
		t8 = /* @__PURE__ */ jsxs("div", {
			className: "flex w-full min-w-[280px] flex-col gap-2 rounded-md border border-destructive/40 bg-background px-4 py-3 text-sm shadow-lg",
			children: [t4, t7]
		});
		$[32] = t4;
		$[33] = t7;
		$[34] = t8;
	} else t8 = $[34];
	return t8;
};
//#endregion
export { AliasCollisionToast };

//# sourceMappingURL=AliasCollisionToast.js.map