import { CodecError } from "./errors.js";
//#region src/data/api/codecs.ts
var stringCodec = {
	type: "string",
	encode: (v) => v,
	decode: (j) => {
		if (typeof j !== "string") throw new CodecError("string", j);
		return j;
	},
	where: { encode: (v) => {
		if (typeof v !== "string") throw new CodecError("string", v);
		return v;
	} }
};
var requireFiniteNumber = (value) => {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new CodecError("finite number", value);
	return value;
};
var numberCodec = {
	type: "number",
	encode: requireFiniteNumber,
	decode: requireFiniteNumber,
	where: { encode: requireFiniteNumber }
};
var booleanCodec = {
	type: "boolean",
	encode: (v) => v,
	decode: (j) => {
		if (typeof j !== "boolean") throw new CodecError("boolean", j);
		return j;
	},
	where: { encode: (v) => {
		if (typeof v !== "boolean") throw new CodecError("boolean", v);
		return v ? 1 : 0;
	} }
};
/** Date codec is natively absence-aware — value type is `Date | undefined`,
*  encode produces JSON null on undefined, decode round-trips. There's
*  no inert "no value" Date sentinel (every Date instance is a real
*  time), so absence has to be expressible at the codec level. See the
*  user-defined-properties.md "Why no codecs.optional" section. */
var dateCodec = {
	type: "date",
	encode: (v) => v === void 0 ? null : v.toISOString(),
	decode: (j) => {
		if (j === null || j === void 0) return void 0;
		if (typeof j !== "string") throw new CodecError("date", j);
		const d = new Date(j);
		if (Number.isNaN(d.getTime())) throw new CodecError("date", j);
		return d;
	},
	where: { encode: (v) => {
		if (v === void 0) throw new CodecError("date (use null for unset)", v);
		if (typeof v === "string") {
			const d = new Date(v);
			if (Number.isNaN(d.getTime())) throw new CodecError("date", v);
			return d.toISOString();
		}
		if (!(v instanceof Date) || Number.isNaN(v.getTime())) throw new CodecError("date", v);
		return v.toISOString();
	} }
};
var list = (inner) => ({
	type: "list",
	encode: (v) => v.map((item) => inner.encode(item)),
	decode: (j) => {
		if (!Array.isArray(j)) throw new CodecError("array", j);
		return j.map((item) => inner.decode(item));
	}
});
var normalizeTargetTypes = (options = {}) => Object.freeze([...options.targetTypes ?? []]);
var ref = (options) => ({
	type: "ref",
	targetTypes: normalizeTargetTypes(options),
	encode: stringCodec.encode,
	decode: stringCodec.decode
});
var refList = (options) => {
	return {
		type: "refList",
		targetTypes: normalizeTargetTypes(options),
		encode: (v) => v.map((item) => stringCodec.encode(item)),
		decode: (j) => {
			if (!Array.isArray(j)) throw new CodecError("array", j);
			return j.map((item) => stringCodec.decode(item));
		},
		decodeValid: (j) => {
			if (!Array.isArray(j)) return [];
			const out = [];
			for (const item of j) try {
				out.push(stringCodec.decode(item));
			} catch {}
			return out;
		}
	};
};
var normalizeEnumOptions = (options) => Object.freeze(options.map((option) => typeof option === "string" ? {
	value: option,
	label: option
} : {
	value: option.value,
	label: option.label
}));
/** Build a codec that accepts the given string `options`. Writes are
*  strict — `encode` (and `where`) reject any out-of-set value, so a
*  hand-edit or a setProperty can't store an invalid choice. Reads are
*  lenient on membership: `decode` only checks the value is a string, so
*  a value stored *before* an option was removed/renamed still decodes
*  and stays editable in the select (which surfaces it as an unknown
*  option) instead of rendering as a decode failure / raw JSON. A
*  non-string is still a genuine shape error and throws.
*
*  The `const` type parameter infers `T` as the literal union from a bare
*  string-array call (`codecs.enum(['a', 'b'])` → `EnumCodec<'a' | 'b'>`). */
var enumCodec = (options) => {
	const normalized = normalizeEnumOptions(options);
	const allowed = new Set(normalized.map((option) => option.value));
	const expected = `enum(${normalized.map((option) => option.value).join("|")})`;
	const requireString = (value) => {
		if (typeof value !== "string") throw new CodecError(expected, value);
		return value;
	};
	const requireMember = (value) => {
		const str = requireString(value);
		if (!allowed.has(str)) throw new CodecError(expected, value);
		return str;
	};
	return {
		type: "enum",
		options: normalized,
		encode: requireMember,
		decode: requireString,
		where: { encode: requireMember }
	};
};
var isEnumCodec = (codec) => typeof codec === "object" && codec !== null && codec.type === "enum";
var isRefCodec = (codec) => typeof codec === "object" && codec !== null && codec.type === "ref";
var isRefListCodec = (codec) => typeof codec === "object" && codec !== null && codec.type === "refList";
/** Project a refList codec's value to its well-formed ref ids — the
*  reference-projection-safe entry point. Prefers the codec's own lenient
*  `decodeValid`; falls back to a method-free string filter for a
*  `RefListCodec` authored against the pre-`decodeValid` public interface
*  (`isRefListCodec` narrows on the discriminator alone, so such a codec
*  reaches here). `RefListCodec` is `Codec<readonly string[]>`, so
*  well-formed elements are strings — keep those, drop the rest. Total by
*  construction: never throws, so one malformed element OR a missing
*  method drops only what it must and never aborts the block's projection
*  (issue #189 + its follow-up). */
var decodeRefListIds = (codec, value) => {
	if (typeof codec.decodeValid === "function") return codec.decodeValid(value);
	if (!Array.isArray(value)) return [];
	return value.filter((item) => typeof item === "string");
};
/** URL codec: plain string with light validation on encode/decode.
*  Currently accepts any non-empty string; tightening the validation
*  (URL parser, allowed schemes) is a follow-up. */
var validateUrlString = (value) => {
	if (typeof value !== "string") throw new CodecError("url", value);
	return value;
};
var urlCodec = {
	type: "url",
	encode: validateUrlString,
	decode: validateUrlString,
	where: { encode: validateUrlString }
};
/** Explicitly unsafe identity codec. Reserved for kernel-internal use where
*  the JSON shape is guaranteed by construction. NOT a default for plugin
*  authors — pick a primitive codec or compose your own. The `type`
*  argument lets callers tag the codec for the `inferTypeFromValue`
*  fallback path; pass `'object'` for object-shaped data, `'string'`
*  for opaque strings, etc. */
var unsafeIdentity = (type = "object") => ({
	type,
	encode: (v) => v,
	decode: (j) => j
});
/** Absence-aware string codec for kernel/plugin properties whose value
*  type is `string | undefined`. NOT a generic wrapper — concrete codec
*  with the `'string'` `type` discriminator. Callers narrow to the
*  absence-aware variant via TypeScript on the schema's value type, not
*  via `c.type`. See the "Why no codecs.optional" section. */
var optionalStringCodec = {
	type: "string",
	encode: (v) => v === void 0 ? null : v,
	decode: (j) => {
		if (j === null || j === void 0) return void 0;
		if (typeof j !== "string") throw new CodecError("string", j);
		return j;
	},
	where: { encode: (v) => {
		if (v === void 0) throw new CodecError("string (use null for unset)", v);
		if (typeof v !== "string") throw new CodecError("string", v);
		return v;
	} }
};
/** Absence-aware number codec — pair to `optionalString`. */
var optionalNumberCodec = {
	type: "number",
	encode: (v) => v === void 0 ? null : v,
	decode: (j) => {
		if (j === null || j === void 0) return void 0;
		if (typeof j !== "number" || !Number.isFinite(j)) throw new CodecError("finite number", j);
		return j;
	},
	where: { encode: (v) => {
		if (v === void 0) throw new CodecError("number (use null for unset)", v);
		if (typeof v !== "number" || !Number.isFinite(v)) throw new CodecError("finite number", v);
		return v;
	} }
};
/** Absence-aware unsafe-identity codec for engine-controlled object
*  state (editor selection, plugin-internal blobs). Same trust model as
*  `unsafeIdentity`: kernel/plugin owns the JSON shape, no validation. */
var optionalIdentity = (type = "object") => ({
	type,
	encode: (v) => v === void 0 ? null : v,
	decode: (j) => j === null || j === void 0 ? void 0 : j
});
var codecs = {
	string: stringCodec,
	number: numberCodec,
	boolean: booleanCodec,
	/** Date codec is natively absence-aware (`Codec<Date | undefined>`).
	*  No generic `codecs.optional` wrapper exists — see the
	*  user-defined-properties.md "Why no codecs.optional" section. */
	date: dateCodec,
	url: urlCodec,
	/** Fixed-set string codec; options ride on the codec for the select
	*  editor. See `EnumCodec`. */
	enum: enumCodec,
	list,
	ref,
	refList,
	unsafeIdentity,
	optionalString: optionalStringCodec,
	optionalNumber: optionalNumberCodec,
	optionalIdentity
};
//#endregion
export { CodecError, codecs, decodeRefListIds, isEnumCodec, isRefCodec, isRefListCodec };

//# sourceMappingURL=codecs.js.map