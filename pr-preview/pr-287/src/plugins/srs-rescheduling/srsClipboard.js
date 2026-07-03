import { CallbackSet } from "../../utils/callbackSet.js";
//#region src/plugins/srs-rescheduling/srsClipboard.ts
var entry = null;
var listeners = new CallbackSet("srsClipboard");
var getSrsClipboard = () => entry;
var setSrsClipboard = (next) => {
	entry = next;
	listeners.notify();
};
var clearSrsClipboard = () => setSrsClipboard(null);
var subscribeSrsClipboard = (cb) => listeners.add(cb);
//#endregion
export { clearSrsClipboard, getSrsClipboard, setSrsClipboard, subscribeSrsClipboard };

//# sourceMappingURL=srsClipboard.js.map