import { aliasesProp } from "../../data/properties.js";
import { Input } from "../../components/ui/input.js";
import { Button } from "../../components/ui/button.js";
import { truncate } from "../../utils/string.js";
import { dismissToast, showCustom } from "../../utils/toast.js";
import { addPlaceToExistingBlock, createOrFindPlace, placeMachineAlias } from "./createOrFindPlace.js";
import { useState } from "react";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/geo/placeNameCollision.tsx
/**
* Friendly-name collision UI for place creation.
*
* `createOrFindPlace` preflights the candidate's name and returns a
* `name-collision` instead of attempting a create the alias-uniqueness
* trigger would roll back. This module turns that result into a choice
* the user can actually act on:
*
*   - "Add location to …" — the common case: the name belongs to a
*     plain page (the existing-place autocomplete would have surfaced
*     a real place match before the user ever reached "create"). The
*     page is enriched in place via `addPlaceToExistingBlock`.
*   - "Create new" with an editable name — for when it IS a different
*     thing that happens to share the name. The field re-validates on
*     submit; a still-colliding name shows an inline error instead of
*     creating anything.
*
* When the claimant is itself a Place (same name, different physical
* location), enriching would overwrite its coords, so only the
* rename-and-create path is offered.
*
* `createOrFindPlaceInteractive` is the entry point callers want: the
* happy path is a plain create/find, the collision path resolves via
* the toast, and `null` means the user cancelled.
*/
/** Best link-name for a block: first human alias, else content, else
*  the caller's fallback. Mirrors the autocomplete's display logic. */
var linkNameOf = (block, fallback) => {
	const data = block.peek();
	if (!data) return fallback;
	const raw = data.properties[aliasesProp.name];
	return (Array.isArray(raw) ? raw.filter((v) => typeof v === "string") : []).find((a) => !a.startsWith("place:") && !a.startsWith("geo:")) ?? (data.content || fallback);
};
var PlaceNameCollisionToast = (t0) => {
	const $ = c(54);
	const { repo, workspaceId, candidate, collision, onSettle } = t0;
	const [name, setName] = useState(collision.name);
	const [error, setError] = useState(null);
	const [pending, setPending] = useState(false);
	const existingLabel = collision.existing.content.trim() === "" ? collision.name : collision.existing.content;
	let t1;
	if ($[0] !== candidate || $[1] !== collision.existing.id || $[2] !== collision.name || $[3] !== onSettle || $[4] !== pending || $[5] !== repo) {
		t1 = async () => {
			if (pending) return;
			setPending(true);
			try {
				onSettle({
					block: await addPlaceToExistingBlock(repo, collision.existing.id, candidate),
					linkName: collision.name
				});
			} catch (t2) {
				const err = t2;
				setError(err instanceof Error ? err.message : "Could not add the location");
				setPending(false);
			}
		};
		$[0] = candidate;
		$[1] = collision.existing.id;
		$[2] = collision.name;
		$[3] = onSettle;
		$[4] = pending;
		$[5] = repo;
		$[6] = t1;
	} else t1 = $[6];
	const addToExisting = t1;
	let t2;
	if ($[7] !== candidate || $[8] !== name || $[9] !== onSettle || $[10] !== pending || $[11] !== repo || $[12] !== workspaceId) {
		t2 = async () => {
			if (pending) return;
			const trimmed = name.trim();
			if (trimmed === "") {
				setError("Enter a name for the new place.");
				return;
			}
			setPending(true);
			try {
				const result = await createOrFindPlace(repo, workspaceId, {
					...candidate,
					name: trimmed
				});
				if (result.kind === "name-collision") {
					setError(`"${trimmed}" is taken too — try another name.`);
					setPending(false);
					return;
				}
				onSettle({
					block: result.block,
					linkName: linkNameOf(result.block, trimmed)
				});
			} catch (t3) {
				const err_0 = t3;
				setError(err_0 instanceof Error ? err_0.message : "Could not create the place");
				setPending(false);
			}
		};
		$[7] = candidate;
		$[8] = name;
		$[9] = onSettle;
		$[10] = pending;
		$[11] = repo;
		$[12] = workspaceId;
		$[13] = t2;
	} else t2 = $[13];
	const createWithName = t2;
	let t3;
	if ($[14] !== collision.existing.isPlace || $[15] !== collision.name) {
		t3 = collision.existing.isPlace ? `A different place is already named "${truncate(collision.name, 40)}". Pick another name for this one.` : `"${truncate(collision.name, 40)}" is already the name of another page.`;
		$[14] = collision.existing.isPlace;
		$[15] = collision.name;
		$[16] = t3;
	} else t3 = $[16];
	const message = t3;
	let t4;
	if ($[17] !== message) {
		t4 = /* @__PURE__ */ jsx("span", {
			className: "text-foreground",
			children: message
		});
		$[17] = message;
		$[18] = t4;
	} else t4 = $[18];
	let t5;
	if ($[19] !== error) {
		t5 = error !== null && /* @__PURE__ */ jsx("span", {
			className: "text-destructive",
			children: error
		});
		$[19] = error;
		$[20] = t5;
	} else t5 = $[20];
	let t6;
	if ($[21] !== addToExisting || $[22] !== collision.existing.isPlace || $[23] !== existingLabel || $[24] !== pending) {
		t6 = !collision.existing.isPlace && /* @__PURE__ */ jsx(Button, {
			variant: "default",
			size: "sm",
			disabled: pending,
			onClick: () => {
				addToExisting();
			},
			children: `Add location to "${truncate(existingLabel, 30)}"`
		});
		$[21] = addToExisting;
		$[22] = collision.existing.isPlace;
		$[23] = existingLabel;
		$[24] = pending;
		$[25] = t6;
	} else t6 = $[25];
	let t7;
	if ($[26] === Symbol.for("react.memo_cache_sentinel")) {
		t7 = (e) => {
			setName(e.target.value);
			setError(null);
		};
		$[26] = t7;
	} else t7 = $[26];
	let t8;
	if ($[27] !== createWithName) {
		t8 = (e_0) => {
			if (e_0.key === "Enter") createWithName();
		};
		$[27] = createWithName;
		$[28] = t8;
	} else t8 = $[28];
	let t9;
	if ($[29] !== name || $[30] !== pending || $[31] !== t8) {
		t9 = /* @__PURE__ */ jsx(Input, {
			value: name,
			disabled: pending,
			className: "h-8",
			"aria-label": "Name for the new place",
			onChange: t7,
			onKeyDown: t8
		});
		$[29] = name;
		$[30] = pending;
		$[31] = t8;
		$[32] = t9;
	} else t9 = $[32];
	const t10 = collision.existing.isPlace ? "default" : "secondary";
	let t11;
	if ($[33] !== createWithName) {
		t11 = () => {
			createWithName();
		};
		$[33] = createWithName;
		$[34] = t11;
	} else t11 = $[34];
	const t12 = pending ? "Working…" : "Create new";
	let t13;
	if ($[35] !== pending || $[36] !== t10 || $[37] !== t11 || $[38] !== t12) {
		t13 = /* @__PURE__ */ jsx(Button, {
			variant: t10,
			size: "sm",
			disabled: pending,
			onClick: t11,
			children: t12
		});
		$[35] = pending;
		$[36] = t10;
		$[37] = t11;
		$[38] = t12;
		$[39] = t13;
	} else t13 = $[39];
	let t14;
	if ($[40] !== t13 || $[41] !== t9) {
		t14 = /* @__PURE__ */ jsxs("div", {
			className: "flex items-center gap-2",
			children: [t9, t13]
		});
		$[40] = t13;
		$[41] = t9;
		$[42] = t14;
	} else t14 = $[42];
	let t15;
	if ($[43] !== onSettle) {
		t15 = () => onSettle(null);
		$[43] = onSettle;
		$[44] = t15;
	} else t15 = $[44];
	let t16;
	if ($[45] !== pending || $[46] !== t15) {
		t16 = /* @__PURE__ */ jsx("div", {
			className: "flex justify-end",
			children: /* @__PURE__ */ jsx(Button, {
				variant: "ghost",
				size: "sm",
				disabled: pending,
				onClick: t15,
				children: "Cancel"
			})
		});
		$[45] = pending;
		$[46] = t15;
		$[47] = t16;
	} else t16 = $[47];
	let t17;
	if ($[48] !== t14 || $[49] !== t16 || $[50] !== t4 || $[51] !== t5 || $[52] !== t6) {
		t17 = /* @__PURE__ */ jsxs("div", {
			className: "flex w-full min-w-[300px] flex-col gap-2 rounded-md border border-border bg-background px-4 py-3 text-sm shadow-lg",
			children: [
				t4,
				t5,
				t6,
				t14,
				t16
			]
		});
		$[48] = t14;
		$[49] = t16;
		$[50] = t4;
		$[51] = t5;
		$[52] = t6;
		$[53] = t17;
	} else t17 = $[53];
	return t17;
};
/** Surface the collision toast and resolve with the user's choice —
*  the enriched/created block, or `null` on cancel. The toast stays
*  up until acted on (it's a decision, not a notification). */
var promptPlaceNameCollision = (repo, workspaceId, candidate, collision) => new Promise((resolve) => {
	let settled = false;
	const toastId = showCustom(() => /* @__PURE__ */ jsx(PlaceNameCollisionToast, {
		repo,
		workspaceId,
		candidate,
		collision,
		onSettle: (result) => {
			if (settled) return;
			settled = true;
			dismissToast(toastId);
			resolve(result);
		}
	}), { duration: Number.POSITIVE_INFINITY });
});
/** `createOrFindPlace` + collision resolution UI. Returns `null` when
*  the user dismissed the collision prompt without choosing. */
var createOrFindPlaceInteractive = async (repo, workspaceId, candidate) => {
	const result = await createOrFindPlace(repo, workspaceId, candidate);
	if (result.kind === "ok") {
		const fallback = candidate.name.trim() || placeMachineAlias(candidate);
		return {
			block: result.block,
			linkName: linkNameOf(result.block, fallback)
		};
	}
	return promptPlaceNameCollision(repo, workspaceId, candidate, result);
};
//#endregion
export { createOrFindPlaceInteractive, promptPlaceNameCollision };

//# sourceMappingURL=placeNameCollision.js.map