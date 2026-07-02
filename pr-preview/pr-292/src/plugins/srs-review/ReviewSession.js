import { getBlockTypes } from "../../data/properties.js";
import { cn } from "../../lib/utils.js";
import { Button } from "../../components/ui/button.js";
import { showError, showInfo } from "../../utils/toast.js";
import { srsArchivedProp, srsFactorProp, srsIntervalProp, srsNextReviewDateProp } from "../srs-rescheduling/schema.js";
import { useRepo } from "../../context/repo.js";
import { useManyParents, useProperty } from "../../hooks/block.js";
import { ArchiveX } from "../../../node_modules/lucide-react/dist/esm/icons/archive-x.js";
import { ArrowLeft } from "../../../node_modules/lucide-react/dist/esm/icons/arrow-left.js";
import { CalendarClock } from "../../../node_modules/lucide-react/dist/esm/icons/calendar-clock.js";
import { Check } from "../../../node_modules/lucide-react/dist/esm/icons/check.js";
import { ChevronLeft } from "../../../node_modules/lucide-react/dist/esm/icons/chevron-left.js";
import { ExternalLink } from "../../../node_modules/lucide-react/dist/esm/icons/external-link.js";
import { Gauge } from "../../../node_modules/lucide-react/dist/esm/icons/gauge.js";
import { PartyPopper } from "../../../node_modules/lucide-react/dist/esm/icons/party-popper.js";
import { RefreshCw } from "../../../node_modules/lucide-react/dist/esm/icons/refresh-cw.js";
import { RotateCcw } from "../../../node_modules/lucide-react/dist/esm/icons/rotate-ccw.js";
import { SkipForward } from "../../../node_modules/lucide-react/dist/esm/icons/skip-forward.js";
import { Sparkles } from "../../../node_modules/lucide-react/dist/esm/icons/sparkles.js";
import { NestedBlockContextProvider } from "../../context/block.js";
import { usePluginUIStateChildBlock } from "../../data/globalState.js";
import { useActionContextActivations } from "../../shortcuts/useActionContext.js";
import { useBlockOpener } from "../../utils/navigation.js";
import { BlockComponent } from "../../components/BlockComponent.js";
import { openDialog } from "../../utils/dialogs.js";
import { ReschedulePicker } from "../daily-notes/ReschedulePicker.js";
import "../daily-notes/index.js";
import { PromotableBreadcrumbList } from "../breadcrumbs/PromotableBreadcrumbList.js";
import { usePromotableBreadcrumb } from "../breadcrumbs/usePromotableBreadcrumb.js";
import "../breadcrumbs/index.js";
import { SrsSignal, estimateSrsIntervalDays } from "../srs-rescheduling/scheduler.js";
import { formatIntervalDays, formatRescheduleToastMessage, rescheduleBlock } from "../srs-rescheduling/index.js";
import { reviewDeckStartedProp, reviewProgressProp, srsReviewProgressType } from "./schema.js";
import { useDueCards, useDueCardsReady } from "./useDueCards.js";
import { archiveSrsCard } from "./archive.js";
import { localDayKey, reconcileRestoredQueue, restoreSavedSession } from "./reviewProgress.js";
import { SRS_REVIEW_CONTEXT } from "./actions.js";
import { SRS_REVIEW_CARD_ID, SRS_REVIEW_REVEALED } from "./reviewCardLayout.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/srs-review/ReviewSession.tsx
/** Breadcrumb context overrides — mirrors the breadcrumbs plugin's own
*  header renderer so the in-review chain renders identically. */
var BREADCRUMB_OVERRIDES = {
	isNestedSurface: true,
	isBreadcrumb: true
};
var EMPTY_PARENTS = [];
/** How many cards' ancestors to prefetch per chunk (two chunks are in
*  flight at once). Bounds the `core.manyAncestors` id count so a large
*  deck can't exceed SQLite's host-parameter limit. */
var BREADCRUMB_PREFETCH = 24;
/** Today's local day key, advanced when the date rolls over. Polls once a
*  minute (cheap; only re-renders the minute the day changes), mirroring
*  `useDueCards`' midnight-aware cutoff so a deck left open overnight saves
*  and restores under the correct day. */
var useTodayKey = () => {
	const $ = c(2);
	const [key, setKey] = useState(localDayKey);
	let t0;
	let t1;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t0 = () => {
			const id = setInterval(() => {
				const next = localDayKey();
				setKey((prev) => prev === next ? prev : next);
			}, 6e4);
			return () => clearInterval(id);
		};
		t1 = [];
		$[0] = t0;
		$[1] = t1;
	} else {
		t0 = $[0];
		t1 = $[1];
	}
	useEffect(t0, t1);
	return key;
};
var isInteractiveTarget = (el) => {
	if (!el) return false;
	if (el.isContentEditable) return true;
	if (el.getAttribute("role") === "button") return true;
	return [
		"INPUT",
		"TEXTAREA",
		"SELECT",
		"BUTTON",
		"A"
	].includes(el.tagName);
};
/** Whether a block is still a live, schedulable review card — mirrors
*  the deck's membership conditions (`buildDueCardsQuery`): it must
*  carry the SRS type AND a non-empty next-review date AND not be
*  archived. A card can lose any of these in another panel after the
*  session snapshotted its id; grading it then would re-add the type
*  and/or write a fresh date via `rescheduleBlock`, resurrecting a card
*  the user just removed from review. */
var isLiveSrsCard = (data) => {
	if (!getBlockTypes(data).includes("srs-sm2.5")) return false;
	try {
		const archivedRaw = data.properties[srsArchivedProp.name];
		if (archivedRaw !== void 0 && srsArchivedProp.codec.decode(archivedRaw)) return false;
		const dateRaw = data.properties[srsNextReviewDateProp.name];
		return dateRaw !== void 0 && srsNextReviewDateProp.codec.decode(dateRaw).length > 0;
	} catch {
		return false;
	}
};
var GRADE_BUTTONS = [
	{
		signal: SrsSignal.AGAIN,
		label: "Again",
		hint: "1",
		icon: RotateCcw,
		className: "text-rose-600"
	},
	{
		signal: SrsSignal.HARD,
		label: "Hard",
		hint: "2",
		icon: Gauge,
		className: "text-amber-600"
	},
	{
		signal: SrsSignal.GOOD,
		label: "Good",
		hint: "3",
		icon: Check,
		className: "text-emerald-600"
	},
	{
		signal: SrsSignal.EASY,
		label: "Easy",
		hint: "4",
		icon: Sparkles,
		className: "text-sky-600"
	}
];
/** The four grade buttons, each labelled with the interval the card would
*  next be scheduled for if you picked it ("1d", "4d", "2mo", …). The
*  estimate reads the card's live interval/factor so it tracks edits made
*  elsewhere, and uses the same formatter as the post-grade toast so the
*  two agree. Split into its own component so the `useProperty` reads only
*  run for the card on screen. */
var GradeButtons = (t0) => {
	const $ = c(7);
	const { card, busy, onGrade } = t0;
	const [interval] = useProperty(card, srsIntervalProp);
	const [factor] = useProperty(card, srsFactorProp);
	let t1;
	if ($[0] !== busy || $[1] !== factor || $[2] !== interval || $[3] !== onGrade) {
		t1 = GRADE_BUTTONS.map((btn) => /* @__PURE__ */ jsxs(Button, {
			type: "button",
			variant: "outline",
			className: "flex h-auto flex-col gap-1 py-2",
			disabled: busy,
			onClick: () => onGrade(btn.signal),
			children: [
				/* @__PURE__ */ jsx(btn.icon, { className: cn("h-4 w-4", btn.className) }),
				/* @__PURE__ */ jsx("span", {
					className: "text-sm font-medium",
					children: btn.label
				}),
				/* @__PURE__ */ jsx("span", {
					className: "text-[11px] font-medium tabular-nums text-muted-foreground",
					children: formatIntervalDays(estimateSrsIntervalDays({
						interval,
						factor
					}, btn.signal))
				}),
				/* @__PURE__ */ jsx("span", {
					className: "text-[10px] opacity-50",
					children: btn.hint
				})
			]
		}, btn.label));
		$[0] = busy;
		$[1] = factor;
		$[2] = interval;
		$[3] = onGrade;
		$[4] = t1;
	} else t1 = $[4];
	let t2;
	if ($[5] !== t1) {
		t2 = /* @__PURE__ */ jsx("div", {
			className: "grid grid-cols-4 gap-2",
			children: t1
		});
		$[5] = t1;
		$[6] = t2;
	} else t2 = $[6];
	return t2;
};
var ReviewSession = ({ deck, tagName }) => {
	const repo = useRepo();
	const workspaceId = deck.peek()?.workspaceId ?? repo.activeWorkspaceId ?? "";
	const dueCards = useDueCards(workspaceId, tagName);
	const dueLoaded = useDueCardsReady(workspaceId, tagName);
	const [progress, setProgress] = useProperty(usePluginUIStateChildBlock(srsReviewProgressType, deck.id), reviewProgressProp);
	const todayKey = useTodayKey();
	const savedSession = restoreSavedSession(progress, tagName, todayKey);
	const [queue, setQueue] = useState(() => savedSession?.queue ?? null);
	const [index, setIndex] = useState(() => savedSession?.index ?? 0);
	const [revealed, setRevealed] = useState(() => savedSession?.revealed ?? false);
	const [busy, setBusy] = useState(false);
	const [wasRestored] = useState(() => savedSession !== null);
	if (queue === null && dueCards.length > 0) setQueue(dueCards.map((c) => c.id));
	const total = queue?.length ?? 0;
	const currentId = queue && index < queue.length ? queue[index] : null;
	if (queue !== null && index >= queue.length) {
		const fresh = dueCards.filter((card) => !queue.includes(card.id));
		if (fresh.length > 0) {
			setQueue(fresh.map((card_0) => card_0.id));
			setIndex(0);
		}
	}
	const advance = useCallback(() => {
		setRevealed(false);
		setIndex((i) => i + 1);
	}, []);
	const canGoBack = queue !== null && index > 0;
	const goBack = useCallback(() => {
		setRevealed(false);
		setIndex((i_0) => Math.max(0, Math.min(i_0, total) - 1));
	}, [total]);
	const openBlock = useBlockOpener({ plainClick: "navigator" });
	const currentBlock = useMemo(() => currentId ? repo.block(currentId) : null, [repo, currentId]);
	useEffect(() => {
		if (queue === null) return;
		setProgress({
			queue: [...queue],
			index,
			revealed,
			tag: tagName,
			day: todayKey
		});
	}, [
		queue,
		index,
		revealed,
		tagName,
		todayKey,
		setProgress
	]);
	const reconciledRef = useRef(false);
	useEffect(() => {
		if (!wasRestored || reconciledRef.current || !dueLoaded) return;
		reconciledRef.current = true;
		const dueIds = new Set(dueCards.map((c_0) => c_0.id));
		setQueue((prev) => prev === null ? prev : reconcileRestoredQueue(prev, index, dueIds));
	}, [
		wasRestored,
		dueLoaded,
		dueCards,
		index
	]);
	const restart = useCallback(() => {
		setRevealed(false);
		setIndex(0);
		setQueue(null);
		setProgress(null);
	}, [setProgress]);
	const prefetchStart = Math.floor(index / BREADCRUMB_PREFETCH) * BREADCRUMB_PREFETCH;
	const parentsByCardId = useManyParents(useMemo(() => (queue ?? []).slice(prefetchStart, prefetchStart + BREADCRUMB_PREFETCH * 2).map((id) => repo.block(id)), [
		queue,
		repo,
		prefetchStart
	]));
	const currentParents = currentId ? parentsByCardId.get(currentId) ?? EMPTY_PARENTS : EMPTY_PARENTS;
	const { shownId, promote: promoteBreadcrumb } = usePromotableBreadcrumb(currentId ?? "");
	const shownParents = useMemo(() => {
		if (!currentId || shownId === currentId) return currentParents;
		const cut = currentParents.findIndex((p) => p.id === shownId);
		return cut >= 0 ? currentParents.slice(0, cut) : currentParents;
	}, [
		shownId,
		currentId,
		currentParents
	]);
	const grade = useCallback(async (signal) => {
		if (!currentId || busy) return;
		setBusy(true);
		try {
			const block = repo.block(currentId);
			const data = block.peek() ?? await block.load();
			if (!data || !isLiveSrsCard(data)) {
				showInfo("Card is no longer in spaced repetition");
				advance();
				return;
			}
			const result = await rescheduleBlock(block, signal);
			if (result) {
				showInfo(formatRescheduleToastMessage(result));
				advance();
			} else showError("Couldn't reschedule this card");
		} finally {
			setBusy(false);
		}
	}, [
		currentId,
		busy,
		repo,
		advance
	]);
	const archive = useCallback(async () => {
		if (!currentId || busy) return;
		setBusy(true);
		try {
			if (await archiveSrsCard(repo.block(currentId))) {
				showInfo("Archived");
				advance();
			} else showError("Couldn't archive this card");
		} finally {
			setBusy(false);
		}
	}, [
		currentId,
		busy,
		repo,
		advance
	]);
	const reschedule = useCallback(() => {
		if (!currentId) return;
		(async () => {
			if ((await openDialog(ReschedulePicker, { blockId: currentId }))?.rescheduled) advance();
		})();
	}, [currentId, advance]);
	const changeDeck = useCallback(() => {
		deck.set(reviewDeckStartedProp, false);
	}, [deck]);
	const [surfaceFocused, setSurfaceFocused] = useState(false);
	const controller = useMemo(() => ({
		reveal: () => {
			if (!busy) setRevealed(true);
		},
		grade: (signal_0) => {
			if (revealed && !busy) grade(signal_0);
		}
	}), [
		busy,
		revealed,
		grade
	]);
	useActionContextActivations(useMemo(() => [{
		context: SRS_REVIEW_CONTEXT,
		dependencies: { controller },
		enabled: surfaceFocused && currentId !== null
	}], [
		controller,
		surfaceFocused,
		currentId
	]));
	const handleSurfaceFocus = useCallback((e) => {
		setSurfaceFocused(!isInteractiveTarget(e.target));
	}, []);
	const handleSurfaceBlur = useCallback((e_0) => {
		if (!e_0.currentTarget.contains(e_0.relatedTarget)) setSurfaceFocused(false);
	}, []);
	const surfaceRef = useRef(null);
	const focusedOnce = useRef(false);
	const focusSessionSurface = useCallback((el) => {
		surfaceRef.current = el;
		if (el && !focusedOnce.current) {
			focusedOnce.current = true;
			el.focus();
		}
	}, []);
	useEffect(() => {
		if (revealed) surfaceRef.current?.focus();
	}, [revealed]);
	const deckLabel = tagName.trim() ? tagName.trim() : "All due cards";
	const header = /* @__PURE__ */ jsxs("div", {
		className: "mb-4 flex items-center justify-between gap-3",
		children: [
			/* @__PURE__ */ jsxs(Button, {
				type: "button",
				variant: "ghost",
				size: "sm",
				className: "h-7 px-2 text-xs",
				onClick: changeDeck,
				children: [/* @__PURE__ */ jsx(ChevronLeft, { className: "mr-1 h-3.5 w-3.5" }), "Decks"]
			}),
			/* @__PURE__ */ jsx("span", {
				className: "truncate text-sm font-medium text-muted-foreground",
				children: deckLabel
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "flex items-center gap-1",
				children: [/* @__PURE__ */ jsx("span", {
					className: "text-xs tabular-nums text-muted-foreground",
					children: total === 0 ? "" : `${Math.min(index + 1, total)} / ${total}`
				}), queue !== null && /* @__PURE__ */ jsx(Button, {
					type: "button",
					variant: "ghost",
					size: "sm",
					className: "h-7 px-2 text-xs",
					onClick: restart,
					disabled: busy,
					title: "Restart review from the cards due now",
					children: /* @__PURE__ */ jsx(RefreshCw, { className: "h-3.5 w-3.5" })
				})]
			})
		]
	});
	if (queue === null) return /* @__PURE__ */ jsxs("div", {
		className: "mx-auto w-full max-w-2xl py-4",
		children: [header, /* @__PURE__ */ jsxs("div", {
			className: "flex flex-col items-center gap-2 rounded-lg border border-dashed py-12 text-center text-muted-foreground",
			children: [/* @__PURE__ */ jsx(PartyPopper, { className: "h-6 w-6" }), /* @__PURE__ */ jsx("p", {
				className: "font-medium",
				children: "No cards due in this deck"
			})]
		})]
	});
	if (currentId === null) return /* @__PURE__ */ jsxs("div", {
		className: "mx-auto w-full max-w-2xl py-4",
		children: [header, /* @__PURE__ */ jsxs("div", {
			className: "flex flex-col items-center gap-2 rounded-lg border border-dashed py-12 text-center",
			children: [
				/* @__PURE__ */ jsx(PartyPopper, { className: "h-6 w-6 text-emerald-600" }),
				/* @__PURE__ */ jsx("p", {
					className: "font-medium",
					children: "Review complete"
				}),
				/* @__PURE__ */ jsxs("p", {
					className: "text-sm text-muted-foreground",
					children: [
						total,
						" ",
						total === 1 ? "card" : "cards",
						" reviewed."
					]
				}),
				canGoBack && /* @__PURE__ */ jsxs(Button, {
					type: "button",
					variant: "ghost",
					size: "sm",
					className: "mt-1 h-7 px-2 text-xs",
					onClick: goBack,
					children: [/* @__PURE__ */ jsx(ArrowLeft, { className: "mr-1 h-3.5 w-3.5" }), "Back to last card"]
				})
			]
		})]
	});
	const surfaceId = shownId;
	const showingCard = surfaceId === currentId;
	return /* @__PURE__ */ jsxs("div", {
		ref: focusSessionSurface,
		tabIndex: -1,
		onFocus: handleSurfaceFocus,
		onBlur: handleSurfaceBlur,
		className: "mx-auto w-full max-w-2xl py-4 outline-none",
		children: [
			header,
			shownParents.length > 0 && /* @__PURE__ */ jsx(PromotableBreadcrumbList, {
				parents: shownParents,
				workspaceId,
				overrides: BREADCRUMB_OVERRIDES,
				onPromote: promoteBreadcrumb,
				className: "mb-2 flex flex-wrap items-center gap-1 overflow-x-auto py-1 text-sm text-muted-foreground",
				itemClassName: "max-w-full cursor-pointer truncate no-underline",
				separatorClassName: "mx-1 text-muted-foreground/50"
			}),
			/* @__PURE__ */ jsx("div", {
				className: "rounded-xl border bg-card p-4 shadow-sm",
				children: /* @__PURE__ */ jsx(NestedBlockContextProvider, {
					overrides: showingCard ? {
						[SRS_REVIEW_CARD_ID]: currentId,
						[SRS_REVIEW_REVEALED]: revealed,
						isNestedSurface: true,
						scopeRootId: currentId,
						renderScopeId: `srs-review:${currentId}`
					} : {
						isNestedSurface: true,
						scopeRootId: surfaceId,
						renderScopeId: `srs-review:${currentId}:${surfaceId}`
					},
					children: /* @__PURE__ */ jsx(BlockComponent, { blockId: surfaceId }, surfaceId)
				})
			}),
			/* @__PURE__ */ jsx("div", {
				className: "mt-4",
				children: !revealed ? /* @__PURE__ */ jsxs(Button, {
					type: "button",
					className: "w-full",
					onClick: () => setRevealed(true),
					disabled: busy,
					children: ["Show answer", /* @__PURE__ */ jsx("span", {
						className: "ml-2 text-xs opacity-70",
						children: "space"
					})]
				}) : currentBlock ? /* @__PURE__ */ jsx(GradeButtons, {
					card: currentBlock,
					busy,
					onGrade: (signal_1) => void grade(signal_1)
				}) : null
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "mt-3 flex flex-wrap items-center justify-center gap-4 text-xs text-muted-foreground",
				children: [
					/* @__PURE__ */ jsxs("button", {
						type: "button",
						className: "inline-flex items-center gap-1 hover:text-foreground disabled:opacity-50",
						onClick: goBack,
						disabled: busy || !canGoBack,
						children: [/* @__PURE__ */ jsx(ArrowLeft, { className: "h-3.5 w-3.5" }), "Previous"]
					}),
					/* @__PURE__ */ jsxs("button", {
						type: "button",
						className: "inline-flex items-center gap-1 hover:text-foreground disabled:opacity-50",
						onClick: advance,
						disabled: busy,
						children: [/* @__PURE__ */ jsx(SkipForward, { className: "h-3.5 w-3.5" }), "Skip"]
					}),
					/* @__PURE__ */ jsxs("button", {
						type: "button",
						className: "inline-flex items-center gap-1 hover:text-foreground disabled:opacity-50",
						onClick: (e_1) => openBlock(e_1, {
							blockId: currentId,
							workspaceId
						}),
						disabled: busy,
						children: [/* @__PURE__ */ jsx(ExternalLink, { className: "h-3.5 w-3.5" }), "Open"]
					}),
					/* @__PURE__ */ jsxs("button", {
						type: "button",
						className: "inline-flex items-center gap-1 hover:text-foreground disabled:opacity-50",
						onClick: reschedule,
						disabled: busy,
						children: [/* @__PURE__ */ jsx(CalendarClock, { className: "h-3.5 w-3.5" }), "Reschedule"]
					}),
					/* @__PURE__ */ jsxs("button", {
						type: "button",
						className: "inline-flex items-center gap-1 hover:text-foreground disabled:opacity-50",
						onClick: () => void archive(),
						disabled: busy,
						children: [/* @__PURE__ */ jsx(ArchiveX, { className: "h-3.5 w-3.5" }), "Archive"]
					})
				]
			})
		]
	});
};
//#endregion
export { ReviewSession };

//# sourceMappingURL=ReviewSession.js.map