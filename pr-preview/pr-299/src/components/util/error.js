import { Button } from "../ui/button.js";
import { useSignOut } from "../Login.js";
import { corruptErrorUserId } from "../../utils/localDbCorruption.js";
import { getLocalDbCorruptionSnapshot, subscribeLocalDbCorruption } from "../../data/localDbCorruptionSignal.js";
import { LocalDbCorruptionFallback } from "./LocalDbCorruptionFallback.js";
import { useSyncExternalStore } from "react";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/components/util/error.tsx
var errorMessage = (error) => error instanceof Error ? error.message : String(error);
/**
* Bridges a RUNTIME local-DB corruption into the bootstrap ErrorBoundary. A
* corrupt already-open DB surfaces inside the PowerSync sync worker, not as a
* React render throw, so nothing would reach the boundary. Mounted as a sibling
* of RepoProvider INSIDE the ErrorBoundary, this reads the latched signal and
* throws it during render → BootstrapErrorFallback → LocalDbCorruptionFallback
* (same Export + Reset flow as the open-time case). See localDbCorruptionSignal.
*/
function LocalDbCorruptionSentinel() {
	const error = useSyncExternalStore(subscribeLocalDbCorruption, getLocalDbCorruptionSnapshot);
	if (error) throw error;
	return null;
}
function FallbackComponent(t0) {
	const $ = c(4);
	const { error } = t0;
	let t1;
	if ($[0] !== error) {
		t1 = errorMessage(error);
		$[0] = error;
		$[1] = t1;
	} else t1 = $[1];
	let t2;
	if ($[2] !== t1) {
		t2 = /* @__PURE__ */ jsxs("div", { children: ["Something went wrong: ", t1] });
		$[2] = t1;
		$[3] = t2;
	} else t2 = $[3];
	return t2;
}
function BootstrapErrorFallback(t0) {
	const $ = c(9);
	const { error } = t0;
	let t1;
	if ($[0] !== error) {
		t1 = corruptErrorUserId(error);
		$[0] = error;
		$[1] = t1;
	} else t1 = $[1];
	const corruptUserId = t1;
	if (corruptUserId !== null) {
		let t2;
		if ($[2] !== error) {
			t2 = errorMessage(error);
			$[2] = error;
			$[3] = t2;
		} else t2 = $[3];
		let t3;
		if ($[4] !== corruptUserId || $[5] !== t2) {
			t3 = /* @__PURE__ */ jsx(LocalDbCorruptionFallback, {
				userId: corruptUserId,
				detail: t2
			});
			$[4] = corruptUserId;
			$[5] = t2;
			$[6] = t3;
		} else t3 = $[6];
		return t3;
	}
	let t2;
	if ($[7] !== error) {
		t2 = /* @__PURE__ */ jsx(GenericBootstrapErrorFallback, { error });
		$[7] = error;
		$[8] = t2;
	} else t2 = $[8];
	return t2;
}
function GenericBootstrapErrorFallback(t0) {
	const $ = c(13);
	const { error } = t0;
	const signOut = useSignOut();
	let t1;
	if ($[0] !== signOut) {
		t1 = async () => {
			try {
				await signOut();
			} catch (t2) {
				console.error("Sign-out failed", t2);
				window.location.reload();
			}
		};
		$[0] = signOut;
		$[1] = t1;
	} else t1 = $[1];
	const handleSignOut = t1;
	let t2;
	if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
		t2 = /* @__PURE__ */ jsxs("div", {
			className: "space-y-1",
			children: [/* @__PURE__ */ jsx("h1", {
				className: "text-lg font-semibold",
				children: "Something went wrong"
			}), /* @__PURE__ */ jsx("p", {
				className: "text-sm text-muted-foreground",
				children: "We couldn't open your workspace. Try reloading — if that doesn't help, sign out to fully reset."
			})]
		});
		$[2] = t2;
	} else t2 = $[2];
	let t3;
	if ($[3] !== error) {
		t3 = errorMessage(error);
		$[3] = error;
		$[4] = t3;
	} else t3 = $[4];
	let t4;
	if ($[5] !== t3) {
		t4 = /* @__PURE__ */ jsx("pre", {
			className: "max-h-32 overflow-auto rounded bg-muted p-2 text-xs text-muted-foreground",
			children: t3
		});
		$[5] = t3;
		$[6] = t4;
	} else t4 = $[6];
	let t5;
	if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
		t5 = /* @__PURE__ */ jsx(Button, {
			onClick: _temp,
			className: "flex-1",
			children: "Reload"
		});
		$[7] = t5;
	} else t5 = $[7];
	let t6;
	if ($[8] !== handleSignOut) {
		t6 = /* @__PURE__ */ jsxs("div", {
			className: "flex flex-col gap-2 sm:flex-row",
			children: [t5, /* @__PURE__ */ jsx(Button, {
				variant: "outline",
				onClick: () => void handleSignOut(),
				className: "flex-1",
				children: "Sign out"
			})]
		});
		$[8] = handleSignOut;
		$[9] = t6;
	} else t6 = $[9];
	let t7;
	if ($[10] !== t4 || $[11] !== t6) {
		t7 = /* @__PURE__ */ jsx("div", {
			className: "flex min-h-screen items-center justify-center px-6",
			children: /* @__PURE__ */ jsxs("div", {
				className: "w-full max-w-md space-y-4 rounded-lg border bg-card p-6 shadow-sm",
				children: [
					t2,
					t4,
					t6
				]
			})
		});
		$[10] = t4;
		$[11] = t6;
		$[12] = t7;
	} else t7 = $[12];
	return t7;
}
function _temp() {
	return window.location.reload();
}
//#endregion
export { BootstrapErrorFallback, FallbackComponent, LocalDbCorruptionSentinel };

//# sourceMappingURL=error.js.map