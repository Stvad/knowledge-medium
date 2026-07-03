//#region src/utils/downloadBlob.ts
/**
* Trigger a browser download of an in-memory {@link Blob} via a transient anchor.
*
* The anchor is created, clicked, and removed synchronously — it is NEVER left in
* the DOM — and its object URL is revoked on the next microtask. Two properties
* matter to callers:
*   - No navigable `blob:` URL survives in the document, so there's nothing to
*     middle-click / open-in-new-tab (a persistent `<a href="blob:">` typed with an
*     active content-type would be a same-origin render/XSS vector).
*   - `blob:` URLs don't expose download completion, so an optional `cleanup` runs on
*     a long delay (only needed by callers holding an OPFS temp snapshot alive).
*/
function downloadBlob(blob, filename, cleanup) {
	const url = URL.createObjectURL(blob);
	try {
		const a = document.createElement("a");
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
	} finally {
		setTimeout(() => URL.revokeObjectURL(url), 0);
		if (cleanup) setTimeout(() => {
			Promise.resolve(cleanup()).catch((error) => {
				console.warn("[download-blob] failed to run download cleanup:", error);
			});
		}, 3600 * 1e3);
	}
}
//#endregion
export { downloadBlob };

//# sourceMappingURL=downloadBlob.js.map