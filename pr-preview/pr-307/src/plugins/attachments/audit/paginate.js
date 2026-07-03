//#region src/plugins/attachments/audit/paginate.ts
/**
* Collect every item from an OFFSET-paginated source.
*
* Two correctness requirements that hand-rolled pagination kept getting wrong:
*   1. `fetchPage(offset)` MUST return a STABLY-ORDERED page. Offset/limit over
*      an unordered result is planner-dependent and can skip or duplicate rows
*      across pages — for the audit, a skipped object is a silent miss. The
*      ordering is the caller's responsibility (it knows the sort key); this
*      helper just walks the pages.
*   2. Advance by the ACTUAL page length, not the requested page size: a server
*      may cap a page below what was asked (PostgREST `db-max-rows`), and
*      advancing by the requested size would then skip the remainder.
* Stops on an empty page.
*/
async function collectPaged(fetchPage) {
	const all = [];
	for (let offset = 0;;) {
		const page = await fetchPage(offset);
		if (page.length === 0) return all;
		all.push(...page);
		offset += page.length;
	}
}
//#endregion
export { collectPaged };

//# sourceMappingURL=paginate.js.map