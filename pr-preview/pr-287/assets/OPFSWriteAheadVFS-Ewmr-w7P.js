import { a as SQLITE_IOERR_CLOSE, c as SQLITE_IOERR_FSYNC, d as SQLITE_IOERR_UNLOCK, l as SQLITE_IOERR_LOCK, n as SQLITE_IOCAP_UNDELETABLE_WHEN_OPEN, o as SQLITE_IOERR_DELETE, r as SQLITE_IOERR_ACCESS, s as SQLITE_IOERR_FSTAT, t as SQLITE_IOCAP_BATCH_ATOMIC, u as SQLITE_IOERR_TRUNCATE } from "./WASQLiteDB.worker-slw50FGL.js";
import { t as FacadeVFS } from "./FacadeVFS-C-MzI7sq.js";
//#region node_modules/@journeyapps/wa-sqlite/src/examples/Lock.js
var Lock = class {
	#name;
	/** @type {LockMode?} */ #mode = null;
	/** @type {Promise<Function|null>} */ #releaser = Promise.resolve(null);
	#isAcquiring = false;
	/**
	* @param {string} name 
	*/
	constructor(name) {
		this.#name = name;
	}
	get name() {
		return this.#name;
	}
	get mode() {
		return this.#mode;
	}
	close() {
		this.release();
	}
	/**
	* @param {'shared'|'exclusive'} mode 
	* @param {number} timeout -1 for infinite, 0 for poll, >0 for milliseconds
	* @return {Promise<boolean>} true if lock acquired, false on failed poll
	*/
	async acquire(mode, timeout = -1) {
		if (this.#isAcquiring) throw new Error("Lock is already being acquired");
		this.#isAcquiring = true;
		try {
			if (this.#mode) throw new Error(`Lock ${this.#name} is already acquired`);
			this.#releaser = new Promise((resolve, reject) => {
				/** @type {LockOptions} */
				const options = {
					mode,
					ifAvailable: timeout === 0
				};
				if (timeout > 0) options.signal = AbortSignal.timeout(timeout);
				navigator.locks.request(this.#name, options, (lock) => {
					if (lock === null) return resolve(null);
					this.#mode = mode;
					return new Promise((releaser) => {
						resolve(releaser);
					});
				}).catch((e) => {
					return reject(e);
				});
			});
			return this.#releaser.then((releaser) => !!releaser);
		} finally {
			this.#isAcquiring = false;
		}
	}
	release() {
		this.#releaser.then((releaser) => releaser?.(), () => {});
		this.#mode = null;
	}
};
//#endregion
//#region node_modules/@journeyapps/wa-sqlite/src/examples/LazyLock.js
var LazyLock = class extends Lock {
	#channel;
	#isBusy = false;
	#hasReleaseRequest = false;
	/**
	* @param {string} name 
	*/
	constructor(name) {
		super(name);
		this.#channel = new BroadcastChannel(name);
		this.#channel.onmessage = (event) => {
			if (this.#isBusy) this.#hasReleaseRequest = true;
			else this.release();
		};
	}
	close() {
		super.close();
		this.#channel.onmessage = null;
		this.#channel.close();
	}
	/**
	* @param {LockMode} mode 
	* @param {number} timeout 
	* @returns {Promise<boolean>}
	*/
	async acquire(mode, timeout = -1) {
		this.#isBusy = true;
		try {
			if (mode === this.mode) return true;
			if (this.mode) super.release();
			else if (await super.acquire(mode, 0)) return true;
			const pResult = super.acquire(mode, timeout);
			this.#channel.postMessage({});
			return await pResult;
		} catch (e) {
			this.release();
			throw e;
		}
	}
	/**
	* @param {LockMode} mode 
	* @returns {boolean}
	*/
	acquireIfHeld(mode) {
		if (mode === this.mode) {
			this.#isBusy = true;
			return true;
		}
		return false;
	}
	release() {
		super.release();
		this.#isBusy = false;
		this.#hasReleaseRequest = false;
	}
	releaseLazy() {
		this.#isBusy = false;
		if (this.#hasReleaseRequest) this.release();
	}
};
//#endregion
//#region node_modules/@journeyapps/wa-sqlite/src/examples/WriteAhead.js
const DEFAULT_JOURNAL_SIZE_LIMIT = 1e3;
const DEFAULT_BACKSTOP_INTERVAL = 3e4;
const MAGIC = 931071620;
const FILE_HEADER_SIZE = 32;
const FRAME_HEADER_SIZE = 32;
const FRAME_TYPE_PAGE = 0;
const FRAME_TYPE_COMMIT = 1;
const FRAME_TYPE_END = 2;
/**
* @typedef PageEntry
* @property {number} waOffset location in WAL file
* @property {number} waSalt1 WAL2 file identifier
* @property {number} pageSize
* @property {Uint8Array} [pageData]
*/
/**
* @typedef Transaction
* @property {number} id
* @property {Map<number, PageEntry>} pages address to page data mapping
* @property {number} dbFileSize
* @property {number} [newPageSize]
* @property {number} waSalt1 WAL2 file identifier
* @property {number} waOffsetEnd
*/
/**
* @typedef WriteAheadOptions
* @property {number} [autoCheckpoint]
* @property {number} [backstopInterval]
* @property {number} [journalSizeLimit]
*/
var WriteAhead = class {
	log = null;
	/** @type {WriteAheadOptions} */ options = {
		autoCheckpoint: 1,
		backstopInterval: DEFAULT_BACKSTOP_INTERVAL,
		journalSizeLimit: DEFAULT_JOURNAL_SIZE_LIMIT
	};
	#zName;
	#dbHandle;
	/** @type {FileSystemSyncAccessHandle[]} */ #waHandles;
	/** @type {FileSystemSyncAccessHandle} */ #activeHandle;
	/** @type {{nextTxId: number, salt1: number, salt2: number}} */ #activeHeader;
	/** @type {number} */ #activeOffset;
	/** @type {number} */ #txId = 0;
	/** @type {Transaction} */ #txInProgress = null;
	#dbFileSize = 0;
	/** @type {Promise<any>} */ #ready;
	/** @type {'read'|'write'} */ #isolationState = null;
	/** @type {Lock} */ #txIdLock = null;
	/** @type {Map<number, PageEntry>} */ #waOverlay = /* @__PURE__ */ new Map();
	/** @type {Map<number, Transaction>} */ #mapIdToTx = /* @__PURE__ */ new Map();
	/** @type {Map<number, Transaction>} */ #mapIdToPendingTx = /* @__PURE__ */ new Map();
	#approxPageCount = 0;
	/** @type {BroadcastChannel} */ #broadcastChannel;
	/** @type {number} */ #backstopTimer;
	/** @type {number} */ #backstopTimestamp = 0;
	#abortController = new AbortController();
	/**
	* @param {string} zName
	* @param {FileSystemSyncAccessHandle} dbHandle
	* @param {FileSystemSyncAccessHandle[]} waHandles
	* @param {WriteAheadOptions} options
	*/
	constructor(zName, dbHandle, waHandles, options = {}) {
		this.#zName = zName;
		this.#dbHandle = dbHandle;
		this.#waHandles = waHandles;
		this.options = Object.assign(this.options, options);
		this.#ready = (async () => {
			await this.#updateTxIdLock();
			this.#broadcastChannel = new BroadcastChannel(`${zName}#wa`);
			this.#broadcastChannel.onmessage = (event) => {
				this.#handleMessage(event);
			};
			const fileHeader = this.#waHandles.map((handle) => this.#readFileHeader(handle)).filter((h) => h).sort((a, b) => a.nextTxId - b.nextTxId)[0] ?? this.#writeFileHeader(Math.floor(Math.random() * 4294967295));
			this.#activeHeader = fileHeader;
			this.#activeHandle = this.#waHandles[fileHeader.salt1 & 1];
			this.#activeOffset = FILE_HEADER_SIZE;
			this.#txId = fileHeader.nextTxId - 1;
			for (const tx of this.#readAllTx()) this.#activateTx(tx);
			this.#updateTxIdLock();
			this.#backstopTimestamp = performance.now();
			this.#backstop();
		})();
	}
	/**
	* @returns {Promise<void>}
	*/
	ready() {
		return this.#ready;
	}
	close() {
		this.#abortController.abort();
		this.#broadcastChannel.onmessage = null;
		clearTimeout(this.#backstopTimer);
		this.#txIdLock?.release();
		this.#broadcastChannel.close();
	}
	/**
	* Freeze our view of the database.
	* The view includes the transactions received so far but is not
	* guaranteed to be completely up to date. Unfreeze the view with rejoin().
	*/
	isolateForRead() {
		if (this.#isolationState !== null) throw new Error("Already in isolated state");
		this.#isolationState = "read";
		clearTimeout(this.#backstopTimer);
		this.#backstopTimer = null;
	}
	/**
	* Freeze our view of the database for writing.
	* The view includes all transactions. Unfreeze the view with rejoin().
	*/
	isolateForWrite() {
		if (this.#isolationState !== null) throw new Error("Already in isolated state");
		this.#isolationState = "write";
		clearTimeout(this.#backstopTimer);
		this.#backstopTimer = null;
		this.#advanceTxId({ readToCurrent: true });
	}
	rejoin() {
		if (this.#isolationState === "read") this.#advanceTxId({ autoCheckpoint: true });
		this.#isolationState = null;
		this.#backstop();
	}
	/**
	* @param {number} offset
	* @return {Uint8Array?}
	*/
	read(offset) {
		const pageEntry = this.#txInProgress?.pages.get(offset) ?? this.#waOverlay.get(offset);
		if (pageEntry) {
			if (pageEntry.pageData) {
				this.log?.(`%cread page at ${offset} from WAL ${pageEntry.waSalt1 & 1}:${pageEntry.waOffset} (cached)`, "background-color: gold;");
				return pageEntry.pageData;
			}
			this.log?.(`%cread page at ${offset} from WAL ${pageEntry.waSalt1 & 1}:${pageEntry.waOffset}`, "background-color: gold;");
			return this.#fetchPage(pageEntry);
		}
		return null;
	}
	/**
	* @param {number} offset
	* @param {Uint8Array} data
	* @param {{dstPageSize: number?}} options
	*/
	write(offset, data, options) {
		if (this.#isolationState !== "write") throw new Error("Not in write isolated state");
		if (!this.#txInProgress) {
			const nPageThreshold = this.options.journalSizeLimit > 0 ? this.options.journalSizeLimit : DEFAULT_JOURNAL_SIZE_LIMIT;
			if (this.#approxPageCount >= nPageThreshold && this.#isInactiveFileEmpty()) {
				this.log?.(`%cchange WAL file at ${this.#approxPageCount} pages`, "background-color: lightskyblue;");
				this.#swapActiveFile();
			}
			this.#beginTx();
			if (options.dstPageSize !== data.byteLength) this.#txInProgress.newPageSize = options.dstPageSize;
		}
		if (this.#txInProgress.newPageSize) {
			const frameSize = FRAME_HEADER_SIZE + this.#txInProgress.newPageSize;
			if (data.byteLength > this.#txInProgress.newPageSize) for (let i = 0; i < data.byteLength; i += this.#txInProgress.newPageSize) {
				const pageData = data.slice(i, i + this.#txInProgress.newPageSize);
				const waOffset = this.#writePage(offset + i, pageData);
				this.log?.(`%cwrite page at ${offset + i} to WAL ${this.#activeHeader.salt1 & 1}:${waOffset}`, "background-color: lightskyblue;");
			}
			else {
				const pageOffset = offset % this.#txInProgress.newPageSize;
				const waOffset = this.#activeOffset + (offset - pageOffset) / this.#txInProgress.newPageSize * frameSize + FRAME_HEADER_SIZE + pageOffset;
				this.#activeHandle.write(data.subarray(), { at: waOffset });
				this.log?.(`%cwrite page at ${offset} to WAL ${this.#activeHeader.salt1 & 1}:${waOffset}`, "background-color: lightskyblue;");
			}
		} else {
			const waOffset = this.#writePage(offset, data.slice());
			this.log?.(`%cwrite page at ${offset} to WAL ${this.#activeHeader.salt1 & 1}:${waOffset}`, "background-color: lightskyblue;");
		}
	}
	/**
	* @param {number} newSize
	*/
	truncate(newSize) {
		if (this.#txInProgress) {
			for (const offset of this.#txInProgress.pages.keys()) if (offset >= newSize) this.#txInProgress.pages.delete(offset);
		}
	}
	getFileSize() {
		return this.#txInProgress?.dbFileSize ?? this.#dbFileSize;
	}
	commit() {
		const tx = this.#txInProgress;
		if (tx.newPageSize && tx.pages.size === 0) {
			let pageCount = 1;
			for (let i = 0; i < pageCount; i++) {
				const pageData = new Uint8Array(tx.newPageSize);
				const waOffset = this.#activeOffset + i * (FRAME_HEADER_SIZE + tx.newPageSize) + FRAME_HEADER_SIZE;
				this.#activeHandle.read(pageData, { at: waOffset });
				if (i === 0) pageCount = new DataView(pageData.buffer).getUint32(28);
				this.#writePage(i * tx.newPageSize, pageData);
			}
		}
		const page1 = this.#txInProgress.pages.get(0)?.pageData;
		if (page1) {
			const pageCount = new DataView(page1.buffer, page1.byteOffset, page1.byteLength).getUint32(28);
			this.#txInProgress.dbFileSize = pageCount * page1.byteLength;
		} else {
			this.rollback();
			return;
		}
		this.#commitTx();
		this.#activateTx(tx);
		this.#updateTxIdLock();
		const payload = {
			type: "tx",
			tx
		};
		this.#broadcastChannel.postMessage(payload);
		this.#autoCheckpoint();
		this.#backstopTimestamp = performance.now();
	}
	rollback() {
		this.#abortTx();
	}
	/**
	* @param {{durability: 'strict'|'relaxed'}} options
	*/
	sync(options) {
		if (options.durability === "strict") this.#flushActiveFile();
	}
	/**
	* Move pages from write-ahead to main database file.
	*
	* @param {{isPassive: boolean}} options
	*/
	async checkpoint(options = { isPassive: true }) {
		const lockOptions = { ifAvailable: options.isPassive };
		await navigator.locks.request(`${this.#zName}#ckpt`, lockOptions, async (lock) => {
			if (!lock) return;
			if (this.#abortController.signal.aborted) return;
			let ckptId = this.#getActiveFileStartingTxId() - 1;
			if (options.isPassive) {
				if (!this.#mapIdToTx.has(ckptId)) return;
				if ((await this.#getTxIdLocks()).reduce((min, value) => Math.min(min, value.maxTxId), this.#txId) < ckptId) return;
			} else {
				await this.#waitForTxIdLocks((value) => value.maxTxId >= this.#txId);
				ckptId = this.#txId;
			}
			this.log?.(`%ccheckpoint through txId ${ckptId}`, "background-color: lightgreen;");
			this.#flushInactiveFile();
			if (!options.isPassive) this.#flushActiveFile();
			const writtenOffsets = /* @__PURE__ */ new Set();
			let dbFileSize = this.#dbHandle.getSize();
			for (let tx = this.#mapIdToTx.get(ckptId); tx; tx = this.#mapIdToTx.get(tx.id - 1)) {
				if (tx.id === ckptId && dbFileSize !== tx.dbFileSize) {
					dbFileSize = tx.dbFileSize;
					this.#dbHandle.truncate(dbFileSize);
				}
				for (const [offset, pageEntry] of tx.pages) if (offset < dbFileSize && !writtenOffsets.has(offset)) {
					const pageData = pageEntry.pageData ?? this.#fetchPage(pageEntry);
					if (this.#dbHandle.write(pageData, { at: offset }) !== pageData.byteLength) throw new Error("Checkpoint write failed");
					writtenOffsets.add(offset);
					this.log?.(`%ccheckpoint wrote txId ${tx.id} page at ${offset} to database`, "background-color: lightgreen;");
				}
				if (tx.newPageSize) break;
			}
			this.log?.(`%ccheckpoint flush database file`, "background-color: lightgreen;");
			this.#dbHandle.flush();
			this.#broadcastChannel.postMessage({
				type: "ckpt",
				ckptId
			});
			this.#handleCheckpoint(ckptId);
			this.log?.(`%ccheckpoint waiting for connection updates`, "background-color: lightgreen;");
			await this.#waitForTxIdLocks((value) => value.minTxId > ckptId);
			this.#truncateInactiveFile();
			this.log?.(`%ccheckpoint complete`, "background-color: lightgreen;");
		});
	}
	/**
	* Return the approximate number of write-ahead pages. This is the
	* sum of the number of unique page indices for each transaction,
	* so it can be fewer than the number of pages if any transaction
	* contains multiple frames for the same page.
	* @returns {number}
	*/
	getWriteAheadSize() {
		return this.#approxPageCount;
	}
	isTransactionPending() {
		return !!this.#txInProgress;
	}
	setBackstopInterval(intervalMillis) {
		this.options.backstopInterval = intervalMillis;
		if (intervalMillis > 0 && this.#isolationState) this.#backstop();
	}
	/**
	* Incorporate a transaction into our view of the database.
	* @param {Transaction} tx
	*/
	#activateTx(tx) {
		this.#mapIdToTx.set(tx.id, tx);
		this.#approxPageCount += tx.pages.size;
		for (const [offset, pageEntry] of tx.pages) this.#waOverlay.set(offset, pageEntry);
		this.#dbFileSize = tx.dbFileSize;
	}
	/**
	* Advance the local view of the database. By default, advance to the
	* last broadcast transaction. Optionally, also advance through any
	* additional transactions in the WAL file to be fully current.
	*
	* @param {{readToCurrent?: boolean, autoCheckpoint?: boolean}} options
	*/
	#advanceTxId(options = {}) {
		let didAdvance = false;
		while (this.#mapIdToPendingTx.size) {
			const nextTxId = this.#txId + 1;
			let tx;
			if (this.#mapIdToPendingTx.has(nextTxId)) {
				tx = this.#mapIdToPendingTx.get(nextTxId);
				this.#mapIdToPendingTx.delete(tx.id);
				this.#skipTx(tx);
			} else tx = this.#readTx();
			this.#activateTx(tx);
			didAdvance = true;
		}
		if (options.readToCurrent) for (const tx of this.#readAllTx()) {
			this.#activateTx(tx);
			didAdvance = true;
		}
		if (didAdvance) {
			this.#updateTxIdLock();
			if (options.autoCheckpoint) this.#autoCheckpoint();
		}
		if (options.readToCurrent || didAdvance) this.#backstopTimestamp = performance.now();
	}
	#autoCheckpoint() {
		if (this.options.autoCheckpoint > 0) this.checkpoint({ isPassive: true });
	}
	/**
	* After a checkpoint, remove checkpointed pages from write-ahead.
	* The checkpoint may be been done locally or by another connection.
	* @param {number} ckptId
	*/
	#handleCheckpoint(ckptId) {
		this.log?.(`%capply checkpoint through txId ${ckptId}`, "background-color: lightgreen;");
		for (let tx = this.#mapIdToTx.get(ckptId); tx; tx = this.#mapIdToTx.get(tx.id - 1)) {
			for (const [offset, pageEntry] of tx.pages.entries()) if (this.#waOverlay.get(offset) === pageEntry) {
				this.log?.(`%cremove txId ${tx.id} page at offset ${offset}`, "background-color: lightgreen;");
				this.#waOverlay.delete(offset);
			}
			this.#mapIdToTx.delete(tx.id);
			this.#approxPageCount -= tx.pages.size;
		}
		this.#updateTxIdLock();
	}
	/**
	* @param {MessageEvent} event
	*/
	#handleMessage(event) {
		if (event.data.type === "tx") {
			/** @type {Transaction} */ const tx = event.data.tx;
			if (tx.id > this.#txId) {
				this.#mapIdToPendingTx.set(tx.id, tx);
				if (this.#isolationState === null) this.#advanceTxId({ autoCheckpoint: true });
			}
		} else if (event.data.type === "ckpt") {
			/** @type {number} */ const ckptId = event.data.ckptId;
			this.#handleCheckpoint(ckptId);
		}
	}
	/**
	* Periodic check for recovering from lost transaction broadcasts.
	*/
	#backstop() {
		if (this.options.backstopInterval <= 0) return;
		if (this.#isolationState) throw new Error("Backstop was invoked in an isolated state");
		if (performance.now() >= this.#backstopTimestamp + this.options.backstopInterval) {
			const oldTxId = this.#txId;
			this.#advanceTxId({ readToCurrent: true });
			if (this.#txId > oldTxId) this.log?.(`%cbackstop txId ${oldTxId} -> ${this.#txId}`, "background-color: lightyellow;");
			this.#backstopTimestamp = performance.now();
		}
		const delay = this.#backstopTimestamp + this.options.backstopInterval - performance.now();
		clearTimeout(this.#backstopTimer);
		this.#backstopTimer = self.setTimeout(() => {
			this.#backstop();
		}, delay);
	}
	/**
	* Update the lock that publishes our current txId.
	*/
	async #updateTxIdLock() {
		const oldLock = this.#txIdLock;
		const newLockName = this.#encodeTxIdLockName();
		if (oldLock?.name !== newLockName) {
			this.#txIdLock = new Lock(newLockName);
			await this.#txIdLock.acquire("shared").then(() => {
				oldLock?.release();
			});
			if (this.log) {
				const { minTxId, maxTxId } = this.#decodeTxIdLockName(newLockName);
				this.log?.(`%ctxId to ${minTxId}:${maxTxId}`, "background-color: pink;");
			}
		}
	}
	/**
	* Get all txId locks for this database.
	* @returns {Promise<{name: string, minTxId: number, maxTxId: number, encoded: string}[]>}
	*/
	async #getTxIdLocks() {
		const { held } = await navigator.locks.query();
		return held.map((lock) => this.#decodeTxIdLockName(lock.name)).filter((value) => value !== null);
	}
	/**
	* @returns {string}
	*/
	#encodeTxIdLockName() {
		const maxTxId = this.#txId;
		const minTxId = this.#mapIdToTx.keys().next().value ?? maxTxId + 1;
		return `${this.#zName}-txId<${minTxId.toString(36)}:${maxTxId.toString(36)}>`;
	}
	/**
	* @param {string} lockName
	* @returns {{name: string, minTxId: number, maxTxId: number, encoded: string}?}
	*/
	#decodeTxIdLockName(lockName) {
		const match = lockName.match(/^(.*)-txId<([0-9a-z]+):([0-9a-z]+)>$/);
		if (match?.[1] === this.#zName) return {
			name: match[1],
			minTxId: parseInt(match[2], 36),
			maxTxId: parseInt(match[3], 36),
			encoded: lockName
		};
		return null;
	}
	/**
	* Wait for all txId locks that fail the provided predicate.
	* @param {(lock: {name: string, minTxId: number, maxTxId: number}) => boolean} predicate
	*/
	async #waitForTxIdLocks(predicate) {
		/** @type {string[]} */ let failingLockNames = [];
		do {
			if (failingLockNames.length > 0) await Promise.all(failingLockNames.map((name) => navigator.locks.request(name, async () => {})));
			failingLockNames = (await this.#getTxIdLocks()).filter((value) => !predicate(value)).map((value) => value.encoded);
		} while (failingLockNames.length > 0);
	}
	/**
	* @param {PageEntry} pageEntry
	* @returns {Uint8Array}
	*/
	#fetchPage(pageEntry) {
		const accessHandle = this.#waHandles[pageEntry.waSalt1 & 1];
		const pageData = new Uint8Array(pageEntry.pageSize);
		const nBytesRead = accessHandle.read(pageData, { at: pageEntry.waOffset });
		if (nBytesRead !== pageEntry.pageSize) throw new Error(`Short WAL read: expected ${pageEntry.pageSize} bytes, got ${nBytesRead}`);
		return pageData;
	}
	*#readAllTx() {
		while (true) {
			const tx = this.#readTx();
			if (!tx) break;
			yield tx;
		}
	}
	/**
	* @returns {Transaction?}
	*/
	#readTx() {
		/** @type {Transaction} */ const tx = {
			id: 0,
			pages: /* @__PURE__ */ new Map(),
			dbFileSize: 0,
			waSalt1: 0,
			waOffsetEnd: 0
		};
		let offset = this.#activeOffset;
		while (true) {
			const frame = this.#readFrame(offset);
			if (!frame) return null;
			if (frame.frameType === FRAME_TYPE_PAGE) tx.pages.set(frame.pageOffset, {
				pageSize: frame.pageData.byteLength,
				waOffset: offset + FRAME_HEADER_SIZE,
				waSalt1: this.#activeHeader.salt1
			});
			else if (frame.frameType === FRAME_TYPE_COMMIT) {
				this.#txId += 1;
				this.#activeOffset = offset + frame.byteLength;
				tx.id = this.#txId;
				tx.dbFileSize = frame.dbFileSize;
				tx.waSalt1 = this.#activeHeader.salt1;
				tx.newPageSize = frame.flags & 1 ? tx.pages.get(0).pageSize : null;
				tx.waOffsetEnd = this.#activeOffset;
				return tx;
			} else if (frame.frameType === FRAME_TYPE_END) {
				this.#followFileChange(frame.fileHeader);
				offset = this.#activeOffset;
				continue;
			}
			offset += frame.byteLength;
		}
	}
	/**
	* This method is called when transaction(s) have been received by other
	* means than readTx(), e.g. via BroadcastChannel.
	*
	* @param {Transaction} tx
	*/
	#skipTx(tx) {
		if (tx.waSalt1 !== this.#activeHeader.salt1) {
			if (!this.#followFileChange(null)) throw new Error("invalid WAL file");
		}
		this.#txId = tx.id;
		this.#activeOffset = tx.waOffsetEnd;
	}
	/**
	* @param {{overwrite?: boolean}} options
	* @returns {Transaction}
	*/
	#beginTx(options = {}) {
		this.#txInProgress = {
			id: this.#txId + 1,
			pages: /* @__PURE__ */ new Map(),
			dbFileSize: this.#dbFileSize,
			waSalt1: this.#activeHeader.salt1,
			waOffsetEnd: this.#activeOffset
		};
		return this.#txInProgress;
	}
	/**
	* Write a page frame to the WAL file.
	*
	* @param {number} pageOffset
	* @param {Uint8Array} pageData
	*/
	#writePage(pageOffset, pageData) {
		const headerView = new DataView(new ArrayBuffer(FRAME_HEADER_SIZE));
		headerView.setUint8(0, FRAME_TYPE_PAGE);
		headerView.setUint16(2, pageData.byteLength === 65536 ? 1 : pageData.byteLength);
		headerView.setBigUint64(8, BigInt(pageOffset));
		headerView.setUint32(16, this.#activeHeader.salt1);
		headerView.setUint32(20, this.#activeHeader.salt2);
		const checksum = new Checksum();
		checksum.update(new Uint8Array(headerView.buffer, 0, FRAME_HEADER_SIZE - 8));
		checksum.update(pageData);
		headerView.setUint32(24, checksum.s0);
		headerView.setUint32(28, checksum.s1);
		const bytesWritten = this.#activeHandle.write(headerView, { at: this.#txInProgress.waOffsetEnd }) + this.#activeHandle.write(pageData, { at: this.#txInProgress.waOffsetEnd + FRAME_HEADER_SIZE });
		if (bytesWritten !== headerView.byteLength + pageData.byteLength) throw new Error("write failed");
		const pageEntry = {
			pageSize: pageData.byteLength,
			waOffset: this.#txInProgress.waOffsetEnd + FRAME_HEADER_SIZE,
			waSalt1: this.#activeHeader.salt1,
			pageData: pageOffset === 0 ? pageData : void 0
		};
		this.#txInProgress.pages.set(pageOffset, pageEntry);
		this.#txInProgress.waOffsetEnd += bytesWritten;
		return pageEntry.waOffset;
	}
	/**
	* @returns {Transaction}
	*/
	#commitTx() {
		const headerView = new DataView(new ArrayBuffer(FRAME_HEADER_SIZE));
		headerView.setUint8(0, FRAME_TYPE_COMMIT);
		headerView.setUint8(1, this.#txInProgress.newPageSize ? 1 : 0);
		headerView.setBigUint64(8, BigInt(this.#txInProgress.dbFileSize));
		headerView.setUint32(16, this.#activeHeader.salt1);
		headerView.setUint32(20, this.#activeHeader.salt2);
		const checksum = new Checksum();
		checksum.update(new Uint8Array(headerView.buffer, 0, FRAME_HEADER_SIZE - 8));
		headerView.setUint32(24, checksum.s0);
		headerView.setUint32(28, checksum.s1);
		const bytesWritten = this.#activeHandle.write(headerView, { at: this.#txInProgress.waOffsetEnd });
		if (bytesWritten !== headerView.byteLength) throw new Error("write failed");
		this.#txInProgress.waOffsetEnd += bytesWritten;
		const tx = this.#txInProgress;
		this.#txInProgress = null;
		this.#activeOffset = tx.waOffsetEnd;
		this.#txId = tx.id;
		return tx;
	}
	#abortTx() {
		this.#txInProgress = null;
		this.#activeHandle.truncate(this.#activeOffset);
	}
	/**
	* Switch the active WAL file prior to writing the next transaction.
	*/
	#swapActiveFile() {
		const frameView = new DataView(new ArrayBuffer(FRAME_HEADER_SIZE));
		frameView.setUint8(0, FRAME_TYPE_END);
		frameView.setUint32(16, this.#activeHeader.salt1);
		frameView.setUint32(20, this.#activeHeader.salt2);
		const checksum = new Checksum();
		checksum.update(new Uint8Array(frameView.buffer, 0, FRAME_HEADER_SIZE - 8));
		frameView.setUint32(24, checksum.s0);
		frameView.setUint32(28, checksum.s1);
		if (this.#activeHandle.write(frameView, { at: this.#activeOffset }) !== frameView.byteLength) throw new Error("write failed");
		this.#activeHeader = this.#writeFileHeader();
		this.#activeHandle = this.#getInactiveHandle();
		this.#activeOffset = FILE_HEADER_SIZE;
	}
	#getActiveFileStartingTxId() {
		return this.#activeHeader.nextTxId;
	}
	#flushActiveFile() {
		this.#activeHandle.flush();
	}
	#flushInactiveFile() {
		this.#getInactiveHandle().flush();
	}
	#isInactiveFileEmpty() {
		if (this.#mapIdToTx.has(this.#activeHeader.nextTxId - 1)) return false;
		const inactiveHandle = this.#getInactiveHandle();
		if (inactiveHandle.getSize() < FILE_HEADER_SIZE) return true;
		return this.#readFileHeader(inactiveHandle) === null;
	}
	#truncateInactiveFile() {
		this.#getInactiveHandle().truncate(0);
	}
	/**
	* This method is called after reading an end frame to switch to the
	* other WAL file.
	* @param {{nextTxId: number, salt1: number, salt2: number}?} fileHeader
	*/
	#followFileChange(fileHeader) {
		const accessHandle = this.#getInactiveHandle();
		if (!fileHeader) {
			fileHeader = this.#readFileHeader(accessHandle);
			if (fileHeader?.salt1 !== this.#activeHeader.salt1 + 1 >>> 0) return null;
		}
		this.#activeHandle = accessHandle;
		this.#activeHeader = fileHeader;
		this.#activeOffset = FILE_HEADER_SIZE;
		return fileHeader;
	}
	#getInactiveHandle() {
		return this.#activeHandle !== this.#waHandles[0] ? this.#waHandles[0] : this.#waHandles[1];
	}
	/**
	* @param {FileSystemSyncAccessHandle} accessHandle
	*/
	#readFileHeader(accessHandle) {
		const headerView = new DataView(new ArrayBuffer(FILE_HEADER_SIZE));
		if (accessHandle.read(headerView, { at: 0 }) !== headerView.byteLength) return null;
		if (headerView.getUint32(0) !== MAGIC) return null;
		const checksum = new Checksum();
		checksum.update(new Uint8Array(headerView.buffer, 0, FILE_HEADER_SIZE - 8));
		if (!checksum.matches(headerView.getUint32(24), headerView.getUint32(28))) return null;
		return {
			nextTxId: Number(headerView.getBigUint64(8)),
			salt1: headerView.getUint32(16),
			salt2: headerView.getUint32(20)
		};
	}
	/**
	* @param {number} offset
	*/
	#readFrame(offset) {
		const headerView = new DataView(new ArrayBuffer(FRAME_HEADER_SIZE));
		if (this.#activeHandle.read(headerView, { at: offset }) !== headerView.byteLength) return null;
		const frameSalt1 = headerView.getUint32(16);
		const frameSalt2 = headerView.getUint32(20);
		if (frameSalt1 !== this.#activeHeader.salt1 || frameSalt2 !== this.#activeHeader.salt2) return null;
		const payloadSize = ((size) => size === 1 ? 65536 : size)(headerView.getUint16(2));
		/** @type {Uint8Array} */ let payloadData;
		if (payloadSize) {
			payloadData = new Uint8Array(payloadSize);
			if (this.#activeHandle.read(payloadData, { at: offset + FRAME_HEADER_SIZE }) !== payloadSize) return null;
		}
		const checksum = new Checksum();
		checksum.update(new Uint8Array(headerView.buffer, 0, FRAME_HEADER_SIZE - 8));
		if (payloadData) checksum.update(payloadData);
		if (!checksum.matches(headerView.getUint32(24), headerView.getUint32(28))) return null;
		const frameType = headerView.getUint8(0);
		if (frameType === FRAME_TYPE_PAGE) return {
			frameType,
			byteLength: FRAME_HEADER_SIZE + payloadSize,
			pageOffset: Number(headerView.getBigUint64(8)),
			pageData: payloadData
		};
		else if (frameType === FRAME_TYPE_COMMIT) return {
			frameType,
			byteLength: FRAME_HEADER_SIZE,
			flags: headerView.getUint8(1),
			dbFileSize: Number(headerView.getBigUint64(8))
		};
		else if (frameType === FRAME_TYPE_END) {
			const fileHeader = this.#readFileHeader(this.#getInactiveHandle());
			if (fileHeader?.salt1 !== this.#activeHeader.salt1 + 1 >>> 0) return null;
			return {
				frameType,
				byteLength: FRAME_HEADER_SIZE,
				fileHeader
			};
		}
		throw new Error(`Invalid frame type: ${frameType}`);
	}
	#writeFileHeader(prevSalt1 = this.#activeHeader.salt1) {
		const nextTxId = this.#txId + 1;
		const salt1 = prevSalt1 + 1 >>> 0;
		const salt2 = Math.floor(Math.random() * 4294967295) >>> 0;
		const headerView = new DataView(new ArrayBuffer(FILE_HEADER_SIZE));
		headerView.setUint32(0, MAGIC);
		headerView.setBigUint64(8, BigInt(nextTxId));
		headerView.setUint32(16, salt1);
		headerView.setUint32(20, salt2);
		const checksum = new Checksum();
		checksum.update(new Uint8Array(headerView.buffer, 0, FILE_HEADER_SIZE - 8));
		headerView.setUint32(24, checksum.s0);
		headerView.setUint32(28, checksum.s1);
		if (this.#waHandles[salt1 & 1].write(headerView, { at: 0 }) !== headerView.byteLength) throw new Error("write failed");
		return {
			nextTxId,
			salt1,
			salt2
		};
	}
};
var Checksum = class {
	/** @type {number} */ s0 = 0;
	/** @type {number} */ s1 = 0;
	/**
	* @param {ArrayBuffer|ArrayBufferView} data
	*/
	update(data) {
		if (data.byteLength % 8 !== 0) throw new Error("Data must be a multiple of 8 bytes");
		const words = ArrayBuffer.isView(data) ? new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4) : new Uint32Array(data);
		for (let i = 0; i < words.length; i += 2) {
			this.s0 = this.s0 + words[i] + this.s1 >>> 0;
			this.s1 = this.s1 + words[i + 1] + this.s0 >>> 0;
		}
	}
	matches(s0, s1) {
		return this.s0 === s0 && this.s1 === s1;
	}
};
//#endregion
//#region node_modules/@journeyapps/wa-sqlite/src/examples/OPFSWriteAheadVFS.js
const LIBRARY_FILES_ROOT = ".wa-sqlite";
const DEFAULT_TEMP_FILES = 6;
const finalizationRegistry = new FinalizationRegistry((f) => f());
/**
* @typedef FileEntry
* @property {string} zName
* @property {number} flags
* @property {FileSystemSyncAccessHandle} [accessHandle]

* Main database file properties:
* @property {*} [retryResult]
* @property {FileSystemSyncAccessHandle[]} [waHandles]
* 
* @property {'reserved'|'exclusive'|null} [writeHint]
* @property {'normal'|'exclusive'} [lockingMode]
* @property {number} [lockState] SQLITE_LOCK_*
* @property {LazyLock} [readLock]
* @property {LazyLock} [writeLock]
* @property {'none'|'read'|'write'|'readwrite'} [useLazyLock]
* @property {number} [timeout]
* @property {0|1|2|3} [synchronous]
* @property {number?} [pageSize]
* @property {boolean} [overwrite]
* 
* @property {WriteAhead} [writeAhead]
*/
/**
* @typedef OPFSWriteAheadOptions
* @property {number} [nTmpFiles]
* @property {number} [autoCheckpoint]
* @property {number} [backstopInterval]
*/
var OPFSWriteAheadVFS = class OPFSWriteAheadVFS extends FacadeVFS {
	lastError = null;
	log = null;
	/** @type {Map<number, FileEntry>} */ mapIdToFile = /* @__PURE__ */ new Map();
	/** @type {Map<string, FileEntry>} */ mapPathToFile = /* @__PURE__ */ new Map();
	/** @type {Map<string, FileSystemSyncAccessHandle>} */ boundTempFiles = /* @__PURE__ */ new Map();
	/** @type {Set<FileSystemSyncAccessHandle>} */ unboundTempFiles = /* @__PURE__ */ new Set();
	/** @type {OPFSWriteAheadOptions} */ options = { nTmpFiles: DEFAULT_TEMP_FILES };
	_ready;
	static async create(name, module, options) {
		const vfs = new OPFSWriteAheadVFS(name, module);
		Object.assign(vfs.options, options);
		await vfs.isReady();
		return vfs;
	}
	constructor(name, module) {
		super(name, module);
		this._ready = (async () => {
			let dirHandle = await navigator.storage.getDirectory();
			dirHandle = await dirHandle.getDirectoryHandle(LIBRARY_FILES_ROOT, { create: true });
			for await (const name of dirHandle.keys()) if (name.startsWith(".session-")) await navigator.locks.request(name, { ifAvailable: true }, async (lock) => {
				if (lock) try {
					await dirHandle.removeEntry(name, { recursive: true });
				} catch (e) {}
			});
			const dirName = `.session-${Math.random().toString(16).slice(2)}`;
			await new Promise((resolve) => {
				navigator.locks.request(dirName, () => {
					resolve();
					return new Promise((release) => {
						finalizationRegistry.register(this, release);
					});
				});
			});
			dirHandle = await dirHandle.getDirectoryHandle(dirName, { create: true });
			for (let i = 0; i < this.options.nTmpFiles; i++) {
				const accessHandle = await (await dirHandle.getFileHandle(i.toString(), { create: true })).createSyncAccessHandle();
				finalizationRegistry.register(this, () => accessHandle.close());
				this.unboundTempFiles.add(accessHandle);
			}
		})();
	}
	isReady() {
		return Promise.all([super.isReady(), this._ready]).then(() => true);
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
			if (zName === null) zName = Math.random().toString(16).slice(2);
			const file = this.mapPathToFile.get(zName) ?? {
				zName,
				flags,
				retryResult: null
			};
			this.mapPathToFile.set(zName, file);
			if (flags & 256) {
				if (file.retryResult === null) {
					this._module.retryOps.push(this.#retryOpen(zName, flags, fileId, pOutFlags));
					return 5;
				} else if (file.retryResult instanceof Error) {
					const e = file.retryResult;
					file.retryResult = null;
					throw e;
				}
				file.accessHandle = file.retryResult.accessHandle;
				file.waHandles = file.retryResult.waHandles;
				file.writeAhead = file.retryResult.writeAhead;
				file.retryResult = null;
				file.lockState = 0;
				file.lockingMode = "normal";
				file.readLock = new LazyLock(`${zName}#read`);
				file.writeLock = new LazyLock(`${zName}#write`);
				file.useLazyLock = "readwrite";
				file.timeout = -1;
				file.synchronous = 1;
				file.writeHint = null;
				file.pageSize = null;
				file.overwrite = false;
			} else if (flags & 540672) throw new Error("WAL and super-journal files are not supported");
			else if (file.accessHandle) {} else {
				if (!(flags & 4)) throw new Error("file not found");
				file.accessHandle = this.#openTemporaryFile(zName);
			}
			this.mapIdToFile.set(fileId, file);
			pOutFlags.setInt32(0, flags, true);
			return 0;
		} catch (e) {
			console.error(e.stack);
			this.lastError = e;
			this.mapPathToFile.delete(zName);
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
			if (this.boundTempFiles.has(zName)) {
				const file = this.mapPathToFile.get(zName);
				this.#deleteTemporaryFile(file);
			} else throw new Error(`unexpected file deletion: ${zName}`);
			return 0;
		} catch (e) {
			console.error(e.stack);
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
			const file = this.mapPathToFile.get(zName);
			pResOut.setInt32(0, file ? 1 : 0, true);
			return 0;
		} catch (e) {
			console.error(e.stack);
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
			if (file?.flags & 256) {
				file.writeAhead.close();
				file.accessHandle.close();
				file.waHandles.forEach((handle) => handle.close());
				this.mapPathToFile.delete(file?.zName);
				file.readLock.close();
				file.writeLock.close();
			} else if (file?.flags & 8) this.#deleteTemporaryFile(file);
			this.mapIdToFile.delete(fileId);
			return 0;
		} catch (e) {
			console.error(e.stack);
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
			let bytesRead = null;
			if (file.flags & 256) {
				const pageOffset = iOffset < 100 ? iOffset : 0;
				const page = file.writeAhead.read(iOffset - pageOffset);
				if (page) {
					const readData = page.subarray(pageOffset, pageOffset + pData.byteLength);
					pData.set(readData);
					bytesRead = readData.byteLength;
				}
			}
			if (bytesRead === null) bytesRead = file.accessHandle.read(pData.subarray(), { at: iOffset });
			if (bytesRead < pData.byteLength) {
				pData.fill(0, bytesRead);
				return 522;
			}
			return 0;
		} catch (e) {
			console.error(e.stack);
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
				const isPageResize = file.overwrite && file.pageSize !== pData.byteLength;
				file.writeAhead.write(iOffset, pData, { dstPageSize: isPageResize ? file.pageSize : null });
				return 0;
			}
			file.accessHandle.write(pData.subarray(), { at: iOffset });
			return 0;
		} catch (e) {
			console.error(e.stack);
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
			if (file.flags & 256) {
				file.writeAhead.truncate(iSize);
				return 0;
			}
			file.accessHandle.truncate(iSize);
			return 0;
		} catch (e) {
			console.error(e.stack);
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
			if (file.flags & 256) {
				const durability = file.synchronous > 1 ? "strict" : "relaxed";
				file.writeAhead.sync({ durability });
			}
			return 0;
		} catch (e) {
			console.error(e.stack);
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
			let size;
			if (file.flags & 256) size = file.writeAhead.getFileSize() || file.accessHandle.getSize();
			else size = file.accessHandle.getSize();
			pSize64.setBigInt64(0, BigInt(size), true);
			return 0;
		} catch (e) {
			console.error(e.stack);
			this.lastError = e;
			return SQLITE_IOERR_FSTAT;
		}
	}
	/**
	* @param {number} pFile 
	* @param {number} lockType 
	* @returns {number|Promise<number>}
	*/
	jLock(pFile, lockType) {
		try {
			const file = this.mapIdToFile.get(pFile);
			if (file.lockState === 0 && lockType === 1) {
				if (file.retryResult === null) {
					if (file.lockingMode === "exclusive") {
						file.retryResult = {};
						this._module.retryOps.push(this.#retryLockWrite(file));
						return 5;
					}
					if (file.writeHint) if (!file.writeLock.acquireIfHeld("exclusive")) {
						file.retryResult = {};
						this._module.retryOps.push(this.#retryLockWrite(file));
						return 5;
					} else file.writeAhead.isolateForWrite();
					else if (!file.readLock.acquireIfHeld("shared")) {
						file.retryResult = {};
						this._module.retryOps.push(this.#retryLockRead(file));
						return 5;
					} else file.writeAhead.isolateForRead();
				} else if (file.retryResult instanceof Error) {
					const e = file.retryResult;
					file.retryResult = null;
					throw e;
				}
				file.retryResult = null;
			} else if (lockType >= 2 && !file.writeLock.mode) throw new Error("Write transaction cannot use BEGIN DEFERRED");
			file.lockState = lockType;
			return 0;
		} catch (e) {
			if (e.name === "TimeoutError") return 5;
			console.error(e.stack);
			this.lastError = e;
			return SQLITE_IOERR_LOCK;
		}
	}
	/**
	* @param {number} pFile 
	* @param {number} lockType 
	* @returns {number}
	*/
	jUnlock(pFile, lockType) {
		try {
			const file = this.mapIdToFile.get(pFile);
			if (!file.retryResult && lockType === 0) {
				file.writeAhead.rejoin();
				switch (file.useLazyLock) {
					case "none":
						file.writeLock.release();
						file.readLock.release();
						break;
					case "read":
						file.writeLock.release();
						file.readLock.releaseLazy();
						break;
					case "write":
						file.writeLock.releaseLazy();
						file.readLock.release();
						break;
					case "readwrite":
						file.writeLock.releaseLazy();
						file.readLock.releaseLazy();
						break;
				}
				file.writeHint = null;
			}
			file.lockState = lockType;
		} catch (e) {
			console.error(e.stack);
			this.lastError = e;
			return SQLITE_IOERR_UNLOCK;
		}
	}
	/**
	* @param {number} pFile 
	* @param {DataView} pResOut 
	* @returns {number}
	*/
	jCheckReservedLock(pFile, pResOut) {
		console.assert(false, "unexpected");
		pResOut.setInt32(0, 0, true);
		return 0;
	}
	/**
	* @param {number} pFile
	* @param {number} op
	* @param {DataView} pArg
	* @returns {number}
	*/
	jFileControl(pFile, op, pArg) {
		try {
			const file = this.mapIdToFile.get(pFile);
			switch (op) {
				case 14:
					const key = this._module.UTF8ToString(pArg.getUint32(4, true));
					const valueAddress = pArg.getUint32(8, true);
					const value = valueAddress ? this._module.UTF8ToString(valueAddress) : null;
					this.log?.(`PRAGMA ${key} ${value}`);
					switch (key.toLowerCase()) {
						case "experimental_pragma_20251114":
							switch (value) {
								case "1":
									file.writeHint = "reserved";
									break;
								case "2":
									file.writeHint = "exclusive";
									break;
								default: throw new Error(`unexpected write hint value: ${value}`);
							}
							break;
						case "backstop_interval":
							if (value !== null) {
								const millis = parseInt(value);
								file.writeAhead.setBackstopInterval(millis);
							} else {
								const s = file.writeAhead.options.backstopInterval.toString();
								const ptr = this._module._sqlite3_malloc64(s.length + 1);
								this._module.stringToUTF8(s, ptr, s.length + 1);
								pArg.setUint32(0, ptr, true);
							}
							return 0;
						case "busy_timeout":
							if (value !== null) file.timeout = parseInt(value);
							else {
								const s = file.timeout.toString();
								const ptr = this._module._sqlite3_malloc64(s.length + 1);
								this._module.stringToUTF8(s, ptr, s.length + 1);
								pArg.setUint32(0, ptr, true);
							}
							return 0;
						case "journal_size_limit":
							if (value !== null) {
								const nPages = parseInt(value);
								file.writeAhead.options.journalSizeLimit = nPages;
							}
							break;
						case "locking_mode":
							switch (value?.toLowerCase()) {
								case "normal":
									file.lockingMode = "normal";
									break;
								case "exclusive":
									file.lockingMode = "exclusive";
									break;
							}
							break;
						case "page_size":
							if (value !== null) {
								const n = parseInt(value);
								if (n === 1 || n >= 512 && n <= 32768 && (n & n - 1) === 0) file.pageSize = n === 1 ? 65536 : n;
							}
							break;
						case "synchronous":
							if (value !== null) switch (value.toLowerCase()) {
								case "off":
								case "0":
									file.synchronous = 0;
									break;
								case "normal":
								case "1":
									file.synchronous = 1;
									break;
								case "full":
								case "2":
									file.synchronous = 2;
									break;
								case "extra":
								case "3":
									file.synchronous = 3;
									break;
								default: throw new Error(`unexpected synchronous value: ${value}`);
							}
							break;
						case "vfs_trace":
							if (value !== null) {
								this.log = parseInt(value) !== 0 ? console.debug : null;
								file.writeAhead.log = this.log;
							}
							return 0;
						case "wal_autocheckpoint":
							if (value !== null) file.writeAhead.options.autoCheckpoint = parseInt(value);
							break;
						case "wal_checkpoint":
							const checkpointMode = (value ?? "passive").toLowerCase();
							switch (checkpointMode) {
								case "passive":
									this._module.pendingOps.push(this.#pendingCheckpoint(file, checkpointMode));
									break;
								case "full":
								case "restart":
								case "truncate":
									if (file.writeAhead.isTransactionPending()) throw new Error("invalid while a transaction is in progress");
									this._module.pendingOps.push(this.#pendingCheckpoint(file, checkpointMode));
									break;
								case "noop": break;
								default: throw new Error(`unexpected wal_checkpoint mode: ${value}`);
							}
							{
								const s = file.writeAhead.getWriteAheadSize().toString();
								const ptr = this._module._sqlite3_malloc64(s.length + 1);
								this._module.stringToUTF8(s, ptr, s.length + 1);
								pArg.setUint32(0, ptr, true);
							}
							return 0;
						case "lazy_lock":
							if (value !== null) {
								const useLazyLock = value.toLowerCase();
								switch (useLazyLock) {
									case "read":
									case "write":
									case "readwrite":
									case "none":
										file.useLazyLock = useLazyLock;
										break;
									default: throw new Error(`unexpected value for lazy_lock: ${value}`);
								}
							}
							{
								const s = file.useLazyLock;
								const ptr = this._module._sqlite3_malloc64(s.length + 1);
								this._module.stringToUTF8(s, ptr, s.length + 1);
								pArg.setUint32(0, ptr, true);
							}
							return 0;
					}
					break;
				case 31:
				case 32:
					if (file.flags & 256) return 0;
					break;
				case 33:
					if (file.flags & 256) {
						file.writeAhead.rollback();
						return 0;
					}
					break;
				case 21:
					if (file.flags & 256) file.writeAhead.commit();
					break;
				case 11:
					file.overwrite = true;
					break;
			}
		} catch (e) {
			console.error(e.stack);
			this.lastError = e;
			return 10;
		}
		return 12;
	}
	/**
	* @param {number} pFile
	* @returns {number}
	*/
	jDeviceCharacteristics(pFile) {
		return SQLITE_IOCAP_UNDELETABLE_WHEN_OPEN | SQLITE_IOCAP_BATCH_ATOMIC;
	}
	/**
	* @param {Uint8Array} zBuf 
	* @returns {number}
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
	* @param {string} zName 
	* @returns {FileSystemSyncAccessHandle}
	*/
	#openTemporaryFile(zName) {
		if (this.unboundTempFiles.size === 0) throw new Error("no temporary files available");
		const accessHandle = this.unboundTempFiles.values().next().value;
		this.unboundTempFiles.delete(accessHandle);
		this.boundTempFiles.set(zName, accessHandle);
		return accessHandle;
	}
	/**
	* @param {FileEntry} file 
	*/
	#deleteTemporaryFile(file) {
		file.accessHandle.truncate(0);
		this.mapPathToFile.delete(file.zName);
		this.unboundTempFiles.add(file.accessHandle);
		this.boundTempFiles.delete(file.zName);
	}
	/**
	* @param {string} dbName 
	* @param {number} i 
	* @returns {string}
	*/
	#getWriteAheadNameFromDbName(dbName, i) {
		return `${dbName}-wa${i}`;
	}
	/**
	* Asynchronous PRAGMA operation to checkpoint the write-ahead log.
	* @param {FileEntry} file 
	* @param {'passive'|'full'|'restart'|'truncate'} mode 
	*/
	async #pendingCheckpoint(file, mode) {
		const onFinally = [];
		try {
			if (mode !== "passive" && file.lockState === 0) {
				await file.writeLock.acquire("exclusive");
				onFinally.push(() => file.writeLock.release());
				file.writeAhead.isolateForWrite();
				onFinally.push(() => file.writeAhead.rejoin());
			}
			await file.writeAhead.checkpoint({ isPassive: mode === "passive" });
		} catch (e) {
			if (e.name === "AbortError") e.code = 5;
			throw e;
		} finally {
			while (onFinally.length) onFinally.pop()();
		}
	}
	/**
	* @param {FileEntry} file 
	*/
	async #retryLockRead(file) {
		const onError = [];
		try {
			await file.readLock.acquire("shared", file.timeout);
			onError.push(() => file.readLock.release());
			file.writeAhead.isolateForRead();
			file.retryResult = {};
		} catch (e) {
			while (onError.length) onError.pop()();
			file.retryResult = e;
		}
	}
	/**
	* @param {FileEntry} file 
	*/
	async #retryLockWrite(file) {
		const onError = [];
		try {
			if (file.lockingMode === "exclusive") {
				await file.readLock.acquire("exclusive", file.timeout);
				onError.push(() => file.readLock.release());
			}
			await file.writeLock.acquire("exclusive", file.timeout);
			onError.push(() => file.writeLock.release());
			file.writeAhead.isolateForWrite();
			file.retryResult = {};
		} catch (e) {
			while (onError.length) onError.pop()();
			file.retryResult = e;
		}
	}
	/**
	* Handle asynchronous jOpen() tasks.
	* @param {string} zName 
	* @param {number} flags 
	* @param {number} fileId 
	* @param {DataView} pOutFlags 
	* @returns {Promise<void>}
	*/
	async #retryOpen(zName, flags, fileId, pOutFlags) {
		/** @type {(() => void)[]} */ const onError = [];
		const file = this.mapPathToFile.get(zName);
		try {
			await navigator.locks.request(`${zName}#ckpt`, async (lock) => {
				const directoryNames = zName.split("/").filter((d) => d);
				const dbName = directoryNames.pop();
				let dirHandle = await navigator.storage.getDirectory();
				const create = !!(flags & 4);
				for (const directoryName of directoryNames) dirHandle = await dirHandle.getDirectoryHandle(directoryName, { create });
				const isNewDatabase = create && await (async function() {
					try {
						await dirHandle.getFileHandle(dbName);
						return false;
					} catch (e) {
						if (e.name === "NotFoundError") return true;
						throw e;
					}
				})();
				async function openFile(filename, options) {
					const accessHandle = await (await dirHandle.getFileHandle(filename, options)).createSyncAccessHandle({ mode: "readwrite-unsafe" });
					onError.push(() => {
						accessHandle.close();
						if (isNewDatabase) dirHandle.removeEntry(filename);
					});
					return accessHandle;
				}
				const accessHandle = await openFile(dbName, { create });
				const waHandles = await Promise.all([0, 1].map(async (i) => {
					const waHandle = await openFile(this.#getWriteAheadNameFromDbName(dbName, i), { create: true });
					if (isNewDatabase) waHandle.truncate(0);
					return waHandle;
				}));
				const writeAhead = new WriteAhead(zName, accessHandle, waHandles);
				await writeAhead.ready();
				file.retryResult = {
					accessHandle,
					waHandles,
					writeAhead
				};
			});
		} catch (e) {
			while (onError.length) onError.pop()();
			file.retryResult = e;
		}
	}
};
//#endregion
export { OPFSWriteAheadVFS };

//# sourceMappingURL=OPFSWriteAheadVFS-Ewmr-w7P.js.map