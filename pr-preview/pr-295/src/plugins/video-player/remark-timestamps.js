import { visit } from "../../../node_modules/unist-util-visit/lib/index.js";
//#region src/plugins/video-player/remark-timestamps.ts
var TS_RE = /(?:(\d{1,3}):)?([0-5]?\d):([0-5]\d)(?:\.(\d{1,3}))?\b/g;
var remarkTimestamps = () => (tree) => {
	visit(tree, "text", (node, index, parent) => {
		const src = node.value;
		const out = [];
		let last = 0;
		for (const m of src.matchAll(TS_RE)) {
			if (m.index > last) out.push({
				type: "text",
				value: src.slice(last, m.index)
			});
			out.push({
				type: "timestamp",
				value: m[0],
				data: {
					hName: "time-stamp",
					hProperties: { hms: m[0] },
					hChildren: [{
						type: "text",
						value: m[0]
					}]
				}
			});
			last = m.index + m[0].length;
		}
		if (out.length) {
			if (last < src.length) out.push({
				type: "text",
				value: src.slice(last)
			});
			parent.children.splice(index, 1, ...out);
			return index + out.length;
		}
	});
};
//#endregion
export { TS_RE, remarkTimestamps };

//# sourceMappingURL=remark-timestamps.js.map