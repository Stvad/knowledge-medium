import { CodecError } from "../../data/api/errors.js";
//#region src/plugins/geo/codecs.ts
/** Plugin-local optional ref codec. Core's `codecs.ref` is non-optional
*  (`Codec<string>`); this is the absence-aware sibling, modeled on
*  `codecs.optionalString`. Kept inside the geo plugin until a second
*  consumer emerges — at which point promoting it to `codecs.optionalRef`
*  in [src/data/api/codecs.ts](../../data/api/codecs.ts) is a trivial
*  follow-up.
*
*  Carries the same `targetTypes` array as a regular `RefCodec` so the
*  property-panel ref-picker can constrain its candidate list. */
var optionalRefCodec = (options) => ({
	type: "ref",
	targetTypes: Object.freeze([...options?.targetTypes ?? []]),
	encode: (v) => v === void 0 ? null : v,
	decode: (j) => {
		if (j === null || j === void 0) return void 0;
		if (typeof j !== "string") throw new CodecError("ref (string id)", j);
		return j;
	}
});
//#endregion
export { optionalRefCodec };

//# sourceMappingURL=codecs.js.map