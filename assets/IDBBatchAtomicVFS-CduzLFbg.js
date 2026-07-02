import { a as SQLITE_IOERR_CLOSE, c as SQLITE_IOERR_FSYNC, d as SQLITE_IOERR_UNLOCK, i as SQLITE_IOERR_CHECKRESERVEDLOCK, l as SQLITE_IOERR_LOCK, n as SQLITE_IOCAP_UNDELETABLE_WHEN_OPEN, o as SQLITE_IOERR_DELETE, r as SQLITE_IOERR_ACCESS, s as SQLITE_IOERR_FSTAT, t as SQLITE_IOCAP_BATCH_ATOMIC, u as SQLITE_IOERR_TRUNCATE } from "./WASQLiteDB.worker-BdG43l4g.js";
import { t as FacadeVFS } from "./FacadeVFS-eYPkYDY5.js";
//#region node_modules/@journeyapps/wa-sqlite/src/WebLocksMixin.js
/** @type {LockOptions} */ const SHARED = { mode: "shared" };
/** @type {LockOptions} */ const POLL_SHARED = {
	ifAvailable: true,
	mode: "shared"
};
/** @type {LockOptions} */ const POLL_EXCLUSIVE = {
	ifAvailable: true,
	mode: "exclusive"
};
const POLICIES = [
	"exclusive",
	"shared",
	"shared+hint"
];
/**
* @typedef LockState
* @property {string} baseName
* @property {number} type
* @property {boolean} writeHint
* 
* These properties are functions that release a specific lock.
* @property {(() => void)?} [gate]
* @property {(() => void)?} [access]
* @property {(() => void)?} [reserved]
* @property {(() => void)?} [hint]
*/
/**
* Mix-in for FacadeVFS that implements the SQLite VFS locking protocol.
* @param {*} superclass FacadeVFS (or subclass)
* @returns 
*/
const WebLocksMixin = (superclass) => class extends superclass {
	#options = {
		lockPolicy: "exclusive",
		lockTimeout: Infinity
	};
	/** @type {Map<number, LockState>} */ #mapIdToState = /* @__PURE__ */ new Map();
	constructor(name, module, options) {
		super(name, module, options);
		Object.assign(this.#options, options);
		if (POLICIES.indexOf(this.#options.lockPolicy) === -1) throw new Error(`WebLocksMixin: invalid lock mode: ${options.lockPolicy}`);
	}
	/**
	* @param {number} fileId 
	* @param {number} lockType 
	* @returns {Promise<number>}
	*/
	async jLock(fileId, lockType) {
		try {
			const lockState = this.#getLockState(fileId);
			if (lockType <= lockState.type) return 0;
			switch (this.#options.lockPolicy) {
				case "exclusive": return await this.#lockExclusive(lockState, lockType);
				case "shared":
				case "shared+hint": return await this.#lockShared(lockState, lockType);
			}
		} catch (e) {
			console.error("WebLocksMixin: lock error", e);
			return SQLITE_IOERR_LOCK;
		}
	}
	/**
	* @param {number} fileId 
	* @param {number} lockType 
	* @returns {Promise<number>}
	*/
	async jUnlock(fileId, lockType) {
		try {
			const lockState = this.#getLockState(fileId);
			if (!(lockType < lockState.type)) return 0;
			switch (this.#options.lockPolicy) {
				case "exclusive": return await this.#unlockExclusive(lockState, lockType);
				case "shared":
				case "shared+hint": return await this.#unlockShared(lockState, lockType);
			}
		} catch (e) {
			console.error("WebLocksMixin: unlock error", e);
			return SQLITE_IOERR_UNLOCK;
		}
	}
	/**
	* @param {number} fileId 
	* @param {DataView} pResOut 
	* @returns {Promise<number>}
	*/
	async jCheckReservedLock(fileId, pResOut) {
		try {
			const lockState = this.#getLockState(fileId);
			switch (this.#options.lockPolicy) {
				case "exclusive": return this.#checkReservedExclusive(lockState, pResOut);
				case "shared":
				case "shared+hint": return await this.#checkReservedShared(lockState, pResOut);
			}
		} catch (e) {
			console.error("WebLocksMixin: check reserved lock error", e);
			return SQLITE_IOERR_CHECKRESERVEDLOCK;
		}
		pResOut.setInt32(0, 0, true);
		return 0;
	}
	/**
	* @param {number} fileId
	* @param {number} op
	* @param {DataView} pArg
	* @returns {number|Promise<number>}
	*/
	jFileControl(fileId, op, pArg) {
		if (op === WebLocksMixin.WRITE_HINT_OP_CODE && this.#options.lockPolicy === "shared+hint") {
			const lockState = this.#getLockState(fileId);
			lockState.writeHint = true;
		}
		return 12;
	}
	#getLockState(fileId) {
		let lockState = this.#mapIdToState.get(fileId);
		if (!lockState) {
			lockState = {
				baseName: this.getFilename(fileId),
				type: 0,
				writeHint: false
			};
			this.#mapIdToState.set(fileId, lockState);
		}
		return lockState;
	}
	/**
	* @param {LockState} lockState 
	* @param {number} lockType 
	* @returns 
	*/
	async #lockExclusive(lockState, lockType) {
		if (!lockState.access) {
			if (!await this.#acquire(lockState, "access")) return 5;
			console.assert(!!lockState.access);
		}
		lockState.type = lockType;
		return 0;
	}
	/**
	* @param {LockState} lockState 
	* @param {number} lockType 
	* @returns {number}
	*/
	#unlockExclusive(lockState, lockType) {
		if (lockType === 0) {
			lockState.access?.();
			console.assert(!lockState.access);
		}
		lockState.type = lockType;
		return 0;
	}
	/**
	* @param {LockState} lockState 
	* @param {DataView} pResOut 
	* @returns {number}
	*/
	#checkReservedExclusive(lockState, pResOut) {
		pResOut.setInt32(0, 0, true);
		return 0;
	}
	/**
	* @param {LockState} lockState 
	* @param {number} lockType 
	* @returns 
	*/
	async #lockShared(lockState, lockType) {
		switch (lockState.type) {
			case 0:
				switch (lockType) {
					case 1:
						if (lockState.writeHint) {
							if (!await this.#acquire(lockState, "hint")) return 5;
						}
						if (!await this.#acquire(lockState, "gate", SHARED)) {
							lockState.hint?.();
							return 5;
						}
						await this.#acquire(lockState, "access", SHARED);
						lockState.gate();
						console.assert(!lockState.gate);
						console.assert(!!lockState.access);
						console.assert(!lockState.reserved);
						break;
					default: throw new Error("unsupported lock transition");
				}
				break;
			case 1:
				switch (lockType) {
					case 2:
						if (this.#options.lockPolicy === "shared+hint") {
							if (!lockState.hint && !await this.#acquire(lockState, "hint", POLL_EXCLUSIVE)) return 5;
						}
						if (!await this.#acquire(lockState, "reserved", POLL_EXCLUSIVE)) {
							lockState.hint?.();
							return 5;
						}
						lockState.access();
						console.assert(!lockState.gate);
						console.assert(!lockState.access);
						console.assert(!!lockState.reserved);
						break;
					case 4:
						if (!await this.#acquire(lockState, "gate")) return 5;
						lockState.access();
						if (!await this.#acquire(lockState, "access")) {
							lockState.gate();
							return 5;
						}
						console.assert(!!lockState.gate);
						console.assert(!!lockState.access);
						console.assert(!lockState.reserved);
						break;
					default: throw new Error("unsupported lock transition");
				}
				break;
			case 2:
				switch (lockType) {
					case 4:
						if (!await this.#acquire(lockState, "gate")) return 5;
						if (!await this.#acquire(lockState, "access")) {
							lockState.gate();
							return 5;
						}
						console.assert(!!lockState.gate);
						console.assert(!!lockState.access);
						console.assert(!!lockState.reserved);
						break;
					default: throw new Error("unsupported lock transition");
				}
				break;
		}
		lockState.type = lockType;
		return 0;
	}
	/**
	* @param {LockState} lockState 
	* @param {number} lockType 
	* @returns 
	*/
	async #unlockShared(lockState, lockType) {
		if (lockType === 0) {
			lockState.access?.();
			lockState.gate?.();
			lockState.reserved?.();
			lockState.hint?.();
			lockState.writeHint = false;
			console.assert(!lockState.access);
			console.assert(!lockState.gate);
			console.assert(!lockState.reserved);
			console.assert(!lockState.hint);
		} else switch (lockState.type) {
			case 4:
				lockState.access();
				await this.#acquire(lockState, "access", SHARED);
				lockState.gate();
				lockState.reserved?.();
				lockState.hint?.();
				console.assert(!!lockState.access);
				console.assert(!lockState.gate);
				console.assert(!lockState.reserved);
				break;
			case 2:
				await this.#acquire(lockState, "access", SHARED);
				lockState.reserved();
				lockState.hint?.();
				console.assert(!!lockState.access);
				console.assert(!lockState.gate);
				console.assert(!lockState.reserved);
				break;
		}
		lockState.type = lockType;
		return 0;
	}
	/**
	* @param {LockState} lockState 
	* @param {DataView} pResOut 
	* @returns {Promise<number>}
	*/
	async #checkReservedShared(lockState, pResOut) {
		if (await this.#acquire(lockState, "reserved", POLL_SHARED)) {
			lockState.reserved();
			pResOut.setInt32(0, 0, true);
		} else pResOut.setInt32(0, 1, true);
		return 0;
	}
	/**
	* @param {LockState} lockState 
	* @param {'gate'|'access'|'reserved'|'hint'} name
	* @param {LockOptions} options 
	* @returns {Promise<boolean>}
	*/
	#acquire(lockState, name, options = {}) {
		console.assert(!lockState[name]);
		return new Promise((resolve) => {
			if (!options.ifAvailable && this.#options.lockTimeout < Infinity) {
				const controller = new AbortController();
				options = Object.assign({}, options, { signal: controller.signal });
				setTimeout(() => {
					controller.abort();
					resolve?.(false);
				}, this.#options.lockTimeout);
			}
			const lockName = `lock##${lockState.baseName}##${name}`;
			navigator.locks.request(lockName, options, (lock) => {
				if (lock) return new Promise((release) => {
					lockState[name] = () => {
						release();
						lockState[name] = null;
					};
					resolve(true);
					resolve = null;
				});
				else {
					lockState[name] = null;
					resolve(false);
					resolve = null;
				}
			}).catch((e) => {
				if (e.name !== "AbortError") throw e;
			});
		});
	}
};
WebLocksMixin.WRITE_HINT_OP_CODE = -9999;
//#endregion
//#region node_modules/@journeyapps/wa-sqlite/src/examples/IDBBatchAtomicVFS.js
const RETRYABLE_ERRORS = new Set(["TransactionInactiveError", "InvalidStateError"]);
/**
* @typedef Metadata
* @property {string} name
* @property {number} fileSize
* @property {number} version
* @property {number} [pendingVersion]
*/
var File = class {
	/** @type {string} */ path;
	/** @type {number} */ flags;
	/** @type {Metadata} */ metadata;
	/** @type {number} */ fileSize = 0;
	/** @type {boolean} */ needsMetadataSync = false;
	/** @type {Metadata} */ rollback = null;
	/** @type {Set<number>} */ changedPages = /* @__PURE__ */ new Set();
	/** @type {string} */ synchronous = "full";
	/** @type {IDBTransactionOptions} */ txOptions = { durability: "strict" };
	constructor(path, flags, metadata) {
		this.path = path;
		this.flags = flags;
		this.metadata = metadata;
	}
};
var IDBBatchAtomicVFS = class IDBBatchAtomicVFS extends WebLocksMixin(FacadeVFS) {
	/** @type {Map<number, File>} */ mapIdToFile = /* @__PURE__ */ new Map();
	lastError = null;
	log = null;
	/** @type {Promise} */ #isReady;
	/** @type {IDBContext} */ #idb;
	static async create(name, module, options) {
		const vfs = new IDBBatchAtomicVFS(name, module, options);
		await vfs.isReady();
		return vfs;
	}
	constructor(name, module, options = {}) {
		super(name, module, options);
		this.#isReady = this.#initialize(options.idbName ?? name);
	}
	async #initialize(name) {
		this.#idb = await IDBContext.create(name);
	}
	close() {
		this.#idb.close();
	}
	async isReady() {
		await super.isReady();
		await this.#isReady;
	}
	getFilename(fileId) {
		const pathname = this.mapIdToFile.get(fileId).path;
		return `IDB(${this.name}):${pathname}`;
	}
	/**
	* @param {string?} zName 
	* @param {number} fileId 
	* @param {number} flags 
	* @param {DataView} pOutFlags 
	* @returns {Promise<number>}
	*/
	async jOpen(zName, fileId, flags, pOutFlags) {
		try {
			const path = new URL(zName || Math.random().toString(36).slice(2), "file://").pathname;
			let meta = await this.#idb.q(({ metadata }) => metadata.get(path));
			if (!meta && flags & 4) {
				meta = {
					name: path,
					fileSize: 0,
					version: 0
				};
				await this.#idb.q(({ metadata }) => metadata.put(meta), "rw");
			}
			if (!meta) throw new Error(`File ${path} not found`);
			const file = new File(path, flags, meta);
			this.mapIdToFile.set(fileId, file);
			pOutFlags.setInt32(0, flags, true);
			return 0;
		} catch (e) {
			this.lastError = e;
			return 14;
		}
	}
	/**
	* @param {string} zName 
	* @param {number} syncDir 
	* @returns {Promise<number>}
	*/
	async jDelete(zName, syncDir) {
		try {
			const path = new URL(zName, "file://").pathname;
			this.#idb.q(({ metadata, blocks }) => {
				const range = IDBKeyRange.bound([path, -Infinity], [path, Infinity]);
				blocks.delete(range);
				metadata.delete(path);
			}, "rw");
			if (syncDir) await this.#idb.sync(false);
			return 0;
		} catch (e) {
			this.lastError = e;
			return SQLITE_IOERR_DELETE;
		}
	}
	/**
	* @param {string} zName 
	* @param {number} flags 
	* @param {DataView} pResOut 
	* @returns {Promise<number>}
	*/
	async jAccess(zName, flags, pResOut) {
		try {
			const path = new URL(zName, "file://").pathname;
			const meta = await this.#idb.q(({ metadata }) => metadata.get(path));
			pResOut.setInt32(0, meta ? 1 : 0, true);
			return 0;
		} catch (e) {
			this.lastError = e;
			return SQLITE_IOERR_ACCESS;
		}
	}
	/**
	* @param {number} fileId 
	* @returns {Promise<number>}
	*/
	async jClose(fileId) {
		try {
			const file = this.mapIdToFile.get(fileId);
			this.mapIdToFile.delete(fileId);
			if (file.flags & 8) await this.#idb.q(({ metadata, blocks }) => {
				metadata.delete(file.path);
				blocks.delete(IDBKeyRange.bound([file.path, 0], [file.path, Infinity]));
			}, "rw");
			if (file.needsMetadataSync) this.#idb.q(({ metadata }) => metadata.put(file.metadata), "rw");
			await this.#idb.sync(file.synchronous === "full");
			return 0;
		} catch (e) {
			this.lastError = e;
			return SQLITE_IOERR_CLOSE;
		}
	}
	/**
	* @param {number} fileId 
	* @param {Uint8Array} pData 
	* @param {number} iOffset
	* @returns {Promise<number>}
	*/
	async jRead(fileId, pData, iOffset) {
		try {
			const file = this.mapIdToFile.get(fileId);
			let pDataOffset = 0;
			while (pDataOffset < pData.byteLength) {
				const fileOffset = iOffset + pDataOffset;
				const block = await this.#idb.q(({ blocks }) => {
					const range = IDBKeyRange.bound([file.path, -fileOffset], [file.path, Infinity]);
					return blocks.get(range);
				});
				if (!block || block.data.byteLength - block.offset <= fileOffset) {
					pData.fill(0, pDataOffset);
					return 522;
				}
				const dst = pData.subarray(pDataOffset);
				const srcOffset = fileOffset + block.offset;
				const nBytesToCopy = Math.min(Math.max(block.data.byteLength - srcOffset, 0), dst.byteLength);
				dst.set(block.data.subarray(srcOffset, srcOffset + nBytesToCopy));
				pDataOffset += nBytesToCopy;
			}
			return 0;
		} catch (e) {
			this.lastError = e;
			return 266;
		}
	}
	/**
	* @param {number} fileId 
	* @param {Uint8Array} pData 
	* @param {number} iOffset
	* @returns {number}
	*/
	jWrite(fileId, pData, iOffset) {
		try {
			const file = this.mapIdToFile.get(fileId);
			if (file.flags & 256) {
				if (!file.rollback) {
					const pending = Object.assign({ pendingVersion: file.metadata.version - 1 }, file.metadata);
					this.#idb.q(({ metadata }) => metadata.put(pending), "rw", file.txOptions);
					file.rollback = Object.assign({}, file.metadata);
					file.metadata.version--;
				}
			}
			if (file.flags & 256) file.changedPages.add(iOffset);
			const data = pData.slice();
			const version = file.metadata.version;
			if (!(iOffset < file.metadata.fileSize) || file.flags & 256 || file.flags & 512) {
				const block = {
					path: file.path,
					offset: -iOffset,
					version,
					data: pData.slice()
				};
				this.#idb.q(({ blocks }) => {
					blocks.put(block);
					file.changedPages.add(iOffset);
				}, "rw", file.txOptions);
			} else this.#idb.q(async ({ blocks }) => {
				const range = IDBKeyRange.bound([file.path, -iOffset], [file.path, Infinity]);
				const block = await blocks.get(range);
				block.data.subarray(iOffset + block.offset).set(data);
				blocks.put(block);
			}, "rw", file.txOptions);
			if (file.metadata.fileSize < iOffset + pData.length) {
				file.metadata.fileSize = iOffset + pData.length;
				file.needsMetadataSync = true;
			}
			return 0;
		} catch (e) {
			this.lastError = e;
			return 778;
		}
	}
	/**
	* @param {number} fileId 
	* @param {number} iSize 
	* @returns {number}
	*/
	jTruncate(fileId, iSize) {
		try {
			const file = this.mapIdToFile.get(fileId);
			if (iSize < file.metadata.fileSize) {
				this.#idb.q(({ blocks }) => {
					const range = IDBKeyRange.bound([file.path, -Infinity], [
						file.path,
						-iSize,
						Infinity
					]);
					blocks.delete(range);
				}, "rw", file.txOptions);
				file.metadata.fileSize = iSize;
				file.needsMetadataSync = true;
			}
			return 0;
		} catch (e) {
			this.lastError = e;
			return SQLITE_IOERR_TRUNCATE;
		}
	}
	/**
	* @param {number} fileId 
	* @param {number} flags 
	* @returns {Promise<number>}
	*/
	async jSync(fileId, flags) {
		try {
			const file = this.mapIdToFile.get(fileId);
			if (file.needsMetadataSync) {
				this.#idb.q(({ metadata }) => metadata.put(file.metadata), "rw", file.txOptions);
				file.needsMetadataSync = false;
			}
			if (file.flags & 256) {
				if (file.synchronous === "full") await this.#idb.sync(true);
			} else await this.#idb.sync(file.synchronous === "full");
			return 0;
		} catch (e) {
			this.lastError = e;
			return SQLITE_IOERR_FSYNC;
		}
	}
	/**
	* @param {number} fileId 
	* @param {DataView} pSize64 
	* @returns {number}
	*/
	jFileSize(fileId, pSize64) {
		try {
			const file = this.mapIdToFile.get(fileId);
			pSize64.setBigInt64(0, BigInt(file.metadata.fileSize), true);
			return 0;
		} catch (e) {
			this.lastError = e;
			return SQLITE_IOERR_FSTAT;
		}
	}
	/**
	* @param {number} fileId 
	* @param {number} lockType 
	* @returns {Promise<number>}
	*/
	async jLock(fileId, lockType) {
		const file = this.mapIdToFile.get(fileId);
		const result = await super.jLock(fileId, lockType);
		if (lockType === 1) file.metadata = await this.#idb.q(async ({ metadata, blocks }) => {
			/** @type {Metadata} */ const m = await metadata.get(file.path);
			if (m.pendingVersion) {
				console.warn(`removing failed transaction ${m.pendingVersion}`);
				await new Promise((resolve, reject) => {
					const range = IDBKeyRange.bound([m.name, -Infinity], [m.name, Infinity]);
					const request = blocks.openCursor(range);
					request.onsuccess = () => {
						const cursor = request.result;
						if (cursor) {
							if (cursor.value.version < m.version) cursor.delete();
							cursor.continue();
						} else resolve();
					};
					request.onerror = () => reject(request.error);
				});
				delete m.pendingVersion;
				metadata.put(m);
			}
			return m;
		}, "rw", file.txOptions);
		return result;
	}
	/**
	* @param {number} fileId 
	* @param {number} lockType 
	* @returns {Promise<number>}
	*/
	async jUnlock(fileId, lockType) {
		if (lockType === 0) {
			const file = this.mapIdToFile.get(fileId);
			await this.#idb.sync(file.synchronous === "full");
		}
		return super.jUnlock(fileId, lockType);
	}
	/**
	* @param {number} fileId
	* @param {number} op
	* @param {DataView} pArg
	* @returns {number|Promise<number>}
	*/
	jFileControl(fileId, op, pArg) {
		try {
			const file = this.mapIdToFile.get(fileId);
			switch (op) {
				case 14:
					const key = extractString(pArg, 4);
					const value = extractString(pArg, 8);
					this.log?.("xFileControl", file.path, "PRAGMA", key, value);
					switch (key.toLowerCase()) {
						case "page_size":
							if (file.flags & 256) {
								if (value && file.metadata.fileSize) return 1;
							}
							break;
						case "synchronous":
							if (value) switch (value.toLowerCase()) {
								case "0":
								case "off":
									file.synchronous = "off";
									file.txOptions = { durability: "relaxed" };
									break;
								case "1":
								case "normal":
									file.synchronous = "normal";
									file.txOptions = { durability: "relaxed" };
									break;
								case "2":
								case "3":
								case "full":
								case "extra":
									file.synchronous = "full";
									file.txOptions = { durability: "strict" };
									break;
							}
							break;
						case "write_hint": return super.jFileControl(fileId, WebLocksMixin.WRITE_HINT_OP_CODE, null);
					}
					break;
				case 21:
					this.log?.("xFileControl", file.path, "SYNC");
					if (file.rollback) {
						const commitMetadata = Object.assign({}, file.metadata);
						const prevFileSize = file.rollback.fileSize;
						this.#idb.q(({ metadata, blocks }) => {
							metadata.put(commitMetadata);
							for (const offset of file.changedPages) if (offset < prevFileSize) {
								const range = IDBKeyRange.bound([
									file.path,
									-offset,
									commitMetadata.version
								], [
									file.path,
									-offset,
									Infinity
								], true);
								blocks.delete(range);
							}
							file.changedPages.clear();
						}, "rw", file.txOptions);
						file.needsMetadataSync = false;
						file.rollback = null;
					}
					break;
				case 31:
					this.log?.("xFileControl", file.path, "BEGIN_ATOMIC_WRITE");
					return 0;
				case 32:
					this.log?.("xFileControl", file.path, "COMMIT_ATOMIC_WRITE");
					return 0;
				case 33:
					this.log?.("xFileControl", file.path, "ROLLBACK_ATOMIC_WRITE");
					file.metadata = file.rollback;
					const rollbackMetadata = Object.assign({}, file.metadata);
					this.#idb.q(({ metadata, blocks }) => {
						metadata.put(rollbackMetadata);
						for (const offset of file.changedPages) blocks.delete([
							file.path,
							-offset,
							rollbackMetadata.version - 1
						]);
						file.changedPages.clear();
					}, "rw", file.txOptions);
					file.needsMetadataSync = false;
					file.rollback = null;
					return 0;
			}
		} catch (e) {
			this.lastError = e;
			return 10;
		}
		return super.jFileControl(fileId, op, pArg);
	}
	/**
	* @param {number} pFile
	* @returns {number|Promise<number>}
	*/
	jDeviceCharacteristics(pFile) {
		return 0 | SQLITE_IOCAP_BATCH_ATOMIC | SQLITE_IOCAP_UNDELETABLE_WHEN_OPEN;
	}
	/**
	* @param {Uint8Array} zBuf 
	* @returns {number|Promise<number>}
	*/
	jGetLastError(zBuf) {
		if (this.lastError) {
			console.error(this.lastError);
			const outputArray = zBuf.subarray(0, zBuf.byteLength - 1);
			const { written } = new TextEncoder().encodeInto(this.lastError.message, outputArray);
			zBuf[written] = 0;
		}
		return 0;
	}
};
function extractString(dataView, offset) {
	const p = dataView.getUint32(offset, true);
	if (p) {
		const chars = new Uint8Array(dataView.buffer, p);
		return new TextDecoder().decode(chars.subarray(0, chars.indexOf(0)));
	}
	return null;
}
var IDBContext = class IDBContext {
	/** @type {IDBDatabase} */ #database;
	/** @type {Promise} */ #chain = null;
	/** @type {Promise<any>} */ #txComplete = Promise.resolve();
	/** @type {IDBRequest?} */ #request = null;
	/** @type {WeakSet<IDBTransaction>} */ #txPending = /* @__PURE__ */ new WeakSet();
	log = null;
	static async create(name) {
		return new IDBContext(await new Promise((resolve, reject) => {
			const request = indexedDB.open(name, 6);
			request.onupgradeneeded = async (event) => {
				const db = request.result;
				if (event.oldVersion) console.log(`Upgrading IndexedDB from version ${event.oldVersion}`);
				switch (event.oldVersion) {
					case 0: db.createObjectStore("blocks", { keyPath: [
						"path",
						"offset",
						"version"
					] }).createIndex("version", ["path", "version"]);
					case 5:
						const tx = request.transaction;
						tx.objectStore("blocks").deleteIndex("version");
						const metadata = db.createObjectStore("metadata", { keyPath: "name" });
						await new Promise((resolve, reject) => {
							let lastBlock = {};
							const request = tx.objectStore("blocks").openCursor();
							request.onsuccess = () => {
								const cursor = request.result;
								if (cursor) {
									const block = cursor.value;
									if (typeof block.offset !== "number" || block.path === lastBlock.path && block.offset === lastBlock.offset) cursor.delete();
									else if (block.offset === 0) {
										metadata.put({
											name: block.path,
											fileSize: block.fileSize,
											version: block.version
										});
										delete block.fileSize;
										cursor.update(block);
									}
									lastBlock = block;
									cursor.continue();
								} else resolve();
							};
							request.onerror = () => reject(request.error);
						});
						break;
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		}));
	}
	constructor(database) {
		this.#database = database;
	}
	close() {
		this.#database.close();
	}
	/**
	* @param {(stores: Object.<string, IDBObjectStore>) => any} f 
	* @param {'ro'|'rw'} mode 
	* @returns {Promise<any>}
	*/
	q(f, mode = "ro", options = {}) {
		/** @type {IDBTransactionMode} */
		const txMode = mode === "ro" ? "readonly" : "readwrite";
		const txOptions = Object.assign({ 
		/** @type {IDBTransactionDurability} */ durability: "default" }, options);
		this.#chain = (this.#chain || Promise.resolve()).then(() => this.#q(f, txMode, txOptions));
		return this.#chain;
	}
	/**
	* @param {(stores: Object.<string, IDBObjectStore>) => any} f 
	* @param {IDBTransactionMode} mode 
	* @param {IDBTransactionOptions} options
	* @returns {Promise<any>}
	*/
	async #q(f, mode, options) {
		/** @type {IDBTransaction} */ let tx;
		if (this.#request && this.#txPending.has(this.#request.transaction) && this.#request.transaction.mode >= mode && this.#request.transaction.durability === options.durability) {
			tx = this.#request.transaction;
			if (this.#request.readyState === "pending") await new Promise((resolve) => {
				this.#request.addEventListener("success", resolve, { once: true });
				this.#request.addEventListener("error", resolve, { once: true });
			});
		}
		for (let i = 0; i < 2; ++i) {
			if (!tx) {
				await this.#txComplete;
				tx = this.#database.transaction(this.#database.objectStoreNames, mode, options);
				this.log?.("IDBTransaction open", mode);
				this.#txPending.add(tx);
				this.#txComplete = new Promise((resolve, reject) => {
					tx.addEventListener("complete", () => {
						this.log?.("IDBTransaction complete");
						this.#txPending.delete(tx);
						resolve();
					});
					tx.addEventListener("abort", () => {
						this.#txPending.delete(tx);
						reject(/* @__PURE__ */ new Error("transaction aborted"));
					});
				});
			}
			try {
				const objectStores = [...tx.objectStoreNames].map((name) => {
					return [name, this.proxyStoreOrIndex(tx.objectStore(name))];
				});
				return await f(Object.fromEntries(objectStores));
			} catch (e) {
				if (!i && RETRYABLE_ERRORS.has(e.name)) {
					this.log?.(`${e.name}, retrying`);
					tx = null;
					continue;
				}
				throw e;
			}
		}
	}
	/**
	* Object store methods that return an IDBRequest, except for cursor
	* creation, are wrapped to return a Promise. In addition, the
	* request is used internally for chaining.
	* @param {IDBObjectStore} objectStore 
	* @returns 
	*/
	proxyStoreOrIndex(objectStore) {
		return new Proxy(objectStore, { get: (target, property, receiver) => {
			const result = Reflect.get(target, property, receiver);
			if (typeof result === "function") return (...args) => {
				const maybeRequest = Reflect.apply(result, target, args);
				if (maybeRequest instanceof IDBRequest && !property.endsWith("Cursor")) {
					this.#request = maybeRequest;
					maybeRequest.addEventListener("error", () => {
						console.error(maybeRequest.error);
						maybeRequest.transaction.abort();
					}, { once: true });
					return wrap(maybeRequest);
				}
				return maybeRequest;
			};
			return result;
		} });
	}
	/**
	* @param {boolean} durable 
	*/
	async sync(durable) {
		if (this.#chain) {
			await this.#chain;
			if (durable) await this.#txComplete;
			this.reset();
		}
	}
	reset() {
		this.#chain = null;
		this.#txComplete = Promise.resolve();
		this.#request = null;
	}
};
/**
* @param {IDBRequest} request 
* @returns {Promise}
*/
function wrap(request) {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}
//#endregion
export { IDBBatchAtomicVFS };

//# sourceMappingURL=IDBBatchAtomicVFS-CduzLFbg.js.map