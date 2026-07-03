import { CallbackSet } from "../utils/callbackSet.js";
//#region src/editor/editSettleSignal.ts
/**
* "The user is done editing this block" — fired when a block's editor
* unmounts (focus moved elsewhere, edit mode exited) or when an action
* finishes a programmatic edit on the user's behalf.
*
* Deliberately generic and editor-owned: consumers (e.g. the agent
* runtime's watch-events facility, which uses it to short-circuit its
* settle window) subscribe here without the editor knowing about them.
*/
var blockEditSettled = new CallbackSet("block-edit-settled");
var notifyBlockEditSettled = (blockId) => blockEditSettled.notify(blockId);
//#endregion
export { blockEditSettled, notifyBlockEditSettled };

//# sourceMappingURL=editSettleSignal.js.map