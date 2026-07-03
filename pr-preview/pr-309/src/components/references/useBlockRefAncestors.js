import { BlockRefAncestorsContext } from "./cycleGuardContext.js";
import { useContext } from "react";
//#region src/components/references/useBlockRefAncestors.ts
var useBlockRefAncestors = () => {
	return useContext(BlockRefAncestorsContext);
};
//#endregion
export { useBlockRefAncestors };

//# sourceMappingURL=useBlockRefAncestors.js.map