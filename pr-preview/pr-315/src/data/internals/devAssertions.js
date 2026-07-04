//#region src/data/internals/devAssertions.ts
var enabled = false;
/** True when L2 dev/test invariant assertions should run. */
var devAssertionsEnabled = () => enabled;
/** Enable/disable L2 assertions. Called by the dev app bootstrap (main.tsx,
*  gated on import.meta.env.DEV) and the vitest setup; off everywhere else. */
var setDevAssertionsEnabled = (value) => {
	enabled = value;
};
//#endregion
export { devAssertionsEnabled, setDevAssertionsEnabled };

//# sourceMappingURL=devAssertions.js.map