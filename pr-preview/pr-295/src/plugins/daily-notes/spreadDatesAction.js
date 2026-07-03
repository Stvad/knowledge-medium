import { showError, showSuccess } from "../../utils/toast.js";
import { Shuffle } from "../../../node_modules/lucide-react/dist/esm/icons/shuffle.js";
import { defineBlocksAction } from "../../shortcuts/utils.js";
import { openDialog } from "../../utils/dialogs.js";
import { hasAnyBlockDateAdapter } from "./blockDateAdapter.js";
import { SpreadDatesDialog } from "./SpreadDatesDialog.js";
import { spreadBlockDates } from "./spreadBlockDates.js";
//#region src/plugins/daily-notes/spreadDatesAction.ts
var SPREAD_BLOCK_DATES_ACTION_ID = "block.date.spread";
/** Prompt for the day window once, then dispatch `spreadBlockDates`
*  over the supplied blocks. The runtime carries the registered
*  `blockDateAdapterFacet` so adapter dispatch stays uniform across
*  the NORMAL_MODE and MULTI_SELECT_MODE entry points. */
var runSpreadFlow = async (blocks, runtime) => {
	if (blocks.length === 0) return;
	if (!runtime) {
		showError("Spread requires the app runtime to be ready");
		return;
	}
	const choice = await openDialog(SpreadDatesDialog);
	if (!choice) return;
	try {
		const result = await spreadBlockDates(runtime, blocks, { days: choice.days });
		if (result.updated > 0) showSuccess(`Spread ${result.updated} date${result.updated === 1 ? "" : "s"}`);
		else if (result.eligible === 0) showError("No blocks with a date adapter were selected");
		else showError("No dates were updated");
	} catch (error) {
		showError(error instanceof Error ? error.message : "Failed to spread dates");
	}
};
var pair = defineBlocksAction({
	id: SPREAD_BLOCK_DATES_ACTION_ID,
	icon: Shuffle,
	blockDescription: "Spread block date across upcoming days",
	blocksDescription: "Spread dates across upcoming days",
	appliesTo: (block) => {
		const runtime = block.repo.facetRuntime;
		if (!runtime) return true;
		return hasAnyBlockDateAdapter(runtime, block);
	},
	flow: (blocks) => runSpreadFlow(blocks, blocks[0]?.repo.facetRuntime ?? null)
});
var spreadBlockDateAction = pair.block;
var spreadBlockDatesAction = pair.blocks;
var SPREAD_BLOCK_DATES_BLOCKS_ACTION_ID = pair.blocks.id;
var spreadBlockDatesGroupHeaderEntry = { actionId: pair.blocks.id };
//#endregion
export { SPREAD_BLOCK_DATES_ACTION_ID, SPREAD_BLOCK_DATES_BLOCKS_ACTION_ID, spreadBlockDateAction, spreadBlockDatesAction, spreadBlockDatesGroupHeaderEntry };

//# sourceMappingURL=spreadDatesAction.js.map