import { cn } from "../../lib/utils.js";
import { Button } from "../../components/ui/button.js";
import { useHash } from "../../../node_modules/react-use/esm/useHash.js";
import { showError } from "../../utils/toast.js";
import { useRepo } from "../../context/repo.js";
import { Check } from "../../../node_modules/lucide-react/dist/esm/icons/check.js";
import { CircleAlert } from "../../../node_modules/lucide-react/dist/esm/icons/circle-alert.js";
import { CircleCheck } from "../../../node_modules/lucide-react/dist/esm/icons/circle-check.js";
import { Copy } from "../../../node_modules/lucide-react/dist/esm/icons/copy.js";
import { RefreshCw } from "../../../node_modules/lucide-react/dist/esm/icons/refresh-cw.js";
import { TriangleAlert } from "../../../node_modules/lucide-react/dist/esm/icons/triangle-alert.js";
import { buildAppHash } from "../../utils/routing.js";
import { useNavigate } from "../../utils/navigation.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { getConsistencyAuditSnapshotFor, subscribeConsistencyAudit } from "./store.js";
import { runConsistencyAuditNow } from "./schedule.js";
import { useState, useSyncExternalStore } from "react";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/data-integrity/ConsistencyAuditDialog.tsx
/**
* Results view for an on-demand data-integrity audit (L3). Opened by the
* `run_data_integrity_audit` action (fresh run) and the
* `view_data_integrity_audit` action (re-open the LAST run) via
* `openDialog(ConsistencyAuditDialog)`.
*
* The results are read live from the audit store (the last published
* `ConsistencyAuditResult`), so the dialog can be re-opened to inspect the last
* run WITHOUT re-running the expensive audit, and refreshes in place when the
* "Re-run" button publishes a new result.
*
* Shows every check that ran with its status, an exact count breakdown, and a
* small sample of offending block ids — each shown in FULL, click-to-copy, and
* click-to-open in the side panel (the dialog stays open so you don't lose the
* results). The FULL per-block list and precise per-ref diffs stay the bridge
* eval's job (scripts/data-integrity/consistency-check.eval.js) — this is the
* in-app lead.
*
* Rendered non-modal with no dimming overlay so opening a sample in the side
* panel is actually visible while the dialog floats — close it with Escape or
* the ✕; an outside click is intentionally NOT a close (see below).
*/
var num = (c, key) => Number(c[key] ?? 0);
var samplesOf = (c) => Array.isArray(c.samples) ? c.samples : [];
function describeCheck(name, c) {
	if (name === "references_index_mirror") {
		const parts = [];
		if (num(c, "missingIndexRows")) parts.push(`${num(c, "missingIndexRows")} missing`);
		if (num(c, "extraIndexRows")) parts.push(`${num(c, "extraIndexRows")} extra`);
		if (num(c, "orphanSourceRows")) parts.push(`${num(c, "orphanSourceRows")} orphaned`);
		if (num(c, "duplicateTuples")) parts.push(`${num(c, "duplicateTuples")} duplicate`);
		if (num(c, "malformedJson")) parts.push(`${num(c, "malformedJson")} malformed JSON`);
		return {
			label: "References index mirror",
			detail: parts.join(", ") || "consistent",
			offending: num(c, "missingIndexRows") + num(c, "extraIndexRows") + num(c, "orphanSourceRows") + num(c, "duplicateTuples")
		};
	}
	if (name === "property_ref_at_rest") {
		const findings = Array.isArray(c.findings) ? c.findings : [];
		return {
			label: "Property refs at rest",
			detail: findings.length ? findings.map((f) => `${f.prop}: ${f.valuePresentRefAbsent}`).join(", ") : "consistent",
			offending: num(c, "total")
		};
	}
	if (name === "local_server_divergence") {
		const parts = [];
		if (num(c, "strandedLocalOnly")) parts.push(`${num(c, "strandedLocalOnly")} stranded`);
		if (num(c, "equalStampStandoff")) parts.push(`${num(c, "equalStampStandoff")} stalemate`);
		if (num(c, "localRicherNoPending")) parts.push(`${num(c, "localRicherNoPending")} unsynced local`);
		if (num(c, "serverAheadUndrained")) parts.push(`${num(c, "serverAheadUndrained")} server-ahead (info)`);
		return {
			label: "Local ↔ server",
			detail: parts.join(", ") || "converged",
			offending: num(c, "strandedLocalOnly") + num(c, "equalStampStandoff") + num(c, "localRicherNoPending")
		};
	}
	return {
		label: name,
		detail: c.status,
		offending: c.status === "anomaly" ? 1 : 0
	};
}
var StatusIcon = (t0) => {
	const $ = c(3);
	const { status } = t0;
	if (status === "anomaly") {
		let t1;
		if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
			t1 = /* @__PURE__ */ jsx(CircleAlert, { className: "h-4 w-4 shrink-0 text-destructive" });
			$[0] = t1;
		} else t1 = $[0];
		return t1;
	}
	if (status === "error") {
		let t1;
		if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
			t1 = /* @__PURE__ */ jsx(TriangleAlert, { className: "h-4 w-4 shrink-0 text-amber-500" });
			$[1] = t1;
		} else t1 = $[1];
		return t1;
	}
	let t1;
	if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = /* @__PURE__ */ jsx(CircleCheck, { className: "h-4 w-4 shrink-0 text-success" });
		$[2] = t1;
	} else t1 = $[2];
	return t1;
};
/** One offending block id: shown in FULL (monospace, wraps so nothing is
*  truncated). Clicking the id opens it in the side panel; a trailing button
*  copies the full id to the clipboard. */
function SampleRow(t0) {
	const $ = c(17);
	const { id, onOpen } = t0;
	const [copied, setCopied] = useState(false);
	let t1;
	if ($[0] !== id) {
		t1 = async () => {
			try {
				await navigator.clipboard.writeText(id);
				setCopied(true);
				window.setTimeout(() => setCopied(false), 1200);
			} catch (t2) {
				console.error("Clipboard write failed", t2);
				showError("Couldn't copy id to the clipboard.");
			}
		};
		$[0] = id;
		$[1] = t1;
	} else t1 = $[1];
	const copy = t1;
	let t2;
	if ($[2] !== id || $[3] !== onOpen) {
		t2 = () => onOpen(id);
		$[2] = id;
		$[3] = onOpen;
		$[4] = t2;
	} else t2 = $[4];
	let t3;
	if ($[5] !== id || $[6] !== t2) {
		t3 = /* @__PURE__ */ jsx("button", {
			type: "button",
			onClick: t2,
			title: "Open in side panel",
			className: "min-w-0 flex-1 break-all rounded bg-muted px-1.5 py-0.5 text-left font-mono text-[11px] hover:bg-muted/70",
			children: id
		});
		$[5] = id;
		$[6] = t2;
		$[7] = t3;
	} else t3 = $[7];
	const t4 = copied ? "Copied" : "Copy id";
	let t5;
	if ($[8] !== copied) {
		t5 = copied ? /* @__PURE__ */ jsx(Check, { className: "h-3 w-3 text-success" }) : /* @__PURE__ */ jsx(Copy, { className: "h-3 w-3" });
		$[8] = copied;
		$[9] = t5;
	} else t5 = $[9];
	let t6;
	if ($[10] !== copy || $[11] !== t4 || $[12] !== t5) {
		t6 = /* @__PURE__ */ jsx("button", {
			type: "button",
			onClick: copy,
			title: "Copy id",
			"aria-label": t4,
			className: "shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground",
			children: t5
		});
		$[10] = copy;
		$[11] = t4;
		$[12] = t5;
		$[13] = t6;
	} else t6 = $[13];
	let t7;
	if ($[14] !== t3 || $[15] !== t6) {
		t7 = /* @__PURE__ */ jsxs("div", {
			className: "flex items-center gap-1",
			children: [t3, t6]
		});
		$[14] = t3;
		$[15] = t6;
		$[16] = t7;
	} else t7 = $[16];
	return t7;
}
var formatCheckedAt = (checkedAt) => {
	const d = new Date(checkedAt);
	return Number.isNaN(d.getTime()) ? "unknown time" : d.toLocaleString();
};
function ConsistencyAuditDialog({ cancel, workspaceId: pinnedWorkspaceId }) {
	const repo = useRepo();
	const navigate = useNavigate();
	const [, setHash] = useHash();
	const [runPinnedWorkspaceId, setRunPinnedWorkspaceId] = useState(null);
	const targetWorkspaceId = pinnedWorkspaceId ?? runPinnedWorkspaceId ?? repo.activeWorkspaceId;
	const getSnapshot = () => getConsistencyAuditSnapshotFor(targetWorkspaceId);
	const result = useSyncExternalStore(subscribeConsistencyAudit, getSnapshot, getSnapshot);
	const [rerunning, setRerunning] = useState(false);
	const open = (id) => {
		const ws = result?.workspaceId;
		if (ws && ws !== repo.activeWorkspaceId) {
			repo.setActiveWorkspaceId(ws);
			setHash(buildAppHash(ws));
		}
		navigate({
			blockId: id,
			target: "sidebar-stack",
			workspaceId: ws
		});
	};
	const rerun = async () => {
		const ws_0 = targetWorkspaceId;
		if (!ws_0) {
			showError("Data integrity audit: no active workspace.");
			return;
		}
		setRunPinnedWorkspaceId(ws_0);
		setRerunning(true);
		try {
			await runConsistencyAuditNow(repo, ws_0);
		} catch (e) {
			showError(`Data integrity audit failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setRerunning(false);
		}
	};
	return /* @__PURE__ */ jsx(Dialog, {
		open: true,
		modal: false,
		onOpenChange: (isOpen) => {
			if (!isOpen) cancel();
		},
		children: /* @__PURE__ */ jsxs(DialogContent, {
			className: "max-w-lg",
			hideOverlay: true,
			onInteractOutside: (e_0) => e_0.preventDefault(),
			onPointerDownOutside: (e_1) => e_1.preventDefault(),
			children: [
				/* @__PURE__ */ jsxs(DialogHeader, { children: [/* @__PURE__ */ jsx(DialogTitle, { children: "Data integrity audit" }), /* @__PURE__ */ jsx(DialogDescription, { children: result ? result.anomalies > 0 ? `${result.anomalies} ${result.anomalies === 1 ? "check" : "checks"} flagged an anomaly above the alert threshold.` : "No anomalies above the alert threshold." : "No audit has run for this workspace yet." })] }),
				result && /* @__PURE__ */ jsxs("div", {
					className: "flex items-center justify-between gap-2 text-[11px] text-muted-foreground",
					children: [/* @__PURE__ */ jsxs("span", { children: ["Last run: ", formatCheckedAt(result.checkedAt)] }), /* @__PURE__ */ jsxs(Button, {
						type: "button",
						variant: "outline",
						size: "sm",
						className: "h-7 shrink-0 text-xs",
						onClick: () => void rerun(),
						disabled: rerunning,
						children: [/* @__PURE__ */ jsx(RefreshCw, { className: cn("h-3 w-3", rerunning && "animate-spin") }), rerunning ? "Re-running…" : "Re-run"]
					})]
				}),
				result ? /* @__PURE__ */ jsx("div", {
					className: "max-h-[60vh] space-y-2 overflow-y-auto",
					children: Object.entries(result.checks).map(([name, check]) => {
						const view = describeCheck(name, check);
						const samples = samplesOf(check);
						return /* @__PURE__ */ jsxs("div", {
							className: "rounded-md border p-2",
							children: [
								/* @__PURE__ */ jsxs("div", {
									className: "flex items-center gap-2",
									children: [/* @__PURE__ */ jsx(StatusIcon, { status: check.status }), /* @__PURE__ */ jsx("div", {
										className: "text-sm font-medium",
										children: view.label
									})]
								}),
								/* @__PURE__ */ jsx("div", {
									className: "mt-0.5 pl-6 text-xs text-muted-foreground",
									children: check.status === "error" ? `couldn't run: ${String(check.error ?? "unknown error")}` : view.detail
								}),
								samples.length > 0 && /* @__PURE__ */ jsxs("div", {
									className: "mt-1 space-y-1 pl-6",
									children: [
										/* @__PURE__ */ jsx("div", {
											className: "text-[11px] text-muted-foreground",
											children: "Sample blocks (click to open in side panel, copy for the full id):"
										}),
										samples.map((id_0) => /* @__PURE__ */ jsx(SampleRow, {
											id: id_0,
											onOpen: open
										}, id_0)),
										view.offending > samples.length && /* @__PURE__ */ jsxs("span", {
											className: "text-[11px] text-muted-foreground",
											children: [
												"+",
												view.offending - samples.length,
												" more"
											]
										})
									]
								})
							]
						}, name);
					})
				}) : /* @__PURE__ */ jsxs("div", {
					className: "space-y-3 py-2",
					children: [/* @__PURE__ */ jsx("p", {
						className: "text-sm text-muted-foreground",
						children: "Run an audit to check data integrity for this workspace."
					}), /* @__PURE__ */ jsxs(Button, {
						type: "button",
						onClick: () => void rerun(),
						disabled: rerunning,
						children: [/* @__PURE__ */ jsx(RefreshCw, { className: cn("h-4 w-4", rerunning && "animate-spin") }), rerunning ? "Running…" : "Run audit"]
					})]
				}),
				/* @__PURE__ */ jsxs("div", {
					className: "text-[11px] leading-4 text-muted-foreground",
					children: [
						"Counts are exact; samples are a lead. For the full per-block list and precise per-ref diffs, run the bridge eval (",
						/* @__PURE__ */ jsx("code", { children: "scripts/data-integrity/consistency-check.eval.js" }),
						")."
					]
				})
			]
		})
	});
}
//#endregion
export { ConsistencyAuditDialog };

//# sourceMappingURL=ConsistencyAuditDialog.js.map