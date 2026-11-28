(function() {
	// src/sw/assets.ts
	/**
	* Which same-origin runtime assets the service worker serves cache-first from
	* the generation cache. Kept globals-free (primitives in, boolean out — no
	* `Request`/`URL`/worker types) so it imports cleanly into BOTH the WebWorker
	* tsconfig (the worker, src/sw/sw.ts) and the Node scripts tsconfig
	* (scripts/precache-assets.ts), and unit-tests without mocking `Request`.
	*
	* `ASSET_EXTENSION` is the load-bearing shared constant. The build precaches by
	* extension; the SW ALSO serves cache-first by `request.destination` (below), so
	* strictly the served set is a superset of the precached set. That superset is
	* empty in practice — every emitted dist asset carries a recognized extension,
	* so a destination-matched request always also matches by extension and was
	* precached. Importing the ONE extension definition here (instead of duplicating
	* the literal in the build script and diffing it in a test) keeps the two in
	* lockstep on the axis the precache is actually built from; the invariant that
	* closes the gap is "every served asset has a recognized extension", which holds
	* for our own emitted output.
	*/
	var ASSET_EXTENSION = /\.(?:js|mjs|css|wasm|woff2?|ttf|otf|png|svg|jpe?g|webp|gif|ico)$/;
	var ASSET_DESTINATIONS = /* @__PURE__ */ new Set([
		"script",
		"style",
		"worker",
		"font",
		"image"
	]);
	/**
	* True for a same-origin request the SW serves cache-first within the
	* generation. Match by `request.destination` first (covers the common cases a
	* browser labels) with an extension fallback for anything left as an empty
	* destination.
	*/
	var isCacheableAsset = (destination, pathname, sameOrigin) => sameOrigin && (ASSET_DESTINATIONS.has(destination) || ASSET_EXTENSION.test(pathname));
	/**
	* The fingerprint the build stamps for each precached file and the worker
	* recomputes over the bytes it fetched: hex SHA-256 cut to 64 bits, enough to
	* tell two builds' bytes apart. The one definition both sides use.
	*/
	var contentDigest = async (bytes) => {
		const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
		return Array.from(hash.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
	};
	// src/data/dbFileSiblings.ts
	/** `OPFSWriteAheadVFS`'s write-ahead log — two files, alternated WAL2-style. */
	var WRITE_AHEAD_SIDECAR_SUFFIXES = ["-wa0", "-wa1"];
	/**
	* SQLite's own crash-recovery files. These must be removed BEFORE the main
	* `.db`: left beside a fresh database of the same name, SQLite replays them.
	*
	* Wider than what this app produces, deliberately: deletion should clear
	* anything SQLite could replay, whoever wrote it. Restoring is the opposite and
	* uses a narrower whitelist — see `exportSqliteDb`.
	*/
	var SQLITE_JOURNAL_SUFFIXES = [
		"-journal",
		"-wal",
		"-shm"
	];
	[...SQLITE_JOURNAL_SUFFIXES, ...WRITE_AHEAD_SIDECAR_SUFFIXES];
	// src/sw/preview.ts
	/**
	* PR-preview subtree gating. github.io is ONE origin for production
	* (…/knowledge-medium/) AND every PR preview (…/pr-preview/pr-<n>/…). A
	* production/root SW's scope is a PREFIX of every preview path, and since we
	* never `clients.claim()`, the production SW controls a freshly-opened preview
	* page until it reloads — and would otherwise cache the preview's shell +
	* assets under production's OWN keys, poisoning the offline production shell
	* with an unmerged build. So a SW refuses to serve/cache a preview subtree it
	* doesn't own. A preview's own SW (its scope IS under /pr-preview/) is exempt.
	*
	* Globals-free (a regex + a pure predicate over primitives) so it's unit-tested
	* directly and shared without dragging worker types.
	*/
	var PREVIEW_SUBTREE = /\/pr-preview\/pr-[^/]+\//;
	/**
	* True when this SW must NOT touch a request: the request targets a preview
	* subtree that this scope does not own. A preview-scoped SW (its own scope is
	* under /pr-preview/) owns its subtree, so it's never "foreign" to itself.
	*/
	var isForeignPreviewRequest = (ownScopeIsPreview, pathname) => !ownScopeIsPreview && PREVIEW_SUBTREE.test(pathname);
	// src/sw/ledger.ts
	/**
	* Pure decisions over the generation ledger — an install-ordered list of
	* BUILD_IDs (newest last). The worker (src/sw/worker.ts) owns the impure I/O
	* (reading/writing the ledger Response in the meta cache); the retention math
	* lives here so it unit-tests without a cache.
	*
	* Each deploy is an immutable generation with its own km-shell-<id> /
	* km-assets-<id> caches. On activate we keep the most recent `keep`
	* generations (so a tab still on a prior build has a consistent cache to read
	* from) and GC the rest.
	*/
	/** The ids to KEEP: the most recent `keep`, newest-last order preserved. */
	var computeKeepIds = (ledger, keep) => ledger.slice(Math.max(0, ledger.length - keep));
	/**
	* The ids that have aged out of the keep-window and whose caches should be
	* GC'd. Disjoint from computeKeepIds; empty when the ledger fits the window.
	*/
	var computeExpiredIds = (ledger, keep) => ledger.slice(0, Math.max(0, ledger.length - keep));
	/**
	* Normalize a stored ledger value into {ids, updatedAt}. Tolerates the two
	* on-disk shapes: the current {ids, updatedAt} object and the LEGACY bare array
	* (written before timestamps existed) — the latter has no timestamp, which the
	* sweeper reads as "staleness unprovable → never reap". Anything else (null,
	* garbage, non-array ids) degrades to an empty ledger.
	*/
	var normalizeLedger = (raw) => {
		if (Array.isArray(raw)) return {
			ids: raw,
			updatedAt: void 0
		};
		if (raw && typeof raw === "object" && Array.isArray(raw.ids)) {
			const { ids, updatedAt } = raw;
			return {
				ids,
				updatedAt: typeof updatedAt === "number" ? updatedAt : void 0
			};
		}
		return {
			ids: [],
			updatedAt: void 0
		};
	};
	/**
	* Decide which OTHER-scope generation caches a sweep should reclaim. Cache
	* Storage is shared per-origin, so a client accumulates the caches of every PR
	* preview it ever visited; once a PR is merged/closed its preview SW never runs
	* again to GC them, so they leak forever. This sweep (run from any active SW's
	* activate) reclaims them — but ONLY:
	*   - preview scopes (PREVIEW_SUBTREE matches the ledger key's path). Production
	*     is NEVER a preview scope, so it can never be reaped here — the sweep is
	*     structurally incapable of touching prod caches.
	*   - that are STALE: a numeric updatedAt older than staleMs. A legacy
	*     untimestamped ledger (updatedAt undefined) is never reaped — we can't
	*     prove it's abandoned. The current scope's own ledger was just re-stamped
	*     on install, so it's fresh and self-excluded.
	* A generation id still referenced by any KEPT (non-reaped) ledger is spared —
	* two deploys can in principle share a build sha, and we must not delete a cache
	* a live scope depends on. The stale ledger ENTRY is removed regardless (the
	* scope is gone), even when its cache was shared-protected.
	*/
	var computeReapableCaches = ({ ledgers, now, staleMs, selfScopeUrl }) => {
		const isPreviewScope = (scopeUrl) => {
			try {
				return PREVIEW_SUBTREE.test(new URL(scopeUrl).pathname);
			} catch {
				return false;
			}
		};
		const isStale = (l) => typeof l.updatedAt === "number" && now - l.updatedAt > staleMs;
		const reapable = ledgers.filter((l) => l.scopeUrl !== selfScopeUrl && isPreviewScope(l.scopeUrl) && isStale(l));
		const reapableSet = new Set(reapable);
		const keptIds = new Set(ledgers.filter((l) => !reapableSet.has(l)).flatMap((l) => l.ids));
		const reapIds = /* @__PURE__ */ new Set();
		for (const l of reapable) for (const id of l.ids) if (!keptIds.has(id)) reapIds.add(id);
		return {
			reapIds: [...reapIds],
			ledgerScopeUrls: reapable.map((l) => l.scopeUrl)
		};
	};
	// src/utils/idbKeyedStore.ts
	/** Promisify a single `IDBRequest` — resolve on success, reject on error. */
	var promisifyRequest = (request) => new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	/** Resolve when the transaction COMMITS (`oncomplete`), reject on abort/error.
	*  A readwrite write is only durable once the tx commits — `onsuccess` fires
	*  earlier, while the tx is still open — so a caller that navigates/reloads
	*  right after a write can have an un-committed tx rolled back. Handlers are
	*  registered synchronously by the caller (before any await) so an `oncomplete`
	*  that fires before we start awaiting can't be missed. */
	var txCommitted = (transaction) => new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () => reject(transaction.error ?? /* @__PURE__ */ new Error("IndexedDB transaction aborted"));
		transaction.onerror = () => reject(transaction.error ?? /* @__PURE__ */ new Error("IndexedDB transaction error"));
	});
	/** Record-id prefix for all of an owner's records. The trailing `:` plus
	*  `encodeURIComponent` (which escapes any literal `:` to `%3A`) makes this an
	*  unambiguous, collision-free prefix — `enc("ab"):` is never a prefix of
	*  `enc("abc"):…`, so a `startsWith(prefix)` scan can't match a sibling owner. */
	var idbKeyPrefix = (owner) => `${encodeURIComponent(owner)}:`;
	/** Composite record id. Each segment is encoded so a delimiter inside an id
	*  can't make two distinct `(owner, id)` pairs collide. */
	var idbRecordId = (owner, id) => `${idbKeyPrefix(owner)}${encodeURIComponent(id)}`;
	/**
	* A cached connection to one named DB + one object store, with commit-durable
	* transactions. Each instance owns its own connection handle, so constructing a
	* fresh instance against the same DB models a page reload (a new tab/handle
	* reopening persisted data) — which is exactly how the consumers' tests verify
	* durability.
	*/
	var IdbKeyedStore = class {
		dbName;
		storeName;
		version;
		dbPromise = null;
		constructor(dbName, storeName, version = 1) {
			this.dbName = dbName;
			this.storeName = storeName;
			this.version = version;
		}
		openDb() {
			if (!this.dbPromise) {
				const opened = new Promise((resolve, reject) => {
					const request = indexedDB.open(this.dbName, this.version);
					request.onupgradeneeded = () => {
						const db = request.result;
						if (!db.objectStoreNames.contains(this.storeName)) db.createObjectStore(this.storeName);
					};
					request.onsuccess = () => {
						const db = request.result;
						db.onclose = () => {
							if (this.dbPromise === opened) this.dbPromise = null;
						};
						db.onversionchange = () => {
							db.close();
							if (this.dbPromise === opened) this.dbPromise = null;
						};
						resolve(db);
					};
					request.onerror = () => reject(request.error);
				}).catch((err) => {
					if (this.dbPromise === opened) this.dbPromise = null;
					throw err;
				});
				this.dbPromise = opened;
			}
			return this.dbPromise;
		}
		/**
		* Open a transaction and return its object store plus a commit fence. PRIVATE
		* and footgun-laden by design — the caller must issue its first request
		* synchronously and observe `committed` on EVERY path (await it, or `.catch` it
		* on an error path) or a tx abort surfaces as an unhandled rejection. The public
		* ops ({@link runTransaction}, {@link tx}, {@link scanByPrefix}) wrap exactly
		* that contract so callers never have to.
		*/
		async openTransaction(mode) {
			const transaction = (await this.openDb()).transaction(this.storeName, mode);
			const committed = txCommitted(transaction);
			return {
				store: transaction.objectStore(this.storeName),
				committed
			};
		}
		/**
		* Run `body` against the store within one transaction and resolve on the
		* transaction COMMIT (durability), not a request's `onsuccess`. `body` MUST
		* issue its first request synchronously — it is invoked in the same task that
		* created the tx (see the file header on activeness). If `body` rejects (or the
		* commit fence does), the fence's rejection is observed here so it can't surface
		* as an unhandled rejection, and the original error propagates. Use for cursor
		* scans / read-modify-write; single-request ops use {@link tx}.
		*/
		async runTransaction(mode, body) {
			const { store, committed } = await this.openTransaction(mode);
			try {
				const result = await body(store);
				await committed;
				return result;
			} catch (err) {
				committed.catch(() => {});
				throw err;
			}
		}
		/**
		* Run a single request against the store, resolving on the transaction COMMIT
		* (durability). The common case; multi-request / cursor work uses
		* {@link runTransaction}.
		*/
		async tx(mode, run) {
			return this.runTransaction(mode, (store) => promisifyRequest(run(store)));
		}
		/**
		* Walk every record whose key starts with `prefix` (the per-owner namespace
		* from {@link idbKeyPrefix}), calling `visit` with each matching cursor, in one
		* commit-durable transaction. A value cursor, because `visit` reads
		* `cursor.value`; the `:`-delimited prefix is collision-free across owners, so
		* a scan never reaches a sibling owner. `visit` is synchronous
		* (it runs in the cursor's `onsuccess`, while the tx is active) and may read
		* `cursor.value` or, in a `'readwrite'` scan, `cursor.delete()`; accumulate into
		* a variable it closes over. If `visit` throws, the scan aborts (rolling back a
		* readwrite scan's partial writes) and rejects with that error.
		*/
		async scanByPrefix(mode, prefix, visit) {
			await this.runTransaction(mode, (store) => new Promise((resolve, reject) => {
				const request = store.openCursor();
				request.onsuccess = () => {
					const cursor = request.result;
					if (!cursor) {
						resolve();
						return;
					}
					try {
						if (typeof cursor.key === "string" && cursor.key.startsWith(prefix)) visit(cursor);
						cursor.continue();
					} catch (err) {
						try {
							store.transaction.abort();
						} catch {}
						reject(err);
					}
				};
				request.onerror = () => reject(request.error);
			}));
		}
		/**
		* Delete every record whose key starts with `prefix`, in one commit-durable
		* readwrite transaction. One ranged delete rather than a value cursor: a
		* cursor deserialises every record in the store to test its key, and some
		* stores hold multi-MB records. The range is exactly "starts with": every
		* key from `prefix` up to, excluding, the prefix with its last code unit
		* incremented.
		*/
		async deleteByPrefix(prefix) {
			const last = prefix.charCodeAt(prefix.length - 1);
			if (last === 65535) throw new Error("deleteByPrefix: the prefix has no successor");
			const upper = prefix.slice(0, -1) + String.fromCharCode(last + 1);
			await this.tx("readwrite", (store) => store.delete(IDBKeyRange.bound(prefix, upper, false, true)));
		}
	};
	// src/sw/bootStore.ts
	/**
	* The boot set (shell HTML, first-paint assets, vendor React) in IndexedDB, so
	* a cold launch answers them without touching Cache Storage. On iOS the first
	* Cache Storage call of a service-worker lifetime costs ~600 ms regardless of
	* which cache or how many entries (measured against an IndexedDB open in the
	* same worker: 17 ms); Cache Storage stays the store for everything lazy.
	*
	* Entries are keyed by build id, so a worker only ever serves its own
	* generation's bytes and the activate GC reaps a generation by prefix.
	*/
	var bootKeyPrefix = (buildId) => idbKeyPrefix(buildId);
	var bootKey = (buildId, url) => idbRecordId(buildId, url);
	var idbBootStore = () => {
		const store = new IdbKeyedStore("km-boot", "entries");
		return {
			get: (key) => store.tx("readonly", (s) => s.get(key)),
			putAll: (entries) => store.runTransaction("readwrite", async (s) => {
				for (const [key, entry] of entries) s.put(entry, key);
			}),
			deletePrefix: (prefix) => store.deleteByPrefix(prefix)
		};
	};
	// src/sw/previewDatabases.ts
	var SERVICE_WORKER_META_CACHE = "km-meta";
	var PREVIEW_DATABASE_RECORD_BASENAME = "__km_database__";
	var previewDatabaseRecordInfo = (recordUrl, ledgerBasename) => {
		try {
			const url = new URL(recordUrl);
			const marker = `/${PREVIEW_DATABASE_RECORD_BASENAME}/`;
			const markerIndex = url.pathname.indexOf(marker);
			if (markerIndex < 0) return null;
			const encodedName = url.pathname.slice(markerIndex + marker.length);
			if (!encodedName || encodedName.includes("/")) return null;
			const scopePath = url.pathname.slice(0, markerIndex + 1);
			return {
				scopeUrl: `${`${url.origin}${scopePath}`}${ledgerBasename}`,
				name: decodeURIComponent(encodedName)
			};
		} catch {
			return null;
		}
	};
	// src/sw/worker.ts
	/**
	* The service worker's orchestration — ledger I/O, install precache, activate
	* GC, and fetch routing — as a factory parameterized by its globals
	* (`caches` / `fetch` / origin) instead of reaching for `self`. The worker
	* entry (src/sw/sw.ts) constructs one of these with the real globals + injected
	* build config and wires it to the SW events; tests construct one with an
	* in-memory CacheStorage and a stub fetch and drive install/activate/fetch
	* directly. Keeping this file free of `self` / ServiceWorkerGlobalScope is what
	* makes it importable + unit-testable outside a worker.
	*
	* The versioning model this implements is documented in the sw.ts header.
	*/
	var CACHE_PREFIX = "km-";
	var VENDOR_HOSTS = /* @__PURE__ */ new Set(["esm.sh"]);
	var createServiceWorker = (config, env) => {
		const { buildId, scopeURL, keepGenerations } = config;
		const { caches, fetch, now } = env;
		const SHELL_CACHE = `${CACHE_PREFIX}shell-${buildId}`;
		const ASSET_CACHE = `${CACHE_PREFIX}assets-${buildId}`;
		const VENDOR_CACHE = `${CACHE_PREFIX}vendor`;
		const META_CACHE = SERVICE_WORKER_META_CACHE;
		const toScopeUrl = (p) => new URL(p, scopeURL).toString();
		const resolveManifest = (manifest) => Object.entries(manifest).map(([path, digest]) => [toScopeUrl(path), digest]);
		const SHELL_ENTRIES = resolveManifest(config.precacheShell);
		const PRECACHE_ENTRIES = resolveManifest(config.precacheAssets);
		const PRECACHE_REST_ENTRIES = resolveManifest(config.precacheRestAssets);
		const PRECACHE_ASSETS = PRECACHE_ENTRIES.map(([url]) => url);
		const SHELL_URL = toScopeUrl("./index.html");
		const BOOT_SET = [[SHELL_CACHE, [SHELL_URL]], [ASSET_CACHE, PRECACHE_ASSETS]];
		const BOOT_URLS = new Set(BOOT_SET.flatMap(([, urls]) => urls));
		const deleteGeneration = (id) => [
			caches.delete(`${CACHE_PREFIX}shell-${id}`),
			caches.delete(`${CACHE_PREFIX}assets-${id}`),
			env.bootStore?.deletePrefix(bootKeyPrefix(id)).catch(() => void 0)
		];
		const OWN_SCOPE_IS_PREVIEW = PREVIEW_SUBTREE.test(scopeURL.pathname);
		const LEDGER_BASENAME = "__km_generations__";
		const LEDGER_KEY = toScopeUrl(`./${LEDGER_BASENAME}`);
		const readLedgerEntry = async () => {
			try {
				const res = await (await caches.open(META_CACHE)).match(LEDGER_KEY);
				if (!res) return {
					ids: [],
					updatedAt: void 0
				};
				return normalizeLedger(await res.json());
			} catch {
				return {
					ids: [],
					updatedAt: void 0
				};
			}
		};
		const readLedger = async () => (await readLedgerEntry()).ids;
		const writeLedgerEntry = async (entry) => {
			const cache = await caches.open(META_CACHE);
			const nextEntry = {
				...entry,
				updatedAt: now()
			};
			await cache.put(LEDGER_KEY, new Response(JSON.stringify(nextEntry), { headers: { "content-type": "application/json" } }));
		};
		let ledgerMutationChain = Promise.resolve();
		const mutateLedgerEntry = async (mutate) => {
			const run = ledgerMutationChain.then(async () => {
				const entry = await readLedgerEntry();
				await writeLedgerEntry(await mutate(entry));
			});
			ledgerMutationChain = run.catch(() => {});
			await run;
		};
		const recordGeneration = async (id) => {
			await mutateLedgerEntry((entry) => {
				const ids = entry.ids.filter((x) => x !== id);
				ids.push(id);
				return {
					...entry,
					ids
				};
			});
		};
		const forgetGeneration = async (id) => {
			await mutateLedgerEntry((entry) => ({
				...entry,
				ids: entry.ids.filter((x) => x !== id)
			}));
		};
		const writeLedger = async (ids) => {
			await mutateLedgerEntry((entry) => ({
				...entry,
				ids
			}));
		};
		const trimLedger = async () => {
			await mutateLedgerEntry((entry) => ({
				...entry,
				ids: computeKeepIds(entry.ids, keepGenerations)
			}));
		};
		let lastTouchAt = 0;
		const maybeTouchOwnLedger = (waitUntil) => {
			if (!OWN_SCOPE_IS_PREVIEW) return;
			const t = now();
			if (t - lastTouchAt <= config.touchIntervalMs) return;
			lastTouchAt = t;
			const touch = (async () => {
				try {
					await mutateLedgerEntry((entry) => entry);
				} catch {}
			})();
			if (waitUntil) waitUntil(touch);
		};
		const install = async () => {
			try {
				await precache();
			} catch (err) {
				await Promise.allSettled(deleteGeneration(buildId));
				await forgetGeneration(buildId).catch(() => {});
				throw err;
			}
		};
		const precache = async () => {
			await recordGeneration(buildId);
			const [shell, assets] = await Promise.all([caches.open(SHELL_CACHE), caches.open(ASSET_CACHE)]);
			const fetchInto = async (cache, url, digest, mode) => {
				const res = await fetch(new Request(url, { cache: mode })).catch(() => null);
				if (!res || !res.ok) return;
				const body = await res.clone().arrayBuffer().catch(() => null);
				if (!body) return;
				if (await contentDigest(body) !== digest) throw new Error(`[sw] ${url} differs from build ${buildId}'s copy; another deploy is being served`);
				await cache.put(url, res).catch(() => {});
			};
			const runPooled = async (entries, limit, task) => {
				let next = 0;
				let failure;
				const worker = async () => {
					while (!failure && next < entries.length) {
						const [url, digest] = entries[next++];
						try {
							await task(url, digest);
						} catch (err) {
							failure ??= { err };
						}
					}
				};
				await Promise.all(Array.from({ length: Math.min(limit, entries.length) }, worker));
				if (failure) throw failure.err;
			};
			await runPooled(SHELL_ENTRIES, SHELL_ENTRIES.length, (u, d) => fetchInto(shell, u, d, "reload"));
			await runPooled(PRECACHE_ENTRIES, 16, (u, d) => fetchInto(assets, u, d, "no-cache"));
			await seedBootStore();
			await runPooled(PRECACHE_REST_ENTRIES, 16, (u, d) => fetchInto(assets, u, d, "no-cache"));
		};
		const seedBootStore = async () => {
			const store = env.bootStore;
			if (!store) return;
			try {
				for (const [cacheName, urls] of BOOT_SET) {
					const cache = await caches.open(cacheName);
					const entries = [];
					for (const url of urls) {
						const cached = await cache.match(url);
						if (!cached) continue;
						entries.push([bootKey(buildId, url), {
							status: cached.status,
							contentType: cached.headers.get("content-type") ?? "application/octet-stream",
							body: await cached.arrayBuffer()
						}]);
					}
					await store.putAll(entries);
				}
			} catch {}
		};
		const bootStoreFirst = async (url, fallback) => {
			const store = env.bootStore;
			if (store && BOOT_URLS.has(url)) try {
				const entry = await store.get(bootKey(buildId, url));
				if (entry) {
					env.mark?.("bootStoreHitAt");
					return new Response(entry.body, {
						status: entry.status,
						headers: { "content-type": entry.contentType }
					});
				}
			} catch {}
			return fallback();
		};
		const activate = async () => {
			const ledger = await readLedger();
			const keepIds = new Set(computeKeepIds(ledger, keepGenerations));
			const expiredIds = computeExpiredIds(ledger, keepGenerations);
			await Promise.all(expiredIds.flatMap(deleteGeneration));
			if (ledger.length > keepIds.size) try {
				await trimLedger();
			} catch {}
			try {
				await sweepStalePreviewGenerations();
			} catch {}
		};
		const sweepStalePreviewGenerations = async () => {
			const meta = await caches.open(META_CACHE);
			const ledgers = [];
			const databaseRecords = [];
			for (const req of await meta.keys()) {
				if (req.url.endsWith(`/${LEDGER_BASENAME}`)) {
					const res = await meta.match(req);
					if (!res) continue;
					const { ids, updatedAt } = normalizeLedger(await res.json().catch(() => null));
					ledgers.push({
						scopeUrl: req.url,
						ids,
						updatedAt
					});
					continue;
				}
				const recordInfo = previewDatabaseRecordInfo(req.url, LEDGER_BASENAME);
				if (recordInfo) {
					const res = await meta.match(req);
					const raw = res ? await res.json().catch(() => null) : null;
					databaseRecords.push({
						...recordInfo,
						recordUrl: req.url,
						updatedAt: databaseRecordUpdatedAt(raw)
					});
				}
			}
			const sweepNow = now();
			const plan = computeReapableCaches({
				ledgers,
				now: sweepNow,
				staleMs: config.staleScopeMs,
				selfScopeUrl: LEDGER_KEY
			});
			await Promise.all([
				sweepStalePreviewDatabases(meta, {
					ledgerScopeUrls: plan.ledgerScopeUrls,
					knownLedgerScopeUrls: ledgers.map(({ scopeUrl }) => scopeUrl),
					databaseRecords,
					sweepNow,
					staleMs: config.staleScopeMs
				}),
				...plan.reapIds.flatMap(deleteGeneration),
				...plan.ledgerScopeUrls.map((url) => meta.delete(url))
			]);
		};
		const databaseRecordUpdatedAt = (raw) => {
			if (!raw || typeof raw !== "object") return void 0;
			const { updatedAt } = raw;
			return typeof updatedAt === "number" ? updatedAt : void 0;
		};
		const previewIdForScopeUrl = (scopeUrl) => {
			try {
				return new URL(scopeUrl).pathname.match(/\/pr-preview\/(pr-[^/]+)\//)?.[1] ?? null;
			} catch {
				return null;
			}
		};
		const isDatabaseNameForPreviewScope = (databaseName, scopeUrl) => {
			const previewId = previewIdForScopeUrl(scopeUrl);
			if (!previewId) return false;
			const escapedPreviewId = previewId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return new RegExp(`^kmp-v\\d+~${escapedPreviewId}~[A-Za-z0-9_-]*\\.db$`).test(databaseName);
		};
		const databaseRecordsToSweep = (ledgerScopeUrls, knownLedgerScopeUrls, databaseRecords, sweepNow, staleMs) => {
			const reapedScopes = new Set(ledgerScopeUrls);
			const knownScopes = new Set(knownLedgerScopeUrls);
			const records = [];
			const seen = /* @__PURE__ */ new Set();
			for (const record of databaseRecords) {
				const orphanedStaleRecord = typeof record.updatedAt === "number" && sweepNow - record.updatedAt > staleMs && !knownScopes.has(record.scopeUrl);
				if (!reapedScopes.has(record.scopeUrl) && !orphanedStaleRecord) continue;
				if (!isDatabaseNameForPreviewScope(record.name, record.scopeUrl)) continue;
				const key = `${record.scopeUrl}\n${record.name}`;
				if (seen.has(key)) continue;
				seen.add(key);
				records.push(record);
			}
			return records;
		};
		const sweepStalePreviewDatabases = async (meta, { ledgerScopeUrls, knownLedgerScopeUrls, databaseRecords, sweepNow, staleMs }) => {
			const databases = databaseRecordsToSweep(ledgerScopeUrls, knownLedgerScopeUrls, databaseRecords, sweepNow, staleMs);
			await Promise.all(databases.map(async ({ name, recordUrl }) => {
				try {
					await deleteOpfsSqliteDatabase(name);
					await deleteIndexedDatabase(name).catch(() => {});
				} catch {
					return;
				}
				await meta.delete(recordUrl).catch(() => false);
			}));
		};
		const deleteOpfsSqliteDatabase = async (databaseName) => {
			if (typeof env.storage?.getDirectory !== "function") return;
			const root = await env.storage.getDirectory();
			const journalFailure = (await Promise.allSettled(SQLITE_JOURNAL_SUFFIXES.map((suffix) => removeOpfsEntryIfExists(root, databaseName + suffix)))).find((result) => result.status === "rejected");
			if (journalFailure) throw journalFailure.reason;
			await removeOpfsEntryIfExists(root, databaseName);
			await Promise.allSettled(WRITE_AHEAD_SIDECAR_SUFFIXES.map((suffix) => removeOpfsEntryIfExists(root, databaseName + suffix)));
		};
		const removeOpfsEntryIfExists = async (root, name) => {
			try {
				await root.removeEntry(name);
			} catch (err) {
				if (!(err instanceof DOMException && err.name === "NotFoundError")) throw err;
			}
		};
		const deleteIndexedDatabase = async (databaseName) => {
			const idb = env.indexedDB;
			if (typeof idb?.deleteDatabase !== "function") return;
			if (typeof idb.databases === "function") {
				const existing = await idb.databases().catch(() => null);
				if (existing && !existing.some((db) => db.name === databaseName)) return;
			}
			await new Promise((resolve, reject) => {
				const request = idb.deleteDatabase(databaseName);
				let settled = false;
				const settle = (fn) => {
					if (settled) return;
					settled = true;
					fn();
				};
				request.onsuccess = () => settle(resolve);
				request.onerror = () => settle(() => reject(request.error));
				request.onblocked = () => settle(() => reject(/* @__PURE__ */ new Error(`IndexedDB delete blocked for ${databaseName}`)));
			});
		};
		const isNavigationRequest = (request) => request.mode === "navigate" || request.method === "GET" && (request.headers.get("accept")?.includes("text/html") ?? false);
		const isSameOrigin = (url) => url.origin === env.origin;
		const isVendor = (url) => VENDOR_HOSTS.has(url.hostname);
		const shellCacheFirst = async (request, shellURL) => {
			const cache = await caches.open(SHELL_CACHE);
			env.mark?.("shellCacheOpenedAt");
			const cached = await cache.match(shellURL);
			env.mark?.("shellCacheMatchedAt");
			if (cached) return cached;
			const fresh = await fetch(request);
			if (fresh && fresh.ok) cache.put(shellURL, fresh.clone()).catch(() => {});
			return fresh;
		};
		const assetCacheFirst = async (request) => {
			const assets = await caches.open(ASSET_CACHE);
			const cached = await assets.match(request) || await (await caches.open(SHELL_CACHE)).match(request);
			if (cached) return cached;
			try {
				const fresh = await fetch(request);
				if (fresh && fresh.ok) assets.put(request, fresh.clone()).catch(() => {});
				return fresh;
			} catch {
				return Response.error();
			}
		};
		const cacheFirst = async (request, cacheName) => {
			const cache = await caches.open(cacheName);
			const cached = await cache.match(request);
			if (cached) return cached;
			try {
				const fresh = await fetch(request);
				if (fresh && fresh.ok) cache.put(request, fresh.clone()).catch(() => {});
				return fresh;
			} catch {
				return Response.error();
			}
		};
		/**
		* Route a GET request. Returns a Response promise for the entry to
		* `respondWith`, or undefined to NOT intercept (let the browser handle it —
		* non-GET, non-http(s), foreign preview subtree, and same-origin non-assets
		* like version.json that must stay fresh).
		*/
		const handleFetch = (request, waitUntil) => {
			if (request.method !== "GET") return void 0;
			const url = new URL(request.url);
			if (url.protocol !== "http:" && url.protocol !== "https:") return void 0;
			maybeTouchOwnLedger(waitUntil);
			if (isForeignPreviewRequest(OWN_SCOPE_IS_PREVIEW, url.pathname)) return void 0;
			if (isNavigationRequest(request) && isSameOrigin(url)) {
				if (url.pathname === scopeURL.pathname || url.href.split(/[?#]/)[0] === SHELL_URL) return bootStoreFirst(SHELL_URL, () => shellCacheFirst(request, SHELL_URL));
				return shellCacheFirst(request, SHELL_URL);
			}
			if (isCacheableAsset(request.destination, url.pathname, isSameOrigin(url))) return bootStoreFirst(request.url, () => assetCacheFirst(request));
			if (isVendor(url)) return cacheFirst(request, VENDOR_CACHE);
		};
		return {
			install,
			activate,
			handleFetch,
			readLedger,
			writeLedger,
			recordGeneration
		};
	};
	// src/sw/sw.ts
	var bootMarks = {
		timeOrigin: performance.timeOrigin,
		evaluatedAt: 0,
		firstNavReceivedAt: 0,
		firstNavAnsweredAt: 0
	};
	var mark = (name) => {
		if (!bootMarks[name]) bootMarks[name] = performance.now();
	};
	var sw = createServiceWorker({
		buildId: "af9096a052af-5e5633c6",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1925/\":\"a7fe2b826d2fd095\",\"/knowledge-medium/pr-preview/pr-1925/index.html\":\"a7fe2b826d2fd095\",\"/knowledge-medium/pr-preview/pr-1925/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1925/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1925/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1925/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1925/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1925/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1925/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1925/assets/FacadeVFS-UqkQmcF2.js\":\"19a7bacbaa239c4b\",\"/knowledge-medium/pr-preview/pr-1925/assets/OPFSCoopSyncVFS-B5lcVDXt.js\":\"2b5f4faab885a312\",\"/knowledge-medium/pr-preview/pr-1925/assets/OPFSWriteAheadVFS-BvJp6tWo.js\":\"0dacd265bb208c60\",\"/knowledge-medium/pr-preview/pr-1925/assets/wa-sqlite-CZzDLRmi.js\":\"de99cbc7ce174a11\",\"/knowledge-medium/pr-preview/pr-1925/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1925/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1925/assets/wa-sqlite-async-C2Wp0erQ.js\":\"bb1fb700b13493b9\",\"/knowledge-medium/pr-preview/pr-1925/assets/worker-CAg0Ezas.js\":\"3153e78fc220408b\",\"/knowledge-medium/pr-preview/pr-1925/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1925/chunks/app-Bs0NPOmG.js\":\"5dac06eec9a3a05a\",\"/knowledge-medium/pr-preview/pr-1925/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1925/index.js\":\"ea28057dcdd33e08\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1925/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1925/assets/AccessHandlePoolVFS-DapMNzXS.js\":\"8dd92e753a8b1740\",\"/knowledge-medium/pr-preview/pr-1925/assets/IDBBatchAtomicVFS-BNOaG816.js\":\"bd9068cae858888f\",\"/knowledge-medium/pr-preview/pr-1925/assets/MemoryVFS-DPRNBzV8.js\":\"abeda537707329da\",\"/knowledge-medium/pr-preview/pr-1925/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1925/assets/mc-wa-sqlite-D1Oe8RDV.js\":\"96f4368f02ea8371\",\"/knowledge-medium/pr-preview/pr-1925/assets/mc-wa-sqlite-async-DsPoeweY.js\":\"956fd2d5a513c7ff\",\"/knowledge-medium/pr-preview/pr-1925/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1925/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1925/chunks/AccessHandlePoolVFS-Cp7joc0l.js\":\"ce3c1da4c1d8cab1\",\"/knowledge-medium/pr-preview/pr-1925/chunks/FacadeVFS-BO_GxfCf.js\":\"0f235b264fd54c2c\",\"/knowledge-medium/pr-preview/pr-1925/chunks/IDBBatchAtomicVFS-BgE3WTcj.js\":\"da2e07de830c42a5\",\"/knowledge-medium/pr-preview/pr-1925/chunks/MemoryVFS-liC8ZiSZ.js\":\"3162f5d26d12a2dd\",\"/knowledge-medium/pr-preview/pr-1925/chunks/OPFSCoopSyncVFS-CBVDQajW.js\":\"0e8d79440a782ff7\",\"/knowledge-medium/pr-preview/pr-1925/chunks/OPFSWriteAheadVFS-qdRBgybi.js\":\"9a0288de684274f8\",\"/knowledge-medium/pr-preview/pr-1925/chunks/Preview-5dsxY5Kf.js\":\"80550c2058b84f73\",\"/knowledge-medium/pr-preview/pr-1925/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1925/chunks/card-DiYeQo6W.js\":\"bc1705eecb6ee78c\",\"/knowledge-medium/pr-preview/pr-1925/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1925/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1925/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1925/chunks/dist-DFMOsq9T.js\":\"591fb49ab65041b1\",\"/knowledge-medium/pr-preview/pr-1925/chunks/freezeExtensionImports-DwbDP1ju.js\":\"731d23d46fecc468\",\"/knowledge-medium/pr-preview/pr-1925/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1925/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/pr-preview/pr-1925/chunks/mc-wa-sqlite-BqzrwCH3.js\":\"33ee09053e5f1586\",\"/knowledge-medium/pr-preview/pr-1925/chunks/mc-wa-sqlite-async-jsg6LZLF.js\":\"9828e63f42c41444\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-B6ErIeZI.js\":\"42520e40ae5a010b\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-BQiVD6Aj.js\":\"beae73e1ee1618a6\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-BX6ipVfB.js\":\"3138acdf5b3567e6\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-D8CCuMSg.js\":\"71510c76d334411c\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-DCje_a0X.js\":\"81ed1f0f2e132044\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-DWunAiIK.js\":\"58487d487c2f032b\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-D_4e56tM.js\":\"6ec5a62d1a89b71f\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-dom-server-legacy.browser.production-CmlTjVWB.js\":\"b620c3a28006eaa7\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-dom-server.browser.production-DXP2rVnt.js\":\"7dfaff89d1304b0e\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-dom-server.edge.production-CETC5ny6.js\":\"f59dec6cc278d675\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-o9-3J_3v.js\":\"26c6473fdad13629\",\"/knowledge-medium/pr-preview/pr-1925/chunks/server.browser-CIgR3LFE.js\":\"a17f7b6f69d059a5\",\"/knowledge-medium/pr-preview/pr-1925/chunks/textarea-DfEbiM6e.js\":\"97aaf01dbaf01563\",\"/knowledge-medium/pr-preview/pr-1925/chunks/ui-HlcW_3m9.js\":\"713755ff2899f16a\",\"/knowledge-medium/pr-preview/pr-1925/chunks/wa-sqlite-CwRJLjPI.js\":\"110c0baeee81ab78\",\"/knowledge-medium/pr-preview/pr-1925/chunks/wa-sqlite-async-DudyhuEa.js\":\"03fc0fdbd1d979b9\",\"/knowledge-medium/pr-preview/pr-1925/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1925/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1925/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1925/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1925/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1925/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1925/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1925/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1925/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1925/src/App.js\":\"3bf4811b66bc85a2\",\"/knowledge-medium/pr-preview/pr-1925/src/appUpdate.js\":\"95f69f044a8c2848\",\"/knowledge-medium/pr-preview/pr-1925/src/appVersion.js\":\"2026e3ad2deb3907\",\"/knowledge-medium/pr-preview/pr-1925/src/bootstrap/initialLayout.js\":\"f49889865a6b3c50\",\"/knowledge-medium/pr-preview/pr-1925/src/bootstrap/openWorkspaceData.js\":\"ae1edbd3599a1912\",\"/knowledge-medium/pr-preview/pr-1925/src/bootstrap/resolveWorkspace.js\":\"127442ccfbd51916\",\"/knowledge-medium/pr-preview/pr-1925/src/bootstrap/workspaceBootstrap.js\":\"3eac696d809784c6\",\"/knowledge-medium/pr-preview/pr-1925/src/components/BlockComponent.js\":\"f507bcc48b72a0b1\",\"/knowledge-medium/pr-preview/pr-1925/src/components/BlockCrumbs.js\":\"3b5f37a061914a86\",\"/knowledge-medium/pr-preview/pr-1925/src/components/BlockEditor.js\":\"cf009b6d519c12e6\",\"/knowledge-medium/pr-preview/pr-1925/src/components/BlockLoadingPlaceholder.js\":\"2d9d70f3fe4c0c59\",\"/knowledge-medium/pr-preview/pr-1925/src/components/BlockProperties.js\":\"8e681d1338958bee\",\"/knowledge-medium/pr-preview/pr-1925/src/components/BlockSearchPicker.js\":\"411b0c2c2edf6e5a\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ConfirmBulkDeleteDialog.js\":\"c0b1f33e97703bc4\",\"/knowledge-medium/pr-preview/pr-1925/src/components/DividerHandle.js\":\"25e899f1000b39eb\",\"/knowledge-medium/pr-preview/pr-1925/src/components/DraftEditor.js\":\"32b21e2efd999cee\",\"/knowledge-medium/pr-preview/pr-1925/src/components/GutterPill.js\":\"a327c64094fd4c25\",\"/knowledge-medium/pr-preview/pr-1925/src/components/Header.js\":\"0f16d73605aa5530\",\"/knowledge-medium/pr-preview/pr-1925/src/components/LazyBlockComponent.js\":\"9119a046661f09f0\",\"/knowledge-medium/pr-preview/pr-1925/src/components/Login.js\":\"67b74e7cccbf1f66\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ZoomableSurface.js\":\"85820ab8a59c0222\",\"/knowledge-medium/pr-preview/pr-1925/src/components/editModeKeepalive.js\":\"ebb188ecfa743b0d\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyDisplay/PropertyDisplayScope.js\":\"c9710339e9958630\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"0946a825eb2d543c\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/RefPropertyEditor.js\":\"5aa4b33506e08795\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/RefTargetTypePicker.js\":\"f8b5b3a0ad4547e9\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/SelectPropertyEditor.js\":\"ce6b3059cc4afa50\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/TypesPropertyEditor.js\":\"0fb47fda6e1c301b\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/defaults.js\":\"bfec63489c7d4117\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/kernelValuePresets.js\":\"0fae812e1706cced\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/selectablePresets.js\":\"bd35b6a8cd809e32\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/typesPropertyUi.js\":\"3508d7acece40291\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/AddPropertyForm.js\":\"6eb29a15d88ed125\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/PropertyPicker.js\":\"f9028ca2c7b4afb9\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/PropertyRow.js\":\"8b673783dce8f1e2\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/Rows.js\":\"ad9f6530a228eec6\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/actions.js\":\"69c8206ad851e13a\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/declarationOnly.js\":\"1c3a8ae260f470af\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/layout.js\":\"2c05feb30cb05a23\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/model.js\":\"31c4f6ba0229ce5e\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/shapeUi.js\":\"e514d3eb31e2c269\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/shapes.js\":\"686107124e4a7577\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/usePropertyEditingActivation.js\":\"3706bf54c71489dc\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/visibility.js\":\"4e5dd7dac0a14096\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanelSections.js\":\"8500aa8189018bed\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/BlockEmbed.js\":\"63b0f5fbad9fadc9\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/BlockLink.js\":\"a621da066bdfba4f\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/BlockRef.js\":\"8ad2073b59998e70\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/CompactReferenceLink.js\":\"4632fcbb493908e7\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/ReferenceLink.js\":\"2de199fabf8ad498\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/cycleGuard.js\":\"51fb26ebd3ab20c7\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/cycleGuardContext.js\":\"7b6137c472e89cee\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/linkInteraction.js\":\"f76f8f0e9bc88df6\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/referenceLayout.js\":\"10bc6e68b4187067\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/useBlockRefAncestors.js\":\"01fd332b8f8202e9\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/BlockGutter.js\":\"47c3493b7110f438\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/BlockInfoDialog.js\":\"7229739d75ebe339\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/BlockReadText.js\":\"68da2d55b8e8847d\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/BlockTypeBlockRenderer.js\":\"2e2ddd8db8e3e67c\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/BulletHoverCard.js\":\"c503eced1a50428a\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/CodeMirrorContentRenderer.js\":\"b2053a6270862f99\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"97fbb2fd5a493f5f\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/ColumnResizeHandles.js\":\"cade46e7edaa4ec0\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"41ac8aff950e30dd\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/DefaultBlockRenderer.js\":\"e245b514181b911b\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/LayoutRenderer.js\":\"8f7922698c2cb504\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/MarkdownContentRenderer.js\":\"21b2afe05f072815\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/MissingDataRenderer.js\":\"f91b25f8fa115ee0\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/PanelRenderer.js\":\"e567c1e821bab1ce\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/PropertySchemaBlockRenderer.js\":\"8f3e5b7b761a17bf\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/TopLevelRenderer.js\":\"78c2b07fff2c408d\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/blockGutterMode.js\":\"4075781738a6ac85\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/blockTitleText.js\":\"21c3a9abc329198e\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/fieldCreationKeydown.js\":\"859ec4bd97dee62a\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/layoutRootContext.js\":\"36499746e7426e44\",\"/knowledge-medium/pr-preview/pr-1925/src/components/typeChip/TypeChip.js\":\"d54b48ef2b808d61\",\"/knowledge-medium/pr-preview/pr-1925/src/components/typeChip/chipStyle.js\":\"d43c997e77a82e12\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/anchored-floating.js\":\"a752c535f6057a92\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/button.js\":\"d7906da4d5204450\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/card.js\":\"71870c6cf63cb9f0\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/checkbox.js\":\"2e794f31e358b2ef\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/collapsible.js\":\"fa38677fdd143190\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/command.js\":\"ba82ad23db0c641d\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/context-menu.js\":\"b64e59385f7cb08f\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/dialog.js\":\"1bd28f79114a005b\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/dropdown-menu.js\":\"a96a286595ff1ff2\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/floating-listbox.js\":\"cf21212316355f00\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/index.js\":\"9294d95713fffe85\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/input.js\":\"4b2110b838a8c098\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/kbd.js\":\"eab4ba2013f91833\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/label.js\":\"c55aa7ed7e0d0139\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/textarea.js\":\"78bcb47888ac8b81\",\"/knowledge-medium/pr-preview/pr-1925/src/components/useEditModeYieldKeepalive.js\":\"d87731ffe0ca0a34\",\"/knowledge-medium/pr-preview/pr-1925/src/components/util/BootFallback.js\":\"515ee05bdbc51175\",\"/knowledge-medium/pr-preview/pr-1925/src/components/util/FocusedRowLazyMount.js\":\"83bf0f711c2f9975\",\"/knowledge-medium/pr-preview/pr-1925/src/components/util/LazyViewportMount.js\":\"1a7c2095386d02ce\",\"/knowledge-medium/pr-preview/pr-1925/src/components/util/LocalDbCorruptionFallback.js\":\"9334dd44a134d8f6\",\"/knowledge-medium/pr-preview/pr-1925/src/components/util/error.js\":\"cb24d64e86ed6091\",\"/knowledge-medium/pr-preview/pr-1925/src/components/util/lazyMountRegistry.js\":\"66c67d90daa86462\",\"/knowledge-medium/pr-preview/pr-1925/src/components/util/suspense.js\":\"2395c0494c52c24f\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/CreateWorkspaceDialog.js\":\"aa6086b638b6fbc7\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/PendingInvitations.js\":\"9b6467898dfcfc3a\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/SyncProgress.js\":\"489afe32edc627c2\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/UnlockProgress.js\":\"84e29c424ca81cb3\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/WorkspaceKeyGate.js\":\"d4f58b585b3dc1ed\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/WorkspaceSettingsDialog.js\":\"83c993df91e46d9e\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/WorkspaceSwitcher.js\":\"e197e1c401bdf0f5\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/WorkspaceSyncGate.js\":\"7027217ab7e4fb97\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/ConversionFlow.js\":\"bb085f6fcbaf4c47\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/ConversionFlowHost.js\":\"110ebf95304daea1\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/EncryptionSection.js\":\"5adeeff30e95cbdf\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/attachmentPrompts.js\":\"5244a3a1ffa24406\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/bundleFolderPrompts.js\":\"700e152593f81be8\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/conversionFlowDeps.js\":\"841a28d9cea11432\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/conversionFlowStore.js\":\"44028ceeef0cbefb\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/flowUi.js\":\"e3427ba6849cfc80\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/useConversionRun.js\":\"e5956a3a2eeaa4e4\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/keyUi.js\":\"2310efb4fa0e0ec7\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/useCloseOnKeyLoss.js\":\"44d012a98aebc0e4\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/useCloseOnServerE2ee.js\":\"2b5373ccfc7c4758\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/workspaceUnlocked.js\":\"08c3d2de8fbb6028\",\"/knowledge-medium/pr-preview/pr-1925/src/context/backgroundSubtree.js\":\"ccd0a6595e1928f2\",\"/knowledge-medium/pr-preview/pr-1925/src/context/block.js\":\"16e81b59fa9b835a\",\"/knowledge-medium/pr-preview/pr-1925/src/context/layoutWsContext.js\":\"304f532f0458d359\",\"/knowledge-medium/pr-preview/pr-1925/src/context/propertyDisplay.js\":\"b48c3144f31b77ec\",\"/knowledge-medium/pr-preview/pr-1925/src/context/repo.js\":\"60e46d614f509278\",\"/knowledge-medium/pr-preview/pr-1925/src/data/aliasClaim.js\":\"222360ae7d7cad8a\",\"/knowledge-medium/pr-preview/pr-1925/src/data/aliasSeatNamespace.js\":\"f56d2160e685bfb2\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/blockData.js\":\"c32971accfc2384c\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/blockType.js\":\"bf2febf4cdd23b3e\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/changeScope.js\":\"6c3c9e62fc758497\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/codecs.js\":\"4d12259a18eef5b1\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/derivedData.js\":\"245c282bcc363e13\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/errors.js\":\"a60c279f76da2341\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/events.js\":\"9299dac945310f7c\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/handle.js\":\"0ef98cb040d9dbc4\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/index.js\":\"fde45b8a7581f124\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/mutator.js\":\"ad0f5cf356f8d210\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/processor.js\":\"1a8b671aa3378c88\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/propertySchema.js\":\"0dc8052ee2dd5ae3\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/query.js\":\"a816e11592e696d3\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/sameTxProcessor.js\":\"239792d27c2334bd\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/schema.js\":\"0ef98cb040d9dbc4\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/tx.js\":\"0ef98cb040d9dbc4\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/typedBlockQuery.js\":\"f7b20dbcc9e870e1\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/user.js\":\"7827c16e50c9f797\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/valuePresetCore.js\":\"97e7844640f91377\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/valuePresets.js\":\"42857fa90556bb35\",\"/knowledge-medium/pr-preview/pr-1925/src/data/attachmentCleanerIOVerb.js\":\"2997dc862988a621\",\"/knowledge-medium/pr-preview/pr-1925/src/data/block.js\":\"02d7a5f188a3675e\",\"/knowledge-medium/pr-preview/pr-1925/src/data/blockCache.js\":\"7a10bea2d7599aa2\",\"/knowledge-medium/pr-preview/pr-1925/src/data/blockId.js\":\"98bc60065aeb886a\",\"/knowledge-medium/pr-preview/pr-1925/src/data/blockLiveness.js\":\"4072770d5a5611e9\",\"/knowledge-medium/pr-preview/pr-1925/src/data/blockMerge.js\":\"b590e0ec8cb9ff61\",\"/knowledge-medium/pr-preview/pr-1925/src/data/blockSchema.js\":\"53eda6cffb02ffee\",\"/knowledge-medium/pr-preview/pr-1925/src/data/blockTypeLookup.js\":\"ce127fbf7608f72e\",\"/knowledge-medium/pr-preview/pr-1925/src/data/blockTypes.js\":\"599f04faedc6e88e\",\"/knowledge-medium/pr-preview/pr-1925/src/data/childrenView.js\":\"e52093317e40543b\",\"/knowledge-medium/pr-preview/pr-1925/src/data/clientContext.js\":\"775a978c32e5f880\",\"/knowledge-medium/pr-preview/pr-1925/src/data/dbFileSiblings.js\":\"f36cce1fcfda5a74\",\"/knowledge-medium/pr-preview/pr-1925/src/data/definitionSeeds.js\":\"f4d9b962dbf6116c\",\"/knowledge-medium/pr-preview/pr-1925/src/data/derivedIds.js\":\"f18e45bda658bfc9\",\"/knowledge-medium/pr-preview/pr-1925/src/data/drawnSubtree.js\":\"df4d69bc0e3978ec\",\"/knowledge-medium/pr-preview/pr-1925/src/data/facetBridge.js\":\"4de1aa07d6f45e4c\",\"/knowledge-medium/pr-preview/pr-1925/src/data/facets.js\":\"18c8a256f2d9b1ed\",\"/knowledge-medium/pr-preview/pr-1925/src/data/globalState.js\":\"0bb81902f700b3b2\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/aliasClaimRederiveProcessor.js\":\"0144c4439fde651a\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/ancestorBatch.js\":\"3ac21687a23012cb\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/blockTypeTypeifyProcessor.js\":\"5d41fc1b2a584592\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/clientSchema.js\":\"6fda7fa7584bf1c7\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/commitPipeline.js\":\"9a6ba9341226c0a5\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/devAssertions.js\":\"86a35b610f55cdc0\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/firstSync.js\":\"58dcaa22dbb4f32b\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/freshInitialLoad.js\":\"3a139b46ea7e2d97\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/graphBackfillClaim.js\":\"3689cd4a83117afc\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/handleStore.js\":\"191582cdac854e3f\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/idleMarkerJobs.js\":\"1304e37a026b4c56\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/initialDownload.js\":\"4c73589f3a9369cb\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/initializeClientDatabase.js\":\"fb0659358c62dd46\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/jsonCanonical.js\":\"30c649e0419ce1dc\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/kernelInvalidation.js\":\"e1bc1174350226d9\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/kernelProcessors.js\":\"4ccdd8757959734e\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/kernelQueries.js\":\"895c516a3c32ac0a\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/mergeTypeMembershipProcessor.js\":\"96443904929c7801\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/normalizeReferencesProcessor.js\":\"94964c05b950c088\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/poolInstrumentation.js\":\"9a82d0a4747c4729\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/processorRunner.js\":\"40f0d200cc574672\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/propertyCellBackfill.js\":\"cc7cbbcf77860f1a\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/propertyChildMint.js\":\"d303d7ac3df96d3f\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/propertyChildrenProcessor.js\":\"54c5060583ae5ac1\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/propertyDefinitionChangeProcessor.js\":\"b2982bf9819c9e64\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/propertyDefinitionSynthesis.js\":\"7b47fac99933af1d\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/propertyKeyScan.js\":\"5080757fd8bd3dcd\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/propertySchemaResolution.js\":\"9b0af369a3767764\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/propertyValueEdits.js\":\"951efb9cdf39cc9c\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/raiseProtocol.js\":\"85d9fe3d0226567c\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/readBatch.js\":\"ae8eea16f905bc54\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/refProjection.js\":\"231bf7c3f319f915\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/referenceTargetLookups.js\":\"8671ad001e59a62b\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/referenceTargetProcessor.js\":\"f7872204497f1db3\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/replayMerge.js\":\"611720407ed24dbe\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/sqlBinds.js\":\"122ec2815e4bb71c\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"0d06618c1e72bbfa\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/syncObserver/arrivalProcessors.js\":\"91d2512bb5c56b1c\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/syncObserver/invalidate.js\":\"ee359272279c3c3a\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/syncObserver/materialize.js\":\"7d261ef75385ff6c\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/syncObserver/observer.js\":\"41273425cc410b5c\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/syncObserver/reconcile.js\":\"287db9e5d2c170de\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/timingMetrics.js\":\"a46d187777858f6f\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/treeQueries.js\":\"974a911f15212cb9\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/txEngine.js\":\"90b32e04a65c36b4\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/txSnapshots.js\":\"6098759eba8e3bdf\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/typedBlockQuery.js\":\"ffc1f50c71954f7b\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/undoManager.js\":\"148079d58a2a83dd\",\"/knowledge-medium/pr-preview/pr-1925/src/data/invalidation.js\":\"1c073a0d3a278c1b\",\"/knowledge-medium/pr-preview/pr-1925/src/data/kernelDataExtension.js\":\"2c01eda992125439\",\"/knowledge-medium/pr-preview/pr-1925/src/data/kernelPage.js\":\"d34117833ee37864\",\"/knowledge-medium/pr-preview/pr-1925/src/data/kernelValuePresetCores.js\":\"76747fe8bf95a227\",\"/knowledge-medium/pr-preview/pr-1925/src/data/localDbCorruptionSignal.js\":\"114f30d88b92f8bd\",\"/knowledge-medium/pr-preview/pr-1925/src/data/localDbStorage.js\":\"66794aaa02878638\",\"/knowledge-medium/pr-preview/pr-1925/src/data/localDbVfs.js\":\"4a6c26d442b543b5\",\"/knowledge-medium/pr-preview/pr-1925/src/data/localSchema.js\":\"54a40d4b4b3f9c90\",\"/knowledge-medium/pr-preview/pr-1925/src/data/maintenance.js\":\"eba4fb4525850fa9\",\"/knowledge-medium/pr-preview/pr-1925/src/data/mergeProperties.js\":\"c075d729432135e9\",\"/knowledge-medium/pr-preview/pr-1925/src/data/metricsConsoleHook.js\":\"2403540253da53af\",\"/knowledge-medium/pr-preview/pr-1925/src/data/migrationsPage.js\":\"d92e69084ec59a7a\",\"/knowledge-medium/pr-preview/pr-1925/src/data/mutators.js\":\"e0ede4f1f1c882a4\",\"/knowledge-medium/pr-preview/pr-1925/src/data/orderKey.js\":\"118400df29aee4ef\",\"/knowledge-medium/pr-preview/pr-1925/src/data/orderKeyPlacement.js\":\"f4f502898d6a2321\",\"/knowledge-medium/pr-preview/pr-1925/src/data/outlineSurface.js\":\"e857f7c05b21fe4d\",\"/knowledge-medium/pr-preview/pr-1925/src/data/pendingEditorContent.js\":\"c2a58dec98543c76\",\"/knowledge-medium/pr-preview/pr-1925/src/data/pendingUploadsSql.js\":\"b925aa928608b823\",\"/knowledge-medium/pr-preview/pr-1925/src/data/pluginStateExtensions.js\":\"82d61a6d2595b1b6\",\"/knowledge-medium/pr-preview/pr-1925/src/data/powerSyncLogger.js\":\"11a6a37583cb22f3\",\"/knowledge-medium/pr-preview/pr-1925/src/data/projectorRuntime.js\":\"4e0600faac735b8d\",\"/knowledge-medium/pr-preview/pr-1925/src/data/properties.js\":\"a70698928f4be415\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertiesPage.js\":\"30fdc2b86993c49f\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertyChildren.js\":\"219349ce35977c72\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertyDefinitionFanout.js\":\"45d766399ab5d4c9\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertyDefinitionMetadata.js\":\"c00a5bbb07a1197b\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertyDefinitionRegistry.js\":\"0af81610cbfcee75\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertyDisplayMode.js\":\"eb0000d17299f8c8\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertyRowCreation.js\":\"10c3477f58903893\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertySchemaCreation.js\":\"03284a8bedb7b6bb\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertySeeds.js\":\"e36a563680ec881f\",\"/knowledge-medium/pr-preview/pr-1925/src/data/recentsPage.js\":\"a054b3aece3c85ed\",\"/knowledge-medium/pr-preview/pr-1925/src/data/refTargetComparableProperty.js\":\"4fd8be6efe86de3b\",\"/knowledge-medium/pr-preview/pr-1925/src/data/referenceBlock.js\":\"cfee4346fa13d873\",\"/knowledge-medium/pr-preview/pr-1925/src/data/rejectedUploads.js\":\"542a87225de531a0\",\"/knowledge-medium/pr-preview/pr-1925/src/data/releasePowerSyncConnection.js\":\"554454ce14f805cf\",\"/knowledge-medium/pr-preview/pr-1925/src/data/repo.js\":\"8514b4b122f50d9c\",\"/knowledge-medium/pr-preview/pr-1925/src/data/repoProvider.js\":\"9618481b049f4354\",\"/knowledge-medium/pr-preview/pr-1925/src/data/rowProperty.js\":\"0d61bed88bd7af17\",\"/knowledge-medium/pr-preview/pr-1925/src/data/searchFilter.js\":\"b33df4265fff7df4\",\"/knowledge-medium/pr-preview/pr-1925/src/data/seedIdentityLedger.js\":\"25b8398c35e21e4b\",\"/knowledge-medium/pr-preview/pr-1925/src/data/stateBlocks.js\":\"ca233e304384f586\",\"/knowledge-medium/pr-preview/pr-1925/src/data/structuralEditPolicy.js\":\"b340742565931fe0\",\"/knowledge-medium/pr-preview/pr-1925/src/data/structuralInsert.js\":\"ec6f548eb47ca81d\",\"/knowledge-medium/pr-preview/pr-1925/src/data/subtreeDelete.js\":\"e2bc135675eeb8ae\",\"/knowledge-medium/pr-preview/pr-1925/src/data/syncStreamLock.js\":\"7493bf5182220503\",\"/knowledge-medium/pr-preview/pr-1925/src/data/syncedTableSqlRecognizer.js\":\"fcca62039e756205\",\"/knowledge-medium/pr-preview/pr-1925/src/data/syncedTableWriteGuard.js\":\"db2878a40f0fbd43\",\"/knowledge-medium/pr-preview/pr-1925/src/data/targets.js\":\"8f9fbf7f108769ce\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typeColors.js\":\"71236460da0e0e7d\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typeDefinitionMetadata.js\":\"996fa569a5eed940\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typeDefinitionRegistry.js\":\"644dc88165a5266f\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typeExtraction.js\":\"4be9ebdceacf057b\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typeInitialValues.js\":\"3515d8dafc91a38e\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typePropertyGroups.js\":\"5c72ec33ccfbfa1a\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typeSeeds.js\":\"66c3bad84ded5f8e\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typeTagger.js\":\"54d8c483c4fb7714\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typedRecords.js\":\"e9df8b751f41e7c8\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typesPage.js\":\"c76ff4808d15c39c\",\"/knowledge-medium/pr-preview/pr-1925/src/data/userPrefs.js\":\"21206f7f4f9252c4\",\"/knowledge-medium/pr-preview/pr-1925/src/data/userSchemasService.js\":\"01a77505618dba8a\",\"/knowledge-medium/pr-preview/pr-1925/src/data/userTypesService.js\":\"447ec786c3936c92\",\"/knowledge-medium/pr-preview/pr-1925/src/data/valuePresetRegistry.js\":\"e970b35e9a4d4bbb\",\"/knowledge-medium/pr-preview/pr-1925/src/data/visibleChildren.js\":\"6e95e9530fb1d980\",\"/knowledge-medium/pr-preview/pr-1925/src/data/workspaceConversion.js\":\"eb86fb178415c8ee\",\"/knowledge-medium/pr-preview/pr-1925/src/data/workspaceFirstSync.js\":\"f135205428ee0c0f\",\"/knowledge-medium/pr-preview/pr-1925/src/data/workspaceIdNamespace.js\":\"9bcb4a2cda6cfd45\",\"/knowledge-medium/pr-preview/pr-1925/src/data/workspaceSchema.js\":\"a4802e62550c81c7\",\"/knowledge-medium/pr-preview/pr-1925/src/data/workspaces.js\":\"d9874a41a0737715\",\"/knowledge-medium/pr-preview/pr-1925/src/data/writeAheadLog.js\":\"d910cabaa1aab0a6\",\"/knowledge-medium/pr-preview/pr-1925/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/BlockPasteShellDecorator.js\":\"e2962eca1e537152\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/atTrigger.js\":\"510020404d415a09\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/autocomplete.js\":\"5cfbd678c481b392\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/codeMirrorExtensions.js\":\"cf48dbd94133baf8\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/contentFlush.js\":\"779de09103ba9b0a\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/defaultInteractions.js\":\"38915eba2ddc8fc8\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/editSettleSignal.js\":\"a3617f99bd716357\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/insertImage.js\":\"7201e49c81a07374\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/referenceCompletionRange.js\":\"14b88efc33eba9b4\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/referenceTargetTypes.js\":\"ac2685acec229e2b\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/syntaxContext.js\":\"5b69892b696a06dd\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/triggerMatch.js\":\"79af08981025fa1f\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/AppRuntimeProvider.js\":\"29bde2a915c9f92e\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/BlockFocusShellDecorator.js\":\"1365ef344401971f\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/ExtensionRenderBoundary.js\":\"1342599a8302b3aa\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/PanelContentRecovery.js\":\"389136cdd2eda751\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/apiCatalog.js\":\"0cc29287fd98de9c\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/appRuntimeController.js\":\"1b74fe99413e143f\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/approveExtensionHere.js\":\"31584bb3c21800f4\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/armedCutAppMount.js\":\"a98da8c7850ebcb4\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/batchableKeyedStore.js\":\"c2c94c77697ff4a4\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/blockInteraction.js\":\"7ddfc7c6088e779b\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/blockSelectionAction.js\":\"ee5a5deaad55faa4\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/buildApprovalRecord.js\":\"8a133cd9d6f1e59b\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/compileExtensionModule.js\":\"04e7f94aba28a762\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/compiledModuleCache.js\":\"bf4a4b2fb8ebfdc0\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/continuousGestures.js\":\"db751337a582f6cc\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/core.js\":\"7f6cc89021777996\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/defaultRenderers.js\":\"de9a3a0b9777ed08\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/definitionFanoutAppMount.js\":\"28450ddae22f5ea9\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/dialogAppMount.js\":\"3e525693a074e9a4\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/dynamicExtensionSeeds.js\":\"355b957a9157c28e\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/dynamicExtensions.js\":\"a877cd1718f61e9b\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/exampleExtensions.js\":\"a2984b8707364400\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/extensionApprovalStatus.js\":\"d476713d85e2723e\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/extensionImportPolicy.js\":\"471d4886e8748bec\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/extensionLoadErrorToast.js\":\"a1e4865e873b17fa\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/extensionLoadErrors.js\":\"639fae5ff1eee35a\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/extensionLookup.js\":\"4f1ff06c27554455\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/extensionToggles.js\":\"821a145cce15e090\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/extensionUtilitiesCss.js\":\"681faa4282a7a8c3\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/kernelPageDeletionGuard.js\":\"eb2443eacb4d1e50\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/liveRuntime.js\":\"ac16c7635c6f40af\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/normalizeExtensionSource.js\":\"ebbaab541294b420\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/openExtensionsSettings.js\":\"34b3b2d27015c235\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/overridesCache.js\":\"53e2d54ef9bcb39e\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/pluginIds.js\":\"68c8c40d3f635f88\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/processorRejectionToast.js\":\"5b64212a14f99971\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/runtimeActions.js\":\"600c426d674866f5\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/runtimeContext.js\":\"f493eb522889e348\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/staticAppExtensions.js\":\"b959b812187c3b19\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/staticDataExtensions.js\":\"3d4091a1567143cb\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/toastAppMount.js\":\"e3d63a1f5454ab5c\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/transpileExtension.js\":\"4c380460341f5c3a\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/useOverrides.js\":\"49bc2a154ff023bd\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/useShortcutSurfaceActivations.js\":\"2499255b7f1b6275\",\"/knowledge-medium/pr-preview/pr-1925/src/facets/discoverToggleTree.js\":\"799b1a500b3f61b0\",\"/knowledge-medium/pr-preview/pr-1925/src/facets/facet.js\":\"0953eee5c100cf91\",\"/knowledge-medium/pr-preview/pr-1925/src/facets/resolveAppRuntime.js\":\"eca9bde75d996c17\",\"/knowledge-medium/pr-preview/pr-1925/src/facets/runtimeEvents.js\":\"83dd186600a2600c\",\"/knowledge-medium/pr-preview/pr-1925/src/facets/togglable.js\":\"831b4d7adf0f7a71\",\"/knowledge-medium/pr-preview/pr-1925/src/facets/variantFacet.js\":\"32313b303f9c4cf4\",\"/knowledge-medium/pr-preview/pr-1925/src/facets/verbFacet.js\":\"107e8f39bff41dc6\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/block.js\":\"a2c39a441b4e0922\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/focusedChild.js\":\"6af61d4df1af0fec\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/propertySchemas.js\":\"07b518f928a880e0\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/typeRegistry.js\":\"c6ff087df21c840e\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useAncestorCrumbs.js\":\"494f3ba5dcd98459\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useAutocompleteListbox.js\":\"9b11fbcf50d5451c\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useDebouncedSearch.js\":\"00f0e52cb95226b1\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useDebouncedValue.js\":\"f309c45fe3f0e5c1\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useFacetValue.js\":\"716ac6dca5cbe6bf\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useIsFocalRender.js\":\"8d902ebbda00613f\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useIsReadOnly.js\":\"b18662aa93cbb229\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useMaterializeBacklog.js\":\"73024e3f77f359c8\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useMinuteClock.js\":\"d4dd362891626219\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/usePanelLayoutProjection.js\":\"81b412126c8312f2\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/usePendingInvitations.js\":\"61d5c8e3016afd36\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useRendererRegistry.js\":\"17d7c0e21807ef27\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useRetainedFieldRows.js\":\"0291767348085a2f\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useWorkspaces.js\":\"9eeed2dec431eda4\",\"/knowledge-medium/pr-preview/pr-1925/src/lib/utils.js\":\"5241e92e9d9d8714\",\"/knowledge-medium/pr-preview/pr-1925/src/main.js\":\"7c2fc6fa3db42912\",\"/knowledge-medium/pr-preview/pr-1925/src/markdown/MarkdownImage.js\":\"55cad926ba4dd9d4\",\"/knowledge-medium/pr-preview/pr-1925/src/markdown/blockSeparators.js\":\"8ca18739f16bcd82\",\"/knowledge-medium/pr-preview/pr-1925/src/markdown/context.js\":\"600c345c7223b506\",\"/knowledge-medium/pr-preview/pr-1925/src/markdown/defaultMarkdownExtension.js\":\"94e2e73caef241de\",\"/knowledge-medium/pr-preview/pr-1925/src/markdown/extensions.js\":\"8b23512e00c9720b\",\"/knowledge-medium/pr-preview/pr-1925/src/markdown/renderMarkdownHtml.js\":\"26e8db2a763c0c23\",\"/knowledge-medium/pr-preview/pr-1925/src/minimal-editor.js\":\"8f98fd8b31fd5966\",\"/knowledge-medium/pr-preview/pr-1925/src/paste/armedCut.js\":\"55821808f2c6e08d\",\"/knowledge-medium/pr-preview/pr-1925/src/paste/captureMediaVerb.js\":\"0a916759e07dece8\",\"/knowledge-medium/pr-preview/pr-1925/src/paste/clipboard.js\":\"7dc80e8c58b796ed\",\"/knowledge-medium/pr-preview/pr-1925/src/paste/decision.js\":\"f137c24e2168e42c\",\"/knowledge-medium/pr-preview/pr-1925/src/paste/operations.js\":\"e5d7aebced109dc4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/account-header/AccountHeaderItem.js\":\"7331422818bb5662\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/account-header/index.js\":\"8b8b42249b8af386\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"f3bf982bd1a83cdb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/askAgent.js\":\"0a64b17b957e4748\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/askedStore.js\":\"fda6314737a5caeb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"30bb1e6861296cf3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/chipState.js\":\"007aed97f28ceb96\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/dataExtension.js\":\"65008a9fbbe2e3b3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/index.js\":\"23ea1a0afa468418\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"57994ecc75690ad5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/schema.js\":\"00ae5da19e9d13c8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/AgentTokensDialog.js\":\"385e7c97470c2abb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/BridgePairingDialog.js\":\"574e4a5e954517b9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/addMedia.js\":\"25cbc9f126809445\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/backlinks.js\":\"cd192a7c161862a6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/block.js\":\"64961c58c4d0cda3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/context.js\":\"202ca8ed080c01ae\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/displayIds.js\":\"2bc4797c6abde070\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/index.js\":\"9f5a67c0d7f6f921\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/outline.js\":\"cb590b39102e40d4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/properties.js\":\"e3a18530e1b3c8be\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/refs.js\":\"403aec2d65efd554\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"cc7256d5ae875b53\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/search.js\":\"255bd90dce0d630b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/shared.js\":\"62b15cf325253f0e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"ddc0190c9b47ed2d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/text.js\":\"af09ef1062a633e8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentWrites.js\":\"974db88cee1904b4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/authoringCatalog.js\":\"d7c718b2367aeeee\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/blockRefTargets.js\":\"1ea32444bf01c723\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/bridge.js\":\"6d7ea901adf62ee1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/bridgeLoop.js\":\"aa1ef2a1f77e9485\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/changeHistory.js\":\"982575c2c7c2a8ba\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/commands.js\":\"9392bb8d5fed51bb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/commentsCommands.js\":\"21e31e3cc63497a1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/dataExtension.js\":\"81029606d417340b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/dataModelGuide.js\":\"159106a191df1dee\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/dayPropertyInputs.js\":\"d4bf15e85b815590\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/describeRuntime.js\":\"607ec1ebe5f7cc39\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/extensionLint.js\":\"dcc0b6113852b040\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/grainAudit.js\":\"e970b829e53d359e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/healthCommand.js\":\"6145b5af363d263c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/index.js\":\"7d969f4a8422044f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/presetIdentity.js\":\"33a7d9d75edb5c67\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"9effab311762d61a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/readMedia.js\":\"fe8dc179b9e6f802\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/schema.js\":\"e78e3c969aabd9fc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/serialization.js\":\"1666d98e7cb1b770\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/targets.js\":\"b04f0ad67005a43f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/tokens.js\":\"1b7cf4304d009f5d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/watchEvents.js\":\"c55197f30fcee84b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/workspaceGuard.js\":\"599ff554aed43e15\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/writeCommands.js\":\"905e7d3ee65e7af3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/AliasCollisionToast.js\":\"a681a145fb351f95\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/DuplicateNameBanner.js\":\"49715af9f5902036\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/collisionMerge.js\":\"55a55cd5b92b8c98\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/dataExtension.js\":\"18eb7353e6957e50\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/index.js\":\"a0d9ead3287669b3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/mergeCollisionAction.js\":\"47ca6fbb1921b2a2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/pageStyling.js\":\"3e4716d2c949b9ff\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/rejectionToast.js\":\"15d7487c3bab42b5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/syncProcessor.js\":\"6312894ba04d7978\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/actions.js\":\"e23ebbb94b80e21e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/addComment.js\":\"ed35a07be1a5eadb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/anchor.js\":\"e84e5d08f209ce2b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/anchorState.js\":\"96819eea21db1fbf\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/commentLinks.js\":\"f6c65736032eab51\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/confirmThreadDeletion.js\":\"7cba72b00e685676\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/container.js\":\"e92beff5ad8fc501\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/dataExtension.js\":\"91e82c8941633741\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/deleteComment.js\":\"9c5e71e8602d6998\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/highlights.js\":\"fb53e2c99054ebf2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/index.js\":\"35d81512833a4ffe\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/linkedCommentsPill.js\":\"df5aca523d684dbc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/margin.js\":\"c07c49600f1457f1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/marginAnchorLinks.js\":\"3f0e575bf6df4a14\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/marginSchema.js\":\"17ccbf8baa446c50\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/newComment.js\":\"898a574bbd62c0b9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/ownThreadPicker.js\":\"065c02eba2f29d6a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/placement.js\":\"90a4aff7a02cdb5b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/queries.js\":\"69deab1e0143c936\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/quotePosition.js\":\"b74e0e9ded300f74\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/quotedIn.js\":\"4439b79aad609563\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/quotedRange.js\":\"e9db361008e1c556\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/rangeRefs.js\":\"8c00002df383c9f1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/readHighlights.js\":\"355c2d2ec818a4c7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/readSelection.js\":\"7f9cfc19ba257eb0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/readSelectionUi.js\":\"6a4e08376369f542\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/reanchor.js\":\"ec6ab7d900bdc24d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/schema.js\":\"74d1638f0a640956\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/scope.js\":\"97d22e8c4953ee79\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/scopeThreads.js\":\"0837f0b90a5ac89a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/splitRetarget.js\":\"d4cca614567d74d6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/suggestionCard.js\":\"e6e6ed82a1cbb4e6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/suggestions.js\":\"d361091aa66b3c2e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/summaries.js\":\"f0b4dfe1a1a99bd5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/summaryBatch.js\":\"7f661f4e36262027\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/surface.js\":\"4ed36673bc819535\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/threadNavigation.js\":\"7500679f4a507474\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/threads.js\":\"435b69c45cbba185\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/ui.js\":\"fb2463d6e150f337\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/uiStore.js\":\"a7c7223c42252aea\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/app-intents/appIntents.js\":\"b87b610985a85b6f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/app-intents/index.js\":\"51f7e4e700e920cc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/app-update-prompt/index.js\":\"5daa797f91a0d1b9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/app-update-prompt/status.js\":\"7f4cdcdb5301b857\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"80f0610ce345c95e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/MediaBlockRenderer.js\":\"376cfb7b1d2fd782\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/MediaDownLaneReplicator.js\":\"cd5530f14bf7667b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/MediaUploadReconciler.js\":\"1b222baa9b1e88c3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/assetDownLane.js\":\"b180102ef86efdd8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/assetResolver.js\":\"d17aa36543569b87\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/assetUpload.js\":\"5d9d50279d8efbc6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/attachmentCleanerIO.js\":\"bba49d2c871ae8e0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/audit/supabaseAuditIO.js\":\"813336bbead8adb1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/blobStore.js\":\"0208824e710c589c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/browserMedia.js\":\"072b0cd1d59c3474\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/byteStore.js\":\"010120c8adb70546\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/cleanerIO.js\":\"3e1b61cb85e13232\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/cleanupAttachments.js\":\"e18d129fbc694451\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/dataExtension.js\":\"d87b64c287c78270\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/downLane.js\":\"58b7a15350777cde\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/index.js\":\"bbaf9bb736b74785\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/insertImageContribution.js\":\"58e0c5c236f843d0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/laneArming.js\":\"e6e9c584025ea9c2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/laneLock.js\":\"6f41704ee5404394\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/mediaBlock.js\":\"8e06711739c4f6e0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/mediaCapture.js\":\"6d08f7643974a2cf\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/mediaLanes.js\":\"622987c5961aa3dc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/mediaViewers.js\":\"56acc558f7231287\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/mediaViewersFacet.js\":\"e1fdba8717533290\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/pasteCapture.js\":\"1edd3a1688e26c29\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/resolver.js\":\"0354323b13ca8cb0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/retryUploadsAction.js\":\"0171c82b76ab9d8c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/storagePaths.js\":\"b6aeb1d6f9524e3a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/uploadDrain.js\":\"bddf5d09929f42d0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/uploadLaneStatus.js\":\"5319309f73513c26\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/uploadReconcile.js\":\"f4a874c146ae25a5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/uploadRecovery.js\":\"aab66373fef7153a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/uploadStore.js\":\"c6170fea90074704\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/useAssetObjectUrl.js\":\"9a46e2706c9cd3ed\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"a48e3ffe94f7e465\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks-view/BacklinksViewSection.js\":\"e0b3f165015dda6e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks-view/facet.js\":\"c0b1f50a3114f604\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks-view/index.js\":\"77e3e62f5d3fe5b6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks-view/prop.js\":\"16ebf1e395080197\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/BacklinkFilters.js\":\"07a44dba69f8556a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"bd8232019e8d8616\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/BlockEntry.js\":\"6da38b0af9925a9b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/LinkedReferences.js\":\"be34d5a76c7d40bf\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"de5277249e3fde74\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/dailyNoteDefaults.js\":\"03fb79735197d853\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/dataExtension.js\":\"7ec4dc6ce181d3c2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/edgeExclusions.js\":\"c6f9ceeebbcb0359\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/filterProperty.js\":\"d8c18510ff165b71\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/index.js\":\"d7ec732317518120\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"e9c87ec0a4ca7fb8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/inline-counts/applies.js\":\"2388675d3941f98c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/inline-counts/countQuery.js\":\"b6573b2b6d098789\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/inline-counts/expansionStore.js\":\"6a0e9a0387d3af36\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/inline-counts/index.js\":\"ca91e0d227dd62b8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"9aba01ec13b0c04a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/presentationInvalidation.js\":\"6505df21ea7c2578\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/propertyEditorOverride.js\":\"34de688be554e1c3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/propertyFilter.js\":\"a7df57f7c9f995c7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/query.js\":\"e3c45273899e0161\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/resolveFilter.js\":\"0568f49dc2a6e8b9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/sourceBatch.js\":\"d2996b55c52382b2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/sources.js\":\"7331d76e3c12a0a8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/useBacklinks.js\":\"a144826fc0f4f752\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"aa57c04429bac3ae\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/birthday/BirthdayCelebration.js\":\"7c6ecbfa0ada3a61\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/birthday/BirthdayOverlay.js\":\"7da5d98cadbfdef9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/birthday/gate.js\":\"d5d9cad78c757bd5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/birthday/index.js\":\"8266cb8e16867869\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/birthday/wolfTheme.js\":\"f9681273d8239763\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-drag/BlockDragLayer.js\":\"12944755c11908b9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-drag/dragController.js\":\"ea28619f4b89c174\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-drag/dropTarget.js\":\"df10e32da053c11d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-drag/index.js\":\"033324c416b6b9b3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-drag/projection.js\":\"35f230f09d36163d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-info/BlockMetaCard.js\":\"dca93d7b96694574\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-info/index.js\":\"7cb252046deb31f5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/AddTagDialog.js\":\"fd0cce1020ec2f32\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"3598dea33828b5ee\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/TagNameIssueHint.js\":\"a83c8caf4952c8d0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/addTagAction.js\":\"b5e0298205c4b0b7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/appendTag.js\":\"381d7565b1e3f612\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/config.js\":\"42c74af808a48549\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/dataExtension.js\":\"4de0c76700f8a0a5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/index.js\":\"2f872359c0917815\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/propertyEditorOverride.js\":\"7f6afca83571d9d8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/breadcrumbs/BreadcrumbList.js\":\"9f21154e5c8dbab5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"bc185214527705ba\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/breadcrumbs/Breadcrumbs.js\":\"30832f1d56d5051f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"0ed125e0279d56b6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"e17b1e488401cbc2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/breadcrumbs/index.js\":\"d670465d0a67917e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"54e035cf8f538abc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/CharacterCountItem.js\":\"5622b0a2cdf15e0f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/ProfilePropertyEditor.js\":\"5ad59da1d52b1caa\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/actions.js\":\"9e4a6b578dfb5f75\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/blockType.js\":\"df8cccf154807c4f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/charCount.js\":\"1a516160f8a33650\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/dataExtension.js\":\"600b51c7a230e7e3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/index.js\":\"3b48b57172e3d24f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/profiles.js\":\"8be07cea4edc91f2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/properties.js\":\"aab7d0a874dd2b6a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/subtree.js\":\"7913dc70450d87bd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/textCounts.js\":\"9c5986d58c443f58\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/colemak-keybindings/index.js\":\"0ab342c84ab74dbf\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/command-palette/CommandPalette.js\":\"6eb960b2773377b6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/command-palette/HeaderItem.js\":\"0b12ad09d77e3e59\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/command-palette/context.js\":\"b671e4d2f777e2f0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/command-palette/index.js\":\"e80ab922c3b0cf98\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/command-palette/selection.js\":\"2986c0fa24f1c283\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/command-palette/toggleStore.js\":\"7f4bc3bab9eefa4e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/command-palette/useCommandPaletteActions.js\":\"cf2907feebb7c82b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/ContributorBadges.js\":\"8d9deb766890318d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/ProfilePicture.js\":\"843a582467816f81\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/author.js\":\"8590966e6943c3ed\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/codeMirrorExtensions.js\":\"68f44a900eb8cdf4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/dataExtension.js\":\"f919adeb359caa3f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/index.js\":\"3670829dbcf18180\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/mentionAutocomplete.js\":\"f09a7fa1d0bedc5f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/processor.js\":\"5b1caccbf4bd3dc1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/profiles.js\":\"c4d48c185e0bfeeb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/queries.js\":\"f4d82b0dce3392f1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/schema.js\":\"fdec34551a3ea8e3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/useCommentAuthor.js\":\"f4968afa34d923e9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"ec26babc1f1b88d4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/cursor-follows-scroll/followOrigin.js\":\"712a70bbd9c75cc9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/cursor-follows-scroll/index.js\":\"e16b98e7dcb938b8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"324fce58c3b1e9d6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"64ae4a07c7d0df50\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/CalendarGrid.js\":\"c91305b02e96b699\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/DailyNotePicker.js\":\"1eea9db941ee0c2a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"2f07a4d614899ef9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/DateNavDecorator.js\":\"f5ccd35ce125b9bd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/DateScrubOverlay.js\":\"9397e83daeae12f4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/DayPropertyControl.js\":\"fb4e8771599496e3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/DayValueReferenceControl.js\":\"4330d3e7946b0853\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/HeaderItem.js\":\"cb09c1d2220eae2d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/ReschedulePicker.js\":\"299cb40ef04af767\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/SpreadDatesDialog.js\":\"e537018edd9b2433\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/actions.js\":\"169089b856509053\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/blockDateAdapter.js\":\"118dcc575bff920c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/calendar.js\":\"28391bb777c79a62\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dailyNotes.js\":\"848b546b9ba9894b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dataExtension.js\":\"57a63910e2151974\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dateScrubActions.js\":\"286b2b618d09bb3c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dateScrubGesture.js\":\"5c0239079841022f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dateScrubGestureActions.js\":\"0addd08a233c9f9b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dateScrubRecognizer.js\":\"aeca44f20cdc9175\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dayProperty.js\":\"1194f6d465f1d0c1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"b0d6122a081e5792\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/deletionGuard.js\":\"4ad0895e730bbc31\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dueQuery.js\":\"6a175d6db61948f5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/index.js\":\"4f505b98d738d423\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/landing.js\":\"1ff66c83807617a6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/localSchema.js\":\"b3e9415e0c6da08b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/referenceDateAdapter.js\":\"f9db0ac9de0feb74\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/rescheduleAction.js\":\"dc8eae6ced220bac\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/schema.js\":\"bb6ac76f08648a24\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/spreadBlockDates.js\":\"03aeed2c00f7642b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/spreadDatesAction.js\":\"4f96458f9e49a068\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/today.js\":\"40f3f7dd2ab1f99e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"0489f5a260d11d69\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"b82286ca129bc56a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/audit.js\":\"93066a3e89212830\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/auditAction.js\":\"a09bb890b7fb77c3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/auditRanges.js\":\"ce9b3ecb7cd3007d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/diagnosticsSource.js\":\"762e66fe2fe6f64c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/divergenceScan.js\":\"e76d8db423ee2fc4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/index.js\":\"a114b7441b0645b8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/propertyChildrenChecks.js\":\"e4c092f5db2eac1e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/referencesMirror.js\":\"9e2b3a2061ebcf4b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/rowJson.js\":\"59cc70412c4e61d8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/schedule.js\":\"1ae50d987af916ea\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/store.js\":\"987ca5cf4b01c717\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-maintenance/action.js\":\"254052e7f0f01154\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-maintenance/index.js\":\"ac80df06d2de0d58\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-maintenance/plugin.js\":\"c844bfebc079f5b6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"a8a7ecccbab43782\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/actions.js\":\"b1e86f29eda87445\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/changeMarker.js\":\"4ca2f2accf5a9d43\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/diagnostics.js\":\"7c0995a352702832\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/fileSystemAccess.js\":\"4e780202bf1503d2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/filenames.js\":\"8f2c347510662963\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/index.js\":\"10a4b9db93e3f70f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/mirror.js\":\"15f9b0e10cc3a6f8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/runLock.js\":\"545b0fc185c97a1f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/runtimeHealth.js\":\"6c0f5a07f2c5d8d4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/schedule.js\":\"3cac853bfdb68f7b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/store.js\":\"550d8de2c7b916fe\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/default-themes/index.js\":\"c0e124759c52bb19\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/default-themes/themes.js\":\"bc2d0eb760f5fc5f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/diagnostics/facet.js\":\"e8173e8dc9f8e94a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/diagnostics/useDiagnostics.js\":\"3e3436db76495788\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extension-prompts/dismissals.js\":\"7511165ed585aa7b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extension-prompts/index.js\":\"1afae7672a3bcb86\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extension-prompts/status.js\":\"8d2e9f33eb680b05\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extension-prompts/store.js\":\"b62717157925537b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"f2a25c5d7b6e5c92\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/ExtensionsSettings.js\":\"6c0a28b39e99cb36\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/actions.js\":\"98d192531ba7c671\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/config.js\":\"afdf3726b86d02ca\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/dataExtension.js\":\"a6738eb965dfc137\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/effect.js\":\"b21222ff1de9c23b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/index.js\":\"57cef9592f8676b9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/propertyEditorOverride.js\":\"82c0f195a9b77d6f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/useToggleTree.js\":\"bbe2aba990e5bf00\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extract-type/ExtractTypeDialog.js\":\"f394de7601b501d0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"618a529f442adc7a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extract-type/PropertyShapePicker.js\":\"b59ccac3f8618aaf\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extract-type/action.js\":\"72b593d15c11a461\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extract-type/index.js\":\"dcfed53756805e88\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/find-replace/FindReplaceDialog.js\":\"59711a91d0aadd0f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/find-replace/HeaderItem.js\":\"0b9418f69b721f11\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/find-replace/dataExtension.js\":\"fa7859bb73eeddb8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/find-replace/index.js\":\"71c41ee7a036ac5c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/find-replace/search.js\":\"c0c222b2d9bd8a60\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/find-replace/toggleStore.js\":\"b8b9b392da2ece05\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/LocationPropertyEditor.js\":\"36bb300ae62c0751\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/MapView.js\":\"8493828d1522baf8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/blockTypes.js\":\"40e045e357a756b7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/codeMirrorExtensions.js\":\"bbbbd1e0a199d6e1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/createOrFindPlace.js\":\"b3ab17a07e30cddd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/currentLocation.js\":\"63573ebc98e60d66\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/dataExtension.js\":\"0d556833209e2670\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/geoContentDecorator.js\":\"44a04b1a9c5d1c4b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/googlePlacesClient.js\":\"f5a1db8ee59a2970\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/index.js\":\"dfd958ae887bd39d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/locationsPage.js\":\"7356ad972cc23bbd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/mapViewport.js\":\"6d4cfb7c682a432f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/pickCurrentLocation.js\":\"d1c8b3ace5d3953b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/placeAutocomplete.js\":\"f9eb5740014aad19\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/placeNameCollision.js\":\"b873c09d91f8f8c9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/properties.js\":\"6f53d5ef489c8efc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/propertyEditorOverrides.js\":\"649a7f864e410f4d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/query.js\":\"0e63781cbdbbbd1d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/usePlaceSearch.js\":\"ce3a45836e9d8a88\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"53af7a165c0a21dd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"5d8f920abf5f0018\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"ada2f76490d2bf99\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/config.js\":\"939856d707496c0e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/dataExtension.js\":\"098be509a01076dc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/facet.js\":\"e49a865f04efcda6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/grouping.js\":\"f6899ce17749cf75\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/index.js\":\"6382ec269e6dbe0a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"91ff4bebb330dcf5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/query.js\":\"43de315623ce3c7d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/resolveConfig.js\":\"e1a5a91e4bec06f7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"359213eb43bd4a3c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"e140244d348606ce\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/HtmlDocumentContent.js\":\"740f260b459d88a3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/HtmlFrame.js\":\"419cfbc75f9c7965\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/actions.js\":\"c174e8b4a3665992\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/blockType.js\":\"09f44fa693ade49e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/confirmRunScripts.js\":\"245f856429f13847\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/dataExtension.js\":\"750366d50f3fabc9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/frameAnnotations.js\":\"33a3f0428322ba2b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/frameDocument.js\":\"2d7e7e8f659945e4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/frameTheme.js\":\"ebf59fbbfad44117\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/index.js\":\"12e2749fab2e39d3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/scriptConsent.js\":\"f69f009e758b10c8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/sourceMap.js\":\"2c9c25e082fea7b3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/useDocumentScripts.js\":\"798e26969bbbc980\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/interaction-metrics/index.js\":\"4931325c4d3e193c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/interaction-metrics/record.js\":\"908fae23ce822e14\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/interaction-metrics/recordStore.js\":\"f025cd1c2e3d1f71\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/interaction-metrics/responsiveness.js\":\"71b362d13bd45165\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/interaction-metrics/schedule.js\":\"3cf98f175ba0e34a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/interaction-metrics/sessionContext.js\":\"971d84e4d59fdb95\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"aae924e8ee92476d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"994bc7d41c10bb7e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/actions.js\":\"50e3069b8d7e5069\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/config.js\":\"604e337bf8a6f443\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/dataExtension.js\":\"0bc74911d3a01568\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/effect.js\":\"a2d1f872e3b0e20e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/index.js\":\"6780aa1ce9be9223\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/keyCapture.js\":\"2920897fb303c1a0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/overrideStore.js\":\"b50e6e6f8460164e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"13d972c223771377\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/left-sidebar/HeaderItem.js\":\"69b60c50ca3d5f14\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/left-sidebar/LeftSidebar.js\":\"9f8e28eab3e7ae46\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/left-sidebar/actions.js\":\"d499be5b9576a2a4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/left-sidebar/facet.js\":\"9ef179eb1c95cc95\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/left-sidebar/index.js\":\"d7f4dd961fbabc6c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/left-sidebar/shortcuts.js\":\"4cdf8f63c3f458c6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/left-sidebar/toggleStore.js\":\"aa5564e58e64f5fd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/merge-blocks/MergePicker.js\":\"b984cde368531b5d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/merge-blocks/index.js\":\"8288e3330684f14b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/merge-blocks/mergeAction.js\":\"27222fd838ef5931\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/merge-blocks/strategy.js\":\"4af83ce11e7f8be2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-bottom-nav/Button.js\":\"35a723fb2a544d63\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"3fca486b35838524\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-bottom-nav/defaultItems.js\":\"15935818672f95ce\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-bottom-nav/facet.js\":\"2e0bd7a38d036ed0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-bottom-nav/index.js\":\"8c207edca2ecdc44\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"acc5c69ef613e13f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-keyboard-toolbar/actions.js\":\"da4baefa75700cf5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"a008a9dff260abdb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-keyboard-toolbar/facet.js\":\"d0bfc785e30f7ab9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-keyboard-toolbar/index.js\":\"5f65641f8b8ae56b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/move-blocks/MoveDestinationPicker.js\":\"40ab7781c27f2ad2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/move-blocks/blockSubtreeMembership.js\":\"72ef07c3f9abe067\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/move-blocks/contextMenuItem.js\":\"f0f5966e2f7a4db3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/move-blocks/index.js\":\"757d6fb1971021c3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/move-blocks/moveAction.js\":\"9d1e768415492833\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/move-blocks/moveBlocks.js\":\"9d36bd7d4e2ba679\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/move-blocks/selectionAfterMove.js\":\"7d0d9d918d1c5a58\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/TutorialBanner.js\":\"05b293a1e4f6a560\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/action.js\":\"b30629be92f40168\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/bannerDismissal.js\":\"8552a6f1d1233b56\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/documents/cheatSheet.js\":\"46c31e94b0f130b4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/index.js\":\"479a467a369ed301\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/keys.js\":\"c084530d912209fa\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/landing.js\":\"63ba669e7602478d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/outline.js\":\"22e2aafb0e2ff9c7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/seed.js\":\"150784956b2214f4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/PerfTrendDialog.js\":\"3823ece7fdbc21e9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/analyze.js\":\"dfbf90cbef982230\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/diagnosticsSource.js\":\"84cfaf9a7411223a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/index.js\":\"7feb96c0930bf60d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/load.js\":\"3a80384f15a2c6b5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/monitorRun.js\":\"8d39058618c4c30d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/schedule.js\":\"017f812d53ab8c6c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/series.js\":\"3f1498b1d7207821\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/store.js\":\"9806b94925a280a6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/trendAction.js\":\"6b53900c9eaf9d91\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/verdict.js\":\"10e129b6570e6aa9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/plain-outliner/clickToEditAction.js\":\"343dd3666c022d5c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/plain-outliner/index.js\":\"1e85e130ffa11b63\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/plain-outliner/interactions.js\":\"526a8e06ff4ba204\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"7a2a833939e1fdc1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/MigrationGate.js\":\"7267c23658f13922\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/MigrationGateDialog.js\":\"2bf4deb3919f40e2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/action.js\":\"858053578e1a62bb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/index.js\":\"ad64d8ce1f2d0eaa\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/localRunMessage.js\":\"9d2c291fa5ad77a5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/plugin.js\":\"b182eac56d36ef89\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/progressReport.js\":\"c7ffcc52f2c3586c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/sweepProgress.js\":\"d7a751cb9e6f8292\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/FieldRowRenderer.js\":\"73fe6fa60c3e196f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/ValueRowRenderer.js\":\"b5b3105bc161a99a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/actions.js\":\"5cb2ce8a9f2a7a92\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/autocomplete.js\":\"dbdc021495f02ada\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/fieldRow.js\":\"25fe0af7853eb877\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/index.js\":\"d8824a2f02dce8b8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/referenceWarning.js\":\"666c7b2c9167a771\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/valueAutocomplete.js\":\"22d95ebf7292d96e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/valueSchema.js\":\"8c147fa04a3c2ab5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/quick-find/HeaderItem.js\":\"f3c2238dc4c778a4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/quick-find/QuickFind.js\":\"0747e58a89e6e305\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/quick-find/index.js\":\"53c5ad086fc690f0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/quick-find/recents.js\":\"edb30a3cef5a0553\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/quick-find/resultItems.js\":\"56de2530f8bc55fc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/quick-find/selection.js\":\"0b1ea7d9c6f912ca\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/quick-find/toggleStore.js\":\"d331a653edf5d4d2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/recents/HeaderItem.js\":\"1bf2d84552ba0a28\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/recents/RecentsPageBlockRenderer.js\":\"196813c53e0092cd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/recents/grouping.js\":\"a3980ba98bb9e3a7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/recents/index.js\":\"eca9972f5bc6211a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/recents/target.js\":\"35df93eba2a1a158\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/codeMirrorExtensions.js\":\"f712d2242f7307d5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/contentPrefill.js\":\"21d0370a210ff375\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/dataExtension.js\":\"aaf5fb2a7ce1104a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/index.js\":\"9a2949045590e685\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"f9033e526bfe0a92\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/invalidation.js\":\"60980f2accacab63\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/localSchema.js\":\"c5c4ca633260ff62\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/blockrefs/index.js\":\"de37782d2b8775b3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"41669536eb97683c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/index.js\":\"c3b5b59f591a6dbc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/referenceNode.js\":\"79be403bbafe2be9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/remark-reference-occurrences.js\":\"ffbf051239fda8e9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"4d93929f441ed8c6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/wikilinks/index.js\":\"1a2150433da57878\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"7cb8fb8432e99bd9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"b0c4f343ae29b86f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/mergeRetargetProcessor.js\":\"bd0c9da89ebf66f0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/parseFence.js\":\"35f3c13a8425fae0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/referenceParser.js\":\"a79b609573f9ece7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/referenceProjection.js\":\"9c8966d450a6138f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/referencesProcessor.js\":\"be4c5f93f1b0f084\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/renameProcessor.js\":\"7c93a5c69132fed8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/spanReplacement.js\":\"7e1c568d7f11199b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/rich-paste/htmlToOutline.js\":\"6f7858172d18fada\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/rich-paste/index.js\":\"16eeb6abb9720c7e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/rich-paste/normalizeClipboardDom.js\":\"804a13babfbbd8c8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/rich-paste/pasteDecision.js\":\"ceb932a3c575cbf4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/action.js\":\"80e549c06ee26f1b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/blockIds.js\":\"c52f702a589f254b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/content.js\":\"f94d1b401c5b2bed\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/effect.js\":\"8f9d8c44aae17d52\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/ids.js\":\"38a1166cd6099a30\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/import.js\":\"59b985b5ff19a640\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/index.js\":\"6f7c95bed285e9ad\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/plan.js\":\"e73fcd2f58020de2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/plugin.js\":\"59f202f810faf9fe\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/promotion.js\":\"df1844e5a1879140\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/properties.js\":\"11adeb87357d5814\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/references.js\":\"1da82ef498cc9c01\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/report.js\":\"7346cee3dfde2d60\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/roamMemo.js\":\"a792dfa8d0804292\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/runtime.js\":\"5ff82324b7443ef4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/schemaReconciliation.js\":\"fab033a63c8ad92f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/srsMarkers.js\":\"615633234a7a0d57\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/todo.js\":\"9bbcce61b7d593d8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/typeCandidates.js\":\"860da79877ff4cb5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/types.js\":\"17f991ff40bf1229\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/search-health/index.js\":\"169cb2c486268e1a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/search-health/store.js\":\"bf02c0ef14a54cdc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/shortcut-help/HeaderItem.js\":\"51820ea564cad70f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"e69c39a834f8627d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/shortcut-help/index.js\":\"3f2cda91921747ba\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/shortcut-help/model.js\":\"6012c18c4c866434\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/shortcut-help/toggleStore.js\":\"6ddd2cd04f7ae7d6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/shortcut-help/useKeyInspector.js\":\"34eeb4d888ade7c6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"ee4d3233d34d40f7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/spatial-navigation/ShellDecorator.js\":\"2911acc43decd436\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/spatial-navigation/actions.js\":\"474c2fde7f510dab\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/spatial-navigation/exclusionsFacet.js\":\"17d0509c4c7a6cad\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/spatial-navigation/index.js\":\"7ce4d8bd3616987a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/spatial-navigation/shell.js\":\"6222f1e35ef78a26\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/spatial-navigation/surface.js\":\"9ba4161d3c6f4172\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/spatial-navigation/walker.js\":\"02aed1b20fae55f9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/RescheduleToast.js\":\"653e5c87a21c1507\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/dataExtension.js\":\"2e73762cb7de6c7e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/index.js\":\"db93b94c45533186\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/indicator.js\":\"541258334aca3819\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/moveSrsState.js\":\"c178830187268c57\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"1a40c118dcdbda4c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/scheduler.js\":\"32b843afb34413d8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/schema.js\":\"148af314a94f8654\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"65690abe66de807e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/srsClipboard.js\":\"f9621d9d582bb4b8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"225e763fe2e902f8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/DailyNoteReviewHint.js\":\"1d4a601c0a8feeb5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/DeckPicker.js\":\"b76dac7c7dc82cc5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/ReviewControls.js\":\"f283065c52da967e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/ReviewDeckRenderer.js\":\"3881feb3ad330957\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/ReviewSession.js\":\"285f06184793180c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/actions.js\":\"c76d3375f66312d1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/archive.js\":\"667e06eb5c43aa6b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/dataExtension.js\":\"1c9974c60f038a1c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/deck.js\":\"ca7fb10156d47f43\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/dueQuery.js\":\"dfbec17b6ca82ea4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/gradeDecision.js\":\"5990421067c2521e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/index.js\":\"389349d89606add6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/keyHints.js\":\"cec5303a71d8f0d1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/reviewCardLayout.js\":\"e1e4112d1d873b9f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/reviewProgress.js\":\"cfd78a482d4bba11\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/schema.js\":\"27e48a20e9d93eb0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/useDueCards.js\":\"de257936646035d5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/startup-metrics/index.js\":\"146f0adfe703624b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/startup-metrics/record.js\":\"cd3c585d7d532a56\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/storage-persistence/index.js\":\"0f9f60739795193e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/storage-persistence/persistenceStatus.js\":\"48a19a6bc37d020b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/storage-persistence/requestAction.js\":\"23bb8f1857d261fe\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/supertags/TypeChipsDecorator.js\":\"66e5da8fb8d7da35\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/supertags/codeMirrorExtensions.js\":\"e529a0d0ef134ffe\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/supertags/index.js\":\"52cee846f69da4dd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/supertags/typeAutocomplete.js\":\"97f7f3a01790ef15\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"55d1db9549e2094e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/swipe-quick-actions/actions.js\":\"c477402cad2172b6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/swipe-quick-actions/anchor.js\":\"d8970d5001483d53\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/swipe-quick-actions/events.js\":\"848166fa40695e65\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/swipe-quick-actions/gestureActions.js\":\"f354747c854473b1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/swipe-quick-actions/index.js\":\"ed0c6fafae10f1ef\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"539b8911af2269a6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/sync-metrics/collect.js\":\"7373e180aff58d91\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/sync-metrics/index.js\":\"206bf8f04d7ac9db\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/sync-metrics/record.js\":\"979bb08bfb92e42b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/system-status/RejectionDialog.js\":\"26d81106c765414e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/system-status/SystemStatusHeaderItem.js\":\"37fee534e060e423\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/system-status/index.js\":\"83117535832181e8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/system-status/model.js\":\"93deaa8eb5bd0f48\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/system-status/queueCounts.js\":\"9a3ad8a137e05a44\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/system-status/rejectedHelpers.js\":\"cca9c2f0497f5d0d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/system-status/rematerializeAction.js\":\"de0571905a6198bc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/system-status/useHysteresis.js\":\"efc38ab020ec0eb4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/ColumnHeaders.js\":\"b23472432a577128\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/QueryUi.js\":\"d92a6deb51c31177\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/TableLayout.js\":\"3e976b13e0a358af\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/actions.js\":\"9634680895b8aa30\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/cellEdits.js\":\"640e63563c530348\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/childrenViews.js\":\"e42dc29708a1d68a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/columns.js\":\"42146a41c3129b95\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/controller.js\":\"aef6bf2918655730\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/convert.js\":\"9beb6811c0b47360\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/dataExtension.js\":\"b26f5ad6803526ac\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/index.js\":\"f44e169857a80c86\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/keys.js\":\"b66d69750735b89a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/model.js\":\"f45e14502fe9639b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/query/QueryText.js\":\"3e49becc22aa8014\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/query/backfill.js\":\"94fce437b3aeea3e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/query/completion.js\":\"d1754397644cff9a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/query/format.js\":\"12b71061862d8c19\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/query/parse.js\":\"148908465c8b24b2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/query/queryValue.js\":\"7a09366094596277\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/query/registrations.js\":\"e5abf9d4e58dc263\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/query/source.js\":\"156556dc9a496ec6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/registry.js\":\"60fc2d7d9125e298\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/rowGutter.js\":\"8e0120bbabef600e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/rowVerbs.js\":\"7f49464f4009e3c4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/schema.js\":\"c63edce659d0939c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/sort.js\":\"9e8d4220f4acda4c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/theme-toggle/effect.js\":\"636916d37d5e1438\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/theme-toggle/index.js\":\"c7baa4577ebef760\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/theme-toggle/theme.js\":\"3ce79d3a0e7cbc36\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/todo/actions.js\":\"32b144aec60f4712\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/todo/dataExtension.js\":\"536029748d7fb5ac\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/todo/index.js\":\"e1bf77261eebaa06\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/todo/schema.js\":\"01784a9ee127ef92\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/touch-selection/TouchSelectionLayer.js\":\"64f20adf2afcd5e5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/touch-selection/actions.js\":\"5583a5d996b14db3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/touch-selection/defaultItems.js\":\"509a25d0df927a33\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/touch-selection/facet.js\":\"15c9668c596766c7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/touch-selection/holdRecognizer.js\":\"edc1f70921b66881\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/touch-selection/index.js\":\"ad60fb0b1b74b4c5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/update-indicator/UpdateIndicator.js\":\"3d561539907773a4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/update-indicator/index.js\":\"feeba4eda353faa6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/update-indicator/loadTimes.js\":\"e4e016a8ca428686\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/VideoNotesRenderer.js\":\"2173346f698eb3f4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/VideoPlayerRenderer.js\":\"fb80b353adc6d27d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/VideoTimeStamp.js\":\"ccf686b77a3a563b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/actions.js\":\"27e0a93a3ab347d2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/index.js\":\"9085dabd7b19860d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/markdown.js\":\"cc1c38d4c61cc1a3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/notes.js\":\"d9eb5c337c53c793\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/registry.js\":\"5fd55acf139b9d0f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/remark-timestamps.js\":\"8045cd76c48002ef\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/view.js\":\"f5772b651cb67495\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/vim-link-hints/LinkHints.js\":\"68a9d1ae7d3e67ed\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/vim-link-hints/index.js\":\"f6d2ecee1aae682a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/vim-link-hints/model.js\":\"99fc3664f297920c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/vim-link-hints/settings.js\":\"06ff797707836f60\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/vim-normal-mode/actions.js\":\"0a2096f3707f3aa2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/vim-normal-mode/index.js\":\"416e4338f8cb9a71\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/vim-normal-mode/interactions.js\":\"71f00063cc28ceed\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/workspace-header/index.js\":\"e14a6ac9f75c5f9b\",\"/knowledge-medium/pr-preview/pr-1925/src/registerServiceWorker.js\":\"82616a135ce697d3\",\"/knowledge-medium/pr-preview/pr-1925/src/requestPersistentStorage.js\":\"0721778112c12741\",\"/knowledge-medium/pr-preview/pr-1925/src/services/authRequestDeadline.js\":\"a9ef14f70d1a4548\",\"/knowledge-medium/pr-preview/pr-1925/src/services/authStorage.js\":\"fc6248a603fd9213\",\"/knowledge-medium/pr-preview/pr-1925/src/services/powersync.js\":\"fe2eed881b394fbf\",\"/knowledge-medium/pr-preview/pr-1925/src/services/supabase.js\":\"6bbb6d96381ebac0\",\"/knowledge-medium/pr-preview/pr-1925/src/services/uploadErrorClassifier.js\":\"9af820ed8c8a5caf\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/ActiveContexts.js\":\"e2912ecddcaac8b9\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/HotkeyReconciler.js\":\"7569561b5a89728b\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/WipeLocalDataDialog.js\":\"0efcd5a51cda62a6\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/actionDispatch.js\":\"6e62680d9512ea45\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/actionKeyHints.js\":\"bf561b942bdeecf7\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/actionRefItems.js\":\"6c266e9d7d451152\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/applyKeybindingOverrides.js\":\"f9fcadba51e34baf\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/blockActions.js\":\"3c5e42978a7af84a\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/blockMergeGesture.js\":\"4c90907a96010846\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/canonicalizeChord.js\":\"cd19eb7a567e70de\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/defaultContexts.js\":\"b45ad052dc102462\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/defaultShortcuts.js\":\"1633f2ab188fdfd8\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/effectiveActions.js\":\"4f1ec1d1c8a2d3ac\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/formatChord.js\":\"06d8b140266257a2\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/gestureAction.js\":\"c3c37a18115028ba\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/gestureBinding.js\":\"bffcc670b3e7af4b\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/holdRegistry.js\":\"b4d308db8914c166\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/keybindingConflicts.js\":\"cfaa8d5ec9e73b5e\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/keybindingOverrides.js\":\"a6152cacea53ac00\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/pointerAction.js\":\"900310149a3922d7\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/resolve.js\":\"9f04aac8f1dfcaa7\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/runAction.js\":\"a1e3c4da2e36f92c\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/sequenceMatcher.js\":\"9ab543cf95a32e1f\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/types.js\":\"921a1bb0fe702027\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/useActionContext.js\":\"545432f1920ad2ba\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/useActionDiscovery.js\":\"8c6be99e54391420\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/utils.js\":\"b3034df06da64913\",\"/knowledge-medium/pr-preview/pr-1925/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1925/src/sw/bootStore.js\":\"2495021b4be2ef91\",\"/knowledge-medium/pr-preview/pr-1925/src/sw/previewDatabases.js\":\"20a5cf1d5caed245\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/byteTransform.js\":\"79ad13a0e75980f3\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/attachmentCleaner.js\":\"c458a3d425ceb3d4\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/bundle/attachmentParts.js\":\"c75d447d14f3def2\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/bundle/bundleParts.js\":\"698b42fa660f4606\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/bundle/bundleRecord.js\":\"c0c090ae36968f71\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/bundle/manifest.js\":\"98fb9da1b8ab0cb8\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/bundle/takeBundle.js\":\"0d221462c18b656b\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/bundle/verifyBundle.js\":\"ced4f76534d51807\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/cleaningStage.js\":\"3d2c8efa90b80a5c\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/conversionKey.js\":\"145dcdcec02642db\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/conversionServer.js\":\"6d93dfd56995d482\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/flip.js\":\"e58fa02f03f2c355\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/flipAttempts.js\":\"678d103592eb0459\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/pages.js\":\"e414e16f6daa0135\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/preflight.js\":\"1b9e11bf76ec1f70\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/reseal.js\":\"5b6a208a4c29ebe4\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/runConversion.js\":\"25e7727b4645ef42\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/runLock.js\":\"fdad281880b55dab\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/sealing.js\":\"5835d1ce79501271\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/sealingStage.js\":\"5dc15eee69c6bb72\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/stage.js\":\"85cec734a9d41f84\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/verifyReseal.js\":\"4eec9d973b113971\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/aad.js\":\"98b95b4a9a670a52\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/aead.js\":\"2fb13a7802b1ff24\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/base32.js\":\"cea2c90d93fac989\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/base64url.js\":\"2c16d853f3311eb9\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/binaryEnvelope.js\":\"22c178f181d12772\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/byteAead.js\":\"13f60284db049f00\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/canary.js\":\"cc19a474f4461fa2\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/contentHash.js\":\"c46dfffc1e0528a2\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/contentKey.js\":\"e0b1920528d307fb\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/derivedIdNamespace.js\":\"103c0a2d0db8ba09\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/envelope.js\":\"ef9103b241155d65\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/hex.js\":\"3807693446b34eee\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/sha256Hex.js\":\"a64e2474cbc140ef\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/workspaceKey.js\":\"9c50d058a3eec3a3\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/conversionState.js\":\"6c1797ea7366b06f\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/flows/createEncryptedWorkspace.js\":\"2749bd680e5dc97f\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/flows/pastedKey.js\":\"3972f2fbccc325ea\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"383611eafd1ca87a\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/flows/upgradeWorkspacePin.js\":\"5ad9780a3a388eed\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/keyStore.js\":\"3bd20ac03caef6b6\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/mintWorkspaceKey.js\":\"d66cc6ac22e38ebd\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/modePin.js\":\"0d2b3eb9f3c2899e\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/openWorkspaceKeys.js\":\"91ee9fc8d9483e70\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/resolveWorkspaceEntry.js\":\"1d7aa039fd2d1d75\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/resolver.js\":\"b2331529a41a7f12\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/workspaceAccess.js\":\"653d0a2ae4b2dc02\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/transform.js\":\"33ba124ed304eb28\",\"/knowledge-medium/pr-preview/pr-1925/src/themeBootDefaults.js\":\"5d2a76b3c36aff31\",\"/knowledge-medium/pr-preview/pr-1925/src/types.js\":\"a1b8ea760d64fd47\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/ClientLocalSettings.js\":\"136b8bb854d214f7\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/abortableSleep.js\":\"89eb65fbe7499aa2\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/array.js\":\"c8c459ee83cfc0f7\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/backlinkAutocomplete.js\":\"281c9d5914d16c3c\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/blockCrumbs.js\":\"d0701809d08b87a5\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/blockrefAutocomplete.js\":\"93adb5bf0fe0e6bf\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/cadencedIdleJob.js\":\"a194e1b8f1871a3f\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/callbackSet.js\":\"0d338b9dd9ea531a\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/clientId.js\":\"fa3b906ab4507afa\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/codemirror.js\":\"711fbff62e9e1385\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/codemirrorCompletion.js\":\"811fc0cc39e3507d\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/copy.js\":\"885424330c6a9323\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/dailyPage.js\":\"dde9f72add18fec2\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/dbForensics.js\":\"68a60df6e7a286c9\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/dbForensicsHooks.js\":\"c43b69823a536f5a\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/deleteBlockThroughUi.js\":\"62072572165c5cb1\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/dialogs.js\":\"80807ad932660c25\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/dom.js\":\"12559a14d48febb0\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/downloadBlob.js\":\"ddcb9dda4d761fc8\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/drawnWalk.js\":\"373465e060568989\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/exportSqliteDb.js\":\"aa7b006031898525\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/fileSystemAccess.js\":\"36a99e08d1e1f013\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/flipSlide.js\":\"543f577fd2a1c8e8\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/fnv1a.js\":\"47839ca5551df03b\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/formatBytes.js\":\"93d7eb14976ab49d\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/fuzzyRank.js\":\"941420b30e370fad\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/idbKeyedStore.js\":\"9d3e5b5e9d29adde\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/idleCallbackPolyfill.js\":\"892824ff4458b13c\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/keyboardAwareScroll.js\":\"f537952cfdd658d0\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/keyboardViewport.js\":\"4deb46f887c7296e\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/lastWorkspace.js\":\"db6c03f05ab82b45\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/layoutColumns.js\":\"04c8b55338e6742a\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/layoutSessionDom.js\":\"f39e97e5768216be\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/layoutSessionId.js\":\"49f0388fd89dd5b8\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/linkClickGestures.js\":\"db8de7953605f7d7\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/linkTargetAutocomplete.js\":\"f94c974a526e10c0\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/localDbCorruption.js\":\"a63f68c5bfeb4bda\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/localDbRecovery.js\":\"e0861126bd853f9a\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/markdownParser.js\":\"549a72d19d207623\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/memoize.js\":\"7bed4b6019f4e671\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/nameFieldCommit.js\":\"d2fa489c2edc7da6\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/nameList.js\":\"7bc9c4974277ce35\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/navigation.js\":\"6b7a9916ed288e29\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/omnilinerNamespace.js\":\"407921e15d443c2e\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/opfsPageScan.js\":\"1926826e5bc6d649\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/panelClearance.js\":\"48f12e12732f1294\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/panelHistory.js\":\"b4c747a798476128\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/panelLanes.js\":\"24d586cb9bec6c7d\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/panelLayoutProjection.js\":\"a4f015a3ea393e9b\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/panelScrollAnchor.js\":\"892298860c1f0368\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/panelUrlFlags.js\":\"7d59d795e7abf449\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/platform.js\":\"119077a5367d7b21\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/pluralize.js\":\"e832465c0ae25341\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/propertyCreation.js\":\"149092fa4e7afa77\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/propertyNavigation.js\":\"8a0a5958f638a6d1\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/propertyValueContext.js\":\"144babefd94ca8e9\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/react.js\":\"bab7e3c6e68bd690\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/relativeDate.js\":\"e329171af3d1beca\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/relativeTime.js\":\"4129540b1d576b04\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/renderScope.js\":\"03b49e5fda948993\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/resolvedThenable.js\":\"c5aa49c7c34e475e\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/routing.js\":\"7a4e2697df27f944\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/safeMode.js\":\"6320994b5d4633a4\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/scheduleIdle.js\":\"57d3781c6b0de1d8\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/screenWakeLock.js\":\"a61b2564f6c9b4fd\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/selection.js\":\"8827a7fefe0c0fdb\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/softKeyboardGrab.js\":\"18dcf0a3a3a578b7\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/startupTimeline.js\":\"1dad3134070fc510\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/state.js\":\"910cb8ad68ac4ed9\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/string.js\":\"f22059122430d4e9\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/surfaceZoom.js\":\"1292b7183a0d28e8\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/time.js\":\"680f4f43b61a94eb\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/toast.js\":\"a697fc4d1bda848b\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/toggleStore.js\":\"3c4b0495a0dc386c\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/untilStopped.js\":\"0e42dbc92898f1f2\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/userActivity.js\":\"c2c7e44a4d060a5a\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/viewTransition.js\":\"d075c2fc3311f708\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/viewport.js\":\"4486ace0a9ea455e\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/webLock.js\":\"83bece061b370200\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/workspaceRecovery.js\":\"b3b378dc0e4eae6e\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/workspaceSnapshotStore.js\":\"50db3824e2d38e86\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-compiler-runtime.js\":\"2c2c27da72ebcffc\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-dom-client.js\":\"ad1a0dd1346b4c6c\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-dom-server-edge.js\":\"2a43befd2d0addcc\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-dom-server.js\":\"c301fee8f726e1f0\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-dom-static-edge.js\":\"50fb78cda7f6a7f7\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-dom-static.js\":\"84b26b8266b9bff6\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-dom-test-utils.js\":\"95ec5e2f0e1b895a\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-dom.js\":\"ea690a5ab783f799\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-jsx-runtime.js\":\"e596476623b20496\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react.js\":\"84b64559315ce5af\",\"/knowledge-medium/pr-preview/pr-1925/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1925/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1925/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
	}, {
		caches,
		fetch,
		origin: self.location.origin,
		now: () => Date.now(),
		storage: navigator.storage,
		indexedDB,
		mark,
		bootStore: /AppleWebKit/.test(navigator.userAgent) && !/Chrom/.test(navigator.userAgent) ? idbBootStore() : void 0
	});
	self.addEventListener("install", (event) => {
		event.waitUntil(sw.install());
		self.skipWaiting();
	});
	self.addEventListener("activate", (event) => {
		event.waitUntil(sw.activate());
	});
	self.addEventListener("message", (event) => {
		if (event.data === "SKIP_WAITING") self.skipWaiting();
		if (event.data === "BOOT_MARKS") event.ports[0]?.postMessage(bootMarks);
	});
	self.addEventListener("fetch", (event) => {
		const response = sw.handleFetch(event.request, (p) => event.waitUntil(p));
		if (response && event.request.mode === "navigate" && !bootMarks.firstNavReceivedAt) {
			mark("firstNavReceivedAt");
			response.then(() => mark("firstNavAnsweredAt"), () => {});
		}
		if (response) event.respondWith(response);
	});
	mark("evaluatedAt");
})();
