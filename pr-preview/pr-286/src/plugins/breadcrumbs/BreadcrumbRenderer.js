import { MarkdownContentRenderer } from "../../components/renderer/MarkdownContentRenderer.js";
import { getBreadcrumbContentPreview } from "./breadcrumbPreview.js";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/plugins/breadcrumbs/BreadcrumbRenderer.tsx
var BreadcrumbRenderer = (props) => {
	const $ = c(2);
	let t0;
	if ($[0] !== props) {
		t0 = /* @__PURE__ */ jsx(MarkdownContentRenderer, {
			...props,
			contentTransform: getBreadcrumbContentPreview,
			containerElement: "span",
			containerClassName: "inline min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap align-baseline [&>*]:inline [&>*]:m-0 [&>*]:font-normal [&>*]:text-inherit"
		});
		$[0] = props;
		$[1] = t0;
	} else t0 = $[1];
	return t0;
};
BreadcrumbRenderer.canRender = ({ context }) => !!context?.isBreadcrumb;
BreadcrumbRenderer.priority = () => 10;
//#endregion
export { BreadcrumbRenderer };

//# sourceMappingURL=BreadcrumbRenderer.js.map