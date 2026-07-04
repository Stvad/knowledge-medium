//#region src/utils/string.ts
/** Truncate `value` to at most `max` characters, replacing the overflow with a
*  single ellipsis (`…`). Strings already within `max` are returned unchanged.
*  The result is always ≤ `max` chars — the ellipsis occupies the last slot. */
var truncate = (value, max) => value.length > max ? `${value.slice(0, max - 1)}…` : value;
//#endregion
export { truncate };

//# sourceMappingURL=string.js.map