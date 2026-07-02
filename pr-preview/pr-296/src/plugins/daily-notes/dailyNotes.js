import { ChangeScope } from "../../data/api/changeScope.js";
import "../../data/api/index.js";
import { aliasesProp, hasBlockType } from "../../data/properties.js";
import v5 from "../../../node_modules/uuid/dist/v5.js";
import { PAGE_TYPE } from "../../data/blockTypes.js";
import { keyAtEnd } from "../../data/orderKey.js";
import { DAILY_NOTE_TYPE, dailyNoteDateProp } from "./schema.js";
import { createOrRestoreTargetBlock } from "../../data/targets.js";
import { dailyPageAliases, formatIsoDate } from "../../utils/dailyPage.js";
//#region src/plugins/daily-notes/dailyNotes.ts
/** Build the indexable `Date` stored on `dailyNoteDateProp`. The
*  daily-note id is a hash of (workspaceId, iso) and not reversible,
*  so this is the canonical place that re-derives "what day is this"
*  for the query layer. UTC midnight keeps `toISOString()` stable
*  across clients regardless of local timezone — same invariant the
*  reverse-chronology orderKey relies on.
*
*  Throws on invalid input. Callers must validate via `isValidDateAlias`
*  upstream — the references-processor routing decision is the canonical
*  gate, so reaching this with a bad iso is a caller bug. */
var dailyNoteDateValue = (iso) => {
	const ms = Date.parse(`${iso}T00:00:00Z`);
	if (Number.isNaN(ms)) throw new Error(`Invalid ISO date for daily note: ${iso}`);
	const d = new Date(ms);
	if (d.toISOString().slice(0, 10) !== iso) throw new Error(`Invalid calendar date for daily note: ${iso}`);
	return d;
};
var JOURNAL_NS = "a304a5da-807a-4c20-8af3-53a033aa9df8";
var DAILY_NOTE_NS = "53421e08-2f31-42f8-b73a-43830bb718f1";
var JOURNAL_ALIAS = "Journal";
var JOURNAL_ALIASES = [JOURNAL_ALIAS];
var journalBlockId = (workspaceId) => v5(workspaceId, JOURNAL_NS);
var dailyNoteBlockId = (workspaceId, iso) => v5(`${workspaceId}:${iso}`, DAILY_NOTE_NS);
var todayIso = (now = /* @__PURE__ */ new Date()) => formatIsoDate(now);
var parseIsoParts = (iso) => {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
	if (!match) throw new Error(`Invalid ISO date for daily note: ${iso}`);
	return {
		year: Number(match[1]),
		month: Number(match[2]),
		day: Number(match[3])
	};
};
var dailyNoteCreatedAt = (iso) => {
	const ms = Date.parse(`${iso}T00:00:00Z`);
	if (Number.isNaN(ms)) throw new Error(`Invalid ISO date for daily note: ${iso}`);
	return ms;
};
var addDaysIso = (iso, days) => {
	const { year, month, day } = parseIsoParts(iso);
	return formatIsoDate(new Date(year, month - 1, day + days));
};
var dailyNoteLocalDate = (iso) => {
	const { year, month, day } = parseIsoParts(iso);
	return new Date(year, month - 1, day);
};
var stringListProperty = (value) => Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
var includesAll = (existing, expected) => expected.every((value) => existing.includes(value));
var mergeStrings = (values) => Array.from(new Set(values));
/** Get-or-create the workspace's Journal page. Idempotent: a
*  deterministic id derived from `workspaceId` means two clients
*  booting offline converge on the same row. Soft-deleted journal
*  rows are restored. */
var getOrCreateJournalBlock = async (repo, workspaceId) => {
	const id = journalBlockId(workspaceId);
	const live = await repo.load(id);
	if (live) {
		const aliases = stringListProperty(live.properties[aliasesProp.name]);
		if (!(!hasBlockType(live, "page") || !includesAll(aliases, JOURNAL_ALIASES))) return repo.block(id);
		const typeSnapshot = repo.snapshotTypeRegistries();
		await repo.tx(async (tx) => {
			const current = await tx.get(id);
			if (!current || current.deleted) return;
			const currentAliases = stringListProperty(current.properties[aliasesProp.name]);
			if (!includesAll(currentAliases, JOURNAL_ALIASES)) await tx.setProperty(id, aliasesProp, mergeStrings([...JOURNAL_ALIASES, ...currentAliases]));
			await repo.addTypeInTx(tx, id, PAGE_TYPE, { [aliasesProp.name]: JOURNAL_ALIASES }, typeSnapshot);
		}, { scope: ChangeScope.BlockDefault });
		return repo.block(id);
	}
	const typeSnapshot = repo.snapshotTypeRegistries();
	await repo.tx(async (tx) => {
		const existing = await tx.get(id);
		if (existing && !existing.deleted) return;
		if (existing && existing.deleted) {
			await tx.restore(id, { content: JOURNAL_ALIAS });
			await tx.setProperty(id, aliasesProp, JOURNAL_ALIASES);
			await repo.addTypeInTx(tx, id, PAGE_TYPE, { [aliasesProp.name]: JOURNAL_ALIASES }, typeSnapshot);
			return;
		}
		await tx.create({
			id,
			workspaceId,
			parentId: null,
			orderKey: "a0",
			content: JOURNAL_ALIAS
		}, { systemMint: true });
		await repo.addTypeInTx(tx, id, PAGE_TYPE, { [aliasesProp.name]: JOURNAL_ALIASES }, typeSnapshot);
	}, { scope: ChangeScope.BlockDefault });
	return repo.block(id);
};
/** Order key under the journal page. The tree uses normal ascending
*  `(order_key, id)` ordering, so daily notes encode the date as its
*  lexical complement: newer ISO dates sort before older ISO dates
*  without a journal-specific query sort. Each daily note has a unique
*  date, so there's never a collision. */
var dailyNoteOrderKey = (iso) => {
	const { year, month, day } = parseIsoParts(iso);
	return `${String(9999 - year).padStart(4, "0")}-${String(12 - month).padStart(2, "0")}-${String(31 - day).padStart(2, "0")}`;
};
/** Get-or-create today's daily note. Two clients calling concurrently
*  with the same (workspaceId, iso) write to the same row, so the
*  daily note never duplicates even when both are offline at boot.
*
*  On a soft-deleted row we resurrect rather than recreate from
*  scratch — the row's content + descendant subtree may carry edits
*  the user wants back. We also re-link to the journal because the
*  resurrected row's parent_id may have drifted; `tx.move` sets it
*  cleanly. */
var getOrCreateDailyNote = async (repo, workspaceId, iso) => {
	const id = dailyNoteBlockId(workspaceId, iso);
	const orderKey = dailyNoteOrderKey(iso);
	const [longLabel, isoLabel] = dailyPageAliases(dailyNoteLocalDate(iso));
	const dailyAliases = [longLabel, isoLabel];
	const dateValue = dailyNoteDateValue(iso);
	const live = await repo.load(id);
	if (live) {
		const aliases = stringListProperty(live.properties[aliasesProp.name]);
		if (!(live.parentId !== journalBlockId(workspaceId) || live.orderKey !== orderKey || !hasBlockType(live, "page") || !hasBlockType(live, "daily-note") || !includesAll(aliases, dailyAliases))) return repo.block(id);
		const journal = await getOrCreateJournalBlock(repo, workspaceId);
		const typeSnapshot = repo.snapshotTypeRegistries();
		await repo.tx(async (tx) => {
			const current = await tx.get(id);
			if (!current || current.deleted) return;
			const currentAliases = stringListProperty(current.properties[aliasesProp.name]);
			if (!includesAll(currentAliases, dailyAliases)) await tx.setProperty(id, aliasesProp, mergeStrings([...dailyAliases, ...currentAliases]));
			await repo.addTypeInTx(tx, id, PAGE_TYPE, { [aliasesProp.name]: dailyAliases }, typeSnapshot);
			await repo.addTypeInTx(tx, id, DAILY_NOTE_TYPE, { [dailyNoteDateProp.name]: dateValue }, typeSnapshot);
			if (current.parentId !== journal.id || current.orderKey !== orderKey) await tx.move(id, {
				parentId: journal.id,
				orderKey
			}, { skipMetadata: true });
		}, { scope: ChangeScope.BlockDefault });
		return repo.block(id);
	}
	const journal = await getOrCreateJournalBlock(repo, workspaceId);
	const typeSnapshot = repo.snapshotTypeRegistries();
	await repo.tx(async (tx) => {
		const existing = await tx.get(id);
		if (existing && !existing.deleted) return;
		if (existing && existing.deleted) {
			await tx.restore(id, { content: longLabel });
			await tx.setProperty(id, aliasesProp, dailyAliases);
			await repo.addTypeInTx(tx, id, PAGE_TYPE, { [aliasesProp.name]: dailyAliases }, typeSnapshot);
			await repo.addTypeInTx(tx, id, DAILY_NOTE_TYPE, { [dailyNoteDateProp.name]: dateValue }, typeSnapshot);
			await tx.move(id, {
				parentId: journal.id,
				orderKey
			}, { skipMetadata: true });
			return;
		}
		await tx.create({
			id,
			workspaceId,
			parentId: journal.id,
			orderKey,
			content: longLabel
		}, { systemMint: true });
		await repo.addTypeInTx(tx, id, PAGE_TYPE, { [aliasesProp.name]: dailyAliases }, typeSnapshot);
		await repo.addTypeInTx(tx, id, DAILY_NOTE_TYPE, { [dailyNoteDateProp.name]: dateValue }, typeSnapshot);
	}, { scope: ChangeScope.BlockDefault });
	return repo.block(id);
};
/** Date-shaped alias detector (spec §7.6). Shape-only — matches the
*  `YYYY-MM-DD` regex without checking calendar validity. Reach for
*  this when you want to find any date-looking alias on a row
*  (e.g. extracting the iso from a daily-note's alias list) and the
*  caller will tolerate a malformed-but-shaped result. Routing
*  decisions (references processor) use `isValidDateAlias` instead. */
var isDateAlias = (alias) => /^\d{4}-\d{2}-\d{2}$/.test(alias);
/** Shape + calendar-validity check. Returns `true` only for strings
*  that parse to a real calendar day (rejects `2026-13-01`,
*  `2026-02-30`, etc. via a round-trip-to-ISO comparison — naive
*  `Date.parse` rolls these over silently). This is the routing
*  predicate: aliases that pass go through `ensureDailyNoteTarget`
*  (deterministic-id daily-note seat); aliases that only pass the
*  shape check fall through to `ensureAliasTarget` (regular alias
*  target page) so the user's typo doesn't pollute the daily-note
*  namespace with a wrong-but-deterministic seat. */
var isValidDateAlias = (alias) => {
	if (!isDateAlias(alias)) return false;
	const ms = Date.parse(`${alias}T00:00:00Z`);
	if (Number.isNaN(ms)) return false;
	return new Date(ms).toISOString().slice(0, 10) === alias;
};
/** Ensure a daily-note **target seat** block exists for ISO date `date`
*  in `workspaceId`. The seat is a reference target materialised at
*  workspace-root when nobody has authored a real daily-note row for
*  that date yet — same `dailyNoteBlockId(workspaceId, date)` namespace
*  as `getOrCreateDailyNote`, so the two flows converge on the same
*  row through PowerSync without a merge.
*
*  Contract: `date` MUST be a valid calendar ISO (`isValidDateAlias`).
*  The references-processor routing gate enforces this; callers
*  invoking this directly are responsible for the same. Invalid input
*  throws via `dailyNoteDateValue`.
*
*  Distinct from `getOrCreateDailyNote`, which parents the row under
*  the Journal page and writes long-form aliases. `ensureDailyNoteTarget`
*  is the lighter-weight materialiser invoked from `parseReferences`
*  during reference resolution; it leaves the row at workspace-root
*  with the iso date as content (matches the alias — mirrors
*  `ensureAliasTarget`'s creation-time-default rule) until
*  `getOrCreateDailyNote` later promotes it with the long-form label. */
var ensureDailyNoteTarget = async (tx, repo, date, workspaceId, typeSnapshot = repo.snapshotTypeRegistries()) => createOrRestoreTargetBlock(tx, {
	id: dailyNoteBlockId(workspaceId, date),
	workspaceId,
	parentId: null,
	orderKey: keyAtEnd(),
	freshContent: date,
	systemMint: true,
	onInsertedOrRestored: async (tx, id) => {
		await tx.setProperty(id, aliasesProp, [date]);
		await repo.addTypeInTx(tx, id, PAGE_TYPE, { [aliasesProp.name]: [date] }, typeSnapshot);
		await repo.addTypeInTx(tx, id, DAILY_NOTE_TYPE, { [dailyNoteDateProp.name]: dailyNoteDateValue(date) }, typeSnapshot);
	}
});
//#endregion
export { DAILY_NOTE_NS, JOURNAL_NS, addDaysIso, dailyNoteBlockId, dailyNoteCreatedAt, dailyNoteDateValue, ensureDailyNoteTarget, getOrCreateDailyNote, getOrCreateJournalBlock, isDateAlias, isValidDateAlias, journalBlockId, todayIso };

//# sourceMappingURL=dailyNotes.js.map