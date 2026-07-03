import { useStatus } from "../../../node_modules/@powersync/react/lib/hooks/useStatus.js";
import { useQuery } from "../../../node_modules/@powersync/react/lib/hooks/watched/useQuery.js";
import "../../../node_modules/@powersync/react/lib/index.js";
import { cn } from "../../lib/utils.js";
import { Button } from "../../components/ui/button.js";
import { useIsLocalOnly } from "../../components/Login.js";
import { CircleAlert } from "../../../node_modules/lucide-react/dist/esm/icons/circle-alert.js";
import { CloudCheck } from "../../../node_modules/lucide-react/dist/esm/icons/cloud-check.js";
import { CloudOff } from "../../../node_modules/lucide-react/dist/esm/icons/cloud-off.js";
import { CloudUpload } from "../../../node_modules/lucide-react/dist/esm/icons/cloud-upload.js";
import { HardDrive } from "../../../node_modules/lucide-react/dist/esm/icons/hard-drive.js";
import { RefreshCw } from "../../../node_modules/lucide-react/dist/esm/icons/refresh-cw.js";
import { runActionById } from "../../shortcuts/runAction.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../../components/ui/dropdown-menu.js";
import { formatPendingChanges, materializeQueueCountSql, uploadQueueCountCap, uploadQueueExactCountSql, uploadQueuePreviewCountSql } from "./queueCounts.js";
import { appVersion } from "../../appVersion.js";
import { getSyncIndicatorView } from "./model.js";
import { RejectionDialog } from "./RejectionDialog.js";
import { useDiagnostics } from "../diagnostics/useDiagnostics.js";
import { useEffect, useState } from "react";
import { c } from "react/compiler-runtime";
import { Fragment as Fragment$1, jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/system-status/SystemStatusHeaderItem.tsx
var uploadQueuePreviewThrottleMs = 1e3;
var rejectedCountSql = "SELECT COUNT(*) AS count FROM ps_crud_rejected";
var networkErrorGraceMs = 5e3;
function useStableError(message, delayMs) {
	const $ = c(4);
	const [stable, setStable] = useState(null);
	let t0;
	let t1;
	if ($[0] !== delayMs || $[1] !== message) {
		t0 = () => {
			if (!message) return;
			const timer = setTimeout(() => setStable(message), delayMs);
			return () => {
				clearTimeout(timer);
				setStable(null);
			};
		};
		t1 = [message, delayMs];
		$[0] = delayMs;
		$[1] = message;
		$[2] = t0;
		$[3] = t1;
	} else {
		t0 = $[2];
		t1 = $[3];
	}
	useEffect(t0, t1);
	return stable === message ? message : null;
}
function useIsDeviceOnline() {
	const $ = c(2);
	const [online, setOnline] = useState(_temp);
	let t0;
	let t1;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t0 = () => {
			const update = () => setOnline(navigator.onLine);
			window.addEventListener("online", update);
			window.addEventListener("offline", update);
			return () => {
				window.removeEventListener("online", update);
				window.removeEventListener("offline", update);
			};
		};
		t1 = [];
		$[0] = t0;
		$[1] = t1;
	} else {
		t0 = $[0];
		t1 = $[1];
	}
	useEffect(t0, t1);
	return online;
}
function _temp() {
	return typeof navigator === "undefined" ? true : navigator.onLine;
}
var toneClass = {
	error: "border-destructive/30 bg-destructive/10 text-destructive",
	warning: "border-destructive/20 bg-destructive/5 text-destructive",
	active: "border-primary/30 bg-primary/10 text-primary",
	success: "border-success/30 bg-success/10 text-success",
	local: "border-border bg-muted/50 text-muted-foreground",
	neutral: "border-border bg-background text-muted-foreground"
};
var iconByName = {
	alert: CircleAlert,
	"hard-drive": HardDrive,
	upload: CloudUpload,
	sync: RefreshCw,
	offline: CloudOff,
	check: CloudCheck
};
var formatLastSyncedAt = (date) => {
	if (!date) return "Not synced yet";
	return date.toLocaleString();
};
function AppVersionValue() {
	const $ = c(2);
	const { display, sha, commitUrl } = appVersion;
	if (sha === "dev" || !commitUrl) {
		let t0;
		if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
			t0 = /* @__PURE__ */ jsx("span", {
				className: "text-muted-foreground",
				children: display
			});
			$[0] = t0;
		} else t0 = $[0];
		return t0;
	}
	let t0;
	if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
		t0 = /* @__PURE__ */ jsx("a", {
			href: commitUrl,
			target: "_blank",
			rel: "noreferrer",
			className: "text-muted-foreground no-underline transition-colors hover:text-foreground",
			title: `Commit ${sha}`,
			children: display
		});
		$[1] = t0;
	} else t0 = $[1];
	return t0;
}
function SystemStatusHeaderItem() {
	const $ = c(11);
	const localOnly = useIsLocalOnly();
	const status = useStatus();
	let t0;
	let t1;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t0 = [];
		t1 = { reportFetching: false };
		$[0] = t0;
		$[1] = t1;
	} else {
		t0 = $[0];
		t1 = $[1];
	}
	const rejected = useQuery(rejectedCountSql, t0, t1);
	const rejectedCount = Number(rejected.data[0]?.count ?? 0);
	const localErrorMessage = rejected.error?.message ?? null;
	if (localOnly) {
		let t2;
		if ($[2] !== localErrorMessage || $[3] !== localOnly || $[4] !== rejectedCount || $[5] !== status) {
			t2 = /* @__PURE__ */ jsx(SyncStatusHeaderContent, {
				localOnly,
				status,
				pendingChanges: 0,
				pendingChangesApproximate: false,
				rejectedCount,
				materializingChanges: 0,
				localErrorMessage
			});
			$[2] = localErrorMessage;
			$[3] = localOnly;
			$[4] = rejectedCount;
			$[5] = status;
			$[6] = t2;
		} else t2 = $[6];
		return t2;
	}
	let t2;
	if ($[7] !== localErrorMessage || $[8] !== rejectedCount || $[9] !== status) {
		t2 = /* @__PURE__ */ jsx(RemoteSyncStatusHeaderContent, {
			status,
			rejectedCount,
			baseLocalErrorMessage: localErrorMessage
		});
		$[7] = localErrorMessage;
		$[8] = rejectedCount;
		$[9] = status;
		$[10] = t2;
	} else t2 = $[10];
	return t2;
}
function RemoteSyncStatusHeaderContent(t0) {
	const $ = c(11);
	const { status, rejectedCount, baseLocalErrorMessage } = t0;
	let t1;
	let t2;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = [];
		t2 = {
			reportFetching: false,
			throttleMs: uploadQueuePreviewThrottleMs
		};
		$[0] = t1;
		$[1] = t2;
	} else {
		t1 = $[0];
		t2 = $[1];
	}
	const queue = useQuery(uploadQueuePreviewCountSql, t1, t2);
	const previewCount = Number(queue.data[0]?.count ?? 0);
	const pendingChangesApproximate = previewCount > uploadQueueCountCap;
	const pendingChanges = pendingChangesApproximate ? uploadQueueCountCap : previewCount;
	let t3;
	let t4;
	if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
		t3 = [];
		t4 = {
			reportFetching: false,
			throttleMs: uploadQueuePreviewThrottleMs
		};
		$[2] = t3;
		$[3] = t4;
	} else {
		t3 = $[2];
		t4 = $[3];
	}
	const materializeQueue = useQuery(materializeQueueCountSql, t3, t4);
	const materializingChanges = Number(materializeQueue.data[0]?.count ?? 0);
	const t5 = queue.error?.message ?? baseLocalErrorMessage;
	let t6;
	if ($[4] !== materializingChanges || $[5] !== pendingChanges || $[6] !== pendingChangesApproximate || $[7] !== rejectedCount || $[8] !== status || $[9] !== t5) {
		t6 = /* @__PURE__ */ jsx(SyncStatusHeaderContent, {
			localOnly: false,
			status,
			pendingChanges,
			pendingChangesApproximate,
			rejectedCount,
			materializingChanges,
			localErrorMessage: t5
		});
		$[4] = materializingChanges;
		$[5] = pendingChanges;
		$[6] = pendingChangesApproximate;
		$[7] = rejectedCount;
		$[8] = status;
		$[9] = t5;
		$[10] = t6;
	} else t6 = $[10];
	return t6;
}
function SyncStatusHeaderContent(t0) {
	const $ = c(78);
	const { localOnly, status, pendingChanges, pendingChangesApproximate, rejectedCount, materializingChanges, localErrorMessage } = t0;
	const [dialogOpen, setDialogOpen] = useState(false);
	const [detailsOpen, setDetailsOpen] = useState(false);
	const deviceOnline = useIsDeviceOnline();
	const dataFlow = status.dataFlowStatus;
	const stableNetworkError = useStableError(deviceOnline ? dataFlow.uploadError?.message ?? dataFlow.downloadError?.message ?? null : null, networkErrorGraceMs);
	const errorMessage = localErrorMessage ?? stableNetworkError;
	const diagnostics = useDiagnostics();
	let T0;
	let T1;
	let t1;
	let t10;
	let t2;
	let t3;
	let t4;
	let t5;
	let t6;
	let t7;
	let t8;
	let t9;
	if ($[0] !== dataFlow.downloading || $[1] !== dataFlow.uploading || $[2] !== detailsOpen || $[3] !== diagnostics.items || $[4] !== errorMessage || $[5] !== localOnly || $[6] !== materializingChanges || $[7] !== pendingChanges || $[8] !== pendingChangesApproximate || $[9] !== rejectedCount || $[10] !== status.connected || $[11] !== status.connecting || $[12] !== status.downloadProgress?.downloadedFraction || $[13] !== status.hasSynced || $[14] !== status.lastSyncedAt) {
		const diagnosticItems = diagnostics.items.filter(_temp2);
		const errorDiagnostic = diagnosticItems.find(_temp3);
		const diagnosticAlert = errorDiagnostic ? {
			label: errorDiagnostic.label,
			summary: errorDiagnostic.snapshot.summary
		} : null;
		const nudge = diagnosticItems.find(_temp4);
		const showStatusDot = Boolean(nudge) && !errorDiagnostic;
		const runDiagnosticAction = _temp6;
		const view = getSyncIndicatorView({
			localOnly,
			connected: status.connected,
			connecting: status.connecting,
			hasSynced: status.hasSynced,
			uploading: Boolean(dataFlow.uploading),
			downloading: Boolean(dataFlow.downloading),
			pendingChanges,
			pendingChangesApproximate,
			rejectedChanges: rejectedCount,
			materializingChanges,
			downloadFraction: status.downloadProgress?.downloadedFraction ?? null,
			errorMessage,
			lastSyncedAt: status.lastSyncedAt,
			diagnosticAlert
		});
		const Icon = iconByName[view.icon];
		const chipTitle = showStatusDot && nudge ? `${view.title} — ${nudge.snapshot.summary}` : view.title;
		T1 = DropdownMenu;
		t8 = detailsOpen;
		t9 = setDetailsOpen;
		const t11 = toneClass[view.tone];
		let t12;
		if ($[27] !== t11) {
			t12 = cn("relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md border outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring sm:h-8 sm:w-8", t11);
			$[27] = t11;
			$[28] = t12;
		} else t12 = $[28];
		let t13;
		if ($[29] !== showStatusDot) {
			t13 = showStatusDot && /* @__PURE__ */ jsx("span", {
				"aria-hidden": true,
				className: "absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-primary ring-2 ring-background"
			});
			$[29] = showStatusDot;
			$[30] = t13;
		} else t13 = $[30];
		t10 = /* @__PURE__ */ jsx(DropdownMenuTrigger, {
			asChild: true,
			children: /* @__PURE__ */ jsxs("button", {
				type: "button",
				className: t12,
				"aria-label": chipTitle,
				title: chipTitle,
				children: [/* @__PURE__ */ jsx(Icon, { className: cn("h-4 w-4", view.spinning && "animate-spin") }), t13]
			})
		});
		T0 = DropdownMenuContent;
		t6 = "end";
		t7 = "w-64 p-3";
		t1 = "space-y-3";
		t2 = /* @__PURE__ */ jsxs("div", {
			className: "flex items-start gap-2",
			children: [/* @__PURE__ */ jsx(Icon, { className: cn("mt-0.5 h-4 w-4 shrink-0", view.spinning && "animate-spin") }), /* @__PURE__ */ jsxs("div", {
				className: "min-w-0",
				children: [/* @__PURE__ */ jsx("div", {
					className: "text-sm font-medium",
					children: view.label
				}), /* @__PURE__ */ jsx("div", {
					className: "text-xs leading-5 text-muted-foreground",
					children: view.title
				})]
			})]
		});
		let t14;
		if ($[31] === Symbol.for("react.memo_cache_sentinel")) {
			t14 = /* @__PURE__ */ jsx("div", {
				className: "text-muted-foreground",
				children: "Unsynced"
			});
			$[31] = t14;
		} else t14 = $[31];
		let t15;
		if ($[32] !== detailsOpen || $[33] !== localOnly || $[34] !== pendingChanges || $[35] !== pendingChangesApproximate) {
			t15 = detailsOpen ? /* @__PURE__ */ jsx(UploadQueueDetails, {
				localOnly,
				previewCount: pendingChanges,
				previewApproximate: pendingChangesApproximate
			}) : formatPendingChanges(pendingChanges, localOnly, pendingChangesApproximate);
			$[32] = detailsOpen;
			$[33] = localOnly;
			$[34] = pendingChanges;
			$[35] = pendingChangesApproximate;
			$[36] = t15;
		} else t15 = $[36];
		let t16;
		if ($[37] !== t15) {
			t16 = /* @__PURE__ */ jsx("div", {
				className: "text-right",
				children: t15
			});
			$[37] = t15;
			$[38] = t16;
		} else t16 = $[38];
		const t17 = view.progressPercent !== null && /* @__PURE__ */ jsxs(Fragment$1, { children: [/* @__PURE__ */ jsx("div", {
			className: "text-muted-foreground",
			children: "Progress"
		}), /* @__PURE__ */ jsxs("div", {
			className: "text-right",
			children: [view.progressPercent, "%"]
		})] });
		let t18;
		if ($[39] !== materializingChanges) {
			t18 = materializingChanges > 0 && /* @__PURE__ */ jsxs(Fragment$1, { children: [/* @__PURE__ */ jsx("div", {
				className: "text-muted-foreground",
				children: "Processing"
			}), /* @__PURE__ */ jsxs("div", {
				className: "text-right",
				children: [
					materializingChanges.toLocaleString(),
					" ",
					materializingChanges === 1 ? "block" : "blocks"
				]
			})] });
			$[39] = materializingChanges;
			$[40] = t18;
		} else t18 = $[40];
		let t19;
		if ($[41] === Symbol.for("react.memo_cache_sentinel")) {
			t19 = /* @__PURE__ */ jsx("div", {
				className: "text-muted-foreground",
				children: "Last sync"
			});
			$[41] = t19;
		} else t19 = $[41];
		let t20;
		if ($[42] !== status.lastSyncedAt) {
			t20 = formatLastSyncedAt(status.lastSyncedAt);
			$[42] = status.lastSyncedAt;
			$[43] = t20;
		} else t20 = $[43];
		let t21;
		if ($[44] !== t20) {
			t21 = /* @__PURE__ */ jsx("div", {
				className: "text-right",
				children: t20
			});
			$[44] = t20;
			$[45] = t21;
		} else t21 = $[45];
		let t22;
		if ($[46] === Symbol.for("react.memo_cache_sentinel")) {
			t22 = /* @__PURE__ */ jsx("div", {
				className: "text-muted-foreground",
				children: "Version"
			});
			$[46] = t22;
		} else t22 = $[46];
		let t23;
		if ($[47] === Symbol.for("react.memo_cache_sentinel")) {
			t23 = /* @__PURE__ */ jsx("div", {
				className: "text-right",
				children: /* @__PURE__ */ jsx(AppVersionValue, {})
			});
			$[47] = t23;
		} else t23 = $[47];
		if ($[48] !== t16 || $[49] !== t17 || $[50] !== t18 || $[51] !== t21) {
			t3 = /* @__PURE__ */ jsxs("div", {
				className: "grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs",
				children: [
					t14,
					t16,
					t17,
					t18,
					t19,
					t21,
					t22,
					t23
				]
			});
			$[48] = t16;
			$[49] = t17;
			$[50] = t18;
			$[51] = t21;
			$[52] = t3;
		} else t3 = $[52];
		if ($[53] !== rejectedCount) {
			t4 = rejectedCount > 0 && /* @__PURE__ */ jsx("div", {
				className: "border-t pt-2",
				children: /* @__PURE__ */ jsxs("div", {
					className: "flex items-center justify-between gap-2",
					children: [/* @__PURE__ */ jsxs("div", {
						className: "text-xs text-destructive",
						children: [
							rejectedCount,
							" ",
							rejectedCount === 1 ? "change" : "changes",
							" couldn't sync"
						]
					}), /* @__PURE__ */ jsx(Button, {
						size: "sm",
						variant: "outline",
						className: "h-7 text-xs",
						onClick: () => setDialogOpen(true),
						children: "View"
					})]
				})
			});
			$[53] = rejectedCount;
			$[54] = t4;
		} else t4 = $[54];
		let t24;
		if ($[55] === Symbol.for("react.memo_cache_sentinel")) {
			t24 = (item) => /* @__PURE__ */ jsxs("div", {
				className: "border-t pt-2",
				children: [/* @__PURE__ */ jsxs("div", {
					className: "flex items-center justify-between gap-2",
					children: [/* @__PURE__ */ jsxs("div", {
						className: cn("min-w-0 text-xs font-medium", item.snapshot.severity === "error" && "text-destructive"),
						children: [
							item.label,
							": ",
							item.snapshot.summary
						]
					}), item.snapshot.actionId && /* @__PURE__ */ jsx(Button, {
						size: "sm",
						variant: "outline",
						className: "h-7 shrink-0 text-xs",
						onClick: () => runDiagnosticAction(item.snapshot.actionId),
						children: item.snapshot.actionLabel ?? "Inspect"
					})]
				}), item.snapshot.detail && /* @__PURE__ */ jsx("div", {
					className: "mt-1 text-[11px] leading-4 text-muted-foreground",
					children: item.snapshot.detail
				})]
			}, item.id);
			$[55] = t24;
		} else t24 = $[55];
		t5 = diagnosticItems.map(t24);
		$[0] = dataFlow.downloading;
		$[1] = dataFlow.uploading;
		$[2] = detailsOpen;
		$[3] = diagnostics.items;
		$[4] = errorMessage;
		$[5] = localOnly;
		$[6] = materializingChanges;
		$[7] = pendingChanges;
		$[8] = pendingChangesApproximate;
		$[9] = rejectedCount;
		$[10] = status.connected;
		$[11] = status.connecting;
		$[12] = status.downloadProgress?.downloadedFraction;
		$[13] = status.hasSynced;
		$[14] = status.lastSyncedAt;
		$[15] = T0;
		$[16] = T1;
		$[17] = t1;
		$[18] = t10;
		$[19] = t2;
		$[20] = t3;
		$[21] = t4;
		$[22] = t5;
		$[23] = t6;
		$[24] = t7;
		$[25] = t8;
		$[26] = t9;
	} else {
		T0 = $[15];
		T1 = $[16];
		t1 = $[17];
		t10 = $[18];
		t2 = $[19];
		t3 = $[20];
		t4 = $[21];
		t5 = $[22];
		t6 = $[23];
		t7 = $[24];
		t8 = $[25];
		t9 = $[26];
	}
	let t11;
	if ($[56] !== t1 || $[57] !== t2 || $[58] !== t3 || $[59] !== t4 || $[60] !== t5) {
		t11 = /* @__PURE__ */ jsxs("div", {
			className: t1,
			children: [
				t2,
				t3,
				t4,
				t5
			]
		});
		$[56] = t1;
		$[57] = t2;
		$[58] = t3;
		$[59] = t4;
		$[60] = t5;
		$[61] = t11;
	} else t11 = $[61];
	let t12;
	if ($[62] !== T0 || $[63] !== t11 || $[64] !== t6 || $[65] !== t7) {
		t12 = /* @__PURE__ */ jsx(T0, {
			align: t6,
			className: t7,
			children: t11
		});
		$[62] = T0;
		$[63] = t11;
		$[64] = t6;
		$[65] = t7;
		$[66] = t12;
	} else t12 = $[66];
	let t13;
	if ($[67] !== T1 || $[68] !== t10 || $[69] !== t12 || $[70] !== t8 || $[71] !== t9) {
		t13 = /* @__PURE__ */ jsxs(T1, {
			open: t8,
			onOpenChange: t9,
			children: [t10, t12]
		});
		$[67] = T1;
		$[68] = t10;
		$[69] = t12;
		$[70] = t8;
		$[71] = t9;
		$[72] = t13;
	} else t13 = $[72];
	let t14;
	if ($[73] !== dialogOpen) {
		t14 = /* @__PURE__ */ jsx(RejectionDialog, {
			open: dialogOpen,
			onOpenChange: setDialogOpen
		});
		$[73] = dialogOpen;
		$[74] = t14;
	} else t14 = $[74];
	let t15;
	if ($[75] !== t13 || $[76] !== t14) {
		t15 = /* @__PURE__ */ jsxs(Fragment$1, { children: [t13, t14] });
		$[75] = t13;
		$[76] = t14;
		$[77] = t15;
	} else t15 = $[77];
	return t15;
}
function _temp6(actionId) {
	try {
		Promise.resolve(runActionById(actionId, new CustomEvent("run-diagnostic-action"))).catch(_temp5);
	} catch (t0) {
		console.error("Failed to run diagnostic action", t0);
	}
}
function _temp5(e_0) {
	return console.error("Failed to run diagnostic action", e_0);
}
function _temp4(it_1) {
	return it_1.snapshot.nudge;
}
function _temp3(it_0) {
	return it_0.snapshot.severity === "error";
}
function _temp2(it) {
	return it.snapshot.severity !== "ok";
}
function UploadQueueDetails(t0) {
	const $ = c(9);
	const { localOnly, previewCount, previewApproximate } = t0;
	let t1;
	let t2;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = [];
		t2 = {
			reportFetching: false,
			runQueryOnce: true
		};
		$[0] = t1;
		$[1] = t2;
	} else {
		t1 = $[0];
		t2 = $[1];
	}
	const queue = useQuery(uploadQueueExactCountSql, t1, t2);
	const exactCount = queue.data[0]?.count;
	if (queue.error) return "Unable to count unsynced changes";
	if (exactCount === void 0) {
		let t3;
		if ($[2] !== localOnly || $[3] !== previewApproximate || $[4] !== previewCount) {
			t3 = formatPendingChanges(previewCount, localOnly, previewApproximate);
			$[2] = localOnly;
			$[3] = previewApproximate;
			$[4] = previewCount;
			$[5] = t3;
		} else t3 = $[5];
		return t3;
	}
	const t3 = Number(exactCount);
	let t4;
	if ($[6] !== localOnly || $[7] !== t3) {
		t4 = formatPendingChanges(t3, localOnly);
		$[6] = localOnly;
		$[7] = t3;
		$[8] = t4;
	} else t4 = $[8];
	return t4;
}
//#endregion
export { SystemStatusHeaderItem };

//# sourceMappingURL=SystemStatusHeaderItem.js.map