//#region src/utils/callbackSet.ts
var CallbackSet = class {
	listeners = /* @__PURE__ */ new Set();
	label;
	constructor(label) {
		this.label = label;
	}
	add(listener) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	notify(...args) {
		for (const listener of [...this.listeners]) try {
			listener(...args);
		} catch (err) {
			const tag = this.label ? ` ${this.label}` : "";
			console.warn(`[CallbackSet${tag}] listener threw:`, err);
		}
	}
	get size() {
		return this.listeners.size;
	}
	clear() {
		this.listeners.clear();
	}
};
//#endregion
export { CallbackSet };

//# sourceMappingURL=callbackSet.js.map