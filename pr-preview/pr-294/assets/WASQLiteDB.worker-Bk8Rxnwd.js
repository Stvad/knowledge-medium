const SQLITE_IOERR_ACCESS = 3338;
const SQLITE_IOERR_CHECKRESERVEDLOCK = 3594;
const SQLITE_IOERR_CLOSE = 4106;
const SQLITE_IOERR_DELETE = 2570;
const SQLITE_IOERR_FSTAT = 1802;
const SQLITE_IOERR_FSYNC = 1034;
const SQLITE_IOERR_LOCK = 3850;
const SQLITE_IOERR_TRUNCATE = 1546;
const SQLITE_IOERR_UNLOCK = 2058;
const SQLITE_OPEN_TRANSIENT_DB = 1024;
const SQLITE_OPEN_MAIN_JOURNAL = 2048;
const SQLITE_OPEN_TEMP_JOURNAL = 4096;
const SQLITE_OPEN_SUBJOURNAL = 8192;
const SQLITE_OPEN_SUPER_JOURNAL = 16384;
const SQLITE_OPEN_WAL = 524288;
const SQLITE_IOCAP_UNDELETABLE_WHEN_OPEN = 2048;
const SQLITE_IOCAP_BATCH_ATOMIC = 16384;
//#endregion
//#region node_modules/@journeyapps/wa-sqlite/src/sqlite-api.js
/**
* Need to have a serializer for bigint
* https://github.com/GoogleChromeLabs/jsbi/issues/30
*/
if (typeof BigInt.prototype["toJSON"] == "undefined") BigInt.prototype["toJSON"] = function() {
	return this.toString();
};
const MAX_INT64 = 9223372036854775807n;
const MIN_INT64 = -9223372036854775808n;
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
var SQLiteError = class extends Error {
	constructor(message, code) {
		super(message);
		this.code = code;
	}
};
const async = true;
/**
* Builds a Javascript API from the Emscripten module. This API is still
* low-level and closely corresponds to the C API exported by the module,
* but differs in some specifics like throwing exceptions on errors.
* @param {*} Module SQLite Emscripten module
* @returns {SQLiteAPI}
*/
function Factory(Module) {
	/** @type {SQLiteAPI} */ const sqlite3 = {};
	Module.retryOps = [];
	Module.pendingOps = [];
	const sqliteFreeAddress = Module._getSqliteFree();
	const tmp = Module._malloc(8);
	const tmpPtr = [tmp, tmp + 4];
	const textEncoder = new TextEncoder();
	function createUTF8(s) {
		if (typeof s !== "string") return 0;
		const utf8 = textEncoder.encode(s);
		const zts = Module._sqlite3_malloc(utf8.byteLength + 1);
		Module.HEAPU8.set(utf8, zts);
		Module.HEAPU8[zts + utf8.byteLength] = 0;
		return zts;
	}
	/**
	* Concatenate 32-bit numbers into a 64-bit (signed) BigInt.
	* @param {number} lo32
	* @param {number} hi32
	* @returns {bigint}
	*/
	function cvt32x2ToBigInt(lo32, hi32) {
		return BigInt(hi32) << 32n | BigInt(lo32) & 4294967295n;
	}
	/**
	* Concatenate 32-bit numbers and return as number or BigInt, depending
	* on the value.
	* @param {number} lo32
	* @param {number} hi32
	* @returns {number|bigint}
	*/
	const cvt32x2AsSafe = (function() {
		const hiMax = BigInt(Number.MAX_SAFE_INTEGER) >> 32n;
		const hiMin = BigInt(Number.MIN_SAFE_INTEGER) >> 32n;
		return function(lo32, hi32) {
			if (hi32 > hiMax || hi32 < hiMin) return cvt32x2ToBigInt(lo32, hi32);
			else return hi32 * 4294967296 + (lo32 & 2147483647) - (lo32 & 2147483648);
		};
	})();
	const databases = /* @__PURE__ */ new Set();
	function verifyDatabase(db) {
		if (!databases.has(db)) throw new SQLiteError("not a database", 21);
	}
	const mapStmtToDB = /* @__PURE__ */ new Map();
	function verifyStatement(stmt) {
		if (!mapStmtToDB.has(stmt)) throw new SQLiteError("not a statement", 21);
	}
	sqlite3.bind_collection = function(stmt, bindings) {
		verifyStatement(stmt);
		const isArray = Array.isArray(bindings);
		const nBindings = sqlite3.bind_parameter_count(stmt);
		for (let i = 1; i <= nBindings; ++i) {
			const value = bindings[isArray ? i - 1 : sqlite3.bind_parameter_name(stmt, i)];
			if (value !== void 0) sqlite3.bind(stmt, i, value);
		}
		return 0;
	};
	sqlite3.bind = function(stmt, i, value) {
		verifyStatement(stmt);
		switch (typeof value) {
			case "number": if (value === (value | 0)) return sqlite3.bind_int(stmt, i, value);
			else return sqlite3.bind_double(stmt, i, value);
			case "string": return sqlite3.bind_text(stmt, i, value);
			case "boolean": return sqlite3.bind_int(stmt, i, value ? 1 : 0);
			default: if (value instanceof Uint8Array || Array.isArray(value)) return sqlite3.bind_blob(stmt, i, value);
			else if (value === null) return sqlite3.bind_null(stmt, i);
			else if (typeof value === "bigint") return sqlite3.bind_int64(stmt, i, value);
			else if (value === void 0) return 27;
			else {
				console.warn("unknown binding converted to null", value);
				return sqlite3.bind_null(stmt, i);
			}
		}
	};
	sqlite3.bind_blob = (function() {
		const fname = "sqlite3_bind_blob";
		const f = Module.cwrap(fname, ...decl("nnnnn:n"));
		return function(stmt, i, value) {
			verifyStatement(stmt);
			const byteLength = value.byteLength ?? value.length;
			const ptr = Module._sqlite3_malloc(byteLength);
			Module.HEAPU8.subarray(ptr).set(value);
			return check(fname, f(stmt, i, ptr, byteLength, sqliteFreeAddress), mapStmtToDB.get(stmt));
		};
	})();
	sqlite3.bind_parameter_count = (function() {
		const f = Module.cwrap("sqlite3_bind_parameter_count", ...decl("n:n"));
		return function(stmt) {
			verifyStatement(stmt);
			return f(stmt);
		};
	})();
	sqlite3.bind_double = (function() {
		const fname = "sqlite3_bind_double";
		const f = Module.cwrap(fname, ...decl("nnn:n"));
		return function(stmt, i, value) {
			verifyStatement(stmt);
			return check(fname, f(stmt, i, value), mapStmtToDB.get(stmt));
		};
	})();
	sqlite3.bind_int = (function() {
		const fname = "sqlite3_bind_int";
		const f = Module.cwrap(fname, ...decl("nnn:n"));
		return function(stmt, i, value) {
			verifyStatement(stmt);
			if (value > 2147483647 || value < -2147483648) return 25;
			return check(fname, f(stmt, i, value), mapStmtToDB.get(stmt));
		};
	})();
	sqlite3.bind_int64 = (function() {
		const fname = "sqlite3_bind_int64";
		const f = Module.cwrap(fname, ...decl("nnnn:n"));
		return function(stmt, i, value) {
			verifyStatement(stmt);
			if (value > MAX_INT64 || value < MIN_INT64) return 25;
			const lo32 = value & 4294967295n;
			const hi32 = value >> 32n;
			return check(fname, f(stmt, i, Number(lo32), Number(hi32)), mapStmtToDB.get(stmt));
		};
	})();
	sqlite3.bind_null = (function() {
		const fname = "sqlite3_bind_null";
		const f = Module.cwrap(fname, ...decl("nn:n"));
		return function(stmt, i) {
			verifyStatement(stmt);
			return check(fname, f(stmt, i), mapStmtToDB.get(stmt));
		};
	})();
	sqlite3.bind_parameter_name = (function() {
		const f = Module.cwrap("sqlite3_bind_parameter_name", ...decl("n:s"));
		return function(stmt, i) {
			verifyStatement(stmt);
			return f(stmt, i);
		};
	})();
	sqlite3.bind_text = (function() {
		const fname = "sqlite3_bind_text";
		const f = Module.cwrap(fname, ...decl("nnnnn:n"));
		return function(stmt, i, value) {
			verifyStatement(stmt);
			return check(fname, f(stmt, i, createUTF8(value), -1, sqliteFreeAddress), mapStmtToDB.get(stmt));
		};
	})();
	sqlite3.changes = (function() {
		const f = Module.cwrap("sqlite3_changes", ...decl("n:n"));
		return function(db) {
			verifyDatabase(db);
			return f(db);
		};
	})();
	sqlite3.clear_bindings = (function() {
		const fname = "sqlite3_clear_bindings";
		const f = Module.cwrap(fname, ...decl("n:n"));
		return function(stmt) {
			verifyStatement(stmt);
			return check(fname, f(stmt), mapStmtToDB.get(stmt));
		};
	})();
	sqlite3.last_insert_id = (function() {
		const f = Module.cwrap("sqlite3_last_insert_rowid", ...decl("n:n"));
		return function(db) {
			verifyDatabase(db);
			return f(db);
		};
	})();
	sqlite3.close = (function() {
		const fname = "sqlite3_close";
		const f = Module.cwrap(fname, ...decl("n:n"), { async });
		return async function(db) {
			verifyDatabase(db);
			const result = await f(db);
			databases.delete(db);
			return check(fname, result, db);
		};
	})();
	sqlite3.column = function(stmt, iCol) {
		verifyStatement(stmt);
		const type = sqlite3.column_type(stmt, iCol);
		switch (type) {
			case 4: return sqlite3.column_blob(stmt, iCol);
			case 2: return sqlite3.column_double(stmt, iCol);
			case 1: return cvt32x2AsSafe(sqlite3.column_int(stmt, iCol), Module.getTempRet0());
			case 5: return null;
			case 3: return sqlite3.column_text(stmt, iCol);
			default: throw new SQLiteError("unknown type", type);
		}
	};
	sqlite3.column_blob = (function() {
		const f = Module.cwrap("sqlite3_column_blob", ...decl("nn:n"));
		return function(stmt, iCol) {
			verifyStatement(stmt);
			const nBytes = sqlite3.column_bytes(stmt, iCol);
			const address = f(stmt, iCol);
			return Module.HEAPU8.subarray(address, address + nBytes);
		};
	})();
	sqlite3.column_bytes = (function() {
		const f = Module.cwrap("sqlite3_column_bytes", ...decl("nn:n"));
		return function(stmt, iCol) {
			verifyStatement(stmt);
			return f(stmt, iCol);
		};
	})();
	sqlite3.column_count = (function() {
		const f = Module.cwrap("sqlite3_column_count", ...decl("n:n"));
		return function(stmt) {
			verifyStatement(stmt);
			return f(stmt);
		};
	})();
	sqlite3.column_double = (function() {
		const f = Module.cwrap("sqlite3_column_double", ...decl("nn:n"));
		return function(stmt, iCol) {
			verifyStatement(stmt);
			return f(stmt, iCol);
		};
	})();
	sqlite3.column_int = (function() {
		const f = Module.cwrap("sqlite3_column_int64", ...decl("nn:n"));
		return function(stmt, iCol) {
			verifyStatement(stmt);
			return f(stmt, iCol);
		};
	})();
	sqlite3.column_int64 = (function() {
		const f = Module.cwrap("sqlite3_column_int64", ...decl("nn:n"));
		return function(stmt, iCol) {
			verifyStatement(stmt);
			return cvt32x2ToBigInt(f(stmt, iCol), Module.getTempRet0());
		};
	})();
	sqlite3.column_name = (function() {
		const f = Module.cwrap("sqlite3_column_name", ...decl("nn:s"));
		return function(stmt, iCol) {
			verifyStatement(stmt);
			return f(stmt, iCol);
		};
	})();
	sqlite3.column_names = function(stmt) {
		const columns = [];
		const nColumns = sqlite3.column_count(stmt);
		for (let i = 0; i < nColumns; ++i) columns.push(sqlite3.column_name(stmt, i));
		return columns;
	};
	sqlite3.column_text = (function() {
		const f = Module.cwrap("sqlite3_column_text", ...decl("nn:s"));
		return function(stmt, iCol) {
			verifyStatement(stmt);
			return f(stmt, iCol);
		};
	})();
	sqlite3.column_type = (function() {
		const f = Module.cwrap("sqlite3_column_type", ...decl("nn:n"));
		return function(stmt, iCol) {
			verifyStatement(stmt);
			return f(stmt, iCol);
		};
	})();
	sqlite3.create_function = function(db, zFunctionName, nArg, eTextRep, pApp, xFunc, xStep, xFinal) {
		verifyDatabase(db);
		function adapt(f) {
			return f instanceof AsyncFunction ? (async (ctx, n, values) => f(ctx, Module.HEAP32.subarray(values / 4, values / 4 + n))) : ((ctx, n, values) => f(ctx, Module.HEAP32.subarray(values / 4, values / 4 + n)));
		}
		return check("sqlite3_create_function", Module.create_function(db, zFunctionName, nArg, eTextRep, pApp, xFunc && adapt(xFunc), xStep && adapt(xStep), xFinal), db);
	};
	sqlite3.data_count = (function() {
		const f = Module.cwrap("sqlite3_data_count", ...decl("n:n"));
		return function(stmt) {
			verifyStatement(stmt);
			return f(stmt);
		};
	})();
	sqlite3.exec = async function(db, sql, callback) {
		for await (const stmt of sqlite3.statements(db, sql)) {
			let columns;
			while (await sqlite3.step(stmt) === 100) if (callback) {
				columns = columns ?? sqlite3.column_names(stmt);
				await callback(sqlite3.row(stmt), columns);
			}
		}
		return 0;
	};
	sqlite3.finalize = (function() {
		const f = Module.cwrap("sqlite3_finalize", ...decl("n:n"), { async });
		return async function(stmt) {
			const result = await f(stmt);
			mapStmtToDB.delete(stmt);
			return result;
		};
	})();
	sqlite3.get_autocommit = (function() {
		const f = Module.cwrap("sqlite3_get_autocommit", ...decl("n:n"));
		return function(db) {
			return f(db);
		};
	})();
	sqlite3.libversion = (function() {
		const f = Module.cwrap("sqlite3_libversion", ...decl(":s"));
		return function() {
			return f();
		};
	})();
	sqlite3.libversion_number = (function() {
		const f = Module.cwrap("sqlite3_libversion_number", ...decl(":n"));
		return function() {
			return f();
		};
	})();
	sqlite3.limit = (function() {
		const f = Module.cwrap("sqlite3_limit", ...decl("nnn:n"));
		return function(db, id, newVal) {
			return f(db, id, newVal);
		};
	})();
	sqlite3.open_v2 = (function() {
		const fname = "sqlite3_open_v2";
		const f = Module.cwrap(fname, ...decl("snnn:n"), { async });
		return async function(zFilename, flags, zVfs) {
			flags = flags || 6;
			zVfs = createUTF8(zVfs);
			try {
				const rc = await retry(() => f(zFilename, tmpPtr[0], flags, zVfs));
				const db = Module.getValue(tmpPtr[0], "*");
				databases.add(db);
				Module.ccall("RegisterExtensionFunctions", "number", ["number"], [db]);
				check(fname, rc);
				return db;
			} finally {
				Module._sqlite3_free(zVfs);
			}
		};
	})();
	sqlite3.progress_handler = function(db, nProgressOps, handler, userData) {
		verifyDatabase(db);
		Module.progress_handler(db, nProgressOps, handler, userData);
	};
	sqlite3.reset = (function() {
		const fname = "sqlite3_reset";
		const f = Module.cwrap(fname, ...decl("n:n"), { async });
		return async function(stmt) {
			verifyStatement(stmt);
			return check(fname, await f(stmt), mapStmtToDB.get(stmt));
		};
	})();
	sqlite3.result = function(context, value) {
		switch (typeof value) {
			case "number":
				if (value === (value | 0)) sqlite3.result_int(context, value);
				else sqlite3.result_double(context, value);
				break;
			case "string":
				sqlite3.result_text(context, value);
				break;
			default:
				if (value instanceof Uint8Array || Array.isArray(value)) sqlite3.result_blob(context, value);
				else if (value === null) sqlite3.result_null(context);
				else if (typeof value === "bigint") return sqlite3.result_int64(context, value);
				else {
					console.warn("unknown result converted to null", value);
					sqlite3.result_null(context);
				}
				break;
		}
	};
	sqlite3.result_blob = (function() {
		const f = Module.cwrap("sqlite3_result_blob", ...decl("nnnn:n"));
		return function(context, value) {
			const byteLength = value.byteLength ?? value.length;
			const ptr = Module._sqlite3_malloc(byteLength);
			Module.HEAPU8.subarray(ptr).set(value);
			f(context, ptr, byteLength, sqliteFreeAddress);
		};
	})();
	sqlite3.result_double = (function() {
		const f = Module.cwrap("sqlite3_result_double", ...decl("nn:n"));
		return function(context, value) {
			f(context, value);
		};
	})();
	sqlite3.result_int = (function() {
		const f = Module.cwrap("sqlite3_result_int", ...decl("nn:n"));
		return function(context, value) {
			f(context, value);
		};
	})();
	sqlite3.result_int64 = (function() {
		const f = Module.cwrap("sqlite3_result_int64", ...decl("nnn:n"));
		return function(context, value) {
			if (value > MAX_INT64 || value < MIN_INT64) return 25;
			const lo32 = value & 4294967295n;
			const hi32 = value >> 32n;
			f(context, Number(lo32), Number(hi32));
		};
	})();
	sqlite3.result_null = (function() {
		const f = Module.cwrap("sqlite3_result_null", ...decl("n:n"));
		return function(context) {
			f(context);
		};
	})();
	sqlite3.result_text = (function() {
		const f = Module.cwrap("sqlite3_result_text", ...decl("nnnn:n"));
		return function(context, value) {
			f(context, createUTF8(value), -1, sqliteFreeAddress);
		};
	})();
	sqlite3.row = function(stmt) {
		const row = [];
		const nColumns = sqlite3.data_count(stmt);
		for (let i = 0; i < nColumns; ++i) {
			const value = sqlite3.column(stmt, i);
			row.push(value?.buffer === Module.HEAPU8.buffer ? value.slice() : value);
		}
		return row;
	};
	sqlite3.set_authorizer = function(db, xAuth, pApp) {
		verifyDatabase(db);
		function cvtArgs(_, iAction, p3, p4, p5, p6) {
			return [
				_,
				iAction,
				Module.UTF8ToString(p3),
				Module.UTF8ToString(p4),
				Module.UTF8ToString(p5),
				Module.UTF8ToString(p6)
			];
		}
		function adapt(f) {
			return f instanceof AsyncFunction ? (async (_, iAction, p3, p4, p5, p6) => f(...cvtArgs(_, iAction, p3, p4, p5, p6))) : ((_, iAction, p3, p4, p5, p6) => f(...cvtArgs(_, iAction, p3, p4, p5, p6)));
		}
		return check("sqlite3_set_authorizer", Module.set_authorizer(db, adapt(xAuth), pApp), db);
	};
	sqlite3.sql = (function() {
		const f = Module.cwrap("sqlite3_sql", ...decl("n:s"));
		return function(stmt) {
			verifyStatement(stmt);
			return f(stmt);
		};
	})();
	sqlite3.statements = function(db, sql, options = {}) {
		const prepare = Module.cwrap("sqlite3_prepare_v3", "number", [
			"number",
			"number",
			"number",
			"number",
			"number",
			"number"
		], { async: true });
		return (async function* () {
			const onFinally = [];
			try {
				const utf8 = textEncoder.encode(sql);
				const allocSize = utf8.byteLength - utf8.byteLength % 4 + 12;
				const pzHead = Module._sqlite3_malloc(allocSize);
				const pzEnd = pzHead + utf8.byteLength + 1;
				onFinally.push(() => Module._sqlite3_free(pzHead));
				Module.HEAPU8.set(utf8, pzHead);
				Module.HEAPU8[pzEnd - 1] = 0;
				const pStmt = pzHead + allocSize - 8;
				const pzTail = pzHead + allocSize - 4;
				let stmt;
				function maybeFinalize() {
					if (stmt && !options.unscoped) sqlite3.finalize(stmt);
					stmt = 0;
				}
				onFinally.push(maybeFinalize);
				Module.setValue(pzTail, pzHead, "*");
				do {
					maybeFinalize();
					const zTail = Module.getValue(pzTail, "*");
					const rc = await retry(() => {
						return prepare(db, zTail, pzEnd - pzTail, options.flags || 0, pStmt, pzTail);
					});
					if (rc !== 0) check("sqlite3_prepare_v3", rc, db);
					stmt = Module.getValue(pStmt, "*");
					if (stmt) {
						mapStmtToDB.set(stmt, db);
						yield stmt;
					}
				} while (stmt);
			} finally {
				while (onFinally.length) onFinally.pop()();
			}
		})();
	};
	sqlite3.step = (function() {
		const fname = "sqlite3_step";
		const f = Module.cwrap(fname, ...decl("n:n"), { async });
		return async function(stmt) {
			verifyStatement(stmt);
			return check(fname, await retry(() => f(stmt)), mapStmtToDB.get(stmt), [100, 101]);
		};
	})();
	sqlite3.commit_hook = function(db, xCommitHook) {
		verifyDatabase(db);
		Module.commit_hook(db, xCommitHook);
	};
	sqlite3.update_hook = function(db, xUpdateHook) {
		verifyDatabase(db);
		function cvtArgs(iUpdateType, dbName, tblName, lo32, hi32) {
			return [
				iUpdateType,
				Module.UTF8ToString(dbName),
				Module.UTF8ToString(tblName),
				cvt32x2ToBigInt(lo32, hi32)
			];
		}
		function adapt(f) {
			return f instanceof AsyncFunction ? (async (iUpdateType, dbName, tblName, lo32, hi32) => f(...cvtArgs(iUpdateType, dbName, tblName, lo32, hi32))) : ((iUpdateType, dbName, tblName, lo32, hi32) => f(...cvtArgs(iUpdateType, dbName, tblName, lo32, hi32)));
		}
		Module.update_hook(db, adapt(xUpdateHook));
	};
	sqlite3.value = function(pValue) {
		const type = sqlite3.value_type(pValue);
		switch (type) {
			case 4: return sqlite3.value_blob(pValue);
			case 2: return sqlite3.value_double(pValue);
			case 1: return cvt32x2AsSafe(sqlite3.value_int(pValue), Module.getTempRet0());
			case 5: return null;
			case 3: return sqlite3.value_text(pValue);
			default: throw new SQLiteError("unknown type", type);
		}
	};
	sqlite3.value_blob = (function() {
		const f = Module.cwrap("sqlite3_value_blob", ...decl("n:n"));
		return function(pValue) {
			const nBytes = sqlite3.value_bytes(pValue);
			const address = f(pValue);
			return Module.HEAPU8.subarray(address, address + nBytes);
		};
	})();
	sqlite3.value_bytes = (function() {
		const f = Module.cwrap("sqlite3_value_bytes", ...decl("n:n"));
		return function(pValue) {
			return f(pValue);
		};
	})();
	sqlite3.value_double = (function() {
		const f = Module.cwrap("sqlite3_value_double", ...decl("n:n"));
		return function(pValue) {
			return f(pValue);
		};
	})();
	sqlite3.value_int = (function() {
		const f = Module.cwrap("sqlite3_value_int64", ...decl("n:n"));
		return function(pValue) {
			return f(pValue);
		};
	})();
	sqlite3.value_int64 = (function() {
		const f = Module.cwrap("sqlite3_value_int64", ...decl("n:n"));
		return function(pValue) {
			return cvt32x2ToBigInt(f(pValue), Module.getTempRet0());
		};
	})();
	sqlite3.value_text = (function() {
		const f = Module.cwrap("sqlite3_value_text", ...decl("n:s"));
		return function(pValue) {
			return f(pValue);
		};
	})();
	sqlite3.value_type = (function() {
		const f = Module.cwrap("sqlite3_value_type", ...decl("n:n"));
		return function(pValue) {
			return f(pValue);
		};
	})();
	sqlite3.vfs_register = function(vfs, makeDefault) {
		return check("sqlite3_vfs_register", Module.vfs_register(vfs, makeDefault));
	};
	function check(fname, result, db = null, allowed = [0]) {
		if (allowed.includes(result)) return result;
		throw new SQLiteError(db ? Module.ccall("sqlite3_errmsg", "string", ["number"], [db]) : fname, result);
	}
	async function retry(f) {
		let rc;
		for (let retryCount = 0; retryCount < 2; ++retryCount) {
			if (Module.retryOps.length) try {
				await Promise.all(Module.retryOps);
			} finally {
				Module.retryOps = [];
			}
			rc = await f();
			if (rc === 0 || Module.retryOps.length === 0) {
				if (Module.pendingOps.length) try {
					await Promise.all(Module.pendingOps);
				} catch (e) {
					console.error("Error in pendingOps:", e);
					return e.code || 1;
				} finally {
					Module.pendingOps = [];
				}
				return rc;
			}
		}
		return rc;
	}
	return sqlite3;
}
function decl(s) {
	const result = [];
	const m = s.match(/([ns@]*):([nsv@])/);
	switch (m[2]) {
		case "n":
			result.push("number");
			break;
		case "s":
			result.push("string");
			break;
		case "v":
			result.push(null);
			break;
	}
	const args = [];
	for (let c of m[1]) switch (c) {
		case "n":
			args.push("number");
			break;
		case "s":
			args.push("string");
			break;
	}
	result.push(args);
	return result;
}
//#endregion
//#region node_modules/@powersync/common/dist/bundle.mjs
/**
* @see https://www.sqlite.org/lang_expr.html#castexpr
* @public
*/
var ColumnType;
(function(ColumnType) {
	ColumnType["TEXT"] = "TEXT";
	ColumnType["INTEGER"] = "INTEGER";
	ColumnType["REAL"] = "REAL";
})(ColumnType || (ColumnType = {}));
ColumnType.TEXT;
ColumnType.INTEGER;
ColumnType.REAL;
/**
* AttachmentState represents the current synchronization state of an attachment.
*
* @alpha
*/
var AttachmentState;
(function(AttachmentState) {
	AttachmentState[AttachmentState["QUEUED_UPLOAD"] = 0] = "QUEUED_UPLOAD";
	AttachmentState[AttachmentState["QUEUED_DOWNLOAD"] = 1] = "QUEUED_DOWNLOAD";
	AttachmentState[AttachmentState["QUEUED_DELETE"] = 2] = "QUEUED_DELETE";
	AttachmentState[AttachmentState["SYNCED"] = 3] = "SYNCED";
	AttachmentState[AttachmentState["ARCHIVED"] = 4] = "ARCHIVED";
})(AttachmentState || (AttachmentState = {}));
/**
* @public
*/
var WatchedQueryListenerEvent;
(function(WatchedQueryListenerEvent) {
	WatchedQueryListenerEvent["ON_DATA"] = "onData";
	WatchedQueryListenerEvent["ON_ERROR"] = "onError";
	WatchedQueryListenerEvent["ON_STATE_CHANGE"] = "onStateChange";
	WatchedQueryListenerEvent["SETTINGS_WILL_UPDATE"] = "settingsWillUpdate";
	WatchedQueryListenerEvent["CLOSED"] = "closed";
})(WatchedQueryListenerEvent || (WatchedQueryListenerEvent = {}));
/**
* A simple fixed-capacity queue implementation.
*
* Unlike a naive queue implemented by `array.push()` and `array.shift()`, this avoids moving array elements around
* and is `O(1)` for {@link addLast} and {@link removeFirst}.
*/
var Queue = class {
	table;
	head;
	_length;
	constructor(initialItems) {
		this.table = [...initialItems];
		this.head = 0;
		this._length = this.table.length;
	}
	get isEmpty() {
		return this.length == 0;
	}
	get length() {
		return this._length;
	}
	removeFirst() {
		if (this.isEmpty) throw new Error("Queue is empty");
		const result = this.table[this.head];
		this._length--;
		this.table[this.head] = void 0;
		this.head = (this.head + 1) % this.table.length;
		return result;
	}
	addLast(element) {
		if (this.length == this.table.length) throw new Error("Queue is full");
		this.table[(this.head + this._length) % this.table.length] = element;
		this._length++;
	}
};
/**
* An asynchronous semaphore implementation with associated items per lease.
*
* @internal This class is meant to be used in PowerSync SDKs only, and is not part of the public API.
*/
var Semaphore = class {
	available;
	size;
	firstWaiter;
	lastWaiter;
	constructor(elements) {
		this.available = new Queue(elements);
		this.size = this.available.length;
	}
	addWaiter(requestedItems, onAcquire) {
		const node = {
			isActive: true,
			acquiredItems: [],
			remainingItems: requestedItems,
			onAcquire,
			prev: this.lastWaiter
		};
		if (this.lastWaiter) {
			this.lastWaiter.next = node;
			this.lastWaiter = node;
		} else this.lastWaiter = this.firstWaiter = node;
		return node;
	}
	deactivateWaiter(waiter) {
		const { prev, next } = waiter;
		waiter.isActive = false;
		if (prev) prev.next = next;
		if (next) next.prev = prev;
		if (waiter == this.firstWaiter) this.firstWaiter = next;
		if (waiter == this.lastWaiter) this.lastWaiter = prev;
	}
	requestPermits(amount, abort) {
		if (amount <= 0 || amount > this.size) throw new Error(`Invalid amount of items requested (${amount}), must be between 1 and ${this.size}`);
		return new Promise((resolve, reject) => {
			function rejectAborted() {
				reject(abort?.reason ?? /* @__PURE__ */ new Error("Semaphore acquire aborted"));
			}
			if (abort?.aborted) return rejectAborted();
			let waiter;
			const markCompleted = () => {
				const items = waiter.acquiredItems;
				waiter.acquiredItems = [];
				for (const element of items) {
					const nextWaiter = this.firstWaiter;
					if (nextWaiter) {
						nextWaiter.acquiredItems.push(element);
						nextWaiter.remainingItems--;
						if (nextWaiter.remainingItems == 0) nextWaiter.onAcquire();
					} else this.available.addLast(element);
				}
			};
			const onAbort = () => {
				abort?.removeEventListener("abort", onAbort);
				if (waiter.isActive) {
					this.deactivateWaiter(waiter);
					rejectAborted();
				}
			};
			const resolvePromise = () => {
				this.deactivateWaiter(waiter);
				abort?.removeEventListener("abort", onAbort);
				const items = waiter.acquiredItems;
				resolve({
					items,
					release: markCompleted
				});
			};
			waiter = this.addWaiter(amount, resolvePromise);
			while (!this.available.isEmpty && waiter.remainingItems > 0) {
				waiter.acquiredItems.push(this.available.removeFirst());
				waiter.remainingItems--;
			}
			if (waiter.remainingItems == 0) return resolvePromise();
			abort?.addEventListener("abort", onAbort);
		});
	}
	/**
	* Requests a single item from the pool.
	*
	* The returned `release` callback must be invoked to return the item into the pool.
	*/
	async requestOne(abort) {
		const { items, release } = await this.requestPermits(1, abort);
		return {
			release,
			item: items[0]
		};
	}
	/**
	* Requests access to all items from the pool.
	*
	* The returned `release` callback must be invoked to return items into the pool.
	*/
	requestAll(abort) {
		return this.requestPermits(this.size, abort);
	}
};
/**
* An asynchronous mutex implementation.
*
* @internal This class is meant to be used in PowerSync SDKs only, and is not part of the public API.
*/
var Mutex = class {
	inner = new Semaphore([null]);
	async acquire(abort) {
		const { release } = await this.inner.requestOne(abort);
		return release;
	}
	async runExclusive(fn, abort) {
		const returnMutex = await this.acquire(abort);
		try {
			return await fn();
		} finally {
			returnMutex();
		}
	}
};
/**
* @alpha
*/
var EncodingType;
(function(EncodingType) {
	EncodingType["UTF8"] = "utf8";
	EncodingType["Base64"] = "base64";
})(EncodingType || (EncodingType = {}));
function getDefaultExportFromCjs(x) {
	return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, "default") ? x["default"] : x;
}
var logger$1 = { exports: {} };
/*!
* js-logger - http://github.com/jonnyreeves/js-logger
* Jonny Reeves, http://jonnyreeves.co.uk/
* js-logger may be freely distributed under the MIT license.
*/
var logger = logger$1.exports;
var hasRequiredLogger;
function requireLogger() {
	if (hasRequiredLogger) return logger$1.exports;
	hasRequiredLogger = 1;
	(function(module) {
		(function(global) {
			var Logger = {};
			Logger.VERSION = "1.6.1";
			var logHandler;
			var contextualLoggersByNameMap = {};
			var bind = function(scope, func) {
				return function() {
					return func.apply(scope, arguments);
				};
			};
			var merge = function() {
				var args = arguments, target = args[0], key, i;
				for (i = 1; i < args.length; i++) for (key in args[i]) if (!(key in target) && args[i].hasOwnProperty(key)) target[key] = args[i][key];
				return target;
			};
			var defineLogLevel = function(value, name) {
				return {
					value,
					name
				};
			};
			Logger.TRACE = defineLogLevel(1, "TRACE");
			Logger.DEBUG = defineLogLevel(2, "DEBUG");
			Logger.INFO = defineLogLevel(3, "INFO");
			Logger.TIME = defineLogLevel(4, "TIME");
			Logger.WARN = defineLogLevel(5, "WARN");
			Logger.ERROR = defineLogLevel(8, "ERROR");
			Logger.OFF = defineLogLevel(99, "OFF");
			var ContextualLogger = function(defaultContext) {
				this.context = defaultContext;
				this.setLevel(defaultContext.filterLevel);
				this.log = this.info;
			};
			ContextualLogger.prototype = {
				setLevel: function(newLevel) {
					if (newLevel && "value" in newLevel) this.context.filterLevel = newLevel;
				},
				getLevel: function() {
					return this.context.filterLevel;
				},
				enabledFor: function(lvl) {
					var filterLevel = this.context.filterLevel;
					return lvl.value >= filterLevel.value;
				},
				trace: function() {
					this.invoke(Logger.TRACE, arguments);
				},
				debug: function() {
					this.invoke(Logger.DEBUG, arguments);
				},
				info: function() {
					this.invoke(Logger.INFO, arguments);
				},
				warn: function() {
					this.invoke(Logger.WARN, arguments);
				},
				error: function() {
					this.invoke(Logger.ERROR, arguments);
				},
				time: function(label) {
					if (typeof label === "string" && label.length > 0) this.invoke(Logger.TIME, [label, "start"]);
				},
				timeEnd: function(label) {
					if (typeof label === "string" && label.length > 0) this.invoke(Logger.TIME, [label, "end"]);
				},
				invoke: function(level, msgArgs) {
					if (logHandler && this.enabledFor(level)) logHandler(msgArgs, merge({ level }, this.context));
				}
			};
			var globalLogger = new ContextualLogger({ filterLevel: Logger.OFF });
			(function() {
				var L = Logger;
				L.enabledFor = bind(globalLogger, globalLogger.enabledFor);
				L.trace = bind(globalLogger, globalLogger.trace);
				L.debug = bind(globalLogger, globalLogger.debug);
				L.time = bind(globalLogger, globalLogger.time);
				L.timeEnd = bind(globalLogger, globalLogger.timeEnd);
				L.info = bind(globalLogger, globalLogger.info);
				L.warn = bind(globalLogger, globalLogger.warn);
				L.error = bind(globalLogger, globalLogger.error);
				L.log = L.info;
			})();
			Logger.setHandler = function(func) {
				logHandler = func;
			};
			Logger.setLevel = function(level) {
				globalLogger.setLevel(level);
				for (var key in contextualLoggersByNameMap) if (contextualLoggersByNameMap.hasOwnProperty(key)) contextualLoggersByNameMap[key].setLevel(level);
			};
			Logger.getLevel = function() {
				return globalLogger.getLevel();
			};
			Logger.get = function(name) {
				return contextualLoggersByNameMap[name] || (contextualLoggersByNameMap[name] = new ContextualLogger(merge({ name }, globalLogger.context)));
			};
			Logger.createDefaultHandler = function(options) {
				options = options || {};
				options.formatter = options.formatter || function defaultMessageFormatter(messages, context) {
					if (context.name) messages.unshift("[" + context.name + "]");
				};
				var timerStartTimeByLabelMap = {};
				var invokeConsoleMethod = function(hdlr, messages) {
					Function.prototype.apply.call(hdlr, console, messages);
				};
				if (typeof console === "undefined") return function() {};
				return function(messages, context) {
					messages = Array.prototype.slice.call(messages);
					var hdlr = console.log;
					var timerLabel;
					if (context.level === Logger.TIME) {
						timerLabel = (context.name ? "[" + context.name + "] " : "") + messages[0];
						if (messages[1] === "start") if (console.time) console.time(timerLabel);
						else timerStartTimeByLabelMap[timerLabel] = (/* @__PURE__ */ new Date()).getTime();
						else if (console.timeEnd) console.timeEnd(timerLabel);
						else invokeConsoleMethod(hdlr, [timerLabel + ": " + ((/* @__PURE__ */ new Date()).getTime() - timerStartTimeByLabelMap[timerLabel]) + "ms"]);
					} else {
						if (context.level === Logger.WARN && console.warn) hdlr = console.warn;
						else if (context.level === Logger.ERROR && console.error) hdlr = console.error;
						else if (context.level === Logger.INFO && console.info) hdlr = console.info;
						else if (context.level === Logger.DEBUG && console.debug) hdlr = console.debug;
						else if (context.level === Logger.TRACE && console.trace) hdlr = console.trace;
						options.formatter(messages, context);
						invokeConsoleMethod(hdlr, messages);
					}
				};
			};
			Logger.useDefaults = function(options) {
				Logger.setLevel(options && options.defaultLevel || Logger.DEBUG);
				Logger.setHandler(Logger.createDefaultHandler(options));
			};
			Logger.setDefaults = Logger.useDefaults;
			if (module.exports) module.exports = Logger;
			else {
				Logger._prevLogger = global.Logger;
				Logger.noConflict = function() {
					global.Logger = Logger._prevLogger;
					return Logger;
				};
				global.Logger = Logger;
			}
		})(logger);
	})(logger$1);
	return logger$1.exports;
}
var Logger = /* @__PURE__ */ getDefaultExportFromCjs(requireLogger());
/**
* Set of generic interfaces to allow PowerSync compatibility with
* different SQLite DB implementations.
*/
/**
* Implements {@link DBGetUtils} on a {@link SqlExecutor}.
*
* @internal
*/
function DBGetUtilsDefaultMixin(Base) {
	return class extends Base {
		async getAll(sql, parameters) {
			return (await this.execute(sql, parameters)).rows?._array ?? [];
		}
		async getOptional(sql, parameters) {
			return (await this.execute(sql, parameters)).rows?.item(0) ?? null;
		}
		async get(sql, parameters) {
			const first = (await this.execute(sql, parameters)).rows?.item(0);
			if (!first) throw new Error("Result set is empty");
			return first;
		}
		async executeBatch(query, params = []) {
			if (super.executeBatch) return super.executeBatch(query, params);
			let lastInsertId;
			let rowsAffected = 0;
			for (const set of params) {
				const result = await this.execute(query, set);
				lastInsertId = result.insertId;
				rowsAffected += result.rowsAffected;
			}
			return {
				rowsAffected,
				insertId: lastInsertId
			};
		}
	};
}
/**
* Update table operation numbers from SQLite
*
* @public
*/
var RowUpdateType;
(function(RowUpdateType) {
	RowUpdateType[RowUpdateType["SQLITE_INSERT"] = 18] = "SQLITE_INSERT";
	RowUpdateType[RowUpdateType["SQLITE_DELETE"] = 9] = "SQLITE_DELETE";
	RowUpdateType[RowUpdateType["SQLITE_UPDATE"] = 23] = "SQLITE_UPDATE";
})(RowUpdateType || (RowUpdateType = {}));
var BaseTransaction = class {
	inner;
	finalized = false;
	constructor(inner) {
		this.inner = inner;
	}
	async commit() {
		if (this.finalized) return { rowsAffected: 0 };
		this.finalized = true;
		return this.inner.execute("COMMIT");
	}
	async rollback() {
		if (this.finalized) return { rowsAffected: 0 };
		this.finalized = true;
		return this.inner.execute("ROLLBACK");
	}
	execute(query, params) {
		return this.inner.execute(query, params);
	}
	executeRaw(query, params) {
		return this.inner.executeRaw(query, params);
	}
	executeBatch(query, params) {
		return this.inner.executeBatch(query, params);
	}
};
DBGetUtilsDefaultMixin(BaseTransaction);
"FinalizationRegistry" in globalThis && new FinalizationRegistry((sub) => {
	sub.logger.warn(`A subscription to ${sub.name} with params ${JSON.stringify(sub.parameters)} leaked! Please ensure calling unsubscribe() when you don't need a subscription anymore. For global subscriptions, consider storing them in global fields to avoid this warning.`);
});
/**
* @internal
*/
var PSInternalTable;
(function(PSInternalTable) {
	PSInternalTable["DATA"] = "ps_data";
	PSInternalTable["CRUD"] = "ps_crud";
	PSInternalTable["BUCKETS"] = "ps_buckets";
	PSInternalTable["OPLOG"] = "ps_oplog";
	PSInternalTable["UNTYPED"] = "ps_untyped";
})(PSInternalTable || (PSInternalTable = {}));
/**
* @internal
*/
var PowerSyncControlCommand;
(function(PowerSyncControlCommand) {
	PowerSyncControlCommand["PROCESS_TEXT_LINE"] = "line_text";
	PowerSyncControlCommand["PROCESS_BSON_LINE"] = "line_binary";
	PowerSyncControlCommand["STOP"] = "stop";
	PowerSyncControlCommand["START"] = "start";
	PowerSyncControlCommand["NOTIFY_TOKEN_REFRESHED"] = "refreshed_token";
	PowerSyncControlCommand["NOTIFY_CRUD_UPLOAD_COMPLETED"] = "completed_upload";
	PowerSyncControlCommand["UPDATE_SUBSCRIPTIONS"] = "update_subscriptions";
	/**
	* An `established` or `end` event for response streams.
	*/
	PowerSyncControlCommand["CONNECTION_STATE"] = "connection";
})(PowerSyncControlCommand || (PowerSyncControlCommand = {}));
/**
* Type of local change.
*
* @public
*/
var UpdateType;
(function(UpdateType) {
	/** Insert or replace existing row. All non-null columns are included in the data. Generated by INSERT statements. */
	UpdateType["PUT"] = "PUT";
	/** Update existing row. Contains the id, and value of each changed column. Generated by UPDATE statements. */
	UpdateType["PATCH"] = "PATCH";
	/** Delete existing row. Contains the id. Generated by DELETE statements. */
	UpdateType["DELETE"] = "DELETE";
})(UpdateType || (UpdateType = {}));
var buffer = {};
var base64Js = {};
var hasRequiredBase64Js;
function requireBase64Js() {
	if (hasRequiredBase64Js) return base64Js;
	hasRequiredBase64Js = 1;
	base64Js.byteLength = byteLength;
	base64Js.toByteArray = toByteArray;
	base64Js.fromByteArray = fromByteArray;
	var lookup = [];
	var revLookup = [];
	var Arr = typeof Uint8Array !== "undefined" ? Uint8Array : Array;
	var code = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	for (var i = 0, len = code.length; i < len; ++i) {
		lookup[i] = code[i];
		revLookup[code.charCodeAt(i)] = i;
	}
	revLookup["-".charCodeAt(0)] = 62;
	revLookup["_".charCodeAt(0)] = 63;
	function getLens(b64) {
		var len = b64.length;
		if (len % 4 > 0) throw new Error("Invalid string. Length must be a multiple of 4");
		var validLen = b64.indexOf("=");
		if (validLen === -1) validLen = len;
		var placeHoldersLen = validLen === len ? 0 : 4 - validLen % 4;
		return [validLen, placeHoldersLen];
	}
	function byteLength(b64) {
		var lens = getLens(b64);
		var validLen = lens[0];
		var placeHoldersLen = lens[1];
		return (validLen + placeHoldersLen) * 3 / 4 - placeHoldersLen;
	}
	function _byteLength(b64, validLen, placeHoldersLen) {
		return (validLen + placeHoldersLen) * 3 / 4 - placeHoldersLen;
	}
	function toByteArray(b64) {
		var tmp;
		var lens = getLens(b64);
		var validLen = lens[0];
		var placeHoldersLen = lens[1];
		var arr = new Arr(_byteLength(b64, validLen, placeHoldersLen));
		var curByte = 0;
		var len = placeHoldersLen > 0 ? validLen - 4 : validLen;
		var i;
		for (i = 0; i < len; i += 4) {
			tmp = revLookup[b64.charCodeAt(i)] << 18 | revLookup[b64.charCodeAt(i + 1)] << 12 | revLookup[b64.charCodeAt(i + 2)] << 6 | revLookup[b64.charCodeAt(i + 3)];
			arr[curByte++] = tmp >> 16 & 255;
			arr[curByte++] = tmp >> 8 & 255;
			arr[curByte++] = tmp & 255;
		}
		if (placeHoldersLen === 2) {
			tmp = revLookup[b64.charCodeAt(i)] << 2 | revLookup[b64.charCodeAt(i + 1)] >> 4;
			arr[curByte++] = tmp & 255;
		}
		if (placeHoldersLen === 1) {
			tmp = revLookup[b64.charCodeAt(i)] << 10 | revLookup[b64.charCodeAt(i + 1)] << 4 | revLookup[b64.charCodeAt(i + 2)] >> 2;
			arr[curByte++] = tmp >> 8 & 255;
			arr[curByte++] = tmp & 255;
		}
		return arr;
	}
	function tripletToBase64(num) {
		return lookup[num >> 18 & 63] + lookup[num >> 12 & 63] + lookup[num >> 6 & 63] + lookup[num & 63];
	}
	function encodeChunk(uint8, start, end) {
		var tmp;
		var output = [];
		for (var i = start; i < end; i += 3) {
			tmp = (uint8[i] << 16 & 16711680) + (uint8[i + 1] << 8 & 65280) + (uint8[i + 2] & 255);
			output.push(tripletToBase64(tmp));
		}
		return output.join("");
	}
	function fromByteArray(uint8) {
		var tmp;
		var len = uint8.length;
		var extraBytes = len % 3;
		var parts = [];
		var maxChunkLength = 16383;
		for (var i = 0, len2 = len - extraBytes; i < len2; i += maxChunkLength) parts.push(encodeChunk(uint8, i, i + maxChunkLength > len2 ? len2 : i + maxChunkLength));
		if (extraBytes === 1) {
			tmp = uint8[len - 1];
			parts.push(lookup[tmp >> 2] + lookup[tmp << 4 & 63] + "==");
		} else if (extraBytes === 2) {
			tmp = (uint8[len - 2] << 8) + uint8[len - 1];
			parts.push(lookup[tmp >> 10] + lookup[tmp >> 4 & 63] + lookup[tmp << 2 & 63] + "=");
		}
		return parts.join("");
	}
	return base64Js;
}
var ieee754 = {};
/*! ieee754. BSD-3-Clause License. Feross Aboukhadijeh <https://feross.org/opensource> */
var hasRequiredIeee754;
function requireIeee754() {
	if (hasRequiredIeee754) return ieee754;
	hasRequiredIeee754 = 1;
	ieee754.read = function(buffer, offset, isLE, mLen, nBytes) {
		var e, m;
		var eLen = nBytes * 8 - mLen - 1;
		var eMax = (1 << eLen) - 1;
		var eBias = eMax >> 1;
		var nBits = -7;
		var i = isLE ? nBytes - 1 : 0;
		var d = isLE ? -1 : 1;
		var s = buffer[offset + i];
		i += d;
		e = s & (1 << -nBits) - 1;
		s >>= -nBits;
		nBits += eLen;
		for (; nBits > 0; e = e * 256 + buffer[offset + i], i += d, nBits -= 8);
		m = e & (1 << -nBits) - 1;
		e >>= -nBits;
		nBits += mLen;
		for (; nBits > 0; m = m * 256 + buffer[offset + i], i += d, nBits -= 8);
		if (e === 0) e = 1 - eBias;
		else if (e === eMax) return m ? NaN : (s ? -1 : 1) * Infinity;
		else {
			m = m + Math.pow(2, mLen);
			e = e - eBias;
		}
		return (s ? -1 : 1) * m * Math.pow(2, e - mLen);
	};
	ieee754.write = function(buffer, value, offset, isLE, mLen, nBytes) {
		var e, m, c;
		var eLen = nBytes * 8 - mLen - 1;
		var eMax = (1 << eLen) - 1;
		var eBias = eMax >> 1;
		var rt = mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0;
		var i = isLE ? 0 : nBytes - 1;
		var d = isLE ? 1 : -1;
		var s = value < 0 || value === 0 && 1 / value < 0 ? 1 : 0;
		value = Math.abs(value);
		if (isNaN(value) || value === Infinity) {
			m = isNaN(value) ? 1 : 0;
			e = eMax;
		} else {
			e = Math.floor(Math.log(value) / Math.LN2);
			if (value * (c = Math.pow(2, -e)) < 1) {
				e--;
				c *= 2;
			}
			if (e + eBias >= 1) value += rt / c;
			else value += rt * Math.pow(2, 1 - eBias);
			if (value * c >= 2) {
				e++;
				c /= 2;
			}
			if (e + eBias >= eMax) {
				m = 0;
				e = eMax;
			} else if (e + eBias >= 1) {
				m = (value * c - 1) * Math.pow(2, mLen);
				e = e + eBias;
			} else {
				m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen);
				e = 0;
			}
		}
		for (; mLen >= 8; buffer[offset + i] = m & 255, i += d, m /= 256, mLen -= 8);
		e = e << mLen | m;
		eLen += mLen;
		for (; eLen > 0; buffer[offset + i] = e & 255, i += d, e /= 256, eLen -= 8);
		buffer[offset + i - d] |= s * 128;
	};
	return ieee754;
}
/*!
* The buffer module from node.js, for the browser.
*
* @author   Feross Aboukhadijeh <https://feross.org>
* @license  MIT
*/
var hasRequiredBuffer;
function requireBuffer() {
	if (hasRequiredBuffer) return buffer;
	hasRequiredBuffer = 1;
	(function(exports$1) {
		const base64 = requireBase64Js();
		const ieee754 = requireIeee754();
		const customInspectSymbol = typeof Symbol === "function" && typeof Symbol["for"] === "function" ? Symbol["for"]("nodejs.util.inspect.custom") : null;
		exports$1.Buffer = Buffer;
		exports$1.SlowBuffer = SlowBuffer;
		exports$1.INSPECT_MAX_BYTES = 50;
		const K_MAX_LENGTH = 2147483647;
		exports$1.kMaxLength = K_MAX_LENGTH;
		/**
		* If `Buffer.TYPED_ARRAY_SUPPORT`:
		*   === true    Use Uint8Array implementation (fastest)
		*   === false   Print warning and recommend using `buffer` v4.x which has an Object
		*               implementation (most compatible, even IE6)
		*
		* Browsers that support typed arrays are IE 10+, Firefox 4+, Chrome 7+, Safari 5.1+,
		* Opera 11.6+, iOS 4.2+.
		*
		* We report that the browser does not support typed arrays if the are not subclassable
		* using __proto__. Firefox 4-29 lacks support for adding new properties to `Uint8Array`
		* (See: https://bugzilla.mozilla.org/show_bug.cgi?id=695438). IE 10 lacks support
		* for __proto__ and has a buggy typed array implementation.
		*/
		Buffer.TYPED_ARRAY_SUPPORT = typedArraySupport();
		if (!Buffer.TYPED_ARRAY_SUPPORT && typeof console !== "undefined" && typeof console.error === "function") console.error("This browser lacks typed array (Uint8Array) support which is required by `buffer` v5.x. Use `buffer` v4.x if you require old browser support.");
		function typedArraySupport() {
			try {
				const arr = new Uint8Array(1);
				const proto = { foo: function() {
					return 42;
				} };
				Object.setPrototypeOf(proto, Uint8Array.prototype);
				Object.setPrototypeOf(arr, proto);
				return arr.foo() === 42;
			} catch (e) {
				return false;
			}
		}
		Object.defineProperty(Buffer.prototype, "parent", {
			enumerable: true,
			get: function() {
				if (!Buffer.isBuffer(this)) return void 0;
				return this.buffer;
			}
		});
		Object.defineProperty(Buffer.prototype, "offset", {
			enumerable: true,
			get: function() {
				if (!Buffer.isBuffer(this)) return void 0;
				return this.byteOffset;
			}
		});
		function createBuffer(length) {
			if (length > K_MAX_LENGTH) throw new RangeError("The value \"" + length + "\" is invalid for option \"size\"");
			const buf = new Uint8Array(length);
			Object.setPrototypeOf(buf, Buffer.prototype);
			return buf;
		}
		/**
		* The Buffer constructor returns instances of `Uint8Array` that have their
		* prototype changed to `Buffer.prototype`. Furthermore, `Buffer` is a subclass of
		* `Uint8Array`, so the returned instances will have all the node `Buffer` methods
		* and the `Uint8Array` methods. Square bracket notation works as expected -- it
		* returns a single octet.
		*
		* The `Uint8Array` prototype remains unmodified.
		*/
		function Buffer(arg, encodingOrOffset, length) {
			if (typeof arg === "number") {
				if (typeof encodingOrOffset === "string") throw new TypeError("The \"string\" argument must be of type string. Received type number");
				return allocUnsafe(arg);
			}
			return from(arg, encodingOrOffset, length);
		}
		Buffer.poolSize = 8192;
		function from(value, encodingOrOffset, length) {
			if (typeof value === "string") return fromString(value, encodingOrOffset);
			if (ArrayBuffer.isView(value)) return fromArrayView(value);
			if (value == null) throw new TypeError("The first argument must be one of type string, Buffer, ArrayBuffer, Array, or Array-like Object. Received type " + typeof value);
			if (isInstance(value, ArrayBuffer) || value && isInstance(value.buffer, ArrayBuffer)) return fromArrayBuffer(value, encodingOrOffset, length);
			if (typeof SharedArrayBuffer !== "undefined" && (isInstance(value, SharedArrayBuffer) || value && isInstance(value.buffer, SharedArrayBuffer))) return fromArrayBuffer(value, encodingOrOffset, length);
			if (typeof value === "number") throw new TypeError("The \"value\" argument must not be of type number. Received type number");
			const valueOf = value.valueOf && value.valueOf();
			if (valueOf != null && valueOf !== value) return Buffer.from(valueOf, encodingOrOffset, length);
			const b = fromObject(value);
			if (b) return b;
			if (typeof Symbol !== "undefined" && Symbol.toPrimitive != null && typeof value[Symbol.toPrimitive] === "function") return Buffer.from(value[Symbol.toPrimitive]("string"), encodingOrOffset, length);
			throw new TypeError("The first argument must be one of type string, Buffer, ArrayBuffer, Array, or Array-like Object. Received type " + typeof value);
		}
		/**
		* Functionally equivalent to Buffer(arg, encoding) but throws a TypeError
		* if value is a number.
		* Buffer.from(str[, encoding])
		* Buffer.from(array)
		* Buffer.from(buffer)
		* Buffer.from(arrayBuffer[, byteOffset[, length]])
		**/
		Buffer.from = function(value, encodingOrOffset, length) {
			return from(value, encodingOrOffset, length);
		};
		Object.setPrototypeOf(Buffer.prototype, Uint8Array.prototype);
		Object.setPrototypeOf(Buffer, Uint8Array);
		function assertSize(size) {
			if (typeof size !== "number") throw new TypeError("\"size\" argument must be of type number");
			else if (size < 0) throw new RangeError("The value \"" + size + "\" is invalid for option \"size\"");
		}
		function alloc(size, fill, encoding) {
			assertSize(size);
			if (size <= 0) return createBuffer(size);
			if (fill !== void 0) return typeof encoding === "string" ? createBuffer(size).fill(fill, encoding) : createBuffer(size).fill(fill);
			return createBuffer(size);
		}
		/**
		* Creates a new filled Buffer instance.
		* alloc(size[, fill[, encoding]])
		**/
		Buffer.alloc = function(size, fill, encoding) {
			return alloc(size, fill, encoding);
		};
		function allocUnsafe(size) {
			assertSize(size);
			return createBuffer(size < 0 ? 0 : checked(size) | 0);
		}
		/**
		* Equivalent to Buffer(num), by default creates a non-zero-filled Buffer instance.
		* */
		Buffer.allocUnsafe = function(size) {
			return allocUnsafe(size);
		};
		/**
		* Equivalent to SlowBuffer(num), by default creates a non-zero-filled Buffer instance.
		*/
		Buffer.allocUnsafeSlow = function(size) {
			return allocUnsafe(size);
		};
		function fromString(string, encoding) {
			if (typeof encoding !== "string" || encoding === "") encoding = "utf8";
			if (!Buffer.isEncoding(encoding)) throw new TypeError("Unknown encoding: " + encoding);
			const length = byteLength(string, encoding) | 0;
			let buf = createBuffer(length);
			const actual = buf.write(string, encoding);
			if (actual !== length) buf = buf.slice(0, actual);
			return buf;
		}
		function fromArrayLike(array) {
			const length = array.length < 0 ? 0 : checked(array.length) | 0;
			const buf = createBuffer(length);
			for (let i = 0; i < length; i += 1) buf[i] = array[i] & 255;
			return buf;
		}
		function fromArrayView(arrayView) {
			if (isInstance(arrayView, Uint8Array)) {
				const copy = new Uint8Array(arrayView);
				return fromArrayBuffer(copy.buffer, copy.byteOffset, copy.byteLength);
			}
			return fromArrayLike(arrayView);
		}
		function fromArrayBuffer(array, byteOffset, length) {
			if (byteOffset < 0 || array.byteLength < byteOffset) throw new RangeError("\"offset\" is outside of buffer bounds");
			if (array.byteLength < byteOffset + (length || 0)) throw new RangeError("\"length\" is outside of buffer bounds");
			let buf;
			if (byteOffset === void 0 && length === void 0) buf = new Uint8Array(array);
			else if (length === void 0) buf = new Uint8Array(array, byteOffset);
			else buf = new Uint8Array(array, byteOffset, length);
			Object.setPrototypeOf(buf, Buffer.prototype);
			return buf;
		}
		function fromObject(obj) {
			if (Buffer.isBuffer(obj)) {
				const len = checked(obj.length) | 0;
				const buf = createBuffer(len);
				if (buf.length === 0) return buf;
				obj.copy(buf, 0, 0, len);
				return buf;
			}
			if (obj.length !== void 0) {
				if (typeof obj.length !== "number" || numberIsNaN(obj.length)) return createBuffer(0);
				return fromArrayLike(obj);
			}
			if (obj.type === "Buffer" && Array.isArray(obj.data)) return fromArrayLike(obj.data);
		}
		function checked(length) {
			if (length >= K_MAX_LENGTH) throw new RangeError("Attempt to allocate Buffer larger than maximum size: 0x" + K_MAX_LENGTH.toString(16) + " bytes");
			return length | 0;
		}
		function SlowBuffer(length) {
			if (+length != length) length = 0;
			return Buffer.alloc(+length);
		}
		Buffer.isBuffer = function isBuffer(b) {
			return b != null && b._isBuffer === true && b !== Buffer.prototype;
		};
		Buffer.compare = function compare(a, b) {
			if (isInstance(a, Uint8Array)) a = Buffer.from(a, a.offset, a.byteLength);
			if (isInstance(b, Uint8Array)) b = Buffer.from(b, b.offset, b.byteLength);
			if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) throw new TypeError("The \"buf1\", \"buf2\" arguments must be one of type Buffer or Uint8Array");
			if (a === b) return 0;
			let x = a.length;
			let y = b.length;
			for (let i = 0, len = Math.min(x, y); i < len; ++i) if (a[i] !== b[i]) {
				x = a[i];
				y = b[i];
				break;
			}
			if (x < y) return -1;
			if (y < x) return 1;
			return 0;
		};
		Buffer.isEncoding = function isEncoding(encoding) {
			switch (String(encoding).toLowerCase()) {
				case "hex":
				case "utf8":
				case "utf-8":
				case "ascii":
				case "latin1":
				case "binary":
				case "base64":
				case "ucs2":
				case "ucs-2":
				case "utf16le":
				case "utf-16le": return true;
				default: return false;
			}
		};
		Buffer.concat = function concat(list, length) {
			if (!Array.isArray(list)) throw new TypeError("\"list\" argument must be an Array of Buffers");
			if (list.length === 0) return Buffer.alloc(0);
			let i;
			if (length === void 0) {
				length = 0;
				for (i = 0; i < list.length; ++i) length += list[i].length;
			}
			const buffer = Buffer.allocUnsafe(length);
			let pos = 0;
			for (i = 0; i < list.length; ++i) {
				let buf = list[i];
				if (isInstance(buf, Uint8Array)) if (pos + buf.length > buffer.length) {
					if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
					buf.copy(buffer, pos);
				} else Uint8Array.prototype.set.call(buffer, buf, pos);
				else if (!Buffer.isBuffer(buf)) throw new TypeError("\"list\" argument must be an Array of Buffers");
				else buf.copy(buffer, pos);
				pos += buf.length;
			}
			return buffer;
		};
		function byteLength(string, encoding) {
			if (Buffer.isBuffer(string)) return string.length;
			if (ArrayBuffer.isView(string) || isInstance(string, ArrayBuffer)) return string.byteLength;
			if (typeof string !== "string") throw new TypeError("The \"string\" argument must be one of type string, Buffer, or ArrayBuffer. Received type " + typeof string);
			const len = string.length;
			const mustMatch = arguments.length > 2 && arguments[2] === true;
			if (!mustMatch && len === 0) return 0;
			let loweredCase = false;
			for (;;) switch (encoding) {
				case "ascii":
				case "latin1":
				case "binary": return len;
				case "utf8":
				case "utf-8": return utf8ToBytes(string).length;
				case "ucs2":
				case "ucs-2":
				case "utf16le":
				case "utf-16le": return len * 2;
				case "hex": return len >>> 1;
				case "base64": return base64ToBytes(string).length;
				default:
					if (loweredCase) return mustMatch ? -1 : utf8ToBytes(string).length;
					encoding = ("" + encoding).toLowerCase();
					loweredCase = true;
			}
		}
		Buffer.byteLength = byteLength;
		function slowToString(encoding, start, end) {
			let loweredCase = false;
			if (start === void 0 || start < 0) start = 0;
			if (start > this.length) return "";
			if (end === void 0 || end > this.length) end = this.length;
			if (end <= 0) return "";
			end >>>= 0;
			start >>>= 0;
			if (end <= start) return "";
			if (!encoding) encoding = "utf8";
			while (true) switch (encoding) {
				case "hex": return hexSlice(this, start, end);
				case "utf8":
				case "utf-8": return utf8Slice(this, start, end);
				case "ascii": return asciiSlice(this, start, end);
				case "latin1":
				case "binary": return latin1Slice(this, start, end);
				case "base64": return base64Slice(this, start, end);
				case "ucs2":
				case "ucs-2":
				case "utf16le":
				case "utf-16le": return utf16leSlice(this, start, end);
				default:
					if (loweredCase) throw new TypeError("Unknown encoding: " + encoding);
					encoding = (encoding + "").toLowerCase();
					loweredCase = true;
			}
		}
		Buffer.prototype._isBuffer = true;
		function swap(b, n, m) {
			const i = b[n];
			b[n] = b[m];
			b[m] = i;
		}
		Buffer.prototype.swap16 = function swap16() {
			const len = this.length;
			if (len % 2 !== 0) throw new RangeError("Buffer size must be a multiple of 16-bits");
			for (let i = 0; i < len; i += 2) swap(this, i, i + 1);
			return this;
		};
		Buffer.prototype.swap32 = function swap32() {
			const len = this.length;
			if (len % 4 !== 0) throw new RangeError("Buffer size must be a multiple of 32-bits");
			for (let i = 0; i < len; i += 4) {
				swap(this, i, i + 3);
				swap(this, i + 1, i + 2);
			}
			return this;
		};
		Buffer.prototype.swap64 = function swap64() {
			const len = this.length;
			if (len % 8 !== 0) throw new RangeError("Buffer size must be a multiple of 64-bits");
			for (let i = 0; i < len; i += 8) {
				swap(this, i, i + 7);
				swap(this, i + 1, i + 6);
				swap(this, i + 2, i + 5);
				swap(this, i + 3, i + 4);
			}
			return this;
		};
		Buffer.prototype.toString = function toString() {
			const length = this.length;
			if (length === 0) return "";
			if (arguments.length === 0) return utf8Slice(this, 0, length);
			return slowToString.apply(this, arguments);
		};
		Buffer.prototype.toLocaleString = Buffer.prototype.toString;
		Buffer.prototype.equals = function equals(b) {
			if (!Buffer.isBuffer(b)) throw new TypeError("Argument must be a Buffer");
			if (this === b) return true;
			return Buffer.compare(this, b) === 0;
		};
		Buffer.prototype.inspect = function inspect() {
			let str = "";
			const max = exports$1.INSPECT_MAX_BYTES;
			str = this.toString("hex", 0, max).replace(/(.{2})/g, "$1 ").trim();
			if (this.length > max) str += " ... ";
			return "<Buffer " + str + ">";
		};
		if (customInspectSymbol) Buffer.prototype[customInspectSymbol] = Buffer.prototype.inspect;
		Buffer.prototype.compare = function compare(target, start, end, thisStart, thisEnd) {
			if (isInstance(target, Uint8Array)) target = Buffer.from(target, target.offset, target.byteLength);
			if (!Buffer.isBuffer(target)) throw new TypeError("The \"target\" argument must be one of type Buffer or Uint8Array. Received type " + typeof target);
			if (start === void 0) start = 0;
			if (end === void 0) end = target ? target.length : 0;
			if (thisStart === void 0) thisStart = 0;
			if (thisEnd === void 0) thisEnd = this.length;
			if (start < 0 || end > target.length || thisStart < 0 || thisEnd > this.length) throw new RangeError("out of range index");
			if (thisStart >= thisEnd && start >= end) return 0;
			if (thisStart >= thisEnd) return -1;
			if (start >= end) return 1;
			start >>>= 0;
			end >>>= 0;
			thisStart >>>= 0;
			thisEnd >>>= 0;
			if (this === target) return 0;
			let x = thisEnd - thisStart;
			let y = end - start;
			const len = Math.min(x, y);
			const thisCopy = this.slice(thisStart, thisEnd);
			const targetCopy = target.slice(start, end);
			for (let i = 0; i < len; ++i) if (thisCopy[i] !== targetCopy[i]) {
				x = thisCopy[i];
				y = targetCopy[i];
				break;
			}
			if (x < y) return -1;
			if (y < x) return 1;
			return 0;
		};
		function bidirectionalIndexOf(buffer, val, byteOffset, encoding, dir) {
			if (buffer.length === 0) return -1;
			if (typeof byteOffset === "string") {
				encoding = byteOffset;
				byteOffset = 0;
			} else if (byteOffset > 2147483647) byteOffset = 2147483647;
			else if (byteOffset < -2147483648) byteOffset = -2147483648;
			byteOffset = +byteOffset;
			if (numberIsNaN(byteOffset)) byteOffset = dir ? 0 : buffer.length - 1;
			if (byteOffset < 0) byteOffset = buffer.length + byteOffset;
			if (byteOffset >= buffer.length) if (dir) return -1;
			else byteOffset = buffer.length - 1;
			else if (byteOffset < 0) if (dir) byteOffset = 0;
			else return -1;
			if (typeof val === "string") val = Buffer.from(val, encoding);
			if (Buffer.isBuffer(val)) {
				if (val.length === 0) return -1;
				return arrayIndexOf(buffer, val, byteOffset, encoding, dir);
			} else if (typeof val === "number") {
				val = val & 255;
				if (typeof Uint8Array.prototype.indexOf === "function") if (dir) return Uint8Array.prototype.indexOf.call(buffer, val, byteOffset);
				else return Uint8Array.prototype.lastIndexOf.call(buffer, val, byteOffset);
				return arrayIndexOf(buffer, [val], byteOffset, encoding, dir);
			}
			throw new TypeError("val must be string, number or Buffer");
		}
		function arrayIndexOf(arr, val, byteOffset, encoding, dir) {
			let indexSize = 1;
			let arrLength = arr.length;
			let valLength = val.length;
			if (encoding !== void 0) {
				encoding = String(encoding).toLowerCase();
				if (encoding === "ucs2" || encoding === "ucs-2" || encoding === "utf16le" || encoding === "utf-16le") {
					if (arr.length < 2 || val.length < 2) return -1;
					indexSize = 2;
					arrLength /= 2;
					valLength /= 2;
					byteOffset /= 2;
				}
			}
			function read(buf, i) {
				if (indexSize === 1) return buf[i];
				else return buf.readUInt16BE(i * indexSize);
			}
			let i;
			if (dir) {
				let foundIndex = -1;
				for (i = byteOffset; i < arrLength; i++) if (read(arr, i) === read(val, foundIndex === -1 ? 0 : i - foundIndex)) {
					if (foundIndex === -1) foundIndex = i;
					if (i - foundIndex + 1 === valLength) return foundIndex * indexSize;
				} else {
					if (foundIndex !== -1) i -= i - foundIndex;
					foundIndex = -1;
				}
			} else {
				if (byteOffset + valLength > arrLength) byteOffset = arrLength - valLength;
				for (i = byteOffset; i >= 0; i--) {
					let found = true;
					for (let j = 0; j < valLength; j++) if (read(arr, i + j) !== read(val, j)) {
						found = false;
						break;
					}
					if (found) return i;
				}
			}
			return -1;
		}
		Buffer.prototype.includes = function includes(val, byteOffset, encoding) {
			return this.indexOf(val, byteOffset, encoding) !== -1;
		};
		Buffer.prototype.indexOf = function indexOf(val, byteOffset, encoding) {
			return bidirectionalIndexOf(this, val, byteOffset, encoding, true);
		};
		Buffer.prototype.lastIndexOf = function lastIndexOf(val, byteOffset, encoding) {
			return bidirectionalIndexOf(this, val, byteOffset, encoding, false);
		};
		function hexWrite(buf, string, offset, length) {
			offset = Number(offset) || 0;
			const remaining = buf.length - offset;
			if (!length) length = remaining;
			else {
				length = Number(length);
				if (length > remaining) length = remaining;
			}
			const strLen = string.length;
			if (length > strLen / 2) length = strLen / 2;
			let i;
			for (i = 0; i < length; ++i) {
				const parsed = parseInt(string.substr(i * 2, 2), 16);
				if (numberIsNaN(parsed)) return i;
				buf[offset + i] = parsed;
			}
			return i;
		}
		function utf8Write(buf, string, offset, length) {
			return blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length);
		}
		function asciiWrite(buf, string, offset, length) {
			return blitBuffer(asciiToBytes(string), buf, offset, length);
		}
		function base64Write(buf, string, offset, length) {
			return blitBuffer(base64ToBytes(string), buf, offset, length);
		}
		function ucs2Write(buf, string, offset, length) {
			return blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length);
		}
		Buffer.prototype.write = function write(string, offset, length, encoding) {
			if (offset === void 0) {
				encoding = "utf8";
				length = this.length;
				offset = 0;
			} else if (length === void 0 && typeof offset === "string") {
				encoding = offset;
				length = this.length;
				offset = 0;
			} else if (isFinite(offset)) {
				offset = offset >>> 0;
				if (isFinite(length)) {
					length = length >>> 0;
					if (encoding === void 0) encoding = "utf8";
				} else {
					encoding = length;
					length = void 0;
				}
			} else throw new Error("Buffer.write(string, encoding, offset[, length]) is no longer supported");
			const remaining = this.length - offset;
			if (length === void 0 || length > remaining) length = remaining;
			if (string.length > 0 && (length < 0 || offset < 0) || offset > this.length) throw new RangeError("Attempt to write outside buffer bounds");
			if (!encoding) encoding = "utf8";
			let loweredCase = false;
			for (;;) switch (encoding) {
				case "hex": return hexWrite(this, string, offset, length);
				case "utf8":
				case "utf-8": return utf8Write(this, string, offset, length);
				case "ascii":
				case "latin1":
				case "binary": return asciiWrite(this, string, offset, length);
				case "base64": return base64Write(this, string, offset, length);
				case "ucs2":
				case "ucs-2":
				case "utf16le":
				case "utf-16le": return ucs2Write(this, string, offset, length);
				default:
					if (loweredCase) throw new TypeError("Unknown encoding: " + encoding);
					encoding = ("" + encoding).toLowerCase();
					loweredCase = true;
			}
		};
		Buffer.prototype.toJSON = function toJSON() {
			return {
				type: "Buffer",
				data: Array.prototype.slice.call(this._arr || this, 0)
			};
		};
		function base64Slice(buf, start, end) {
			if (start === 0 && end === buf.length) return base64.fromByteArray(buf);
			else return base64.fromByteArray(buf.slice(start, end));
		}
		function utf8Slice(buf, start, end) {
			end = Math.min(buf.length, end);
			const res = [];
			let i = start;
			while (i < end) {
				const firstByte = buf[i];
				let codePoint = null;
				let bytesPerSequence = firstByte > 239 ? 4 : firstByte > 223 ? 3 : firstByte > 191 ? 2 : 1;
				if (i + bytesPerSequence <= end) {
					let secondByte, thirdByte, fourthByte, tempCodePoint;
					switch (bytesPerSequence) {
						case 1:
							if (firstByte < 128) codePoint = firstByte;
							break;
						case 2:
							secondByte = buf[i + 1];
							if ((secondByte & 192) === 128) {
								tempCodePoint = (firstByte & 31) << 6 | secondByte & 63;
								if (tempCodePoint > 127) codePoint = tempCodePoint;
							}
							break;
						case 3:
							secondByte = buf[i + 1];
							thirdByte = buf[i + 2];
							if ((secondByte & 192) === 128 && (thirdByte & 192) === 128) {
								tempCodePoint = (firstByte & 15) << 12 | (secondByte & 63) << 6 | thirdByte & 63;
								if (tempCodePoint > 2047 && (tempCodePoint < 55296 || tempCodePoint > 57343)) codePoint = tempCodePoint;
							}
							break;
						case 4:
							secondByte = buf[i + 1];
							thirdByte = buf[i + 2];
							fourthByte = buf[i + 3];
							if ((secondByte & 192) === 128 && (thirdByte & 192) === 128 && (fourthByte & 192) === 128) {
								tempCodePoint = (firstByte & 15) << 18 | (secondByte & 63) << 12 | (thirdByte & 63) << 6 | fourthByte & 63;
								if (tempCodePoint > 65535 && tempCodePoint < 1114112) codePoint = tempCodePoint;
							}
					}
				}
				if (codePoint === null) {
					codePoint = 65533;
					bytesPerSequence = 1;
				} else if (codePoint > 65535) {
					codePoint -= 65536;
					res.push(codePoint >>> 10 & 1023 | 55296);
					codePoint = 56320 | codePoint & 1023;
				}
				res.push(codePoint);
				i += bytesPerSequence;
			}
			return decodeCodePointsArray(res);
		}
		const MAX_ARGUMENTS_LENGTH = 4096;
		function decodeCodePointsArray(codePoints) {
			const len = codePoints.length;
			if (len <= MAX_ARGUMENTS_LENGTH) return String.fromCharCode.apply(String, codePoints);
			let res = "";
			let i = 0;
			while (i < len) res += String.fromCharCode.apply(String, codePoints.slice(i, i += MAX_ARGUMENTS_LENGTH));
			return res;
		}
		function asciiSlice(buf, start, end) {
			let ret = "";
			end = Math.min(buf.length, end);
			for (let i = start; i < end; ++i) ret += String.fromCharCode(buf[i] & 127);
			return ret;
		}
		function latin1Slice(buf, start, end) {
			let ret = "";
			end = Math.min(buf.length, end);
			for (let i = start; i < end; ++i) ret += String.fromCharCode(buf[i]);
			return ret;
		}
		function hexSlice(buf, start, end) {
			const len = buf.length;
			if (!start || start < 0) start = 0;
			if (!end || end < 0 || end > len) end = len;
			let out = "";
			for (let i = start; i < end; ++i) out += hexSliceLookupTable[buf[i]];
			return out;
		}
		function utf16leSlice(buf, start, end) {
			const bytes = buf.slice(start, end);
			let res = "";
			for (let i = 0; i < bytes.length - 1; i += 2) res += String.fromCharCode(bytes[i] + bytes[i + 1] * 256);
			return res;
		}
		Buffer.prototype.slice = function slice(start, end) {
			const len = this.length;
			start = ~~start;
			end = end === void 0 ? len : ~~end;
			if (start < 0) {
				start += len;
				if (start < 0) start = 0;
			} else if (start > len) start = len;
			if (end < 0) {
				end += len;
				if (end < 0) end = 0;
			} else if (end > len) end = len;
			if (end < start) end = start;
			const newBuf = this.subarray(start, end);
			Object.setPrototypeOf(newBuf, Buffer.prototype);
			return newBuf;
		};
		function checkOffset(offset, ext, length) {
			if (offset % 1 !== 0 || offset < 0) throw new RangeError("offset is not uint");
			if (offset + ext > length) throw new RangeError("Trying to access beyond buffer length");
		}
		Buffer.prototype.readUintLE = Buffer.prototype.readUIntLE = function readUIntLE(offset, byteLength, noAssert) {
			offset = offset >>> 0;
			byteLength = byteLength >>> 0;
			if (!noAssert) checkOffset(offset, byteLength, this.length);
			let val = this[offset];
			let mul = 1;
			let i = 0;
			while (++i < byteLength && (mul *= 256)) val += this[offset + i] * mul;
			return val;
		};
		Buffer.prototype.readUintBE = Buffer.prototype.readUIntBE = function readUIntBE(offset, byteLength, noAssert) {
			offset = offset >>> 0;
			byteLength = byteLength >>> 0;
			if (!noAssert) checkOffset(offset, byteLength, this.length);
			let val = this[offset + --byteLength];
			let mul = 1;
			while (byteLength > 0 && (mul *= 256)) val += this[offset + --byteLength] * mul;
			return val;
		};
		Buffer.prototype.readUint8 = Buffer.prototype.readUInt8 = function readUInt8(offset, noAssert) {
			offset = offset >>> 0;
			if (!noAssert) checkOffset(offset, 1, this.length);
			return this[offset];
		};
		Buffer.prototype.readUint16LE = Buffer.prototype.readUInt16LE = function readUInt16LE(offset, noAssert) {
			offset = offset >>> 0;
			if (!noAssert) checkOffset(offset, 2, this.length);
			return this[offset] | this[offset + 1] << 8;
		};
		Buffer.prototype.readUint16BE = Buffer.prototype.readUInt16BE = function readUInt16BE(offset, noAssert) {
			offset = offset >>> 0;
			if (!noAssert) checkOffset(offset, 2, this.length);
			return this[offset] << 8 | this[offset + 1];
		};
		Buffer.prototype.readUint32LE = Buffer.prototype.readUInt32LE = function readUInt32LE(offset, noAssert) {
			offset = offset >>> 0;
			if (!noAssert) checkOffset(offset, 4, this.length);
			return (this[offset] | this[offset + 1] << 8 | this[offset + 2] << 16) + this[offset + 3] * 16777216;
		};
		Buffer.prototype.readUint32BE = Buffer.prototype.readUInt32BE = function readUInt32BE(offset, noAssert) {
			offset = offset >>> 0;
			if (!noAssert) checkOffset(offset, 4, this.length);
			return this[offset] * 16777216 + (this[offset + 1] << 16 | this[offset + 2] << 8 | this[offset + 3]);
		};
		Buffer.prototype.readBigUInt64LE = defineBigIntMethod(function readBigUInt64LE(offset) {
			offset = offset >>> 0;
			validateNumber(offset, "offset");
			const first = this[offset];
			const last = this[offset + 7];
			if (first === void 0 || last === void 0) boundsError(offset, this.length - 8);
			const lo = first + this[++offset] * 2 ** 8 + this[++offset] * 2 ** 16 + this[++offset] * 2 ** 24;
			const hi = this[++offset] + this[++offset] * 2 ** 8 + this[++offset] * 2 ** 16 + last * 2 ** 24;
			return BigInt(lo) + (BigInt(hi) << BigInt(32));
		});
		Buffer.prototype.readBigUInt64BE = defineBigIntMethod(function readBigUInt64BE(offset) {
			offset = offset >>> 0;
			validateNumber(offset, "offset");
			const first = this[offset];
			const last = this[offset + 7];
			if (first === void 0 || last === void 0) boundsError(offset, this.length - 8);
			const hi = first * 2 ** 24 + this[++offset] * 2 ** 16 + this[++offset] * 2 ** 8 + this[++offset];
			const lo = this[++offset] * 2 ** 24 + this[++offset] * 2 ** 16 + this[++offset] * 2 ** 8 + last;
			return (BigInt(hi) << BigInt(32)) + BigInt(lo);
		});
		Buffer.prototype.readIntLE = function readIntLE(offset, byteLength, noAssert) {
			offset = offset >>> 0;
			byteLength = byteLength >>> 0;
			if (!noAssert) checkOffset(offset, byteLength, this.length);
			let val = this[offset];
			let mul = 1;
			let i = 0;
			while (++i < byteLength && (mul *= 256)) val += this[offset + i] * mul;
			mul *= 128;
			if (val >= mul) val -= Math.pow(2, 8 * byteLength);
			return val;
		};
		Buffer.prototype.readIntBE = function readIntBE(offset, byteLength, noAssert) {
			offset = offset >>> 0;
			byteLength = byteLength >>> 0;
			if (!noAssert) checkOffset(offset, byteLength, this.length);
			let i = byteLength;
			let mul = 1;
			let val = this[offset + --i];
			while (i > 0 && (mul *= 256)) val += this[offset + --i] * mul;
			mul *= 128;
			if (val >= mul) val -= Math.pow(2, 8 * byteLength);
			return val;
		};
		Buffer.prototype.readInt8 = function readInt8(offset, noAssert) {
			offset = offset >>> 0;
			if (!noAssert) checkOffset(offset, 1, this.length);
			if (!(this[offset] & 128)) return this[offset];
			return (255 - this[offset] + 1) * -1;
		};
		Buffer.prototype.readInt16LE = function readInt16LE(offset, noAssert) {
			offset = offset >>> 0;
			if (!noAssert) checkOffset(offset, 2, this.length);
			const val = this[offset] | this[offset + 1] << 8;
			return val & 32768 ? val | 4294901760 : val;
		};
		Buffer.prototype.readInt16BE = function readInt16BE(offset, noAssert) {
			offset = offset >>> 0;
			if (!noAssert) checkOffset(offset, 2, this.length);
			const val = this[offset + 1] | this[offset] << 8;
			return val & 32768 ? val | 4294901760 : val;
		};
		Buffer.prototype.readInt32LE = function readInt32LE(offset, noAssert) {
			offset = offset >>> 0;
			if (!noAssert) checkOffset(offset, 4, this.length);
			return this[offset] | this[offset + 1] << 8 | this[offset + 2] << 16 | this[offset + 3] << 24;
		};
		Buffer.prototype.readInt32BE = function readInt32BE(offset, noAssert) {
			offset = offset >>> 0;
			if (!noAssert) checkOffset(offset, 4, this.length);
			return this[offset] << 24 | this[offset + 1] << 16 | this[offset + 2] << 8 | this[offset + 3];
		};
		Buffer.prototype.readBigInt64LE = defineBigIntMethod(function readBigInt64LE(offset) {
			offset = offset >>> 0;
			validateNumber(offset, "offset");
			const first = this[offset];
			const last = this[offset + 7];
			if (first === void 0 || last === void 0) boundsError(offset, this.length - 8);
			const val = this[offset + 4] + this[offset + 5] * 2 ** 8 + this[offset + 6] * 2 ** 16 + (last << 24);
			return (BigInt(val) << BigInt(32)) + BigInt(first + this[++offset] * 2 ** 8 + this[++offset] * 2 ** 16 + this[++offset] * 2 ** 24);
		});
		Buffer.prototype.readBigInt64BE = defineBigIntMethod(function readBigInt64BE(offset) {
			offset = offset >>> 0;
			validateNumber(offset, "offset");
			const first = this[offset];
			const last = this[offset + 7];
			if (first === void 0 || last === void 0) boundsError(offset, this.length - 8);
			const val = (first << 24) + this[++offset] * 2 ** 16 + this[++offset] * 2 ** 8 + this[++offset];
			return (BigInt(val) << BigInt(32)) + BigInt(this[++offset] * 2 ** 24 + this[++offset] * 2 ** 16 + this[++offset] * 2 ** 8 + last);
		});
		Buffer.prototype.readFloatLE = function readFloatLE(offset, noAssert) {
			offset = offset >>> 0;
			if (!noAssert) checkOffset(offset, 4, this.length);
			return ieee754.read(this, offset, true, 23, 4);
		};
		Buffer.prototype.readFloatBE = function readFloatBE(offset, noAssert) {
			offset = offset >>> 0;
			if (!noAssert) checkOffset(offset, 4, this.length);
			return ieee754.read(this, offset, false, 23, 4);
		};
		Buffer.prototype.readDoubleLE = function readDoubleLE(offset, noAssert) {
			offset = offset >>> 0;
			if (!noAssert) checkOffset(offset, 8, this.length);
			return ieee754.read(this, offset, true, 52, 8);
		};
		Buffer.prototype.readDoubleBE = function readDoubleBE(offset, noAssert) {
			offset = offset >>> 0;
			if (!noAssert) checkOffset(offset, 8, this.length);
			return ieee754.read(this, offset, false, 52, 8);
		};
		function checkInt(buf, value, offset, ext, max, min) {
			if (!Buffer.isBuffer(buf)) throw new TypeError("\"buffer\" argument must be a Buffer instance");
			if (value > max || value < min) throw new RangeError("\"value\" argument is out of bounds");
			if (offset + ext > buf.length) throw new RangeError("Index out of range");
		}
		Buffer.prototype.writeUintLE = Buffer.prototype.writeUIntLE = function writeUIntLE(value, offset, byteLength, noAssert) {
			value = +value;
			offset = offset >>> 0;
			byteLength = byteLength >>> 0;
			if (!noAssert) {
				const maxBytes = Math.pow(2, 8 * byteLength) - 1;
				checkInt(this, value, offset, byteLength, maxBytes, 0);
			}
			let mul = 1;
			let i = 0;
			this[offset] = value & 255;
			while (++i < byteLength && (mul *= 256)) this[offset + i] = value / mul & 255;
			return offset + byteLength;
		};
		Buffer.prototype.writeUintBE = Buffer.prototype.writeUIntBE = function writeUIntBE(value, offset, byteLength, noAssert) {
			value = +value;
			offset = offset >>> 0;
			byteLength = byteLength >>> 0;
			if (!noAssert) {
				const maxBytes = Math.pow(2, 8 * byteLength) - 1;
				checkInt(this, value, offset, byteLength, maxBytes, 0);
			}
			let i = byteLength - 1;
			let mul = 1;
			this[offset + i] = value & 255;
			while (--i >= 0 && (mul *= 256)) this[offset + i] = value / mul & 255;
			return offset + byteLength;
		};
		Buffer.prototype.writeUint8 = Buffer.prototype.writeUInt8 = function writeUInt8(value, offset, noAssert) {
			value = +value;
			offset = offset >>> 0;
			if (!noAssert) checkInt(this, value, offset, 1, 255, 0);
			this[offset] = value & 255;
			return offset + 1;
		};
		Buffer.prototype.writeUint16LE = Buffer.prototype.writeUInt16LE = function writeUInt16LE(value, offset, noAssert) {
			value = +value;
			offset = offset >>> 0;
			if (!noAssert) checkInt(this, value, offset, 2, 65535, 0);
			this[offset] = value & 255;
			this[offset + 1] = value >>> 8;
			return offset + 2;
		};
		Buffer.prototype.writeUint16BE = Buffer.prototype.writeUInt16BE = function writeUInt16BE(value, offset, noAssert) {
			value = +value;
			offset = offset >>> 0;
			if (!noAssert) checkInt(this, value, offset, 2, 65535, 0);
			this[offset] = value >>> 8;
			this[offset + 1] = value & 255;
			return offset + 2;
		};
		Buffer.prototype.writeUint32LE = Buffer.prototype.writeUInt32LE = function writeUInt32LE(value, offset, noAssert) {
			value = +value;
			offset = offset >>> 0;
			if (!noAssert) checkInt(this, value, offset, 4, 4294967295, 0);
			this[offset + 3] = value >>> 24;
			this[offset + 2] = value >>> 16;
			this[offset + 1] = value >>> 8;
			this[offset] = value & 255;
			return offset + 4;
		};
		Buffer.prototype.writeUint32BE = Buffer.prototype.writeUInt32BE = function writeUInt32BE(value, offset, noAssert) {
			value = +value;
			offset = offset >>> 0;
			if (!noAssert) checkInt(this, value, offset, 4, 4294967295, 0);
			this[offset] = value >>> 24;
			this[offset + 1] = value >>> 16;
			this[offset + 2] = value >>> 8;
			this[offset + 3] = value & 255;
			return offset + 4;
		};
		function wrtBigUInt64LE(buf, value, offset, min, max) {
			checkIntBI(value, min, max, buf, offset, 7);
			let lo = Number(value & BigInt(4294967295));
			buf[offset++] = lo;
			lo = lo >> 8;
			buf[offset++] = lo;
			lo = lo >> 8;
			buf[offset++] = lo;
			lo = lo >> 8;
			buf[offset++] = lo;
			let hi = Number(value >> BigInt(32) & BigInt(4294967295));
			buf[offset++] = hi;
			hi = hi >> 8;
			buf[offset++] = hi;
			hi = hi >> 8;
			buf[offset++] = hi;
			hi = hi >> 8;
			buf[offset++] = hi;
			return offset;
		}
		function wrtBigUInt64BE(buf, value, offset, min, max) {
			checkIntBI(value, min, max, buf, offset, 7);
			let lo = Number(value & BigInt(4294967295));
			buf[offset + 7] = lo;
			lo = lo >> 8;
			buf[offset + 6] = lo;
			lo = lo >> 8;
			buf[offset + 5] = lo;
			lo = lo >> 8;
			buf[offset + 4] = lo;
			let hi = Number(value >> BigInt(32) & BigInt(4294967295));
			buf[offset + 3] = hi;
			hi = hi >> 8;
			buf[offset + 2] = hi;
			hi = hi >> 8;
			buf[offset + 1] = hi;
			hi = hi >> 8;
			buf[offset] = hi;
			return offset + 8;
		}
		Buffer.prototype.writeBigUInt64LE = defineBigIntMethod(function writeBigUInt64LE(value, offset = 0) {
			return wrtBigUInt64LE(this, value, offset, BigInt(0), BigInt("0xffffffffffffffff"));
		});
		Buffer.prototype.writeBigUInt64BE = defineBigIntMethod(function writeBigUInt64BE(value, offset = 0) {
			return wrtBigUInt64BE(this, value, offset, BigInt(0), BigInt("0xffffffffffffffff"));
		});
		Buffer.prototype.writeIntLE = function writeIntLE(value, offset, byteLength, noAssert) {
			value = +value;
			offset = offset >>> 0;
			if (!noAssert) {
				const limit = Math.pow(2, 8 * byteLength - 1);
				checkInt(this, value, offset, byteLength, limit - 1, -limit);
			}
			let i = 0;
			let mul = 1;
			let sub = 0;
			this[offset] = value & 255;
			while (++i < byteLength && (mul *= 256)) {
				if (value < 0 && sub === 0 && this[offset + i - 1] !== 0) sub = 1;
				this[offset + i] = (value / mul >> 0) - sub & 255;
			}
			return offset + byteLength;
		};
		Buffer.prototype.writeIntBE = function writeIntBE(value, offset, byteLength, noAssert) {
			value = +value;
			offset = offset >>> 0;
			if (!noAssert) {
				const limit = Math.pow(2, 8 * byteLength - 1);
				checkInt(this, value, offset, byteLength, limit - 1, -limit);
			}
			let i = byteLength - 1;
			let mul = 1;
			let sub = 0;
			this[offset + i] = value & 255;
			while (--i >= 0 && (mul *= 256)) {
				if (value < 0 && sub === 0 && this[offset + i + 1] !== 0) sub = 1;
				this[offset + i] = (value / mul >> 0) - sub & 255;
			}
			return offset + byteLength;
		};
		Buffer.prototype.writeInt8 = function writeInt8(value, offset, noAssert) {
			value = +value;
			offset = offset >>> 0;
			if (!noAssert) checkInt(this, value, offset, 1, 127, -128);
			if (value < 0) value = 255 + value + 1;
			this[offset] = value & 255;
			return offset + 1;
		};
		Buffer.prototype.writeInt16LE = function writeInt16LE(value, offset, noAssert) {
			value = +value;
			offset = offset >>> 0;
			if (!noAssert) checkInt(this, value, offset, 2, 32767, -32768);
			this[offset] = value & 255;
			this[offset + 1] = value >>> 8;
			return offset + 2;
		};
		Buffer.prototype.writeInt16BE = function writeInt16BE(value, offset, noAssert) {
			value = +value;
			offset = offset >>> 0;
			if (!noAssert) checkInt(this, value, offset, 2, 32767, -32768);
			this[offset] = value >>> 8;
			this[offset + 1] = value & 255;
			return offset + 2;
		};
		Buffer.prototype.writeInt32LE = function writeInt32LE(value, offset, noAssert) {
			value = +value;
			offset = offset >>> 0;
			if (!noAssert) checkInt(this, value, offset, 4, 2147483647, -2147483648);
			this[offset] = value & 255;
			this[offset + 1] = value >>> 8;
			this[offset + 2] = value >>> 16;
			this[offset + 3] = value >>> 24;
			return offset + 4;
		};
		Buffer.prototype.writeInt32BE = function writeInt32BE(value, offset, noAssert) {
			value = +value;
			offset = offset >>> 0;
			if (!noAssert) checkInt(this, value, offset, 4, 2147483647, -2147483648);
			if (value < 0) value = 4294967295 + value + 1;
			this[offset] = value >>> 24;
			this[offset + 1] = value >>> 16;
			this[offset + 2] = value >>> 8;
			this[offset + 3] = value & 255;
			return offset + 4;
		};
		Buffer.prototype.writeBigInt64LE = defineBigIntMethod(function writeBigInt64LE(value, offset = 0) {
			return wrtBigUInt64LE(this, value, offset, -BigInt("0x8000000000000000"), BigInt("0x7fffffffffffffff"));
		});
		Buffer.prototype.writeBigInt64BE = defineBigIntMethod(function writeBigInt64BE(value, offset = 0) {
			return wrtBigUInt64BE(this, value, offset, -BigInt("0x8000000000000000"), BigInt("0x7fffffffffffffff"));
		});
		function checkIEEE754(buf, value, offset, ext, max, min) {
			if (offset + ext > buf.length) throw new RangeError("Index out of range");
			if (offset < 0) throw new RangeError("Index out of range");
		}
		function writeFloat(buf, value, offset, littleEndian, noAssert) {
			value = +value;
			offset = offset >>> 0;
			if (!noAssert) checkIEEE754(buf, value, offset, 4);
			ieee754.write(buf, value, offset, littleEndian, 23, 4);
			return offset + 4;
		}
		Buffer.prototype.writeFloatLE = function writeFloatLE(value, offset, noAssert) {
			return writeFloat(this, value, offset, true, noAssert);
		};
		Buffer.prototype.writeFloatBE = function writeFloatBE(value, offset, noAssert) {
			return writeFloat(this, value, offset, false, noAssert);
		};
		function writeDouble(buf, value, offset, littleEndian, noAssert) {
			value = +value;
			offset = offset >>> 0;
			if (!noAssert) checkIEEE754(buf, value, offset, 8);
			ieee754.write(buf, value, offset, littleEndian, 52, 8);
			return offset + 8;
		}
		Buffer.prototype.writeDoubleLE = function writeDoubleLE(value, offset, noAssert) {
			return writeDouble(this, value, offset, true, noAssert);
		};
		Buffer.prototype.writeDoubleBE = function writeDoubleBE(value, offset, noAssert) {
			return writeDouble(this, value, offset, false, noAssert);
		};
		Buffer.prototype.copy = function copy(target, targetStart, start, end) {
			if (!Buffer.isBuffer(target)) throw new TypeError("argument should be a Buffer");
			if (!start) start = 0;
			if (!end && end !== 0) end = this.length;
			if (targetStart >= target.length) targetStart = target.length;
			if (!targetStart) targetStart = 0;
			if (end > 0 && end < start) end = start;
			if (end === start) return 0;
			if (target.length === 0 || this.length === 0) return 0;
			if (targetStart < 0) throw new RangeError("targetStart out of bounds");
			if (start < 0 || start >= this.length) throw new RangeError("Index out of range");
			if (end < 0) throw new RangeError("sourceEnd out of bounds");
			if (end > this.length) end = this.length;
			if (target.length - targetStart < end - start) end = target.length - targetStart + start;
			const len = end - start;
			if (this === target && typeof Uint8Array.prototype.copyWithin === "function") this.copyWithin(targetStart, start, end);
			else Uint8Array.prototype.set.call(target, this.subarray(start, end), targetStart);
			return len;
		};
		Buffer.prototype.fill = function fill(val, start, end, encoding) {
			if (typeof val === "string") {
				if (typeof start === "string") {
					encoding = start;
					start = 0;
					end = this.length;
				} else if (typeof end === "string") {
					encoding = end;
					end = this.length;
				}
				if (encoding !== void 0 && typeof encoding !== "string") throw new TypeError("encoding must be a string");
				if (typeof encoding === "string" && !Buffer.isEncoding(encoding)) throw new TypeError("Unknown encoding: " + encoding);
				if (val.length === 1) {
					const code = val.charCodeAt(0);
					if (encoding === "utf8" && code < 128 || encoding === "latin1") val = code;
				}
			} else if (typeof val === "number") val = val & 255;
			else if (typeof val === "boolean") val = Number(val);
			if (start < 0 || this.length < start || this.length < end) throw new RangeError("Out of range index");
			if (end <= start) return this;
			start = start >>> 0;
			end = end === void 0 ? this.length : end >>> 0;
			if (!val) val = 0;
			let i;
			if (typeof val === "number") for (i = start; i < end; ++i) this[i] = val;
			else {
				const bytes = Buffer.isBuffer(val) ? val : Buffer.from(val, encoding);
				const len = bytes.length;
				if (len === 0) throw new TypeError("The value \"" + val + "\" is invalid for argument \"value\"");
				for (i = 0; i < end - start; ++i) this[i + start] = bytes[i % len];
			}
			return this;
		};
		const errors = {};
		function E(sym, getMessage, Base) {
			errors[sym] = class NodeError extends Base {
				constructor() {
					super();
					Object.defineProperty(this, "message", {
						value: getMessage.apply(this, arguments),
						writable: true,
						configurable: true
					});
					this.name = `${this.name} [${sym}]`;
					this.stack;
					delete this.name;
				}
				get code() {
					return sym;
				}
				set code(value) {
					Object.defineProperty(this, "code", {
						configurable: true,
						enumerable: true,
						value,
						writable: true
					});
				}
				toString() {
					return `${this.name} [${sym}]: ${this.message}`;
				}
			};
		}
		E("ERR_BUFFER_OUT_OF_BOUNDS", function(name) {
			if (name) return `${name} is outside of buffer bounds`;
			return "Attempt to access memory outside buffer bounds";
		}, RangeError);
		E("ERR_INVALID_ARG_TYPE", function(name, actual) {
			return `The "${name}" argument must be of type number. Received type ${typeof actual}`;
		}, TypeError);
		E("ERR_OUT_OF_RANGE", function(str, range, input) {
			let msg = `The value of "${str}" is out of range.`;
			let received = input;
			if (Number.isInteger(input) && Math.abs(input) > 2 ** 32) received = addNumericalSeparator(String(input));
			else if (typeof input === "bigint") {
				received = String(input);
				if (input > BigInt(2) ** BigInt(32) || input < -(BigInt(2) ** BigInt(32))) received = addNumericalSeparator(received);
				received += "n";
			}
			msg += ` It must be ${range}. Received ${received}`;
			return msg;
		}, RangeError);
		function addNumericalSeparator(val) {
			let res = "";
			let i = val.length;
			const start = val[0] === "-" ? 1 : 0;
			for (; i >= start + 4; i -= 3) res = `_${val.slice(i - 3, i)}${res}`;
			return `${val.slice(0, i)}${res}`;
		}
		function checkBounds(buf, offset, byteLength) {
			validateNumber(offset, "offset");
			if (buf[offset] === void 0 || buf[offset + byteLength] === void 0) boundsError(offset, buf.length - (byteLength + 1));
		}
		function checkIntBI(value, min, max, buf, offset, byteLength) {
			if (value > max || value < min) {
				const n = typeof min === "bigint" ? "n" : "";
				let range;
				if (min === 0 || min === BigInt(0)) range = `>= 0${n} and < 2${n} ** ${(byteLength + 1) * 8}${n}`;
				else range = `>= -(2${n} ** ${(byteLength + 1) * 8 - 1}${n}) and < 2 ** ${(byteLength + 1) * 8 - 1}${n}`;
				throw new errors.ERR_OUT_OF_RANGE("value", range, value);
			}
			checkBounds(buf, offset, byteLength);
		}
		function validateNumber(value, name) {
			if (typeof value !== "number") throw new errors.ERR_INVALID_ARG_TYPE(name, "number", value);
		}
		function boundsError(value, length, type) {
			if (Math.floor(value) !== value) {
				validateNumber(value, type);
				throw new errors.ERR_OUT_OF_RANGE("offset", "an integer", value);
			}
			if (length < 0) throw new errors.ERR_BUFFER_OUT_OF_BOUNDS();
			throw new errors.ERR_OUT_OF_RANGE("offset", `>= 0 and <= ${length}`, value);
		}
		const INVALID_BASE64_RE = /[^+/0-9A-Za-z-_]/g;
		function base64clean(str) {
			str = str.split("=")[0];
			str = str.trim().replace(INVALID_BASE64_RE, "");
			if (str.length < 2) return "";
			while (str.length % 4 !== 0) str = str + "=";
			return str;
		}
		function utf8ToBytes(string, units) {
			units = units || Infinity;
			let codePoint;
			const length = string.length;
			let leadSurrogate = null;
			const bytes = [];
			for (let i = 0; i < length; ++i) {
				codePoint = string.charCodeAt(i);
				if (codePoint > 55295 && codePoint < 57344) {
					if (!leadSurrogate) {
						if (codePoint > 56319) {
							if ((units -= 3) > -1) bytes.push(239, 191, 189);
							continue;
						} else if (i + 1 === length) {
							if ((units -= 3) > -1) bytes.push(239, 191, 189);
							continue;
						}
						leadSurrogate = codePoint;
						continue;
					}
					if (codePoint < 56320) {
						if ((units -= 3) > -1) bytes.push(239, 191, 189);
						leadSurrogate = codePoint;
						continue;
					}
					codePoint = (leadSurrogate - 55296 << 10 | codePoint - 56320) + 65536;
				} else if (leadSurrogate) {
					if ((units -= 3) > -1) bytes.push(239, 191, 189);
				}
				leadSurrogate = null;
				if (codePoint < 128) {
					if ((units -= 1) < 0) break;
					bytes.push(codePoint);
				} else if (codePoint < 2048) {
					if ((units -= 2) < 0) break;
					bytes.push(codePoint >> 6 | 192, codePoint & 63 | 128);
				} else if (codePoint < 65536) {
					if ((units -= 3) < 0) break;
					bytes.push(codePoint >> 12 | 224, codePoint >> 6 & 63 | 128, codePoint & 63 | 128);
				} else if (codePoint < 1114112) {
					if ((units -= 4) < 0) break;
					bytes.push(codePoint >> 18 | 240, codePoint >> 12 & 63 | 128, codePoint >> 6 & 63 | 128, codePoint & 63 | 128);
				} else throw new Error("Invalid code point");
			}
			return bytes;
		}
		function asciiToBytes(str) {
			const byteArray = [];
			for (let i = 0; i < str.length; ++i) byteArray.push(str.charCodeAt(i) & 255);
			return byteArray;
		}
		function utf16leToBytes(str, units) {
			let c, hi, lo;
			const byteArray = [];
			for (let i = 0; i < str.length; ++i) {
				if ((units -= 2) < 0) break;
				c = str.charCodeAt(i);
				hi = c >> 8;
				lo = c % 256;
				byteArray.push(lo);
				byteArray.push(hi);
			}
			return byteArray;
		}
		function base64ToBytes(str) {
			return base64.toByteArray(base64clean(str));
		}
		function blitBuffer(src, dst, offset, length) {
			let i;
			for (i = 0; i < length; ++i) {
				if (i + offset >= dst.length || i >= src.length) break;
				dst[i + offset] = src[i];
			}
			return i;
		}
		function isInstance(obj, type) {
			return obj instanceof type || obj != null && obj.constructor != null && obj.constructor.name != null && obj.constructor.name === type.name;
		}
		function numberIsNaN(obj) {
			return obj !== obj;
		}
		const hexSliceLookupTable = (function() {
			const alphabet = "0123456789abcdef";
			const table = new Array(256);
			for (let i = 0; i < 16; ++i) {
				const i16 = i * 16;
				for (let j = 0; j < 16; ++j) table[i16 + j] = alphabet[i] + alphabet[j];
			}
			return table;
		})();
		function defineBigIntMethod(fn) {
			return typeof BigInt === "undefined" ? BufferBigIntNotDefined : fn;
		}
		function BufferBigIntNotDefined() {
			throw new Error("BigInt not supported");
		}
	})(buffer);
	return buffer;
}
var bufferExports = requireBuffer();
var dist = {};
var Codecs = {};
var Frames = {};
var hasRequiredFrames;
function requireFrames() {
	if (hasRequiredFrames) return Frames;
	hasRequiredFrames = 1;
	(function(exports$1) {
		Object.defineProperty(exports$1, "__esModule", { value: true });
		exports$1.Frame = exports$1.Lengths = exports$1.Flags = exports$1.FrameTypes = void 0;
		var FrameTypes;
		(function(FrameTypes) {
			FrameTypes[FrameTypes["RESERVED"] = 0] = "RESERVED";
			FrameTypes[FrameTypes["SETUP"] = 1] = "SETUP";
			FrameTypes[FrameTypes["LEASE"] = 2] = "LEASE";
			FrameTypes[FrameTypes["KEEPALIVE"] = 3] = "KEEPALIVE";
			FrameTypes[FrameTypes["REQUEST_RESPONSE"] = 4] = "REQUEST_RESPONSE";
			FrameTypes[FrameTypes["REQUEST_FNF"] = 5] = "REQUEST_FNF";
			FrameTypes[FrameTypes["REQUEST_STREAM"] = 6] = "REQUEST_STREAM";
			FrameTypes[FrameTypes["REQUEST_CHANNEL"] = 7] = "REQUEST_CHANNEL";
			FrameTypes[FrameTypes["REQUEST_N"] = 8] = "REQUEST_N";
			FrameTypes[FrameTypes["CANCEL"] = 9] = "CANCEL";
			FrameTypes[FrameTypes["PAYLOAD"] = 10] = "PAYLOAD";
			FrameTypes[FrameTypes["ERROR"] = 11] = "ERROR";
			FrameTypes[FrameTypes["METADATA_PUSH"] = 12] = "METADATA_PUSH";
			FrameTypes[FrameTypes["RESUME"] = 13] = "RESUME";
			FrameTypes[FrameTypes["RESUME_OK"] = 14] = "RESUME_OK";
			FrameTypes[FrameTypes["EXT"] = 63] = "EXT";
		})(FrameTypes = exports$1.FrameTypes || (exports$1.FrameTypes = {}));
		(function(Flags) {
			Flags[Flags["NONE"] = 0] = "NONE";
			Flags[Flags["COMPLETE"] = 64] = "COMPLETE";
			Flags[Flags["FOLLOWS"] = 128] = "FOLLOWS";
			Flags[Flags["IGNORE"] = 512] = "IGNORE";
			Flags[Flags["LEASE"] = 64] = "LEASE";
			Flags[Flags["METADATA"] = 256] = "METADATA";
			Flags[Flags["NEXT"] = 32] = "NEXT";
			Flags[Flags["RESPOND"] = 128] = "RESPOND";
			Flags[Flags["RESUME_ENABLE"] = 128] = "RESUME_ENABLE";
		})(exports$1.Flags || (exports$1.Flags = {}));
		(function(Flags) {
			function hasMetadata(flags) {
				return (flags & Flags.METADATA) === Flags.METADATA;
			}
			Flags.hasMetadata = hasMetadata;
			function hasComplete(flags) {
				return (flags & Flags.COMPLETE) === Flags.COMPLETE;
			}
			Flags.hasComplete = hasComplete;
			function hasNext(flags) {
				return (flags & Flags.NEXT) === Flags.NEXT;
			}
			Flags.hasNext = hasNext;
			function hasFollows(flags) {
				return (flags & Flags.FOLLOWS) === Flags.FOLLOWS;
			}
			Flags.hasFollows = hasFollows;
			function hasIgnore(flags) {
				return (flags & Flags.IGNORE) === Flags.IGNORE;
			}
			Flags.hasIgnore = hasIgnore;
			function hasRespond(flags) {
				return (flags & Flags.RESPOND) === Flags.RESPOND;
			}
			Flags.hasRespond = hasRespond;
			function hasLease(flags) {
				return (flags & Flags.LEASE) === Flags.LEASE;
			}
			Flags.hasLease = hasLease;
			function hasResume(flags) {
				return (flags & Flags.RESUME_ENABLE) === Flags.RESUME_ENABLE;
			}
			Flags.hasResume = hasResume;
		})(exports$1.Flags || (exports$1.Flags = {}));
		(function(Lengths) {
			Lengths[Lengths["FRAME"] = 3] = "FRAME";
			Lengths[Lengths["HEADER"] = 6] = "HEADER";
			Lengths[Lengths["METADATA"] = 3] = "METADATA";
			Lengths[Lengths["REQUEST"] = 3] = "REQUEST";
		})(exports$1.Lengths || (exports$1.Lengths = {}));
		(function(Frame) {
			function isConnection(frame) {
				return frame.streamId === 0;
			}
			Frame.isConnection = isConnection;
			function isRequest(frame) {
				return FrameTypes.REQUEST_RESPONSE <= frame.type && frame.type <= FrameTypes.REQUEST_CHANNEL;
			}
			Frame.isRequest = isRequest;
		})(exports$1.Frame || (exports$1.Frame = {}));
	})(Frames);
	return Frames;
}
var hasRequiredCodecs;
function requireCodecs() {
	if (hasRequiredCodecs) return Codecs;
	hasRequiredCodecs = 1;
	(function(exports$1) {
		var __generator = Codecs && Codecs.__generator || function(thisArg, body) {
			var _ = {
				label: 0,
				sent: function() {
					if (t[0] & 1) throw t[1];
					return t[1];
				},
				trys: [],
				ops: []
			}, f, y, t, g;
			return g = {
				next: verb(0),
				"throw": verb(1),
				"return": verb(2)
			}, typeof Symbol === "function" && (g[Symbol.iterator] = function() {
				return this;
			}), g;
			function verb(n) {
				return function(v) {
					return step([n, v]);
				};
			}
			function step(op) {
				if (f) throw new TypeError("Generator is already executing.");
				while (_) try {
					if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
					if (y = 0, t) op = [op[0] & 2, t.value];
					switch (op[0]) {
						case 0:
						case 1:
							t = op;
							break;
						case 4:
							_.label++;
							return {
								value: op[1],
								done: false
							};
						case 5:
							_.label++;
							y = op[1];
							op = [0];
							continue;
						case 7:
							op = _.ops.pop();
							_.trys.pop();
							continue;
						default:
							if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) {
								_ = 0;
								continue;
							}
							if (op[0] === 3 && (!t || op[1] > t[0] && op[1] < t[3])) {
								_.label = op[1];
								break;
							}
							if (op[0] === 6 && _.label < t[1]) {
								_.label = t[1];
								t = op;
								break;
							}
							if (t && _.label < t[2]) {
								_.label = t[2];
								_.ops.push(op);
								break;
							}
							if (t[2]) _.ops.pop();
							_.trys.pop();
							continue;
					}
					op = body.call(thisArg, _);
				} catch (e) {
					op = [6, e];
					y = 0;
				} finally {
					f = t = 0;
				}
				if (op[0] & 5) throw op[1];
				return {
					value: op[0] ? op[1] : void 0,
					done: true
				};
			}
		};
		Object.defineProperty(exports$1, "__esModule", { value: true });
		exports$1.Deserializer = exports$1.sizeOfFrame = exports$1.serializeFrame = exports$1.deserializeFrame = exports$1.serializeFrameWithLength = exports$1.deserializeFrames = exports$1.deserializeFrameWithLength = exports$1.writeUInt64BE = exports$1.readUInt64BE = exports$1.writeUInt24BE = exports$1.readUInt24BE = exports$1.MAX_VERSION = exports$1.MAX_TTL = exports$1.MAX_STREAM_ID = exports$1.MAX_RESUME_LENGTH = exports$1.MAX_REQUEST_N = exports$1.MAX_REQUEST_COUNT = exports$1.MAX_MIME_LENGTH = exports$1.MAX_METADATA_LENGTH = exports$1.MAX_LIFETIME = exports$1.MAX_KEEPALIVE = exports$1.MAX_CODE = exports$1.FRAME_TYPE_OFFFSET = exports$1.FLAGS_MASK = void 0;
		var Frames_1 = requireFrames();
		exports$1.FLAGS_MASK = 1023;
		exports$1.FRAME_TYPE_OFFFSET = 10;
		exports$1.MAX_CODE = 2147483647;
		exports$1.MAX_KEEPALIVE = 2147483647;
		exports$1.MAX_LIFETIME = 2147483647;
		exports$1.MAX_METADATA_LENGTH = 16777215;
		exports$1.MAX_MIME_LENGTH = 255;
		exports$1.MAX_REQUEST_COUNT = 2147483647;
		exports$1.MAX_REQUEST_N = 2147483647;
		exports$1.MAX_RESUME_LENGTH = 65535;
		exports$1.MAX_STREAM_ID = 2147483647;
		exports$1.MAX_TTL = 2147483647;
		exports$1.MAX_VERSION = 65535;
		/**
		* Mimimum value that would overflow bitwise operators (2^32).
		*/
		var BITWISE_OVERFLOW = 4294967296;
		/**
		* Read a uint24 from a buffer starting at the given offset.
		*/
		function readUInt24BE(buffer, offset) {
			var val1 = buffer.readUInt8(offset) << 16;
			var val2 = buffer.readUInt8(offset + 1) << 8;
			var val3 = buffer.readUInt8(offset + 2);
			return val1 | val2 | val3;
		}
		exports$1.readUInt24BE = readUInt24BE;
		/**
		* Writes a uint24 to a buffer starting at the given offset, returning the
		* offset of the next byte.
		*/
		function writeUInt24BE(buffer, value, offset) {
			offset = buffer.writeUInt8(value >>> 16, offset);
			offset = buffer.writeUInt8(value >>> 8 & 255, offset);
			return buffer.writeUInt8(value & 255, offset);
		}
		exports$1.writeUInt24BE = writeUInt24BE;
		/**
		* Read a uint64 (technically supports up to 53 bits per JS number
		* representation).
		*/
		function readUInt64BE(buffer, offset) {
			var high = buffer.readUInt32BE(offset);
			var low = buffer.readUInt32BE(offset + 4);
			return high * BITWISE_OVERFLOW + low;
		}
		exports$1.readUInt64BE = readUInt64BE;
		/**
		* Write a uint64 (technically supports up to 53 bits per JS number
		* representation).
		*/
		function writeUInt64BE(buffer, value, offset) {
			var high = value / BITWISE_OVERFLOW | 0;
			var low = value % BITWISE_OVERFLOW;
			offset = buffer.writeUInt32BE(high, offset);
			return buffer.writeUInt32BE(low, offset);
		}
		exports$1.writeUInt64BE = writeUInt64BE;
		/**
		* Frame header is:
		* - stream id (uint32 = 4)
		* - type + flags (uint 16 = 2)
		*/
		var FRAME_HEADER_SIZE = 6;
		/**
		* Size of frame length and metadata length fields.
		*/
		var UINT24_SIZE = 3;
		/**
		* Reads a frame from a buffer that is prefixed with the frame length.
		*/
		function deserializeFrameWithLength(buffer) {
			var frameLength = readUInt24BE(buffer, 0);
			return deserializeFrame(buffer.slice(UINT24_SIZE, UINT24_SIZE + frameLength));
		}
		exports$1.deserializeFrameWithLength = deserializeFrameWithLength;
		/**
		* Given a buffer that may contain zero or more length-prefixed frames followed
		* by zero or more bytes of a (partial) subsequent frame, returns an array of
		* the frames and an int representing the buffer offset.
		*/
		function deserializeFrames(buffer) {
			var offset, frameLength, frameStart, frameEnd, frameBuffer, frame;
			return __generator(this, function(_a) {
				switch (_a.label) {
					case 0:
						offset = 0;
						_a.label = 1;
					case 1:
						if (!(offset + UINT24_SIZE < buffer.length)) return [3, 3];
						frameLength = readUInt24BE(buffer, offset);
						frameStart = offset + UINT24_SIZE;
						frameEnd = frameStart + frameLength;
						if (frameEnd > buffer.length) return [3, 3];
						frameBuffer = buffer.slice(frameStart, frameEnd);
						frame = deserializeFrame(frameBuffer);
						offset = frameEnd;
						return [4, [frame, offset]];
					case 2:
						_a.sent();
						return [3, 1];
					case 3: return [2];
				}
			});
		}
		exports$1.deserializeFrames = deserializeFrames;
		/**
		* Writes a frame to a buffer with a length prefix.
		*/
		function serializeFrameWithLength(frame) {
			var buffer = serializeFrame(frame);
			var lengthPrefixed = bufferExports.Buffer.allocUnsafe(buffer.length + UINT24_SIZE);
			writeUInt24BE(lengthPrefixed, buffer.length, 0);
			buffer.copy(lengthPrefixed, UINT24_SIZE);
			return lengthPrefixed;
		}
		exports$1.serializeFrameWithLength = serializeFrameWithLength;
		/**
		* Read a frame from the buffer.
		*/
		function deserializeFrame(buffer) {
			var offset = 0;
			var streamId = buffer.readInt32BE(offset);
			offset += 4;
			var typeAndFlags = buffer.readUInt16BE(offset);
			offset += 2;
			var type = typeAndFlags >>> exports$1.FRAME_TYPE_OFFFSET;
			var flags = typeAndFlags & exports$1.FLAGS_MASK;
			switch (type) {
				case Frames_1.FrameTypes.SETUP: return deserializeSetupFrame(buffer, streamId, flags);
				case Frames_1.FrameTypes.PAYLOAD: return deserializePayloadFrame(buffer, streamId, flags);
				case Frames_1.FrameTypes.ERROR: return deserializeErrorFrame(buffer, streamId, flags);
				case Frames_1.FrameTypes.KEEPALIVE: return deserializeKeepAliveFrame(buffer, streamId, flags);
				case Frames_1.FrameTypes.REQUEST_FNF: return deserializeRequestFnfFrame(buffer, streamId, flags);
				case Frames_1.FrameTypes.REQUEST_RESPONSE: return deserializeRequestResponseFrame(buffer, streamId, flags);
				case Frames_1.FrameTypes.REQUEST_STREAM: return deserializeRequestStreamFrame(buffer, streamId, flags);
				case Frames_1.FrameTypes.REQUEST_CHANNEL: return deserializeRequestChannelFrame(buffer, streamId, flags);
				case Frames_1.FrameTypes.METADATA_PUSH: return deserializeMetadataPushFrame(buffer, streamId, flags);
				case Frames_1.FrameTypes.REQUEST_N: return deserializeRequestNFrame(buffer, streamId, flags);
				case Frames_1.FrameTypes.RESUME: return deserializeResumeFrame(buffer, streamId, flags);
				case Frames_1.FrameTypes.RESUME_OK: return deserializeResumeOkFrame(buffer, streamId, flags);
				case Frames_1.FrameTypes.CANCEL: return deserializeCancelFrame(buffer, streamId, flags);
				case Frames_1.FrameTypes.LEASE: return deserializeLeaseFrame(buffer, streamId, flags);
			}
		}
		exports$1.deserializeFrame = deserializeFrame;
		/**
		* Convert the frame to a (binary) buffer.
		*/
		function serializeFrame(frame) {
			switch (frame.type) {
				case Frames_1.FrameTypes.SETUP: return serializeSetupFrame(frame);
				case Frames_1.FrameTypes.PAYLOAD: return serializePayloadFrame(frame);
				case Frames_1.FrameTypes.ERROR: return serializeErrorFrame(frame);
				case Frames_1.FrameTypes.KEEPALIVE: return serializeKeepAliveFrame(frame);
				case Frames_1.FrameTypes.REQUEST_FNF:
				case Frames_1.FrameTypes.REQUEST_RESPONSE: return serializeRequestFrame(frame);
				case Frames_1.FrameTypes.REQUEST_STREAM:
				case Frames_1.FrameTypes.REQUEST_CHANNEL: return serializeRequestManyFrame(frame);
				case Frames_1.FrameTypes.METADATA_PUSH: return serializeMetadataPushFrame(frame);
				case Frames_1.FrameTypes.REQUEST_N: return serializeRequestNFrame(frame);
				case Frames_1.FrameTypes.RESUME: return serializeResumeFrame(frame);
				case Frames_1.FrameTypes.RESUME_OK: return serializeResumeOkFrame(frame);
				case Frames_1.FrameTypes.CANCEL: return serializeCancelFrame(frame);
				case Frames_1.FrameTypes.LEASE: return serializeLeaseFrame(frame);
			}
		}
		exports$1.serializeFrame = serializeFrame;
		/**
		* Byte size of frame without size prefix
		*/
		function sizeOfFrame(frame) {
			switch (frame.type) {
				case Frames_1.FrameTypes.SETUP: return sizeOfSetupFrame(frame);
				case Frames_1.FrameTypes.PAYLOAD: return sizeOfPayloadFrame(frame);
				case Frames_1.FrameTypes.ERROR: return sizeOfErrorFrame(frame);
				case Frames_1.FrameTypes.KEEPALIVE: return sizeOfKeepAliveFrame(frame);
				case Frames_1.FrameTypes.REQUEST_FNF:
				case Frames_1.FrameTypes.REQUEST_RESPONSE: return sizeOfRequestFrame(frame);
				case Frames_1.FrameTypes.REQUEST_STREAM:
				case Frames_1.FrameTypes.REQUEST_CHANNEL: return sizeOfRequestManyFrame(frame);
				case Frames_1.FrameTypes.METADATA_PUSH: return sizeOfMetadataPushFrame(frame);
				case Frames_1.FrameTypes.REQUEST_N: return sizeOfRequestNFrame();
				case Frames_1.FrameTypes.RESUME: return sizeOfResumeFrame(frame);
				case Frames_1.FrameTypes.RESUME_OK: return sizeOfResumeOkFrame();
				case Frames_1.FrameTypes.CANCEL: return sizeOfCancelFrame();
				case Frames_1.FrameTypes.LEASE: return sizeOfLeaseFrame(frame);
			}
		}
		exports$1.sizeOfFrame = sizeOfFrame;
		/**
		* Writes a SETUP frame into a new buffer and returns it.
		*
		* Prefix size is:
		* - version (2x uint16 = 4)
		* - keepalive (uint32 = 4)
		* - lifetime (uint32 = 4)
		* - mime lengths (2x uint8 = 2)
		*/
		var SETUP_FIXED_SIZE = 14;
		var RESUME_TOKEN_LENGTH_SIZE = 2;
		function serializeSetupFrame(frame) {
			var resumeTokenLength = frame.resumeToken != null ? frame.resumeToken.byteLength : 0;
			var metadataMimeTypeLength = frame.metadataMimeType != null ? bufferExports.Buffer.byteLength(frame.metadataMimeType, "ascii") : 0;
			var dataMimeTypeLength = frame.dataMimeType != null ? bufferExports.Buffer.byteLength(frame.dataMimeType, "ascii") : 0;
			var payloadLength = getPayloadLength(frame);
			var buffer = bufferExports.Buffer.allocUnsafe(FRAME_HEADER_SIZE + SETUP_FIXED_SIZE + (resumeTokenLength ? RESUME_TOKEN_LENGTH_SIZE + resumeTokenLength : 0) + metadataMimeTypeLength + dataMimeTypeLength + payloadLength);
			var offset = writeHeader(frame, buffer);
			offset = buffer.writeUInt16BE(frame.majorVersion, offset);
			offset = buffer.writeUInt16BE(frame.minorVersion, offset);
			offset = buffer.writeUInt32BE(frame.keepAlive, offset);
			offset = buffer.writeUInt32BE(frame.lifetime, offset);
			if (frame.flags & Frames_1.Flags.RESUME_ENABLE) {
				offset = buffer.writeUInt16BE(resumeTokenLength, offset);
				if (frame.resumeToken != null) offset += frame.resumeToken.copy(buffer, offset);
			}
			offset = buffer.writeUInt8(metadataMimeTypeLength, offset);
			if (frame.metadataMimeType != null) offset += buffer.write(frame.metadataMimeType, offset, offset + metadataMimeTypeLength, "ascii");
			offset = buffer.writeUInt8(dataMimeTypeLength, offset);
			if (frame.dataMimeType != null) offset += buffer.write(frame.dataMimeType, offset, offset + dataMimeTypeLength, "ascii");
			writePayload(frame, buffer, offset);
			return buffer;
		}
		function sizeOfSetupFrame(frame) {
			var resumeTokenLength = frame.resumeToken != null ? frame.resumeToken.byteLength : 0;
			var metadataMimeTypeLength = frame.metadataMimeType != null ? bufferExports.Buffer.byteLength(frame.metadataMimeType, "ascii") : 0;
			var dataMimeTypeLength = frame.dataMimeType != null ? bufferExports.Buffer.byteLength(frame.dataMimeType, "ascii") : 0;
			var payloadLength = getPayloadLength(frame);
			return FRAME_HEADER_SIZE + SETUP_FIXED_SIZE + (resumeTokenLength ? RESUME_TOKEN_LENGTH_SIZE + resumeTokenLength : 0) + metadataMimeTypeLength + dataMimeTypeLength + payloadLength;
		}
		/**
		* Reads a SETUP frame from the buffer and returns it.
		*/
		function deserializeSetupFrame(buffer, streamId, flags) {
			buffer.length;
			var offset = FRAME_HEADER_SIZE;
			var majorVersion = buffer.readUInt16BE(offset);
			offset += 2;
			var minorVersion = buffer.readUInt16BE(offset);
			offset += 2;
			var keepAlive = buffer.readInt32BE(offset);
			offset += 4;
			var lifetime = buffer.readInt32BE(offset);
			offset += 4;
			var resumeToken = null;
			if (flags & Frames_1.Flags.RESUME_ENABLE) {
				var resumeTokenLength = buffer.readInt16BE(offset);
				offset += 2;
				resumeToken = buffer.slice(offset, offset + resumeTokenLength);
				offset += resumeTokenLength;
			}
			var metadataMimeTypeLength = buffer.readUInt8(offset);
			offset += 1;
			var metadataMimeType = buffer.toString("ascii", offset, offset + metadataMimeTypeLength);
			offset += metadataMimeTypeLength;
			var dataMimeTypeLength = buffer.readUInt8(offset);
			offset += 1;
			var dataMimeType = buffer.toString("ascii", offset, offset + dataMimeTypeLength);
			offset += dataMimeTypeLength;
			var frame = {
				data: null,
				dataMimeType,
				flags,
				keepAlive,
				lifetime,
				majorVersion,
				metadata: null,
				metadataMimeType,
				minorVersion,
				resumeToken,
				streamId: 0,
				type: Frames_1.FrameTypes.SETUP
			};
			readPayload(buffer, frame, offset);
			return frame;
		}
		/**
		* Writes an ERROR frame into a new buffer and returns it.
		*
		* Prefix size is for the error code (uint32 = 4).
		*/
		var ERROR_FIXED_SIZE = 4;
		function serializeErrorFrame(frame) {
			var messageLength = frame.message != null ? bufferExports.Buffer.byteLength(frame.message, "utf8") : 0;
			var buffer = bufferExports.Buffer.allocUnsafe(FRAME_HEADER_SIZE + ERROR_FIXED_SIZE + messageLength);
			var offset = writeHeader(frame, buffer);
			offset = buffer.writeUInt32BE(frame.code, offset);
			if (frame.message != null) buffer.write(frame.message, offset, offset + messageLength, "utf8");
			return buffer;
		}
		function sizeOfErrorFrame(frame) {
			var messageLength = frame.message != null ? bufferExports.Buffer.byteLength(frame.message, "utf8") : 0;
			return FRAME_HEADER_SIZE + ERROR_FIXED_SIZE + messageLength;
		}
		/**
		* Reads an ERROR frame from the buffer and returns it.
		*/
		function deserializeErrorFrame(buffer, streamId, flags) {
			buffer.length;
			var offset = FRAME_HEADER_SIZE;
			var code = buffer.readInt32BE(offset);
			offset += 4;
			var messageLength = buffer.length - offset;
			var message = "";
			if (messageLength > 0) {
				message = buffer.toString("utf8", offset, offset + messageLength);
				offset += messageLength;
			}
			return {
				code,
				flags,
				message,
				streamId,
				type: Frames_1.FrameTypes.ERROR
			};
		}
		/**
		* Writes a KEEPALIVE frame into a new buffer and returns it.
		*
		* Prefix size is for the last received position (uint64 = 8).
		*/
		var KEEPALIVE_FIXED_SIZE = 8;
		function serializeKeepAliveFrame(frame) {
			var dataLength = frame.data != null ? frame.data.byteLength : 0;
			var buffer = bufferExports.Buffer.allocUnsafe(FRAME_HEADER_SIZE + KEEPALIVE_FIXED_SIZE + dataLength);
			var offset = writeHeader(frame, buffer);
			offset = writeUInt64BE(buffer, frame.lastReceivedPosition, offset);
			if (frame.data != null) frame.data.copy(buffer, offset);
			return buffer;
		}
		function sizeOfKeepAliveFrame(frame) {
			var dataLength = frame.data != null ? frame.data.byteLength : 0;
			return FRAME_HEADER_SIZE + KEEPALIVE_FIXED_SIZE + dataLength;
		}
		/**
		* Reads a KEEPALIVE frame from the buffer and returns it.
		*/
		function deserializeKeepAliveFrame(buffer, streamId, flags) {
			buffer.length;
			var offset = FRAME_HEADER_SIZE;
			var lastReceivedPosition = readUInt64BE(buffer, offset);
			offset += 8;
			var data = null;
			if (offset < buffer.length) data = buffer.slice(offset, buffer.length);
			return {
				data,
				flags,
				lastReceivedPosition,
				streamId: 0,
				type: Frames_1.FrameTypes.KEEPALIVE
			};
		}
		/**
		* Writes a LEASE frame into a new buffer and returns it.
		*
		* Prefix size is for the ttl (uint32) and requestcount (uint32).
		*/
		var LEASE_FIXED_SIZE = 8;
		function serializeLeaseFrame(frame) {
			var metaLength = frame.metadata != null ? frame.metadata.byteLength : 0;
			var buffer = bufferExports.Buffer.allocUnsafe(FRAME_HEADER_SIZE + LEASE_FIXED_SIZE + metaLength);
			var offset = writeHeader(frame, buffer);
			offset = buffer.writeUInt32BE(frame.ttl, offset);
			offset = buffer.writeUInt32BE(frame.requestCount, offset);
			if (frame.metadata != null) frame.metadata.copy(buffer, offset);
			return buffer;
		}
		function sizeOfLeaseFrame(frame) {
			var metaLength = frame.metadata != null ? frame.metadata.byteLength : 0;
			return FRAME_HEADER_SIZE + LEASE_FIXED_SIZE + metaLength;
		}
		/**
		* Reads a LEASE frame from the buffer and returns it.
		*/
		function deserializeLeaseFrame(buffer, streamId, flags) {
			var offset = FRAME_HEADER_SIZE;
			var ttl = buffer.readUInt32BE(offset);
			offset += 4;
			var requestCount = buffer.readUInt32BE(offset);
			offset += 4;
			var metadata = null;
			if (offset < buffer.length) metadata = buffer.slice(offset, buffer.length);
			return {
				flags,
				metadata,
				requestCount,
				streamId: 0,
				ttl,
				type: Frames_1.FrameTypes.LEASE
			};
		}
		/**
		* Writes a REQUEST_FNF or REQUEST_RESPONSE frame to a new buffer and returns
		* it.
		*
		* Note that these frames have the same shape and only differ in their type.
		*/
		function serializeRequestFrame(frame) {
			var payloadLength = getPayloadLength(frame);
			var buffer = bufferExports.Buffer.allocUnsafe(FRAME_HEADER_SIZE + payloadLength);
			writePayload(frame, buffer, writeHeader(frame, buffer));
			return buffer;
		}
		function sizeOfRequestFrame(frame) {
			return FRAME_HEADER_SIZE + getPayloadLength(frame);
		}
		/**
		* Writes a METADATA_PUSH frame to a new buffer and returns
		* it.
		*/
		function serializeMetadataPushFrame(frame) {
			var metadata = frame.metadata;
			if (metadata != null) {
				var buffer = bufferExports.Buffer.allocUnsafe(FRAME_HEADER_SIZE + metadata.byteLength);
				var offset = writeHeader(frame, buffer);
				metadata.copy(buffer, offset);
				return buffer;
			} else {
				var buffer = bufferExports.Buffer.allocUnsafe(FRAME_HEADER_SIZE);
				writeHeader(frame, buffer);
				return buffer;
			}
		}
		function sizeOfMetadataPushFrame(frame) {
			return FRAME_HEADER_SIZE + (frame.metadata != null ? frame.metadata.byteLength : 0);
		}
		function deserializeRequestFnfFrame(buffer, streamId, flags) {
			buffer.length;
			var frame = {
				data: null,
				flags,
				metadata: null,
				streamId,
				type: Frames_1.FrameTypes.REQUEST_FNF
			};
			readPayload(buffer, frame, FRAME_HEADER_SIZE);
			return frame;
		}
		function deserializeRequestResponseFrame(buffer, streamId, flags) {
			var frame = {
				data: null,
				flags,
				metadata: null,
				streamId,
				type: Frames_1.FrameTypes.REQUEST_RESPONSE
			};
			readPayload(buffer, frame, FRAME_HEADER_SIZE);
			return frame;
		}
		function deserializeMetadataPushFrame(buffer, streamId, flags) {
			return {
				flags,
				metadata: length === FRAME_HEADER_SIZE ? null : buffer.slice(FRAME_HEADER_SIZE, length),
				streamId: 0,
				type: Frames_1.FrameTypes.METADATA_PUSH
			};
		}
		/**
		* Writes a REQUEST_STREAM or REQUEST_CHANNEL frame to a new buffer and returns
		* it.
		*
		* Note that these frames have the same shape and only differ in their type.
		*
		* Prefix size is for requestN (uint32 = 4).
		*/
		var REQUEST_MANY_HEADER = 4;
		function serializeRequestManyFrame(frame) {
			var payloadLength = getPayloadLength(frame);
			var buffer = bufferExports.Buffer.allocUnsafe(FRAME_HEADER_SIZE + REQUEST_MANY_HEADER + payloadLength);
			var offset = writeHeader(frame, buffer);
			offset = buffer.writeUInt32BE(frame.requestN, offset);
			writePayload(frame, buffer, offset);
			return buffer;
		}
		function sizeOfRequestManyFrame(frame) {
			var payloadLength = getPayloadLength(frame);
			return FRAME_HEADER_SIZE + REQUEST_MANY_HEADER + payloadLength;
		}
		function deserializeRequestStreamFrame(buffer, streamId, flags) {
			buffer.length;
			var offset = FRAME_HEADER_SIZE;
			var requestN = buffer.readInt32BE(offset);
			offset += 4;
			var frame = {
				data: null,
				flags,
				metadata: null,
				requestN,
				streamId,
				type: Frames_1.FrameTypes.REQUEST_STREAM
			};
			readPayload(buffer, frame, offset);
			return frame;
		}
		function deserializeRequestChannelFrame(buffer, streamId, flags) {
			buffer.length;
			var offset = FRAME_HEADER_SIZE;
			var requestN = buffer.readInt32BE(offset);
			offset += 4;
			var frame = {
				data: null,
				flags,
				metadata: null,
				requestN,
				streamId,
				type: Frames_1.FrameTypes.REQUEST_CHANNEL
			};
			readPayload(buffer, frame, offset);
			return frame;
		}
		/**
		* Writes a REQUEST_N frame to a new buffer and returns it.
		*
		* Prefix size is for requestN (uint32 = 4).
		*/
		var REQUEST_N_HEADER = 4;
		function serializeRequestNFrame(frame) {
			var buffer = bufferExports.Buffer.allocUnsafe(FRAME_HEADER_SIZE + REQUEST_N_HEADER);
			var offset = writeHeader(frame, buffer);
			buffer.writeUInt32BE(frame.requestN, offset);
			return buffer;
		}
		function sizeOfRequestNFrame(frame) {
			return FRAME_HEADER_SIZE + REQUEST_N_HEADER;
		}
		function deserializeRequestNFrame(buffer, streamId, flags) {
			buffer.length;
			return {
				flags,
				requestN: buffer.readInt32BE(FRAME_HEADER_SIZE),
				streamId,
				type: Frames_1.FrameTypes.REQUEST_N
			};
		}
		/**
		* Writes a CANCEL frame to a new buffer and returns it.
		*/
		function serializeCancelFrame(frame) {
			var buffer = bufferExports.Buffer.allocUnsafe(FRAME_HEADER_SIZE);
			writeHeader(frame, buffer);
			return buffer;
		}
		function sizeOfCancelFrame(frame) {
			return FRAME_HEADER_SIZE;
		}
		function deserializeCancelFrame(buffer, streamId, flags) {
			buffer.length;
			return {
				flags,
				streamId,
				type: Frames_1.FrameTypes.CANCEL
			};
		}
		/**
		* Writes a PAYLOAD frame to a new buffer and returns it.
		*/
		function serializePayloadFrame(frame) {
			var payloadLength = getPayloadLength(frame);
			var buffer = bufferExports.Buffer.allocUnsafe(FRAME_HEADER_SIZE + payloadLength);
			writePayload(frame, buffer, writeHeader(frame, buffer));
			return buffer;
		}
		function sizeOfPayloadFrame(frame) {
			return FRAME_HEADER_SIZE + getPayloadLength(frame);
		}
		function deserializePayloadFrame(buffer, streamId, flags) {
			buffer.length;
			var frame = {
				data: null,
				flags,
				metadata: null,
				streamId,
				type: Frames_1.FrameTypes.PAYLOAD
			};
			readPayload(buffer, frame, FRAME_HEADER_SIZE);
			return frame;
		}
		/**
		* Writes a RESUME frame into a new buffer and returns it.
		*
		* Fixed size is:
		* - major version (uint16 = 2)
		* - minor version (uint16 = 2)
		* - token length (uint16 = 2)
		* - client position (uint64 = 8)
		* - server position (uint64 = 8)
		*/
		var RESUME_FIXED_SIZE = 22;
		function serializeResumeFrame(frame) {
			var resumeTokenLength = frame.resumeToken.byteLength;
			var buffer = bufferExports.Buffer.allocUnsafe(FRAME_HEADER_SIZE + RESUME_FIXED_SIZE + resumeTokenLength);
			var offset = writeHeader(frame, buffer);
			offset = buffer.writeUInt16BE(frame.majorVersion, offset);
			offset = buffer.writeUInt16BE(frame.minorVersion, offset);
			offset = buffer.writeUInt16BE(resumeTokenLength, offset);
			offset += frame.resumeToken.copy(buffer, offset);
			offset = writeUInt64BE(buffer, frame.serverPosition, offset);
			writeUInt64BE(buffer, frame.clientPosition, offset);
			return buffer;
		}
		function sizeOfResumeFrame(frame) {
			var resumeTokenLength = frame.resumeToken.byteLength;
			return FRAME_HEADER_SIZE + RESUME_FIXED_SIZE + resumeTokenLength;
		}
		function deserializeResumeFrame(buffer, streamId, flags) {
			buffer.length;
			var offset = FRAME_HEADER_SIZE;
			var majorVersion = buffer.readUInt16BE(offset);
			offset += 2;
			var minorVersion = buffer.readUInt16BE(offset);
			offset += 2;
			var resumeTokenLength = buffer.readInt16BE(offset);
			offset += 2;
			var resumeToken = buffer.slice(offset, offset + resumeTokenLength);
			offset += resumeTokenLength;
			var serverPosition = readUInt64BE(buffer, offset);
			offset += 8;
			var clientPosition = readUInt64BE(buffer, offset);
			offset += 8;
			return {
				clientPosition,
				flags,
				majorVersion,
				minorVersion,
				resumeToken,
				serverPosition,
				streamId: 0,
				type: Frames_1.FrameTypes.RESUME
			};
		}
		/**
		* Writes a RESUME_OK frame into a new buffer and returns it.
		*
		* Fixed size is:
		* - client position (uint64 = 8)
		*/
		var RESUME_OK_FIXED_SIZE = 8;
		function serializeResumeOkFrame(frame) {
			var buffer = bufferExports.Buffer.allocUnsafe(FRAME_HEADER_SIZE + RESUME_OK_FIXED_SIZE);
			var offset = writeHeader(frame, buffer);
			writeUInt64BE(buffer, frame.clientPosition, offset);
			return buffer;
		}
		function sizeOfResumeOkFrame(frame) {
			return FRAME_HEADER_SIZE + RESUME_OK_FIXED_SIZE;
		}
		function deserializeResumeOkFrame(buffer, streamId, flags) {
			buffer.length;
			return {
				clientPosition: readUInt64BE(buffer, FRAME_HEADER_SIZE),
				flags,
				streamId: 0,
				type: Frames_1.FrameTypes.RESUME_OK
			};
		}
		/**
		* Write the header of the frame into the buffer.
		*/
		function writeHeader(frame, buffer) {
			var offset = buffer.writeInt32BE(frame.streamId, 0);
			return buffer.writeUInt16BE(frame.type << exports$1.FRAME_TYPE_OFFFSET | frame.flags & exports$1.FLAGS_MASK, offset);
		}
		/**
		* Determine the length of the payload section of a frame. Only applies to
		* frame types that MAY have both metadata and data.
		*/
		function getPayloadLength(frame) {
			var payloadLength = 0;
			if (frame.data != null) payloadLength += frame.data.byteLength;
			if (Frames_1.Flags.hasMetadata(frame.flags)) {
				payloadLength += UINT24_SIZE;
				if (frame.metadata != null) payloadLength += frame.metadata.byteLength;
			}
			return payloadLength;
		}
		/**
		* Write the payload of a frame into the given buffer. Only applies to frame
		* types that MAY have both metadata and data.
		*/
		function writePayload(frame, buffer, offset) {
			if (Frames_1.Flags.hasMetadata(frame.flags)) if (frame.metadata != null) {
				var metaLength = frame.metadata.byteLength;
				offset = writeUInt24BE(buffer, metaLength, offset);
				offset += frame.metadata.copy(buffer, offset);
			} else offset = writeUInt24BE(buffer, 0, offset);
			if (frame.data != null) frame.data.copy(buffer, offset);
		}
		/**
		* Read the payload from a buffer and write it into the frame. Only applies to
		* frame types that MAY have both metadata and data.
		*/
		function readPayload(buffer, frame, offset) {
			if (Frames_1.Flags.hasMetadata(frame.flags)) {
				var metaLength = readUInt24BE(buffer, offset);
				offset += UINT24_SIZE;
				if (metaLength > 0) {
					frame.metadata = buffer.slice(offset, offset + metaLength);
					offset += metaLength;
				}
			}
			if (offset < buffer.length) frame.data = buffer.slice(offset, buffer.length);
		}
		exports$1.Deserializer = function() {
			function Deserializer() {}
			/**
			* Read a frame from the buffer.
			*/
			Deserializer.prototype.deserializeFrame = function(buffer) {
				return deserializeFrame(buffer);
			};
			/**
			* Reads a frame from a buffer that is prefixed with the frame length.
			*/
			Deserializer.prototype.deserializeFrameWithLength = function(buffer) {
				return deserializeFrameWithLength(buffer);
			};
			/**
			* Given a buffer that may contain zero or more length-prefixed frames followed
			* by zero or more bytes of a (partial) subsequent frame, returns an array of
			* the frames and a int representing the buffer offset.
			*/
			Deserializer.prototype.deserializeFrames = function(buffer) {
				return deserializeFrames(buffer);
			};
			return Deserializer;
		}();
	})(Codecs);
	return Codecs;
}
var Common = {};
var hasRequiredCommon;
function requireCommon() {
	if (hasRequiredCommon) return Common;
	hasRequiredCommon = 1;
	Object.defineProperty(Common, "__esModule", { value: true });
	return Common;
}
var Deferred = {};
var hasRequiredDeferred;
function requireDeferred() {
	if (hasRequiredDeferred) return Deferred;
	hasRequiredDeferred = 1;
	var __values = Deferred && Deferred.__values || function(o) {
		var s = typeof Symbol === "function" && Symbol.iterator, m = s && o[s], i = 0;
		if (m) return m.call(o);
		if (o && typeof o.length === "number") return { next: function() {
			if (o && i >= o.length) o = void 0;
			return {
				value: o && o[i++],
				done: !o
			};
		} };
		throw new TypeError(s ? "Object is not iterable." : "Symbol.iterator is not defined.");
	};
	Object.defineProperty(Deferred, "__esModule", { value: true });
	Deferred.Deferred = void 0;
	Deferred.Deferred = function() {
		function Deferred() {
			this._done = false;
			this.onCloseCallbacks = [];
		}
		Object.defineProperty(Deferred.prototype, "done", {
			get: function() {
				return this._done;
			},
			enumerable: false,
			configurable: true
		});
		/**
		* Signals to an observer that the Deferred operation has been closed, which invokes
		* the provided `onClose` callback.
		*/
		Deferred.prototype.close = function(error) {
			var e_1, _a, e_2, _b;
			if (this.done) {
				console.warn("Trying to close for the second time. ".concat(error ? "Dropping error [".concat(error, "].") : ""));
				return;
			}
			this._done = true;
			this._error = error;
			if (error) {
				try {
					for (var _c = __values(this.onCloseCallbacks), _d = _c.next(); !_d.done; _d = _c.next()) {
						var callback = _d.value;
						callback(error);
					}
				} catch (e_1_1) {
					e_1 = { error: e_1_1 };
				} finally {
					try {
						if (_d && !_d.done && (_a = _c.return)) _a.call(_c);
					} finally {
						if (e_1) throw e_1.error;
					}
				}
				return;
			}
			try {
				for (var _e = __values(this.onCloseCallbacks), _f = _e.next(); !_f.done; _f = _e.next()) {
					var callback = _f.value;
					callback();
				}
			} catch (e_2_1) {
				e_2 = { error: e_2_1 };
			} finally {
				try {
					if (_f && !_f.done && (_b = _e.return)) _b.call(_e);
				} finally {
					if (e_2) throw e_2.error;
				}
			}
		};
		/**
		* Registers a callback to be called when the Closeable is closed. optionally with an Error.
		*/
		Deferred.prototype.onClose = function(callback) {
			if (this._done) {
				callback(this._error);
				return;
			}
			this.onCloseCallbacks.push(callback);
		};
		return Deferred;
	}();
	return Deferred;
}
var Errors = {};
var hasRequiredErrors;
function requireErrors() {
	if (hasRequiredErrors) return Errors;
	hasRequiredErrors = 1;
	(function(exports$1) {
		var __extends = Errors && Errors.__extends || (function() {
			var extendStatics = function(d, b) {
				extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d, b) {
					d.__proto__ = b;
				} || function(d, b) {
					for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p];
				};
				return extendStatics(d, b);
			};
			return function(d, b) {
				if (typeof b !== "function" && b !== null) throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
				extendStatics(d, b);
				function __() {
					this.constructor = d;
				}
				d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
			};
		})();
		Object.defineProperty(exports$1, "__esModule", { value: true });
		exports$1.ErrorCodes = exports$1.RSocketError = void 0;
		exports$1.RSocketError = function(_super) {
			__extends(RSocketError, _super);
			function RSocketError(code, message) {
				var _this = _super.call(this, message) || this;
				_this.code = code;
				return _this;
			}
			return RSocketError;
		}(Error);
		(function(ErrorCodes) {
			ErrorCodes[ErrorCodes["RESERVED"] = 0] = "RESERVED";
			ErrorCodes[ErrorCodes["INVALID_SETUP"] = 1] = "INVALID_SETUP";
			ErrorCodes[ErrorCodes["UNSUPPORTED_SETUP"] = 2] = "UNSUPPORTED_SETUP";
			ErrorCodes[ErrorCodes["REJECTED_SETUP"] = 3] = "REJECTED_SETUP";
			ErrorCodes[ErrorCodes["REJECTED_RESUME"] = 4] = "REJECTED_RESUME";
			ErrorCodes[ErrorCodes["CONNECTION_CLOSE"] = 258] = "CONNECTION_CLOSE";
			ErrorCodes[ErrorCodes["CONNECTION_ERROR"] = 257] = "CONNECTION_ERROR";
			ErrorCodes[ErrorCodes["APPLICATION_ERROR"] = 513] = "APPLICATION_ERROR";
			ErrorCodes[ErrorCodes["REJECTED"] = 514] = "REJECTED";
			ErrorCodes[ErrorCodes["CANCELED"] = 515] = "CANCELED";
			ErrorCodes[ErrorCodes["INVALID"] = 516] = "INVALID";
			ErrorCodes[ErrorCodes["RESERVED_EXTENSION"] = 4294967295] = "RESERVED_EXTENSION";
		})(exports$1.ErrorCodes || (exports$1.ErrorCodes = {}));
	})(Errors);
	return Errors;
}
var RSocket = {};
var hasRequiredRSocket;
function requireRSocket() {
	if (hasRequiredRSocket) return RSocket;
	hasRequiredRSocket = 1;
	Object.defineProperty(RSocket, "__esModule", { value: true });
	return RSocket;
}
var RSocketConnector = {};
var ClientServerMultiplexerDemultiplexer = {};
var hasRequiredClientServerMultiplexerDemultiplexer;
function requireClientServerMultiplexerDemultiplexer() {
	if (hasRequiredClientServerMultiplexerDemultiplexer) return ClientServerMultiplexerDemultiplexer;
	hasRequiredClientServerMultiplexerDemultiplexer = 1;
	(function(exports$1) {
		var __extends = ClientServerMultiplexerDemultiplexer && ClientServerMultiplexerDemultiplexer.__extends || (function() {
			var extendStatics = function(d, b) {
				extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d, b) {
					d.__proto__ = b;
				} || function(d, b) {
					for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p];
				};
				return extendStatics(d, b);
			};
			return function(d, b) {
				if (typeof b !== "function" && b !== null) throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
				extendStatics(d, b);
				function __() {
					this.constructor = d;
				}
				d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
			};
		})();
		var __awaiter = ClientServerMultiplexerDemultiplexer && ClientServerMultiplexerDemultiplexer.__awaiter || function(thisArg, _arguments, P, generator) {
			function adopt(value) {
				return value instanceof P ? value : new P(function(resolve) {
					resolve(value);
				});
			}
			return new (P || (P = Promise))(function(resolve, reject) {
				function fulfilled(value) {
					try {
						step(generator.next(value));
					} catch (e) {
						reject(e);
					}
				}
				function rejected(value) {
					try {
						step(generator["throw"](value));
					} catch (e) {
						reject(e);
					}
				}
				function step(result) {
					result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);
				}
				step((generator = generator.apply(thisArg, _arguments || [])).next());
			});
		};
		var __generator = ClientServerMultiplexerDemultiplexer && ClientServerMultiplexerDemultiplexer.__generator || function(thisArg, body) {
			var _ = {
				label: 0,
				sent: function() {
					if (t[0] & 1) throw t[1];
					return t[1];
				},
				trys: [],
				ops: []
			}, f, y, t, g;
			return g = {
				next: verb(0),
				"throw": verb(1),
				"return": verb(2)
			}, typeof Symbol === "function" && (g[Symbol.iterator] = function() {
				return this;
			}), g;
			function verb(n) {
				return function(v) {
					return step([n, v]);
				};
			}
			function step(op) {
				if (f) throw new TypeError("Generator is already executing.");
				while (_) try {
					if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
					if (y = 0, t) op = [op[0] & 2, t.value];
					switch (op[0]) {
						case 0:
						case 1:
							t = op;
							break;
						case 4:
							_.label++;
							return {
								value: op[1],
								done: false
							};
						case 5:
							_.label++;
							y = op[1];
							op = [0];
							continue;
						case 7:
							op = _.ops.pop();
							_.trys.pop();
							continue;
						default:
							if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) {
								_ = 0;
								continue;
							}
							if (op[0] === 3 && (!t || op[1] > t[0] && op[1] < t[3])) {
								_.label = op[1];
								break;
							}
							if (op[0] === 6 && _.label < t[1]) {
								_.label = t[1];
								t = op;
								break;
							}
							if (t && _.label < t[2]) {
								_.label = t[2];
								_.ops.push(op);
								break;
							}
							if (t[2]) _.ops.pop();
							_.trys.pop();
							continue;
					}
					op = body.call(thisArg, _);
				} catch (e) {
					op = [6, e];
					y = 0;
				} finally {
					f = t = 0;
				}
				if (op[0] & 5) throw op[1];
				return {
					value: op[0] ? op[1] : void 0,
					done: true
				};
			}
		};
		Object.defineProperty(exports$1, "__esModule", { value: true });
		exports$1.ResumeOkAwaitingResumableClientServerInputMultiplexerDemultiplexer = exports$1.ResumableClientServerInputMultiplexerDemultiplexer = exports$1.ClientServerInputMultiplexerDemultiplexer = exports$1.StreamIdGenerator = void 0;
		var _1 = requireDist();
		var Deferred_1 = requireDeferred();
		var Errors_1 = requireErrors();
		var Frames_1 = requireFrames();
		(function(StreamIdGenerator) {
			function create(seedId) {
				return new StreamIdGeneratorImpl(seedId);
			}
			StreamIdGenerator.create = create;
			var StreamIdGeneratorImpl = function() {
				function StreamIdGeneratorImpl(currentId) {
					this.currentId = currentId;
				}
				StreamIdGeneratorImpl.prototype.next = function(handler) {
					var nextId = this.currentId + 2;
					if (!handler(nextId)) return;
					this.currentId = nextId;
				};
				return StreamIdGeneratorImpl;
			}();
		})(exports$1.StreamIdGenerator || (exports$1.StreamIdGenerator = {}));
		var ClientServerInputMultiplexerDemultiplexer = function(_super) {
			__extends(ClientServerInputMultiplexerDemultiplexer, _super);
			function ClientServerInputMultiplexerDemultiplexer(streamIdSupplier, outbound, closeable) {
				var _this = _super.call(this) || this;
				_this.streamIdSupplier = streamIdSupplier;
				_this.outbound = outbound;
				_this.closeable = closeable;
				_this.registry = {};
				closeable.onClose(_this.close.bind(_this));
				return _this;
			}
			ClientServerInputMultiplexerDemultiplexer.prototype.handle = function(frame) {
				if (Frames_1.Frame.isConnection(frame)) {
					if (frame.type === _1.FrameTypes.RESERVED) return;
					this.connectionFramesHandler.handle(frame);
				} else if (Frames_1.Frame.isRequest(frame)) {
					if (this.registry[frame.streamId]) return;
					this.requestFramesHandler.handle(frame, this);
				} else {
					var handler = this.registry[frame.streamId];
					if (!handler) return;
					handler.handle(frame);
				}
			};
			ClientServerInputMultiplexerDemultiplexer.prototype.connectionInbound = function(handler) {
				if (this.connectionFramesHandler) throw new Error("Connection frame handler has already been installed");
				this.connectionFramesHandler = handler;
			};
			ClientServerInputMultiplexerDemultiplexer.prototype.handleRequestStream = function(handler) {
				if (this.requestFramesHandler) throw new Error("Stream handler has already been installed");
				this.requestFramesHandler = handler;
			};
			ClientServerInputMultiplexerDemultiplexer.prototype.send = function(frame) {
				this.outbound.send(frame);
			};
			Object.defineProperty(ClientServerInputMultiplexerDemultiplexer.prototype, "connectionOutbound", {
				get: function() {
					return this;
				},
				enumerable: false,
				configurable: true
			});
			ClientServerInputMultiplexerDemultiplexer.prototype.createRequestStream = function(streamHandler) {
				var _this = this;
				if (this.done) {
					streamHandler.handleReject(/* @__PURE__ */ new Error("Already closed"));
					return;
				}
				var registry = this.registry;
				this.streamIdSupplier.next(function(streamId) {
					return streamHandler.handleReady(streamId, _this);
				}, Object.keys(registry));
			};
			ClientServerInputMultiplexerDemultiplexer.prototype.connect = function(handler) {
				this.registry[handler.streamId] = handler;
			};
			ClientServerInputMultiplexerDemultiplexer.prototype.disconnect = function(stream) {
				delete this.registry[stream.streamId];
			};
			ClientServerInputMultiplexerDemultiplexer.prototype.close = function(error) {
				if (this.done) {
					_super.prototype.close.call(this, error);
					return;
				}
				for (var streamId in this.registry) this.registry[streamId].close(new Error("Closed. ".concat(error ? "Original cause [".concat(error, "].") : "")));
				_super.prototype.close.call(this, error);
			};
			return ClientServerInputMultiplexerDemultiplexer;
		}(Deferred_1.Deferred);
		exports$1.ClientServerInputMultiplexerDemultiplexer = ClientServerInputMultiplexerDemultiplexer;
		exports$1.ResumableClientServerInputMultiplexerDemultiplexer = function(_super) {
			__extends(ResumableClientServerInputMultiplexerDemultiplexer, _super);
			function ResumableClientServerInputMultiplexerDemultiplexer(streamIdSupplier, outbound, closeable, frameStore, token, sessionStoreOrReconnector, sessionTimeout) {
				var _this = _super.call(this, streamIdSupplier, outbound, new Deferred_1.Deferred()) || this;
				_this.frameStore = frameStore;
				_this.token = token;
				_this.sessionTimeout = sessionTimeout;
				if (sessionStoreOrReconnector instanceof Function) _this.reconnector = sessionStoreOrReconnector;
				else _this.sessionStore = sessionStoreOrReconnector;
				closeable.onClose(_this.handleConnectionClose.bind(_this));
				return _this;
			}
			ResumableClientServerInputMultiplexerDemultiplexer.prototype.send = function(frame) {
				if (Frames_1.Frame.isConnection(frame)) {
					if (frame.type === _1.FrameTypes.KEEPALIVE) frame.lastReceivedPosition = this.frameStore.lastReceivedFramePosition;
					else if (frame.type === _1.FrameTypes.ERROR) {
						this.outbound.send(frame);
						if (this.sessionStore) delete this.sessionStore[this.token];
						_super.prototype.close.call(this, new Errors_1.RSocketError(frame.code, frame.message));
						return;
					}
				} else this.frameStore.store(frame);
				this.outbound.send(frame);
			};
			ResumableClientServerInputMultiplexerDemultiplexer.prototype.handle = function(frame) {
				if (Frames_1.Frame.isConnection(frame)) {
					if (frame.type === _1.FrameTypes.KEEPALIVE) try {
						this.frameStore.dropTo(frame.lastReceivedPosition);
					} catch (re) {
						this.outbound.send({
							type: _1.FrameTypes.ERROR,
							streamId: 0,
							flags: _1.Flags.NONE,
							code: re.code,
							message: re.message
						});
						this.close(re);
					}
					else if (frame.type === _1.FrameTypes.ERROR) {
						_super.prototype.handle.call(this, frame);
						if (this.sessionStore) delete this.sessionStore[this.token];
						_super.prototype.close.call(this, new Errors_1.RSocketError(frame.code, frame.message));
						return;
					}
				} else this.frameStore.record(frame);
				_super.prototype.handle.call(this, frame);
			};
			ResumableClientServerInputMultiplexerDemultiplexer.prototype.resume = function(frame, outbound, closeable) {
				this.outbound = outbound;
				switch (frame.type) {
					case _1.FrameTypes.RESUME:
						clearTimeout(this.timeoutId);
						if (this.frameStore.lastReceivedFramePosition < frame.clientPosition) {
							var e = new Errors_1.RSocketError(_1.ErrorCodes.REJECTED_RESUME, "Impossible to resume since first available client frame position is greater than last received server frame position");
							this.outbound.send({
								type: _1.FrameTypes.ERROR,
								streamId: 0,
								flags: _1.Flags.NONE,
								code: e.code,
								message: e.message
							});
							this.close(e);
							return;
						}
						try {
							this.frameStore.dropTo(frame.serverPosition);
						} catch (re) {
							this.outbound.send({
								type: _1.FrameTypes.ERROR,
								streamId: 0,
								flags: _1.Flags.NONE,
								code: re.code,
								message: re.message
							});
							this.close(re);
							return;
						}
						this.outbound.send({
							type: _1.FrameTypes.RESUME_OK,
							streamId: 0,
							flags: _1.Flags.NONE,
							clientPosition: this.frameStore.lastReceivedFramePosition
						});
						break;
					case _1.FrameTypes.RESUME_OK:
						try {
							this.frameStore.dropTo(frame.clientPosition);
						} catch (re) {
							this.outbound.send({
								type: _1.FrameTypes.ERROR,
								streamId: 0,
								flags: _1.Flags.NONE,
								code: re.code,
								message: re.message
							});
							this.close(re);
						}
						break;
				}
				this.frameStore.drain(this.outbound.send.bind(this.outbound));
				closeable.onClose(this.handleConnectionClose.bind(this));
				this.connectionFramesHandler.resume();
			};
			ResumableClientServerInputMultiplexerDemultiplexer.prototype.handleConnectionClose = function(_error) {
				return __awaiter(this, void 0, void 0, function() {
					var e_1;
					return __generator(this, function(_a) {
						switch (_a.label) {
							case 0:
								this.connectionFramesHandler.pause();
								if (!this.reconnector) return [3, 5];
								_a.label = 1;
							case 1:
								_a.trys.push([
									1,
									3,
									,
									4
								]);
								return [4, this.reconnector(this, this.frameStore)];
							case 2:
								_a.sent();
								return [3, 4];
							case 3:
								e_1 = _a.sent();
								this.close(e_1);
								return [3, 4];
							case 4: return [3, 6];
							case 5:
								this.timeoutId = setTimeout(this.close.bind(this), this.sessionTimeout);
								_a.label = 6;
							case 6: return [2];
						}
					});
				});
			};
			return ResumableClientServerInputMultiplexerDemultiplexer;
		}(ClientServerInputMultiplexerDemultiplexer);
		exports$1.ResumeOkAwaitingResumableClientServerInputMultiplexerDemultiplexer = function() {
			function ResumeOkAwaitingResumableClientServerInputMultiplexerDemultiplexer(outbound, closeable, delegate) {
				this.outbound = outbound;
				this.closeable = closeable;
				this.delegate = delegate;
				this.resumed = false;
			}
			ResumeOkAwaitingResumableClientServerInputMultiplexerDemultiplexer.prototype.close = function() {
				this.delegate.close();
			};
			ResumeOkAwaitingResumableClientServerInputMultiplexerDemultiplexer.prototype.onClose = function(callback) {
				this.delegate.onClose(callback);
			};
			Object.defineProperty(ResumeOkAwaitingResumableClientServerInputMultiplexerDemultiplexer.prototype, "connectionOutbound", {
				get: function() {
					return this.delegate.connectionOutbound;
				},
				enumerable: false,
				configurable: true
			});
			ResumeOkAwaitingResumableClientServerInputMultiplexerDemultiplexer.prototype.createRequestStream = function(streamHandler) {
				this.delegate.createRequestStream(streamHandler);
			};
			ResumeOkAwaitingResumableClientServerInputMultiplexerDemultiplexer.prototype.connectionInbound = function(handler) {
				this.delegate.connectionInbound(handler);
			};
			ResumeOkAwaitingResumableClientServerInputMultiplexerDemultiplexer.prototype.handleRequestStream = function(handler) {
				this.delegate.handleRequestStream(handler);
			};
			ResumeOkAwaitingResumableClientServerInputMultiplexerDemultiplexer.prototype.handle = function(frame) {
				var _this = this;
				if (!this.resumed) {
					if (frame.type === _1.FrameTypes.RESUME_OK) {
						this.resumed = true;
						this.delegate.resume(frame, this.outbound, this.closeable);
						return;
					} else {
						this.outbound.send({
							type: _1.FrameTypes.ERROR,
							streamId: 0,
							code: _1.ErrorCodes.CONNECTION_ERROR,
							message: "Incomplete RESUME handshake. Unexpected frame ".concat(frame.type, " received"),
							flags: _1.Flags.NONE
						});
						this.closeable.close();
						this.closeable.onClose(function() {
							return _this.delegate.close(new Errors_1.RSocketError(_1.ErrorCodes.CONNECTION_ERROR, "Incomplete RESUME handshake. Unexpected frame ".concat(frame.type, " received")));
						});
					}
					return;
				}
				this.delegate.handle(frame);
			};
			return ResumeOkAwaitingResumableClientServerInputMultiplexerDemultiplexer;
		}();
	})(ClientServerMultiplexerDemultiplexer);
	return ClientServerMultiplexerDemultiplexer;
}
var RSocketSupport = {};
var RequestChannelStream = {};
var Fragmenter = {};
var hasRequiredFragmenter;
function requireFragmenter() {
	if (hasRequiredFragmenter) return Fragmenter;
	hasRequiredFragmenter = 1;
	var __generator = Fragmenter && Fragmenter.__generator || function(thisArg, body) {
		var _ = {
			label: 0,
			sent: function() {
				if (t[0] & 1) throw t[1];
				return t[1];
			},
			trys: [],
			ops: []
		}, f, y, t, g;
		return g = {
			next: verb(0),
			"throw": verb(1),
			"return": verb(2)
		}, typeof Symbol === "function" && (g[Symbol.iterator] = function() {
			return this;
		}), g;
		function verb(n) {
			return function(v) {
				return step([n, v]);
			};
		}
		function step(op) {
			if (f) throw new TypeError("Generator is already executing.");
			while (_) try {
				if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
				if (y = 0, t) op = [op[0] & 2, t.value];
				switch (op[0]) {
					case 0:
					case 1:
						t = op;
						break;
					case 4:
						_.label++;
						return {
							value: op[1],
							done: false
						};
					case 5:
						_.label++;
						y = op[1];
						op = [0];
						continue;
					case 7:
						op = _.ops.pop();
						_.trys.pop();
						continue;
					default:
						if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) {
							_ = 0;
							continue;
						}
						if (op[0] === 3 && (!t || op[1] > t[0] && op[1] < t[3])) {
							_.label = op[1];
							break;
						}
						if (op[0] === 6 && _.label < t[1]) {
							_.label = t[1];
							t = op;
							break;
						}
						if (t && _.label < t[2]) {
							_.label = t[2];
							_.ops.push(op);
							break;
						}
						if (t[2]) _.ops.pop();
						_.trys.pop();
						continue;
				}
				op = body.call(thisArg, _);
			} catch (e) {
				op = [6, e];
				y = 0;
			} finally {
				f = t = 0;
			}
			if (op[0] & 5) throw op[1];
			return {
				value: op[0] ? op[1] : void 0,
				done: true
			};
		}
	};
	Object.defineProperty(Fragmenter, "__esModule", { value: true });
	Fragmenter.fragmentWithRequestN = Fragmenter.fragment = Fragmenter.isFragmentable = void 0;
	var Frames_1 = requireFrames();
	function isFragmentable(payload, fragmentSize, frameType) {
		if (fragmentSize === 0) return false;
		return payload.data.byteLength + (payload.metadata ? payload.metadata.byteLength + Frames_1.Lengths.METADATA : 0) + (frameType == Frames_1.FrameTypes.REQUEST_STREAM || frameType == Frames_1.FrameTypes.REQUEST_CHANNEL ? Frames_1.Lengths.REQUEST : 0) > fragmentSize;
	}
	Fragmenter.isFragmentable = isFragmentable;
	function fragment(streamId, payload, fragmentSize, frameType, isComplete) {
		var dataLength, firstFrame, remaining, metadata, metadataLength, metadataPosition, nextMetadataPosition, nextMetadataPosition, dataPosition, data, nextDataPosition, nextDataPosition;
		var _a, _b;
		if (isComplete === void 0) isComplete = false;
		return __generator(this, function(_c) {
			switch (_c.label) {
				case 0:
					dataLength = (_b = (_a = payload.data) === null || _a === void 0 ? void 0 : _a.byteLength) !== null && _b !== void 0 ? _b : 0;
					firstFrame = frameType !== Frames_1.FrameTypes.PAYLOAD;
					remaining = fragmentSize;
					if (!payload.metadata) return [3, 6];
					metadataLength = payload.metadata.byteLength;
					if (!(metadataLength === 0)) return [3, 1];
					remaining -= Frames_1.Lengths.METADATA;
					metadata = bufferExports.Buffer.allocUnsafe(0);
					return [3, 6];
				case 1:
					metadataPosition = 0;
					if (!firstFrame) return [3, 3];
					remaining -= Frames_1.Lengths.METADATA;
					nextMetadataPosition = Math.min(metadataLength, metadataPosition + remaining);
					metadata = payload.metadata.slice(metadataPosition, nextMetadataPosition);
					remaining -= metadata.byteLength;
					metadataPosition = nextMetadataPosition;
					if (!(remaining === 0)) return [3, 3];
					firstFrame = false;
					return [4, {
						type: frameType,
						flags: Frames_1.Flags.FOLLOWS | Frames_1.Flags.METADATA,
						data: void 0,
						metadata,
						streamId
					}];
				case 2:
					_c.sent();
					metadata = void 0;
					remaining = fragmentSize;
					_c.label = 3;
				case 3:
					if (!(metadataPosition < metadataLength)) return [3, 6];
					remaining -= Frames_1.Lengths.METADATA;
					nextMetadataPosition = Math.min(metadataLength, metadataPosition + remaining);
					metadata = payload.metadata.slice(metadataPosition, nextMetadataPosition);
					remaining -= metadata.byteLength;
					metadataPosition = nextMetadataPosition;
					if (!(remaining === 0 || dataLength === 0)) return [3, 5];
					return [4, {
						type: Frames_1.FrameTypes.PAYLOAD,
						flags: Frames_1.Flags.NEXT | Frames_1.Flags.METADATA | (metadataPosition === metadataLength && isComplete && dataLength === 0 ? Frames_1.Flags.COMPLETE : Frames_1.Flags.FOLLOWS),
						data: void 0,
						metadata,
						streamId
					}];
				case 4:
					_c.sent();
					metadata = void 0;
					remaining = fragmentSize;
					_c.label = 5;
				case 5: return [3, 3];
				case 6:
					dataPosition = 0;
					if (!firstFrame) return [3, 8];
					nextDataPosition = Math.min(dataLength, dataPosition + remaining);
					data = payload.data.slice(dataPosition, nextDataPosition);
					remaining -= data.byteLength;
					dataPosition = nextDataPosition;
					return [4, {
						type: frameType,
						flags: Frames_1.Flags.FOLLOWS | (metadata ? Frames_1.Flags.METADATA : Frames_1.Flags.NONE),
						data,
						metadata,
						streamId
					}];
				case 7:
					_c.sent();
					metadata = void 0;
					data = void 0;
					remaining = fragmentSize;
					_c.label = 8;
				case 8:
					if (!(dataPosition < dataLength)) return [3, 10];
					nextDataPosition = Math.min(dataLength, dataPosition + remaining);
					data = payload.data.slice(dataPosition, nextDataPosition);
					remaining -= data.byteLength;
					dataPosition = nextDataPosition;
					return [4, {
						type: Frames_1.FrameTypes.PAYLOAD,
						flags: dataPosition === dataLength ? (isComplete ? Frames_1.Flags.COMPLETE : Frames_1.Flags.NONE) | Frames_1.Flags.NEXT | (metadata ? Frames_1.Flags.METADATA : 0) : Frames_1.Flags.FOLLOWS | Frames_1.Flags.NEXT | (metadata ? Frames_1.Flags.METADATA : 0),
						data,
						metadata,
						streamId
					}];
				case 9:
					_c.sent();
					metadata = void 0;
					data = void 0;
					remaining = fragmentSize;
					return [3, 8];
				case 10: return [2];
			}
		});
	}
	Fragmenter.fragment = fragment;
	function fragmentWithRequestN(streamId, payload, fragmentSize, frameType, requestN, isComplete) {
		var dataLength, firstFrame, remaining, metadata, metadataLength, metadataPosition, nextMetadataPosition, nextMetadataPosition, dataPosition, data, nextDataPosition, nextDataPosition;
		var _a, _b;
		if (isComplete === void 0) isComplete = false;
		return __generator(this, function(_c) {
			switch (_c.label) {
				case 0:
					dataLength = (_b = (_a = payload.data) === null || _a === void 0 ? void 0 : _a.byteLength) !== null && _b !== void 0 ? _b : 0;
					firstFrame = true;
					remaining = fragmentSize;
					if (!payload.metadata) return [3, 6];
					metadataLength = payload.metadata.byteLength;
					if (!(metadataLength === 0)) return [3, 1];
					remaining -= Frames_1.Lengths.METADATA;
					metadata = bufferExports.Buffer.allocUnsafe(0);
					return [3, 6];
				case 1:
					metadataPosition = 0;
					if (!firstFrame) return [3, 3];
					remaining -= Frames_1.Lengths.METADATA + Frames_1.Lengths.REQUEST;
					nextMetadataPosition = Math.min(metadataLength, metadataPosition + remaining);
					metadata = payload.metadata.slice(metadataPosition, nextMetadataPosition);
					remaining -= metadata.byteLength;
					metadataPosition = nextMetadataPosition;
					if (!(remaining === 0)) return [3, 3];
					firstFrame = false;
					return [4, {
						type: frameType,
						flags: Frames_1.Flags.FOLLOWS | Frames_1.Flags.METADATA,
						data: void 0,
						requestN,
						metadata,
						streamId
					}];
				case 2:
					_c.sent();
					metadata = void 0;
					remaining = fragmentSize;
					_c.label = 3;
				case 3:
					if (!(metadataPosition < metadataLength)) return [3, 6];
					remaining -= Frames_1.Lengths.METADATA;
					nextMetadataPosition = Math.min(metadataLength, metadataPosition + remaining);
					metadata = payload.metadata.slice(metadataPosition, nextMetadataPosition);
					remaining -= metadata.byteLength;
					metadataPosition = nextMetadataPosition;
					if (!(remaining === 0 || dataLength === 0)) return [3, 5];
					return [4, {
						type: Frames_1.FrameTypes.PAYLOAD,
						flags: Frames_1.Flags.NEXT | Frames_1.Flags.METADATA | (metadataPosition === metadataLength && isComplete && dataLength === 0 ? Frames_1.Flags.COMPLETE : Frames_1.Flags.FOLLOWS),
						data: void 0,
						metadata,
						streamId
					}];
				case 4:
					_c.sent();
					metadata = void 0;
					remaining = fragmentSize;
					_c.label = 5;
				case 5: return [3, 3];
				case 6:
					dataPosition = 0;
					if (!firstFrame) return [3, 8];
					remaining -= Frames_1.Lengths.REQUEST;
					nextDataPosition = Math.min(dataLength, dataPosition + remaining);
					data = payload.data.slice(dataPosition, nextDataPosition);
					remaining -= data.byteLength;
					dataPosition = nextDataPosition;
					return [4, {
						type: frameType,
						flags: Frames_1.Flags.FOLLOWS | (metadata ? Frames_1.Flags.METADATA : Frames_1.Flags.NONE),
						data,
						requestN,
						metadata,
						streamId
					}];
				case 7:
					_c.sent();
					metadata = void 0;
					data = void 0;
					remaining = fragmentSize;
					_c.label = 8;
				case 8:
					if (!(dataPosition < dataLength)) return [3, 10];
					nextDataPosition = Math.min(dataLength, dataPosition + remaining);
					data = payload.data.slice(dataPosition, nextDataPosition);
					remaining -= data.byteLength;
					dataPosition = nextDataPosition;
					return [4, {
						type: Frames_1.FrameTypes.PAYLOAD,
						flags: dataPosition === dataLength ? (isComplete ? Frames_1.Flags.COMPLETE : Frames_1.Flags.NONE) | Frames_1.Flags.NEXT | (metadata ? Frames_1.Flags.METADATA : 0) : Frames_1.Flags.FOLLOWS | Frames_1.Flags.NEXT | (metadata ? Frames_1.Flags.METADATA : 0),
						data,
						metadata,
						streamId
					}];
				case 9:
					_c.sent();
					metadata = void 0;
					data = void 0;
					remaining = fragmentSize;
					return [3, 8];
				case 10: return [2];
			}
		});
	}
	Fragmenter.fragmentWithRequestN = fragmentWithRequestN;
	return Fragmenter;
}
var Reassembler = {};
var hasRequiredReassembler;
function requireReassembler() {
	if (hasRequiredReassembler) return Reassembler;
	hasRequiredReassembler = 1;
	Object.defineProperty(Reassembler, "__esModule", { value: true });
	Reassembler.cancel = Reassembler.reassemble = Reassembler.add = void 0;
	function add(holder, dataFragment, metadataFragment) {
		if (!holder.hasFragments) {
			holder.hasFragments = true;
			holder.data = dataFragment;
			if (metadataFragment) holder.metadata = metadataFragment;
			return true;
		}
		holder.data = holder.data ? bufferExports.Buffer.concat([holder.data, dataFragment]) : dataFragment;
		if (holder.metadata && metadataFragment) holder.metadata = bufferExports.Buffer.concat([holder.metadata, metadataFragment]);
		return true;
	}
	Reassembler.add = add;
	function reassemble(holder, dataFragment, metadataFragment) {
		holder.hasFragments = false;
		var data = holder.data ? bufferExports.Buffer.concat([holder.data, dataFragment]) : dataFragment;
		holder.data = void 0;
		if (holder.metadata) {
			var metadata = metadataFragment ? bufferExports.Buffer.concat([holder.metadata, metadataFragment]) : holder.metadata;
			holder.metadata = void 0;
			return {
				data,
				metadata
			};
		}
		return { data };
	}
	Reassembler.reassemble = reassemble;
	function cancel(holder) {
		holder.hasFragments = false;
		holder.data = void 0;
		holder.metadata = void 0;
	}
	Reassembler.cancel = cancel;
	return Reassembler;
}
var hasRequiredRequestChannelStream;
function requireRequestChannelStream() {
	if (hasRequiredRequestChannelStream) return RequestChannelStream;
	hasRequiredRequestChannelStream = 1;
	var __createBinding = RequestChannelStream && RequestChannelStream.__createBinding || (Object.create ? (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		Object.defineProperty(o, k2, {
			enumerable: true,
			get: function() {
				return m[k];
			}
		});
	}) : (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		o[k2] = m[k];
	}));
	var __setModuleDefault = RequestChannelStream && RequestChannelStream.__setModuleDefault || (Object.create ? (function(o, v) {
		Object.defineProperty(o, "default", {
			enumerable: true,
			value: v
		});
	}) : function(o, v) {
		o["default"] = v;
	});
	var __importStar = RequestChannelStream && RequestChannelStream.__importStar || function(mod) {
		if (mod && mod.__esModule) return mod;
		var result = {};
		if (mod != null) {
			for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
		}
		__setModuleDefault(result, mod);
		return result;
	};
	var __values = RequestChannelStream && RequestChannelStream.__values || function(o) {
		var s = typeof Symbol === "function" && Symbol.iterator, m = s && o[s], i = 0;
		if (m) return m.call(o);
		if (o && typeof o.length === "number") return { next: function() {
			if (o && i >= o.length) o = void 0;
			return {
				value: o && o[i++],
				done: !o
			};
		} };
		throw new TypeError(s ? "Object is not iterable." : "Symbol.iterator is not defined.");
	};
	Object.defineProperty(RequestChannelStream, "__esModule", { value: true });
	RequestChannelStream.RequestChannelResponderStream = RequestChannelStream.RequestChannelRequesterStream = void 0;
	var Errors_1 = requireErrors();
	var Fragmenter_1 = requireFragmenter();
	var Frames_1 = requireFrames();
	var Reassembler = __importStar(requireReassembler());
	RequestChannelStream.RequestChannelRequesterStream = function() {
		function RequestChannelRequesterStream(payload, isComplete, receiver, fragmentSize, initialRequestN, leaseManager) {
			this.payload = payload;
			this.isComplete = isComplete;
			this.receiver = receiver;
			this.fragmentSize = fragmentSize;
			this.initialRequestN = initialRequestN;
			this.leaseManager = leaseManager;
			this.streamType = Frames_1.FrameTypes.REQUEST_CHANNEL;
		}
		RequestChannelRequesterStream.prototype.handleReady = function(streamId, stream) {
			var e_1, _a;
			if (this.outboundDone) return false;
			this.streamId = streamId;
			this.stream = stream;
			stream.connect(this);
			var isCompleted = this.isComplete;
			if (isCompleted) this.outboundDone = isCompleted;
			if ((0, Fragmenter_1.isFragmentable)(this.payload, this.fragmentSize, Frames_1.FrameTypes.REQUEST_CHANNEL)) try {
				for (var _b = __values((0, Fragmenter_1.fragmentWithRequestN)(streamId, this.payload, this.fragmentSize, Frames_1.FrameTypes.REQUEST_CHANNEL, this.initialRequestN, isCompleted)), _c = _b.next(); !_c.done; _c = _b.next()) {
					var frame = _c.value;
					this.stream.send(frame);
				}
			} catch (e_1_1) {
				e_1 = { error: e_1_1 };
			} finally {
				try {
					if (_c && !_c.done && (_a = _b.return)) _a.call(_b);
				} finally {
					if (e_1) throw e_1.error;
				}
			}
			else this.stream.send({
				type: Frames_1.FrameTypes.REQUEST_CHANNEL,
				data: this.payload.data,
				metadata: this.payload.metadata,
				requestN: this.initialRequestN,
				flags: (this.payload.metadata !== void 0 ? Frames_1.Flags.METADATA : Frames_1.Flags.NONE) | (isCompleted ? Frames_1.Flags.COMPLETE : Frames_1.Flags.NONE),
				streamId
			});
			if (this.hasExtension) this.stream.send({
				type: Frames_1.FrameTypes.EXT,
				streamId,
				extendedContent: this.extendedContent,
				extendedType: this.extendedType,
				flags: this.flags
			});
			return true;
		};
		RequestChannelRequesterStream.prototype.handleReject = function(error) {
			if (this.inboundDone) return;
			this.inboundDone = true;
			this.outboundDone = true;
			this.receiver.onError(error);
		};
		RequestChannelRequesterStream.prototype.handle = function(frame) {
			var errorMessage;
			var frameType = frame.type;
			switch (frameType) {
				case Frames_1.FrameTypes.PAYLOAD:
					var hasComplete = Frames_1.Flags.hasComplete(frame.flags);
					var hasNext = Frames_1.Flags.hasNext(frame.flags);
					if (hasComplete || !Frames_1.Flags.hasFollows(frame.flags)) {
						if (hasComplete) {
							this.inboundDone = true;
							if (this.outboundDone) this.stream.disconnect(this);
							if (!hasNext) {
								this.receiver.onComplete();
								return;
							}
						}
						var payload = this.hasFragments ? Reassembler.reassemble(this, frame.data, frame.metadata) : {
							data: frame.data,
							metadata: frame.metadata
						};
						this.receiver.onNext(payload, hasComplete);
						return;
					}
					if (Reassembler.add(this, frame.data, frame.metadata)) return;
					errorMessage = "Unexpected frame size";
					break;
				case Frames_1.FrameTypes.CANCEL:
					if (this.outboundDone) return;
					this.outboundDone = true;
					if (this.inboundDone) this.stream.disconnect(this);
					this.receiver.cancel();
					return;
				case Frames_1.FrameTypes.REQUEST_N:
					if (this.outboundDone) return;
					if (this.hasFragments) {
						errorMessage = "Unexpected frame type [".concat(frameType, "] during reassembly");
						break;
					}
					this.receiver.request(frame.requestN);
					return;
				case Frames_1.FrameTypes.ERROR:
					var outboundDone = this.outboundDone;
					this.inboundDone = true;
					this.outboundDone = true;
					this.stream.disconnect(this);
					Reassembler.cancel(this);
					if (!outboundDone) this.receiver.cancel();
					this.receiver.onError(new Errors_1.RSocketError(frame.code, frame.message));
					return;
				case Frames_1.FrameTypes.EXT:
					this.receiver.onExtension(frame.extendedType, frame.extendedContent, Frames_1.Flags.hasIgnore(frame.flags));
					return;
				default: errorMessage = "Unexpected frame type [".concat(frameType, "]");
			}
			this.close(new Errors_1.RSocketError(Errors_1.ErrorCodes.CANCELED, errorMessage));
			this.stream.send({
				type: Frames_1.FrameTypes.CANCEL,
				streamId: this.streamId,
				flags: Frames_1.Flags.NONE
			});
			this.stream.disconnect(this);
		};
		RequestChannelRequesterStream.prototype.request = function(n) {
			if (this.inboundDone) return;
			if (!this.streamId) {
				this.initialRequestN += n;
				return;
			}
			this.stream.send({
				type: Frames_1.FrameTypes.REQUEST_N,
				flags: Frames_1.Flags.NONE,
				requestN: n,
				streamId: this.streamId
			});
		};
		RequestChannelRequesterStream.prototype.cancel = function() {
			var _a;
			var inboundDone = this.inboundDone;
			var outboundDone = this.outboundDone;
			if (inboundDone && outboundDone) return;
			this.inboundDone = true;
			this.outboundDone = true;
			if (!outboundDone) this.receiver.cancel();
			if (!this.streamId) {
				(_a = this.leaseManager) === null || _a === void 0 || _a.cancelRequest(this);
				return;
			}
			this.stream.send({
				type: inboundDone ? Frames_1.FrameTypes.ERROR : Frames_1.FrameTypes.CANCEL,
				flags: Frames_1.Flags.NONE,
				streamId: this.streamId,
				code: Errors_1.ErrorCodes.CANCELED,
				message: "Cancelled"
			});
			this.stream.disconnect(this);
			Reassembler.cancel(this);
		};
		RequestChannelRequesterStream.prototype.onNext = function(payload, isComplete) {
			var e_2, _a;
			if (this.outboundDone) return;
			if (isComplete) {
				this.outboundDone = true;
				if (this.inboundDone) this.stream.disconnect(this);
			}
			if ((0, Fragmenter_1.isFragmentable)(payload, this.fragmentSize, Frames_1.FrameTypes.PAYLOAD)) try {
				for (var _b = __values((0, Fragmenter_1.fragment)(this.streamId, payload, this.fragmentSize, Frames_1.FrameTypes.PAYLOAD, isComplete)), _c = _b.next(); !_c.done; _c = _b.next()) {
					var frame = _c.value;
					this.stream.send(frame);
				}
			} catch (e_2_1) {
				e_2 = { error: e_2_1 };
			} finally {
				try {
					if (_c && !_c.done && (_a = _b.return)) _a.call(_b);
				} finally {
					if (e_2) throw e_2.error;
				}
			}
			else this.stream.send({
				type: Frames_1.FrameTypes.PAYLOAD,
				streamId: this.streamId,
				flags: Frames_1.Flags.NEXT | (payload.metadata ? Frames_1.Flags.METADATA : Frames_1.Flags.NONE) | (isComplete ? Frames_1.Flags.COMPLETE : Frames_1.Flags.NONE),
				data: payload.data,
				metadata: payload.metadata
			});
		};
		RequestChannelRequesterStream.prototype.onComplete = function() {
			if (!this.streamId) {
				this.isComplete = true;
				return;
			}
			if (this.outboundDone) return;
			this.outboundDone = true;
			this.stream.send({
				type: Frames_1.FrameTypes.PAYLOAD,
				streamId: this.streamId,
				flags: Frames_1.Flags.COMPLETE,
				data: null,
				metadata: null
			});
			if (this.inboundDone) this.stream.disconnect(this);
		};
		RequestChannelRequesterStream.prototype.onError = function(error) {
			if (this.outboundDone) return;
			var inboundDone = this.inboundDone;
			this.outboundDone = true;
			this.inboundDone = true;
			this.stream.send({
				type: Frames_1.FrameTypes.ERROR,
				streamId: this.streamId,
				flags: Frames_1.Flags.NONE,
				code: error instanceof Errors_1.RSocketError ? error.code : Errors_1.ErrorCodes.APPLICATION_ERROR,
				message: error.message
			});
			this.stream.disconnect(this);
			if (!inboundDone) this.receiver.onError(error);
		};
		RequestChannelRequesterStream.prototype.onExtension = function(extendedType, content, canBeIgnored) {
			if (this.outboundDone) return;
			if (!this.streamId) {
				this.hasExtension = true;
				this.extendedType = extendedType;
				this.extendedContent = content;
				this.flags = canBeIgnored ? Frames_1.Flags.IGNORE : Frames_1.Flags.NONE;
				return;
			}
			this.stream.send({
				streamId: this.streamId,
				type: Frames_1.FrameTypes.EXT,
				extendedType,
				extendedContent: content,
				flags: canBeIgnored ? Frames_1.Flags.IGNORE : Frames_1.Flags.NONE
			});
		};
		RequestChannelRequesterStream.prototype.close = function(error) {
			if (this.inboundDone && this.outboundDone) return;
			var inboundDone = this.inboundDone;
			var outboundDone = this.outboundDone;
			this.inboundDone = true;
			this.outboundDone = true;
			Reassembler.cancel(this);
			if (!outboundDone) this.receiver.cancel();
			if (!inboundDone) if (error) this.receiver.onError(error);
			else this.receiver.onComplete();
		};
		return RequestChannelRequesterStream;
	}();
	RequestChannelStream.RequestChannelResponderStream = function() {
		function RequestChannelResponderStream(streamId, stream, fragmentSize, handler, frame) {
			this.streamId = streamId;
			this.stream = stream;
			this.fragmentSize = fragmentSize;
			this.handler = handler;
			this.streamType = Frames_1.FrameTypes.REQUEST_CHANNEL;
			stream.connect(this);
			if (Frames_1.Flags.hasFollows(frame.flags)) {
				Reassembler.add(this, frame.data, frame.metadata);
				this.initialRequestN = frame.requestN;
				this.isComplete = Frames_1.Flags.hasComplete(frame.flags);
				return;
			}
			var payload = {
				data: frame.data,
				metadata: frame.metadata
			};
			var hasComplete = Frames_1.Flags.hasComplete(frame.flags);
			this.inboundDone = hasComplete;
			try {
				this.receiver = handler(payload, frame.requestN, hasComplete, this);
				if (this.outboundDone && this.defferedError) this.receiver.onError(this.defferedError);
			} catch (error) {
				if (this.outboundDone && !this.inboundDone) this.cancel();
				else this.inboundDone = true;
				this.onError(error);
			}
		}
		RequestChannelResponderStream.prototype.handle = function(frame) {
			var errorMessage;
			var frameType = frame.type;
			switch (frameType) {
				case Frames_1.FrameTypes.PAYLOAD:
					if (Frames_1.Flags.hasFollows(frame.flags)) {
						if (Reassembler.add(this, frame.data, frame.metadata)) return;
						errorMessage = "Unexpected frame size";
						break;
					}
					var payload = this.hasFragments ? Reassembler.reassemble(this, frame.data, frame.metadata) : {
						data: frame.data,
						metadata: frame.metadata
					};
					var hasComplete = Frames_1.Flags.hasComplete(frame.flags);
					if (!this.receiver) {
						var inboundDone = this.isComplete || hasComplete;
						if (inboundDone) {
							this.inboundDone = true;
							if (this.outboundDone) this.stream.disconnect(this);
						}
						try {
							this.receiver = this.handler(payload, this.initialRequestN, inboundDone, this);
							if (this.outboundDone && this.defferedError) {}
						} catch (error) {
							if (this.outboundDone && !this.inboundDone) this.cancel();
							else this.inboundDone = true;
							this.onError(error);
						}
					} else {
						if (hasComplete) {
							this.inboundDone = true;
							if (this.outboundDone) this.stream.disconnect(this);
							if (!Frames_1.Flags.hasNext(frame.flags)) {
								this.receiver.onComplete();
								return;
							}
						}
						this.receiver.onNext(payload, hasComplete);
					}
					return;
				case Frames_1.FrameTypes.REQUEST_N:
					if (!this.receiver || this.hasFragments) {
						errorMessage = "Unexpected frame type [".concat(frameType, "] during reassembly");
						break;
					}
					this.receiver.request(frame.requestN);
					return;
				case Frames_1.FrameTypes.ERROR:
				case Frames_1.FrameTypes.CANCEL:
					var inboundDone = this.inboundDone;
					var outboundDone = this.outboundDone;
					this.inboundDone = true;
					this.outboundDone = true;
					this.stream.disconnect(this);
					Reassembler.cancel(this);
					if (!this.receiver) return;
					if (!outboundDone) this.receiver.cancel();
					if (!inboundDone) {
						var error = frameType === Frames_1.FrameTypes.CANCEL ? new Errors_1.RSocketError(Errors_1.ErrorCodes.CANCELED, "Cancelled") : new Errors_1.RSocketError(frame.code, frame.message);
						this.receiver.onError(error);
					}
					return;
				case Frames_1.FrameTypes.EXT:
					if (!this.receiver || this.hasFragments) {
						errorMessage = "Unexpected frame type [".concat(frameType, "] during reassembly");
						break;
					}
					this.receiver.onExtension(frame.extendedType, frame.extendedContent, Frames_1.Flags.hasIgnore(frame.flags));
					return;
				default: errorMessage = "Unexpected frame type [".concat(frameType, "]");
			}
			this.stream.send({
				type: Frames_1.FrameTypes.ERROR,
				flags: Frames_1.Flags.NONE,
				code: Errors_1.ErrorCodes.CANCELED,
				message: errorMessage,
				streamId: this.streamId
			});
			this.stream.disconnect(this);
			this.close(new Errors_1.RSocketError(Errors_1.ErrorCodes.CANCELED, errorMessage));
		};
		RequestChannelResponderStream.prototype.onError = function(error) {
			if (this.outboundDone) {
				console.warn("Trying to error for the second time. ".concat(error ? "Dropping error [".concat(error, "].") : ""));
				return;
			}
			var inboundDone = this.inboundDone;
			this.outboundDone = true;
			this.inboundDone = true;
			this.stream.send({
				type: Frames_1.FrameTypes.ERROR,
				flags: Frames_1.Flags.NONE,
				code: error instanceof Errors_1.RSocketError ? error.code : Errors_1.ErrorCodes.APPLICATION_ERROR,
				message: error.message,
				streamId: this.streamId
			});
			this.stream.disconnect(this);
			if (!inboundDone) if (this.receiver) this.receiver.onError(error);
			else this.defferedError = error;
		};
		RequestChannelResponderStream.prototype.onNext = function(payload, isCompletion) {
			var e_3, _a;
			if (this.outboundDone) return;
			if (isCompletion) this.outboundDone = true;
			if ((0, Fragmenter_1.isFragmentable)(payload, this.fragmentSize, Frames_1.FrameTypes.PAYLOAD)) try {
				for (var _b = __values((0, Fragmenter_1.fragment)(this.streamId, payload, this.fragmentSize, Frames_1.FrameTypes.PAYLOAD, isCompletion)), _c = _b.next(); !_c.done; _c = _b.next()) {
					var frame = _c.value;
					this.stream.send(frame);
				}
			} catch (e_3_1) {
				e_3 = { error: e_3_1 };
			} finally {
				try {
					if (_c && !_c.done && (_a = _b.return)) _a.call(_b);
				} finally {
					if (e_3) throw e_3.error;
				}
			}
			else this.stream.send({
				type: Frames_1.FrameTypes.PAYLOAD,
				flags: Frames_1.Flags.NEXT | (isCompletion ? Frames_1.Flags.COMPLETE : Frames_1.Flags.NONE) | (payload.metadata ? Frames_1.Flags.METADATA : Frames_1.Flags.NONE),
				data: payload.data,
				metadata: payload.metadata,
				streamId: this.streamId
			});
			if (isCompletion && this.inboundDone) this.stream.disconnect(this);
		};
		RequestChannelResponderStream.prototype.onComplete = function() {
			if (this.outboundDone) return;
			this.outboundDone = true;
			this.stream.send({
				type: Frames_1.FrameTypes.PAYLOAD,
				flags: Frames_1.Flags.COMPLETE,
				streamId: this.streamId,
				data: null,
				metadata: null
			});
			if (this.inboundDone) this.stream.disconnect(this);
		};
		RequestChannelResponderStream.prototype.onExtension = function(extendedType, content, canBeIgnored) {
			if (this.outboundDone && this.inboundDone) return;
			this.stream.send({
				type: Frames_1.FrameTypes.EXT,
				streamId: this.streamId,
				flags: canBeIgnored ? Frames_1.Flags.IGNORE : Frames_1.Flags.NONE,
				extendedType,
				extendedContent: content
			});
		};
		RequestChannelResponderStream.prototype.request = function(n) {
			if (this.inboundDone) return;
			this.stream.send({
				type: Frames_1.FrameTypes.REQUEST_N,
				flags: Frames_1.Flags.NONE,
				streamId: this.streamId,
				requestN: n
			});
		};
		RequestChannelResponderStream.prototype.cancel = function() {
			if (this.inboundDone) return;
			this.inboundDone = true;
			this.stream.send({
				type: Frames_1.FrameTypes.CANCEL,
				flags: Frames_1.Flags.NONE,
				streamId: this.streamId
			});
			if (this.outboundDone) this.stream.disconnect(this);
		};
		RequestChannelResponderStream.prototype.close = function(error) {
			if (this.inboundDone && this.outboundDone) {
				console.warn("Trying to close for the second time. ".concat(error ? "Dropping error [".concat(error, "].") : ""));
				return;
			}
			var inboundDone = this.inboundDone;
			var outboundDone = this.outboundDone;
			this.inboundDone = true;
			this.outboundDone = true;
			Reassembler.cancel(this);
			var receiver = this.receiver;
			if (!receiver) return;
			if (!outboundDone) receiver.cancel();
			if (!inboundDone) if (error) receiver.onError(error);
			else receiver.onComplete();
		};
		return RequestChannelResponderStream;
	}();
	return RequestChannelStream;
}
var RequestFnFStream = {};
var hasRequiredRequestFnFStream;
function requireRequestFnFStream() {
	if (hasRequiredRequestFnFStream) return RequestFnFStream;
	hasRequiredRequestFnFStream = 1;
	var __createBinding = RequestFnFStream && RequestFnFStream.__createBinding || (Object.create ? (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		Object.defineProperty(o, k2, {
			enumerable: true,
			get: function() {
				return m[k];
			}
		});
	}) : (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		o[k2] = m[k];
	}));
	var __setModuleDefault = RequestFnFStream && RequestFnFStream.__setModuleDefault || (Object.create ? (function(o, v) {
		Object.defineProperty(o, "default", {
			enumerable: true,
			value: v
		});
	}) : function(o, v) {
		o["default"] = v;
	});
	var __importStar = RequestFnFStream && RequestFnFStream.__importStar || function(mod) {
		if (mod && mod.__esModule) return mod;
		var result = {};
		if (mod != null) {
			for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
		}
		__setModuleDefault(result, mod);
		return result;
	};
	var __values = RequestFnFStream && RequestFnFStream.__values || function(o) {
		var s = typeof Symbol === "function" && Symbol.iterator, m = s && o[s], i = 0;
		if (m) return m.call(o);
		if (o && typeof o.length === "number") return { next: function() {
			if (o && i >= o.length) o = void 0;
			return {
				value: o && o[i++],
				done: !o
			};
		} };
		throw new TypeError(s ? "Object is not iterable." : "Symbol.iterator is not defined.");
	};
	Object.defineProperty(RequestFnFStream, "__esModule", { value: true });
	RequestFnFStream.RequestFnfResponderStream = RequestFnFStream.RequestFnFRequesterStream = void 0;
	var Errors_1 = requireErrors();
	var Fragmenter_1 = requireFragmenter();
	var Frames_1 = requireFrames();
	var Reassembler = __importStar(requireReassembler());
	RequestFnFStream.RequestFnFRequesterStream = function() {
		function RequestFnFRequesterStream(payload, receiver, fragmentSize, leaseManager) {
			this.payload = payload;
			this.receiver = receiver;
			this.fragmentSize = fragmentSize;
			this.leaseManager = leaseManager;
			this.streamType = Frames_1.FrameTypes.REQUEST_FNF;
		}
		RequestFnFRequesterStream.prototype.handleReady = function(streamId, stream) {
			var e_1, _a;
			if (this.done) return false;
			this.streamId = streamId;
			if ((0, Fragmenter_1.isFragmentable)(this.payload, this.fragmentSize, Frames_1.FrameTypes.REQUEST_FNF)) try {
				for (var _b = __values((0, Fragmenter_1.fragment)(streamId, this.payload, this.fragmentSize, Frames_1.FrameTypes.REQUEST_FNF)), _c = _b.next(); !_c.done; _c = _b.next()) {
					var frame = _c.value;
					stream.send(frame);
				}
			} catch (e_1_1) {
				e_1 = { error: e_1_1 };
			} finally {
				try {
					if (_c && !_c.done && (_a = _b.return)) _a.call(_b);
				} finally {
					if (e_1) throw e_1.error;
				}
			}
			else stream.send({
				type: Frames_1.FrameTypes.REQUEST_FNF,
				data: this.payload.data,
				metadata: this.payload.metadata,
				flags: this.payload.metadata ? Frames_1.Flags.METADATA : 0,
				streamId
			});
			this.done = true;
			this.receiver.onComplete();
			return true;
		};
		RequestFnFRequesterStream.prototype.handleReject = function(error) {
			if (this.done) return;
			this.done = true;
			this.receiver.onError(error);
		};
		RequestFnFRequesterStream.prototype.cancel = function() {
			var _a;
			if (this.done) return;
			this.done = true;
			(_a = this.leaseManager) === null || _a === void 0 || _a.cancelRequest(this);
		};
		RequestFnFRequesterStream.prototype.handle = function(frame) {
			if (frame.type == Frames_1.FrameTypes.ERROR) {
				this.close(new Errors_1.RSocketError(frame.code, frame.message));
				return;
			}
			this.close(new Errors_1.RSocketError(Errors_1.ErrorCodes.CANCELED, "Received invalid frame"));
		};
		RequestFnFRequesterStream.prototype.close = function(error) {
			if (this.done) {
				console.warn("Trying to close for the second time. ".concat(error ? "Dropping error [".concat(error, "].") : ""));
				return;
			}
			if (error) this.receiver.onError(error);
			else this.receiver.onComplete();
		};
		return RequestFnFRequesterStream;
	}();
	RequestFnFStream.RequestFnfResponderStream = function() {
		function RequestFnfResponderStream(streamId, stream, handler, frame) {
			this.streamId = streamId;
			this.stream = stream;
			this.handler = handler;
			this.streamType = Frames_1.FrameTypes.REQUEST_FNF;
			if (Frames_1.Flags.hasFollows(frame.flags)) {
				Reassembler.add(this, frame.data, frame.metadata);
				stream.connect(this);
				return;
			}
			var payload = {
				data: frame.data,
				metadata: frame.metadata
			};
			try {
				this.cancellable = handler(payload, this);
			} catch (e) {}
		}
		RequestFnfResponderStream.prototype.handle = function(frame) {
			var errorMessage;
			if (frame.type == Frames_1.FrameTypes.PAYLOAD) if (Frames_1.Flags.hasFollows(frame.flags)) {
				if (Reassembler.add(this, frame.data, frame.metadata)) return;
				errorMessage = "Unexpected fragment size";
			} else {
				this.stream.disconnect(this);
				var payload = Reassembler.reassemble(this, frame.data, frame.metadata);
				try {
					this.cancellable = this.handler(payload, this);
				} catch (e) {}
				return;
			}
			else errorMessage = "Unexpected frame type [".concat(frame.type, "]");
			this.done = true;
			if (frame.type != Frames_1.FrameTypes.CANCEL && frame.type != Frames_1.FrameTypes.ERROR) this.stream.send({
				type: Frames_1.FrameTypes.ERROR,
				streamId: this.streamId,
				flags: Frames_1.Flags.NONE,
				code: Errors_1.ErrorCodes.CANCELED,
				message: errorMessage
			});
			this.stream.disconnect(this);
			Reassembler.cancel(this);
		};
		RequestFnfResponderStream.prototype.close = function(error) {
			var _a;
			if (this.done) {
				console.warn("Trying to close for the second time. ".concat(error ? "Dropping error [".concat(error, "].") : ""));
				return;
			}
			this.done = true;
			Reassembler.cancel(this);
			(_a = this.cancellable) === null || _a === void 0 || _a.cancel();
		};
		RequestFnfResponderStream.prototype.onError = function(error) {};
		RequestFnfResponderStream.prototype.onComplete = function() {};
		return RequestFnfResponderStream;
	}();
	return RequestFnFStream;
}
var RequestResponseStream = {};
var hasRequiredRequestResponseStream;
function requireRequestResponseStream() {
	if (hasRequiredRequestResponseStream) return RequestResponseStream;
	hasRequiredRequestResponseStream = 1;
	var __createBinding = RequestResponseStream && RequestResponseStream.__createBinding || (Object.create ? (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		Object.defineProperty(o, k2, {
			enumerable: true,
			get: function() {
				return m[k];
			}
		});
	}) : (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		o[k2] = m[k];
	}));
	var __setModuleDefault = RequestResponseStream && RequestResponseStream.__setModuleDefault || (Object.create ? (function(o, v) {
		Object.defineProperty(o, "default", {
			enumerable: true,
			value: v
		});
	}) : function(o, v) {
		o["default"] = v;
	});
	var __importStar = RequestResponseStream && RequestResponseStream.__importStar || function(mod) {
		if (mod && mod.__esModule) return mod;
		var result = {};
		if (mod != null) {
			for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
		}
		__setModuleDefault(result, mod);
		return result;
	};
	var __values = RequestResponseStream && RequestResponseStream.__values || function(o) {
		var s = typeof Symbol === "function" && Symbol.iterator, m = s && o[s], i = 0;
		if (m) return m.call(o);
		if (o && typeof o.length === "number") return { next: function() {
			if (o && i >= o.length) o = void 0;
			return {
				value: o && o[i++],
				done: !o
			};
		} };
		throw new TypeError(s ? "Object is not iterable." : "Symbol.iterator is not defined.");
	};
	Object.defineProperty(RequestResponseStream, "__esModule", { value: true });
	RequestResponseStream.RequestResponseResponderStream = RequestResponseStream.RequestResponseRequesterStream = void 0;
	var Errors_1 = requireErrors();
	var Fragmenter_1 = requireFragmenter();
	var Frames_1 = requireFrames();
	var Reassembler = __importStar(requireReassembler());
	RequestResponseStream.RequestResponseRequesterStream = function() {
		function RequestResponseRequesterStream(payload, receiver, fragmentSize, leaseManager) {
			this.payload = payload;
			this.receiver = receiver;
			this.fragmentSize = fragmentSize;
			this.leaseManager = leaseManager;
			this.streamType = Frames_1.FrameTypes.REQUEST_RESPONSE;
		}
		RequestResponseRequesterStream.prototype.handleReady = function(streamId, stream) {
			var e_1, _a;
			if (this.done) return false;
			this.streamId = streamId;
			this.stream = stream;
			stream.connect(this);
			if ((0, Fragmenter_1.isFragmentable)(this.payload, this.fragmentSize, Frames_1.FrameTypes.REQUEST_RESPONSE)) try {
				for (var _b = __values((0, Fragmenter_1.fragment)(streamId, this.payload, this.fragmentSize, Frames_1.FrameTypes.REQUEST_RESPONSE)), _c = _b.next(); !_c.done; _c = _b.next()) {
					var frame = _c.value;
					this.stream.send(frame);
				}
			} catch (e_1_1) {
				e_1 = { error: e_1_1 };
			} finally {
				try {
					if (_c && !_c.done && (_a = _b.return)) _a.call(_b);
				} finally {
					if (e_1) throw e_1.error;
				}
			}
			else this.stream.send({
				type: Frames_1.FrameTypes.REQUEST_RESPONSE,
				data: this.payload.data,
				metadata: this.payload.metadata,
				flags: this.payload.metadata ? Frames_1.Flags.METADATA : 0,
				streamId
			});
			if (this.hasExtension) this.stream.send({
				type: Frames_1.FrameTypes.EXT,
				streamId,
				extendedContent: this.extendedContent,
				extendedType: this.extendedType,
				flags: this.flags
			});
			return true;
		};
		RequestResponseRequesterStream.prototype.handleReject = function(error) {
			if (this.done) return;
			this.done = true;
			this.receiver.onError(error);
		};
		RequestResponseRequesterStream.prototype.handle = function(frame) {
			var errorMessage;
			var frameType = frame.type;
			switch (frameType) {
				case Frames_1.FrameTypes.PAYLOAD:
					var hasComplete = Frames_1.Flags.hasComplete(frame.flags);
					var hasPayload = Frames_1.Flags.hasNext(frame.flags);
					if (hasComplete || !Frames_1.Flags.hasFollows(frame.flags)) {
						this.done = true;
						this.stream.disconnect(this);
						if (!hasPayload) {
							this.receiver.onComplete();
							return;
						}
						var payload = this.hasFragments ? Reassembler.reassemble(this, frame.data, frame.metadata) : {
							data: frame.data,
							metadata: frame.metadata
						};
						this.receiver.onNext(payload, true);
						return;
					}
					if (!Reassembler.add(this, frame.data, frame.metadata)) {
						errorMessage = "Unexpected fragment size";
						break;
					}
					return;
				case Frames_1.FrameTypes.ERROR:
					this.done = true;
					this.stream.disconnect(this);
					Reassembler.cancel(this);
					this.receiver.onError(new Errors_1.RSocketError(frame.code, frame.message));
					return;
				case Frames_1.FrameTypes.EXT:
					if (this.hasFragments) {
						errorMessage = "Unexpected frame type [".concat(frameType, "] during reassembly");
						break;
					}
					this.receiver.onExtension(frame.extendedType, frame.extendedContent, Frames_1.Flags.hasIgnore(frame.flags));
					return;
				default: errorMessage = "Unexpected frame type [".concat(frameType, "]");
			}
			this.close(new Errors_1.RSocketError(Errors_1.ErrorCodes.CANCELED, errorMessage));
			this.stream.send({
				type: Frames_1.FrameTypes.CANCEL,
				streamId: this.streamId,
				flags: Frames_1.Flags.NONE
			});
			this.stream.disconnect(this);
		};
		RequestResponseRequesterStream.prototype.cancel = function() {
			var _a;
			if (this.done) return;
			this.done = true;
			if (!this.streamId) {
				(_a = this.leaseManager) === null || _a === void 0 || _a.cancelRequest(this);
				return;
			}
			this.stream.send({
				type: Frames_1.FrameTypes.CANCEL,
				flags: Frames_1.Flags.NONE,
				streamId: this.streamId
			});
			this.stream.disconnect(this);
			Reassembler.cancel(this);
		};
		RequestResponseRequesterStream.prototype.onExtension = function(extendedType, content, canBeIgnored) {
			if (this.done) return;
			if (!this.streamId) {
				this.hasExtension = true;
				this.extendedType = extendedType;
				this.extendedContent = content;
				this.flags = canBeIgnored ? Frames_1.Flags.IGNORE : Frames_1.Flags.NONE;
				return;
			}
			this.stream.send({
				streamId: this.streamId,
				type: Frames_1.FrameTypes.EXT,
				extendedType,
				extendedContent: content,
				flags: canBeIgnored ? Frames_1.Flags.IGNORE : Frames_1.Flags.NONE
			});
		};
		RequestResponseRequesterStream.prototype.close = function(error) {
			if (this.done) return;
			this.done = true;
			Reassembler.cancel(this);
			if (error) this.receiver.onError(error);
			else this.receiver.onComplete();
		};
		return RequestResponseRequesterStream;
	}();
	RequestResponseStream.RequestResponseResponderStream = function() {
		function RequestResponseResponderStream(streamId, stream, fragmentSize, handler, frame) {
			this.streamId = streamId;
			this.stream = stream;
			this.fragmentSize = fragmentSize;
			this.handler = handler;
			this.streamType = Frames_1.FrameTypes.REQUEST_RESPONSE;
			stream.connect(this);
			if (Frames_1.Flags.hasFollows(frame.flags)) {
				Reassembler.add(this, frame.data, frame.metadata);
				return;
			}
			var payload = {
				data: frame.data,
				metadata: frame.metadata
			};
			try {
				this.receiver = handler(payload, this);
			} catch (error) {
				this.onError(error);
			}
		}
		RequestResponseResponderStream.prototype.handle = function(frame) {
			var _a;
			var errorMessage;
			if (!this.receiver || this.hasFragments) if (frame.type === Frames_1.FrameTypes.PAYLOAD) if (Frames_1.Flags.hasFollows(frame.flags)) {
				if (Reassembler.add(this, frame.data, frame.metadata)) return;
				errorMessage = "Unexpected fragment size";
			} else {
				var payload = Reassembler.reassemble(this, frame.data, frame.metadata);
				try {
					this.receiver = this.handler(payload, this);
				} catch (error) {
					this.onError(error);
				}
				return;
			}
			else errorMessage = "Unexpected frame type [".concat(frame.type, "] during reassembly");
			else if (frame.type === Frames_1.FrameTypes.EXT) {
				this.receiver.onExtension(frame.extendedType, frame.extendedContent, Frames_1.Flags.hasIgnore(frame.flags));
				return;
			} else errorMessage = "Unexpected frame type [".concat(frame.type, "]");
			this.done = true;
			(_a = this.receiver) === null || _a === void 0 || _a.cancel();
			if (frame.type !== Frames_1.FrameTypes.CANCEL && frame.type !== Frames_1.FrameTypes.ERROR) this.stream.send({
				type: Frames_1.FrameTypes.ERROR,
				flags: Frames_1.Flags.NONE,
				code: Errors_1.ErrorCodes.CANCELED,
				message: errorMessage,
				streamId: this.streamId
			});
			this.stream.disconnect(this);
			Reassembler.cancel(this);
		};
		RequestResponseResponderStream.prototype.onError = function(error) {
			if (this.done) {
				console.warn("Trying to error for the second time. ".concat(error ? "Dropping error [".concat(error, "].") : ""));
				return;
			}
			this.done = true;
			this.stream.send({
				type: Frames_1.FrameTypes.ERROR,
				flags: Frames_1.Flags.NONE,
				code: error instanceof Errors_1.RSocketError ? error.code : Errors_1.ErrorCodes.APPLICATION_ERROR,
				message: error.message,
				streamId: this.streamId
			});
			this.stream.disconnect(this);
		};
		RequestResponseResponderStream.prototype.onNext = function(payload, isCompletion) {
			var e_2, _a;
			if (this.done) return;
			this.done = true;
			if ((0, Fragmenter_1.isFragmentable)(payload, this.fragmentSize, Frames_1.FrameTypes.PAYLOAD)) try {
				for (var _b = __values((0, Fragmenter_1.fragment)(this.streamId, payload, this.fragmentSize, Frames_1.FrameTypes.PAYLOAD, true)), _c = _b.next(); !_c.done; _c = _b.next()) {
					var frame = _c.value;
					this.stream.send(frame);
				}
			} catch (e_2_1) {
				e_2 = { error: e_2_1 };
			} finally {
				try {
					if (_c && !_c.done && (_a = _b.return)) _a.call(_b);
				} finally {
					if (e_2) throw e_2.error;
				}
			}
			else this.stream.send({
				type: Frames_1.FrameTypes.PAYLOAD,
				flags: Frames_1.Flags.NEXT | Frames_1.Flags.COMPLETE | (payload.metadata ? Frames_1.Flags.METADATA : 0),
				data: payload.data,
				metadata: payload.metadata,
				streamId: this.streamId
			});
			this.stream.disconnect(this);
		};
		RequestResponseResponderStream.prototype.onComplete = function() {
			if (this.done) return;
			this.done = true;
			this.stream.send({
				type: Frames_1.FrameTypes.PAYLOAD,
				flags: Frames_1.Flags.COMPLETE,
				streamId: this.streamId,
				data: null,
				metadata: null
			});
			this.stream.disconnect(this);
		};
		RequestResponseResponderStream.prototype.onExtension = function(extendedType, content, canBeIgnored) {
			if (this.done) return;
			this.stream.send({
				type: Frames_1.FrameTypes.EXT,
				streamId: this.streamId,
				flags: canBeIgnored ? Frames_1.Flags.IGNORE : Frames_1.Flags.NONE,
				extendedType,
				extendedContent: content
			});
		};
		RequestResponseResponderStream.prototype.close = function(error) {
			var _a;
			if (this.done) {
				console.warn("Trying to close for the second time. ".concat(error ? "Dropping error [".concat(error, "].") : ""));
				return;
			}
			Reassembler.cancel(this);
			(_a = this.receiver) === null || _a === void 0 || _a.cancel();
		};
		return RequestResponseResponderStream;
	}();
	return RequestResponseStream;
}
var RequestStreamStream = {};
var hasRequiredRequestStreamStream;
function requireRequestStreamStream() {
	if (hasRequiredRequestStreamStream) return RequestStreamStream;
	hasRequiredRequestStreamStream = 1;
	var __createBinding = RequestStreamStream && RequestStreamStream.__createBinding || (Object.create ? (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		Object.defineProperty(o, k2, {
			enumerable: true,
			get: function() {
				return m[k];
			}
		});
	}) : (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		o[k2] = m[k];
	}));
	var __setModuleDefault = RequestStreamStream && RequestStreamStream.__setModuleDefault || (Object.create ? (function(o, v) {
		Object.defineProperty(o, "default", {
			enumerable: true,
			value: v
		});
	}) : function(o, v) {
		o["default"] = v;
	});
	var __importStar = RequestStreamStream && RequestStreamStream.__importStar || function(mod) {
		if (mod && mod.__esModule) return mod;
		var result = {};
		if (mod != null) {
			for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
		}
		__setModuleDefault(result, mod);
		return result;
	};
	var __values = RequestStreamStream && RequestStreamStream.__values || function(o) {
		var s = typeof Symbol === "function" && Symbol.iterator, m = s && o[s], i = 0;
		if (m) return m.call(o);
		if (o && typeof o.length === "number") return { next: function() {
			if (o && i >= o.length) o = void 0;
			return {
				value: o && o[i++],
				done: !o
			};
		} };
		throw new TypeError(s ? "Object is not iterable." : "Symbol.iterator is not defined.");
	};
	Object.defineProperty(RequestStreamStream, "__esModule", { value: true });
	RequestStreamStream.RequestStreamResponderStream = RequestStreamStream.RequestStreamRequesterStream = void 0;
	var Errors_1 = requireErrors();
	var Fragmenter_1 = requireFragmenter();
	var Frames_1 = requireFrames();
	var Reassembler = __importStar(requireReassembler());
	RequestStreamStream.RequestStreamRequesterStream = function() {
		function RequestStreamRequesterStream(payload, receiver, fragmentSize, initialRequestN, leaseManager) {
			this.payload = payload;
			this.receiver = receiver;
			this.fragmentSize = fragmentSize;
			this.initialRequestN = initialRequestN;
			this.leaseManager = leaseManager;
			this.streamType = Frames_1.FrameTypes.REQUEST_STREAM;
		}
		RequestStreamRequesterStream.prototype.handleReady = function(streamId, stream) {
			var e_1, _a;
			if (this.done) return false;
			this.streamId = streamId;
			this.stream = stream;
			stream.connect(this);
			if ((0, Fragmenter_1.isFragmentable)(this.payload, this.fragmentSize, Frames_1.FrameTypes.REQUEST_STREAM)) try {
				for (var _b = __values((0, Fragmenter_1.fragmentWithRequestN)(streamId, this.payload, this.fragmentSize, Frames_1.FrameTypes.REQUEST_STREAM, this.initialRequestN)), _c = _b.next(); !_c.done; _c = _b.next()) {
					var frame = _c.value;
					this.stream.send(frame);
				}
			} catch (e_1_1) {
				e_1 = { error: e_1_1 };
			} finally {
				try {
					if (_c && !_c.done && (_a = _b.return)) _a.call(_b);
				} finally {
					if (e_1) throw e_1.error;
				}
			}
			else this.stream.send({
				type: Frames_1.FrameTypes.REQUEST_STREAM,
				data: this.payload.data,
				metadata: this.payload.metadata,
				requestN: this.initialRequestN,
				flags: this.payload.metadata !== void 0 ? Frames_1.Flags.METADATA : 0,
				streamId
			});
			if (this.hasExtension) this.stream.send({
				type: Frames_1.FrameTypes.EXT,
				streamId,
				extendedContent: this.extendedContent,
				extendedType: this.extendedType,
				flags: this.flags
			});
			return true;
		};
		RequestStreamRequesterStream.prototype.handleReject = function(error) {
			if (this.done) return;
			this.done = true;
			this.receiver.onError(error);
		};
		RequestStreamRequesterStream.prototype.handle = function(frame) {
			var errorMessage;
			var frameType = frame.type;
			switch (frameType) {
				case Frames_1.FrameTypes.PAYLOAD:
					var hasComplete = Frames_1.Flags.hasComplete(frame.flags);
					var hasNext = Frames_1.Flags.hasNext(frame.flags);
					if (hasComplete || !Frames_1.Flags.hasFollows(frame.flags)) {
						if (hasComplete) {
							this.done = true;
							this.stream.disconnect(this);
							if (!hasNext) {
								this.receiver.onComplete();
								return;
							}
						}
						var payload = this.hasFragments ? Reassembler.reassemble(this, frame.data, frame.metadata) : {
							data: frame.data,
							metadata: frame.metadata
						};
						this.receiver.onNext(payload, hasComplete);
						return;
					}
					if (!Reassembler.add(this, frame.data, frame.metadata)) {
						errorMessage = "Unexpected fragment size";
						break;
					}
					return;
				case Frames_1.FrameTypes.ERROR:
					this.done = true;
					this.stream.disconnect(this);
					Reassembler.cancel(this);
					this.receiver.onError(new Errors_1.RSocketError(frame.code, frame.message));
					return;
				case Frames_1.FrameTypes.EXT:
					if (this.hasFragments) {
						errorMessage = "Unexpected frame type [".concat(frameType, "] during reassembly");
						break;
					}
					this.receiver.onExtension(frame.extendedType, frame.extendedContent, Frames_1.Flags.hasIgnore(frame.flags));
					return;
				default: errorMessage = "Unexpected frame type [".concat(frameType, "]");
			}
			this.close(new Errors_1.RSocketError(Errors_1.ErrorCodes.CANCELED, errorMessage));
			this.stream.send({
				type: Frames_1.FrameTypes.CANCEL,
				streamId: this.streamId,
				flags: Frames_1.Flags.NONE
			});
			this.stream.disconnect(this);
		};
		RequestStreamRequesterStream.prototype.request = function(n) {
			if (this.done) return;
			if (!this.streamId) {
				this.initialRequestN += n;
				return;
			}
			this.stream.send({
				type: Frames_1.FrameTypes.REQUEST_N,
				flags: Frames_1.Flags.NONE,
				requestN: n,
				streamId: this.streamId
			});
		};
		RequestStreamRequesterStream.prototype.cancel = function() {
			var _a;
			if (this.done) return;
			this.done = true;
			if (!this.streamId) {
				(_a = this.leaseManager) === null || _a === void 0 || _a.cancelRequest(this);
				return;
			}
			this.stream.send({
				type: Frames_1.FrameTypes.CANCEL,
				flags: Frames_1.Flags.NONE,
				streamId: this.streamId
			});
			this.stream.disconnect(this);
			Reassembler.cancel(this);
		};
		RequestStreamRequesterStream.prototype.onExtension = function(extendedType, content, canBeIgnored) {
			if (this.done) return;
			if (!this.streamId) {
				this.hasExtension = true;
				this.extendedType = extendedType;
				this.extendedContent = content;
				this.flags = canBeIgnored ? Frames_1.Flags.IGNORE : Frames_1.Flags.NONE;
				return;
			}
			this.stream.send({
				streamId: this.streamId,
				type: Frames_1.FrameTypes.EXT,
				extendedType,
				extendedContent: content,
				flags: canBeIgnored ? Frames_1.Flags.IGNORE : Frames_1.Flags.NONE
			});
		};
		RequestStreamRequesterStream.prototype.close = function(error) {
			if (this.done) return;
			this.done = true;
			Reassembler.cancel(this);
			if (error) this.receiver.onError(error);
			else this.receiver.onComplete();
		};
		return RequestStreamRequesterStream;
	}();
	RequestStreamStream.RequestStreamResponderStream = function() {
		function RequestStreamResponderStream(streamId, stream, fragmentSize, handler, frame) {
			this.streamId = streamId;
			this.stream = stream;
			this.fragmentSize = fragmentSize;
			this.handler = handler;
			this.streamType = Frames_1.FrameTypes.REQUEST_STREAM;
			stream.connect(this);
			if (Frames_1.Flags.hasFollows(frame.flags)) {
				this.initialRequestN = frame.requestN;
				Reassembler.add(this, frame.data, frame.metadata);
				return;
			}
			var payload = {
				data: frame.data,
				metadata: frame.metadata
			};
			try {
				this.receiver = handler(payload, frame.requestN, this);
			} catch (error) {
				this.onError(error);
			}
		}
		RequestStreamResponderStream.prototype.handle = function(frame) {
			var _a;
			var errorMessage;
			if (!this.receiver || this.hasFragments) if (frame.type === Frames_1.FrameTypes.PAYLOAD) if (Frames_1.Flags.hasFollows(frame.flags)) {
				if (Reassembler.add(this, frame.data, frame.metadata)) return;
				errorMessage = "Unexpected frame size";
			} else {
				var payload = Reassembler.reassemble(this, frame.data, frame.metadata);
				try {
					this.receiver = this.handler(payload, this.initialRequestN, this);
				} catch (error) {
					this.onError(error);
				}
				return;
			}
			else errorMessage = "Unexpected frame type [".concat(frame.type, "] during reassembly");
			else if (frame.type === Frames_1.FrameTypes.REQUEST_N) {
				this.receiver.request(frame.requestN);
				return;
			} else if (frame.type === Frames_1.FrameTypes.EXT) {
				this.receiver.onExtension(frame.extendedType, frame.extendedContent, Frames_1.Flags.hasIgnore(frame.flags));
				return;
			} else errorMessage = "Unexpected frame type [".concat(frame.type, "]");
			this.done = true;
			Reassembler.cancel(this);
			(_a = this.receiver) === null || _a === void 0 || _a.cancel();
			if (frame.type !== Frames_1.FrameTypes.CANCEL && frame.type !== Frames_1.FrameTypes.ERROR) this.stream.send({
				type: Frames_1.FrameTypes.ERROR,
				flags: Frames_1.Flags.NONE,
				code: Errors_1.ErrorCodes.CANCELED,
				message: errorMessage,
				streamId: this.streamId
			});
			this.stream.disconnect(this);
		};
		RequestStreamResponderStream.prototype.onError = function(error) {
			if (this.done) {
				console.warn("Trying to error for the second time. ".concat(error ? "Dropping error [".concat(error, "].") : ""));
				return;
			}
			this.done = true;
			this.stream.send({
				type: Frames_1.FrameTypes.ERROR,
				flags: Frames_1.Flags.NONE,
				code: error instanceof Errors_1.RSocketError ? error.code : Errors_1.ErrorCodes.APPLICATION_ERROR,
				message: error.message,
				streamId: this.streamId
			});
			this.stream.disconnect(this);
		};
		RequestStreamResponderStream.prototype.onNext = function(payload, isCompletion) {
			var e_2, _a;
			if (this.done) return;
			if (isCompletion) this.done = true;
			if ((0, Fragmenter_1.isFragmentable)(payload, this.fragmentSize, Frames_1.FrameTypes.PAYLOAD)) try {
				for (var _b = __values((0, Fragmenter_1.fragment)(this.streamId, payload, this.fragmentSize, Frames_1.FrameTypes.PAYLOAD, isCompletion)), _c = _b.next(); !_c.done; _c = _b.next()) {
					var frame = _c.value;
					this.stream.send(frame);
				}
			} catch (e_2_1) {
				e_2 = { error: e_2_1 };
			} finally {
				try {
					if (_c && !_c.done && (_a = _b.return)) _a.call(_b);
				} finally {
					if (e_2) throw e_2.error;
				}
			}
			else this.stream.send({
				type: Frames_1.FrameTypes.PAYLOAD,
				flags: Frames_1.Flags.NEXT | (isCompletion ? Frames_1.Flags.COMPLETE : Frames_1.Flags.NONE) | (payload.metadata ? Frames_1.Flags.METADATA : Frames_1.Flags.NONE),
				data: payload.data,
				metadata: payload.metadata,
				streamId: this.streamId
			});
			if (isCompletion) this.stream.disconnect(this);
		};
		RequestStreamResponderStream.prototype.onComplete = function() {
			if (this.done) return;
			this.done = true;
			this.stream.send({
				type: Frames_1.FrameTypes.PAYLOAD,
				flags: Frames_1.Flags.COMPLETE,
				streamId: this.streamId,
				data: null,
				metadata: null
			});
			this.stream.disconnect(this);
		};
		RequestStreamResponderStream.prototype.onExtension = function(extendedType, content, canBeIgnored) {
			if (this.done) return;
			this.stream.send({
				type: Frames_1.FrameTypes.EXT,
				streamId: this.streamId,
				flags: canBeIgnored ? Frames_1.Flags.IGNORE : Frames_1.Flags.NONE,
				extendedType,
				extendedContent: content
			});
		};
		RequestStreamResponderStream.prototype.close = function(error) {
			var _a;
			if (this.done) {
				console.warn("Trying to close for the second time. ".concat(error ? "Dropping error [".concat(error, "].") : ""));
				return;
			}
			Reassembler.cancel(this);
			(_a = this.receiver) === null || _a === void 0 || _a.cancel();
		};
		return RequestStreamResponderStream;
	}();
	return RequestStreamStream;
}
var hasRequiredRSocketSupport;
function requireRSocketSupport() {
	if (hasRequiredRSocketSupport) return RSocketSupport;
	hasRequiredRSocketSupport = 1;
	Object.defineProperty(RSocketSupport, "__esModule", { value: true });
	RSocketSupport.KeepAliveSender = RSocketSupport.KeepAliveHandler = RSocketSupport.DefaultConnectionFrameHandler = RSocketSupport.DefaultStreamRequestHandler = RSocketSupport.LeaseHandler = RSocketSupport.RSocketRequester = void 0;
	var Errors_1 = requireErrors();
	var Frames_1 = requireFrames();
	var RequestChannelStream_1 = requireRequestChannelStream();
	var RequestFnFStream_1 = requireRequestFnFStream();
	var RequestResponseStream_1 = requireRequestResponseStream();
	var RequestStreamStream_1 = requireRequestStreamStream();
	RSocketSupport.RSocketRequester = function() {
		function RSocketRequester(connection, fragmentSize, leaseManager) {
			this.connection = connection;
			this.fragmentSize = fragmentSize;
			this.leaseManager = leaseManager;
		}
		RSocketRequester.prototype.fireAndForget = function(payload, responderStream) {
			var handler = new RequestFnFStream_1.RequestFnFRequesterStream(payload, responderStream, this.fragmentSize, this.leaseManager);
			if (this.leaseManager) this.leaseManager.requestLease(handler);
			else this.connection.multiplexerDemultiplexer.createRequestStream(handler);
			return handler;
		};
		RSocketRequester.prototype.requestResponse = function(payload, responderStream) {
			var handler = new RequestResponseStream_1.RequestResponseRequesterStream(payload, responderStream, this.fragmentSize, this.leaseManager);
			if (this.leaseManager) this.leaseManager.requestLease(handler);
			else this.connection.multiplexerDemultiplexer.createRequestStream(handler);
			return handler;
		};
		RSocketRequester.prototype.requestStream = function(payload, initialRequestN, responderStream) {
			var handler = new RequestStreamStream_1.RequestStreamRequesterStream(payload, responderStream, this.fragmentSize, initialRequestN, this.leaseManager);
			if (this.leaseManager) this.leaseManager.requestLease(handler);
			else this.connection.multiplexerDemultiplexer.createRequestStream(handler);
			return handler;
		};
		RSocketRequester.prototype.requestChannel = function(payload, initialRequestN, isCompleted, responderStream) {
			var handler = new RequestChannelStream_1.RequestChannelRequesterStream(payload, isCompleted, responderStream, this.fragmentSize, initialRequestN, this.leaseManager);
			if (this.leaseManager) this.leaseManager.requestLease(handler);
			else this.connection.multiplexerDemultiplexer.createRequestStream(handler);
			return handler;
		};
		RSocketRequester.prototype.metadataPush = function(metadata, responderStream) {
			throw new Error("Method not implemented.");
		};
		RSocketRequester.prototype.close = function(error) {
			this.connection.close(error);
		};
		RSocketRequester.prototype.onClose = function(callback) {
			this.connection.onClose(callback);
		};
		return RSocketRequester;
	}();
	RSocketSupport.LeaseHandler = function() {
		function LeaseHandler(maxPendingRequests, multiplexer) {
			this.maxPendingRequests = maxPendingRequests;
			this.multiplexer = multiplexer;
			this.pendingRequests = [];
			this.expirationTime = 0;
			this.availableLease = 0;
		}
		LeaseHandler.prototype.handle = function(frame) {
			this.expirationTime = frame.ttl + Date.now();
			this.availableLease = frame.requestCount;
			while (this.availableLease > 0 && this.pendingRequests.length > 0) {
				var handler = this.pendingRequests.shift();
				this.availableLease--;
				this.multiplexer.createRequestStream(handler);
			}
		};
		LeaseHandler.prototype.requestLease = function(handler) {
			var availableLease = this.availableLease;
			if (availableLease > 0 && Date.now() < this.expirationTime) {
				this.availableLease = availableLease - 1;
				this.multiplexer.createRequestStream(handler);
				return;
			}
			if (this.pendingRequests.length >= this.maxPendingRequests) {
				handler.handleReject(new Errors_1.RSocketError(Errors_1.ErrorCodes.REJECTED, "No available lease given"));
				return;
			}
			this.pendingRequests.push(handler);
		};
		LeaseHandler.prototype.cancelRequest = function(handler) {
			var index = this.pendingRequests.indexOf(handler);
			if (index > -1) this.pendingRequests.splice(index, 1);
		};
		return LeaseHandler;
	}();
	RSocketSupport.DefaultStreamRequestHandler = function() {
		function DefaultStreamRequestHandler(rsocket, fragmentSize) {
			this.rsocket = rsocket;
			this.fragmentSize = fragmentSize;
		}
		DefaultStreamRequestHandler.prototype.handle = function(frame, stream) {
			switch (frame.type) {
				case Frames_1.FrameTypes.REQUEST_FNF:
					if (this.rsocket.fireAndForget) new RequestFnFStream_1.RequestFnfResponderStream(frame.streamId, stream, this.rsocket.fireAndForget.bind(this.rsocket), frame);
					return;
				case Frames_1.FrameTypes.REQUEST_RESPONSE:
					if (this.rsocket.requestResponse) {
						new RequestResponseStream_1.RequestResponseResponderStream(frame.streamId, stream, this.fragmentSize, this.rsocket.requestResponse.bind(this.rsocket), frame);
						return;
					}
					this.rejectRequest(frame.streamId, stream);
					return;
				case Frames_1.FrameTypes.REQUEST_STREAM:
					if (this.rsocket.requestStream) {
						new RequestStreamStream_1.RequestStreamResponderStream(frame.streamId, stream, this.fragmentSize, this.rsocket.requestStream.bind(this.rsocket), frame);
						return;
					}
					this.rejectRequest(frame.streamId, stream);
					return;
				case Frames_1.FrameTypes.REQUEST_CHANNEL:
					if (this.rsocket.requestChannel) {
						new RequestChannelStream_1.RequestChannelResponderStream(frame.streamId, stream, this.fragmentSize, this.rsocket.requestChannel.bind(this.rsocket), frame);
						return;
					}
					this.rejectRequest(frame.streamId, stream);
					return;
			}
		};
		DefaultStreamRequestHandler.prototype.rejectRequest = function(streamId, stream) {
			stream.send({
				type: Frames_1.FrameTypes.ERROR,
				streamId,
				flags: Frames_1.Flags.NONE,
				code: Errors_1.ErrorCodes.REJECTED,
				message: "No available handler found"
			});
		};
		DefaultStreamRequestHandler.prototype.close = function() {};
		return DefaultStreamRequestHandler;
	}();
	RSocketSupport.DefaultConnectionFrameHandler = function() {
		function DefaultConnectionFrameHandler(connection, keepAliveHandler, keepAliveSender, leaseHandler, rsocket) {
			this.connection = connection;
			this.keepAliveHandler = keepAliveHandler;
			this.keepAliveSender = keepAliveSender;
			this.leaseHandler = leaseHandler;
			this.rsocket = rsocket;
		}
		DefaultConnectionFrameHandler.prototype.handle = function(frame) {
			switch (frame.type) {
				case Frames_1.FrameTypes.KEEPALIVE:
					this.keepAliveHandler.handle(frame);
					return;
				case Frames_1.FrameTypes.LEASE:
					if (this.leaseHandler) {
						this.leaseHandler.handle(frame);
						return;
					}
					return;
				case Frames_1.FrameTypes.ERROR:
					this.connection.close(new Errors_1.RSocketError(frame.code, frame.message));
					return;
				case Frames_1.FrameTypes.METADATA_PUSH:
					if (this.rsocket.metadataPush);
					return;
				default: this.connection.multiplexerDemultiplexer.connectionOutbound.send({
					type: Frames_1.FrameTypes.ERROR,
					streamId: 0,
					flags: Frames_1.Flags.NONE,
					message: "Received unknown frame type",
					code: Errors_1.ErrorCodes.CONNECTION_ERROR
				});
			}
		};
		DefaultConnectionFrameHandler.prototype.pause = function() {
			var _a;
			this.keepAliveHandler.pause();
			(_a = this.keepAliveSender) === null || _a === void 0 || _a.pause();
		};
		DefaultConnectionFrameHandler.prototype.resume = function() {
			var _a;
			this.keepAliveHandler.start();
			(_a = this.keepAliveSender) === null || _a === void 0 || _a.start();
		};
		DefaultConnectionFrameHandler.prototype.close = function(error) {
			var _a;
			this.keepAliveHandler.close();
			(_a = this.rsocket.close) === null || _a === void 0 || _a.call(this.rsocket, error);
		};
		return DefaultConnectionFrameHandler;
	}();
	var KeepAliveHandlerStates;
	(function(KeepAliveHandlerStates) {
		KeepAliveHandlerStates[KeepAliveHandlerStates["Paused"] = 0] = "Paused";
		KeepAliveHandlerStates[KeepAliveHandlerStates["Running"] = 1] = "Running";
		KeepAliveHandlerStates[KeepAliveHandlerStates["Closed"] = 2] = "Closed";
	})(KeepAliveHandlerStates || (KeepAliveHandlerStates = {}));
	RSocketSupport.KeepAliveHandler = function() {
		function KeepAliveHandler(connection, keepAliveTimeoutDuration) {
			this.connection = connection;
			this.keepAliveTimeoutDuration = keepAliveTimeoutDuration;
			this.state = KeepAliveHandlerStates.Paused;
			this.outbound = connection.multiplexerDemultiplexer.connectionOutbound;
		}
		KeepAliveHandler.prototype.handle = function(frame) {
			this.keepAliveLastReceivedMillis = Date.now();
			if (Frames_1.Flags.hasRespond(frame.flags)) this.outbound.send({
				type: Frames_1.FrameTypes.KEEPALIVE,
				streamId: 0,
				data: frame.data,
				flags: frame.flags ^ Frames_1.Flags.RESPOND,
				lastReceivedPosition: 0
			});
		};
		KeepAliveHandler.prototype.start = function() {
			if (this.state !== KeepAliveHandlerStates.Paused) return;
			this.keepAliveLastReceivedMillis = Date.now();
			this.state = KeepAliveHandlerStates.Running;
			this.activeTimeout = setTimeout(this.timeoutCheck.bind(this), this.keepAliveTimeoutDuration);
		};
		KeepAliveHandler.prototype.pause = function() {
			if (this.state !== KeepAliveHandlerStates.Running) return;
			this.state = KeepAliveHandlerStates.Paused;
			clearTimeout(this.activeTimeout);
		};
		KeepAliveHandler.prototype.close = function() {
			this.state = KeepAliveHandlerStates.Closed;
			clearTimeout(this.activeTimeout);
		};
		KeepAliveHandler.prototype.timeoutCheck = function() {
			var noKeepAliveDuration = Date.now() - this.keepAliveLastReceivedMillis;
			if (noKeepAliveDuration >= this.keepAliveTimeoutDuration) this.connection.close(new Error("No keep-alive acks for ".concat(this.keepAliveTimeoutDuration, " millis")));
			else this.activeTimeout = setTimeout(this.timeoutCheck.bind(this), Math.max(100, this.keepAliveTimeoutDuration - noKeepAliveDuration));
		};
		return KeepAliveHandler;
	}();
	var KeepAliveSenderStates;
	(function(KeepAliveSenderStates) {
		KeepAliveSenderStates[KeepAliveSenderStates["Paused"] = 0] = "Paused";
		KeepAliveSenderStates[KeepAliveSenderStates["Running"] = 1] = "Running";
		KeepAliveSenderStates[KeepAliveSenderStates["Closed"] = 2] = "Closed";
	})(KeepAliveSenderStates || (KeepAliveSenderStates = {}));
	RSocketSupport.KeepAliveSender = function() {
		function KeepAliveSender(outbound, keepAlivePeriodDuration) {
			this.outbound = outbound;
			this.keepAlivePeriodDuration = keepAlivePeriodDuration;
			this.state = KeepAliveSenderStates.Paused;
		}
		KeepAliveSender.prototype.sendKeepAlive = function() {
			this.outbound.send({
				type: Frames_1.FrameTypes.KEEPALIVE,
				streamId: 0,
				data: void 0,
				flags: Frames_1.Flags.RESPOND,
				lastReceivedPosition: 0
			});
		};
		KeepAliveSender.prototype.start = function() {
			if (this.state !== KeepAliveSenderStates.Paused) return;
			this.state = KeepAliveSenderStates.Running;
			this.activeInterval = setInterval(this.sendKeepAlive.bind(this), this.keepAlivePeriodDuration);
		};
		KeepAliveSender.prototype.pause = function() {
			if (this.state !== KeepAliveSenderStates.Running) return;
			this.state = KeepAliveSenderStates.Paused;
			clearInterval(this.activeInterval);
		};
		KeepAliveSender.prototype.close = function() {
			this.state = KeepAliveSenderStates.Closed;
			clearInterval(this.activeInterval);
		};
		return KeepAliveSender;
	}();
	return RSocketSupport;
}
var Resume = {};
var hasRequiredResume;
function requireResume() {
	if (hasRequiredResume) return Resume;
	hasRequiredResume = 1;
	var __values = Resume && Resume.__values || function(o) {
		var s = typeof Symbol === "function" && Symbol.iterator, m = s && o[s], i = 0;
		if (m) return m.call(o);
		if (o && typeof o.length === "number") return { next: function() {
			if (o && i >= o.length) o = void 0;
			return {
				value: o && o[i++],
				done: !o
			};
		} };
		throw new TypeError(s ? "Object is not iterable." : "Symbol.iterator is not defined.");
	};
	Object.defineProperty(Resume, "__esModule", { value: true });
	Resume.FrameStore = void 0;
	var _1 = requireDist();
	var Codecs_1 = requireCodecs();
	Resume.FrameStore = function() {
		function FrameStore() {
			this.storedFrames = [];
			this._lastReceivedFramePosition = 0;
			this._firstAvailableFramePosition = 0;
			this._lastSentFramePosition = 0;
		}
		Object.defineProperty(FrameStore.prototype, "lastReceivedFramePosition", {
			get: function() {
				return this._lastReceivedFramePosition;
			},
			enumerable: false,
			configurable: true
		});
		Object.defineProperty(FrameStore.prototype, "firstAvailableFramePosition", {
			get: function() {
				return this._firstAvailableFramePosition;
			},
			enumerable: false,
			configurable: true
		});
		Object.defineProperty(FrameStore.prototype, "lastSentFramePosition", {
			get: function() {
				return this._lastSentFramePosition;
			},
			enumerable: false,
			configurable: true
		});
		FrameStore.prototype.store = function(frame) {
			this._lastSentFramePosition += (0, Codecs_1.sizeOfFrame)(frame);
			this.storedFrames.push(frame);
		};
		FrameStore.prototype.record = function(frame) {
			this._lastReceivedFramePosition += (0, Codecs_1.sizeOfFrame)(frame);
		};
		FrameStore.prototype.dropTo = function(lastReceivedPosition) {
			var bytesToDrop = lastReceivedPosition - this._firstAvailableFramePosition;
			while (bytesToDrop > 0 && this.storedFrames.length > 0) {
				var storedFrame = this.storedFrames.shift();
				bytesToDrop -= (0, Codecs_1.sizeOfFrame)(storedFrame);
			}
			if (bytesToDrop !== 0) throw new _1.RSocketError(_1.ErrorCodes.CONNECTION_ERROR, "State inconsistency. Expected bytes to drop ".concat(lastReceivedPosition - this._firstAvailableFramePosition, " but actual ").concat(bytesToDrop));
			this._firstAvailableFramePosition = lastReceivedPosition;
		};
		FrameStore.prototype.drain = function(consumer) {
			var e_1, _a;
			try {
				for (var _b = __values(this.storedFrames), _c = _b.next(); !_c.done; _c = _b.next()) {
					var frame = _c.value;
					consumer(frame);
				}
			} catch (e_1_1) {
				e_1 = { error: e_1_1 };
			} finally {
				try {
					if (_c && !_c.done && (_a = _b.return)) _a.call(_b);
				} finally {
					if (e_1) throw e_1.error;
				}
			}
		};
		return FrameStore;
	}();
	return Resume;
}
var hasRequiredRSocketConnector;
function requireRSocketConnector() {
	if (hasRequiredRSocketConnector) return RSocketConnector;
	hasRequiredRSocketConnector = 1;
	var __awaiter = RSocketConnector && RSocketConnector.__awaiter || function(thisArg, _arguments, P, generator) {
		function adopt(value) {
			return value instanceof P ? value : new P(function(resolve) {
				resolve(value);
			});
		}
		return new (P || (P = Promise))(function(resolve, reject) {
			function fulfilled(value) {
				try {
					step(generator.next(value));
				} catch (e) {
					reject(e);
				}
			}
			function rejected(value) {
				try {
					step(generator["throw"](value));
				} catch (e) {
					reject(e);
				}
			}
			function step(result) {
				result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);
			}
			step((generator = generator.apply(thisArg, _arguments || [])).next());
		});
	};
	var __generator = RSocketConnector && RSocketConnector.__generator || function(thisArg, body) {
		var _ = {
			label: 0,
			sent: function() {
				if (t[0] & 1) throw t[1];
				return t[1];
			},
			trys: [],
			ops: []
		}, f, y, t, g;
		return g = {
			next: verb(0),
			"throw": verb(1),
			"return": verb(2)
		}, typeof Symbol === "function" && (g[Symbol.iterator] = function() {
			return this;
		}), g;
		function verb(n) {
			return function(v) {
				return step([n, v]);
			};
		}
		function step(op) {
			if (f) throw new TypeError("Generator is already executing.");
			while (_) try {
				if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
				if (y = 0, t) op = [op[0] & 2, t.value];
				switch (op[0]) {
					case 0:
					case 1:
						t = op;
						break;
					case 4:
						_.label++;
						return {
							value: op[1],
							done: false
						};
					case 5:
						_.label++;
						y = op[1];
						op = [0];
						continue;
					case 7:
						op = _.ops.pop();
						_.trys.pop();
						continue;
					default:
						if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) {
							_ = 0;
							continue;
						}
						if (op[0] === 3 && (!t || op[1] > t[0] && op[1] < t[3])) {
							_.label = op[1];
							break;
						}
						if (op[0] === 6 && _.label < t[1]) {
							_.label = t[1];
							t = op;
							break;
						}
						if (t && _.label < t[2]) {
							_.label = t[2];
							_.ops.push(op);
							break;
						}
						if (t[2]) _.ops.pop();
						_.trys.pop();
						continue;
				}
				op = body.call(thisArg, _);
			} catch (e) {
				op = [6, e];
				y = 0;
			} finally {
				f = t = 0;
			}
			if (op[0] & 5) throw op[1];
			return {
				value: op[0] ? op[1] : void 0,
				done: true
			};
		}
	};
	Object.defineProperty(RSocketConnector, "__esModule", { value: true });
	RSocketConnector.RSocketConnector = void 0;
	var ClientServerMultiplexerDemultiplexer_1 = requireClientServerMultiplexerDemultiplexer();
	var Frames_1 = requireFrames();
	var RSocketSupport_1 = requireRSocketSupport();
	var Resume_1 = requireResume();
	RSocketConnector.RSocketConnector = function() {
		function RSocketConnector(config) {
			this.config = config;
		}
		RSocketConnector.prototype.connect = function() {
			var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v;
			return __awaiter(this, void 0, void 0, function() {
				var config, setupFrame, connection, keepAliveSender, keepAliveHandler, leaseHandler, responder, connectionFrameHandler, streamsHandler;
				var _this = this;
				return __generator(this, function(_w) {
					switch (_w.label) {
						case 0:
							config = this.config;
							setupFrame = {
								type: Frames_1.FrameTypes.SETUP,
								dataMimeType: (_b = (_a = config.setup) === null || _a === void 0 ? void 0 : _a.dataMimeType) !== null && _b !== void 0 ? _b : "application/octet-stream",
								metadataMimeType: (_d = (_c = config.setup) === null || _c === void 0 ? void 0 : _c.metadataMimeType) !== null && _d !== void 0 ? _d : "application/octet-stream",
								keepAlive: (_f = (_e = config.setup) === null || _e === void 0 ? void 0 : _e.keepAlive) !== null && _f !== void 0 ? _f : 6e4,
								lifetime: (_h = (_g = config.setup) === null || _g === void 0 ? void 0 : _g.lifetime) !== null && _h !== void 0 ? _h : 3e5,
								metadata: (_k = (_j = config.setup) === null || _j === void 0 ? void 0 : _j.payload) === null || _k === void 0 ? void 0 : _k.metadata,
								data: (_m = (_l = config.setup) === null || _l === void 0 ? void 0 : _l.payload) === null || _m === void 0 ? void 0 : _m.data,
								resumeToken: (_p = (_o = config.resume) === null || _o === void 0 ? void 0 : _o.tokenGenerator()) !== null && _p !== void 0 ? _p : null,
								streamId: 0,
								majorVersion: 1,
								minorVersion: 0,
								flags: (((_r = (_q = config.setup) === null || _q === void 0 ? void 0 : _q.payload) === null || _r === void 0 ? void 0 : _r.metadata) ? Frames_1.Flags.METADATA : Frames_1.Flags.NONE) | (config.lease ? Frames_1.Flags.LEASE : Frames_1.Flags.NONE) | (config.resume ? Frames_1.Flags.RESUME_ENABLE : Frames_1.Flags.NONE)
							};
							return [4, config.transport.connect(function(outbound) {
								return config.resume ? new ClientServerMultiplexerDemultiplexer_1.ResumableClientServerInputMultiplexerDemultiplexer(ClientServerMultiplexerDemultiplexer_1.StreamIdGenerator.create(-1), outbound, outbound, new Resume_1.FrameStore(), setupFrame.resumeToken.toString(), function(self, frameStore) {
									return __awaiter(_this, void 0, void 0, function() {
										var multiplexerDemultiplexerProvider, reconnectionAttempts, reconnector;
										return __generator(this, function(_a) {
											switch (_a.label) {
												case 0:
													multiplexerDemultiplexerProvider = function(outbound) {
														outbound.send({
															type: Frames_1.FrameTypes.RESUME,
															streamId: 0,
															flags: Frames_1.Flags.NONE,
															clientPosition: frameStore.firstAvailableFramePosition,
															serverPosition: frameStore.lastReceivedFramePosition,
															majorVersion: setupFrame.minorVersion,
															minorVersion: setupFrame.majorVersion,
															resumeToken: setupFrame.resumeToken
														});
														return new ClientServerMultiplexerDemultiplexer_1.ResumeOkAwaitingResumableClientServerInputMultiplexerDemultiplexer(outbound, outbound, self);
													};
													reconnectionAttempts = -1;
													reconnector = function() {
														reconnectionAttempts++;
														return config.resume.reconnectFunction(reconnectionAttempts).then(function() {
															return config.transport.connect(multiplexerDemultiplexerProvider).catch(reconnector);
														});
													};
													return [4, reconnector()];
												case 1:
													_a.sent();
													return [2];
											}
										});
									});
								}) : new ClientServerMultiplexerDemultiplexer_1.ClientServerInputMultiplexerDemultiplexer(ClientServerMultiplexerDemultiplexer_1.StreamIdGenerator.create(-1), outbound, outbound);
							})];
						case 1:
							connection = _w.sent();
							keepAliveSender = new RSocketSupport_1.KeepAliveSender(connection.multiplexerDemultiplexer.connectionOutbound, setupFrame.keepAlive);
							keepAliveHandler = new RSocketSupport_1.KeepAliveHandler(connection, setupFrame.lifetime);
							leaseHandler = config.lease ? new RSocketSupport_1.LeaseHandler((_s = config.lease.maxPendingRequests) !== null && _s !== void 0 ? _s : 256, connection.multiplexerDemultiplexer) : void 0;
							responder = (_t = config.responder) !== null && _t !== void 0 ? _t : {};
							connectionFrameHandler = new RSocketSupport_1.DefaultConnectionFrameHandler(connection, keepAliveHandler, keepAliveSender, leaseHandler, responder);
							streamsHandler = new RSocketSupport_1.DefaultStreamRequestHandler(responder, 0);
							connection.onClose(function(e) {
								keepAliveSender.close();
								keepAliveHandler.close();
								connectionFrameHandler.close(e);
							});
							connection.multiplexerDemultiplexer.connectionInbound(connectionFrameHandler);
							connection.multiplexerDemultiplexer.handleRequestStream(streamsHandler);
							connection.multiplexerDemultiplexer.connectionOutbound.send(setupFrame);
							keepAliveHandler.start();
							keepAliveSender.start();
							return [2, new RSocketSupport_1.RSocketRequester(connection, (_v = (_u = config.fragmentation) === null || _u === void 0 ? void 0 : _u.maxOutboundFragmentSize) !== null && _v !== void 0 ? _v : 0, leaseHandler)];
					}
				});
			});
		};
		return RSocketConnector;
	}();
	return RSocketConnector;
}
var RSocketServer = {};
var hasRequiredRSocketServer;
function requireRSocketServer() {
	if (hasRequiredRSocketServer) return RSocketServer;
	hasRequiredRSocketServer = 1;
	var __awaiter = RSocketServer && RSocketServer.__awaiter || function(thisArg, _arguments, P, generator) {
		function adopt(value) {
			return value instanceof P ? value : new P(function(resolve) {
				resolve(value);
			});
		}
		return new (P || (P = Promise))(function(resolve, reject) {
			function fulfilled(value) {
				try {
					step(generator.next(value));
				} catch (e) {
					reject(e);
				}
			}
			function rejected(value) {
				try {
					step(generator["throw"](value));
				} catch (e) {
					reject(e);
				}
			}
			function step(result) {
				result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);
			}
			step((generator = generator.apply(thisArg, _arguments || [])).next());
		});
	};
	var __generator = RSocketServer && RSocketServer.__generator || function(thisArg, body) {
		var _ = {
			label: 0,
			sent: function() {
				if (t[0] & 1) throw t[1];
				return t[1];
			},
			trys: [],
			ops: []
		}, f, y, t, g;
		return g = {
			next: verb(0),
			"throw": verb(1),
			"return": verb(2)
		}, typeof Symbol === "function" && (g[Symbol.iterator] = function() {
			return this;
		}), g;
		function verb(n) {
			return function(v) {
				return step([n, v]);
			};
		}
		function step(op) {
			if (f) throw new TypeError("Generator is already executing.");
			while (_) try {
				if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
				if (y = 0, t) op = [op[0] & 2, t.value];
				switch (op[0]) {
					case 0:
					case 1:
						t = op;
						break;
					case 4:
						_.label++;
						return {
							value: op[1],
							done: false
						};
					case 5:
						_.label++;
						y = op[1];
						op = [0];
						continue;
					case 7:
						op = _.ops.pop();
						_.trys.pop();
						continue;
					default:
						if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) {
							_ = 0;
							continue;
						}
						if (op[0] === 3 && (!t || op[1] > t[0] && op[1] < t[3])) {
							_.label = op[1];
							break;
						}
						if (op[0] === 6 && _.label < t[1]) {
							_.label = t[1];
							t = op;
							break;
						}
						if (t && _.label < t[2]) {
							_.label = t[2];
							_.ops.push(op);
							break;
						}
						if (t[2]) _.ops.pop();
						_.trys.pop();
						continue;
				}
				op = body.call(thisArg, _);
			} catch (e) {
				op = [6, e];
				y = 0;
			} finally {
				f = t = 0;
			}
			if (op[0] & 5) throw op[1];
			return {
				value: op[0] ? op[1] : void 0,
				done: true
			};
		}
	};
	Object.defineProperty(RSocketServer, "__esModule", { value: true });
	RSocketServer.RSocketServer = void 0;
	var ClientServerMultiplexerDemultiplexer_1 = requireClientServerMultiplexerDemultiplexer();
	var Errors_1 = requireErrors();
	var Frames_1 = requireFrames();
	var RSocketSupport_1 = requireRSocketSupport();
	var Resume_1 = requireResume();
	RSocketServer.RSocketServer = function() {
		function RSocketServer(config) {
			var _a, _b;
			this.acceptor = config.acceptor;
			this.transport = config.transport;
			this.lease = config.lease;
			this.serverSideKeepAlive = config.serverSideKeepAlive;
			this.sessionStore = config.resume ? {} : void 0;
			this.sessionTimeout = (_b = (_a = config.resume) === null || _a === void 0 ? void 0 : _a.sessionTimeout) !== null && _b !== void 0 ? _b : void 0;
		}
		RSocketServer.prototype.bind = function() {
			return __awaiter(this, void 0, void 0, function() {
				var _this = this;
				return __generator(this, function(_a) {
					switch (_a.label) {
						case 0: return [4, this.transport.bind(function(frame, connection) {
							return __awaiter(_this, void 0, void 0, function() {
								var _a, error, error, leaseHandler, requester, responder, keepAliveHandler_1, keepAliveSender_1, connectionFrameHandler_1, streamsHandler, e_1;
								var _b, _c, _d, _e;
								return __generator(this, function(_f) {
									switch (_f.label) {
										case 0:
											_a = frame.type;
											switch (_a) {
												case Frames_1.FrameTypes.SETUP: return [3, 1];
												case Frames_1.FrameTypes.RESUME: return [3, 5];
											}
											return [3, 6];
										case 1:
											_f.trys.push([
												1,
												3,
												,
												4
											]);
											if (this.lease && !Frames_1.Flags.hasLease(frame.flags)) {
												error = new Errors_1.RSocketError(Errors_1.ErrorCodes.REJECTED_SETUP, "Lease has to be enabled");
												connection.multiplexerDemultiplexer.connectionOutbound.send({
													type: Frames_1.FrameTypes.ERROR,
													streamId: 0,
													flags: Frames_1.Flags.NONE,
													code: error.code,
													message: error.message
												});
												connection.close(error);
												return [2];
											}
											if (Frames_1.Flags.hasLease(frame.flags) && !this.lease) {
												error = new Errors_1.RSocketError(Errors_1.ErrorCodes.REJECTED_SETUP, "Lease has to be disabled");
												connection.multiplexerDemultiplexer.connectionOutbound.send({
													type: Frames_1.FrameTypes.ERROR,
													streamId: 0,
													flags: Frames_1.Flags.NONE,
													code: error.code,
													message: error.message
												});
												connection.close(error);
												return [2];
											}
											leaseHandler = Frames_1.Flags.hasLease(frame.flags) ? new RSocketSupport_1.LeaseHandler((_b = this.lease.maxPendingRequests) !== null && _b !== void 0 ? _b : 256, connection.multiplexerDemultiplexer) : void 0;
											requester = new RSocketSupport_1.RSocketRequester(connection, (_d = (_c = this.fragmentation) === null || _c === void 0 ? void 0 : _c.maxOutboundFragmentSize) !== null && _d !== void 0 ? _d : 0, leaseHandler);
											return [4, this.acceptor.accept({
												data: frame.data,
												dataMimeType: frame.dataMimeType,
												metadata: frame.metadata,
												metadataMimeType: frame.metadataMimeType,
												flags: frame.flags,
												keepAliveMaxLifetime: frame.lifetime,
												keepAliveInterval: frame.keepAlive,
												resumeToken: frame.resumeToken
											}, requester)];
										case 2:
											responder = _f.sent();
											keepAliveHandler_1 = new RSocketSupport_1.KeepAliveHandler(connection, frame.lifetime);
											keepAliveSender_1 = this.serverSideKeepAlive ? new RSocketSupport_1.KeepAliveSender(connection.multiplexerDemultiplexer.connectionOutbound, frame.keepAlive) : void 0;
											connectionFrameHandler_1 = new RSocketSupport_1.DefaultConnectionFrameHandler(connection, keepAliveHandler_1, keepAliveSender_1, leaseHandler, responder);
											streamsHandler = new RSocketSupport_1.DefaultStreamRequestHandler(responder, 0);
											connection.onClose(function(e) {
												keepAliveSender_1 === null || keepAliveSender_1 === void 0 || keepAliveSender_1.close();
												keepAliveHandler_1.close();
												connectionFrameHandler_1.close(e);
											});
											connection.multiplexerDemultiplexer.connectionInbound(connectionFrameHandler_1);
											connection.multiplexerDemultiplexer.handleRequestStream(streamsHandler);
											keepAliveHandler_1.start();
											keepAliveSender_1 === null || keepAliveSender_1 === void 0 || keepAliveSender_1.start();
											return [3, 4];
										case 3:
											e_1 = _f.sent();
											connection.multiplexerDemultiplexer.connectionOutbound.send({
												type: Frames_1.FrameTypes.ERROR,
												streamId: 0,
												code: Errors_1.ErrorCodes.REJECTED_SETUP,
												message: (_e = e_1.message) !== null && _e !== void 0 ? _e : "",
												flags: Frames_1.Flags.NONE
											});
											connection.close(e_1 instanceof Errors_1.RSocketError ? e_1 : new Errors_1.RSocketError(Errors_1.ErrorCodes.REJECTED_SETUP, e_1.message));
											return [3, 4];
										case 4: return [2];
										case 5: return [2];
										case 6:
											connection.multiplexerDemultiplexer.connectionOutbound.send({
												type: Frames_1.FrameTypes.ERROR,
												streamId: 0,
												code: Errors_1.ErrorCodes.UNSUPPORTED_SETUP,
												message: "Unsupported setup",
												flags: Frames_1.Flags.NONE
											});
											connection.close(new Errors_1.RSocketError(Errors_1.ErrorCodes.UNSUPPORTED_SETUP));
											_f.label = 7;
										case 7: return [2];
									}
								});
							});
						}, function(frame, outbound) {
							if (frame.type === Frames_1.FrameTypes.RESUME) {
								if (_this.sessionStore) {
									var multiplexerDemultiplexer = _this.sessionStore[frame.resumeToken.toString()];
									if (!multiplexerDemultiplexer) {
										outbound.send({
											type: Frames_1.FrameTypes.ERROR,
											streamId: 0,
											code: Errors_1.ErrorCodes.REJECTED_RESUME,
											message: "No session found for the given resume token",
											flags: Frames_1.Flags.NONE
										});
										outbound.close();
										return;
									}
									multiplexerDemultiplexer.resume(frame, outbound, outbound);
									return multiplexerDemultiplexer;
								}
								outbound.send({
									type: Frames_1.FrameTypes.ERROR,
									streamId: 0,
									code: Errors_1.ErrorCodes.REJECTED_RESUME,
									message: "Resume is not enabled",
									flags: Frames_1.Flags.NONE
								});
								outbound.close();
								return;
							} else if (frame.type === Frames_1.FrameTypes.SETUP) {
								if (Frames_1.Flags.hasResume(frame.flags)) {
									if (!_this.sessionStore) {
										var error = new Errors_1.RSocketError(Errors_1.ErrorCodes.REJECTED_SETUP, "No resume support");
										outbound.send({
											type: Frames_1.FrameTypes.ERROR,
											streamId: 0,
											flags: Frames_1.Flags.NONE,
											code: error.code,
											message: error.message
										});
										outbound.close(error);
										return;
									}
									var multiplexerDumiltiplexer = new ClientServerMultiplexerDemultiplexer_1.ResumableClientServerInputMultiplexerDemultiplexer(ClientServerMultiplexerDemultiplexer_1.StreamIdGenerator.create(0), outbound, outbound, new Resume_1.FrameStore(), frame.resumeToken.toString(), _this.sessionStore, _this.sessionTimeout);
									_this.sessionStore[frame.resumeToken.toString()] = multiplexerDumiltiplexer;
									return multiplexerDumiltiplexer;
								}
							}
							return new ClientServerMultiplexerDemultiplexer_1.ClientServerInputMultiplexerDemultiplexer(ClientServerMultiplexerDemultiplexer_1.StreamIdGenerator.create(0), outbound, outbound);
						})];
						case 1: return [2, _a.sent()];
					}
				});
			});
		};
		return RSocketServer;
	}();
	return RSocketServer;
}
var Transport = {};
var hasRequiredTransport;
function requireTransport() {
	if (hasRequiredTransport) return Transport;
	hasRequiredTransport = 1;
	Object.defineProperty(Transport, "__esModule", { value: true });
	return Transport;
}
var hasRequiredDist;
function requireDist() {
	if (hasRequiredDist) return dist;
	hasRequiredDist = 1;
	(function(exports$1) {
		var __createBinding = dist && dist.__createBinding || (Object.create ? (function(o, m, k, k2) {
			if (k2 === void 0) k2 = k;
			Object.defineProperty(o, k2, {
				enumerable: true,
				get: function() {
					return m[k];
				}
			});
		}) : (function(o, m, k, k2) {
			if (k2 === void 0) k2 = k;
			o[k2] = m[k];
		}));
		var __exportStar = dist && dist.__exportStar || function(m, exports$1) {
			for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports$1, p)) __createBinding(exports$1, m, p);
		};
		Object.defineProperty(exports$1, "__esModule", { value: true });
		__exportStar(requireCodecs(), exports$1);
		__exportStar(requireCommon(), exports$1);
		__exportStar(requireDeferred(), exports$1);
		__exportStar(requireErrors(), exports$1);
		__exportStar(requireFrames(), exports$1);
		__exportStar(requireRSocket(), exports$1);
		__exportStar(requireRSocketConnector(), exports$1);
		__exportStar(requireRSocketServer(), exports$1);
		__exportStar(requireTransport(), exports$1);
	})(dist);
	return dist;
}
requireDist();
var PACKAGE = { version: "1.55.0" };
var WebsocketDuplexConnection = {};
var hasRequiredWebsocketDuplexConnection;
function requireWebsocketDuplexConnection() {
	if (hasRequiredWebsocketDuplexConnection) return WebsocketDuplexConnection;
	hasRequiredWebsocketDuplexConnection = 1;
	var __extends = WebsocketDuplexConnection && WebsocketDuplexConnection.__extends || (function() {
		var extendStatics = function(d, b) {
			extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d, b) {
				d.__proto__ = b;
			} || function(d, b) {
				for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p];
			};
			return extendStatics(d, b);
		};
		return function(d, b) {
			if (typeof b !== "function" && b !== null) throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
			extendStatics(d, b);
			function __() {
				this.constructor = d;
			}
			d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
		};
	})();
	Object.defineProperty(WebsocketDuplexConnection, "__esModule", { value: true });
	WebsocketDuplexConnection.WebsocketDuplexConnection = void 0;
	var rsocket_core_1 = requireDist();
	WebsocketDuplexConnection.WebsocketDuplexConnection = function(_super) {
		__extends(WebsocketDuplexConnection, _super);
		function WebsocketDuplexConnection(websocket, deserializer, multiplexerDemultiplexerFactory) {
			var _this = _super.call(this) || this;
			_this.websocket = websocket;
			_this.deserializer = deserializer;
			_this.handleClosed = function(e) {
				_this.close(new Error(e.reason || "WebsocketDuplexConnection: Socket closed unexpectedly."));
			};
			_this.handleError = function(e) {
				_this.close(e.error);
			};
			_this.handleMessage = function(message) {
				try {
					var buffer = bufferExports.Buffer.from(message.data);
					var frame = _this.deserializer.deserializeFrame(buffer);
					_this.multiplexerDemultiplexer.handle(frame);
				} catch (error) {
					_this.close(error);
				}
			};
			websocket.addEventListener("close", _this.handleClosed);
			websocket.addEventListener("error", _this.handleError);
			websocket.addEventListener("message", _this.handleMessage);
			_this.multiplexerDemultiplexer = multiplexerDemultiplexerFactory(_this);
			return _this;
		}
		Object.defineProperty(WebsocketDuplexConnection.prototype, "availability", {
			get: function() {
				return this.done ? 0 : 1;
			},
			enumerable: false,
			configurable: true
		});
		WebsocketDuplexConnection.prototype.close = function(error) {
			if (this.done) {
				_super.prototype.close.call(this, error);
				return;
			}
			this.websocket.removeEventListener("close", this.handleClosed);
			this.websocket.removeEventListener("error", this.handleError);
			this.websocket.removeEventListener("message", this.handleMessage);
			this.websocket.close();
			delete this.websocket;
			_super.prototype.close.call(this, error);
		};
		WebsocketDuplexConnection.prototype.send = function(frame) {
			if (this.done) return;
			var buffer = (0, rsocket_core_1.serializeFrame)(frame);
			this.websocket.send(buffer);
		};
		return WebsocketDuplexConnection;
	}(rsocket_core_1.Deferred);
	return WebsocketDuplexConnection;
}
requireWebsocketDuplexConnection();
PACKAGE.version;
Logger.get("PowerSyncRemote");
/**
* @public
*/
var FetchStrategy;
(function(FetchStrategy) {
	/**
	* Queues multiple sync events before processing, reducing round-trips.
	* This comes at the cost of more processing overhead, which may cause ACK timeouts on older/weaker devices for big enough datasets.
	*/
	FetchStrategy["Buffered"] = "buffered";
	/**
	* Processes each sync event immediately before requesting the next.
	* This reduces processing overhead and improves real-time responsiveness.
	*/
	FetchStrategy["Sequential"] = "sequential";
})(FetchStrategy || (FetchStrategy = {}));
/**
* Class wrapper for providing a fetch implementation.
* The class wrapper is used to distinguish the fetchImplementation
* option in [AbstractRemoteOptions] from the general fetch method
* which is typeof "function"
*
* @internal
*/
var FetchImplementationProvider = class {
	getFetch() {
		throw new Error("Unspecified fetch implementation");
	}
};
new FetchImplementationProvider();
/**
* @internal
*/
var LockType;
(function(LockType) {
	LockType["CRUD"] = "crud";
	LockType["SYNC"] = "sync";
})(LockType || (LockType = {}));
/**
* @public
*/
var SyncStreamConnectionMethod;
(function(SyncStreamConnectionMethod) {
	SyncStreamConnectionMethod["HTTP"] = "http";
	SyncStreamConnectionMethod["WEB_SOCKET"] = "web-socket";
})(SyncStreamConnectionMethod || (SyncStreamConnectionMethod = {}));
/**
* @deprecated Deprecated since {@link SyncClientImplementation.RUST} is the only option.
* @public
*/
var SyncClientImplementation;
(function(SyncClientImplementation) {
	/**
	* This implementation offloads the sync line decoding and handling into the PowerSync
	* core extension.
	*
	* This is the only option, as an older JavaScript client implementation has been removed from the SDK.
	*
	* ## Compatibility warning
	*
	* The Rust sync client stores sync data in a format that is slightly different than the one used
	* by the old JavaScript client. When adopting the {@link SyncClientImplementation.RUST} client on existing databases,
	* the PowerSync SDK will migrate the format automatically.
	*
	* SDK versions supporting both the JavaScript and the Rust client support both formats with the JavaScript client
	* implementaiton. However, downgrading to an SDK version that only supports the JavaScript client would not be
	* possible anymore. Problematic SDK versions have been released before 2025-06-09.
	*/
	SyncClientImplementation["RUST"] = "rust";
})(SyncClientImplementation || (SyncClientImplementation = {}));
SyncClientImplementation.RUST;
SyncStreamConnectionMethod.WEB_SOCKET, FetchStrategy.Buffered;
/**
* SQLite operations to track changes for with {@link TriggerManager}
*
* @experimental @alpha
*/
var DiffTriggerOperation;
(function(DiffTriggerOperation) {
	DiffTriggerOperation["INSERT"] = "INSERT";
	DiffTriggerOperation["UPDATE"] = "UPDATE";
	DiffTriggerOperation["DELETE"] = "DELETE";
})(DiffTriggerOperation || (DiffTriggerOperation = {}));
const TypedLogger = Logger;
TypedLogger.TRACE, TypedLogger.DEBUG, TypedLogger.INFO, TypedLogger.TIME, TypedLogger.WARN, TypedLogger.ERROR, TypedLogger.OFF;
/**
* Retrieves the base (default) logger instance.
*
* This base logger controls the default logging configuration and is shared
* across all loggers created with `createLogger`. Adjusting settings on this
* base logger affects all loggers derived from it unless explicitly overridden.
*
* @public
*/
function createBaseLogger() {
	return Logger;
}
/**
* Creates and configures a new named logger based on the base logger.
*
* Named loggers allow specific modules or areas of your application to have
* their own logging levels and behaviors. These loggers inherit configuration
* from the base logger by default but can override settings independently.
*
* @public
*/
function createLogger(name, options = {}) {
	const logger = Logger.get(name);
	if (options.logLevel) logger.setLevel(options.logLevel);
	return logger;
}
//#endregion
//#region node_modules/comlink/dist/esm/comlink.mjs
/**
* @license
* Copyright 2019 Google LLC
* SPDX-License-Identifier: Apache-2.0
*/
const proxyMarker = Symbol("Comlink.proxy");
const createEndpoint = Symbol("Comlink.endpoint");
const releaseProxy = Symbol("Comlink.releaseProxy");
const finalizer = Symbol("Comlink.finalizer");
const throwMarker = Symbol("Comlink.thrown");
const isObject = (val) => typeof val === "object" && val !== null || typeof val === "function";
/**
* Allows customizing the serialization of certain values.
*/
const transferHandlers = new Map([["proxy", {
	canHandle: (val) => isObject(val) && val[proxyMarker],
	serialize(obj) {
		const { port1, port2 } = new MessageChannel();
		expose(obj, port1);
		return [port2, [port2]];
	},
	deserialize(port) {
		port.start();
		return wrap(port);
	}
}], ["throw", {
	canHandle: (value) => isObject(value) && throwMarker in value,
	serialize({ value }) {
		let serialized;
		if (value instanceof Error) serialized = {
			isError: true,
			value: {
				message: value.message,
				name: value.name,
				stack: value.stack
			}
		};
		else serialized = {
			isError: false,
			value
		};
		return [serialized, []];
	},
	deserialize(serialized) {
		if (serialized.isError) throw Object.assign(new Error(serialized.value.message), serialized.value);
		throw serialized.value;
	}
}]]);
function isAllowedOrigin(allowedOrigins, origin) {
	for (const allowedOrigin of allowedOrigins) {
		if (origin === allowedOrigin || allowedOrigin === "*") return true;
		if (allowedOrigin instanceof RegExp && allowedOrigin.test(origin)) return true;
	}
	return false;
}
function expose(obj, ep = globalThis, allowedOrigins = ["*"]) {
	ep.addEventListener("message", function callback(ev) {
		if (!ev || !ev.data) return;
		if (!isAllowedOrigin(allowedOrigins, ev.origin)) {
			console.warn(`Invalid origin '${ev.origin}' for comlink proxy`);
			return;
		}
		const { id, type, path } = Object.assign({ path: [] }, ev.data);
		const argumentList = (ev.data.argumentList || []).map(fromWireValue);
		let returnValue;
		try {
			const parent = path.slice(0, -1).reduce((obj, prop) => obj[prop], obj);
			const rawValue = path.reduce((obj, prop) => obj[prop], obj);
			switch (type) {
				case "GET":
					returnValue = rawValue;
					break;
				case "SET":
					parent[path.slice(-1)[0]] = fromWireValue(ev.data.value);
					returnValue = true;
					break;
				case "APPLY":
					returnValue = rawValue.apply(parent, argumentList);
					break;
				case "CONSTRUCT":
					returnValue = proxy(new rawValue(...argumentList));
					break;
				case "ENDPOINT":
					{
						const { port1, port2 } = new MessageChannel();
						expose(obj, port2);
						returnValue = transfer(port1, [port1]);
					}
					break;
				case "RELEASE":
					returnValue = void 0;
					break;
				default: return;
			}
		} catch (value) {
			returnValue = {
				value,
				[throwMarker]: 0
			};
		}
		Promise.resolve(returnValue).catch((value) => {
			return {
				value,
				[throwMarker]: 0
			};
		}).then((returnValue) => {
			const [wireValue, transferables] = toWireValue(returnValue);
			ep.postMessage(Object.assign(Object.assign({}, wireValue), { id }), transferables);
			if (type === "RELEASE") {
				ep.removeEventListener("message", callback);
				closeEndPoint(ep);
				if (finalizer in obj && typeof obj[finalizer] === "function") obj[finalizer]();
			}
		}).catch((error) => {
			const [wireValue, transferables] = toWireValue({
				value: /* @__PURE__ */ new TypeError("Unserializable return value"),
				[throwMarker]: 0
			});
			ep.postMessage(Object.assign(Object.assign({}, wireValue), { id }), transferables);
		});
	});
	if (ep.start) ep.start();
}
function isMessagePort(endpoint) {
	return endpoint.constructor.name === "MessagePort";
}
function closeEndPoint(endpoint) {
	if (isMessagePort(endpoint)) endpoint.close();
}
function wrap(ep, target) {
	const pendingListeners = /* @__PURE__ */ new Map();
	ep.addEventListener("message", function handleMessage(ev) {
		const { data } = ev;
		if (!data || !data.id) return;
		const resolver = pendingListeners.get(data.id);
		if (!resolver) return;
		try {
			resolver(data);
		} finally {
			pendingListeners.delete(data.id);
		}
	});
	return createProxy(ep, pendingListeners, [], target);
}
function throwIfProxyReleased(isReleased) {
	if (isReleased) throw new Error("Proxy has been released and is not useable");
}
function releaseEndpoint(ep) {
	return requestResponseMessage(ep, /* @__PURE__ */ new Map(), { type: "RELEASE" }).then(() => {
		closeEndPoint(ep);
	});
}
const proxyCounter = /* @__PURE__ */ new WeakMap();
const proxyFinalizers = "FinalizationRegistry" in globalThis && new FinalizationRegistry((ep) => {
	const newCount = (proxyCounter.get(ep) || 0) - 1;
	proxyCounter.set(ep, newCount);
	if (newCount === 0) releaseEndpoint(ep);
});
function registerProxy(proxy, ep) {
	const newCount = (proxyCounter.get(ep) || 0) + 1;
	proxyCounter.set(ep, newCount);
	if (proxyFinalizers) proxyFinalizers.register(proxy, ep, proxy);
}
function unregisterProxy(proxy) {
	if (proxyFinalizers) proxyFinalizers.unregister(proxy);
}
function createProxy(ep, pendingListeners, path = [], target = function() {}) {
	let isProxyReleased = false;
	const proxy = new Proxy(target, {
		get(_target, prop) {
			throwIfProxyReleased(isProxyReleased);
			if (prop === releaseProxy) return () => {
				unregisterProxy(proxy);
				releaseEndpoint(ep);
				pendingListeners.clear();
				isProxyReleased = true;
			};
			if (prop === "then") {
				if (path.length === 0) return { then: () => proxy };
				const r = requestResponseMessage(ep, pendingListeners, {
					type: "GET",
					path: path.map((p) => p.toString())
				}).then(fromWireValue);
				return r.then.bind(r);
			}
			return createProxy(ep, pendingListeners, [...path, prop]);
		},
		set(_target, prop, rawValue) {
			throwIfProxyReleased(isProxyReleased);
			const [value, transferables] = toWireValue(rawValue);
			return requestResponseMessage(ep, pendingListeners, {
				type: "SET",
				path: [...path, prop].map((p) => p.toString()),
				value
			}, transferables).then(fromWireValue);
		},
		apply(_target, _thisArg, rawArgumentList) {
			throwIfProxyReleased(isProxyReleased);
			const last = path[path.length - 1];
			if (last === createEndpoint) return requestResponseMessage(ep, pendingListeners, { type: "ENDPOINT" }).then(fromWireValue);
			if (last === "bind") return createProxy(ep, pendingListeners, path.slice(0, -1));
			const [argumentList, transferables] = processArguments(rawArgumentList);
			return requestResponseMessage(ep, pendingListeners, {
				type: "APPLY",
				path: path.map((p) => p.toString()),
				argumentList
			}, transferables).then(fromWireValue);
		},
		construct(_target, rawArgumentList) {
			throwIfProxyReleased(isProxyReleased);
			const [argumentList, transferables] = processArguments(rawArgumentList);
			return requestResponseMessage(ep, pendingListeners, {
				type: "CONSTRUCT",
				path: path.map((p) => p.toString()),
				argumentList
			}, transferables).then(fromWireValue);
		}
	});
	registerProxy(proxy, ep);
	return proxy;
}
function myFlat(arr) {
	return Array.prototype.concat.apply([], arr);
}
function processArguments(argumentList) {
	const processed = argumentList.map(toWireValue);
	return [processed.map((v) => v[0]), myFlat(processed.map((v) => v[1]))];
}
const transferCache = /* @__PURE__ */ new WeakMap();
function transfer(obj, transfers) {
	transferCache.set(obj, transfers);
	return obj;
}
function proxy(obj) {
	return Object.assign(obj, { [proxyMarker]: true });
}
function toWireValue(value) {
	for (const [name, handler] of transferHandlers) if (handler.canHandle(value)) {
		const [serializedValue, transferables] = handler.serialize(value);
		return [{
			type: "HANDLER",
			name,
			value: serializedValue
		}, transferables];
	}
	return [{
		type: "RAW",
		value
	}, transferCache.get(value) || []];
}
function fromWireValue(value) {
	switch (value.type) {
		case "HANDLER": return transferHandlers.get(value.name).deserialize(value.value);
		case "RAW": return value.value;
	}
}
function requestResponseMessage(ep, pendingListeners, msg, transfers) {
	return new Promise((resolve) => {
		const id = generateUUID();
		pendingListeners.set(id, resolve);
		if (ep.start) ep.start();
		ep.postMessage(Object.assign({ id }, msg), transfers);
	});
}
function generateUUID() {
	return new Array(4).fill(0).map(() => Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(16)).join("-");
}
//#endregion
//#region node_modules/@powersync/web/lib/src/db/adapters/wa-sqlite/DatabaseServer.js
/**
* Access to a WA-sqlite connection that can be shared with multiple clients sending queries over an RPC protocol built
* with the Comlink package.
*/
var DatabaseServer = class {
	#options;
	#nextClientId = 0;
	#activeClients = /* @__PURE__ */ new Set();
	#updateBroadcastChannel;
	#clientTableListeners = /* @__PURE__ */ new Set();
	constructor(options) {
		this.#options = options;
		const inner = options.inner;
		this.#updateBroadcastChannel = new BroadcastChannel(`${inner.options.dbFilename}-table-updates`);
		this.#updateBroadcastChannel.onmessage = ({ data }) => {
			this.#pushTableUpdateToClients(data);
		};
	}
	#pushTableUpdateToClients(changedTables) {
		for (const listener of this.#clientTableListeners) listener.postMessage(changedTables);
	}
	get #inner() {
		return this.#options.inner;
	}
	get #logger() {
		return this.#options.logger;
	}
	/**
	* Called by clients when they wish to connect to this database.
	*
	* @param lockName A lock that is currently held by the client. When the lock is returned, we know the client is gone
	* and that we need to clean up resources.
	*/
	async connect(lockName) {
		let isOpen = true;
		const clientId = this.#nextClientId++;
		this.#activeClients.add(clientId);
		let connectionLeases = /* @__PURE__ */ new Map();
		let currentTableListener;
		function requireOpen() {
			if (!isOpen) throw new Error("Client has already been closed");
		}
		function requireOpenAndLease(lease) {
			requireOpen();
			const token = connectionLeases.get(lease);
			if (!token) throw new Error("Attempted to use a connection lease that has already been returned.");
			return token;
		}
		const close = async () => {
			if (isOpen) {
				isOpen = false;
				if (currentTableListener) this.#clientTableListeners.delete(currentTableListener);
				for (const { lease } of connectionLeases.values()) {
					this.#logger.debug(`Closing connection lease that hasn't been returned.`);
					await lease.returnLease();
				}
				this.#activeClients.delete(clientId);
				if (this.#activeClients.size == 0) await this.forceClose();
				else this.#logger.debug("Keeping underlying connection active since its used by other clients.");
			}
		};
		if (lockName) navigator.locks.request(lockName, {}, () => {
			close();
		});
		return {
			close,
			debugIsAutoCommit: async () => {
				return this.#inner.unsafeUseInner().isAutoCommit();
			},
			requestAccess: async (write, timeoutMs) => {
				requireOpen();
				const lease = await this.#inner.acquireConnection(timeoutMs != null ? AbortSignal.timeout(timeoutMs) : void 0);
				if (!isOpen) {
					await lease.returnLease();
					return requireOpen();
				}
				const token = crypto.randomUUID();
				connectionLeases.set(token, {
					lease,
					write
				});
				return token;
			},
			completeAccess: async (token) => {
				const lease = requireOpenAndLease(token);
				connectionLeases.delete(token);
				try {
					if (lease.write) {
						const { resultSet } = await lease.lease.use((conn) => conn.execute(`SELECT powersync_update_hooks('get')`));
						if (resultSet) {
							const updatedTables = JSON.parse(resultSet.rows[0][0]);
							if (updatedTables.length) {
								this.#updateBroadcastChannel.postMessage(updatedTables);
								this.#pushTableUpdateToClients(updatedTables);
							}
						}
					}
				} finally {
					await lease.lease.returnLease();
				}
			},
			execute: async (token, sql, params) => {
				const { lease } = requireOpenAndLease(token);
				return await lease.use((db) => db.execute(sql, params));
			},
			executeBatch: async (token, sql, params) => {
				const { lease } = requireOpenAndLease(token);
				return await lease.use((db) => db.executeBatch(sql, params));
			},
			setUpdateListener: async (listener) => {
				requireOpen();
				if (currentTableListener) this.#clientTableListeners.delete(currentTableListener);
				currentTableListener = listener;
				if (listener) this.#clientTableListeners.add(listener);
			}
		};
	}
	async forceClose() {
		this.#logger.debug(`Closing connection to ${this.#inner.options}.`);
		const connection = this.#inner;
		this.#options.onClose();
		this.#updateBroadcastChannel.close();
		await connection.close();
	}
};
//#endregion
//#region node_modules/@powersync/web/lib/src/shared/navigator.js
const getNavigatorLocks = () => {
	if ("locks" in navigator && navigator.locks) return navigator.locks;
	throw new Error("Navigator locks are not available in an insecure context. Use a secure context such as HTTPS or http://localhost.");
};
//#endregion
//#region node_modules/@powersync/web/lib/src/db/adapters/wa-sqlite/vfs.js
/**
* List of currently tested virtual filesystems
*/
var WASQLiteVFS;
(function(WASQLiteVFS) {
	WASQLiteVFS["IDBBatchAtomicVFS"] = "IDBBatchAtomicVFS";
	WASQLiteVFS["OPFSCoopSyncVFS"] = "OPFSCoopSyncVFS";
	WASQLiteVFS["AccessHandlePoolVFS"] = "AccessHandlePoolVFS";
	WASQLiteVFS["OPFSWriteAheadVFS"] = "OPFSWriteAheadVFS";
})(WASQLiteVFS || (WASQLiteVFS = {}));
async function asyncModuleFactory(encryptionKey) {
	if (encryptionKey) {
		const { default: factory } = await import("./mc-wa-sqlite-async-CEiOjoNj.js");
		return factory();
	} else {
		const { default: factory } = await import("./wa-sqlite-async-4uAHr6iy.js");
		return factory();
	}
}
async function syncModuleFactory(encryptionKey) {
	if (encryptionKey) {
		const { default: factory } = await import("./mc-wa-sqlite-1a8FFV6m.js");
		return factory();
	} else {
		const { default: factory } = await import("./wa-sqlite-BU7J0H74.js");
		return factory();
	}
}
/**
* @internal
*/
const DEFAULT_MODULE_FACTORIES = {
	[WASQLiteVFS.IDBBatchAtomicVFS]: async (options) => {
		const module = await asyncModuleFactory(options.encryptionKey);
		const { IDBBatchAtomicVFS } = await import("./IDBBatchAtomicVFS-DPI9wolR.js");
		return {
			module,
			vfs: await IDBBatchAtomicVFS.create(options.dbFileName, module, { lockPolicy: "exclusive" })
		};
	},
	[WASQLiteVFS.AccessHandlePoolVFS]: async (options) => {
		const module = await syncModuleFactory(options.encryptionKey);
		const { AccessHandlePoolVFS } = await import("./AccessHandlePoolVFS-BxZ2vFk-.js");
		return {
			module,
			vfs: await AccessHandlePoolVFS.create(options.dbFileName, module)
		};
	},
	[WASQLiteVFS.OPFSCoopSyncVFS]: async (options) => {
		const module = await syncModuleFactory(options.encryptionKey);
		const { OPFSCoopSyncVFS } = await import("./OPFSCoopSyncVFS-4nYsAb-q.js");
		return {
			module,
			vfs: await OPFSCoopSyncVFS.create(options.dbFileName, module)
		};
	},
	[WASQLiteVFS.OPFSWriteAheadVFS]: async (options) => {
		const module = await syncModuleFactory(options.encryptionKey);
		const { OPFSWriteAheadVFS } = await import("./OPFSWriteAheadVFS-DOOBy0Hq.js");
		return {
			module,
			vfs: await OPFSWriteAheadVFS.create(options.dbFileName, module, {})
		};
	}
};
//#endregion
//#region node_modules/@powersync/web/lib/src/db/adapters/wa-sqlite/RawSqliteConnection.js
/**
* A small wrapper around WA-sqlite to help with opening databases and running statements by preparing them internally.
*
* This is an internal class, and it must never be used directly. Wrappers are required to ensure raw connections aren't
* used concurrently across tabs.
*/
var RawSqliteConnection = class {
	options;
	_sqliteAPI = null;
	/**
	* The `sqlite3*` connection pointer.
	*/
	db = 0;
	_moduleFactory;
	constructor(options) {
		this.options = options;
		this._moduleFactory = DEFAULT_MODULE_FACTORIES[this.options.vfs];
	}
	get isOpen() {
		return this.db != 0;
	}
	async init() {
		const api = this._sqliteAPI = await this.openSQLiteAPI();
		this.db = await api.open_v2(this.options.dbFilename, this.options.isReadOnly ? 1 : 6);
		await this.executeRaw(`PRAGMA temp_store = ${this.options.temporaryStorage};`);
		if (this.options.encryptionKey) {
			const escapedKey = this.options.encryptionKey.replace("'", "''");
			await this.executeRaw(`PRAGMA key = '${escapedKey}'`);
		}
		await this.executeRaw(`PRAGMA cache_size = -${this.options.cacheSizeKb};`);
		await this.executeRaw(`SELECT powersync_update_hooks('install');`);
	}
	async openSQLiteAPI() {
		const { module, vfs } = await this._moduleFactory({
			dbFileName: this.options.dbFilename,
			encryptionKey: this.options.encryptionKey
		});
		const sqlite3 = Factory(module);
		sqlite3.vfs_register(vfs, true);
		/**
		* Register the PowerSync core SQLite extension
		*/
		module.ccall("powersync_init_static", "int", []);
		/**
		* Create the multiple cipher vfs if an encryption key is provided
		*/
		if (this.options.encryptionKey) {
			if (module.ccall("sqlite3mc_vfs_create", "int", ["string", "int"], [this.options.dbFilename, 1]) !== 0) throw new Error("Failed to create multiple cipher vfs, Database encryption will not work");
		}
		return sqlite3;
	}
	requireSqlite() {
		if (!this._sqliteAPI) throw new Error(`Initialization has not completed`);
		return this._sqliteAPI;
	}
	/**
	* Checks if the database connection is in autocommit mode.
	* @returns true if in autocommit mode, false if in a transaction
	*/
	isAutoCommit() {
		return this.requireSqlite().get_autocommit(this.db) != 0;
	}
	async execute(sql, bindings) {
		const resultSet = await this.executeSingleStatementRaw(sql, bindings);
		return this.wrapQueryResults(this.requireSqlite(), resultSet);
	}
	async executeBatch(sql, bindings) {
		const results = [];
		const api = this.requireSqlite();
		for await (const stmt of api.statements(this.db, sql)) {
			let columns;
			for (const parameterSet of bindings) {
				const rs = await this.stepThroughStatement(api, stmt, parameterSet, columns, false);
				results.push(this.wrapQueryResults(api, rs));
			}
			break;
		}
		return results;
	}
	wrapQueryResults(api, rs) {
		return {
			changes: api.changes(this.db),
			lastInsertRowId: api.last_insert_id(this.db),
			autocommit: api.get_autocommit(this.db) != 0,
			resultSet: rs
		};
	}
	/**
	* This executes a single statement using SQLite3 and returns the results as a {@link RawResultSet}.
	*/
	async executeSingleStatementRaw(sql, bindings) {
		const results = await this.executeRaw(sql, bindings);
		return results.length ? results[0] : void 0;
	}
	async executeRaw(sql, bindings) {
		const results = [];
		const api = this.requireSqlite();
		for await (const stmt of api.statements(this.db, sql)) {
			let columns;
			const rs = await this.stepThroughStatement(api, stmt, bindings ?? [], columns);
			columns = rs.columns;
			if (columns.length) results.push(rs);
			if (bindings) break;
		}
		return results;
	}
	async stepThroughStatement(api, stmt, bindings, knownColumns, includeResults = true) {
		bindings.forEach((b, index, arr) => {
			if (typeof b == "boolean") arr[index] = b ? 1 : 0;
		});
		api.reset(stmt);
		if (bindings) api.bind_collection(stmt, bindings);
		const rows = [];
		while (await api.step(stmt) === 100) if (includeResults) {
			const row = api.row(stmt);
			rows.push(row);
		}
		knownColumns ??= api.column_names(stmt);
		return {
			columns: knownColumns,
			rows
		};
	}
	async close() {
		if (this.isOpen) {
			await this.requireSqlite().close(this.db);
			this.db = 0;
		}
	}
};
//#endregion
//#region node_modules/@powersync/web/lib/src/db/adapters/wa-sqlite/ConcurrentConnection.js
/**
* A wrapper around a {@link RawSqliteConnection} allowing multiple tabs to access it.
*
* To allow potentially concurrent accesses from different clients, this requires a local mutex implementation here.
*
* Note that instances of this class are not safe to proxy across context boundaries with comlink! We need to be able to
* rely on mutexes being returned reliably, so additional checks to detect say a client tab closing are required to
* avoid deadlocks.
*/
var ConcurrentSqliteConnection = class {
	inner;
	/**
	* An outer mutex ensuring at most one {@link ConnectionLeaseToken} can exist for this connection at a time.
	*
	* If null, we'll use navigator locks instead.
	*/
	leaseMutex;
	/**
	* @param needsNavigatorLocks Whether access to the database needs an additional navigator lock guard.
	*
	* While {@link ConcurrentSqliteConnection} prevents concurrent access to a database _connection_, it's possible we
	* might have multiple connections to the same physical database (e.g. if multiple tabs use dedicated workers).
	* In those setups, we use navigator locks instead of an internal mutex to guard access..
	*/
	constructor(inner, needsNavigatorLocks) {
		this.inner = inner;
		this.leaseMutex = needsNavigatorLocks ? null : new Mutex();
	}
	get options() {
		return this.inner.options;
	}
	acquireMutex(abort) {
		if (this.leaseMutex) return this.leaseMutex.acquire(abort);
		return new Promise((resolve, reject) => {
			const options = { signal: abort };
			navigator.locks.request(`db-lock-${this.options.dbFilename}`, options, (_) => {
				return new Promise((returnLock) => {
					return resolve(() => {
						returnLock();
					});
				});
			}).catch(reject);
		});
	}
	unsafeUseInner() {
		return this.inner;
	}
	/**
	* @returns A {@link ConnectionLeaseToken}. Until that token is returned, no other client can use the database.
	*/
	async acquireConnection(abort) {
		const returnMutex = await this.acquireMutex(abort);
		const token = new ConnectionLeaseToken(returnMutex, this.inner);
		try {
			this.inner.requireSqlite();
			if (!this.inner.isAutoCommit()) await this.inner.executeRaw("ROLLBACK");
		} catch (e) {
			returnMutex();
			throw e;
		}
		return token;
	}
	async close() {
		const returnMutex = await this.acquireMutex();
		try {
			await this.inner.close();
		} finally {
			returnMutex();
		}
	}
};
/**
* An instance representing temporary exclusive access to a {@link ConcurrentSqliteConnection}.
*/
var ConnectionLeaseToken = class {
	returnMutex;
	connection;
	/** Ensures that the client with access to this token can't run statements concurrently. */
	useMutex = new Mutex();
	closed = false;
	constructor(returnMutex, connection) {
		this.returnMutex = returnMutex;
		this.connection = connection;
	}
	/**
	* Returns this lease, allowing another client to use the database connection.
	*/
	async returnLease() {
		await this.useMutex.runExclusive(async () => {
			if (!this.closed) {
				this.closed = true;
				this.returnMutex();
			}
		});
	}
	/**
	* This should only be used internally, since the callback must not use the raw connection after resolving.
	*/
	async use(callback) {
		return await this.useMutex.runExclusive(async () => {
			if (this.closed) throw new Error("lease token has already been closed");
			return await callback(this.connection);
		});
	}
};
//#endregion
//#region node_modules/@powersync/web/lib/src/worker/db/MultiDatabaseServer.js
const OPEN_DB_LOCK = "open-wasqlite-db";
/**
* Shared state to manage multiple database connections hosted by a worker.
*/
var MultiDatabaseServer = class {
	logger;
	activeDatabases = /* @__PURE__ */ new Map();
	constructor(logger) {
		this.logger = logger;
	}
	async handleConnection(options) {
		this.logger.setLevel(options.logLevel);
		return proxy(await this.openConnectionLocally(options, options.lockName));
	}
	async connectToExisting(name, lockName) {
		return getNavigatorLocks().request(OPEN_DB_LOCK, async () => {
			const server = this.activeDatabases.get(name);
			if (server == null) throw new Error(`connectToExisting(${name}) failed because the worker doesn't own a database with that name.`);
			return proxy(await server.connect(lockName));
		});
	}
	async openConnectionLocally(options, lockName) {
		const maxAttempts = 3;
		let server;
		for (let count = 0; count < maxAttempts - 1; count++) try {
			server = await this.databaseOpenAttempt(options);
		} catch (ex) {
			this.logger.warn(`Attempt ${count + 1} of ${maxAttempts} to open database failed, retrying in 1 second...`, ex);
			await new Promise((resolve) => setTimeout(resolve, 1e3));
		}
		server ??= await this.databaseOpenAttempt(options);
		return server.connect(lockName);
	}
	async databaseOpenAttempt(options) {
		return getNavigatorLocks().request(OPEN_DB_LOCK, async () => {
			const { dbFilename } = options;
			let server = this.activeDatabases.get(dbFilename);
			if (server == null) {
				const needsNavigatorLocks = !(isSharedWorker || options.isReadOnly);
				const connection = new RawSqliteConnection(options);
				const withSafeConcurrency = new ConcurrentSqliteConnection(connection, needsNavigatorLocks);
				const returnLease = await withSafeConcurrency.acquireMutex();
				try {
					await connection.init();
				} catch (e) {
					returnLease();
					await connection.close();
					throw e;
				}
				returnLease();
				const onClose = () => this.activeDatabases.delete(dbFilename);
				server = new DatabaseServer({
					inner: withSafeConcurrency,
					logger: this.logger,
					onClose
				});
				this.activeDatabases.set(dbFilename, server);
			}
			return server;
		});
	}
	closeAll() {
		const existingDatabases = [...this.activeDatabases.values()];
		return Promise.all(existingDatabases.map((db) => {
			db.forceClose();
		}));
	}
};
const isSharedWorker = "SharedWorkerGlobalScope" in globalThis;
//#endregion
//#region node_modules/@powersync/web/lib/src/worker/db/WASQLiteDB.worker.js
createBaseLogger().useDefaults();
const server = new MultiDatabaseServer(createLogger("db-worker"));
const exposedFunctions = {
	connect: (config) => server.handleConnection(config),
	connectToExisting: ({ identifier, lockName }) => server.connectToExisting(identifier, lockName)
};
if (isSharedWorker) {
	const _self = self;
	_self.onconnect = function(event) {
		const port = event.ports[0];
		expose(exposedFunctions, port);
	};
} else expose(exposedFunctions);
addEventListener("unload", () => {
	server.closeAll();
});
//#endregion
export { SQLITE_OPEN_WAL as _, SQLITE_IOERR_CLOSE as a, SQLITE_IOERR_FSYNC as c, SQLITE_IOERR_UNLOCK as d, SQLITE_OPEN_MAIN_JOURNAL as f, SQLITE_OPEN_TRANSIENT_DB as g, SQLITE_OPEN_TEMP_JOURNAL as h, SQLITE_IOERR_CHECKRESERVEDLOCK as i, SQLITE_IOERR_LOCK as l, SQLITE_OPEN_SUPER_JOURNAL as m, SQLITE_IOCAP_UNDELETABLE_WHEN_OPEN as n, SQLITE_IOERR_DELETE as o, SQLITE_OPEN_SUBJOURNAL as p, SQLITE_IOERR_ACCESS as r, SQLITE_IOERR_FSTAT as s, SQLITE_IOCAP_BATCH_ATOMIC as t, SQLITE_IOERR_TRUNCATE as u };

//# sourceMappingURL=WASQLiteDB.worker-Bk8Rxnwd.js.map