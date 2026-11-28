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
		buildId: "0b861cbbfdcd-2d9693f6",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1925/\":\"2897c465eb4fa96c\",\"/knowledge-medium/pr-preview/pr-1925/index.html\":\"2897c465eb4fa96c\",\"/knowledge-medium/pr-preview/pr-1925/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1925/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1925/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1925/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1925/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1925/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1925/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1925/assets/FacadeVFS-UqkQmcF2.js\":\"19a7bacbaa239c4b\",\"/knowledge-medium/pr-preview/pr-1925/assets/OPFSCoopSyncVFS-B5lcVDXt.js\":\"2b5f4faab885a312\",\"/knowledge-medium/pr-preview/pr-1925/assets/OPFSWriteAheadVFS-BvJp6tWo.js\":\"0dacd265bb208c60\",\"/knowledge-medium/pr-preview/pr-1925/assets/wa-sqlite-CZzDLRmi.js\":\"de99cbc7ce174a11\",\"/knowledge-medium/pr-preview/pr-1925/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1925/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1925/assets/wa-sqlite-async-C2Wp0erQ.js\":\"bb1fb700b13493b9\",\"/knowledge-medium/pr-preview/pr-1925/assets/worker-CAg0Ezas.js\":\"3153e78fc220408b\",\"/knowledge-medium/pr-preview/pr-1925/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1925/chunks/app-KZm-JQK3.js\":\"7143001dd62d5f76\",\"/knowledge-medium/pr-preview/pr-1925/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1925/index.js\":\"18a5ce937b1f827c\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1925/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1925/assets/AccessHandlePoolVFS-DapMNzXS.js\":\"8dd92e753a8b1740\",\"/knowledge-medium/pr-preview/pr-1925/assets/IDBBatchAtomicVFS-BNOaG816.js\":\"bd9068cae858888f\",\"/knowledge-medium/pr-preview/pr-1925/assets/MemoryVFS-DPRNBzV8.js\":\"abeda537707329da\",\"/knowledge-medium/pr-preview/pr-1925/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1925/assets/mc-wa-sqlite-D1Oe8RDV.js\":\"96f4368f02ea8371\",\"/knowledge-medium/pr-preview/pr-1925/assets/mc-wa-sqlite-async-DsPoeweY.js\":\"956fd2d5a513c7ff\",\"/knowledge-medium/pr-preview/pr-1925/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1925/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1925/chunks/AccessHandlePoolVFS-B7yXSG8p.js\":\"e3a5a1847a4ebad4\",\"/knowledge-medium/pr-preview/pr-1925/chunks/FacadeVFS-B5QgcYKc.js\":\"409b7bad5e9ecf80\",\"/knowledge-medium/pr-preview/pr-1925/chunks/IDBBatchAtomicVFS-PdrQ6Q1k.js\":\"ead436edd1118b64\",\"/knowledge-medium/pr-preview/pr-1925/chunks/MemoryVFS-bvGMJd0C.js\":\"a85d1e4e00e19687\",\"/knowledge-medium/pr-preview/pr-1925/chunks/OPFSCoopSyncVFS-CHSxhfVf.js\":\"acf15c80cead8c5b\",\"/knowledge-medium/pr-preview/pr-1925/chunks/OPFSWriteAheadVFS-CRz1cX-B.js\":\"063622f1a315faeb\",\"/knowledge-medium/pr-preview/pr-1925/chunks/Preview-DaxU5FWk.js\":\"c3acdf1bf1802abe\",\"/knowledge-medium/pr-preview/pr-1925/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1925/chunks/card-CXv0beQU.js\":\"c75ded73490ca7e0\",\"/knowledge-medium/pr-preview/pr-1925/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1925/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1925/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1925/chunks/dist-C_BWbuno.js\":\"bd5c662dcf7450a1\",\"/knowledge-medium/pr-preview/pr-1925/chunks/freezeExtensionImports-BLU81mw4.js\":\"91b6017b22d9983b\",\"/knowledge-medium/pr-preview/pr-1925/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1925/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/pr-preview/pr-1925/chunks/mc-wa-sqlite-BqzrwCH3.js\":\"33ee09053e5f1586\",\"/knowledge-medium/pr-preview/pr-1925/chunks/mc-wa-sqlite-async-jsg6LZLF.js\":\"9828e63f42c41444\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-4smz4UaK.js\":\"ca998c285b29e574\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-B1osU954.js\":\"c4915205649c1053\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-BePTi8eq.js\":\"f46a31b0435b3f42\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-Bm7uTt9P.js\":\"182e602d42160374\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-BugPbasM.js\":\"747b59b497d3b905\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-C_4DHNw3.js\":\"87a8627a3cf6bd39\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-DMU2OsR2.js\":\"7dcac18b19fb9da5\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-DrtyidNm.js\":\"06fa9f39f91aaae4\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-dom-server-legacy.browser.production-CUUqxpNX.js\":\"4aaf0316cbc9efa1\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-dom-server.browser.production-CkhApRan.js\":\"493b9e4aa93af141\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-dom-server.edge.production-Bg-YRA3e.js\":\"3ec1d1ecaf52e38f\",\"/knowledge-medium/pr-preview/pr-1925/chunks/server.browser-CzV-wxoB.js\":\"b490e164219d98ff\",\"/knowledge-medium/pr-preview/pr-1925/chunks/textarea-Ddur_aJP.js\":\"21c7ebb9bd51998f\",\"/knowledge-medium/pr-preview/pr-1925/chunks/ui-BPHi8n0j.js\":\"1e5f151cbcd46b8d\",\"/knowledge-medium/pr-preview/pr-1925/chunks/wa-sqlite-CwRJLjPI.js\":\"110c0baeee81ab78\",\"/knowledge-medium/pr-preview/pr-1925/chunks/wa-sqlite-async-DudyhuEa.js\":\"03fc0fdbd1d979b9\",\"/knowledge-medium/pr-preview/pr-1925/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1925/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1925/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1925/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1925/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1925/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1925/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1925/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1925/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1925/src/App.js\":\"e5760f72d79965f9\",\"/knowledge-medium/pr-preview/pr-1925/src/appUpdate.js\":\"f45439736378b99d\",\"/knowledge-medium/pr-preview/pr-1925/src/appVersion.js\":\"1f37c14810687d72\",\"/knowledge-medium/pr-preview/pr-1925/src/bootstrap/initialLayout.js\":\"49713be9483d1f66\",\"/knowledge-medium/pr-preview/pr-1925/src/bootstrap/openWorkspaceData.js\":\"460c338ed486ba41\",\"/knowledge-medium/pr-preview/pr-1925/src/bootstrap/resolveWorkspace.js\":\"61f315c47bc007b2\",\"/knowledge-medium/pr-preview/pr-1925/src/bootstrap/workspaceBootstrap.js\":\"3ba68fb08277a491\",\"/knowledge-medium/pr-preview/pr-1925/src/components/BlockComponent.js\":\"681b92ebb4ce1984\",\"/knowledge-medium/pr-preview/pr-1925/src/components/BlockCrumbs.js\":\"9b839617ef749c0d\",\"/knowledge-medium/pr-preview/pr-1925/src/components/BlockEditor.js\":\"cabdd69c0c9bacd9\",\"/knowledge-medium/pr-preview/pr-1925/src/components/BlockLoadingPlaceholder.js\":\"25c39750485f38eb\",\"/knowledge-medium/pr-preview/pr-1925/src/components/BlockProperties.js\":\"258128751b32237b\",\"/knowledge-medium/pr-preview/pr-1925/src/components/BlockSearchPicker.js\":\"d708c0bc7d9b1798\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ConfirmBulkDeleteDialog.js\":\"e34363c03c7accdb\",\"/knowledge-medium/pr-preview/pr-1925/src/components/DividerHandle.js\":\"fb9a71a512d8a415\",\"/knowledge-medium/pr-preview/pr-1925/src/components/DraftEditor.js\":\"d2e1900a793021e2\",\"/knowledge-medium/pr-preview/pr-1925/src/components/GutterPill.js\":\"479673af8eec9297\",\"/knowledge-medium/pr-preview/pr-1925/src/components/Header.js\":\"18023733283367c4\",\"/knowledge-medium/pr-preview/pr-1925/src/components/LazyBlockComponent.js\":\"00bead125f7df5fa\",\"/knowledge-medium/pr-preview/pr-1925/src/components/Login.js\":\"c487a197f501dcd6\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ZoomableSurface.js\":\"555c4af7937ead45\",\"/knowledge-medium/pr-preview/pr-1925/src/components/editModeKeepalive.js\":\"e3789e9a4d7d12cf\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyDisplay/PropertyDisplayScope.js\":\"3a37ce15a3f322ee\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"2a64fbe87944fca4\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/RefPropertyEditor.js\":\"341ab4afa4f593b0\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/RefTargetTypePicker.js\":\"eefb893aad808061\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/SelectPropertyEditor.js\":\"ae3e4fa96f0bb566\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/TypesPropertyEditor.js\":\"18c67cf4355dd884\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/defaults.js\":\"db1220a998df8c0a\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/kernelValuePresets.js\":\"6a16126076675656\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/selectablePresets.js\":\"aed76466881d595d\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/typesPropertyUi.js\":\"d5b6fbdea5e73806\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/AddPropertyForm.js\":\"c7f9aa4798ceadca\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/PropertyPicker.js\":\"ab44bc103b7d5be5\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/PropertyRow.js\":\"ef686ce4abc2ae41\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/Rows.js\":\"54cd1c951f55a872\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/actions.js\":\"39c3c41e8ccb648e\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/declarationOnly.js\":\"640cb2d867745a9f\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/layout.js\":\"0c1eebcf0123fd82\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/model.js\":\"1c28d1851db44151\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/shapeUi.js\":\"3bee036c1863dc5b\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/shapes.js\":\"f6f3e8a3eb6b4617\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/usePropertyEditingActivation.js\":\"b66ff8409518bdab\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/visibility.js\":\"c6c6ec7345465537\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanelSections.js\":\"5a3618027701e8d4\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/BlockEmbed.js\":\"0715e3d5ea6534ba\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/BlockLink.js\":\"dc50e9a12c547557\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/BlockRef.js\":\"6c0bb2e513d4c4f7\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/CompactReferenceLink.js\":\"6da94769d56eccf5\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/ReferenceLink.js\":\"418682a87f8b9609\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/cycleGuard.js\":\"7967dfdf4f23017a\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/cycleGuardContext.js\":\"f924a564f97bc3b8\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/linkInteraction.js\":\"ab1a6eaf66b3e69b\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/referenceLayout.js\":\"cf89b7d62c7e9123\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/useBlockRefAncestors.js\":\"5f795701dcbfb3ab\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/BlockGutter.js\":\"3f25cce3265eacd3\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/BlockInfoDialog.js\":\"10400f0dda62726c\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/BlockReadText.js\":\"55212bdefb9930c7\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/BlockTypeBlockRenderer.js\":\"776ab429a132b869\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/BulletHoverCard.js\":\"dbf916b67df0eb8e\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/CodeMirrorContentRenderer.js\":\"d05f8d348fd79092\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"d860c8e72bbbdcc0\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/ColumnResizeHandles.js\":\"5b17ec9607c5ec3e\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"69273b88c1740c13\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/DefaultBlockRenderer.js\":\"b6f896f4ac992eaa\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/LayoutRenderer.js\":\"3b0e35900050b84e\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/MarkdownContentRenderer.js\":\"ea5c6917f6c0e99d\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/MissingDataRenderer.js\":\"fc326778e26456ef\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/PanelRenderer.js\":\"88a464e2ddca2ae8\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/PropertySchemaBlockRenderer.js\":\"9940c539aa066dd7\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/TopLevelRenderer.js\":\"7a2434bf89015ba1\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/blockGutterMode.js\":\"cc705b5928fa3fe3\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/blockTitleText.js\":\"3ef3666b514d8c28\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/fieldCreationKeydown.js\":\"13b72c53c80ee7d3\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/layoutRootContext.js\":\"a1363ff95b1e8bc0\",\"/knowledge-medium/pr-preview/pr-1925/src/components/typeChip/TypeChip.js\":\"e320c6570074eebe\",\"/knowledge-medium/pr-preview/pr-1925/src/components/typeChip/chipStyle.js\":\"a4e7143dba9d2e8f\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/anchored-floating.js\":\"c25e53d0590f4a23\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/button.js\":\"ff20d91b14d61d90\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/card.js\":\"a6c50a7d9f4c4d61\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/checkbox.js\":\"ff104fc95cd1f636\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/collapsible.js\":\"d5aff43252e71afd\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/command.js\":\"3d24bbe6b26160be\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/context-menu.js\":\"19712cdd18b3dca0\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/dialog.js\":\"f6b0e75576b4c301\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/dropdown-menu.js\":\"47c87968f1341249\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/floating-listbox.js\":\"83716976f3e103b5\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/index.js\":\"2293e8f8405d499a\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/input.js\":\"bf261e106e6dc43c\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/kbd.js\":\"bb7480d2880e0428\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/label.js\":\"bf341d8ae377ffdc\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/textarea.js\":\"f78034c6be67af19\",\"/knowledge-medium/pr-preview/pr-1925/src/components/useEditModeYieldKeepalive.js\":\"a754309527253f7e\",\"/knowledge-medium/pr-preview/pr-1925/src/components/util/BootFallback.js\":\"f158d60f8fdcc036\",\"/knowledge-medium/pr-preview/pr-1925/src/components/util/FocusedRowLazyMount.js\":\"b9d15c186adf2e76\",\"/knowledge-medium/pr-preview/pr-1925/src/components/util/LazyViewportMount.js\":\"3b44204a074098c0\",\"/knowledge-medium/pr-preview/pr-1925/src/components/util/LocalDbCorruptionFallback.js\":\"1ad3ead2f86d2c99\",\"/knowledge-medium/pr-preview/pr-1925/src/components/util/error.js\":\"b543ee05e2614699\",\"/knowledge-medium/pr-preview/pr-1925/src/components/util/lazyMountRegistry.js\":\"95ae49440bdc9135\",\"/knowledge-medium/pr-preview/pr-1925/src/components/util/suspense.js\":\"5435d7e1e841b3d5\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/CreateWorkspaceDialog.js\":\"529fc244428eedb4\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/PendingInvitations.js\":\"f70ab497cb222a2d\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/SyncProgress.js\":\"618aa0c01e080759\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/UnlockProgress.js\":\"cdb374ad7f974816\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/WorkspaceKeyGate.js\":\"78a83004109719e8\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/WorkspaceSettingsDialog.js\":\"3c4afcde28866fe7\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/WorkspaceSwitcher.js\":\"b132868c25e712a6\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/WorkspaceSyncGate.js\":\"e92870bb8ef4ce27\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/ConversionFlow.js\":\"239d38eedc663e04\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/ConversionFlowHost.js\":\"4817fb936e489200\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/EncryptionSection.js\":\"2bac6c9a878ffb56\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/attachmentPrompts.js\":\"3388abdea06dd43d\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/bundleFolderPrompts.js\":\"3166856efa8324e3\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/conversionFlowDeps.js\":\"9c4dc47b135795e9\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/conversionFlowStore.js\":\"1eb60b8814bcd019\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/flowUi.js\":\"78da921d653bfb19\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/useConversionRun.js\":\"a618431470520d6e\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/keyUi.js\":\"0dbb98d44629b61e\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/useCloseOnKeyLoss.js\":\"e577238dfa9287eb\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/useCloseOnServerE2ee.js\":\"6d57a2f8646ba957\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/workspaceUnlocked.js\":\"ccd47d3de14127dd\",\"/knowledge-medium/pr-preview/pr-1925/src/context/backgroundSubtree.js\":\"ec8260f1eec6e1ee\",\"/knowledge-medium/pr-preview/pr-1925/src/context/block.js\":\"6b9de2ee13d5f28e\",\"/knowledge-medium/pr-preview/pr-1925/src/context/layoutWsContext.js\":\"7121d98c4f11a01f\",\"/knowledge-medium/pr-preview/pr-1925/src/context/propertyDisplay.js\":\"76a35a3dd72ff2c2\",\"/knowledge-medium/pr-preview/pr-1925/src/context/repo.js\":\"a103b55f89926e75\",\"/knowledge-medium/pr-preview/pr-1925/src/data/aliasClaim.js\":\"c814f37e69956011\",\"/knowledge-medium/pr-preview/pr-1925/src/data/aliasSeatNamespace.js\":\"eb62d18de1aa0136\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/blockData.js\":\"157f502591876398\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/blockType.js\":\"f19802162e5c344f\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/changeScope.js\":\"2f268c5115f8fd1e\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/codecs.js\":\"c7b334b4944b2704\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/derivedData.js\":\"24122ef6cc9c47e0\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/errors.js\":\"401219d0af1a40b5\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/events.js\":\"ff2d52ac9f76da47\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/handle.js\":\"145e73f71de6d416\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/index.js\":\"db52ff785cab5175\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/mutator.js\":\"e1e7718c66273470\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/processor.js\":\"e5800b479d6878eb\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/propertySchema.js\":\"d5b6f5acb5523a6b\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/query.js\":\"eff1d69bec560097\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/sameTxProcessor.js\":\"90ba9e2e8b00d7f9\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/schema.js\":\"145e73f71de6d416\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/tx.js\":\"145e73f71de6d416\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/typedBlockQuery.js\":\"a9f0f62a6e2b76f2\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/user.js\":\"ea0495d6c652e538\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/valuePresetCore.js\":\"7924f1069de2c725\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/valuePresets.js\":\"70373e588e7ff920\",\"/knowledge-medium/pr-preview/pr-1925/src/data/attachmentCleanerIOVerb.js\":\"4264962367efc44a\",\"/knowledge-medium/pr-preview/pr-1925/src/data/block.js\":\"99e096ce1d8ddbbc\",\"/knowledge-medium/pr-preview/pr-1925/src/data/blockCache.js\":\"f92ef7d4a8f42870\",\"/knowledge-medium/pr-preview/pr-1925/src/data/blockId.js\":\"4a67881854e432af\",\"/knowledge-medium/pr-preview/pr-1925/src/data/blockLiveness.js\":\"0a765bfd77672fa6\",\"/knowledge-medium/pr-preview/pr-1925/src/data/blockMerge.js\":\"fe7aaa52e6465be2\",\"/knowledge-medium/pr-preview/pr-1925/src/data/blockSchema.js\":\"b89cb5b2e7504266\",\"/knowledge-medium/pr-preview/pr-1925/src/data/blockTypeLookup.js\":\"11691d1aabb19640\",\"/knowledge-medium/pr-preview/pr-1925/src/data/blockTypes.js\":\"d58a5abbd7a2ae28\",\"/knowledge-medium/pr-preview/pr-1925/src/data/childrenView.js\":\"d2027ac7b1e3837c\",\"/knowledge-medium/pr-preview/pr-1925/src/data/clientContext.js\":\"8c7362cd9f17a9e8\",\"/knowledge-medium/pr-preview/pr-1925/src/data/dbFileSiblings.js\":\"09e33c229bb2ddb9\",\"/knowledge-medium/pr-preview/pr-1925/src/data/definitionSeeds.js\":\"68d45395b4d41ae1\",\"/knowledge-medium/pr-preview/pr-1925/src/data/derivedIds.js\":\"82920fb99a4eaa12\",\"/knowledge-medium/pr-preview/pr-1925/src/data/drawnSubtree.js\":\"c93e2eaef829932b\",\"/knowledge-medium/pr-preview/pr-1925/src/data/facetBridge.js\":\"23a5d3bb9d72b279\",\"/knowledge-medium/pr-preview/pr-1925/src/data/facets.js\":\"e7e9569de05da814\",\"/knowledge-medium/pr-preview/pr-1925/src/data/globalState.js\":\"6be777925487ba18\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/aliasClaimRederiveProcessor.js\":\"d0931be9f549836e\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/ancestorBatch.js\":\"5beb0a0faccc46ee\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/blockTypeTypeifyProcessor.js\":\"68a128429e7c2fd2\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/clientSchema.js\":\"f7b574ffb8663e4c\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/commitPipeline.js\":\"3ac65bd187c4ae65\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/devAssertions.js\":\"2e15b259f03afb23\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/firstSync.js\":\"81a18128f850df04\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/freshInitialLoad.js\":\"82e6ae578b246c67\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/graphBackfillClaim.js\":\"99b865a51620e859\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/handleStore.js\":\"7fdb52d2d1077ebf\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/idleMarkerJobs.js\":\"c5574c17b66378da\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/initialDownload.js\":\"48804936cbf6bf22\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/initializeClientDatabase.js\":\"85ff1d7a9aa23f03\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/jsonCanonical.js\":\"957f40ac76acc41a\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/kernelInvalidation.js\":\"86517fc2d33e8bff\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/kernelProcessors.js\":\"5fc04c0755c396ce\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/kernelQueries.js\":\"7124c38bdcf30454\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/mergeTypeMembershipProcessor.js\":\"5a3d6a2c76dd9094\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/normalizeReferencesProcessor.js\":\"1a1612c9bee14690\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/poolInstrumentation.js\":\"19aa606add52878d\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/processorRunner.js\":\"9c5259d03b9ab3c0\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/propertyCellBackfill.js\":\"caf1f0d93c6a1642\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/propertyChildMint.js\":\"70b5933cf4836538\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/propertyChildrenProcessor.js\":\"273d0df7b0df4a29\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/propertyDefinitionChangeProcessor.js\":\"b86098729a91b3c8\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/propertyDefinitionSynthesis.js\":\"908fa16086e49852\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/propertyKeyScan.js\":\"8c547e78dd2ccef8\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/propertySchemaResolution.js\":\"f5dbffe0081eec49\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/propertyValueEdits.js\":\"00fc7609e5ad66b6\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/raiseProtocol.js\":\"f7a7f15fcce7c991\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/readBatch.js\":\"7f5a59009d942e9a\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/refProjection.js\":\"38394a15f6161fde\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/referenceTargetLookups.js\":\"03892a387025e7d9\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/referenceTargetProcessor.js\":\"9351835e1a6293d2\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/replayMerge.js\":\"5745dea33f00f08e\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/sqlBinds.js\":\"25fdd35a51de1611\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"6803200819263af5\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/syncObserver/arrivalProcessors.js\":\"63184421e29eb21c\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/syncObserver/invalidate.js\":\"3cbe556c73724672\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/syncObserver/materialize.js\":\"a526dca6e7c34660\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/syncObserver/observer.js\":\"0c67d62798b7b3f8\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/syncObserver/reconcile.js\":\"a682ee01bef76a61\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/timingMetrics.js\":\"018c7959c10962e6\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/treeQueries.js\":\"fc7a88ceb82aed2f\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/txEngine.js\":\"1dbc239a0424f040\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/txSnapshots.js\":\"86315bf30445711f\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/typedBlockQuery.js\":\"bc0581c1a4864656\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/undoManager.js\":\"9fb439fe69ba18d9\",\"/knowledge-medium/pr-preview/pr-1925/src/data/invalidation.js\":\"71ade4cc96811a5c\",\"/knowledge-medium/pr-preview/pr-1925/src/data/kernelDataExtension.js\":\"e7a09c0972689fb0\",\"/knowledge-medium/pr-preview/pr-1925/src/data/kernelPage.js\":\"bd77b01331e2d43f\",\"/knowledge-medium/pr-preview/pr-1925/src/data/kernelValuePresetCores.js\":\"7e96f6760c57af58\",\"/knowledge-medium/pr-preview/pr-1925/src/data/localDbCorruptionSignal.js\":\"2bd98cc05d78688a\",\"/knowledge-medium/pr-preview/pr-1925/src/data/localDbStorage.js\":\"07891057064bc8d8\",\"/knowledge-medium/pr-preview/pr-1925/src/data/localDbVfs.js\":\"6d87e8702e6fa760\",\"/knowledge-medium/pr-preview/pr-1925/src/data/localSchema.js\":\"f1d9f12a0ee85082\",\"/knowledge-medium/pr-preview/pr-1925/src/data/maintenance.js\":\"4419d804e02e61cb\",\"/knowledge-medium/pr-preview/pr-1925/src/data/mergeProperties.js\":\"6f9a77022784ccb9\",\"/knowledge-medium/pr-preview/pr-1925/src/data/metricsConsoleHook.js\":\"f1f08fcf66a66379\",\"/knowledge-medium/pr-preview/pr-1925/src/data/migrationsPage.js\":\"f2394faf22e2b912\",\"/knowledge-medium/pr-preview/pr-1925/src/data/mutators.js\":\"3b815b1cdd1e7b46\",\"/knowledge-medium/pr-preview/pr-1925/src/data/orderKey.js\":\"9575d2348f210ef9\",\"/knowledge-medium/pr-preview/pr-1925/src/data/orderKeyPlacement.js\":\"33d066a5c7e7ee0c\",\"/knowledge-medium/pr-preview/pr-1925/src/data/outlineSurface.js\":\"1a2d949cf698e5e4\",\"/knowledge-medium/pr-preview/pr-1925/src/data/pendingEditorContent.js\":\"e524e3a760a53695\",\"/knowledge-medium/pr-preview/pr-1925/src/data/pendingUploadsSql.js\":\"8ec28946da884a00\",\"/knowledge-medium/pr-preview/pr-1925/src/data/pluginStateExtensions.js\":\"0cb3fa5f91389775\",\"/knowledge-medium/pr-preview/pr-1925/src/data/powerSyncLogger.js\":\"3f2137ff5ac164eb\",\"/knowledge-medium/pr-preview/pr-1925/src/data/projectorRuntime.js\":\"51efb942e9b64528\",\"/knowledge-medium/pr-preview/pr-1925/src/data/properties.js\":\"66e96d09ea585b28\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertiesPage.js\":\"a95ac497682f3e0c\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertyChildren.js\":\"343e71aae2f298a5\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertyDefinitionFanout.js\":\"85227db9bca8195e\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertyDefinitionMetadata.js\":\"e5a1f2b143a6e64f\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertyDefinitionRegistry.js\":\"553c2f1550099a39\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertyDisplayMode.js\":\"b1f38e523f3b8f51\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertyRowCreation.js\":\"17ae562b46fe3984\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertySchemaCreation.js\":\"282414d8b6ab7403\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertySeeds.js\":\"114ac078f2fe3f47\",\"/knowledge-medium/pr-preview/pr-1925/src/data/recentsPage.js\":\"595522f86409d09d\",\"/knowledge-medium/pr-preview/pr-1925/src/data/refTargetComparableProperty.js\":\"c61d49a45aeeacc9\",\"/knowledge-medium/pr-preview/pr-1925/src/data/referenceBlock.js\":\"41f7b9e878054a73\",\"/knowledge-medium/pr-preview/pr-1925/src/data/rejectedUploads.js\":\"3bfd3ca92f2562f7\",\"/knowledge-medium/pr-preview/pr-1925/src/data/releasePowerSyncConnection.js\":\"5ce0dc13b4a30864\",\"/knowledge-medium/pr-preview/pr-1925/src/data/repo.js\":\"8bf7e0c86687e78c\",\"/knowledge-medium/pr-preview/pr-1925/src/data/repoProvider.js\":\"8604253eb36a6271\",\"/knowledge-medium/pr-preview/pr-1925/src/data/rowProperty.js\":\"3e10240357e693a8\",\"/knowledge-medium/pr-preview/pr-1925/src/data/searchFilter.js\":\"233dcb490df4e103\",\"/knowledge-medium/pr-preview/pr-1925/src/data/seedIdentityLedger.js\":\"5fc66efdf68d695e\",\"/knowledge-medium/pr-preview/pr-1925/src/data/stateBlocks.js\":\"d96e3028e1733a6c\",\"/knowledge-medium/pr-preview/pr-1925/src/data/structuralEditPolicy.js\":\"9247db3751ddd5ba\",\"/knowledge-medium/pr-preview/pr-1925/src/data/structuralInsert.js\":\"b81f035568c04373\",\"/knowledge-medium/pr-preview/pr-1925/src/data/subtreeDelete.js\":\"8046df706de468a1\",\"/knowledge-medium/pr-preview/pr-1925/src/data/syncStreamLock.js\":\"acffdbc3256ff871\",\"/knowledge-medium/pr-preview/pr-1925/src/data/syncedTableSqlRecognizer.js\":\"a1e98cadcd2e8d09\",\"/knowledge-medium/pr-preview/pr-1925/src/data/syncedTableWriteGuard.js\":\"9a282e096b0e1ae6\",\"/knowledge-medium/pr-preview/pr-1925/src/data/targets.js\":\"306f060abc6f7fa3\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typeColors.js\":\"588a1149354685d4\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typeDefinitionMetadata.js\":\"5bca1ccb2e673c6f\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typeDefinitionRegistry.js\":\"15d19d9c9b84ef4b\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typeExtraction.js\":\"3dc825f9862a55cd\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typeInitialValues.js\":\"a360adfabc6820c1\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typePropertyGroups.js\":\"5634d28bdb61c0d1\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typeSeeds.js\":\"0a7f0034fa52c3c1\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typeTagger.js\":\"23aa97448f569ffd\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typedRecords.js\":\"9760d8305ebb89b9\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typesPage.js\":\"8b46f2754e6b4cc9\",\"/knowledge-medium/pr-preview/pr-1925/src/data/userPrefs.js\":\"360a5d364c4a2701\",\"/knowledge-medium/pr-preview/pr-1925/src/data/userSchemasService.js\":\"f60387dfa8d03a87\",\"/knowledge-medium/pr-preview/pr-1925/src/data/userTypesService.js\":\"c82799e31c8711ac\",\"/knowledge-medium/pr-preview/pr-1925/src/data/valuePresetRegistry.js\":\"aa3bcc17a0ecf121\",\"/knowledge-medium/pr-preview/pr-1925/src/data/visibleChildren.js\":\"cd869207dc77e7ca\",\"/knowledge-medium/pr-preview/pr-1925/src/data/workspaceConversion.js\":\"7242d77974d96753\",\"/knowledge-medium/pr-preview/pr-1925/src/data/workspaceFirstSync.js\":\"9b2b35f5833b9a12\",\"/knowledge-medium/pr-preview/pr-1925/src/data/workspaceIdNamespace.js\":\"76dff560b9b64479\",\"/knowledge-medium/pr-preview/pr-1925/src/data/workspaceSchema.js\":\"a95749f226b00fdb\",\"/knowledge-medium/pr-preview/pr-1925/src/data/workspaces.js\":\"e1b86ab2d927fd6e\",\"/knowledge-medium/pr-preview/pr-1925/src/data/writeAheadLog.js\":\"53aa073f5a0c76a6\",\"/knowledge-medium/pr-preview/pr-1925/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/BlockPasteShellDecorator.js\":\"b4c52ae3c70cdf89\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/atTrigger.js\":\"8f1421d3c388de7e\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/autocomplete.js\":\"c4081d187e0923ee\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/codeMirrorExtensions.js\":\"6a814aa3191221a7\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/contentFlush.js\":\"026ec77152db8cc2\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/defaultInteractions.js\":\"a1b4aa5373db0795\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/editSettleSignal.js\":\"efff8115945b394d\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/insertImage.js\":\"015ec2f8d33e1d16\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/referenceCompletionRange.js\":\"be52991225d1c63c\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/referenceTargetTypes.js\":\"b371cf9790f0ee59\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/syntaxContext.js\":\"d3aea505cb5b444b\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/triggerMatch.js\":\"02578c8dba861c73\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/AppRuntimeProvider.js\":\"6c281d1289387507\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/BlockFocusShellDecorator.js\":\"41f20807d3343d0b\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/ExtensionRenderBoundary.js\":\"6c683364cf7013f5\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/PanelContentRecovery.js\":\"c75bf900d711e2d4\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/apiCatalog.js\":\"dc9c71eed1e544a0\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/appRuntimeController.js\":\"be774a46024246ab\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/approveExtensionHere.js\":\"dffc9ba6ed0efeca\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/armedCutAppMount.js\":\"a380ad952d801494\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/batchableKeyedStore.js\":\"bfc59af7720b1230\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/blockInteraction.js\":\"6f201cb4ba96c177\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/blockSelectionAction.js\":\"2d368168414cdb5d\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/buildApprovalRecord.js\":\"0cfe5950da43aa51\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/compileExtensionModule.js\":\"86d685688c7ed7e8\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/compiledModuleCache.js\":\"d781678fa9ea82f4\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/continuousGestures.js\":\"77637a4b6a7a7637\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/core.js\":\"c551cf309bd86b92\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/defaultRenderers.js\":\"c8debd6c8bc3af55\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/definitionFanoutAppMount.js\":\"0a527edc89feb080\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/dialogAppMount.js\":\"5a8347a001b3fcd1\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/dynamicExtensionSeeds.js\":\"d388f882020b3db2\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/dynamicExtensions.js\":\"8b4a339bb70eedbb\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/exampleExtensions.js\":\"f961c0df37691a8e\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/extensionApprovalStatus.js\":\"8021e21faa9e164d\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/extensionImportPolicy.js\":\"03a3a8dd62a980f0\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/extensionLoadErrorToast.js\":\"a5f81521802839fc\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/extensionLoadErrors.js\":\"19db0530deb42146\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/extensionLookup.js\":\"7199ce3532f839b7\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/extensionToggles.js\":\"608173b9cae5656e\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/extensionUtilitiesCss.js\":\"ff541985b57d2ad5\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/kernelPageDeletionGuard.js\":\"81b13776aa1dc05c\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/liveRuntime.js\":\"ec504cb405dd2795\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/normalizeExtensionSource.js\":\"9a37738a83a53c5f\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/openExtensionsSettings.js\":\"e84699a3f9254e02\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/overridesCache.js\":\"18d0410fc614d143\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/pluginIds.js\":\"e4080a87d07be3fb\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/processorRejectionToast.js\":\"cd74754268fe91f3\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/runtimeActions.js\":\"b3c0fd8994eee7be\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/runtimeContext.js\":\"9da9a57fc210d49f\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/staticAppExtensions.js\":\"65c3dd57a647c520\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/staticDataExtensions.js\":\"baa915095921dc5c\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/toastAppMount.js\":\"e894df101985f622\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/transpileExtension.js\":\"c488ca9d5af08c5e\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/useOverrides.js\":\"ff5b0ec3aa1d75e6\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/useShortcutSurfaceActivations.js\":\"6b56bf985b926590\",\"/knowledge-medium/pr-preview/pr-1925/src/facets/discoverToggleTree.js\":\"e5dbfbf25a670bb2\",\"/knowledge-medium/pr-preview/pr-1925/src/facets/facet.js\":\"fe725ca3cd94b868\",\"/knowledge-medium/pr-preview/pr-1925/src/facets/resolveAppRuntime.js\":\"b804677380707866\",\"/knowledge-medium/pr-preview/pr-1925/src/facets/runtimeEvents.js\":\"387e5d147278a23b\",\"/knowledge-medium/pr-preview/pr-1925/src/facets/togglable.js\":\"f208e5b2c4cb13ae\",\"/knowledge-medium/pr-preview/pr-1925/src/facets/variantFacet.js\":\"303473e5e7dce44a\",\"/knowledge-medium/pr-preview/pr-1925/src/facets/verbFacet.js\":\"2c6b743c632fe285\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/block.js\":\"adc248be49ac0495\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/focusedChild.js\":\"98d34a87f2f886e2\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/propertySchemas.js\":\"39769a754e56f201\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/typeRegistry.js\":\"6699ce3867b5b235\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useAncestorCrumbs.js\":\"2284530d558de5cc\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useAutocompleteListbox.js\":\"ab3ef4461fb9f6b1\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useDebouncedSearch.js\":\"4aae4b9fdb51a30c\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useDebouncedValue.js\":\"bdb1d27fac268105\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useFacetValue.js\":\"b29fc710e26b22e2\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useIsFocalRender.js\":\"26542016f2f30fa9\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useIsReadOnly.js\":\"d051d0410c2e978c\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useMaterializeBacklog.js\":\"75784ab8cca75158\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useMinuteClock.js\":\"e35a9c6ce045f933\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/usePanelLayoutProjection.js\":\"4a26ae15aa335bd5\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/usePendingInvitations.js\":\"f8f747997b1b3443\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useRendererRegistry.js\":\"a2ceb122862b047c\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useRetainedFieldRows.js\":\"2a3b3e81ffef2a87\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useWorkspaces.js\":\"ecf73b9b3dade0ca\",\"/knowledge-medium/pr-preview/pr-1925/src/lib/utils.js\":\"12da253afdd6e52d\",\"/knowledge-medium/pr-preview/pr-1925/src/main.js\":\"475aeae3bb3fee5b\",\"/knowledge-medium/pr-preview/pr-1925/src/markdown/MarkdownImage.js\":\"22ec6a1cfdd5d9e5\",\"/knowledge-medium/pr-preview/pr-1925/src/markdown/blockSeparators.js\":\"5edcdb06840705bc\",\"/knowledge-medium/pr-preview/pr-1925/src/markdown/context.js\":\"4f67307550f5a560\",\"/knowledge-medium/pr-preview/pr-1925/src/markdown/defaultMarkdownExtension.js\":\"43b7fba177c2808b\",\"/knowledge-medium/pr-preview/pr-1925/src/markdown/extensions.js\":\"34335282c4717c37\",\"/knowledge-medium/pr-preview/pr-1925/src/markdown/renderMarkdownHtml.js\":\"84afb2f3f70324e7\",\"/knowledge-medium/pr-preview/pr-1925/src/minimal-editor.js\":\"4594552ce23d67e0\",\"/knowledge-medium/pr-preview/pr-1925/src/paste/armedCut.js\":\"b0567e5b161dab08\",\"/knowledge-medium/pr-preview/pr-1925/src/paste/captureMediaVerb.js\":\"346261fa0c386cd6\",\"/knowledge-medium/pr-preview/pr-1925/src/paste/clipboard.js\":\"a352a25836ae5551\",\"/knowledge-medium/pr-preview/pr-1925/src/paste/decision.js\":\"49150418cf6d1a53\",\"/knowledge-medium/pr-preview/pr-1925/src/paste/operations.js\":\"6998c79a4f870c84\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/account-header/AccountHeaderItem.js\":\"16f479919bcfe112\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/account-header/index.js\":\"929a999e25451f3f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"12cc7bd4f431d9ec\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/askAgent.js\":\"5fe21894df99e227\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/askedStore.js\":\"b794dd169d13d282\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"87c995793ee4ab3f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/chipState.js\":\"86a9168a5946d164\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/dataExtension.js\":\"4ce0d3066f95a421\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/index.js\":\"db22f2ac523e5f7b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"a64355d1d613e74e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/schema.js\":\"c0b28d7110da25e3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/AgentTokensDialog.js\":\"d1932f0a36732c83\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/BridgePairingDialog.js\":\"8e0e995b5d0080f7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/addMedia.js\":\"71a30106b155ad4d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/backlinks.js\":\"817677e593e112b0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/block.js\":\"bf277c5813042edc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/context.js\":\"73957f87e666f56b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/displayIds.js\":\"2c9bc993f2f5f6ba\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/index.js\":\"54f0fcb378a64179\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/outline.js\":\"ff909e40e8fe09d8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/properties.js\":\"2eb8933e9794840d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/refs.js\":\"1c4ab6221cd581eb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"38825c72895e46a1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/search.js\":\"490c1298c638a879\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/shared.js\":\"117e80b6764443b1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"8b913c7f9fc0b894\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/text.js\":\"a1ae115852484ef0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentWrites.js\":\"382337cd403e5bee\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/authoringCatalog.js\":\"2a6112dc52dbb57a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/blockRefTargets.js\":\"5d79ae1465b6af9d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/bridge.js\":\"92371096845e67f6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/bridgeLoop.js\":\"03d0868d00657e5b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/changeHistory.js\":\"db08a0e345c57c35\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/commands.js\":\"be7d72a200ae32d3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/commentsCommands.js\":\"0a9e20763887060a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/dataExtension.js\":\"ec3cac6d51058aef\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/dataModelGuide.js\":\"5896cdf84b1b3a56\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/dayPropertyInputs.js\":\"9093bce33c361075\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/describeRuntime.js\":\"e64573a4e0a380bd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/extensionLint.js\":\"53eb1e84892198e4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/grainAudit.js\":\"95ff23f7e2070892\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/healthCommand.js\":\"7e9b85fc6cc38548\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/index.js\":\"fd6452b02a01d880\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/presetIdentity.js\":\"811ce399ee4710fc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"5a9bdb3e1adf6056\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/readMedia.js\":\"ef267d4a821697cb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/schema.js\":\"c5c6928f3098d91e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/serialization.js\":\"7e493257776e7e35\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/targets.js\":\"f85661e6d3d1b337\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/tokens.js\":\"1e079d4d7de04f89\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/watchEvents.js\":\"d1c8466e5758202b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/workspaceGuard.js\":\"f4f5583f2db54c23\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/writeCommands.js\":\"eb4c0fd0e5735785\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/AliasCollisionToast.js\":\"6ee2b9dfb416a7e3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/DuplicateNameBanner.js\":\"1f3413f036dcffaf\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/collisionMerge.js\":\"e00bbc035199db86\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/dataExtension.js\":\"5ce2d7dc60f724d0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/index.js\":\"fddce923eb9568e6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/mergeCollisionAction.js\":\"3805abf34be1b9d4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/pageStyling.js\":\"42ca5fdec434bb2b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/rejectionToast.js\":\"f7526237c3047e59\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/syncProcessor.js\":\"5a26c8d24ec5bf78\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/actions.js\":\"1e56b20e319bb90d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/addComment.js\":\"36eec94020140679\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/anchor.js\":\"2a0c02d9ab6b8984\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/anchorState.js\":\"aa0726b207531898\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/commentLinks.js\":\"9ce301382ee2399f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/confirmThreadDeletion.js\":\"06f88425397ea6ee\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/container.js\":\"da819d9a045a89ca\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/dataExtension.js\":\"438a5719e808e137\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/deleteComment.js\":\"98e0cd1bf87accd3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/highlights.js\":\"0a21431e5b8e4f92\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/index.js\":\"4921dfa3dad792a0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/linkedCommentsPill.js\":\"54384be118a84f55\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/margin.js\":\"ee5e1df170a75158\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/marginAnchorLinks.js\":\"632e93fbdfaf2505\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/marginSchema.js\":\"f9dcbf0798caab78\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/newComment.js\":\"766f137e425d03c3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/ownThreadPicker.js\":\"50d3f8c04bdcf84d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/placement.js\":\"b4426917c9d9021f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/queries.js\":\"ef50fe86712f9aa7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/quotePosition.js\":\"8fa4879bda52608f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/quotedIn.js\":\"01c98a858fa1f46c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/quotedRange.js\":\"c932fdeec478413f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/rangeRefs.js\":\"8813ec4e4f181f06\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/readHighlights.js\":\"25da5827b6f5f12d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/readSelection.js\":\"239eeab0c72213bf\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/readSelectionUi.js\":\"2c41122a172099e6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/reanchor.js\":\"dfc8a3bc1d4e191f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/schema.js\":\"8943dbd54bad7dbc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/scope.js\":\"ebbaf2fdfe8a753e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/scopeThreads.js\":\"5fad8bc05cc12304\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/splitRetarget.js\":\"1bc2e951921fc52e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/suggestionCard.js\":\"120e01c809625bf1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/suggestions.js\":\"8018e4d035bb7ed5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/summaries.js\":\"489e13eb0f5d2b2b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/summaryBatch.js\":\"556ec7dcabb5451e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/surface.js\":\"0a26f186448c85d6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/threadNavigation.js\":\"31f70d8fb2e84c66\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/threads.js\":\"d38eca3c2fe8dc0a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/ui.js\":\"42ce93789bfec360\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/uiStore.js\":\"8000713db9659dcf\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/app-intents/appIntents.js\":\"734620d64b8725fe\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/app-intents/index.js\":\"6773c156aaaac6bc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/app-update-prompt/index.js\":\"c19eded952bce3d7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/app-update-prompt/status.js\":\"6852c074cf20b8b2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"b3e374f1b48bbc9c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/MediaBlockRenderer.js\":\"972bc70f69a79296\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/MediaDownLaneReplicator.js\":\"820676bd5869c9cd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/MediaUploadReconciler.js\":\"36627396982d7021\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/assetDownLane.js\":\"12d3d92e76abf0a6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/assetResolver.js\":\"8766bd865ebcb87e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/assetUpload.js\":\"b3f5941fb2d24377\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/attachmentCleanerIO.js\":\"ebe2fcce9f709444\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/audit/supabaseAuditIO.js\":\"e0a4efab88d509e0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/blobStore.js\":\"755f7f4004995f75\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/browserMedia.js\":\"abfc38ab351658b2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/byteStore.js\":\"0c3939abc2ee7d24\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/cleanerIO.js\":\"755f173d950c22a7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/cleanupAttachments.js\":\"6248bff05317c6d5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/dataExtension.js\":\"5e913fe07d27a889\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/downLane.js\":\"fd215f48bf8acc90\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/index.js\":\"e0f61e30b225dfd6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/insertImageContribution.js\":\"a3c49c4b3d59b322\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/laneArming.js\":\"c58c62674ebad0d4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/laneLock.js\":\"c5e0d384a0a2bbd1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/mediaBlock.js\":\"3db02d0977312dc1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/mediaCapture.js\":\"611edbe00a18809f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/mediaLanes.js\":\"ca4493209ed44c07\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/mediaViewers.js\":\"cba2a808cf782417\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/mediaViewersFacet.js\":\"bb81fd1f58bae6b1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/pasteCapture.js\":\"4c3dc6df11dc3c3d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/resolver.js\":\"59458e0df3977e1c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/retryUploadsAction.js\":\"5885d9a8adabddd1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/storagePaths.js\":\"250a4f084681123e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/uploadDrain.js\":\"ef3f8474f9216e46\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/uploadLaneStatus.js\":\"5e2f5227aee977a3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/uploadReconcile.js\":\"edc9055f70dc4c32\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/uploadRecovery.js\":\"780cc106e56d00e9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/uploadStore.js\":\"1aea36ab029d0d17\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/useAssetObjectUrl.js\":\"3617f2d6f0239d90\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"e4cc47fc5e6d7806\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks-view/BacklinksViewSection.js\":\"3a072094e6b3a4cf\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks-view/facet.js\":\"7f7c2a2b9893574d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks-view/index.js\":\"0b461c3ed190dce1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks-view/prop.js\":\"626ee7df75476835\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/BacklinkFilters.js\":\"518bca01b8f383f4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"5311528163b25316\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/BlockEntry.js\":\"b2f486ea84ed87ae\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/LinkedReferences.js\":\"1d65aaf9f5a6c7c2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"7c42d649209c616d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/dailyNoteDefaults.js\":\"46d99541afe2a219\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/dataExtension.js\":\"9791ade017af7d4c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/edgeExclusions.js\":\"b7fd42bf9c10a73f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/filterProperty.js\":\"8150646e6d0f341d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/index.js\":\"9206e0d09cabea20\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"4a1707fddf052c56\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/inline-counts/applies.js\":\"7a319c7145b3d31f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/inline-counts/countQuery.js\":\"048b348eca1c8385\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/inline-counts/expansionStore.js\":\"b23ef3e109587e07\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/inline-counts/index.js\":\"bab5f10f1f2c26e3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"ce56a0f0445e0bbe\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/presentationInvalidation.js\":\"a9ed4d56e531d75a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/propertyEditorOverride.js\":\"24f2a5b8200bb34d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/propertyFilter.js\":\"610bd107f1e95ffb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/query.js\":\"aded98f10d3d8a41\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/resolveFilter.js\":\"315dea0125f1c545\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/sourceBatch.js\":\"8ece245981d57ce8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/sources.js\":\"5b376cd19e85de44\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/useBacklinks.js\":\"03af2e32aca6ac76\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"56de07180222ee8a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/birthday/BirthdayCelebration.js\":\"3ba64f7b223aee46\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/birthday/BirthdayOverlay.js\":\"67eadcaa15c94488\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/birthday/gate.js\":\"6112fa23f44ef1fe\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/birthday/index.js\":\"d619c307b744e986\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/birthday/wolfTheme.js\":\"fc02f2a97656858f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-drag/BlockDragLayer.js\":\"1b4c20e923e1675d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-drag/dragController.js\":\"31e84c5866beb260\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-drag/dropTarget.js\":\"c916d771f86beec9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-drag/index.js\":\"d9fce771219c6b87\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-drag/projection.js\":\"26230037a02fa654\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-info/BlockMetaCard.js\":\"ab5c42689c7dfca3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-info/index.js\":\"f665ba395f0f72e9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/AddTagDialog.js\":\"3dcd33503b2489cb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"6280565a5b2b03ff\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/TagNameIssueHint.js\":\"591e55bddd735a34\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/addTagAction.js\":\"2c35fefa5a15db67\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/appendTag.js\":\"320bf8441fa5ea3f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/config.js\":\"94e28d372ff8b66c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/dataExtension.js\":\"52c8c6311a516c8a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/index.js\":\"888d0df9a7a49a55\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/propertyEditorOverride.js\":\"f45765e5d4988a13\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/breadcrumbs/BreadcrumbList.js\":\"885bcd57bab8b274\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"97264ad61d4c606b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/breadcrumbs/Breadcrumbs.js\":\"11e5a78b0333001d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"c50c2d9be3121ee7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"ba006cf75ad6ad98\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/breadcrumbs/index.js\":\"39bf05faa63ef23b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"bf4dce83cfdf2bc4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/CharacterCountItem.js\":\"80008ee2c397246e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/ProfilePropertyEditor.js\":\"37b3a669cf053cd5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/actions.js\":\"d42e50db85e08f89\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/blockType.js\":\"e0c0efaf922990e4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/charCount.js\":\"f22a29091f72225d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/dataExtension.js\":\"e91cca7efce27298\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/index.js\":\"537f6aa61629b153\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/profiles.js\":\"482965ac34c0f625\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/properties.js\":\"49df9f0e648a0761\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/subtree.js\":\"81bdda5a77cb2c3e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/textCounts.js\":\"3db5c9d300768b60\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/colemak-keybindings/index.js\":\"576edc6c1510c0b6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/command-palette/CommandPalette.js\":\"8d9c28e09b0f4bf5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/command-palette/HeaderItem.js\":\"0331ae9243d377d0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/command-palette/context.js\":\"e268a21a9176094e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/command-palette/index.js\":\"04f3dab13f6215ab\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/command-palette/selection.js\":\"5ec74932fdb61326\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/command-palette/toggleStore.js\":\"a4817a8f53f8c4c9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/command-palette/useCommandPaletteActions.js\":\"aae6264ffbeb93ec\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/ContributorBadges.js\":\"ad1595501dccb3ff\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/ProfilePicture.js\":\"09c8cc461bf76143\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/author.js\":\"8e74f459040a9d47\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/codeMirrorExtensions.js\":\"1c815011d9966d37\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/dataExtension.js\":\"9ba1d35111959c53\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/index.js\":\"be76bd14f8e22be0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/mentionAutocomplete.js\":\"2c0f5e131b2d5e97\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/processor.js\":\"365618435d55edba\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/profiles.js\":\"11d4293d1a87e967\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/queries.js\":\"f23a98f5b0208911\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/schema.js\":\"b75f724718f4a2c8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/useCommentAuthor.js\":\"760f3b80a28af143\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"619d616674eedf68\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/cursor-follows-scroll/followOrigin.js\":\"e4d4a91a937fb0e8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/cursor-follows-scroll/index.js\":\"920874cca607c9f4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"5dce5b285de4678c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"f3663d5fde238f16\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/CalendarGrid.js\":\"cd9042561e44da47\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/DailyNotePicker.js\":\"97ca5d4dce28132f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"a94aebdbe537559e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/DateNavDecorator.js\":\"2a4df46374f8528c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/DateScrubOverlay.js\":\"8980939e4cf17e3c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/DayPropertyControl.js\":\"a75a3668ee771239\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/DayValueReferenceControl.js\":\"054d990253e6d4d5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/HeaderItem.js\":\"13ade627c75a146f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/ReschedulePicker.js\":\"ce2f4982ab86d784\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/SpreadDatesDialog.js\":\"45f25b77fdf85ef2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/actions.js\":\"d05356546bc9bb3b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/blockDateAdapter.js\":\"7082c0cb4ee4d7ab\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/calendar.js\":\"e4e292ecab7ef946\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dailyNotes.js\":\"b31c4f15bfbb4e56\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dataExtension.js\":\"6345998fa0b9d81d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dateScrubActions.js\":\"9831e6e45635ae92\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dateScrubGesture.js\":\"20f94d090251ce78\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dateScrubGestureActions.js\":\"1703796709ef32d1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dateScrubRecognizer.js\":\"ee5f99c15fef212c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dayProperty.js\":\"56a551db1b724bc7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"c3a4d544272149e8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/deletionGuard.js\":\"5152cfc6931441f1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dueQuery.js\":\"dc6d7ac17f6f9359\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/index.js\":\"2a450b0065da5305\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/landing.js\":\"fad009c2ef134ebb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/localSchema.js\":\"1f06d01a1fbc41ff\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/referenceDateAdapter.js\":\"2ac7008d0438928c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/rescheduleAction.js\":\"ec255d8cc4af4aae\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/schema.js\":\"a86b6b8af585d6b2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/spreadBlockDates.js\":\"f0e9b1f76c007ad6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/spreadDatesAction.js\":\"775d20ed3aa2262f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/today.js\":\"ac3d0a2fd09cb300\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"432545eb46622e92\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"389e806c45865b11\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/audit.js\":\"b55cb46a7ab0356c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/auditAction.js\":\"8c932cea585c1d86\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/auditRanges.js\":\"41f73a39ef903f87\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/diagnosticsSource.js\":\"b7255847a4e5fae3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/divergenceScan.js\":\"3478b58d6ed5b1d2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/index.js\":\"6188559304b0b48b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/propertyChildrenChecks.js\":\"070d8c386b04bf13\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/referencesMirror.js\":\"3023d92636db920c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/rowJson.js\":\"a792303c9d9d1d4a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/schedule.js\":\"99d2438c978c1d25\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/store.js\":\"1001ba9971c1cc50\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-maintenance/action.js\":\"bb05486d605256fd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-maintenance/index.js\":\"5e7159bc2434bf68\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-maintenance/plugin.js\":\"f145c22547547a28\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"a0e27f4767005084\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/actions.js\":\"a9785e76dcc16fb2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/changeMarker.js\":\"be516c6b1761c737\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/diagnostics.js\":\"49b766dd699cfa76\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/fileSystemAccess.js\":\"9db2f5aff359c1c4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/filenames.js\":\"967bec444b35cfa5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/index.js\":\"0777493360c3c2d6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/mirror.js\":\"a390d644438d0632\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/runLock.js\":\"7b9f5bf2d25201e3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/runtimeHealth.js\":\"fc3d7a8b208f3226\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/schedule.js\":\"3d263ef211e6e080\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/store.js\":\"f860d5d934a776a9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/default-themes/index.js\":\"544921b8b73fa1e1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/default-themes/themes.js\":\"7d58feb0dca4361d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/diagnostics/facet.js\":\"1006239e5dece25c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/diagnostics/useDiagnostics.js\":\"90209b9982d3f6b1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extension-prompts/dismissals.js\":\"57f5955eabd8f5c6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extension-prompts/index.js\":\"59a1fb263f069fa4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extension-prompts/status.js\":\"d3fd3cc1a08cdb0d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extension-prompts/store.js\":\"731cb741a44a85d8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"ffccdebad559bc2f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/ExtensionsSettings.js\":\"6d3fcaf5c17a8be3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/actions.js\":\"1337b0c63df6812c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/config.js\":\"a2a24a471bb8ab96\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/dataExtension.js\":\"db97c9403caf35a4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/effect.js\":\"cf8a04e2075fab8a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/index.js\":\"0bcf3c991659bff7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/propertyEditorOverride.js\":\"45ef1b160f1c5695\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/useToggleTree.js\":\"f110110f575a233a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extract-type/ExtractTypeDialog.js\":\"68e8ef6788a90a30\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"f3d63fbfeceeb56e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extract-type/PropertyShapePicker.js\":\"3fb58f3698254f3d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extract-type/action.js\":\"5c224388aa1eb4e4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extract-type/index.js\":\"8f3b8e8de37c494b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/find-replace/FindReplaceDialog.js\":\"14d22885850cb47c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/find-replace/HeaderItem.js\":\"3b6bee3feaa14470\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/find-replace/dataExtension.js\":\"a45da02977d924cc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/find-replace/index.js\":\"77203925246c3bab\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/find-replace/search.js\":\"b66f57b0af3b8657\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/find-replace/toggleStore.js\":\"954f3d3c40b81cd8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/LocationPropertyEditor.js\":\"efd298c51ae87fc9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/MapView.js\":\"156505cbce03a63d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/blockTypes.js\":\"966b3cd59b48002a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/codeMirrorExtensions.js\":\"c2deacc826ce9ef9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/createOrFindPlace.js\":\"5b4b729cf3289327\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/currentLocation.js\":\"50d8a72d6785a415\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/dataExtension.js\":\"6f8c0557aab87553\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/geoContentDecorator.js\":\"9424290e3d045b14\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/googlePlacesClient.js\":\"a4783ddc4a2323b2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/index.js\":\"ebb2a1cbd0adb329\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/locationsPage.js\":\"21e423b6b5e7d3e2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/mapViewport.js\":\"c1a8f068d4067903\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/pickCurrentLocation.js\":\"dadcf34ead279c25\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/placeAutocomplete.js\":\"06feefffdf9ff115\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/placeNameCollision.js\":\"09185fd3cf4c0592\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/properties.js\":\"9bdf9a00a5802060\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/propertyEditorOverrides.js\":\"886b6177223d81cc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/query.js\":\"6c582d463c201e37\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/usePlaceSearch.js\":\"27a3cad4e7311d05\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"54fa31e5c820f9c2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"caacdb464d64656b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"cffa2b7eb5461f34\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/config.js\":\"143d65d1fdcc5354\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/dataExtension.js\":\"10d407eed8d02d28\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/facet.js\":\"eb830f8608f019ce\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/grouping.js\":\"2c11c60334ce2e86\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/index.js\":\"0c835123a6a756cd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"93ad59eb926aa3fa\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/query.js\":\"2ec62d3e87e57e3a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/resolveConfig.js\":\"135580203e44649f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"9be9ec218fa0c96c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"c1c265c77c24375e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/HtmlDocumentContent.js\":\"b3ac8b8f5eb5ecc3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/HtmlFrame.js\":\"8df93d7f91fb3c1a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/actions.js\":\"29927e6389ce62e2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/blockType.js\":\"d3bbc6bf1863e38d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/confirmRunScripts.js\":\"171f12f0b4226b3a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/dataExtension.js\":\"b4945571b51bb3ad\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/frameAnnotations.js\":\"ba0a41f83f031b77\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/frameDocument.js\":\"a77c1d080cdfd206\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/frameTheme.js\":\"e7baea0693a681f9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/index.js\":\"b602c9e466ad93c1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/scriptConsent.js\":\"29316e4c821156e8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/sourceMap.js\":\"9fe8f5ef6400f7ea\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/useDocumentScripts.js\":\"475ff0363bfb7988\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/interaction-metrics/index.js\":\"da45e780140b77d1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/interaction-metrics/record.js\":\"70c6060e13d46fc1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/interaction-metrics/recordStore.js\":\"8b92f72cc5ba0148\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/interaction-metrics/responsiveness.js\":\"2f21e31b15adbd80\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/interaction-metrics/schedule.js\":\"d12cfddf75cd44a9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/interaction-metrics/sessionContext.js\":\"02126aafae837037\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"d7b4f84381d6c9c9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"50b3bde202971a44\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/actions.js\":\"10e6c17cad7ae32c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/config.js\":\"36a10d072317b20d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/dataExtension.js\":\"13ce829cb5082cfd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/effect.js\":\"fb37b2df7e1b67ff\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/index.js\":\"267ed391ebc3eacc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/keyCapture.js\":\"dae13f963459b220\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/overrideStore.js\":\"e31334d9524c03df\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"6b6d43b08768d2d6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/left-sidebar/HeaderItem.js\":\"a0ca54e4df58ce9f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/left-sidebar/LeftSidebar.js\":\"115ff25602b7aaf5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/left-sidebar/actions.js\":\"68d5ce568594a815\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/left-sidebar/facet.js\":\"1e54c9f634a3ff94\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/left-sidebar/index.js\":\"292ef6582294363a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/left-sidebar/shortcuts.js\":\"2db2bca0bf78535b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/left-sidebar/toggleStore.js\":\"f07c442127e1e900\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/merge-blocks/MergePicker.js\":\"75a9b52280623286\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/merge-blocks/index.js\":\"b351a2f3f0ce8439\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/merge-blocks/mergeAction.js\":\"062fa0ff023e3f20\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/merge-blocks/strategy.js\":\"648e452459da4956\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-bottom-nav/Button.js\":\"9946bbd30bcf5d1d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"0a1e9f734e5dbe09\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-bottom-nav/defaultItems.js\":\"05cca2ab76a06922\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-bottom-nav/facet.js\":\"746e26e27ef6e0b7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-bottom-nav/index.js\":\"ccf3fd103c62c6d8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"5e92aef7dc0e03df\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-keyboard-toolbar/actions.js\":\"10c6c1d8f5a4c04b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"15119fcb1fc4b425\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-keyboard-toolbar/facet.js\":\"6a7ac9a7d7f7d80e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-keyboard-toolbar/index.js\":\"063ea073e56f021b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/move-blocks/MoveDestinationPicker.js\":\"815a0fb5ed61ca05\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/move-blocks/blockSubtreeMembership.js\":\"bdb0f7fcfba90156\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/move-blocks/contextMenuItem.js\":\"c72362be4c8a29df\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/move-blocks/index.js\":\"b2df31f503c36dcc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/move-blocks/moveAction.js\":\"b5c23e211e57e640\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/move-blocks/moveBlocks.js\":\"05700cfab13462ad\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/move-blocks/selectionAfterMove.js\":\"26565cab9ae1cb9b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/TutorialBanner.js\":\"466cc40db94c2ffd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/action.js\":\"89f0d5b009643e21\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/bannerDismissal.js\":\"2b51953b6e8e3a4a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/documents/cheatSheet.js\":\"b3c41d030352cfa1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/index.js\":\"6f0a0f584f657932\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/keys.js\":\"f036afa5417999e0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/landing.js\":\"48bed75348e39e92\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/outline.js\":\"1137a7b9a803e01e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/seed.js\":\"d19cf9fad56e836d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/PerfTrendDialog.js\":\"5d8cb5ac4dc1e272\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/analyze.js\":\"f314bf9c1fd71804\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/diagnosticsSource.js\":\"3c196d498bb3962a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/index.js\":\"b38fdbc7737af47d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/load.js\":\"b445023e48025fd9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/monitorRun.js\":\"e363f366230e4e04\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/schedule.js\":\"4006f68aef0ad732\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/series.js\":\"cca475ea87b8708d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/store.js\":\"dc7c6c30052f0647\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/trendAction.js\":\"a91c504725a1e7e1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/verdict.js\":\"a9e63a1c49bbf8e1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/plain-outliner/clickToEditAction.js\":\"fe0d292ceef0f8e1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/plain-outliner/index.js\":\"b7ec515492c5c233\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/plain-outliner/interactions.js\":\"085a06e8f42aeb11\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"8ab23f54dba70239\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/MigrationGate.js\":\"ca1307e931f00415\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/MigrationGateDialog.js\":\"4e9dcd427036a978\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/action.js\":\"cb89f4ad0801d664\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/index.js\":\"a76a3cb6efac1b18\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/localRunMessage.js\":\"28b96378d37ea934\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/plugin.js\":\"d3e8314c063ae464\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/progressReport.js\":\"38e1faf81d67cf48\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/sweepProgress.js\":\"d5becaeb94202976\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/FieldRowRenderer.js\":\"a2850c6013e5dc40\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/ValueRowRenderer.js\":\"98ef66e7588ce46b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/actions.js\":\"9a9fca8ab9164012\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/autocomplete.js\":\"8901172c95911655\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/fieldRow.js\":\"c2b1417e2c13e902\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/index.js\":\"ebf17c7b0a0a519d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/referenceWarning.js\":\"5c00b59d4094936b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/valueAutocomplete.js\":\"016c625b836bb2cf\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/valueSchema.js\":\"1238ce5ef21011be\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/quick-find/HeaderItem.js\":\"8839bd698fb1737b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/quick-find/QuickFind.js\":\"75c78222075be7ee\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/quick-find/index.js\":\"48ef78c5f3578fed\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/quick-find/recents.js\":\"9f658672b9ecc2a4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/quick-find/resultItems.js\":\"d2d30c2466a605b4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/quick-find/selection.js\":\"6ac999e51bb87e89\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/quick-find/toggleStore.js\":\"a00fba9b027d835d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/recents/HeaderItem.js\":\"58cb1c1cc91ed6ba\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/recents/RecentsPageBlockRenderer.js\":\"b1cdce1bfc9d611f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/recents/grouping.js\":\"2453372e44988df1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/recents/index.js\":\"d521b6d2dba84547\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/recents/target.js\":\"d263c017b42af246\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/codeMirrorExtensions.js\":\"22d4846c3c330192\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/contentPrefill.js\":\"c2005fb762d2aeab\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/dataExtension.js\":\"9aafcb4bec0fee24\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/index.js\":\"fbcc4228ac2a9f17\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"8022f28fb8e784b1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/invalidation.js\":\"ecd13f8c69f3ffc6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/localSchema.js\":\"3fbc2f496c7aaa55\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/blockrefs/index.js\":\"cddb2fe29ec4e367\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"8c9fca354bd0d039\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/index.js\":\"1278e36ae068ccb9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/referenceNode.js\":\"7c9b5243587d5b08\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/remark-reference-occurrences.js\":\"956695ecd1c8ffd0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"400a8f3ff042cd16\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/wikilinks/index.js\":\"daf096a91b355bae\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"d8b0fe0bf560a698\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"616f2029dde2e7f0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/mergeRetargetProcessor.js\":\"67c04714a87bcaf1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/parseFence.js\":\"632c8d31d9f3d358\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/referenceParser.js\":\"c58a9ddd5e18a486\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/referenceProjection.js\":\"e545670b469b6ee1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/referencesProcessor.js\":\"f34b0d72075a8469\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/renameProcessor.js\":\"17779cb4a135b57c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/spanReplacement.js\":\"d4a9f37c7288a937\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/rich-paste/htmlToOutline.js\":\"8d7736fefcbd7bcb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/rich-paste/index.js\":\"91e64e0cba5ecffb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/rich-paste/normalizeClipboardDom.js\":\"c906bbdfe1907192\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/rich-paste/pasteDecision.js\":\"879e37a8e7f4e6f1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/action.js\":\"8bd9bc432fef26ac\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/blockIds.js\":\"c9ecacec3a9e4ef2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/content.js\":\"8c306d989cffe68b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/effect.js\":\"26bd253596122509\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/ids.js\":\"89862bb1a06cec8c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/import.js\":\"874e8fc10b4ec0c5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/index.js\":\"b996a264c84825e7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/plan.js\":\"dd4bc8029325fafc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/plugin.js\":\"98bd1a89f1167828\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/promotion.js\":\"ffd7279498e248dd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/properties.js\":\"0b430a9f95a3b53f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/references.js\":\"1978f43e1a93d349\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/report.js\":\"7b09833d3f32989e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/roamMemo.js\":\"859f79a7db74523a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/runtime.js\":\"b1d85309ff22961f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/schemaReconciliation.js\":\"10d4705c49f0f119\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/srsMarkers.js\":\"fd9be5b94dd4bf81\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/todo.js\":\"10b8f8faccb2262b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/typeCandidates.js\":\"40cb9ef0a2a9faf1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/types.js\":\"16a8dc6952a286a6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/search-health/index.js\":\"1239d3f15a2691ba\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/search-health/store.js\":\"fccef703dc0af8a7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/shortcut-help/HeaderItem.js\":\"c716cf3095756608\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"9c64117ad3eaa464\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/shortcut-help/index.js\":\"0d48dc9ec6590a2f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/shortcut-help/model.js\":\"cd24ec48212f1059\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/shortcut-help/toggleStore.js\":\"554f6d654ed07538\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/shortcut-help/useKeyInspector.js\":\"ad3b704566f351d7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"26d7c905cb03fbba\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/spatial-navigation/ShellDecorator.js\":\"53c45f37c914c944\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/spatial-navigation/actions.js\":\"a1cfc5676d2eb2e1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/spatial-navigation/exclusionsFacet.js\":\"493933715b9fb423\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/spatial-navigation/index.js\":\"a2ce5156514ba24f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/spatial-navigation/shell.js\":\"b8e0c3220798a74f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/spatial-navigation/surface.js\":\"04fd69cd7d25d67a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/spatial-navigation/walker.js\":\"7543e9d41319fc36\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/RescheduleToast.js\":\"ad9005edbc9a42b5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/dataExtension.js\":\"a0d0add14e765c7d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/index.js\":\"2f4595121325c370\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/indicator.js\":\"55c301e8470ed9a3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/moveSrsState.js\":\"e1c0f91179f8f43b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"b1837d7644f012ab\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/scheduler.js\":\"50675479681f3959\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/schema.js\":\"b6ce688da9a8b84f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"e163f3119a81041b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/srsClipboard.js\":\"ef467a73358ab64a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"7dd7bd96581f92fb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/DailyNoteReviewHint.js\":\"2f76d43530d0f1b6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/DeckPicker.js\":\"dcb4013e42c72d0f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/ReviewControls.js\":\"2579c7916a48c40d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/ReviewDeckRenderer.js\":\"38012744026c3903\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/ReviewSession.js\":\"20eb9c1c4478a44c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/actions.js\":\"99cf633100036e85\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/archive.js\":\"a40ba80b4f6ad5ce\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/dataExtension.js\":\"f38c75c8218325ca\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/deck.js\":\"61a5f63af2a7ae9d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/dueQuery.js\":\"9913ce33ca4554b4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/gradeDecision.js\":\"e1679f9df53bab4d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/index.js\":\"33691b1473c2b37b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/keyHints.js\":\"ef4152c12c21751d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/reviewCardLayout.js\":\"f2808293e76a4958\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/reviewProgress.js\":\"b0ca346fcb795459\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/schema.js\":\"02caa4e692982874\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/useDueCards.js\":\"d34e196c2f9a510a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/startup-metrics/index.js\":\"b67dd0b4a5538bac\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/startup-metrics/record.js\":\"dd59dbdee0a47d50\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/storage-persistence/index.js\":\"2fea757e7dff83f9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/storage-persistence/persistenceStatus.js\":\"14ccba741fec934e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/storage-persistence/requestAction.js\":\"d5455eb617f125d5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/supertags/TypeChipsDecorator.js\":\"ed9542be1d9fdf32\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/supertags/codeMirrorExtensions.js\":\"a5b9e591472fca6b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/supertags/index.js\":\"74baa4d73dc35ff7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/supertags/typeAutocomplete.js\":\"535a9dd7c747a49a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"e1d7dc5f930309d0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/swipe-quick-actions/actions.js\":\"8d0c5192bb5ddc2f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/swipe-quick-actions/anchor.js\":\"affc059aba9a4c54\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/swipe-quick-actions/events.js\":\"dd5c96e628b3ad00\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/swipe-quick-actions/gestureActions.js\":\"4841b79512c7e3b4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/swipe-quick-actions/index.js\":\"1c665300074534e2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"f6fcae1e60ba87dd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/sync-metrics/collect.js\":\"85a3444bdc887503\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/sync-metrics/index.js\":\"a7e148e621cba5b0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/sync-metrics/record.js\":\"594437ba783ec44a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/system-status/RejectionDialog.js\":\"f58e99ae8a68776c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/system-status/SystemStatusHeaderItem.js\":\"df4cb0c9a8cffcaa\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/system-status/index.js\":\"e7c21de7b2da14cd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/system-status/model.js\":\"068912212a2d8f1b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/system-status/queueCounts.js\":\"df3c7193e8f87372\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/system-status/rejectedHelpers.js\":\"d48e45347c3ce014\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/system-status/rematerializeAction.js\":\"567290a379a001b3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/system-status/useHysteresis.js\":\"d3f1a1b2d8a8ff34\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/ColumnHeaders.js\":\"e16aaf81bbff280a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/QueryUi.js\":\"7235d0480e718005\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/TableLayout.js\":\"4585ee097524dee1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/actions.js\":\"301ac40618ee3563\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/cellEdits.js\":\"d5ece1a2cfe15aab\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/childrenViews.js\":\"6b42680cc87230bd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/columns.js\":\"0293d8a4c6d44fa7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/controller.js\":\"68ad9df1b74d4f40\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/convert.js\":\"7d02e43a4c5497e4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/dataExtension.js\":\"32c7135b1a65e12f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/index.js\":\"7f13baccaa945e1f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/keys.js\":\"7afc918cb1c3cac6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/model.js\":\"92b86337b3310402\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/query/QueryText.js\":\"c1125966219b0ffc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/query/backfill.js\":\"3b981d92564a15ba\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/query/completion.js\":\"9e809958bcea5796\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/query/format.js\":\"0247412122722e22\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/query/parse.js\":\"f24b63827cd3c899\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/query/queryValue.js\":\"a32eb36bf04dbf3d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/query/registrations.js\":\"092f18a99757be34\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/query/source.js\":\"bb60c7fa66cf1eea\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/registry.js\":\"455ba7406d1295b5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/rowGutter.js\":\"08b4e33fe7d3cc47\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/rowVerbs.js\":\"9868b7d6160021de\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/schema.js\":\"07c0d5883a51ffe1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/sort.js\":\"64b171862f319f16\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/theme-toggle/effect.js\":\"d64dfef2bcac56ad\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/theme-toggle/index.js\":\"7c774e979a8ad985\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/theme-toggle/theme.js\":\"23147282c6153e03\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/todo/actions.js\":\"d0d432a854b3755b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/todo/dataExtension.js\":\"9983a9c8d356aa46\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/todo/index.js\":\"6827be6ea0bb4049\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/todo/schema.js\":\"1712af7246c56f12\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/touch-selection/TouchSelectionLayer.js\":\"ed4062fc8e30e19a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/touch-selection/actions.js\":\"a7ed671169b0382b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/touch-selection/defaultItems.js\":\"fb69be347ecb3832\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/touch-selection/facet.js\":\"9ebca07e0d92c9c2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/touch-selection/holdRecognizer.js\":\"2ee3d5cfed577c35\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/touch-selection/index.js\":\"98b400e1cc506c03\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/update-indicator/UpdateIndicator.js\":\"9a8cb615bff6551b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/update-indicator/index.js\":\"c6ccae455f30c50f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/update-indicator/loadTimes.js\":\"86b87bb4ed97f614\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/VideoNotesRenderer.js\":\"000e6641c794e793\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/VideoPlayerRenderer.js\":\"36e630cfe42ea4d4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/VideoTimeStamp.js\":\"f0facb6ce948e93d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/actions.js\":\"b20877b4aa7e5418\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/index.js\":\"f6a1ee64d4e877f0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/markdown.js\":\"f22cb2054a43d23f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/notes.js\":\"41618630a0ccfe83\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/registry.js\":\"bd34e762a52be136\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/remark-timestamps.js\":\"b23ab46b9796b21d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/view.js\":\"237874c64ece08d0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/vim-link-hints/LinkHints.js\":\"3e7f7315180e6fb4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/vim-link-hints/index.js\":\"218dabc2c064c30e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/vim-link-hints/model.js\":\"0893210c39a71ebb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/vim-link-hints/settings.js\":\"4113ce60cb5b0fdb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/vim-normal-mode/actions.js\":\"41a57fcef8be9b65\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/vim-normal-mode/index.js\":\"315ed6cf356b0a05\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/vim-normal-mode/interactions.js\":\"a2e0e8c5c27898ec\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/workspace-header/index.js\":\"dd46bed4a05fc516\",\"/knowledge-medium/pr-preview/pr-1925/src/registerServiceWorker.js\":\"5917280c96f9bdf1\",\"/knowledge-medium/pr-preview/pr-1925/src/requestPersistentStorage.js\":\"d9cd99af4d2f60e4\",\"/knowledge-medium/pr-preview/pr-1925/src/services/authRequestDeadline.js\":\"58c6c13c0a33dac5\",\"/knowledge-medium/pr-preview/pr-1925/src/services/authStorage.js\":\"9c0a97e729921712\",\"/knowledge-medium/pr-preview/pr-1925/src/services/powersync.js\":\"b2dd5bedf1804e1e\",\"/knowledge-medium/pr-preview/pr-1925/src/services/supabase.js\":\"9960c482a05df33a\",\"/knowledge-medium/pr-preview/pr-1925/src/services/uploadErrorClassifier.js\":\"aa5e8fb269c4dee7\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/ActiveContexts.js\":\"f0cd8fd1aa00dc92\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/HotkeyReconciler.js\":\"1b45588209549eda\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/WipeLocalDataDialog.js\":\"9abcc57735c42080\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/actionDispatch.js\":\"ed2bd94fec4e8996\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/actionKeyHints.js\":\"986355ebcd229ad5\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/actionRefItems.js\":\"31d4b054ff147b0d\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/applyKeybindingOverrides.js\":\"14c821be2403fd1d\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/blockActions.js\":\"77da1f4327cf1537\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/blockMergeGesture.js\":\"67ec42d95e535d5f\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/canonicalizeChord.js\":\"706de3a0c8d82b2c\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/defaultContexts.js\":\"7131ccc826fb944d\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/defaultShortcuts.js\":\"a81ced0f34db27ed\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/effectiveActions.js\":\"e365cbe5761b2e37\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/formatChord.js\":\"d0ea6cc8bfe9b186\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/gestureAction.js\":\"7f0a33dc0507da96\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/gestureBinding.js\":\"25bd66668dfc6125\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/holdRegistry.js\":\"3989449946ab594c\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/keybindingConflicts.js\":\"88682fab2c578416\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/keybindingOverrides.js\":\"0171b48d7fd78870\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/pointerAction.js\":\"17e506230650e5d0\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/resolve.js\":\"74ad5edcb2e00b29\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/runAction.js\":\"27f3e40c8597b55b\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/sequenceMatcher.js\":\"839f21c654c0633e\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/types.js\":\"072076ecc8311ade\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/useActionContext.js\":\"5912f9c488d93e5c\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/useActionDiscovery.js\":\"80875952425085ca\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/utils.js\":\"ac99e26e1d774574\",\"/knowledge-medium/pr-preview/pr-1925/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1925/src/sw/bootStore.js\":\"e7d95ec7da0aa53e\",\"/knowledge-medium/pr-preview/pr-1925/src/sw/previewDatabases.js\":\"2350e9988980de08\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/byteTransform.js\":\"546acc4af0c8d979\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/attachmentCleaner.js\":\"e5832c38b8e1da3d\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/bundle/attachmentParts.js\":\"c26957e26b8ae8d9\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/bundle/bundleParts.js\":\"e19fd84e66d079c9\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/bundle/bundleRecord.js\":\"cd287d82cdff6d59\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/bundle/manifest.js\":\"ab7ee7d33ed51e54\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/bundle/takeBundle.js\":\"10e33a4e8242de2b\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/bundle/verifyBundle.js\":\"4f612be450d77434\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/cleaningStage.js\":\"11211a5baebd0963\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/conversionKey.js\":\"64e34e52317a36d6\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/conversionServer.js\":\"b30a115a2ad83a2d\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/flip.js\":\"2dce3b62f895f186\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/flipAttempts.js\":\"a2f3e0d9233147b2\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/pages.js\":\"691301d3389b9ab9\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/preflight.js\":\"e6f8f1800b4fadac\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/reseal.js\":\"71979c2206e2cacf\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/runConversion.js\":\"ed35e0cec8dab547\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/runLock.js\":\"5fc03b645db9865d\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/sealing.js\":\"384776dd25287c82\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/sealingStage.js\":\"b8526a36d0455313\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/stage.js\":\"f651ea67a13c9b4a\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/verifyReseal.js\":\"91436c3e85359c0f\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/aad.js\":\"12497a50686b35d5\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/aead.js\":\"120f591f3ef2e9a1\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/base32.js\":\"d397d033504d0b18\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/base64url.js\":\"af997b2ccd127872\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/binaryEnvelope.js\":\"300e24dfacfc5261\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/byteAead.js\":\"e51a3f7a06b31eae\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/canary.js\":\"2636ea4fcb9565b6\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/contentHash.js\":\"6178b12c4adfb355\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/contentKey.js\":\"786df4903f836863\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/derivedIdNamespace.js\":\"9e2182d9f8d1817d\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/envelope.js\":\"151203c96653cedd\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/hex.js\":\"8d5934467e66cf31\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/sha256Hex.js\":\"3537c9e4d7d4b96c\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/workspaceKey.js\":\"528280249f998bea\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/conversionState.js\":\"5e275b9e0958998c\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/flows/createEncryptedWorkspace.js\":\"0427af114458b7a7\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/flows/pastedKey.js\":\"af5d949e9633e0cb\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"8089c35439a360b8\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/flows/upgradeWorkspacePin.js\":\"00b086e3231d3b6f\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/keyStore.js\":\"fc77dab58082e48c\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/mintWorkspaceKey.js\":\"e585d99b79d62edb\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/modePin.js\":\"e3cdb7b78b9f3e5c\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/openWorkspaceKeys.js\":\"c4b25dec01c83fae\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/resolveWorkspaceEntry.js\":\"4f8c7cfa327d4c53\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/resolver.js\":\"4fc5d624b2095958\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/workspaceAccess.js\":\"f1462ee6053fc9df\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/transform.js\":\"a06727859970f048\",\"/knowledge-medium/pr-preview/pr-1925/src/themeBootDefaults.js\":\"78ff59cd64c2febe\",\"/knowledge-medium/pr-preview/pr-1925/src/types.js\":\"06fe66222b6739bc\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/ClientLocalSettings.js\":\"49049bc499ed9783\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/abortableSleep.js\":\"18c84dc7823cf8a7\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/array.js\":\"43ad779c8aa0c2fc\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/backlinkAutocomplete.js\":\"14da587f39f6fcbc\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/blockCrumbs.js\":\"e1726d721408dfc0\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/blockrefAutocomplete.js\":\"e84ad2f35a0ead7c\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/cadencedIdleJob.js\":\"87c492c6c0f203c1\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/callbackSet.js\":\"81925adba9559f01\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/clientId.js\":\"0da64e0596d23ade\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/codemirror.js\":\"1a7232d77267e237\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/codemirrorCompletion.js\":\"fbe723f5f371b106\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/copy.js\":\"f6b201f63e7fb46d\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/dailyPage.js\":\"93feca9012c1076e\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/dbForensics.js\":\"f2153eb890ae9c58\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/dbForensicsHooks.js\":\"f28632403fb9284e\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/deleteBlockThroughUi.js\":\"33d1ab3e2269b442\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/dialogs.js\":\"25383768a5c7287a\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/dom.js\":\"a69827c4c46a757e\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/downloadBlob.js\":\"16b9fcbf52cf14c1\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/drawnWalk.js\":\"bbc83ad895be4064\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/exportSqliteDb.js\":\"3ea28c297bb3ac11\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/fileSystemAccess.js\":\"ff7c4e0dc7a76791\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/flipSlide.js\":\"7e0c9f8fa453d98c\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/fnv1a.js\":\"b27d958f9196680b\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/formatBytes.js\":\"de2439439e4941d4\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/fuzzyRank.js\":\"2b9e5586d5d4eecc\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/idbKeyedStore.js\":\"0e84f02006beb17d\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/idleCallbackPolyfill.js\":\"6c64bf4ea5efb8c5\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/keyboardAwareScroll.js\":\"a42455bdec16ca64\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/keyboardViewport.js\":\"baa391af103b35d7\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/lastWorkspace.js\":\"fa7a0c8f3fb8748b\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/layoutColumns.js\":\"f470095860aa12c0\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/layoutSessionDom.js\":\"b5feb0f40aaf298c\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/layoutSessionId.js\":\"347367c240b02e04\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/linkClickGestures.js\":\"54b6d12ebe86d0df\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/linkTargetAutocomplete.js\":\"3518e3d1e7245792\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/localDbCorruption.js\":\"40f4117ad66e1640\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/localDbRecovery.js\":\"f18b4a4a18588557\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/markdownParser.js\":\"a2517bbf3a8aad9b\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/memoize.js\":\"fb80c0fbd5dccf23\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/nameFieldCommit.js\":\"3e97214a6c32becb\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/nameList.js\":\"2ff5d04bfc47da38\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/navigation.js\":\"5f13f4dbe30e3fdf\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/omnilinerNamespace.js\":\"ea40975d11cd8d51\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/opfsPageScan.js\":\"38e67e873e1061ae\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/panelClearance.js\":\"61763cf86b0cd547\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/panelHistory.js\":\"3779d376a20316a4\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/panelLanes.js\":\"632bac95c47a8fee\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/panelLayoutProjection.js\":\"1e7db43a92c46f7f\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/panelScrollAnchor.js\":\"324dcbb89440a4ce\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/panelUrlFlags.js\":\"5abe6573fcaecea9\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/platform.js\":\"88759305f824d4c0\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/pluralize.js\":\"6f5dca4c7777128e\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/propertyCreation.js\":\"7731484fff2a9072\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/propertyNavigation.js\":\"4a1733b4bafb1207\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/propertyValueContext.js\":\"cddca47874f8e10d\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/react.js\":\"0b060f8ecae75e06\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/relativeDate.js\":\"6a622397f0f981a4\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/relativeTime.js\":\"d281fdda97b3b409\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/renderScope.js\":\"1b22da0b4da483a7\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/resolvedThenable.js\":\"d1a1b31ee4ea9b8f\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/routing.js\":\"c6bb011ed16a611c\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/safeMode.js\":\"69c581b75002f452\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/scheduleIdle.js\":\"a687d72a36c4caf3\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/screenWakeLock.js\":\"c3e291da1cd4cc8f\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/selection.js\":\"a228fda86415d164\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/softKeyboardGrab.js\":\"ec73b5abb16ac3c2\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/startupTimeline.js\":\"aad9b1d3bceccb2b\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/state.js\":\"9bd7bad596edf386\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/string.js\":\"6c442f8eef9c5359\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/surfaceZoom.js\":\"7022a5113d846a14\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/time.js\":\"9cf44a6e5eeb02e2\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/toast.js\":\"5877d0094c756570\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/toggleStore.js\":\"bd1cdb7568333264\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/untilStopped.js\":\"bbbeeb7d2badb926\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/userActivity.js\":\"c7f7a9cd05888abb\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/viewTransition.js\":\"839d7e0d2e825d01\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/viewport.js\":\"152cf67abaea5e41\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/webLock.js\":\"192751f6ec0d0c10\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/workspaceRecovery.js\":\"ad4212f0decdfc0c\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/workspaceSnapshotStore.js\":\"bf664953a651c2e5\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-compiler-runtime.js\":\"e66c3b617e72691c\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-dom-client.js\":\"618aa9c37d75ef01\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-dom-server-edge.js\":\"4e44946e3335ef49\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-dom-server.js\":\"8e43510cc5eff017\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-dom-static-edge.js\":\"240800fcc9b433de\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-dom-static.js\":\"e037e3a2755dcace\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-dom-test-utils.js\":\"71c00f67e9dc0061\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-dom.js\":\"75054df903ba67c9\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-jsx-runtime.js\":\"fa9b52397daff1fc\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react.js\":\"a32db9aad3655db5\",\"/knowledge-medium/pr-preview/pr-1925/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1925/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1925/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
