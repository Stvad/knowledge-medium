//#region src/plugins/srs-rescheduling/scheduler.ts
var SrsSignal = /* @__PURE__ */ function(SrsSignal) {
	SrsSignal[SrsSignal["AGAIN"] = 1] = "AGAIN";
	SrsSignal[SrsSignal["HARD"] = 1 + SrsSignal["AGAIN"]] = "HARD";
	SrsSignal[SrsSignal["GOOD"] = 1 + SrsSignal["HARD"]] = "GOOD";
	SrsSignal[SrsSignal["EASY"] = 1 + SrsSignal["GOOD"]] = "EASY";
	SrsSignal[SrsSignal["SOONER"] = 1 + SrsSignal["EASY"]] = "SOONER";
	return SrsSignal;
}({});
var srsSignals = [
	SrsSignal.AGAIN,
	SrsSignal.HARD,
	SrsSignal.GOOD,
	SrsSignal.EASY,
	SrsSignal.SOONER
];
var DEFAULT_FACTOR = 2.5;
var DEFAULT_INTERVAL = 2;
var MAX_INTERVAL = 50 * 365;
var MIN_FACTOR = 1.3;
var HARD_FACTOR = 1.3;
var SOONER_FACTOR = .75;
var JITTER_PERCENTAGE = .05;
var FACTOR_MODIFIER = .15;
var addDays = (date, days) => {
	const next = new Date(date);
	next.setDate(date.getDate() + days);
	return next;
};
var randomFromInterval = (min, max, random) => random() * (max - min) + min;
var enforceLimits = ({ interval, factor }) => ({
	interval: Math.min(interval, MAX_INTERVAL),
	factor: Math.max(factor, MIN_FACTOR)
});
var addJitter = ({ interval, factor }, random) => {
	const jitter = interval * JITTER_PERCENTAGE;
	return {
		interval: interval + randomFromInterval(-jitter, jitter, random),
		factor
	};
};
var getNewSrsParametersFromValues = ({ interval, factor }, signal, random = Math.random) => {
	let newFactor = factor;
	let newInterval = interval;
	switch (signal) {
		case SrsSignal.AGAIN:
			newFactor = factor - .2;
			newInterval = 1;
			break;
		case SrsSignal.HARD:
			newFactor = factor - FACTOR_MODIFIER;
			newInterval = interval * HARD_FACTOR;
			break;
		case SrsSignal.GOOD:
			newInterval = interval * factor;
			break;
		case SrsSignal.EASY:
			newInterval = interval * factor;
			newFactor = factor + FACTOR_MODIFIER;
			break;
		case SrsSignal.SOONER:
			newInterval = interval * SOONER_FACTOR;
			break;
	}
	return enforceLimits(addJitter({
		interval: newInterval,
		factor: newFactor
	}, random));
};
/** Projected next interval (in days, un-rounded) for `signal` given the
*  card's current params, computed with the jitter neutralised
*  (`random() = 0.5` is the midpoint of the ±jitter range, so it cancels)
*  so the value is stable enough to show as a pre-grade estimate on the
*  review buttons. The committed reschedule re-applies real jitter, so the
*  card can land ±`JITTER_PERCENTAGE` off this — fine for an estimate.
*  Feed the result through the same `formatIntervalDays` the toast uses so
*  the button label and the post-grade toast agree. */
var estimateSrsIntervalDays = (params, signal) => getNewSrsParametersFromValues(params, signal, () => .5).interval;
var scheduleSrsProperties = (params, signal, options = {}) => {
	const now = options.now ?? /* @__PURE__ */ new Date();
	const next = getNewSrsParametersFromValues(params, signal, options.random ?? Math.random);
	return {
		...next,
		nextReviewDate: addDays(now, Math.ceil(next.interval))
	};
};
//#endregion
export { DEFAULT_FACTOR, DEFAULT_INTERVAL, SrsSignal, estimateSrsIntervalDays, getNewSrsParametersFromValues, scheduleSrsProperties, srsSignals };

//# sourceMappingURL=scheduler.js.map