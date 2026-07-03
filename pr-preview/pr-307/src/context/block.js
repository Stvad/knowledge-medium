import { createContext, useContext, useState } from "react";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/context/block.tsx
var BlockContext = createContext({});
var shallowEqual = (a, b) => {
	if (Object.is(a, b)) return true;
	const ka = Object.keys(a);
	const kb = Object.keys(b);
	if (ka.length !== kb.length) return false;
	for (const k of ka) if (!Object.is(a[k], b[k])) return false;
	return true;
};
/** Shallow-equal stabilizer: return the previous reference whenever
*  every own key in `next` is `Object.is`-equal to the corresponding
*  key in the previous value. Callers can then pass inline object
*  literals without forcing every downstream consumer of the context
*  to re-render. Context propagation goes by identity — even with
*  React Compiler auto-memoizing JSX inputs and `React.memo`
*  gating props, a new context value reaches every consumer.
*
*  Implemented via "adjusting state during render" (see React docs):
*  when `next` diverges from the stored reference, schedule an update
*  and return the new value for this render, so consumers see the
*  fresh values without a one-frame delay. */
var useStableShallow = (next) => {
	const [stable, setStable] = useState(next);
	if (stable !== next && !shallowEqual(stable, next)) {
		setStable(next);
		return next;
	}
	return stable;
};
var BlockContextProvider = (t0) => {
	const $ = c(3);
	const { children, initialValue } = t0;
	const stable = useStableShallow(initialValue);
	let t1;
	if ($[0] !== children || $[1] !== stable) {
		t1 = /* @__PURE__ */ jsx(BlockContext, {
			value: stable,
			children
		});
		$[0] = children;
		$[1] = stable;
		$[2] = t1;
	} else t1 = $[2];
	return t1;
};
var NestedBlockContextProvider = (t0) => {
	const $ = c(6);
	const { children, overrides } = t0;
	const context = useContext(BlockContext);
	const stableOverrides = useStableShallow(overrides);
	let t1;
	if ($[0] !== context || $[1] !== stableOverrides) {
		t1 = {
			...context,
			...stableOverrides
		};
		$[0] = context;
		$[1] = stableOverrides;
		$[2] = t1;
	} else t1 = $[2];
	const value = t1;
	let t2;
	if ($[3] !== children || $[4] !== value) {
		t2 = /* @__PURE__ */ jsx(BlockContext, {
			value,
			children
		});
		$[3] = children;
		$[4] = value;
		$[5] = t2;
	} else t2 = $[5];
	return t2;
};
var useBlockContext = () => {
	const context = useContext(BlockContext);
	if (!context) throw new Error("useBlockContext must be used within a BlockContextProvider");
	return context;
};
//#endregion
export { BlockContextProvider, NestedBlockContextProvider, useBlockContext };

//# sourceMappingURL=block.js.map