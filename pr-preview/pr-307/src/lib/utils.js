import clsx from "../../node_modules/clsx/dist/clsx.js";
import { twMerge } from "../../node_modules/tailwind-merge/dist/bundle-mjs.js";
//#region src/lib/utils.ts
function cn(...inputs) {
	return twMerge(clsx(inputs));
}
//#endregion
export { cn };

//# sourceMappingURL=utils.js.map