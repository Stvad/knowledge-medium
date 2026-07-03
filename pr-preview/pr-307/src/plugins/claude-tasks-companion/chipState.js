//#region src/plugins/claude-tasks-companion/chipState.ts
/**
* Pure decision logic for the Claude status chip: block properties →
* chip descriptor. The property protocol is owned by the claude-tasks
* daemon (packages/claude-tasks/src/config.ts PROPS) — names are
* duplicated here because the app bundle can't depend on that node
* package; keep the two in sync.
*/
var CLAUDE_PROPS = {
	status: "claude:status",
	updatedAt: "claude:updated-at",
	attempts: "claude:attempts",
	error: "claude:error",
	reply: "claude:reply"
};
var chipStateFor = (properties) => {
	const status = properties?.[CLAUDE_PROPS.status];
	if (status !== "queued" && status !== "running" && status !== "done" && status !== "error") return null;
	const updatedAt = properties?.[CLAUDE_PROPS.updatedAt];
	const attempts = properties?.[CLAUDE_PROPS.attempts];
	const error = properties?.[CLAUDE_PROPS.error];
	return {
		kind: status,
		updatedAtMs: typeof updatedAt === "number" && Number.isFinite(updatedAt) ? updatedAt : null,
		attempts: typeof attempts === "number" && attempts > 0 ? Math.floor(attempts) : 1,
		errorMessage: typeof error === "string" ? error : ""
	};
};
var chipTitle = (chip) => {
	switch (chip.kind) {
		case "queued": return "Queued for Claude";
		case "running": return chip.attempts > 1 ? `Claude is working (attempt ${chip.attempts})` : "Claude is working";
		case "done": return chip.updatedAtMs ? `Claude replied · ${new Date(chip.updatedAtMs).toLocaleString()}` : "Claude replied";
		case "error": return chip.errorMessage ? `Claude run failed: ${chip.errorMessage}` : "Claude run failed";
	}
};
//#endregion
export { CLAUDE_PROPS, chipStateFor, chipTitle };

//# sourceMappingURL=chipState.js.map