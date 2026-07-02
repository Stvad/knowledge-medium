import { Block } from "../../data/block.js";
import { usePropertyEditingShortcuts } from "../../shortcuts/useActionContext.js";
import { useState } from "react";
import { c } from "react/compiler-runtime";
//#region src/components/propertyPanel/usePropertyEditingActivation.ts
/**
* Activate the `PROPERTY_EDITING` shortcut context while the returned
* handlers' input has focus. PROPERTY_EDITING is `modal: true`, so once
* active it shadows underlying block-scoped bindings — typing into a
* property input no longer fires vim-normal-mode's `shift+p` / `cmd+d`
* etc. on the surrounding block. Deactivates on blur.
*
* Accepts `unknown` for `block` so per-shape editor signatures
* (`PropertyEditorProps.block: unknown`) can call this hook without
* narrowing at every call site. When `block` isn't a `Block` instance
* activation is skipped (the standard hook chain's `enabled=false` path).
*
* Inputs already wired with their own `onFocus`/`onBlur` should compose
* with these handlers — call both, the order doesn't matter.
*/
function usePropertyEditingActivation(block) {
	const $ = c(6);
	const targetBlock = block instanceof Block ? block : null;
	const [input, setInput] = useState(null);
	let t0;
	if ($[0] !== input || $[1] !== targetBlock) {
		t0 = {
			block: targetBlock,
			input
		};
		$[0] = input;
		$[1] = targetBlock;
		$[2] = t0;
	} else t0 = $[2];
	usePropertyEditingShortcuts(t0, targetBlock !== null && input !== null);
	let t1;
	if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = (event) => {
			setInput(event.currentTarget);
		};
		$[3] = t1;
	} else t1 = $[3];
	const onFocus = t1;
	let t2;
	if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
		t2 = () => setInput(null);
		$[4] = t2;
	} else t2 = $[4];
	const onBlur = t2;
	let t3;
	if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
		t3 = {
			onFocus,
			onBlur
		};
		$[5] = t3;
	} else t3 = $[5];
	return t3;
}
//#endregion
export { usePropertyEditingActivation };

//# sourceMappingURL=usePropertyEditingActivation.js.map