import { __exportAll } from "../../../_virtual/_rolldown/runtime.js";
import { cn } from "../../lib/utils.js";
import "react";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/components/ui/card.tsx
var card_exports = /* @__PURE__ */ __exportAll({
	Card: () => Card,
	CardContent: () => CardContent,
	CardDescription: () => CardDescription,
	CardFooter: () => CardFooter,
	CardHeader: () => CardHeader,
	CardTitle: () => CardTitle
});
var Card = (t0) => {
	const $ = c(8);
	let className;
	let props;
	if ($[0] !== t0) {
		({className, ...props} = t0);
		$[0] = t0;
		$[1] = className;
		$[2] = props;
	} else {
		className = $[1];
		props = $[2];
	}
	let t1;
	if ($[3] !== className) {
		t1 = cn("rounded-lg border bg-card text-card-foreground shadow-sm", className);
		$[3] = className;
		$[4] = t1;
	} else t1 = $[4];
	let t2;
	if ($[5] !== props || $[6] !== t1) {
		t2 = /* @__PURE__ */ jsx("div", {
			className: t1,
			...props
		});
		$[5] = props;
		$[6] = t1;
		$[7] = t2;
	} else t2 = $[7];
	return t2;
};
Card.displayName = "Card";
var CardHeader = (t0) => {
	const $ = c(8);
	let className;
	let props;
	if ($[0] !== t0) {
		({className, ...props} = t0);
		$[0] = t0;
		$[1] = className;
		$[2] = props;
	} else {
		className = $[1];
		props = $[2];
	}
	let t1;
	if ($[3] !== className) {
		t1 = cn("flex flex-col space-y-1.5 p-6", className);
		$[3] = className;
		$[4] = t1;
	} else t1 = $[4];
	let t2;
	if ($[5] !== props || $[6] !== t1) {
		t2 = /* @__PURE__ */ jsx("div", {
			className: t1,
			...props
		});
		$[5] = props;
		$[6] = t1;
		$[7] = t2;
	} else t2 = $[7];
	return t2;
};
CardHeader.displayName = "CardHeader";
var CardTitle = (t0) => {
	const $ = c(8);
	let className;
	let props;
	if ($[0] !== t0) {
		({className, ...props} = t0);
		$[0] = t0;
		$[1] = className;
		$[2] = props;
	} else {
		className = $[1];
		props = $[2];
	}
	let t1;
	if ($[3] !== className) {
		t1 = cn("text-2xl font-semibold leading-none tracking-tight", className);
		$[3] = className;
		$[4] = t1;
	} else t1 = $[4];
	let t2;
	if ($[5] !== props || $[6] !== t1) {
		t2 = /* @__PURE__ */ jsx("h3", {
			className: t1,
			...props
		});
		$[5] = props;
		$[6] = t1;
		$[7] = t2;
	} else t2 = $[7];
	return t2;
};
CardTitle.displayName = "CardTitle";
var CardDescription = (t0) => {
	const $ = c(8);
	let className;
	let props;
	if ($[0] !== t0) {
		({className, ...props} = t0);
		$[0] = t0;
		$[1] = className;
		$[2] = props;
	} else {
		className = $[1];
		props = $[2];
	}
	let t1;
	if ($[3] !== className) {
		t1 = cn("text-sm text-muted-foreground", className);
		$[3] = className;
		$[4] = t1;
	} else t1 = $[4];
	let t2;
	if ($[5] !== props || $[6] !== t1) {
		t2 = /* @__PURE__ */ jsx("p", {
			className: t1,
			...props
		});
		$[5] = props;
		$[6] = t1;
		$[7] = t2;
	} else t2 = $[7];
	return t2;
};
CardDescription.displayName = "CardDescription";
var CardContent = (t0) => {
	const $ = c(8);
	let className;
	let props;
	if ($[0] !== t0) {
		({className, ...props} = t0);
		$[0] = t0;
		$[1] = className;
		$[2] = props;
	} else {
		className = $[1];
		props = $[2];
	}
	let t1;
	if ($[3] !== className) {
		t1 = cn("p-6 pt-0", className);
		$[3] = className;
		$[4] = t1;
	} else t1 = $[4];
	let t2;
	if ($[5] !== props || $[6] !== t1) {
		t2 = /* @__PURE__ */ jsx("div", {
			className: t1,
			...props
		});
		$[5] = props;
		$[6] = t1;
		$[7] = t2;
	} else t2 = $[7];
	return t2;
};
CardContent.displayName = "CardContent";
var CardFooter = (t0) => {
	const $ = c(8);
	let className;
	let props;
	if ($[0] !== t0) {
		({className, ...props} = t0);
		$[0] = t0;
		$[1] = className;
		$[2] = props;
	} else {
		className = $[1];
		props = $[2];
	}
	let t1;
	if ($[3] !== className) {
		t1 = cn("flex items-center p-6 pt-0", className);
		$[3] = className;
		$[4] = t1;
	} else t1 = $[4];
	let t2;
	if ($[5] !== props || $[6] !== t1) {
		t2 = /* @__PURE__ */ jsx("div", {
			className: t1,
			...props
		});
		$[5] = props;
		$[6] = t1;
		$[7] = t2;
	} else t2 = $[7];
	return t2;
};
CardFooter.displayName = "CardFooter";
//#endregion
export { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, card_exports };

//# sourceMappingURL=card.js.map