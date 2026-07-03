//#region src/plugins/attachments/audit/report.ts
var REASONS = {
	nested: "unexpected NESTED entry under an E2EE prefix (layout must be flat — could hide plaintext)",
	unreadable: "UNREADABLE object under an E2EE prefix (empty/truncated/errored — not verifiable as ciphertext)",
	plaintext: "non-ciphertext object in an E2EE workspace"
};
/**
* Turn an audit outcome into the lines + exit code the entrypoint emits. Pure;
* `redact` (a sha256 prefix in production) keeps raw workspace ids / object names
* out of the public-repo CI log — applied here, to EVERY path, so the no-PII
* guarantee is tested, not assumed.
*/
function buildReport(outcome, redact) {
	if (!outcome.armed) return {
		exitCode: 1,
		notices: [],
		warnings: [],
		errors: ["attachments ciphertext audit NOT ARMED — required credentials unset; the tripwire did not run (configure the privileged key)"],
		summary: "### ❌ Attachments ciphertext audit — NOT ARMED\nRequired credentials unset, so the audit did not run. This is the sole server-side ciphertext check — configure the key."
	};
	const { workspaces, scanned, findings } = outcome.result;
	const tally = `${workspaces} E2EE workspace(s), ${scanned} object(s) scanned, ${findings.length} finding(s)`;
	const notices = [`attachments ciphertext audit: ${tally}`];
	if (findings.length === 0) return {
		exitCode: 0,
		notices,
		warnings: [],
		errors: [],
		summary: `### ✅ Attachments ciphertext audit — armed and clean\n${tally}.\n\n> Coverage is scoped to server-labeled e2ee workspaces — a workspace mislabeled non-e2ee is not scanned, so this is not proof of zero plaintext across all storage.`
	};
	return {
		exitCode: 1,
		notices,
		warnings: [],
		errors: [...findings.map((f) => `${REASONS[f.kind]}: obj:${redact(f.path)}`), `${findings.length} finding(s) under an E2EE prefix — a client is uploading plaintext, nesting, or writing unverifiable objects (§10.1/§17)`],
		summary: `### ❌ Attachments ciphertext audit — ${findings.length} finding(s)\n${tally}. Plaintext, non-flat, or unreadable object under an E2EE workspace (§10.1/§17).`
	};
}
//#endregion
export { REASONS, buildReport };

//# sourceMappingURL=report.js.map