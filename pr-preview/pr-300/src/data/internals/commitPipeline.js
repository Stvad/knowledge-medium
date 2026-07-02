import { scopeAllowedInReadOnly, scopeUploadsToServer, sourceForScope } from "../api/changeScope.js";
import { ReadOnlyError } from "../api/errors.js";
import "../api/index.js";
import { newSnapshotsMap } from "./txSnapshots.js";
import { TxImpl, newTxMeta } from "./txEngine.js";
//#region src/data/internals/commitPipeline.ts
/** Compute the changedRows passed to a same-tx processor for the
*  current snapshot state. Mirrors the post-commit
*  `collectFieldMatches` in `processorRunner.ts` but lives here so
*  the same-tx pass doesn't have to import from `processorRunner`
*  (which has its own React/Repo dependency baggage). Recomputed
*  per-processor inside the runner so later processors see
*  amendments by earlier ones in the same pass. */
var collectSameTxFieldMatches = (processor, snapshots) => {
	if (processor.watches.kind !== "field") return [];
	if (processor.watches.table !== "blocks") return [];
	const out = [];
	for (const [id, entry] of snapshots) if (processor.watches.fields.some((f) => sameTxFieldChanged(entry.before, entry.after, f))) out.push({
		id,
		before: entry.before,
		after: entry.after
	});
	return out;
};
var collectSameTxEventMatches = (processor, sameTxEvents) => {
	if (processor.watches.kind !== "event") return [];
	const names = new Set(processor.watches.events);
	return sameTxEvents.filter((event) => names.has(event.name));
};
/** Mirror of `processorRunner.fieldChanged`. Duplicated rather than
*  shared because `processorRunner.ts` depends on Repo + React
*  surfaces this file deliberately doesn't pull in. */
var sameTxFieldChanged = (before, after, field) => {
	if (before === null) return after !== null;
	if (after === null) return true;
	const a = before[field];
	const b = after[field];
	return a === b ? false : JSON.stringify(a) !== JSON.stringify(b);
};
var runTx = async (params) => {
	const { db, cache, fn, opts, user, isReadOnly, newTxId, newTxSeq, newId, now, mutators, processors, sameTxProcessors, propertySchemas, isReplay = false } = params;
	const { scope, description } = opts;
	if (isReadOnly && !scopeAllowedInReadOnly(scope)) throw new ReadOnlyError(scope);
	const txId = newTxId();
	const txSeq = newTxSeq();
	const source = sourceForScope(scope);
	const snapshots = newSnapshotsMap();
	const afterCommitJobs = [];
	const sameTxEvents = [];
	const mutatorCalls = [];
	const meta = newTxMeta({
		txId,
		scope,
		source,
		user,
		description
	});
	const value = await db.writeTransaction(async (txDb) => {
		await txDb.execute(`UPDATE tx_context SET tx_id = ?, tx_seq = ?, user_id = ?, scope = ?, source = ? WHERE id = 1`, [
			txId,
			txSeq,
			user.id,
			scope,
			source
		]);
		const tx = new TxImpl({
			txDb,
			snapshots,
			cache,
			meta,
			afterCommitJobs,
			mutatorCalls,
			mutators,
			processors,
			sameTxEvents,
			now,
			newId
		});
		const result = await fn(tx);
		if (!isReplay && sameTxProcessors.size > 0 && (snapshots.size > 0 || sameTxEvents.length > 0)) for (const processor of sameTxProcessors.values()) {
			const changedRows = collectSameTxFieldMatches(processor, snapshots);
			const emittedEvents = collectSameTxEventMatches(processor, sameTxEvents);
			if (changedRows.length === 0 && emittedEvents.length === 0) continue;
			if (meta.workspaceId === null) throw new Error("same-tx processor matched without a pinned workspace");
			await processor.apply({
				txId,
				scope,
				user,
				workspaceId: meta.workspaceId,
				changedRows,
				emittedEvents
			}, {
				tx,
				db: txDb,
				propertySchemas
			});
		}
		await txDb.execute(`INSERT INTO command_events
        (tx_id, description, scope, user_id, workspace_id, mutator_calls, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
			txId,
			description ?? null,
			scope,
			user.id,
			meta.workspaceId,
			JSON.stringify(mutatorCalls),
			source,
			now()
		]);
		await txDb.execute(`UPDATE tx_context SET tx_id = NULL, tx_seq = NULL, user_id = NULL, scope = NULL, source = NULL WHERE id = 1`);
		return result;
	});
	for (const [id, entry] of snapshots) if (entry.after === null) cache.markMissing(id);
	else cache.setSnapshot(entry.after);
	return {
		value,
		afterCommitJobs,
		snapshots,
		workspaceId: meta.workspaceId,
		txId,
		user,
		processors,
		propertySchemas
	};
};
var __debug = { scopeUploadsToServer };
//#endregion
export { __debug, runTx };

//# sourceMappingURL=commitPipeline.js.map