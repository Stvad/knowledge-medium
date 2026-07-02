import { typesProp } from "../../data/properties.js";
import { systemToggle } from "../../facets/togglable.js";
import { TODO_TYPE, roamTodoStateProp, statusProp, todoType } from "./schema.js";
import { todoDataExtension } from "./dataExtension.js";
import { usePropertyValue } from "../../hooks/block.js";
import { blockContentDecoratorsFacet } from "../../extensions/blockInteraction.js";
import { cycleTodoState, todoActions, todoActionsExtension } from "./actions.js";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/todo/index.tsx
var nextStatus = (checked) => checked ? "done" : "open";
var TodoContentDecorator = (t0) => {
	const $ = c(19);
	const { block, Inner } = t0;
	const [types] = usePropertyValue(block, typesProp);
	const [status, setStatus] = usePropertyValue(block, statusProp);
	if (!types.includes("todo")) {
		let t1;
		if ($[0] !== Inner || $[1] !== block) {
			t1 = /* @__PURE__ */ jsx(Inner, { block });
			$[0] = Inner;
			$[1] = block;
			$[2] = t1;
		} else t1 = $[2];
		return t1;
	}
	const done = status === "done";
	const t1 = done ? "Mark todo open" : "Mark todo done";
	let t2;
	if ($[3] !== setStatus) {
		t2 = (event_0) => {
			event_0.stopPropagation();
			setStatus(nextStatus(event_0.currentTarget.checked));
		};
		$[3] = setStatus;
		$[4] = t2;
	} else t2 = $[4];
	let t3;
	if ($[5] !== block.repo.isReadOnly || $[6] !== done || $[7] !== t1 || $[8] !== t2) {
		t3 = /* @__PURE__ */ jsx("input", {
			"aria-label": t1,
			type: "checkbox",
			checked: done,
			disabled: block.repo.isReadOnly,
			"data-block-interaction": "ignore",
			className: "mt-1 h-4 w-4 shrink-0 rounded border-border accent-primary",
			onClick: _temp,
			onChange: t2
		});
		$[5] = block.repo.isReadOnly;
		$[6] = done;
		$[7] = t1;
		$[8] = t2;
		$[9] = t3;
	} else t3 = $[9];
	const t4 = done ? "min-w-0 flex-1 text-muted-foreground line-through" : "min-w-0 flex-1";
	let t5;
	if ($[10] !== Inner || $[11] !== block) {
		t5 = /* @__PURE__ */ jsx(Inner, { block });
		$[10] = Inner;
		$[11] = block;
		$[12] = t5;
	} else t5 = $[12];
	let t6;
	if ($[13] !== t4 || $[14] !== t5) {
		t6 = /* @__PURE__ */ jsx("div", {
			className: t4,
			children: t5
		});
		$[13] = t4;
		$[14] = t5;
		$[15] = t6;
	} else t6 = $[15];
	let t7;
	if ($[16] !== t3 || $[17] !== t6) {
		t7 = /* @__PURE__ */ jsxs("div", {
			className: "flex items-start gap-2",
			children: [t3, t6]
		});
		$[16] = t3;
		$[17] = t6;
		$[18] = t7;
	} else t7 = $[18];
	return t7;
};
var todoDecoratorCache = /* @__PURE__ */ new WeakMap();
var decorateTodoContent = (inner) => {
	const cached = todoDecoratorCache.get(inner);
	if (cached) return cached;
	const Decorated = (t0) => {
		const $ = c(2);
		const { block } = t0;
		let t1;
		if ($[0] !== block) {
			t1 = /* @__PURE__ */ jsx(TodoContentDecorator, {
				block,
				Inner: inner
			});
			$[0] = block;
			$[1] = t1;
		} else t1 = $[1];
		return t1;
	};
	Decorated.displayName = "WithTodoCheckbox";
	todoDecoratorCache.set(inner, Decorated);
	return Decorated;
};
var todoContentDecoratorContribution = () => decorateTodoContent;
var todoPlugin = systemToggle({
	id: "system:todo",
	name: "Todo",
	description: "Checkbox / done-state property on blocks."
}).of([
	todoDataExtension,
	todoActionsExtension,
	blockContentDecoratorsFacet.of(todoContentDecoratorContribution, { source: "todo" })
]);
function _temp(event) {
	return event.stopPropagation();
}
//#endregion
export { TODO_TYPE, cycleTodoState, roamTodoStateProp, statusProp, todoActions, todoDataExtension, todoPlugin, todoType };

//# sourceMappingURL=index.js.map