//#region src/data/api/changeScope.ts
/** ChangeScope drives undo behavior, upload routing, and read-only gating
*  for every write made through `repo.tx`. Plugins pick the one whose
*  engine semantics match their need (no plugin-extensible scope registry —
*  see §5.8 of the data-layer spec). */
var ChangeScope = {
	/** User document edits. Undoable; uploads to server. */
	BlockDefault: "block-default",
	/** Selection / focus / chrome state. Not undoable; uploads like any
	*  other write — server-side RLS or FK errors land in the rejection
	*  quarantine rather than blocking the queue. The scope identity is
	*  still load-bearing for undo bucketing and schema validation
	*  (`requireSchemaScope`). */
	UiState: "local-ui",
	/** User-owned preferences. Not undoable; uploads. */
	UserPrefs: "user-prefs",
	/** App/automation-authored records (diagnostics, telemetry, automation
	*  output, e.g. startup-metrics) — written by the program, not the user.
	*  Durable + synced like any write, NOT undoable — and unlike a
	*  `system:`-prefixed property NAME (which is hidden), Automation-scoped
	*  properties ARE surfaced in the property panel. For machine-generated data
	*  the user may want to inspect but never hand-edits as a document. Same
	*  engine policy as UserPrefs; the distinct identity is its own undo bucket +
	*  semantic label. */
	Automation: "automation",
	/** parseReferences bookkeeping. Separate undo bucket; uploads. */
	References: "block-default:references"
};
var CHANGE_SCOPE_POLICIES = {
	[ChangeScope.BlockDefault]: {
		undoable: true,
		source: "user",
		readOnly: "reject"
	},
	[ChangeScope.UiState]: {
		undoable: false,
		source: "user",
		readOnly: "allow"
	},
	[ChangeScope.UserPrefs]: {
		undoable: false,
		source: "user",
		readOnly: "allow"
	},
	[ChangeScope.Automation]: {
		undoable: false,
		source: "user",
		readOnly: "allow"
	},
	[ChangeScope.References]: {
		undoable: true,
		source: "user",
		readOnly: "reject"
	}
};
var policyForScope = (scope) => CHANGE_SCOPE_POLICIES[scope];
var scopeAllowedInReadOnly = (scope) => policyForScope(scope).readOnly !== "reject";
var scopeIsUndoable = (scope) => policyForScope(scope).undoable;
var sourceForScope = (scope) => policyForScope(scope).source;
var scopeUploadsToServer = (scope) => sourceForScope(scope) === "user";
//#endregion
export { CHANGE_SCOPE_POLICIES, ChangeScope, policyForScope, scopeAllowedInReadOnly, scopeIsUndoable, scopeUploadsToServer, sourceForScope };

//# sourceMappingURL=changeScope.js.map