import { isRefCodec, isRefListCodec } from "../../data/api/codecs.js";
import "../../data/api/index.js";
//#region src/plugins/backlinks/propertyFilter.ts
/** Resolves how a registered property is filtered in the backlinks UI.
*
*  Pulls together three sources of truth and presents a single shape
*  the filter form consumes:
*    - the codec's `where` capability (is this storage-comparable?),
*    - the codec's `type` discriminator (date/number get richer
*      comparison operators; everything else with `where` is eq-only),
*    - the `refTargetFilterDefaultsFacet` (a ref/refList to a known
*      target type is presented as a filter on the target's default
*      inner property — daily-notes contributes daily-note:date).
*
*  Keeps domain-specific knowledge (daily-note-as-date) in the
*  contributing plugin. The UI never special-cases a property name. */
var COMPARISON_OPERATORS = [
	"eq",
	"lt",
	"lte",
	"gt",
	"gte",
	"between",
	"exists-true",
	"exists-false"
];
var EQ_OPERATORS = [
	"eq",
	"exists-true",
	"exists-false"
];
var PRESENCE_OPERATORS = ["exists-true", "exists-false"];
var operatorArity = (op) => op === "exists-true" || op === "exists-false" ? 0 : op === "between" ? 2 : 1;
/** Affordance for a scalar codec, keyed by the codec's `type`
*  discriminator. Date and number get the full comparison menu; other
*  where-capable codecs (string/url/boolean) keep eq-only. */
var scalarAffordance = (codecType, whereCapable) => {
	const operators = !whereCapable ? PRESENCE_OPERATORS : codecType === "date" || codecType === "number" ? COMPARISON_OPERATORS : EQ_OPERATORS;
	const inputKind = codecType === "date" ? "date" : codecType === "number" ? "number" : codecType === "boolean" ? "boolean" : "text";
	const parse = (raw) => {
		if (raw === "") return void 0;
		if (codecType === "date") {
			const d = /* @__PURE__ */ new Date(`${raw}T00:00:00.000Z`);
			return Number.isNaN(d.getTime()) ? void 0 : d;
		}
		if (codecType === "number") {
			const n = Number(raw);
			return Number.isFinite(n) ? n : void 0;
		}
		if (codecType === "boolean") return raw === "true";
		return raw;
	};
	const build = (propertyName, operator, values) => {
		const whereValue = buildScalarWhereValue(operator, values, parse);
		if (whereValue === INCOMPLETE) return null;
		return {
			scope: "ancestor",
			where: { [propertyName]: whereValue }
		};
	};
	return {
		operators,
		inputKind,
		parse,
		build
	};
};
var INCOMPLETE = Symbol("incomplete");
var buildScalarWhereValue = (operator, values, parse) => {
	if (operator === "exists-true") return { exists: true };
	if (operator === "exists-false") return null;
	if (operator === "between") {
		const lo = parse(values[0] ?? "");
		const hi = parse(values[1] ?? "");
		if (lo === void 0 || hi === void 0) return INCOMPLETE;
		return { between: [lo, hi] };
	}
	const operand = parse(values[0] ?? "");
	if (operand === void 0) return operator === "eq" ? null : INCOMPLETE;
	return { [operator]: operand };
};
/** Wrap a scalar affordance with the typed-query `target` traversal so
*  a ref/refList property surfaces the inner property's UX. */
var targetTraversalAffordance = (inner, innerPropertyName) => ({
	operators: inner.operators,
	inputKind: inner.inputKind,
	parse: inner.parse,
	build: (propertyName, operator, values) => {
		if (operator === "exists-true") return {
			scope: "ancestor",
			where: { [propertyName]: { target: {} } }
		};
		if (operator === "exists-false") return {
			scope: "ancestor",
			where: { [propertyName]: null }
		};
		const inner_ = buildScalarWhereValue(operator, values, inner.parse);
		if (inner_ === INCOMPLETE) return null;
		return {
			scope: "ancestor",
			where: { [propertyName]: { target: { [innerPropertyName]: inner_ } } }
		};
	}
});
var presenceOnlyAffordance = {
	operators: PRESENCE_OPERATORS,
	inputKind: "text",
	parse: () => void 0,
	build: (propertyName, operator) => {
		if (operator === "exists-true") return {
			scope: "ancestor",
			where: { [propertyName]: { exists: true } }
		};
		if (operator === "exists-false") return {
			scope: "ancestor",
			where: { [propertyName]: null }
		};
		return null;
	}
};
var resolvePropertyFilter = (schema, schemas, refTargetDefaults) => {
	if (isRefCodec(schema.codec) || isRefListCodec(schema.codec)) {
		for (const targetType of schema.codec.targetTypes) {
			const entry = refTargetDefaults.get(targetType);
			if (!entry) continue;
			const innerSchema = schemas.get(entry.property);
			if (!innerSchema) continue;
			return targetTraversalAffordance(resolvePropertyFilter(innerSchema, schemas, refTargetDefaults), entry.property);
		}
		return presenceOnlyAffordance;
	}
	return scalarAffordance(schema.codec.type, schema.codec.where !== void 0);
};
var propertyFilterOperatorArity = operatorArity;
//#endregion
export { propertyFilterOperatorArity, resolvePropertyFilter };

//# sourceMappingURL=propertyFilter.js.map