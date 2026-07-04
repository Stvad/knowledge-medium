import { hasBlockType } from "../../data/properties.js";
import { EXTENSION_TYPE } from "../../data/blockTypes.js";
import { useContent } from "../../hooks/block.js";
import { createTypeScriptConfig } from "../../utils/codemirror.js";
import ReactCodeMirror from "../../../node_modules/@uiw/react-codemirror/esm/index.js";
import { BlockEditor } from "../BlockEditor.js";
import { DefaultBlockRenderer } from "./DefaultBlockRenderer.js";
import { useExtensionLoadError } from "../../extensions/extensionLoadErrors.js";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/components/renderer/CodeMirrorExtensionBlockRenderer.tsx
var extensionFrameClass = "border rounded-md overflow-hidden";
var extensionTheme = "dark";
var extensionBasicSetup = { history: false };
var ExtensionLoadErrorBanner = (t0) => {
	const $ = c(3);
	const { error } = t0;
	let t1;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = /* @__PURE__ */ jsx("strong", {
			className: "font-semibold",
			children: "Extension failed to load:"
		});
		$[0] = t1;
	} else t1 = $[0];
	let t2;
	if ($[1] !== error.message) {
		t2 = /* @__PURE__ */ jsxs("div", {
			role: "alert",
			"data-testid": "extension-load-error",
			className: "border border-red-500/60 bg-red-500/10 text-red-200 rounded-md px-3 py-2 mb-2 text-sm font-mono whitespace-pre-wrap",
			children: [
				t1,
				" ",
				error.message
			]
		});
		$[1] = error.message;
		$[2] = t2;
	} else t2 = $[2];
	return t2;
};
var ExtensionFrame = (t0) => {
	const $ = c(7);
	const { blockId, children } = t0;
	const error = useExtensionLoadError(blockId);
	let t1;
	if ($[0] !== error) {
		t1 = error && /* @__PURE__ */ jsx(ExtensionLoadErrorBanner, { error });
		$[0] = error;
		$[1] = t1;
	} else t1 = $[1];
	let t2;
	if ($[2] !== children) {
		t2 = /* @__PURE__ */ jsx("div", {
			className: extensionFrameClass,
			children
		});
		$[2] = children;
		$[3] = t2;
	} else t2 = $[3];
	let t3;
	if ($[4] !== t1 || $[5] !== t2) {
		t3 = /* @__PURE__ */ jsxs("div", { children: [t1, t2] });
		$[4] = t1;
		$[5] = t2;
		$[6] = t3;
	} else t3 = $[6];
	return t3;
};
var ExtensionViewer = (t0) => {
	const $ = c(6);
	const { block } = t0;
	const content = useContent(block);
	let t1;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = createTypeScriptConfig();
		$[0] = t1;
	} else t1 = $[0];
	const extensions = t1;
	let t2;
	if ($[1] !== content) {
		t2 = /* @__PURE__ */ jsx(ReactCodeMirror, {
			value: content,
			extensions,
			editable: false,
			theme: extensionTheme,
			className: "w-full",
			basicSetup: extensionBasicSetup
		});
		$[1] = content;
		$[2] = t2;
	} else t2 = $[2];
	let t3;
	if ($[3] !== block.id || $[4] !== t2) {
		t3 = /* @__PURE__ */ jsx(ExtensionFrame, {
			blockId: block.id,
			children: t2
		});
		$[3] = block.id;
		$[4] = t2;
		$[5] = t3;
	} else t3 = $[5];
	return t3;
};
var ExtensionEditor = (t0) => {
	const $ = c(6);
	const { block } = t0;
	let t1;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = createTypeScriptConfig();
		$[0] = t1;
	} else t1 = $[0];
	const extensions = t1;
	let t2;
	if ($[1] !== block) {
		t2 = /* @__PURE__ */ jsx(BlockEditor, {
			block,
			extensions,
			theme: extensionTheme,
			className: "w-full",
			basicSetup: extensionBasicSetup,
			indentWithTab: true,
			autoFocus: false
		});
		$[1] = block;
		$[2] = t2;
	} else t2 = $[2];
	let t3;
	if ($[3] !== block.id || $[4] !== t2) {
		t3 = /* @__PURE__ */ jsx(ExtensionFrame, {
			blockId: block.id,
			children: t2
		});
		$[3] = block.id;
		$[4] = t2;
		$[5] = t3;
	} else t3 = $[5];
	return t3;
};
var CodeMirrorExtensionBlockRenderer = (props) => {
	const $ = c(2);
	let t0;
	if ($[0] !== props) {
		t0 = /* @__PURE__ */ jsx(DefaultBlockRenderer, {
			...props,
			ContentRenderer: ExtensionViewer,
			EditContentRenderer: ExtensionEditor
		});
		$[0] = props;
		$[1] = t0;
	} else t0 = $[1];
	return t0;
};
CodeMirrorExtensionBlockRenderer.canRender = ({ block }) => {
	const data = block.peek();
	return data ? hasBlockType(data, EXTENSION_TYPE) : false;
};
CodeMirrorExtensionBlockRenderer.priority = () => 5;
//#endregion
export { CodeMirrorExtensionBlockRenderer };

//# sourceMappingURL=CodeMirrorExtensionBlockRenderer.js.map