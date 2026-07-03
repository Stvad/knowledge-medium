import { _ as SQLITE_OPEN_WAL, f as SQLITE_OPEN_MAIN_JOURNAL, g as SQLITE_OPEN_TRANSIENT_DB, h as SQLITE_OPEN_TEMP_JOURNAL, m as SQLITE_OPEN_SUPER_JOURNAL, p as SQLITE_OPEN_SUBJOURNAL } from "./WASQLiteDB.worker-Cv45FNmG.js";
//#region node_modules/@journeyapps/wa-sqlite/src/VFS.js
const DEFAULT_SECTOR_SIZE = 512;
var Base = class {
	name;
	mxPathname = 64;
	_module;
	/**
	* @param {string} name 
	* @param {object} module 
	*/
	constructor(name, module) {
		this.name = name;
		this._module = module;
	}
	/**
	* @returns {void|Promise<void>} 
	*/
	close() {}
	/**
	* @returns {boolean|Promise<boolean>}
	*/
	isReady() {
		return true;
	}
	/**
	* Overload in subclasses to indicate which methods are asynchronous.
	* @param {string} methodName 
	* @returns {boolean}
	*/
	hasAsyncMethod(methodName) {
		return false;
	}
	/**
	* @param {number} pVfs 
	* @param {number} zName 
	* @param {number} pFile 
	* @param {number} flags 
	* @param {number} pOutFlags 
	* @returns {number|Promise<number>}
	*/
	xOpen(pVfs, zName, pFile, flags, pOutFlags) {
		return 14;
	}
	/**
	* @param {number} pVfs 
	* @param {number} zName 
	* @param {number} syncDir 
	* @returns {number|Promise<number>}
	*/
	xDelete(pVfs, zName, syncDir) {
		return 0;
	}
	/**
	* @param {number} pVfs 
	* @param {number} zName 
	* @param {number} flags 
	* @param {number} pResOut 
	* @returns {number|Promise<number>}
	*/
	xAccess(pVfs, zName, flags, pResOut) {
		return 0;
	}
	/**
	* @param {number} pVfs 
	* @param {number} zName 
	* @param {number} nOut 
	* @param {number} zOut 
	* @returns {number|Promise<number>}
	*/
	xFullPathname(pVfs, zName, nOut, zOut) {
		return 0;
	}
	/**
	* @param {number} pVfs 
	* @param {number} nBuf 
	* @param {number} zBuf 
	* @returns {number|Promise<number>}
	*/
	xGetLastError(pVfs, nBuf, zBuf) {
		return 0;
	}
	/**
	* @param {number} pFile 
	* @returns {number|Promise<number>}
	*/
	xClose(pFile) {
		return 0;
	}
	/**
	* @param {number} pFile 
	* @param {number} pData 
	* @param {number} iAmt 
	* @param {number} iOffsetLo 
	* @param {number} iOffsetHi 
	* @returns {number|Promise<number>}
	*/
	xRead(pFile, pData, iAmt, iOffsetLo, iOffsetHi) {
		return 0;
	}
	/**
	* @param {number} pFile 
	* @param {number} pData 
	* @param {number} iAmt 
	* @param {number} iOffsetLo 
	* @param {number} iOffsetHi 
	* @returns {number|Promise<number>}
	*/
	xWrite(pFile, pData, iAmt, iOffsetLo, iOffsetHi) {
		return 0;
	}
	/**
	* @param {number} pFile 
	* @param {number} sizeLo 
	* @param {number} sizeHi 
	* @returns {number|Promise<number>}
	*/
	xTruncate(pFile, sizeLo, sizeHi) {
		return 0;
	}
	/**
	* @param {number} pFile 
	* @param {number} flags 
	* @returns {number|Promise<number>}
	*/
	xSync(pFile, flags) {
		return 0;
	}
	/**
	* 
	* @param {number} pFile 
	* @param {number} pSize 
	* @returns {number|Promise<number>}
	*/
	xFileSize(pFile, pSize) {
		return 0;
	}
	/**
	* @param {number} pFile 
	* @param {number} lockType 
	* @returns {number|Promise<number>}
	*/
	xLock(pFile, lockType) {
		return 0;
	}
	/**
	* @param {number} pFile 
	* @param {number} lockType 
	* @returns {number|Promise<number>}
	*/
	xUnlock(pFile, lockType) {
		return 0;
	}
	/**
	* @param {number} pFile 
	* @param {number} pResOut 
	* @returns {number|Promise<number>}
	*/
	xCheckReservedLock(pFile, pResOut) {
		return 0;
	}
	/**
	* @param {number} pFile 
	* @param {number} op 
	* @param {number} pArg 
	* @returns {number|Promise<number>}
	*/
	xFileControl(pFile, op, pArg) {
		return 12;
	}
	/**
	* @param {number} pFile 
	* @returns {number|Promise<number>}
	*/
	xSectorSize(pFile) {
		return DEFAULT_SECTOR_SIZE;
	}
	/**
	* @param {number} pFile 
	* @returns {number|Promise<number>}
	*/
	xDeviceCharacteristics(pFile) {
		return 0;
	}
};
[
	256,
	SQLITE_OPEN_MAIN_JOURNAL,
	512,
	SQLITE_OPEN_TEMP_JOURNAL,
	SQLITE_OPEN_TRANSIENT_DB,
	SQLITE_OPEN_SUBJOURNAL,
	SQLITE_OPEN_SUPER_JOURNAL,
	SQLITE_OPEN_WAL
].reduce((mask, element) => mask | element);
//#endregion
//#region node_modules/@journeyapps/wa-sqlite/src/FacadeVFS.js
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
const UNIX_EPOCH = 24405875n * 8640000n;
var FacadeVFS = class extends Base {
	/**
	* @param {string} name 
	* @param {object} module 
	*/
	constructor(name, module) {
		super(name, module);
	}
	/**
	* Override to indicate which methods are asynchronous.
	* @param {string} methodName 
	* @returns {boolean}
	*/
	hasAsyncMethod(methodName) {
		const jMethodName = `j${methodName.slice(1)}`;
		return this[jMethodName] instanceof AsyncFunction;
	}
	/**
	* Return the filename for a file id for use by mixins.
	* @param {number} pFile 
	* @returns {string}
	*/
	getFilename(pFile) {
		throw new Error("unimplemented");
	}
	/**
	* @param {string?} filename 
	* @param {number} pFile 
	* @param {number} flags 
	* @param {DataView} pOutFlags 
	* @returns {number|Promise<number>}
	*/
	jOpen(filename, pFile, flags, pOutFlags) {
		return 14;
	}
	/**
	* @param {string} filename 
	* @param {number} syncDir 
	* @returns {number|Promise<number>}
	*/
	jDelete(filename, syncDir) {
		return 0;
	}
	/**
	* @param {string} filename 
	* @param {number} flags 
	* @param {DataView} pResOut 
	* @returns {number|Promise<number>}
	*/
	jAccess(filename, flags, pResOut) {
		return 0;
	}
	/**
	* @param {string} filename 
	* @param {Uint8Array} zOut 
	* @returns {number|Promise<number>}
	*/
	jFullPathname(filename, zOut) {
		const { read, written } = new TextEncoder().encodeInto(filename, zOut);
		if (read < filename.length) return 10;
		if (written >= zOut.length) return 10;
		zOut[written] = 0;
		return 0;
	}
	/**
	* @param {Uint8Array} zBuf 
	* @returns {number|Promise<number>}
	*/
	jGetLastError(zBuf) {
		return 0;
	}
	/**
	* @param {number} pFile 
	* @returns {number|Promise<number>}
	*/
	jClose(pFile) {
		return 0;
	}
	/**
	* @param {number} pFile 
	* @param {Uint8Array} pData 
	* @param {number} iOffset 
	* @returns {number|Promise<number>}
	*/
	jRead(pFile, pData, iOffset) {
		pData.fill(0);
		return 522;
	}
	/**
	* @param {number} pFile 
	* @param {Uint8Array} pData 
	* @param {number} iOffset 
	* @returns {number|Promise<number>}
	*/
	jWrite(pFile, pData, iOffset) {
		return 778;
	}
	/**
	* @param {number} pFile 
	* @param {number} size 
	* @returns {number|Promise<number>}
	*/
	jTruncate(pFile, size) {
		return 0;
	}
	/**
	* @param {number} pFile 
	* @param {number} flags 
	* @returns {number|Promise<number>}
	*/
	jSync(pFile, flags) {
		return 0;
	}
	/**
	* @param {number} pFile 
	* @param {DataView} pSize
	* @returns {number|Promise<number>}
	*/
	jFileSize(pFile, pSize) {
		return 0;
	}
	/**
	* @param {number} pFile 
	* @param {number} lockType 
	* @returns {number|Promise<number>}
	*/
	jLock(pFile, lockType) {
		return 0;
	}
	/**
	* @param {number} pFile 
	* @param {number} lockType 
	* @returns {number|Promise<number>}
	*/
	jUnlock(pFile, lockType) {
		return 0;
	}
	/**
	* @param {number} pFile 
	* @param {DataView} pResOut 
	* @returns {number|Promise<number>}
	*/
	jCheckReservedLock(pFile, pResOut) {
		pResOut.setInt32(0, 0, true);
		return 0;
	}
	/**
	* @param {number} pFile
	* @param {number} op
	* @param {DataView} pArg
	* @returns {number|Promise<number>}
	*/
	jFileControl(pFile, op, pArg) {
		return 12;
	}
	/**
	* @param {number} pFile
	* @returns {number|Promise<number>}
	*/
	jSectorSize(pFile) {
		return super.xSectorSize(pFile);
	}
	/**
	* @param {number} pFile
	* @returns {number|Promise<number>}
	*/
	jDeviceCharacteristics(pFile) {
		return 0;
	}
	/**
	* @param {number} pVfs 
	* @param {number} zName 
	* @param {number} pFile 
	* @param {number} flags 
	* @param {number} pOutFlags 
	* @returns {number|Promise<number>}
	*/
	xOpen(pVfs, zName, pFile, flags, pOutFlags) {
		const filename = this.#decodeFilename(zName, flags);
		const pOutFlagsView = this.#makeTypedDataView("Int32", pOutFlags);
		this["log"]?.("jOpen", filename, pFile, "0x" + flags.toString(16));
		return this.jOpen(filename, pFile, flags, pOutFlagsView);
	}
	/**
	* @param {number} pVfs 
	* @param {number} nByte 
	* @param {number} pCharOut
	* @returns {number|Promise<number>}
	*/
	xRandomness(pVfs, nByte, pCharOut) {
		const randomArray = new Uint8Array(nByte);
		crypto.getRandomValues(randomArray);
		const buffer = pCharOut;
		this._module.HEAPU8.set(randomArray, buffer);
		return nByte;
	}
	/**
	* Gets the current time as milliseconds since Unix epoch
	* @param {number} pVfs pointer to the VFS
	* @param {number} pTime pointer to write the time value
	* @returns {number} SQLite error code
	*/
	xCurrentTimeInt64(pVfs, pTime) {
		const timeView = this.#makeTypedDataView("BigInt64", pTime);
		const value = UNIX_EPOCH + BigInt(Date.now());
		timeView.setBigInt64(0, value, true);
		return 0;
	}
	/**
	* @param {number} pVfs 
	* @param {number} zName 
	* @param {number} syncDir 
	* @returns {number|Promise<number>}
	*/
	xDelete(pVfs, zName, syncDir) {
		const filename = this._module.UTF8ToString(zName);
		this["log"]?.("jDelete", filename, syncDir);
		return this.jDelete(filename, syncDir);
	}
	/**
	* @param {number} pVfs 
	* @param {number} zName 
	* @param {number} flags 
	* @param {number} pResOut 
	* @returns {number|Promise<number>}
	*/
	xAccess(pVfs, zName, flags, pResOut) {
		const filename = this._module.UTF8ToString(zName);
		const pResOutView = this.#makeTypedDataView("Int32", pResOut);
		this["log"]?.("jAccess", filename, flags);
		return this.jAccess(filename, flags, pResOutView);
	}
	/**
	* @param {number} pVfs 
	* @param {number} zName 
	* @param {number} nOut 
	* @param {number} zOut 
	* @returns {number|Promise<number>}
	*/
	xFullPathname(pVfs, zName, nOut, zOut) {
		const filename = this._module.UTF8ToString(zName);
		const zOutArray = this._module.HEAPU8.subarray(zOut, zOut + nOut);
		this["log"]?.("jFullPathname", filename, nOut);
		return this.jFullPathname(filename, zOutArray);
	}
	/**
	* @param {number} pVfs 
	* @param {number} nBuf 
	* @param {number} zBuf 
	* @returns {number|Promise<number>}
	*/
	xGetLastError(pVfs, nBuf, zBuf) {
		const zBufArray = this._module.HEAPU8.subarray(zBuf, zBuf + nBuf);
		this["log"]?.("jGetLastError", nBuf);
		return this.jGetLastError(zBufArray);
	}
	/**
	* @param {number} pFile 
	* @returns {number|Promise<number>}
	*/
	xClose(pFile) {
		this["log"]?.("jClose", pFile);
		return this.jClose(pFile);
	}
	/**
	* @param {number} pFile 
	* @param {number} pData 
	* @param {number} iAmt 
	* @param {number} iOffsetLo 
	* @param {number} iOffsetHi 
	* @returns {number|Promise<number>}
	*/
	xRead(pFile, pData, iAmt, iOffsetLo, iOffsetHi) {
		const pDataArray = this.#makeDataArray(pData, iAmt);
		const iOffset = delegalize(iOffsetLo, iOffsetHi);
		this["log"]?.("jRead", pFile, iAmt, iOffset);
		return this.jRead(pFile, pDataArray, iOffset);
	}
	/**
	* @param {number} pFile 
	* @param {number} pData 
	* @param {number} iAmt 
	* @param {number} iOffsetLo 
	* @param {number} iOffsetHi 
	* @returns {number|Promise<number>}
	*/
	xWrite(pFile, pData, iAmt, iOffsetLo, iOffsetHi) {
		const pDataArray = this.#makeDataArray(pData, iAmt);
		const iOffset = delegalize(iOffsetLo, iOffsetHi);
		this["log"]?.("jWrite", pFile, pDataArray, iOffset);
		return this.jWrite(pFile, pDataArray, iOffset);
	}
	/**
	* @param {number} pFile 
	* @param {number} sizeLo 
	* @param {number} sizeHi 
	* @returns {number|Promise<number>}
	*/
	xTruncate(pFile, sizeLo, sizeHi) {
		const size = delegalize(sizeLo, sizeHi);
		this["log"]?.("jTruncate", pFile, size);
		return this.jTruncate(pFile, size);
	}
	/**
	* @param {number} pFile 
	* @param {number} flags 
	* @returns {number|Promise<number>}
	*/
	xSync(pFile, flags) {
		this["log"]?.("jSync", pFile, flags);
		return this.jSync(pFile, flags);
	}
	/**
	* 
	* @param {number} pFile 
	* @param {number} pSize 
	* @returns {number|Promise<number>}
	*/
	xFileSize(pFile, pSize) {
		const pSizeView = this.#makeTypedDataView("BigInt64", pSize);
		this["log"]?.("jFileSize", pFile);
		return this.jFileSize(pFile, pSizeView);
	}
	/**
	* @param {number} pFile 
	* @param {number} lockType 
	* @returns {number|Promise<number>}
	*/
	xLock(pFile, lockType) {
		this["log"]?.("jLock", pFile, lockType);
		return this.jLock(pFile, lockType);
	}
	/**
	* @param {number} pFile 
	* @param {number} lockType 
	* @returns {number|Promise<number>}
	*/
	xUnlock(pFile, lockType) {
		this["log"]?.("jUnlock", pFile, lockType);
		return this.jUnlock(pFile, lockType);
	}
	/**
	* @param {number} pFile 
	* @param {number} pResOut 
	* @returns {number|Promise<number>}
	*/
	xCheckReservedLock(pFile, pResOut) {
		const pResOutView = this.#makeTypedDataView("Int32", pResOut);
		this["log"]?.("jCheckReservedLock", pFile);
		return this.jCheckReservedLock(pFile, pResOutView);
	}
	/**
	* @param {number} pFile 
	* @param {number} op 
	* @param {number} pArg 
	* @returns {number|Promise<number>}
	*/
	xFileControl(pFile, op, pArg) {
		const pArgView = new DataView(this._module.HEAPU8.buffer, this._module.HEAPU8.byteOffset + pArg);
		this["log"]?.("jFileControl", pFile, op, pArgView);
		return this.jFileControl(pFile, op, pArgView);
	}
	/**
	* @param {number} pFile 
	* @returns {number|Promise<number>}
	*/
	xSectorSize(pFile) {
		this["log"]?.("jSectorSize", pFile);
		return this.jSectorSize(pFile);
	}
	/**
	* @param {number} pFile 
	* @returns {number|Promise<number>}
	*/
	xDeviceCharacteristics(pFile) {
		this["log"]?.("jDeviceCharacteristics", pFile);
		return this.jDeviceCharacteristics(pFile);
	}
	/**
	* Wrapped DataView for pointer arguments.
	* Pointers to a single value are passed using a DataView-like class.
	* This wrapper class prevents use of incorrect type or endianness, and
	* reacquires the underlying buffer when the WebAssembly memory is resized.
	* @param {'Int32'|'BigInt64'} type 
	* @param {number} byteOffset 
	* @returns {DataView}
	*/
	#makeTypedDataView(type, byteOffset) {
		return new DataViewProxy(this._module, byteOffset, type);
	}
	/**
	* Wrapped Uint8Array for buffer arguments.
	* Memory blocks are passed as a Uint8Array-like class. This wrapper
	* class reacquires the underlying buffer when the WebAssembly memory
	* is resized.
	* @param {number} byteOffset 
	* @param {number} byteLength 
	* @returns {Uint8Array}
	*/
	#makeDataArray(byteOffset, byteLength) {
		return new Uint8ArrayProxy(this._module, byteOffset, byteLength);
	}
	#decodeFilename(zName, flags) {
		if (flags & 64) {
			let pName = zName;
			let state = 1;
			const charCodes = [];
			while (state) {
				const charCode = this._module.HEAPU8[pName++];
				if (charCode) charCodes.push(charCode);
				else {
					if (!this._module.HEAPU8[pName]) state = null;
					switch (state) {
						case 1:
							charCodes.push("?".charCodeAt(0));
							state = 2;
							break;
						case 2:
							charCodes.push("=".charCodeAt(0));
							state = 3;
							break;
						case 3:
							charCodes.push("&".charCodeAt(0));
							state = 2;
							break;
					}
				}
			}
			return new TextDecoder().decode(new Uint8Array(charCodes));
		}
		return zName ? this._module.UTF8ToString(zName) : null;
	}
};
function delegalize(lo32, hi32) {
	return hi32 * 4294967296 + lo32 + (lo32 < 0 ? 2 ** 32 : 0);
}
var Uint8ArrayProxy = class {
	#module;
	#_array = new Uint8Array();
	get #array() {
		if (this.#_array.buffer.byteLength === 0) this.#_array = this.#module.HEAPU8.subarray(this.byteOffset, this.byteOffset + this.byteLength);
		return this.#_array;
	}
	/**
	* @param {*} module
	* @param {number} byteOffset 
	* @param {number} byteLength 
	*/
	constructor(module, byteOffset, byteLength) {
		this.#module = module;
		this.byteOffset = byteOffset;
		this.length = this.byteLength = byteLength;
	}
	get buffer() {
		return this.#array.buffer;
	}
	at(index) {
		return this.#array.at(index);
	}
	copyWithin(target, start, end) {
		this.#array.copyWithin(target, start, end);
	}
	entries() {
		return this.#array.entries();
	}
	every(predicate) {
		return this.#array.every(predicate);
	}
	fill(value, start, end) {
		this.#array.fill(value, start, end);
	}
	filter(predicate) {
		return this.#array.filter(predicate);
	}
	find(predicate) {
		return this.#array.find(predicate);
	}
	findIndex(predicate) {
		return this.#array.findIndex(predicate);
	}
	findLast(predicate) {
		return this.#array.findLast(predicate);
	}
	findLastIndex(predicate) {
		return this.#array.findLastIndex(predicate);
	}
	forEach(callback) {
		this.#array.forEach(callback);
	}
	includes(value, start) {
		return this.#array.includes(value, start);
	}
	indexOf(value, start) {
		return this.#array.indexOf(value, start);
	}
	join(separator) {
		return this.#array.join(separator);
	}
	keys() {
		return this.#array.keys();
	}
	lastIndexOf(value, start) {
		return this.#array.lastIndexOf(value, start);
	}
	map(callback) {
		return this.#array.map(callback);
	}
	reduce(callback, initialValue) {
		return this.#array.reduce(callback, initialValue);
	}
	reduceRight(callback, initialValue) {
		return this.#array.reduceRight(callback, initialValue);
	}
	reverse() {
		this.#array.reverse();
	}
	set(array, offset) {
		this.#array.set(array, offset);
	}
	slice(start, end) {
		return this.#array.slice(start, end);
	}
	some(predicate) {
		return this.#array.some(predicate);
	}
	sort(compareFn) {
		this.#array.sort(compareFn);
	}
	subarray(begin, end) {
		return this.#array.subarray(begin, end);
	}
	toLocaleString(locales, options) {
		return this.#array.toLocaleString(locales, options);
	}
	toReversed() {
		return this.#array.toReversed();
	}
	toSorted(compareFn) {
		return this.#array.toSorted(compareFn);
	}
	toString() {
		return this.#array.toString();
	}
	values() {
		return this.#array.values();
	}
	with(index, value) {
		return this.#array.with(index, value);
	}
	[Symbol.iterator]() {
		return this.#array[Symbol.iterator]();
	}
};
var DataViewProxy = class {
	#module;
	#type;
	#_view = /* @__PURE__ */ new DataView(/* @__PURE__ */ new ArrayBuffer(0));
	get #view() {
		if (this.#_view.buffer.byteLength === 0) this.#_view = new DataView(this.#module.HEAPU8.buffer, this.#module.HEAPU8.byteOffset + this.byteOffset);
		return this.#_view;
	}
	/**
	* @param {*} module
	* @param {number} byteOffset 
	* @param {'Int32'|'BigInt64'} type
	*/
	constructor(module, byteOffset, type) {
		this.#module = module;
		this.byteOffset = byteOffset;
		this.#type = type;
	}
	get buffer() {
		return this.#view.buffer;
	}
	get byteLength() {
		return this.#type === "Int32" ? 4 : 8;
	}
	getInt32(byteOffset, littleEndian) {
		if (this.#type !== "Int32") throw new Error("invalid type");
		if (!littleEndian) throw new Error("must be little endian");
		return this.#view.getInt32(byteOffset, littleEndian);
	}
	setInt32(byteOffset, value, littleEndian) {
		if (this.#type !== "Int32") throw new Error("invalid type");
		if (!littleEndian) throw new Error("must be little endian");
		this.#view.setInt32(byteOffset, value, littleEndian);
	}
	getBigInt64(byteOffset, littleEndian) {
		if (this.#type !== "BigInt64") throw new Error("invalid type");
		if (!littleEndian) throw new Error("must be little endian");
		return this.#view.getBigInt64(byteOffset, littleEndian);
	}
	setBigInt64(byteOffset, value, littleEndian) {
		if (this.#type !== "BigInt64") throw new Error("invalid type");
		if (!littleEndian) throw new Error("must be little endian");
		this.#view.setBigInt64(byteOffset, value, littleEndian);
	}
};
//#endregion
export { FacadeVFS as t };

//# sourceMappingURL=FacadeVFS-DzFqjpSN.js.map