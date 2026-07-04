//#region src/utils/templateLiterals.ts
/**
* It reconstructs the string from its parts (strings and values).
*/
var reassembleTag = (strings, ...values) => {
	return values.reduce((result, currentValue, index) => {
		return result + String(currentValue) + strings[index + 1];
	}, strings[0]);
};
var reassembleTagProducer = (consumer) => (strings, ...values) => consumer(reassembleTag(strings, ...values));
//#endregion
export { reassembleTag, reassembleTagProducer };

//# sourceMappingURL=templateLiterals.js.map