import { addDaysIso, todayIso } from "./dailyNotes.js";
import { useRepo } from "../../context/repo.js";
import { useAppRuntime } from "../../extensions/runtimeContext.js";
import { pickBlockDateAdapter } from "./blockDateAdapter.js";
import { registerScrubHandler } from "./dateScrubGesture.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/daily-notes/DateScrubOverlay.tsx
/**
* Floating preview rendered while the two-finger scrub gesture is
* active. Owns the runtime + adapter resolution + commit; the gesture
* module (`dateScrubGesture.ts`) just feeds it day deltas.
*
* Rendering: a small pill near the user's finger showing the current
* candidate ISO and the offset from the original date. A cancel hint
* appears when the user has dragged far enough vertically that
* releasing would revert.
*
* State strategy: the live scrub lives in a mutable ref so the
* gesture callbacks can read the latest value across rapid touchmove
* events without going through React state batching. A parallel
* `setActive` mirrors the ref for rendering. Persisted-data writes
* (the adapter `setIso` commit) happen OUTSIDE any state-updater
* closure — Strict Mode / render-retry would otherwise re-run the
* updater and fire duplicate reschedule writes for a single gesture
* release.
*/
var formatPretty = (iso) => {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
	if (!match) return iso;
	return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).toLocaleDateString("en-US", {
		weekday: "short",
		day: "numeric",
		month: "short"
	});
};
var offsetLabel = (deltaDays, candidateIso) => {
	if (deltaDays === 0) return "unchanged";
	if (candidateIso === todayIso()) return "today";
	if (deltaDays > 0) return `+${deltaDays}d`;
	return `${deltaDays}d`;
};
var createDateDraft = ({ adapter, repoBlock, initialIso, deltaDays }) => {
	const currentIso = addDaysIso(initialIso, deltaDays);
	return {
		id: "date-scrub.date",
		currentIso,
		preview: {
			label: "Scrub date",
			value: formatPretty(currentIso),
			detail: offsetLabel(deltaDays, currentIso)
		},
		payload: {
			plugin: "daily-notes.date-scrub",
			initialIso,
			deltaDays
		},
		shiftDate: (delta) => createDateDraft({
			adapter,
			repoBlock,
			initialIso,
			deltaDays: deltaDays + delta
		}),
		commit: async () => {
			if (currentIso === initialIso) return;
			await adapter.setIso(repoBlock(), currentIso);
		}
	};
};
/** Monotonic gesture counter — module-scoped so it survives any
*  StrictMode-driven double-mount of the overlay. Each scrub start
*  takes the next id; async patches compare it against the still-
*  active session to reject stale resolves. */
var nextScrubSession = 0;
var DateScrubOverlay = () => {
	const runtime = useAppRuntime();
	const repo = useRepo();
	const [active, setActive] = useState(null);
	const activeRef = useRef(null);
	const writeActive = useCallback((next) => {
		activeRef.current = next;
		setActive(next);
	}, []);
	const dismiss = useCallback(() => writeActive(null), [writeActive]);
	useEffect(() => {
		return registerScrubHandler({
			start: (args) => {
				const adapter = args.adapter ?? pickBlockDateAdapter(runtime, args.block);
				if (!adapter) return false;
				const fallback = todayIso();
				const session = ++nextScrubSession;
				writeActive({
					blockId: args.blockId,
					session,
					adapter,
					initialIso: null,
					fallbackIso: fallback,
					startX: args.startX,
					startY: args.startY,
					deltaDays: 0,
					cancelIntent: false,
					draft: null,
					resolved: false
				});
				(async () => {
					let iso;
					try {
						iso = await adapter.getCurrentIso(args.block);
					} catch (error) {
						console.error("[date-scrub] adapter read failed", error);
						return;
					}
					if (!iso) return;
					const current = activeRef.current;
					if (!current || current.session !== session) return;
					if (current.draft) {
						writeActive({
							...current,
							initialIso: iso,
							resolved: true
						});
						return;
					}
					writeActive({
						...current,
						initialIso: iso,
						draft: createDateDraft({
							adapter,
							repoBlock: () => repo.block(args.blockId),
							initialIso: iso,
							deltaDays: current.deltaDays
						}),
						resolved: true
					});
				})();
				return true;
			},
			update: (deltaDays, intentCancel) => {
				const current_0 = activeRef.current;
				if (!current_0) return;
				const stepDeltaDays = deltaDays - current_0.deltaDays;
				const draft = current_0.draft && stepDeltaDays !== 0 ? current_0.draft.shiftDate(stepDeltaDays) : current_0.draft;
				if (deltaDays === current_0.deltaDays && intentCancel === current_0.cancelIntent) return;
				writeActive({
					...current_0,
					deltaDays,
					cancelIntent: intentCancel,
					draft
				});
			},
			stage: (blockId, draft_0) => {
				const current_1 = activeRef.current;
				if (!current_1 || current_1.blockId !== blockId) return false;
				writeActive({
					...current_1,
					draft: draft_0
				});
				return true;
			},
			getDraft: (blockId_0) => {
				const current_2 = activeRef.current;
				if (!current_2 || current_2.blockId !== blockId_0) return null;
				return current_2.draft;
			},
			end: (commit) => {
				const current_3 = activeRef.current;
				writeActive(null);
				if (!current_3) return;
				if (!commit || current_3.cancelIntent) return;
				if (!current_3.draft) {
					console.warn("[date-scrub] released before initial ISO resolved; skipped commit");
					return;
				}
				Promise.resolve(current_3.draft.commit()).catch((error_0) => {
					console.error("[date-scrub] commit failed", error_0);
				});
			}
		});
	}, [
		repo,
		runtime,
		writeActive
	]);
	useEffect(() => {
		if (!active) return;
		const handleKey = (event) => {
			if (event.key === "Escape") dismiss();
		};
		window.addEventListener("keydown", handleKey);
		return () => window.removeEventListener("keydown", handleKey);
	}, [active, dismiss]);
	if (!active) return null;
	const PILL_OFFSET_Y = 72;
	const PILL_HALF_WIDTH = 110;
	const top = Math.max(8, active.startY - PILL_OFFSET_Y);
	const left = Math.max(PILL_HALF_WIDTH + 8, Math.min(window.innerWidth - PILL_HALF_WIDTH - 8, active.startX));
	const preview = active.draft?.preview;
	const label = active.cancelIntent ? "Release to cancel" : preview ? preview.label : active.resolved ? "Scrub date" : "Loading current date…";
	const value = preview?.value ?? formatPretty(active.fallbackIso);
	const detail = active.cancelIntent ? "release will cancel" : preview?.detail ?? (active.resolved ? offsetLabel(active.deltaDays, active.draft?.currentIso ?? active.fallbackIso) : "release will cancel");
	const valueResolved = active.draft !== null;
	return createPortal(/* @__PURE__ */ jsx("div", {
		className: "pointer-events-none fixed z-[60] -translate-x-1/2",
		style: {
			top,
			left
		},
		"aria-live": "polite",
		children: /* @__PURE__ */ jsxs("div", {
			className: `flex min-w-[200px] flex-col items-center gap-1 rounded-xl border px-4 py-2 shadow-2xl backdrop-blur transition-colors ${active.cancelIntent ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-border bg-popover/95 text-popover-foreground"}`,
			children: [
				/* @__PURE__ */ jsx("div", {
					className: "text-[10px] font-medium uppercase tracking-wide text-muted-foreground",
					children: label
				}),
				/* @__PURE__ */ jsx("div", {
					className: `text-lg font-semibold leading-none ${valueResolved ? "" : "opacity-60"}`,
					children: value
				}),
				/* @__PURE__ */ jsx("div", {
					className: "text-xs text-muted-foreground",
					children: detail
				})
			]
		})
	}), document.body);
};
//#endregion
export { DateScrubOverlay };

//# sourceMappingURL=DateScrubOverlay.js.map