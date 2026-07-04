//#region src/data/api/sameTxProcessor.ts
/** Thrown by a same-tx processor to reject the user's tx. The
*  SQLite `writeTransaction` aborts; the error bubbles out of
*  `repo.tx` to the caller. Top-level handlers (editor save, chip
*  edit, command palette) catch this and surface the error via the
*  toast layer using `code` + `meta` to format the message.
*
*  Distinct error class so callers can `if (err instanceof
*  ProcessorRejection)` without parsing messages. `code` is a
*  stable string like `'alias.collision'` for routing to the right
*  UI affordance. `meta` carries structured detail the toast can
*  use for action buttons / formatted messages. */
var ProcessorRejection = class extends Error {
	constructor(message, code, meta) {
		super(message);
		this.code = code;
		this.meta = meta;
		this.name = "ProcessorRejection";
	}
};
var defineSameTxProcessor = (processor) => processor;
//#endregion
export { ProcessorRejection, defineSameTxProcessor };

//# sourceMappingURL=sameTxProcessor.js.map