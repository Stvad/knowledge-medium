import { useUpdateMetadata } from "../../hooks/block.js";
import { useInFocus, usePluginPrefsProperty, useUserPage } from "../../data/globalState.js";
import { previousLoadTimeProp, updateIndicatorPrefsType } from "./loadTimes.js";
import { useState } from "react";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/plugins/update-indicator/UpdateIndicator.tsx
var UpdateIndicator = (t0) => {
	const $ = c(4);
	const { block } = t0;
	const inFocus = useInFocus(block.id);
	const [previousLoadTime] = usePluginPrefsProperty(updateIndicatorPrefsType, previousLoadTimeProp);
	const updateInfo = useUpdateMetadata(block);
	const updatedByName = useUserPage(updateInfo?.updatedBy ?? "").name;
	const [seen, setSeen] = useState(false);
	if (inFocus && !seen) setSeen(true);
	if (!updateInfo) return null;
	if (!(updateInfo.updatedBy !== block.repo.user.id && updateInfo.updatedAt !== 0 && updateInfo.userUpdatedAt > (previousLoadTime ?? 0) && !seen)) return null;
	let t1;
	if ($[0] !== updateInfo.userUpdatedAt) {
		t1 = new Date(updateInfo.userUpdatedAt).toLocaleString();
		$[0] = updateInfo.userUpdatedAt;
		$[1] = t1;
	} else t1 = $[1];
	const t2 = `Updated by ${updatedByName} on ${t1}`;
	let t3;
	if ($[2] !== t2) {
		t3 = /* @__PURE__ */ jsx("div", {
			className: "absolute right-1 top-1 h-2 w-2 rounded-full bg-blue-400",
			title: t2
		});
		$[2] = t2;
		$[3] = t3;
	} else t3 = $[3];
	return t3;
};
//#endregion
export { UpdateIndicator };

//# sourceMappingURL=UpdateIndicator.js.map