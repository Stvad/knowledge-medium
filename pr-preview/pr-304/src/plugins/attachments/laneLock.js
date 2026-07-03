//#region src/plugins/attachments/laneLock.ts
/**
* Web Lock helpers for the background byte-replication lanes (design §8/§9). The
* up-lane drain and the down-lane replicator are SINGLE-OWNER across tabs so N open
* tabs don't multiply egress; both elect one owner via `navigator.locks`.
*/
/** Run `work` holding a named Web Lock — the lane is single-owner across tabs. A
*  concurrent caller QUEUES behind the holder (runs after it releases). Falls back to
*  running directly where `navigator.locks` is absent (tests / older browsers). Used
*  by the up-lane drain, whose queued duplicate is cheap + idempotent. */
var withLock = async (name, work) => {
	const locks = typeof navigator !== "undefined" ? navigator.locks : void 0;
	return locks?.request ? locks.request(name, work) : work();
};
/** Like {@link withLock} but NON-BLOCKING (`ifAvailable`): if another tab already
*  holds the lane, SKIP this pass instead of queuing behind it. The right call for an
*  idempotent, periodically-re-armed lane (the down-lane) where a queued duplicate
*  would only re-walk a workspace the owner already replicated — wasted work, not
*  wrong. Returns true if `work` ran, false if it was skipped. Runs directly (→ true)
*  where `navigator.locks` is absent. */
var runSingleOwner = async (name, work) => {
	const locks = typeof navigator !== "undefined" ? navigator.locks : void 0;
	if (!locks?.request) {
		await work();
		return true;
	}
	return locks.request(name, { ifAvailable: true }, async (lock) => {
		if (!lock) return false;
		await work();
		return true;
	});
};
//#endregion
export { runSingleOwner, withLock };

//# sourceMappingURL=laneLock.js.map