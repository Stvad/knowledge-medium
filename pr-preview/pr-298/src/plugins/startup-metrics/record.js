import { defineBlockType } from "../../data/api/blockType.js";
import { ChangeScope } from "../../data/api/changeScope.js";
import { codecs } from "../../data/api/codecs.js";
import { defineProperty } from "../../data/api/propertySchema.js";
import "../../data/api/index.js";
import v4 from "../../../node_modules/uuid/dist/v4.js";
import { keyAtStart } from "../../data/orderKey.js";
import { scheduleIdle } from "../../utils/scheduleIdle.js";
import { onFirstSync } from "../../data/internals/firstSync.js";
import { getPluginUIStateBlock, getPluginUIStateChild } from "../../data/stateBlocks.js";
import { getLastLongTaskEndMs, getStartupTimeline, hasStartupMark, longTasksSupported, markStartup, markStartupAt, onLongTask } from "../../utils/startupTimeline.js";
import { isInstalledAppDisplayMode } from "../../utils/layoutSessionId.js";
import { appVersion } from "../../appVersion.js";
import { getClientId } from "../../utils/clientId.js";
//#region src/plugins/startup-metrics/record.ts
/**
* Startup-metrics persistence: assemble the cold-start timeline into a durable
* record and store it as a block-per-session under a hidden per-user ui-state
* subtree. Block-per-session (a fresh block id each boot) keeps the log
* conflict-free across devices — two devices booting never touch the same row,
* unlike a shared JSON-array property which would LWW-clobber. Each record
* carries the device + version so a fleet-wide history is groupable.
*
* Why a record exists at all: see `src/utils/startupTimeline.ts`. This is the
* "store it so we can see TTI trend, not just feel it" half.
*/
/** The whole record rides one identity-codec property (an engine-controlled
*  blob), so the shape can evolve without per-field schema churn. A future
*  trend view reads the child blocks and parses these — fine at this volume. */
var startupRecordProp = defineProperty("startupRecord", {
	codec: codecs.optionalIdentity("object"),
	defaultValue: void 0,
	changeScope: ChangeScope.Automation
});
/** Parent ui-state container; each boot adds one child under it. */
var startupMetricsUIStateType = defineBlockType({
	id: "startup-metrics",
	label: "Startup metrics",
	properties: []
});
var startupDeviceLabel = () => {
	const surface = isInstalledAppDisplayMode() ? "installed" : "browser";
	if (typeof navigator === "undefined") return `${surface}:unknown`;
	return `${surface}:${navigator.platform || navigator.userAgent.slice(0, 40)}`;
};
/** Pure: fold the timeline + metadata into a storable record. */
var buildStartupRecord = (timeline, meta) => {
	const { marks } = timeline;
	return {
		recordedAt: meta.recordedAt,
		appVersion: meta.appVersion,
		appSha: meta.appSha,
		clientId: meta.clientId,
		deviceLabel: meta.deviceLabel,
		timeOriginMs: timeline.timeOriginMs,
		repoReadyMs: marks.repoReady,
		workspaceResolvedMs: marks.workspaceResolved,
		bootstrapDoneMs: marks.bootstrapDone,
		firstContentPaintMs: marks.firstContentPaint,
		syncedMs: marks.synced,
		drainedMs: marks.drained,
		interactiveMs: marks.interactive
	};
};
/** Append one startup record as a fresh child block under this client's group
*  block (one per browser/device installation) inside the per-user
*  startup-metrics ui-state subtree. Returns the new block id. */
var writeStartupRecord = async (repo, workspaceId) => {
	const root = await getPluginUIStateBlock(repo, workspaceId, repo.user, startupMetricsUIStateType);
	const clientId = getClientId();
	const deviceLabel = startupDeviceLabel();
	const group = await getPluginUIStateChild(root, clientId, `${deviceLabel} · ${clientId.slice(0, 8)}`);
	const data = buildStartupRecord(getStartupTimeline(), {
		recordedAt: Date.now(),
		appVersion: appVersion.display,
		appSha: appVersion.sha,
		clientId,
		deviceLabel
	});
	const id = v4();
	const first = await repo.db.getOptional("SELECT order_key FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key LIMIT 1", [group.id]);
	await repo.tx(async (tx) => {
		await tx.create({
			id,
			workspaceId,
			parentId: group.id,
			orderKey: keyAtStart(first?.order_key ?? null),
			content: new Date(data.recordedAt).toISOString(),
			properties: {}
		}, { systemMint: true });
		await tx.setProperty(id, startupRecordProp, data);
	}, {
		scope: ChangeScope.Automation,
		description: "startup metrics record"
	});
	return id;
};
/** A main thread quiet for this long (no long task) after first paint is treated
*  as "boot contention stopped" — the `interactive` mark lands at the end of the
*  last long task before this window. */
var INTERACTIVE_QUIET_MS = 2e3;
/** If `interactive` is never reached (sync never completes, thread never quiets),
*  still persist what we have so the earlier marks aren't lost. */
var SETTLE_FALLBACK_MS = 6e4;
var recorded = false;
/** Test helper — re-arm the once-per-session guard. */
var resetStartupMetricsRecorded = () => {
	recorded = false;
};
/**
* On first workspace open, detect time-to-interactivity and persist one record.
*
* The headline `interactive` mark is the end of the last long task after first
* paint — i.e. when boot contention stopped and the UI became usable — found by
* waiting for a sustained quiet window in the Long Tasks stream. (Without the
* Long Tasks API we fall back to a single post-paint idle frame, a coarser
* proxy.) `synced`/`drained` are captured alongside as warm-vs-cold diagnostics
* (both ~immediate on a warm start; on a cold start the materialization long
* tasks push `interactive` out on their own). The write itself is deferred to
* idle so the bookkeeping never re-adds boot contention.
*/
var collectStartupMetricsEffect = {
	id: "startup-metrics.collect",
	start: ({ repo, workspaceId }) => {
		if (!workspaceId || recorded) return;
		let done = false;
		const cleanups = [];
		const runCleanups = () => {
			for (const c of cleanups.splice(0)) c();
		};
		const record = () => {
			if (done) return;
			done = true;
			runCleanups();
			recorded = true;
			scheduleIdle(() => {
				writeStartupRecord(repo, workspaceId).catch((err) => console.warn("[startup-metrics] failed to write record", err));
			});
		};
		const fallback = setTimeout(record, SETTLE_FALLBACK_MS);
		cleanups.push(() => clearTimeout(fallback));
		cleanups.push(onFirstSync(repo.db, () => {
			if (done) return;
			markStartup("synced");
			repo.flushSyncObserver().then(() => {
				if (!done) markStartup("drained");
			});
		}));
		let paintTimer;
		let quietTimer;
		cleanups.push(() => {
			if (paintTimer) clearTimeout(paintTimer);
			if (quietTimer) clearTimeout(quietTimer);
		});
		const acceptInteractive = () => {
			if (done) return;
			const fcp = getStartupTimeline().marks.firstContentPaint ?? 0;
			markStartupAt("interactive", Math.max(getLastLongTaskEndMs() ?? 0, fcp));
			record();
		};
		const armQuietTimer = () => {
			if (done) return;
			if (quietTimer) clearTimeout(quietTimer);
			quietTimer = setTimeout(acceptInteractive, INTERACTIVE_QUIET_MS);
		};
		const waitForPaint = () => {
			paintTimer = void 0;
			if (done) return;
			if (!hasStartupMark("firstContentPaint")) {
				paintTimer = setTimeout(waitForPaint, 250);
				return;
			}
			if (!longTasksSupported()) {
				scheduleIdle(() => {
					if (done) return;
					markStartup("interactive");
					record();
				});
				return;
			}
			cleanups.push(onLongTask(armQuietTimer));
			armQuietTimer();
		};
		waitForPaint();
		return () => {
			done = true;
			runCleanups();
		};
	}
};
//#endregion
export { buildStartupRecord, collectStartupMetricsEffect, resetStartupMetricsRecorded, startupMetricsUIStateType, startupRecordProp, writeStartupRecord };

//# sourceMappingURL=record.js.map