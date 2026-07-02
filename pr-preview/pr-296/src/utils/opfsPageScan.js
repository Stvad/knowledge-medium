//#region src/utils/opfsPageScan.ts
/**
* Cheap structural scan of a raw SQLite `.db` file for physically-lost pages.
*
* A whole-file `PRAGMA integrity_check` on a multi-GB DB takes ~30s and aborts
* with a generic "malformed" the moment it hits an unparseable page — no
* per-page detail. This scan instead reads the raw bytes and flags **fully
* zeroed pages**, which is the clearest fingerprint of a dropped/torn write
* (a live b-tree page zero-filled by file extension but never written back).
* The two real iPad corruptions (see the db-forensics instrumentation) both
* surfaced this way; the 2026-07-01 incident was a single zeroed page at
* exactly the 1 GiB offset. Reading 1.4 GB this way takes ~3s.
*
* Runs against a `Blob`/`File` (from `handle.getFile()`), reading one window at
* a time so a multi-GB file never lands in memory. It does NOT interpret b-tree
* structure beyond the page-type byte — a zeroed page is unambiguous; detecting
* non-zero corruption (torn/stale writes) needs SQLite and is out of scope here.
*/
var DEFAULT_PAGE_SIZE = 4096;
var WINDOW_PAGES = 1024;
var MAX_LISTED_ZERO_PAGES = 200;
var DEFAULT_TIME_BUDGET_MS = 3e4;
/** SQLite stores the page size at bytes 16-17 of page 1 (big-endian); the
*  value 1 encodes 65536. Falls back to 4096 when the header is unreadable. */
var readPageSize = (header) => {
	if (header.length < 18) return DEFAULT_PAGE_SIZE;
	const raw = header[16] << 8 | header[17];
	if (raw === 1) return 65536;
	if (raw >= 512 && raw <= 65536 && (raw & raw - 1) === 0) return raw;
	return DEFAULT_PAGE_SIZE;
};
var isAllZero = (buf, base, pageSize) => {
	for (let i = 0; i < pageSize; i += 8) if (buf[base + i] !== 0) return false;
	for (let i = 0; i < pageSize; i++) if (buf[base + i] !== 0) return false;
	return true;
};
/**
* Scan `source` for fully-zeroed pages. `now` is injectable for tests; it
* defaults to `Date.now` (this is app-runtime code, not a workflow script).
*/
var scanForZeroPages = async (source, options = {}) => {
	const now = options.now ?? Date.now;
	const timeBudgetMs = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
	const total = source.size;
	const pageSize = readPageSize(new Uint8Array(await source.slice(0, Math.min(100, total)).arrayBuffer()));
	const pageCount = Math.floor(total / pageSize);
	const windowBytes = pageSize * WINDOW_PAGES;
	const zeroPages = [];
	const typeByteHistogram = {};
	let zeroPageCount = 0;
	let scannedPages = 0;
	let timedOut = false;
	const start = now();
	for (let off = 0; off < total; off += windowBytes) {
		if (now() - start > timeBudgetMs) {
			timedOut = true;
			break;
		}
		const end = Math.min(off + windowBytes, total);
		const buf = new Uint8Array(await source.slice(off, end).arrayBuffer());
		const pagesInWindow = Math.floor(buf.length / pageSize);
		for (let p = 0; p < pagesInWindow; p++) {
			const base = p * pageSize;
			const pageIndex = off / pageSize + p + 1;
			const typeByte = buf[base];
			typeByteHistogram[typeByte] = (typeByteHistogram[typeByte] ?? 0) + 1;
			if (isAllZero(buf, base, pageSize)) {
				zeroPageCount++;
				if (zeroPages.length < MAX_LISTED_ZERO_PAGES) zeroPages.push(pageIndex);
			}
			scannedPages++;
		}
	}
	return {
		fileSize: total,
		pageSize,
		pageCount,
		scannedPages,
		zeroPages,
		zeroPageCount,
		firstZeroPageByteOffset: zeroPages.length > 0 ? (zeroPages[0] - 1) * pageSize : null,
		typeByteHistogram,
		elapsedMs: now() - start,
		timedOut
	};
};
//#endregion
export { scanForZeroPages };

//# sourceMappingURL=opfsPageScan.js.map