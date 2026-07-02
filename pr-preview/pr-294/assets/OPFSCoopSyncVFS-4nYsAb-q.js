import { a as SQLITE_IOERR_CLOSE, c as SQLITE_IOERR_FSYNC, o as SQLITE_IOERR_DELETE, r as SQLITE_IOERR_ACCESS, s as SQLITE_IOERR_FSTAT, u as SQLITE_IOERR_TRUNCATE } from "./WASQLiteDB.worker-Bk8Rxnwd.js";
import { t as FacadeVFS } from "./FacadeVFS-DwHJKezN.js";
//#region node_modules/@journeyapps/wa-sqlite/src/examples/OPFSCoopSyncVFS.js
const DEFAULT_TEMPORARY_FILES = 10;
const LOCK_NOTIFY_INTERVAL = 1e3;
const DB_RELATED_FILE_SUFFIXES = [
	"",
	"-journal",
	"-wal"
];
const finalizationRegistry = new FinalizationRegistry((releaser) => releaser());
var File = class {
	/** @type {string} */ path;
	/** @type {number} */ flags;
	/** @type {FileSystemSyncAccessHandle} */ accessHandle;
	/** @type {PersistentFile?} */ persistentFile;
	constructor(path, flags) {
		this.path = path;
		this.flags = flags;
	}
};
var PersistentFile = class {
	/** @type {FileSystemFileHandle} */ fileHandle;
	/** @type {FileSystemSyncAccessHandle} */ accessHandle = null;
	/** @type {boolean} */ isLockBusy = false;
	/** @type {boolean} */ isFileLocked = false;
	/** @type {boolean} */ isRequestInProgress = false;
	/** @type {function} */ handleLockReleaser = null;
	/** @type {BroadcastChannel} */ handleRequestChannel;
	/** @type {boolean} */ isHandleRequested = false;
	constructor(fileHandle) {
		this.fileHandle = fileHandle;
	}
};
var OPFSCoopSyncVFS = class OPFSCoopSyncVFS extends FacadeVFS {
	/** @type {Map<number, File>} */ mapIdToFile = /* @__PURE__ */ new Map();
	lastError = null;
	log = null;
	/** @type {Map<string, PersistentFile>} */ persistentFiles = /* @__PURE__ */ new Map();
	/** @type {Map<string, FileSystemSyncAccessHandle>} */ boundAccessHandles = /* @__PURE__ */ new Map();
	/** @type {Set<FileSystemSyncAccessHandle>} */ unboundAccessHandles = /* @__PURE__ */ new Set();
	/** @type {Set<string>} */ accessiblePaths = /* @__PURE__ */ new Set();
	releaser = null;
	static async create(name, module) {
		const vfs = new OPFSCoopSyncVFS(name, module);
		await Promise.all([vfs.isReady(), vfs.#initialize(DEFAULT_TEMPORARY_FILES)]);
		return vfs;
	}
	constructor(name, module) {
		super(name, module);
	}
	async #initialize(nTemporaryFiles) {
		const root = await navigator.storage.getDirectory();
		for await (const entry of root.values()) if (entry.kind === "directory" && entry.name.startsWith(".ahp-")) await navigator.locks.request(entry.name, { ifAvailable: true }, async (lock) => {
			if (lock) {
				this.log?.(`Deleting temporary directory ${entry.name}`);
				await root.removeEntry(entry.name, { recursive: true });
			} else this.log?.(`Temporary directory ${entry.name} is in use`);
		});
		const tmpDirName = `.ahp-${Math.random().toString(36).slice(2)}`;
		this.releaser = await new Promise((resolve) => {
			navigator.locks.request(tmpDirName, () => {
				return new Promise((release) => {
					resolve(release);
				});
			});
		});
		finalizationRegistry.register(this, this.releaser);
		const tmpDir = await root.getDirectoryHandle(tmpDirName, { create: true });
		for (let i = 0; i < nTemporaryFiles; i++) {
			const tmpAccessHandle = await (await tmpDir.getFileHandle(`${i}.tmp`, { create: true })).createSyncAccessHandle();
			this.unboundAccessHandles.add(tmpAccessHandle);
		}
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
			const path = new URL(zName || Math.random().toString(36).slice(2), "file://").pathname;
			if (flags & 256) {
				const persistentFile = this.persistentFiles.get(path);
				if (persistentFile?.isRequestInProgress) return 5;
				else if (!persistentFile) {
					this.log?.(`creating persistent file for ${path}`);
					const create = !!(flags & 4);
					this._module.retryOps.push((async () => {
						try {
							let dirHandle = await navigator.storage.getDirectory();
							const directories = path.split("/").filter((d) => d);
							const filename = directories.pop();
							for (const directory of directories) dirHandle = await dirHandle.getDirectoryHandle(directory, { create });
							for (const suffix of DB_RELATED_FILE_SUFFIXES) {
								const fileHandle = await dirHandle.getFileHandle(filename + suffix, { create });
								await this.#createPersistentFile(fileHandle);
							}
							const file = new File(path, flags);
							file.persistentFile = this.persistentFiles.get(path);
							await this.#requestAccessHandle(file);
						} catch (e) {
							const persistentFile = new PersistentFile(null);
							this.persistentFiles.set(path, persistentFile);
							console.error(e);
						}
					})());
					return 5;
				} else if (!persistentFile.fileHandle) {
					this.persistentFiles.delete(path);
					return 14;
				} else if (!persistentFile.accessHandle) {
					this._module.retryOps.push((async () => {
						const file = new File(path, flags);
						file.persistentFile = this.persistentFiles.get(path);
						await this.#requestAccessHandle(file);
					})());
					return 5;
				}
			}
			if (!this.accessiblePaths.has(path) && !(flags & 4)) throw new Error(`File ${path} not found`);
			const file = new File(path, flags);
			this.mapIdToFile.set(fileId, file);
			if (this.persistentFiles.has(path)) file.persistentFile = this.persistentFiles.get(path);
			else if (this.boundAccessHandles.has(path)) file.accessHandle = this.boundAccessHandles.get(path);
			else if (this.unboundAccessHandles.size) {
				file.accessHandle = this.unboundAccessHandles.values().next().value;
				file.accessHandle.truncate(0);
				this.unboundAccessHandles.delete(file.accessHandle);
				this.boundAccessHandles.set(path, file.accessHandle);
			}
			this.accessiblePaths.add(path);
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
	* @returns {number}
	*/
	jDelete(zName, syncDir) {
		try {
			const path = new URL(zName, "file://").pathname;
			if (this.persistentFiles.has(path)) this.persistentFiles.get(path).accessHandle.truncate(0);
			else this.boundAccessHandles.get(path)?.truncate(0);
			this.accessiblePaths.delete(path);
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
	* @returns {number}
	*/
	jAccess(zName, flags, pResOut) {
		try {
			const path = new URL(zName, "file://").pathname;
			pResOut.setInt32(0, this.accessiblePaths.has(path) ? 1 : 0, true);
			return 0;
		} catch (e) {
			this.lastError = e;
			return SQLITE_IOERR_ACCESS;
		}
	}
	/**
	* @param {number} fileId 
	* @returns {number}
	*/
	jClose(fileId) {
		try {
			const file = this.mapIdToFile.get(fileId);
			this.mapIdToFile.delete(fileId);
			if (file?.flags & 256) {
				if (file.persistentFile?.handleLockReleaser) this.#releaseAccessHandle(file);
			} else if (file?.flags & 8) {
				file.accessHandle.truncate(0);
				this.accessiblePaths.delete(file.path);
				if (!this.persistentFiles.has(file.path)) {
					this.boundAccessHandles.delete(file.path);
					this.unboundAccessHandles.add(file.accessHandle);
				}
			}
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
	* @returns {number}
	*/
	jRead(fileId, pData, iOffset) {
		try {
			const file = this.mapIdToFile.get(fileId);
			const bytesRead = (file.accessHandle || file.persistentFile.accessHandle).read(pData.subarray(), { at: iOffset });
			if (file.flags & 256 && !file.persistentFile.isFileLocked) this.#releaseAccessHandle(file);
			if (bytesRead < pData.byteLength) {
				pData.fill(0, bytesRead);
				return 522;
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
			if ((file.accessHandle || file.persistentFile.accessHandle).write(pData.subarray(), { at: iOffset }) !== pData.byteLength) throw new Error("short write");
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
			(file.accessHandle || file.persistentFile.accessHandle).truncate(iSize);
			return 0;
		} catch (e) {
			this.lastError = e;
			return SQLITE_IOERR_TRUNCATE;
		}
	}
	/**
	* @param {number} fileId 
	* @param {number} flags 
	* @returns {number}
	*/
	jSync(fileId, flags) {
		try {
			const file = this.mapIdToFile.get(fileId);
			(file.accessHandle || file.persistentFile.accessHandle).flush();
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
			const size = (file.accessHandle || file.persistentFile.accessHandle).getSize();
			pSize64.setBigInt64(0, BigInt(size), true);
			return 0;
		} catch (e) {
			this.lastError = e;
			return SQLITE_IOERR_FSTAT;
		}
	}
	/**
	* @param {number} fileId 
	* @param {number} lockType 
	* @returns {number}
	*/
	jLock(fileId, lockType) {
		const file = this.mapIdToFile.get(fileId);
		if (file.persistentFile.isRequestInProgress) {
			file.persistentFile.isLockBusy = true;
			return 5;
		}
		file.persistentFile.isFileLocked = true;
		if (!file.persistentFile.handleLockReleaser) {
			file.persistentFile.handleRequestChannel.onmessage = () => {
				this.log?.(`received notification for ${file.path}`);
				if (file.persistentFile.isFileLocked) file.persistentFile.isHandleRequested = true;
				else this.#releaseAccessHandle(file);
				file.persistentFile.handleRequestChannel.onmessage = null;
			};
			this.#requestAccessHandle(file);
			this.log?.("returning SQLITE_BUSY");
			file.persistentFile.isLockBusy = true;
			return 5;
		}
		file.persistentFile.isLockBusy = false;
		return 0;
	}
	/**
	* @param {number} fileId 
	* @param {number} lockType 
	* @returns {number}
	*/
	jUnlock(fileId, lockType) {
		const file = this.mapIdToFile.get(fileId);
		if (lockType === 0) {
			if (!file.persistentFile.isLockBusy) {
				if (file.persistentFile.isHandleRequested) {
					this.#releaseAccessHandle(file);
					file.persistentFile.isHandleRequested = false;
				}
				file.persistentFile.isFileLocked = false;
			}
		}
		return 0;
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
						case "journal_mode":
							if (value && ![
								"off",
								"memory",
								"delete",
								"wal"
							].includes(value.toLowerCase())) throw new Error("journal_mode must be \"off\", \"memory\", \"delete\", or \"wal\"");
							break;
					}
					break;
			}
		} catch (e) {
			this.lastError = e;
			return 10;
		}
		return 12;
	}
	/**
	* @param {Uint8Array} zBuf 
	* @returns 
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
	/**
	* @param {FileSystemFileHandle} fileHandle 
	* @returns {Promise<PersistentFile>}
	*/
	async #createPersistentFile(fileHandle) {
		const persistentFile = new PersistentFile(fileHandle);
		const path = `/${(await (await navigator.storage.getDirectory()).resolve(fileHandle)).join("/")}`;
		persistentFile.handleRequestChannel = new BroadcastChannel(`ahp:${path}`);
		this.persistentFiles.set(path, persistentFile);
		if ((await fileHandle.getFile()).size) this.accessiblePaths.add(path);
		return persistentFile;
	}
	/**
	* @param {File} file 
	*/
	#requestAccessHandle(file) {
		console.assert(!file.persistentFile.handleLockReleaser);
		if (!file.persistentFile.isRequestInProgress) {
			file.persistentFile.isRequestInProgress = true;
			this._module.retryOps.push((async () => {
				file.persistentFile.handleLockReleaser = await this.#acquireLock(file.persistentFile);
				try {
					this.log?.(`creating access handles for ${file.path}`);
					await Promise.all(DB_RELATED_FILE_SUFFIXES.map(async (suffix) => {
						const persistentFile = this.persistentFiles.get(file.path + suffix);
						if (persistentFile) persistentFile.accessHandle = await persistentFile.fileHandle.createSyncAccessHandle();
					}));
				} catch (e) {
					this.log?.(`failed to create access handles for ${file.path}`, e);
					this.#releaseAccessHandle(file);
					throw e;
				} finally {
					file.persistentFile.isRequestInProgress = false;
				}
			})());
			return this._module.retryOps.at(-1);
		}
		return Promise.resolve();
	}
	/**
	* @param {File} file 
	*/
	#releaseAccessHandle(file) {
		DB_RELATED_FILE_SUFFIXES.forEach((suffix) => {
			const persistentFile = this.persistentFiles.get(file.path + suffix);
			if (persistentFile) {
				persistentFile.accessHandle?.close();
				persistentFile.accessHandle = null;
			}
		});
		this.log?.(`access handles closed for ${file.path}`);
		file.persistentFile.handleLockReleaser?.();
		file.persistentFile.handleLockReleaser = null;
		this.log?.(`lock released for ${file.path}`);
	}
	/**
	* @param {PersistentFile} persistentFile 
	* @returns  {Promise<function>} lock releaser
	*/
	#acquireLock(persistentFile) {
		return new Promise((resolve) => {
			const lockName = persistentFile.handleRequestChannel.name;
			const notify = () => {
				this.log?.(`notifying for ${lockName}`);
				persistentFile.handleRequestChannel.postMessage(null);
			};
			const notifyId = setInterval(notify, LOCK_NOTIFY_INTERVAL);
			setTimeout(notify);
			this.log?.(`lock requested: ${lockName}`);
			navigator.locks.request(lockName, (lock) => {
				this.log?.(`lock acquired: ${lockName}`, lock);
				clearInterval(notifyId);
				return new Promise(resolve);
			});
		});
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
//#endregion
export { OPFSCoopSyncVFS };

//# sourceMappingURL=OPFSCoopSyncVFS-4nYsAb-q.js.map