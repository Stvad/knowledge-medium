import { useHandle } from "../../hooks/block.js";
import { useAppRuntime } from "../../extensions/runtimeContext.js";
import { useBlockContext } from "../../context/block.js";
import { Markdown } from "../../../node_modules/react-markdown/lib/index.js";
import { markdownExtensionsFacet } from "../../markdown/extensions.js";
import { Fragment } from "react";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/components/renderer/MarkdownContentRenderer.tsx
var DEFAULT_CONTAINER_CLASS = "min-h-[1.7em] whitespace-pre-wrap overflow-x-clip overflow-y-visible max-w-full";
var inlineComponents = { p: ({ children }) => /* @__PURE__ */ jsx(Fragment, { children }) };
function MarkdownContentRenderer(t0) {
	const $ = c(20);
	const { block, contentTransform, containerClassName, containerElement } = t0;
	let t1;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = { selector: _temp };
		$[0] = t1;
	} else t1 = $[0];
	const renderData = useHandle(block, t1);
	const blockContext = useBlockContext();
	const runtime = useAppRuntime();
	if (!renderData) return null;
	const inline = blockContext.isReference === true;
	const Container = containerElement ?? (inline ? "span" : "div");
	const className = containerClassName ?? (inline ? "" : DEFAULT_CONTAINER_CLASS);
	let t2;
	if ($[1] !== block || $[2] !== blockContext || $[3] !== renderData || $[4] !== runtime) {
		t2 = runtime.read(markdownExtensionsFacet)({
			block,
			blockContext,
			data: renderData
		});
		$[1] = block;
		$[2] = blockContext;
		$[3] = renderData;
		$[4] = runtime;
		$[5] = t2;
	} else t2 = $[5];
	const markdownConfig = t2;
	let t3;
	if ($[6] !== inline || $[7] !== markdownConfig.components) {
		t3 = inline ? {
			...markdownConfig.components,
			...inlineComponents
		} : markdownConfig.components;
		$[6] = inline;
		$[7] = markdownConfig.components;
		$[8] = t3;
	} else t3 = $[8];
	const components = t3;
	let t4;
	if ($[9] !== contentTransform || $[10] !== renderData.content) {
		t4 = contentTransform ? contentTransform(renderData.content) : renderData.content;
		$[9] = contentTransform;
		$[10] = renderData.content;
		$[11] = t4;
	} else t4 = $[11];
	const content = t4;
	let t5;
	if ($[12] !== components || $[13] !== content || $[14] !== markdownConfig.remarkPlugins) {
		t5 = /* @__PURE__ */ jsx(Markdown, {
			remarkPlugins: markdownConfig.remarkPlugins,
			components,
			children: content
		});
		$[12] = components;
		$[13] = content;
		$[14] = markdownConfig.remarkPlugins;
		$[15] = t5;
	} else t5 = $[15];
	let t6;
	if ($[16] !== Container || $[17] !== className || $[18] !== t5) {
		t6 = /* @__PURE__ */ jsx(Container, {
			className,
			children: t5
		});
		$[16] = Container;
		$[17] = className;
		$[18] = t5;
		$[19] = t6;
	} else t6 = $[19];
	return t6;
}
function _temp(doc) {
	return doc ? {
		content: doc.content,
		references: doc.references,
		workspaceId: doc.workspaceId
	} : void 0;
}
//#endregion
export { MarkdownContentRenderer };

//# sourceMappingURL=MarkdownContentRenderer.js.map