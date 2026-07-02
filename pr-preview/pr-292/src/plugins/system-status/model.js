//#region src/plugins/system-status/model.ts
var formatPendingLabel = (count, approximate = false) => {
	if (count <= 0) return null;
	if (approximate) return `${count}+`;
	if (count > 999) return "999+";
	return String(count);
};
var formatChangeCount = (count, approximate = false) => {
	return `${approximate ? `${count}+` : String(count)} ${count === 1 && !approximate ? "block" : "blocks"}`;
};
var clampProgressPercent = (fraction) => {
	if (fraction === null || fraction === void 0 || !Number.isFinite(fraction)) return null;
	return Math.round(Math.max(0, Math.min(1, fraction)) * 100);
};
var formatLastSyncedAt = (date) => {
	if (!date) return null;
	return `Last synced ${date.toLocaleString()}.`;
};
var appendPendingTitle = (title, pendingChanges, localOnly = false, approximate = false) => {
	if (pendingChanges <= 0) return title;
	return `${title} ${localOnly ? `${formatChangeCount(pendingChanges, approximate)} changed, stored locally.` : `${formatChangeCount(pendingChanges, approximate)} changed, queued for upload.`}`;
};
var formatRejectedCount = (count) => {
	if (count === 1) return "1 change couldn't sync — review.";
	return `${count} changes couldn't sync — review.`;
};
var appendRejectedTitle = (title, rejectedChanges) => {
	if (rejectedChanges <= 0) return title;
	return `${title} ${formatRejectedCount(rejectedChanges)}`;
};
var baseSyncIndicatorView = ({ localOnly, connected, connecting, hasSynced, uploading, downloading, pendingChanges, pendingChangesApproximate = false, rejectedChanges = 0, materializingChanges = 0, materializingChangesApproximate = false, downloadFraction, errorMessage, lastSyncedAt }) => {
	const progressPercent = clampProgressPercent(downloadFraction);
	const pendingLabel = formatPendingLabel(pendingChanges, pendingChangesApproximate);
	if (localOnly) return {
		state: "local",
		tone: "local",
		icon: "hard-drive",
		label: "Local only",
		title: appendPendingTitle("Remote sync is disabled.", pendingChanges, true, pendingChangesApproximate),
		pendingLabel,
		progressPercent: null,
		spinning: false
	};
	if (errorMessage) return {
		state: "error",
		tone: "error",
		icon: "alert",
		label: "Sync issue",
		title: appendPendingTitle(`Sync needs attention: ${errorMessage}`, pendingChanges, false, pendingChangesApproximate),
		pendingLabel,
		progressPercent: null,
		spinning: false
	};
	if (downloading) return {
		state: "downloading",
		tone: "active",
		icon: "sync",
		label: progressPercent === null ? "Syncing" : `Sync ${progressPercent}%`,
		title: appendPendingTitle(progressPercent === null ? "Downloading remote changes." : `Downloading remote changes: ${progressPercent}%.`, pendingChanges, false, pendingChangesApproximate),
		pendingLabel,
		progressPercent,
		spinning: true
	};
	if (materializingChanges > 0) return {
		state: "materializing",
		tone: "active",
		icon: "sync",
		label: "Processing",
		title: appendPendingTitle(`Applying ${formatChangeCount(materializingChanges, materializingChangesApproximate)} of synced data to this device.`, pendingChanges, false, pendingChangesApproximate),
		pendingLabel,
		progressPercent: null,
		spinning: true
	};
	if (uploading) return {
		state: "uploading",
		tone: "active",
		icon: "sync",
		label: "Uploading",
		title: appendPendingTitle("Uploading local changes.", pendingChanges, false, pendingChangesApproximate),
		pendingLabel,
		progressPercent: null,
		spinning: true
	};
	if (pendingChanges > 0) return {
		state: "pending",
		tone: connected ? "warning" : "neutral",
		icon: "upload",
		label: "Pending",
		title: appendPendingTitle(connected ? "Waiting to upload." : "Waiting for a sync connection.", pendingChanges, false, pendingChangesApproximate),
		pendingLabel,
		progressPercent: null,
		spinning: false
	};
	if (connecting) return {
		state: "connecting",
		tone: "active",
		icon: "sync",
		label: "Connecting",
		title: "Connecting to sync.",
		pendingLabel,
		progressPercent: null,
		spinning: true
	};
	if (!connected) return {
		state: "offline",
		tone: "neutral",
		icon: "offline",
		label: "Offline",
		title: appendRejectedTitle("Sync is offline.", rejectedChanges),
		pendingLabel,
		progressPercent: null,
		spinning: false
	};
	if (hasSynced) {
		if (rejectedChanges > 0) return {
			state: "synced",
			tone: "warning",
			icon: "alert",
			label: "Synced with issues",
			title: appendRejectedTitle(formatLastSyncedAt(lastSyncedAt) ?? "All current changes are synced.", rejectedChanges),
			pendingLabel,
			progressPercent: null,
			spinning: false
		};
		return {
			state: "synced",
			tone: "success",
			icon: "check",
			label: "Synced",
			title: formatLastSyncedAt(lastSyncedAt) ?? "All local changes are synced.",
			pendingLabel,
			progressPercent: null,
			spinning: false
		};
	}
	return {
		state: "starting",
		tone: "active",
		icon: "sync",
		label: "Starting",
		title: "Preparing initial sync.",
		pendingLabel,
		progressPercent: null,
		spinning: true
	};
};
var getSyncIndicatorView = (input) => {
	const view = baseSyncIndicatorView(input);
	const alert = input.diagnosticAlert;
	if (alert && view.tone !== "error" && !view.spinning) return {
		...view,
		tone: "error",
		icon: "alert",
		label: "Integrity issue",
		title: `${alert.label}: ${alert.summary} — see details. ${view.title}`
	};
	return view;
};
//#endregion
export { getSyncIndicatorView };

//# sourceMappingURL=model.js.map