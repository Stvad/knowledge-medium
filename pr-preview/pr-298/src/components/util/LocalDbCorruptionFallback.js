import { Button } from "../ui/button.js";
import { useIsLocalOnly, useSignOut } from "../Login.js";
import { downloadLocalDbBackup, resetLocalDatabase } from "../../utils/localDbRecovery.js";
import { useState } from "react";
import { Fragment as Fragment$1, jsx, jsxs } from "react/jsx-runtime";
//#region src/components/util/LocalDbCorruptionFallback.tsx
var messageOf = (error) => error instanceof Error ? error.message : String(error);
var formatMiB = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
/**
* Bootstrap fallback shown when the local SQLite database is corrupt and can't
* be opened (see [[ipad-opfs-sqlite-corruption]]). Recovery is MANUAL: the user
* downloads a backup of the (corrupt) DB and then resets — we never wipe
* automatically. Reset deletes only the local SQLite files (keeps e2ee keys,
* auth, media) and reloads.
*
* Local-only vs synced matters here: a synced workspace re-downloads from the
* server after reset, but a LOCAL-ONLY workspace has no server copy — reset is
* irreversible data loss. We branch the warnings on `useIsLocalOnly()` and gate
* the destructive button behind a backup attempt so the "always offer the old
* `.db`" promise is enforced, not merely suggested.
*
* Self-contained (no `openDialog`/Dialog portal): the app shell isn't mounted in
* this state, so the confirm step is inline.
*/
function LocalDbCorruptionFallback({ userId, detail }) {
	const signOut = useSignOut();
	const localOnly = useIsLocalOnly();
	const [confirming, setConfirming] = useState(false);
	const [downloadStarted, setDownloadStarted] = useState(false);
	const [downloaded, setDownloaded] = useState(false);
	const [backupFailed, setBackupFailed] = useState(false);
	const [busy, setBusy] = useState(null);
	const [status, setStatus] = useState(null);
	const [actionError, setActionError] = useState(null);
	const resetUnlocked = downloaded || backupFailed;
	const handleExport = async () => {
		setBusy("export");
		setActionError(null);
		setBackupFailed(false);
		setStatus("Preparing download…");
		try {
			const { filename, size } = await downloadLocalDbBackup(userId);
			setDownloadStarted(true);
			setStatus(`Download started for ${filename} (${formatMiB(size)}). Check it saved to your device, then confirm you have it below.`);
		} catch (err) {
			setStatus(null);
			setBackupFailed(true);
			setActionError(`Couldn't export the database: ${messageOf(err)}`);
		} finally {
			setBusy(null);
		}
	};
	const confirmBackupSaved = () => {
		setDownloaded(true);
		setActionError(null);
		setStatus("Backup confirmed — you can reset now.");
	};
	const handleReset = async () => {
		setBusy("reset");
		setActionError(null);
		setStatus("Resetting local database…");
		try {
			await resetLocalDatabase(userId);
			window.location.reload();
		} catch (err_0) {
			setStatus(null);
			setActionError(`Reset failed: ${messageOf(err_0)}`);
			setBusy(null);
		}
	};
	const handleSignOut = async () => {
		try {
			await signOut();
		} catch (err_1) {
			console.error("Sign-out failed", err_1);
			window.location.reload();
		}
	};
	return /* @__PURE__ */ jsx("div", {
		className: "flex min-h-screen items-center justify-center px-6",
		children: /* @__PURE__ */ jsxs("div", {
			className: "w-full max-w-md space-y-4 rounded-lg border bg-card p-6 shadow-sm",
			children: [
				/* @__PURE__ */ jsxs("div", {
					className: "space-y-1",
					children: [/* @__PURE__ */ jsx("h1", {
						className: "text-lg font-semibold",
						children: "Local database problem"
					}), localOnly ? /* @__PURE__ */ jsxs("p", {
						className: "text-sm text-muted-foreground",
						children: [
							"This device's local database is corrupted and can't be opened. This workspace is ",
							/* @__PURE__ */ jsx("strong", { children: "local-only" }),
							" — it does not sync to a server, so this device holds your ",
							/* @__PURE__ */ jsx("strong", { children: "only" }),
							" copy. Download a backup before anything else; resetting permanently deletes it."
						]
					}) : /* @__PURE__ */ jsx("p", {
						className: "text-sm text-muted-foreground",
						children: "This device's local copy of your workspace is corrupted and can't be opened. Your data on the server is unaffected — once you reset, it re-downloads here. First, download a backup so nothing is lost."
					})]
				}),
				/* @__PURE__ */ jsx("pre", {
					className: "max-h-24 overflow-auto rounded bg-muted p-2 text-xs text-muted-foreground",
					children: detail
				}),
				status && /* @__PURE__ */ jsx("p", {
					className: "text-sm text-muted-foreground",
					children: status
				}),
				actionError && /* @__PURE__ */ jsx("p", {
					className: "text-sm text-destructive",
					children: actionError
				}),
				!confirming ? /* @__PURE__ */ jsxs(Fragment$1, { children: [/* @__PURE__ */ jsxs("div", {
					className: "flex flex-col gap-2 sm:flex-row",
					children: [/* @__PURE__ */ jsx(Button, {
						onClick: () => void handleExport(),
						disabled: busy !== null,
						className: "flex-1 min-w-0",
						children: busy === "export" ? "Downloading…" : "Download backup (.db)"
					}), /* @__PURE__ */ jsx(Button, {
						variant: "destructive",
						onClick: () => setConfirming(true),
						disabled: busy !== null,
						className: "flex-1 min-w-0",
						children: localOnly ? "Reset (delete local data)…" : "Reset & re-sync…"
					})]
				}), /* @__PURE__ */ jsxs("div", {
					className: "flex flex-col gap-2 sm:flex-row",
					children: [/* @__PURE__ */ jsx(Button, {
						variant: "outline",
						onClick: () => window.location.reload(),
						disabled: busy !== null,
						className: "flex-1 min-w-0",
						children: "Reload"
					}), /* @__PURE__ */ jsx(Button, {
						variant: "outline",
						onClick: () => void handleSignOut(),
						disabled: busy !== null,
						className: "flex-1 min-w-0",
						children: "Sign out"
					})]
				})] }) : /* @__PURE__ */ jsxs("div", {
					className: "space-y-3 rounded border border-destructive/40 bg-destructive/5 p-3",
					children: [
						localOnly ? /* @__PURE__ */ jsxs("p", {
							className: "text-sm text-destructive",
							children: [
								"This permanently deletes this workspace on this device. It is",
								/* @__PURE__ */ jsx("strong", { children: " local-only" }),
								", so there is ",
								/* @__PURE__ */ jsx("strong", { children: "no server copy" }),
								" to restore from — anything not exported is lost for good. Your encryption keys and sign-in stay on this device."
							]
						}) : /* @__PURE__ */ jsx("p", {
							className: "text-sm text-destructive",
							children: "This deletes the local database on this device and re-downloads everything from the server. Changes not yet synced — and local history — will be permanently lost. Your encryption keys and sign-in stay on this device."
						}),
						!downloadStarted && !backupFailed && /* @__PURE__ */ jsx("p", {
							className: "text-sm text-muted-foreground",
							children: "Download a backup first — the delete button stays disabled until you confirm you have it."
						}),
						downloadStarted && !downloaded && /* @__PURE__ */ jsx("p", {
							className: "text-sm text-muted-foreground",
							children: "A download was started, but the browser can't tell us if it actually saved. Make sure the file is on your device, then confirm — only then does reset unlock."
						}),
						backupFailed && !downloaded && /* @__PURE__ */ jsx("p", {
							className: "text-sm text-destructive",
							children: "The backup couldn't be saved (see above). You can still reset, but anything only on this device will be lost."
						}),
						downloadStarted && !downloaded && /* @__PURE__ */ jsx(Button, {
							onClick: confirmBackupSaved,
							disabled: busy !== null,
							className: "w-full",
							children: "I've saved the backup file"
						}),
						!downloaded && /* @__PURE__ */ jsx(Button, {
							variant: "outline",
							onClick: () => void handleExport(),
							disabled: busy !== null,
							className: "w-full",
							children: busy === "export" ? "Downloading…" : backupFailed ? "Try backup again" : downloadStarted ? "Download again" : "Download backup first"
						}),
						/* @__PURE__ */ jsxs("div", {
							className: "flex flex-col gap-2 sm:flex-row",
							children: [/* @__PURE__ */ jsx(Button, {
								variant: "destructive",
								onClick: () => void handleReset(),
								disabled: busy !== null || !resetUnlocked,
								className: "flex-1 min-w-0",
								children: busy === "reset" ? "Resetting…" : "Delete local data & reload"
							}), /* @__PURE__ */ jsx(Button, {
								variant: "outline",
								onClick: () => setConfirming(false),
								disabled: busy !== null,
								className: "flex-1 min-w-0",
								children: "Cancel"
							})]
						})
					]
				})
			]
		})
	});
}
//#endregion
export { LocalDbCorruptionFallback };

//# sourceMappingURL=LocalDbCorruptionFallback.js.map