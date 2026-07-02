import { _ as SQLITE_OPEN_WAL, f as SQLITE_OPEN_MAIN_JOURNAL, m as SQLITE_OPEN_SUPER_JOURNAL, n as SQLITE_IOCAP_UNDELETABLE_WHEN_OPEN } from "./WASQLiteDB.worker-B1Tu9nsE.js";
import { t as FacadeVFS } from "./FacadeVFS-CqKmBBeJ.js";
//#region node_modules/@journeyapps/wa-sqlite/src/examples/AccessHandlePoolVFS.js
const SECTOR_SIZE = 4096;
const HEADER_MAX_PATH_SIZE = 512;
const HEADER_FLAGS_SIZE = 4;
const HEADER_DIGEST_SIZE = 8;
const HEADER_CORPUS_SIZE = HEADER_MAX_PATH_SIZE + HEADER_FLAGS_SIZE;
const HEADER_OFFSET_FLAGS = HEADER_MAX_PATH_SIZE;
const HEADER_OFFSET_DIGEST = HEADER_CORPUS_SIZE;
const HEADER_OFFSET_DATA = SECTOR_SIZE;
const PERSISTENT_FILE_TYPES = 256 | SQLITE_OPEN_MAIN_JOURNAL | SQLITE_OPEN_SUPER_JOURNAL | SQLITE_OPEN_WAL;
const DEFAULT_CAPACITY = 6;
/**
* This VFS uses the updated Access Handle API with all synchronous methods
* on FileSystemSyncAccessHandle (instead of just read and write). It will
* work with the regular SQLite WebAssembly build, i.e. the one without
* Asyncify.
*/
var AccessHandlePoolVFS = class AccessHandlePoolVFS extends FacadeVFS {
	log = null;
	#directoryPath;
	#directoryHandle;
	#mapAccessHandleToName = /* @__PURE__ */ new Map();
	#mapPathToAccessHandle = /* @__PURE__ */ new Map();
	#availableAccessHandles = /* @__PURE__ */ new Set();
	#mapIdToFile = /* @__PURE__ */ new Map();
	static async create(name, module) {
		const vfs = new AccessHandlePoolVFS(name, module);
		await vfs.isReady();
		return vfs;
	}
	constructor(name, module) {
		super(name, module);
		this.#directoryPath = name;
	}
	/**
	* @param {string?} zName 
	* @param {number} fileId 
	* @param {number} flags 
	* @param {DataView} pOutFlags 
	* @returns {number}
	*/
	jOpen(zName, fileId, flags, pOutFlags) {
		try {
			const path = zName ? this.#getPath(zName) : Math.random().toString(36);
			let accessHandle = this.#mapPathToAccessHandle.get(path);
			if (!accessHandle && flags & 4) if (this.getSize() < this.getCapacity()) {
				[accessHandle] = this.#availableAccessHandles.keys();
				this.#setAssociatedPath(accessHandle, path, flags);
			} else throw new Error("cannot create file");
			if (!accessHandle) throw new Error("file not found");
			const file = {
				path,
				flags,
				accessHandle
			};
			this.#mapIdToFile.set(fileId, file);
			pOutFlags.setInt32(0, flags, true);
			return 0;
		} catch (e) {
			console.error(e.message);
			return 14;
		}
	}
	/**
	* @param {number} fileId 
	* @returns {number}
	*/
	jClose(fileId) {
		const file = this.#mapIdToFile.get(fileId);
		if (file) {
			file.accessHandle.flush();
			this.#mapIdToFile.delete(fileId);
			if (file.flags & 8) this.#deletePath(file.path);
		}
		return 0;
	}
	/**
	* @param {number} fileId 
	* @param {Uint8Array} pData 
	* @param {number} iOffset
	* @returns {number}
	*/
	jRead(fileId, pData, iOffset) {
		const nBytes = this.#mapIdToFile.get(fileId).accessHandle.read(pData.subarray(), { at: HEADER_OFFSET_DATA + iOffset });
		if (nBytes < pData.byteLength) {
			pData.fill(0, nBytes, pData.byteLength);
			return 522;
		}
		return 0;
	}
	/**
	* @param {number} fileId 
	* @param {Uint8Array} pData 
	* @param {number} iOffset
	* @returns {number}
	*/
	jWrite(fileId, pData, iOffset) {
		return this.#mapIdToFile.get(fileId).accessHandle.write(pData.subarray(), { at: HEADER_OFFSET_DATA + iOffset }) === pData.byteLength ? 0 : 10;
	}
	/**
	* @param {number} fileId 
	* @param {number} iSize 
	* @returns {number}
	*/
	jTruncate(fileId, iSize) {
		this.#mapIdToFile.get(fileId).accessHandle.truncate(HEADER_OFFSET_DATA + iSize);
		return 0;
	}
	/**
	* @param {number} fileId 
	* @param {number} flags 
	* @returns {number}
	*/
	jSync(fileId, flags) {
		this.#mapIdToFile.get(fileId).accessHandle.flush();
		return 0;
	}
	/**
	* @param {number} fileId 
	* @param {DataView} pSize64 
	* @returns {number}
	*/
	jFileSize(fileId, pSize64) {
		const size = this.#mapIdToFile.get(fileId).accessHandle.getSize() - HEADER_OFFSET_DATA;
		pSize64.setBigInt64(0, BigInt(size), true);
		return 0;
	}
	jSectorSize(fileId) {
		return SECTOR_SIZE;
	}
	jDeviceCharacteristics(fileId) {
		return SQLITE_IOCAP_UNDELETABLE_WHEN_OPEN;
	}
	/**
	* @param {string} zName 
	* @param {number} flags 
	* @param {DataView} pResOut 
	* @returns {number}
	*/
	jAccess(zName, flags, pResOut) {
		const path = this.#getPath(zName);
		pResOut.setInt32(0, this.#mapPathToAccessHandle.has(path) ? 1 : 0, true);
		return 0;
	}
	/**
	* @param {string} zName 
	* @param {number} syncDir 
	* @returns {number}
	*/
	jDelete(zName, syncDir) {
		const path = this.#getPath(zName);
		this.#deletePath(path);
		return 0;
	}
	async close() {
		await this.#releaseAccessHandles();
	}
	async isReady() {
		if (!this.#directoryHandle) {
			let handle = await navigator.storage.getDirectory();
			for (const d of this.#directoryPath.split("/")) if (d) handle = await handle.getDirectoryHandle(d, { create: true });
			this.#directoryHandle = handle;
			await this.#acquireAccessHandles();
			if (this.getCapacity() === 0) await this.addCapacity(DEFAULT_CAPACITY);
		}
		return true;
	}
	/**
	* Returns the number of SQLite files in the file system.
	* @returns {number}
	*/
	getSize() {
		return this.#mapPathToAccessHandle.size;
	}
	/**
	* Returns the maximum number of SQLite files the file system can hold.
	* @returns {number}
	*/
	getCapacity() {
		return this.#mapAccessHandleToName.size;
	}
	/**
	* Increase the capacity of the file system by n.
	* @param {number} n 
	* @returns {Promise<number>} 
	*/
	async addCapacity(n) {
		for (let i = 0; i < n; ++i) {
			const name = Math.random().toString(36).replace("0.", "");
			const accessHandle = await (await this.#directoryHandle.getFileHandle(name, { create: true })).createSyncAccessHandle();
			this.#mapAccessHandleToName.set(accessHandle, name);
			this.#setAssociatedPath(accessHandle, "", 0);
		}
		return n;
	}
	/**
	* Decrease the capacity of the file system by n. The capacity cannot be
	* decreased to fewer than the current number of SQLite files in the
	* file system.
	* @param {number} n 
	* @returns {Promise<number>}
	*/
	async removeCapacity(n) {
		let nRemoved = 0;
		for (const accessHandle of Array.from(this.#availableAccessHandles)) {
			if (nRemoved == n || this.getSize() === this.getCapacity()) return nRemoved;
			const name = this.#mapAccessHandleToName.get(accessHandle);
			await accessHandle.close();
			await this.#directoryHandle.removeEntry(name);
			this.#mapAccessHandleToName.delete(accessHandle);
			this.#availableAccessHandles.delete(accessHandle);
			++nRemoved;
		}
		return nRemoved;
	}
	async #acquireAccessHandles() {
		const files = [];
		for await (const [name, handle] of this.#directoryHandle) if (handle.kind === "file") files.push([name, handle]);
		await Promise.all(files.map(async ([name, handle]) => {
			const accessHandle = await handle.createSyncAccessHandle();
			this.#mapAccessHandleToName.set(accessHandle, name);
			const path = this.#getAssociatedPath(accessHandle);
			if (path) this.#mapPathToAccessHandle.set(path, accessHandle);
			else this.#availableAccessHandles.add(accessHandle);
		}));
	}
	#releaseAccessHandles() {
		for (const accessHandle of this.#mapAccessHandleToName.keys()) accessHandle.close();
		this.#mapAccessHandleToName.clear();
		this.#mapPathToAccessHandle.clear();
		this.#availableAccessHandles.clear();
	}
	/**
	* Read and return the associated path from an OPFS file header.
	* Empty string is returned for an unassociated OPFS file.
	* @param accessHandle FileSystemSyncAccessHandle
	* @returns {string} path or empty string
	*/
	#getAssociatedPath(accessHandle) {
		const corpus = new Uint8Array(HEADER_CORPUS_SIZE);
		accessHandle.read(corpus, { at: 0 });
		const flags = new DataView(corpus.buffer, corpus.byteOffset).getUint32(HEADER_OFFSET_FLAGS);
		if (corpus[0] && (flags & 8 || (flags & PERSISTENT_FILE_TYPES) === 0)) {
			console.warn(`Remove file with unexpected flags ${flags.toString(16)}`);
			this.#setAssociatedPath(accessHandle, "", 0);
			return "";
		}
		const fileDigest = new Uint32Array(HEADER_DIGEST_SIZE / 4);
		accessHandle.read(fileDigest, { at: HEADER_OFFSET_DIGEST });
		const computedDigest = this.#computeDigest(corpus);
		if (fileDigest.every((value, i) => value === computedDigest[i])) {
			const pathBytes = corpus.findIndex((value) => value === 0);
			if (pathBytes === 0) accessHandle.truncate(HEADER_OFFSET_DATA);
			return new TextDecoder().decode(corpus.subarray(0, pathBytes));
		} else {
			console.warn("Disassociating file with bad digest.");
			this.#setAssociatedPath(accessHandle, "", 0);
			return "";
		}
	}
	/**
	* Set the path on an OPFS file header.
	* @param accessHandle FileSystemSyncAccessHandle
	* @param {string} path
	* @param {number} flags
	*/
	#setAssociatedPath(accessHandle, path, flags) {
		const corpus = new Uint8Array(HEADER_CORPUS_SIZE);
		if (new TextEncoder().encodeInto(path, corpus).written >= HEADER_MAX_PATH_SIZE) throw new Error("path too long");
		new DataView(corpus.buffer, corpus.byteOffset).setUint32(HEADER_OFFSET_FLAGS, flags);
		const digest = this.#computeDigest(corpus);
		accessHandle.write(corpus, { at: 0 });
		accessHandle.write(digest, { at: HEADER_OFFSET_DIGEST });
		accessHandle.flush();
		if (path) {
			this.#mapPathToAccessHandle.set(path, accessHandle);
			this.#availableAccessHandles.delete(accessHandle);
		} else {
			accessHandle.truncate(HEADER_OFFSET_DATA);
			this.#availableAccessHandles.add(accessHandle);
		}
	}
	/**
	* We need a synchronous digest function so can't use WebCrypto.
	* Adapted from https://github.com/bryc/code/blob/master/jshash/experimental/cyrb53.js
	* @param {Uint8Array} corpus 
	* @returns {ArrayBuffer} 64-bit digest
	*/
	#computeDigest(corpus) {
		if (!corpus[0]) return new Uint32Array([4274806656, 2899230775]);
		let h1 = 3735928559;
		let h2 = 1103547991;
		for (const value of corpus) {
			h1 = Math.imul(h1 ^ value, 2654435761);
			h2 = Math.imul(h2 ^ value, 1597334677);
		}
		h1 = Math.imul(h1 ^ h1 >>> 16, 2246822507) ^ Math.imul(h2 ^ h2 >>> 13, 3266489909);
		h2 = Math.imul(h2 ^ h2 >>> 16, 2246822507) ^ Math.imul(h1 ^ h1 >>> 13, 3266489909);
		return new Uint32Array([h1 >>> 0, h2 >>> 0]);
	}
	/**
	* Convert a bare filename, path, or URL to a UNIX-style path.
	* @param {string|URL} nameOrURL
	* @returns {string} path
	*/
	#getPath(nameOrURL) {
		return (typeof nameOrURL === "string" ? new URL(nameOrURL, "file://localhost/") : nameOrURL).pathname;
	}
	/**
	* Remove the association between a path and an OPFS file.
	* @param {string} path 
	*/
	#deletePath(path) {
		const accessHandle = this.#mapPathToAccessHandle.get(path);
		if (accessHandle) {
			this.#mapPathToAccessHandle.delete(path);
			this.#setAssociatedPath(accessHandle, "", 0);
		}
	}
};
//#endregion
export { AccessHandlePoolVFS };

//# sourceMappingURL=AccessHandlePoolVFS-DfprTePR.js.map