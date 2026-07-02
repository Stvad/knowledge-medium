import { systemToggle } from "../../facets/togglable.js";
import { blockRenderersFacet } from "../../extensions/core.js";
import { blockHeaderFacet } from "../../extensions/blockInteraction.js";
import { BreadcrumbList } from "./BreadcrumbList.js";
import { Breadcrumbs } from "./Breadcrumbs.js";
import { getBreadcrumbContentPreview } from "./breadcrumbPreview.js";
import { BreadcrumbRenderer } from "./BreadcrumbRenderer.js";
import { PromotableBreadcrumbList } from "./PromotableBreadcrumbList.js";
import { usePromotableBreadcrumb } from "./usePromotableBreadcrumb.js";
//#region src/plugins/breadcrumbs/index.ts
var breadcrumbRendererContribution = {
	id: "breadcrumb",
	renderer: BreadcrumbRenderer
};
var breadcrumbsPlugin = systemToggle({
	id: "system:breadcrumbs",
	name: "Breadcrumbs",
	description: "Ancestor chain rendered above each panel."
}).of([blockRenderersFacet.of(breadcrumbRendererContribution, { source: "breadcrumbs" }), blockHeaderFacet.of((ctx) => ctx.isTopLevel ? Breadcrumbs : null, { source: "breadcrumbs" })]);
//#endregion
export { BreadcrumbList, BreadcrumbRenderer, Breadcrumbs, PromotableBreadcrumbList, breadcrumbRendererContribution, breadcrumbsPlugin, getBreadcrumbContentPreview, usePromotableBreadcrumb };

//# sourceMappingURL=index.js.map