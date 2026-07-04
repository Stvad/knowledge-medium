import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/agent-runtime/BridgePairingDialog.tsx
/**
* Confirmation gate for link-initiated bridge pairing. A crafted link
* can put an `agent-runtime-url` / `agent-runtime-secret` in the page
* hash; honoring it silently would let any page redirect the bridge and
* exfiltrate the user's agent tokens (and run arbitrary commands as
* them). So persistence of a hash-supplied pairing is gated behind this
* explicit, user-driven confirmation — `resolve(true)` means "pair",
* cancel means "don't".
*/
function BridgePairingDialog(t0) {
	const $ = c(25);
	const { url, hasSecret, resolve, cancel } = t0;
	let t1;
	if ($[0] !== cancel) {
		t1 = (next) => {
			if (!next) cancel();
		};
		$[0] = cancel;
		$[1] = t1;
	} else t1 = $[1];
	let t2;
	if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
		t2 = /* @__PURE__ */ jsx(DialogTitle, { children: "Connect to local agent bridge?" });
		$[2] = t2;
	} else t2 = $[2];
	let t3;
	if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
		t3 = /* @__PURE__ */ jsxs(DialogHeader, { children: [t2, /* @__PURE__ */ jsxs(DialogDescription, { children: [
			"A link is asking to connect this workspace to a local agent runtime bridge. Once connected, a process on this machine can read and modify this workspace as you — including running code. Only continue if you just started this from your own terminal (e.g. ",
			/* @__PURE__ */ jsx("code", { children: "yarn agent connect" }),
			")."
		] })] });
		$[3] = t3;
	} else t3 = $[3];
	let t4;
	if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
		t4 = /* @__PURE__ */ jsx("p", {
			className: "text-xs font-medium text-muted-foreground",
			children: "Bridge URL"
		});
		$[4] = t4;
	} else t4 = $[4];
	let t5;
	if ($[5] !== url) {
		t5 = /* @__PURE__ */ jsx("code", {
			className: "block min-w-0 break-all text-xs font-mono",
			children: url
		});
		$[5] = url;
		$[6] = t5;
	} else t5 = $[6];
	let t6;
	if ($[7] !== hasSecret) {
		t6 = hasSecret && /* @__PURE__ */ jsx("p", {
			className: "text-xs text-muted-foreground",
			children: "The link also supplied a pairing secret for this bridge."
		});
		$[7] = hasSecret;
		$[8] = t6;
	} else t6 = $[8];
	let t7;
	if ($[9] !== t5 || $[10] !== t6) {
		t7 = /* @__PURE__ */ jsxs("div", {
			className: "min-w-0 rounded-md border bg-muted/40 p-3 space-y-1",
			children: [
				t4,
				t5,
				t6
			]
		});
		$[9] = t5;
		$[10] = t6;
		$[11] = t7;
	} else t7 = $[11];
	let t8;
	if ($[12] !== cancel) {
		t8 = /* @__PURE__ */ jsx(Button, {
			type: "button",
			variant: "outline",
			onClick: () => cancel(),
			children: "Cancel"
		});
		$[12] = cancel;
		$[13] = t8;
	} else t8 = $[13];
	let t9;
	if ($[14] !== resolve) {
		t9 = /* @__PURE__ */ jsx(Button, {
			type: "button",
			onClick: () => resolve(true),
			children: "Pair"
		});
		$[14] = resolve;
		$[15] = t9;
	} else t9 = $[15];
	let t10;
	if ($[16] !== t8 || $[17] !== t9) {
		t10 = /* @__PURE__ */ jsxs(DialogFooter, { children: [t8, t9] });
		$[16] = t8;
		$[17] = t9;
		$[18] = t10;
	} else t10 = $[18];
	let t11;
	if ($[19] !== t10 || $[20] !== t7) {
		t11 = /* @__PURE__ */ jsxs(DialogContent, {
			className: "max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] overflow-y-auto",
			children: [
				t3,
				t7,
				t10
			]
		});
		$[19] = t10;
		$[20] = t7;
		$[21] = t11;
	} else t11 = $[21];
	let t12;
	if ($[22] !== t1 || $[23] !== t11) {
		t12 = /* @__PURE__ */ jsx(Dialog, {
			open: true,
			onOpenChange: t1,
			children: t11
		});
		$[22] = t1;
		$[23] = t11;
		$[24] = t12;
	} else t12 = $[24];
	return t12;
}
//#endregion
export { BridgePairingDialog };

//# sourceMappingURL=BridgePairingDialog.js.map