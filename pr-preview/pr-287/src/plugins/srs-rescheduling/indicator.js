//#region src/plugins/srs-rescheduling/indicator.ts
var BAR_BASE = "srs-review-block border-l-2 pl-1";
var srsBarClass = (state) => {
	if (state.archived) return `${BAR_BASE} srs-review-block--archived border-muted-foreground/40 border-dashed`;
	if (state.reviewCount === 0) return `${BAR_BASE} border-sky-500/40 border-dashed`;
	const i = state.interval;
	if (i <= 3) return `${BAR_BASE} border-sky-500`;
	if (i <= 10) return `${BAR_BASE} border-sky-500/75`;
	if (i <= 30) return `${BAR_BASE} border-sky-500/50`;
	if (i <= 90) return `${BAR_BASE} border-sky-500/30`;
	return `${BAR_BASE} border-sky-500/15`;
};
var formatInterval = (interval) => {
	return (Math.round(interval * 10) / 10).toString();
};
var formatFactor = (factor) => {
	return (Math.round(factor * 100) / 100).toString();
};
var srsIndicatorTitle = (state) => {
	if (state.archived) return "SRS · archived";
	if (state.reviewCount === 0) return "SRS · new (not yet reviewed)";
	const reviews = `${state.reviewCount} review${state.reviewCount === 1 ? "" : "s"}`;
	return `SRS · ${formatInterval(state.interval)}d interval · ${formatFactor(state.factor)} factor · ${reviews}`;
};
//#endregion
export { srsBarClass, srsIndicatorTitle };

//# sourceMappingURL=indicator.js.map