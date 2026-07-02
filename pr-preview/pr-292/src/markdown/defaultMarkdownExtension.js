import { MarkdownImage } from "./MarkdownImage.js";
import remarkGfm from "../../node_modules/remark-gfm/lib/index.js";
import { createElement } from "react";
//#region src/markdown/defaultMarkdownExtension.ts
var ABSOLUTE_URL_PATTERN = /^[a-z][a-z\d+.-]*:/i;
var currentLocationHref = () => typeof window === "undefined" ? void 0 : window.location.href;
var isExternalHref = (href, baseHref = currentLocationHref()) => {
	if (!href) return false;
	if (!(ABSOLUTE_URL_PATTERN.test(href) || href.startsWith("//"))) return false;
	try {
		const url = new URL(href, baseHref);
		if (url.protocol !== "http:" && url.protocol !== "https:") return false;
		if (!baseHref) return true;
		return url.origin !== new URL(baseHref).origin;
	} catch {
		return false;
	}
};
var withExternalRel = (rel) => {
	const values = new Set(rel?.split(/\s+/).filter(Boolean) ?? []);
	values.add("noopener");
	values.add("noreferrer");
	return [...values].join(" ");
};
var MarkdownAnchor = ({ href, children, rel, node: _node, ...props }) => {
	const external = isExternalHref(href);
	return createElement("a", {
		...props,
		href,
		rel: external ? withExternalRel(rel) : rel,
		target: external ? "_blank" : props.target
	}, children);
};
var gfmMarkdownExtension = () => ({
	remarkPlugins: [remarkGfm],
	components: {
		a: MarkdownAnchor,
		img: MarkdownImage
	}
});
//#endregion
export { gfmMarkdownExtension, isExternalHref };

//# sourceMappingURL=defaultMarkdownExtension.js.map