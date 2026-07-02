import { CircleAlert } from "../../../node_modules/lucide-react/dist/esm/icons/circle-alert.js";
import { CircleCheck } from "../../../node_modules/lucide-react/dist/esm/icons/circle-check.js";
import { TriangleAlert } from "../../../node_modules/lucide-react/dist/esm/icons/triangle-alert.js";
import { useNavigate } from "../../utils/navigation.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/system-status/ConsistencyAuditDialog.tsx
/**
* Results view for an on-demand data-integrity audit (L3). Opened by the
* `run_data_integrity_audit` action (command palette + status dropdown
* button) via `openDialog(ConsistencyAuditDialog, {result})`.
*
* Shows every check that ran with its status, an exact count breakdown, and a
* small sample of offending block ids (click to navigate). The FULL per-block
* list and precise per-ref diffs stay the bridge eval's job
* (scripts/data-integrity/consistency-check.eval.js) — this is the in-app lead.
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
function ConsistencyAuditDialog(t0) {
	const $ = c(18);
	const { result, resolve, cancel } = t0;
	const navigate = useNavigate();
	let t1;
	if ($[0] !== navigate || $[1] !== resolve) {
		t1 = (id) => {
			resolve();
			navigate({
				blockId: id,
				target: "active"
			});
		};
		$[0] = navigate;
		$[1] = resolve;
		$[2] = t1;
	} else t1 = $[2];
	const open = t1;
	let t2;
	if ($[3] !== cancel) {
		t2 = (isOpen) => {
			if (!isOpen) cancel();
		};
		$[3] = cancel;
		$[4] = t2;
	} else t2 = $[4];
	let t3;
	if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
		t3 = /* @__PURE__ */ jsx(DialogTitle, { children: "Data integrity audit" });
		$[5] = t3;
	} else t3 = $[5];
	const t4 = result.anomalies > 0 ? `${result.anomalies} ${result.anomalies === 1 ? "check" : "checks"} flagged an anomaly above the alert threshold.` : "No anomalies above the alert threshold.";
	let t5;
	if ($[6] !== t4) {
		t5 = /* @__PURE__ */ jsxs(DialogHeader, { children: [t3, /* @__PURE__ */ jsx(DialogDescription, { children: t4 })] });
		$[6] = t4;
		$[7] = t5;
	} else t5 = $[7];
	let t6;
	if ($[8] !== open || $[9] !== result.checks) {
		t6 = /* @__PURE__ */ jsx("div", {
			className: "max-h-[60vh] space-y-2 overflow-y-auto",
			children: Object.entries(result.checks).map((t7) => {
				const [name, check] = t7;
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
							className: "mt-1 pl-6",
							children: [/* @__PURE__ */ jsx("div", {
								className: "text-[11px] text-muted-foreground",
								children: "Sample blocks (click to open):"
							}), /* @__PURE__ */ jsxs("div", {
								className: "mt-0.5 flex flex-wrap items-center gap-1",
								children: [samples.map((id_0) => /* @__PURE__ */ jsx("button", {
									type: "button",
									onClick: () => open(id_0),
									title: id_0,
									className: "rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] hover:bg-muted/70",
									children: id_0.slice(0, 8)
								}, id_0)), view.offending > samples.length && /* @__PURE__ */ jsxs("span", {
									className: "text-[11px] text-muted-foreground",
									children: [
										"+",
										view.offending - samples.length,
										" more"
									]
								})]
							})]
						})
					]
				}, name);
			})
		});
		$[8] = open;
		$[9] = result.checks;
		$[10] = t6;
	} else t6 = $[10];
	let t7;
	if ($[11] === Symbol.for("react.memo_cache_sentinel")) {
		t7 = /* @__PURE__ */ jsxs("div", {
			className: "text-[11px] leading-4 text-muted-foreground",
			children: [
				"Counts are exact; samples are a lead. For the full per-block list and precise per-ref diffs, run the bridge eval (",
				/* @__PURE__ */ jsx("code", { children: "scripts/data-integrity/consistency-check.eval.js" }),
				")."
			]
		});
		$[11] = t7;
	} else t7 = $[11];
	let t8;
	if ($[12] !== t5 || $[13] !== t6) {
		t8 = /* @__PURE__ */ jsxs(DialogContent, {
			className: "max-w-lg",
			children: [
				t5,
				t6,
				t7
			]
		});
		$[12] = t5;
		$[13] = t6;
		$[14] = t8;
	} else t8 = $[14];
	let t9;
	if ($[15] !== t2 || $[16] !== t8) {
		t9 = /* @__PURE__ */ jsx(Dialog, {
			open: true,
			onOpenChange: t2,
			children: t8
		});
		$[15] = t2;
		$[16] = t8;
		$[17] = t9;
	} else t9 = $[17];
	return t9;
}
//#endregion
export { ConsistencyAuditDialog };

//# sourceMappingURL=ConsistencyAuditDialog.js.map