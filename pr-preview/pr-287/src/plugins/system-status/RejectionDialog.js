import { usePowerSync } from "../../../node_modules/@powersync/react/lib/hooks/PowerSyncContext.js";
import { useQuery } from "../../../node_modules/@powersync/react/lib/hooks/watched/useQuery.js";
import "../../../node_modules/@powersync/react/lib/index.js";
import { Button } from "../../components/ui/button.js";
import { Copy } from "../../../node_modules/lucide-react/dist/esm/icons/copy.js";
import { Lock } from "../../../node_modules/lucide-react/dist/esm/icons/lock.js";
import { RotateCcw } from "../../../node_modules/lucide-react/dist/esm/icons/rotate-ccw.js";
import { Trash2 } from "../../../node_modules/lucide-react/dist/esm/icons/trash-2.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { extractBlockDetails, parseRejectionError, shortenId, summarizeOp } from "./rejectedHelpers.js";
import { useState } from "react";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/system-status/RejectionDialog.tsx
function RejectionDialog(t0) {
	const $ = c(36);
	const { open, onOpenChange } = t0;
	const db = usePowerSync();
	let t1;
	let t2;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = [];
		t2 = { reportFetching: false };
		$[0] = t1;
		$[1] = t2;
	} else {
		t1 = $[0];
		t2 = $[1];
	}
	const rows = useQuery("SELECT id, original_id, tx_id, data, error_code, error_message, rejected_at FROM ps_crud_rejected ORDER BY rejected_at DESC", t1, t2);
	let t3;
	let t4;
	if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
		t3 = [];
		t4 = { reportFetching: false };
		$[2] = t3;
		$[3] = t4;
	} else {
		t3 = $[2];
		t4 = $[3];
	}
	const workspaces = useQuery("SELECT id, name FROM workspaces", t3, t4);
	let t5;
	if ($[4] !== workspaces.data) {
		t5 = new Map(workspaces.data.map(_temp));
		$[4] = workspaces.data;
		$[5] = t5;
	} else t5 = $[5];
	const workspaceNameById = t5;
	let t6;
	if ($[6] !== workspaceNameById) {
		t6 = (workspaceId) => workspaceNameById.get(workspaceId) ?? shortenId(workspaceId);
		$[6] = workspaceNameById;
		$[7] = t6;
	} else t6 = $[7];
	const workspaceLabel = t6;
	const [copiedId, setCopiedId] = useState(null);
	let t7;
	if ($[8] !== db) {
		t7 = async (row) => {
			await db.writeTransaction(async (tx) => {
				await tx.execute("INSERT INTO ps_crud (tx_id, data) VALUES (?, ?)", [row.tx_id, row.data]);
				await tx.execute("DELETE FROM ps_crud_rejected WHERE id = ?", [row.id]);
			});
		};
		$[8] = db;
		$[9] = t7;
	} else t7 = $[9];
	const handleRetry = t7;
	let t8;
	if ($[10] !== db) {
		t8 = async (row_0) => {
			await db.execute("DELETE FROM ps_crud_rejected WHERE id = ?", [row_0.id]);
		};
		$[10] = db;
		$[11] = t8;
	} else t8 = $[11];
	const handleDismiss = t8;
	let t9;
	if ($[12] === Symbol.for("react.memo_cache_sentinel")) {
		t9 = async (row_1) => {
			const payload = {
				tx_id: row_1.tx_id,
				data: safeParseJson(row_1.data),
				error_code: row_1.error_code,
				error: safeParseJson(row_1.error_message ?? "") ?? row_1.error_message,
				rejected_at: new Date(row_1.rejected_at).toISOString()
			};
			await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
			setCopiedId(row_1.id);
			setTimeout(() => setCopiedId((current) => current === row_1.id ? null : current), 1500);
		};
		$[12] = t9;
	} else t9 = $[12];
	const handleCopy = t9;
	let t10;
	if ($[13] === Symbol.for("react.memo_cache_sentinel")) {
		t10 = /* @__PURE__ */ jsx(DialogTitle, { children: "Rejected sync changes" });
		$[13] = t10;
	} else t10 = $[13];
	const t11 = rows.data.length === 0 ? "No rejected changes — your local edits are all syncing." : `${rows.data.length} change${rows.data.length === 1 ? "" : "s"} the server refused. Retry once the underlying issue is fixed, or dismiss to clear from this list.`;
	let t12;
	if ($[14] !== t11) {
		t12 = /* @__PURE__ */ jsxs(DialogHeader, { children: [t10, /* @__PURE__ */ jsx(DialogDescription, { children: t11 })] });
		$[14] = t11;
		$[15] = t12;
	} else t12 = $[15];
	let t13;
	if ($[16] !== copiedId || $[17] !== handleDismiss || $[18] !== handleRetry || $[19] !== rows.data || $[20] !== workspaceLabel) {
		let t14;
		if ($[22] !== copiedId || $[23] !== handleDismiss || $[24] !== handleRetry || $[25] !== workspaceLabel) {
			t14 = (row_2) => {
				const summary = summarizeOp(row_2.data);
				const error = parseRejectionError(row_2.error_message);
				const details = extractBlockDetails(row_2.data);
				return /* @__PURE__ */ jsx("div", {
					className: "rounded-md border bg-card p-3 text-sm",
					children: /* @__PURE__ */ jsxs("div", {
						className: "flex items-start justify-between gap-2",
						children: [/* @__PURE__ */ jsxs("div", {
							className: "min-w-0 flex-1",
							children: [
								/* @__PURE__ */ jsxs("div", {
									className: "font-mono text-xs text-muted-foreground",
									children: [
										summary.op,
										" ",
										summary.table,
										" ",
										summary.idShort
									]
								}),
								/* @__PURE__ */ jsxs("div", {
									className: "mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground",
									children: [
										details.workspaceId && /* @__PURE__ */ jsxs("span", { children: ["workspace ", /* @__PURE__ */ jsx("span", {
											className: "font-mono",
											children: workspaceLabel(details.workspaceId)
										})] }),
										details.fields.length > 0 && /* @__PURE__ */ jsxs("span", { children: ["fields ", /* @__PURE__ */ jsx("span", {
											className: "font-mono",
											children: details.fields.join(", ")
										})] }),
										details.encrypted && /* @__PURE__ */ jsxs("span", {
											className: "inline-flex items-center gap-1",
											children: [/* @__PURE__ */ jsx(Lock, { className: "h-3 w-3" }), "encrypted"]
										})
									]
								}),
								details.contentPreview && /* @__PURE__ */ jsxs("div", {
									className: "mt-1 truncate text-xs text-foreground/80",
									title: details.contentPreview,
									children: [
										"“",
										details.contentPreview,
										"”"
									]
								}),
								/* @__PURE__ */ jsx("div", {
									className: "mt-1 text-sm",
									children: error.message
								}),
								(error.code || error.details) && /* @__PURE__ */ jsxs("div", {
									className: "mt-1 font-mono text-xs text-muted-foreground",
									children: [
										error.code && /* @__PURE__ */ jsxs("span", { children: ["code ", error.code] }),
										error.code && error.details && /* @__PURE__ */ jsx("span", { children: " · " }),
										error.details && /* @__PURE__ */ jsx("span", { children: error.details })
									]
								}),
								/* @__PURE__ */ jsx("div", {
									className: "mt-1 text-xs text-muted-foreground",
									children: new Date(row_2.rejected_at).toLocaleString()
								})
							]
						}), /* @__PURE__ */ jsxs("div", {
							className: "flex shrink-0 flex-col gap-1",
							children: [
								/* @__PURE__ */ jsxs(Button, {
									size: "sm",
									variant: "outline",
									onClick: () => handleRetry(row_2),
									title: "Re-queue this change for upload",
									children: [/* @__PURE__ */ jsx(RotateCcw, { className: "mr-1 h-3.5 w-3.5" }), "Retry"]
								}),
								/* @__PURE__ */ jsxs(Button, {
									size: "sm",
									variant: "ghost",
									onClick: () => handleCopy(row_2),
									title: "Copy payload and error to clipboard",
									children: [/* @__PURE__ */ jsx(Copy, { className: "mr-1 h-3.5 w-3.5" }), copiedId === row_2.id ? "Copied" : "Copy"]
								}),
								/* @__PURE__ */ jsxs(Button, {
									size: "sm",
									variant: "ghost",
									onClick: () => handleDismiss(row_2),
									title: "Remove from this list (does not affect local data)",
									children: [/* @__PURE__ */ jsx(Trash2, { className: "mr-1 h-3.5 w-3.5" }), "Dismiss"]
								})
							]
						})]
					})
				}, row_2.id);
			};
			$[22] = copiedId;
			$[23] = handleDismiss;
			$[24] = handleRetry;
			$[25] = workspaceLabel;
			$[26] = t14;
		} else t14 = $[26];
		t13 = rows.data.map(t14);
		$[16] = copiedId;
		$[17] = handleDismiss;
		$[18] = handleRetry;
		$[19] = rows.data;
		$[20] = workspaceLabel;
		$[21] = t13;
	} else t13 = $[21];
	let t14;
	if ($[27] !== t13) {
		t14 = /* @__PURE__ */ jsx("div", {
			className: "max-h-[60vh] space-y-2 overflow-y-auto",
			children: t13
		});
		$[27] = t13;
		$[28] = t14;
	} else t14 = $[28];
	let t15;
	if ($[29] !== t12 || $[30] !== t14) {
		t15 = /* @__PURE__ */ jsxs(DialogContent, {
			className: "max-w-2xl",
			children: [t12, t14]
		});
		$[29] = t12;
		$[30] = t14;
		$[31] = t15;
	} else t15 = $[31];
	let t16;
	if ($[32] !== onOpenChange || $[33] !== open || $[34] !== t15) {
		t16 = /* @__PURE__ */ jsx(Dialog, {
			open,
			onOpenChange,
			children: t15
		});
		$[32] = onOpenChange;
		$[33] = open;
		$[34] = t15;
		$[35] = t16;
	} else t16 = $[35];
	return t16;
}
function _temp(workspace) {
	return [workspace.id, workspace.name];
}
var safeParseJson = (raw) => {
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
};
//#endregion
export { RejectionDialog };

//# sourceMappingURL=RejectionDialog.js.map