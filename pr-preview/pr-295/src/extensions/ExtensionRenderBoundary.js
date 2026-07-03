import { m } from "../../node_modules/react-error-boundary/dist/react-error-boundary.js";
import { FallbackComponent } from "../components/util/error.js";
import { Suspense } from "react";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/extensions/ExtensionRenderBoundary.tsx
function ExtensionRenderBoundary(t0) {
	const $ = c(3);
	const { children, suspenseFallback: t1 } = t0;
	const suspenseFallback = t1 === void 0 ? null : t1;
	let t2;
	if ($[0] !== children || $[1] !== suspenseFallback) {
		t2 = /* @__PURE__ */ jsx(m, {
			FallbackComponent,
			children: /* @__PURE__ */ jsx(Suspense, {
				fallback: suspenseFallback,
				children
			})
		});
		$[0] = children;
		$[1] = suspenseFallback;
		$[2] = t2;
	} else t2 = $[2];
	return t2;
}
//#endregion
export { ExtensionRenderBoundary };

//# sourceMappingURL=ExtensionRenderBoundary.js.map