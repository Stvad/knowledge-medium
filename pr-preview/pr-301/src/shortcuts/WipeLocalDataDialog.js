import { Button } from "../components/ui/button.js";
import { getPowerSyncDb } from "../data/repoProvider.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog.js";
import { useEffect, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/shortcuts/WipeLocalDataDialog.tsx
var REJECTED_COUNT_SQL = "SELECT COUNT(*) AS count FROM ps_crud_rejected";
var CLEAR_DATA_STEPS = [
	{
		browser: "Chrome / Edge",
		steps: "click the icon at the left of the address bar → Cookies and site data → Delete (or Settings → Privacy and security → Site settings → this site → Delete data)."
	},
	{
		browser: "Firefox",
		steps: "Settings → Privacy & Security → Cookies and Site Data → Manage Data → select this site → Remove Selected → Save Changes."
	},
	{
		browser: "Safari (Mac)",
		steps: "Settings → Privacy → Manage Website Data → select this site → Remove."
	},
	{
		browser: "Safari (iOS)",
		steps: "Settings app → Safari → Advanced → Website Data → select this site → swipe to delete."
	},
	{
		browser: "Installed app (Android / desktop PWA)",
		steps: "OS app settings → Storage → Clear data, or remove and reinstall the app."
	}
];
/**
* "Wipe local data" — pure guidance. The app can't reliably destroy origin
* storage from JS, so this dialog just explains how to use the browser/OS
* "clear site data" control, which erases everything (local DB, keys, auth
* session) from outside the page. Sync runs in the background, so we don't
* drain anything here — we only WARN if there are still-unsynced changes
* (e.g. you're offline), which a wipe would lose.
*/
var WipeLocalDataDialog = ({ userId, cancel }) => {
	const [unsynced, setUnsynced] = useState(null);
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const db = getPowerSyncDb(userId);
				const { count: queued } = await db.getUploadQueueStats();
				let rejected = 0;
				try {
					const row = await db.get(REJECTED_COUNT_SQL);
					rejected = Number(row?.count ?? 0);
				} catch {}
				if (!cancelled) setUnsynced(queued + rejected);
			} catch {}
		})();
		return () => {
			cancelled = true;
		};
	}, [userId]);
	return /* @__PURE__ */ jsx(Dialog, {
		open: true,
		onOpenChange: (next) => {
			if (!next) cancel();
		},
		children: /* @__PURE__ */ jsxs(DialogContent, {
			className: "max-w-lg",
			children: [
				/* @__PURE__ */ jsxs(DialogHeader, { children: [/* @__PURE__ */ jsx(DialogTitle, { children: "Wipe local data on this device" }), /* @__PURE__ */ jsx(DialogDescription, { children: "This erases everything this app stored on this device and signs you out. Anything already synced re-downloads when you sign back in." })] }),
				/* @__PURE__ */ jsxs("div", {
					className: "space-y-4 text-sm",
					children: [unsynced != null && unsynced > 0 && /* @__PURE__ */ jsxs("p", {
						className: "text-destructive",
						children: [
							"You have ",
							unsynced,
							" local change(s) that aren’t synced to the server. Clearing the data permanently deletes anything not synced — there’s no undo. If you’re online with sync enabled, let it finish syncing first (changes made in local-only mode, or rejected by the server, can’t sync and will be lost)."
						]
					}), /* @__PURE__ */ jsxs("div", {
						className: "space-y-2",
						children: [
							/* @__PURE__ */ jsxs("p", { children: [
								"The wipe is done by your browser’s ",
								/* @__PURE__ */ jsx("strong", { children: "“clear site data”" }),
								" control:"
							] }),
							/* @__PURE__ */ jsx("ul", {
								className: "list-disc space-y-1 pl-5",
								children: CLEAR_DATA_STEPS.map(({ browser, steps }) => /* @__PURE__ */ jsxs("li", { children: [
									/* @__PURE__ */ jsxs("span", {
										className: "font-medium",
										children: [browser, ":"]
									}),
									" ",
									steps
								] }, browser))
							}),
							/* @__PURE__ */ jsx("p", {
								className: "text-muted-foreground",
								children: "After clearing, close or reload every tab of this app (including this one) — until you do, an open tab stays signed in and keeps showing your data."
							})
						]
					})]
				}),
				/* @__PURE__ */ jsx(DialogFooter, { children: /* @__PURE__ */ jsx(Button, {
					onClick: () => cancel(),
					children: "Close"
				}) })
			]
		})
	});
};
//#endregion
export { WipeLocalDataDialog };

//# sourceMappingURL=WipeLocalDataDialog.js.map