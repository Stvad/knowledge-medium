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
		buildId: "127029934a4a-6321df61",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1925/\":\"a550f94c9f6702d6\",\"/knowledge-medium/pr-preview/pr-1925/index.html\":\"a550f94c9f6702d6\",\"/knowledge-medium/pr-preview/pr-1925/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1925/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1925/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1925/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1925/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1925/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1925/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1925/assets/FacadeVFS-UqkQmcF2.js\":\"19a7bacbaa239c4b\",\"/knowledge-medium/pr-preview/pr-1925/assets/OPFSCoopSyncVFS-B5lcVDXt.js\":\"2b5f4faab885a312\",\"/knowledge-medium/pr-preview/pr-1925/assets/OPFSWriteAheadVFS-BvJp6tWo.js\":\"0dacd265bb208c60\",\"/knowledge-medium/pr-preview/pr-1925/assets/wa-sqlite-CZzDLRmi.js\":\"de99cbc7ce174a11\",\"/knowledge-medium/pr-preview/pr-1925/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1925/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1925/assets/wa-sqlite-async-C2Wp0erQ.js\":\"bb1fb700b13493b9\",\"/knowledge-medium/pr-preview/pr-1925/assets/worker-CAg0Ezas.js\":\"3153e78fc220408b\",\"/knowledge-medium/pr-preview/pr-1925/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1925/chunks/app-DENLERP0.js\":\"c02644753558c42f\",\"/knowledge-medium/pr-preview/pr-1925/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1925/index.js\":\"665cfd51ea3aa5bf\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1925/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1925/assets/AccessHandlePoolVFS-DapMNzXS.js\":\"8dd92e753a8b1740\",\"/knowledge-medium/pr-preview/pr-1925/assets/IDBBatchAtomicVFS-BNOaG816.js\":\"bd9068cae858888f\",\"/knowledge-medium/pr-preview/pr-1925/assets/MemoryVFS-DPRNBzV8.js\":\"abeda537707329da\",\"/knowledge-medium/pr-preview/pr-1925/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1925/assets/mc-wa-sqlite-D1Oe8RDV.js\":\"96f4368f02ea8371\",\"/knowledge-medium/pr-preview/pr-1925/assets/mc-wa-sqlite-async-DsPoeweY.js\":\"956fd2d5a513c7ff\",\"/knowledge-medium/pr-preview/pr-1925/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1925/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1925/chunks/AccessHandlePoolVFS-CAoZgkwR.js\":\"6d2f0a04fa1e3fc9\",\"/knowledge-medium/pr-preview/pr-1925/chunks/FacadeVFS-A6PnI3ox.js\":\"01b6406d1ec7b153\",\"/knowledge-medium/pr-preview/pr-1925/chunks/IDBBatchAtomicVFS-BhIolHor.js\":\"d624d784f751e6e6\",\"/knowledge-medium/pr-preview/pr-1925/chunks/MemoryVFS-Dnuqjm8C.js\":\"79a67150b7415287\",\"/knowledge-medium/pr-preview/pr-1925/chunks/OPFSCoopSyncVFS-B10HUYTZ.js\":\"57e2b5f7d77d6e12\",\"/knowledge-medium/pr-preview/pr-1925/chunks/OPFSWriteAheadVFS-D15GXhsd.js\":\"dd3dcb2adcdc5acb\",\"/knowledge-medium/pr-preview/pr-1925/chunks/Preview-BFdQPC8p.js\":\"d11f59866562e74d\",\"/knowledge-medium/pr-preview/pr-1925/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1925/chunks/card-Clrrzh5I.js\":\"008c22d4c9d75fc9\",\"/knowledge-medium/pr-preview/pr-1925/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1925/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1925/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1925/chunks/dist-D5iloTmO.js\":\"2f0217e9f29ef6c8\",\"/knowledge-medium/pr-preview/pr-1925/chunks/freezeExtensionImports-_LMILIOU.js\":\"0a974c8696192406\",\"/knowledge-medium/pr-preview/pr-1925/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1925/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/pr-preview/pr-1925/chunks/mc-wa-sqlite-BqzrwCH3.js\":\"33ee09053e5f1586\",\"/knowledge-medium/pr-preview/pr-1925/chunks/mc-wa-sqlite-async-jsg6LZLF.js\":\"9828e63f42c41444\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-C4I_MsPM.js\":\"21bdbcc7edac0e00\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-CC8djcny.js\":\"e4785ccae02831b4\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-CUmqitf8.js\":\"826ad2fde7d90f2b\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-D-us3zJX.js\":\"1dd24e985ebb7bc1\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-DQjqdW6V.js\":\"a5e2576b89020858\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-dom-server-legacy.browser.production-CRqjuOU0.js\":\"277e0b8151f37001\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-dom-server.browser.production-CpeKF9V9.js\":\"faea313ab790a6f4\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-dom-server.edge.production-CMuDRX-6.js\":\"f3c7156d804d6f4f\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-q0gm6oVg.js\":\"e0b4b10a35601e19\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-sxPZElH_.js\":\"6bb70566be95172c\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-t_tEXUY8.js\":\"37535a0c439279b3\",\"/knowledge-medium/pr-preview/pr-1925/chunks/server.browser-D-niHKQM.js\":\"01db16f5ab047540\",\"/knowledge-medium/pr-preview/pr-1925/chunks/textarea-DPxjOVgV.js\":\"0af234f8db586abb\",\"/knowledge-medium/pr-preview/pr-1925/chunks/ui-Dz8T52EX.js\":\"aef64b730533d56c\",\"/knowledge-medium/pr-preview/pr-1925/chunks/wa-sqlite-CwRJLjPI.js\":\"110c0baeee81ab78\",\"/knowledge-medium/pr-preview/pr-1925/chunks/wa-sqlite-async-DudyhuEa.js\":\"03fc0fdbd1d979b9\",\"/knowledge-medium/pr-preview/pr-1925/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1925/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1925/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1925/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1925/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1925/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1925/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1925/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1925/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1925/src/App.js\":\"20d8087b47d66191\",\"/knowledge-medium/pr-preview/pr-1925/src/appUpdate.js\":\"960b2fc96ec70ff9\",\"/knowledge-medium/pr-preview/pr-1925/src/appVersion.js\":\"a527d6974244079b\",\"/knowledge-medium/pr-preview/pr-1925/src/bootstrap/initialLayout.js\":\"1efcc5020aed4c6a\",\"/knowledge-medium/pr-preview/pr-1925/src/bootstrap/openWorkspaceData.js\":\"553472bd3b547589\",\"/knowledge-medium/pr-preview/pr-1925/src/bootstrap/resolveWorkspace.js\":\"7c0968ac2e263547\",\"/knowledge-medium/pr-preview/pr-1925/src/bootstrap/workspaceBootstrap.js\":\"f6b5f61150118646\",\"/knowledge-medium/pr-preview/pr-1925/src/components/BlockComponent.js\":\"6bed4b119dfeebf0\",\"/knowledge-medium/pr-preview/pr-1925/src/components/BlockCrumbs.js\":\"b85af00f3e1ca005\",\"/knowledge-medium/pr-preview/pr-1925/src/components/BlockEditor.js\":\"a60c8e7e2b9af09e\",\"/knowledge-medium/pr-preview/pr-1925/src/components/BlockLoadingPlaceholder.js\":\"7891d5f5e307003c\",\"/knowledge-medium/pr-preview/pr-1925/src/components/BlockProperties.js\":\"a359d1affc3cb79b\",\"/knowledge-medium/pr-preview/pr-1925/src/components/BlockSearchPicker.js\":\"7f7b968f5eb14faf\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ConfirmBulkDeleteDialog.js\":\"65ef1ebfee43a999\",\"/knowledge-medium/pr-preview/pr-1925/src/components/DividerHandle.js\":\"452e6c149e5beca6\",\"/knowledge-medium/pr-preview/pr-1925/src/components/DraftEditor.js\":\"76ed4cf396998849\",\"/knowledge-medium/pr-preview/pr-1925/src/components/GutterPill.js\":\"59274c18c1010a2e\",\"/knowledge-medium/pr-preview/pr-1925/src/components/Header.js\":\"fbbdcc241ac77170\",\"/knowledge-medium/pr-preview/pr-1925/src/components/LazyBlockComponent.js\":\"2a8f5455b3403346\",\"/knowledge-medium/pr-preview/pr-1925/src/components/Login.js\":\"1739befb35fdaefe\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ZoomableSurface.js\":\"4f05ef923b1b25dc\",\"/knowledge-medium/pr-preview/pr-1925/src/components/editModeKeepalive.js\":\"13e954a535c26629\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyDisplay/PropertyDisplayScope.js\":\"7006f0be47fe2420\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"7fdf8d1847f4a4aa\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/RefPropertyEditor.js\":\"133a270a79914308\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/RefTargetTypePicker.js\":\"4cf1dfb1f6ea136b\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/SelectPropertyEditor.js\":\"32b181f790838840\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/TypesPropertyEditor.js\":\"f63e60a1fd425d0e\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/defaults.js\":\"78eed5da65288679\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/kernelValuePresets.js\":\"0ed8c6d259f5b911\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/selectablePresets.js\":\"3a0db12117f8c572\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/typesPropertyUi.js\":\"0de97356dea4b35b\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/AddPropertyForm.js\":\"90389a893a6a9aa2\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/PropertyPicker.js\":\"8de37624b76d915f\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/PropertyRow.js\":\"a781d4db08b63061\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/Rows.js\":\"84ed7daaf4e8231d\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/actions.js\":\"c3b7280c8596f9c6\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/declarationOnly.js\":\"c3055c7e47999396\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/layout.js\":\"c834461f6cebf2be\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/model.js\":\"a8a5722fca215e0c\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/shapeUi.js\":\"a51cfb56b109525a\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/shapes.js\":\"32e8246c840d13ab\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/usePropertyEditingActivation.js\":\"58ec925a7d320c89\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/visibility.js\":\"fa30b66784ec2d2d\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanelSections.js\":\"77cdc496ac3f7259\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/BlockEmbed.js\":\"2ee29ac6722e86c1\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/BlockLink.js\":\"3e28e61063b69fb2\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/BlockRef.js\":\"fbc90d7bc94a2217\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/CompactReferenceLink.js\":\"8639fdb020193b39\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/ReferenceLink.js\":\"9e6d571f0e282ed4\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/cycleGuard.js\":\"817cce49c6ac960c\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/cycleGuardContext.js\":\"3905bbc8f6964d06\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/linkInteraction.js\":\"a23f68a8ba0f9a1f\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/referenceLayout.js\":\"aa85c5ea54fb23be\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/useBlockRefAncestors.js\":\"9e35ebaf4b226734\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/BlockGutter.js\":\"80764304de743d13\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/BlockInfoDialog.js\":\"32b233b31b70edd5\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/BlockReadText.js\":\"983be8cbe4388e34\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/BlockTypeBlockRenderer.js\":\"ab603d1b8c9018e5\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/BulletHoverCard.js\":\"70804b5a414e4e80\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/CodeMirrorContentRenderer.js\":\"a8ed11b55d54c877\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"579c92f6710581cb\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/ColumnResizeHandles.js\":\"a2c51249b69dbb42\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"3e11b8c60f70ee14\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/DefaultBlockRenderer.js\":\"e4c0f926e264c208\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/LayoutRenderer.js\":\"d6b5a19970dab63e\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/MarkdownContentRenderer.js\":\"bbca423178c76b92\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/MissingDataRenderer.js\":\"69640a5caae597ef\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/PanelRenderer.js\":\"3d0a7ff71c80c374\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/PropertySchemaBlockRenderer.js\":\"4bf0344c3028a3ba\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/TopLevelRenderer.js\":\"f1323335a958d4a3\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/blockGutterMode.js\":\"cd0f9b580048f08c\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/blockTitleText.js\":\"b540683d9868ff9e\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/fieldCreationKeydown.js\":\"077b4a04f74c0ef7\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/layoutRootContext.js\":\"0129f9d4bd4b988e\",\"/knowledge-medium/pr-preview/pr-1925/src/components/typeChip/TypeChip.js\":\"bb7ccccd520bf3b0\",\"/knowledge-medium/pr-preview/pr-1925/src/components/typeChip/chipStyle.js\":\"a889e66d0a4d6044\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/anchored-floating.js\":\"2d61adb7e525cf32\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/button.js\":\"7fc0cf643a2e726c\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/card.js\":\"1246052911d925d1\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/checkbox.js\":\"c516313ec2c3b0d3\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/collapsible.js\":\"75d183b8562fcdb7\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/command.js\":\"08f0f8dc52b7fb3f\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/context-menu.js\":\"5173f239f9db8415\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/dialog.js\":\"bf5b7b7bc4837cc0\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/dropdown-menu.js\":\"1870b16448b6c267\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/floating-listbox.js\":\"97b22a9e184f50f4\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/index.js\":\"d94f1a1767295e00\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/input.js\":\"2191a7c8e56d2871\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/kbd.js\":\"2149889f19605949\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/label.js\":\"a9700355ecc37002\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/textarea.js\":\"13c4219f975b0aaf\",\"/knowledge-medium/pr-preview/pr-1925/src/components/useEditModeYieldKeepalive.js\":\"cee97cad8d1f3a68\",\"/knowledge-medium/pr-preview/pr-1925/src/components/util/BootFallback.js\":\"17e7793b9af351d8\",\"/knowledge-medium/pr-preview/pr-1925/src/components/util/FocusedRowLazyMount.js\":\"5e0b25eb479eb45f\",\"/knowledge-medium/pr-preview/pr-1925/src/components/util/LazyViewportMount.js\":\"650189492198452b\",\"/knowledge-medium/pr-preview/pr-1925/src/components/util/LocalDbCorruptionFallback.js\":\"2fe062a4c0364fc6\",\"/knowledge-medium/pr-preview/pr-1925/src/components/util/error.js\":\"af91f70a416035dc\",\"/knowledge-medium/pr-preview/pr-1925/src/components/util/lazyMountRegistry.js\":\"c43ff972decb364d\",\"/knowledge-medium/pr-preview/pr-1925/src/components/util/suspense.js\":\"8847066f8c695ddc\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/CreateWorkspaceDialog.js\":\"7497e315f0b400b7\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/PendingInvitations.js\":\"688357dbcb329b24\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/SyncProgress.js\":\"52396889914f9d52\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/UnlockProgress.js\":\"875d4a0eb7125b8f\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/WorkspaceKeyGate.js\":\"1fbe6a725b81f4e5\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/WorkspaceSettingsDialog.js\":\"15406701b8a8ee04\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/WorkspaceSwitcher.js\":\"aa70ea3ffc98109a\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/WorkspaceSyncGate.js\":\"1c1471cf2a26a28e\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/ConversionFlow.js\":\"537eea34c60b30d2\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/ConversionFlowHost.js\":\"68e53fe3bc776b80\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/EncryptionSection.js\":\"4e9592099cbb61b3\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/attachmentPrompts.js\":\"3ba6dd3c9d09cded\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/bundleFolderPrompts.js\":\"c3acc78022c72deb\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/conversionFlowDeps.js\":\"a15fc6f8835d013e\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/conversionFlowStore.js\":\"16f3be7aaafb0913\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/flowUi.js\":\"1ec9c9d87319c2e3\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/useConversionRun.js\":\"3697237e3d919a5b\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/keyUi.js\":\"aaddcec8007e4600\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/useCloseOnKeyLoss.js\":\"93649b2265182979\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/useCloseOnServerE2ee.js\":\"f0fe7a3ef07b07ae\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/workspaceUnlocked.js\":\"87c39d1bad3023e7\",\"/knowledge-medium/pr-preview/pr-1925/src/context/backgroundSubtree.js\":\"5a41d8481e868be8\",\"/knowledge-medium/pr-preview/pr-1925/src/context/block.js\":\"400f06a87d0e56dd\",\"/knowledge-medium/pr-preview/pr-1925/src/context/layoutWsContext.js\":\"a74517b3beecbf01\",\"/knowledge-medium/pr-preview/pr-1925/src/context/propertyDisplay.js\":\"79cc322ca964ca8e\",\"/knowledge-medium/pr-preview/pr-1925/src/context/repo.js\":\"8fcd98249884bdc5\",\"/knowledge-medium/pr-preview/pr-1925/src/data/aliasClaim.js\":\"99d612184cfbd65f\",\"/knowledge-medium/pr-preview/pr-1925/src/data/aliasSeatNamespace.js\":\"f15bc56ee8f96af2\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/blockData.js\":\"56d22130b91220d9\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/blockType.js\":\"ee3b4df3ae26bee3\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/changeScope.js\":\"ade08fc0a30123ce\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/codecs.js\":\"4b475479bc416a99\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/derivedData.js\":\"6785072fe90d7912\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/errors.js\":\"191b9583811cae58\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/events.js\":\"7d940092b3963508\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/handle.js\":\"47c5144c8741ad67\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/index.js\":\"b46621891ea4ba31\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/mutator.js\":\"2b51c3447f8642c9\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/processor.js\":\"07f20970dd93d740\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/propertySchema.js\":\"43c34c145057ae2c\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/query.js\":\"58bf47842ae5b5f9\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/sameTxProcessor.js\":\"825ac46451740513\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/schema.js\":\"47c5144c8741ad67\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/tx.js\":\"47c5144c8741ad67\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/typedBlockQuery.js\":\"0d1b4178863465b0\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/user.js\":\"8f8d2edb5105ca44\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/valuePresetCore.js\":\"8370ba7ff626082e\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/valuePresets.js\":\"88b9ea3b6a8aa2a2\",\"/knowledge-medium/pr-preview/pr-1925/src/data/attachmentCleanerIOVerb.js\":\"7586e14fb88b681a\",\"/knowledge-medium/pr-preview/pr-1925/src/data/block.js\":\"3ed6a49dbc261fc1\",\"/knowledge-medium/pr-preview/pr-1925/src/data/blockCache.js\":\"20591ac7f7fd610e\",\"/knowledge-medium/pr-preview/pr-1925/src/data/blockId.js\":\"9fa28860fe2a0a13\",\"/knowledge-medium/pr-preview/pr-1925/src/data/blockLiveness.js\":\"2231769767ada423\",\"/knowledge-medium/pr-preview/pr-1925/src/data/blockMerge.js\":\"28de2eecf3c80451\",\"/knowledge-medium/pr-preview/pr-1925/src/data/blockSchema.js\":\"437eaf6768d26078\",\"/knowledge-medium/pr-preview/pr-1925/src/data/blockTypeLookup.js\":\"9aa43ab3a4be51b3\",\"/knowledge-medium/pr-preview/pr-1925/src/data/blockTypes.js\":\"26fa3fca398a8a0b\",\"/knowledge-medium/pr-preview/pr-1925/src/data/childrenView.js\":\"0aef9ddd3bf5a470\",\"/knowledge-medium/pr-preview/pr-1925/src/data/clientContext.js\":\"8445febcc5ab78a4\",\"/knowledge-medium/pr-preview/pr-1925/src/data/dbFileSiblings.js\":\"0986502e8cc9ea0a\",\"/knowledge-medium/pr-preview/pr-1925/src/data/definitionSeeds.js\":\"223b4b07f530e65d\",\"/knowledge-medium/pr-preview/pr-1925/src/data/derivedIds.js\":\"294c9fe132333044\",\"/knowledge-medium/pr-preview/pr-1925/src/data/drawnSubtree.js\":\"7f7d8c4c524b05f6\",\"/knowledge-medium/pr-preview/pr-1925/src/data/facetBridge.js\":\"344e9a9ed6b86d06\",\"/knowledge-medium/pr-preview/pr-1925/src/data/facets.js\":\"5b41fab06b97b775\",\"/knowledge-medium/pr-preview/pr-1925/src/data/globalState.js\":\"4993da8429c7726c\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/aliasClaimRederiveProcessor.js\":\"f9f24d68294ed42f\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/ancestorBatch.js\":\"4c1366061c8f0b57\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/blockTypeTypeifyProcessor.js\":\"59d3d3a79e961acc\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/clientSchema.js\":\"54972b7bb61e803b\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/commitPipeline.js\":\"f24e452f01feab75\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/devAssertions.js\":\"4dea2aee0ce5944a\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/firstSync.js\":\"227476f572c0862c\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/freshInitialLoad.js\":\"4317a4897d310919\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/graphBackfillClaim.js\":\"aa3f38e25377e03d\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/handleStore.js\":\"c3d0e30d01545991\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/idleMarkerJobs.js\":\"3ac6b2eb3d493415\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/initialDownload.js\":\"9aec2d147e423230\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/initializeClientDatabase.js\":\"751b678dbf296bfb\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/jsonCanonical.js\":\"b45e9af3085869a4\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/kernelInvalidation.js\":\"ca54972197da3d5b\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/kernelProcessors.js\":\"5f730bedf4daa129\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/kernelQueries.js\":\"5ba339fb86608a7c\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/mergeTypeMembershipProcessor.js\":\"41f637c1439ab125\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/normalizeReferencesProcessor.js\":\"028c754a338d5891\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/poolInstrumentation.js\":\"353d0e4a55234643\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/processorRunner.js\":\"6d88c48f8ce7d722\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/propertyCellBackfill.js\":\"69461e048309c543\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/propertyChildMint.js\":\"042604ae7639a108\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/propertyChildrenProcessor.js\":\"c7a63cb4a137a101\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/propertyDefinitionChangeProcessor.js\":\"928b7960cb0d5a6f\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/propertyDefinitionSynthesis.js\":\"a6de8eed8610a810\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/propertyKeyScan.js\":\"0374c57b188e8a36\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/propertySchemaResolution.js\":\"9242ec1e42644e27\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/propertyValueEdits.js\":\"7b2bc967c7dd05d8\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/raiseProtocol.js\":\"7f448db7ff9929d8\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/readBatch.js\":\"3ab5a1276b7f9a51\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/refProjection.js\":\"c54a4a28beddb43e\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/referenceTargetLookups.js\":\"739080cecf5e7c67\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/referenceTargetProcessor.js\":\"736589b0b2434b18\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/replayMerge.js\":\"dd1f50175dded714\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/sqlBinds.js\":\"9e87b2f709fe3a6e\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"f228a46ee6228955\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/syncObserver/arrivalProcessors.js\":\"ff5698ddf146c212\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/syncObserver/invalidate.js\":\"c4b6c6d2e70cfc67\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/syncObserver/materialize.js\":\"83bddacf9f2c0cd9\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/syncObserver/observer.js\":\"163577a4f6cc9068\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/syncObserver/reconcile.js\":\"71674d798811fd37\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/timingMetrics.js\":\"494fef33a15b10f8\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/treeQueries.js\":\"1fb16f15f2b2b0a2\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/txEngine.js\":\"1356eab3056a9801\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/txSnapshots.js\":\"2873a34e3976077d\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/typedBlockQuery.js\":\"d5f92939f74620be\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/undoManager.js\":\"958ec7dba06c10ab\",\"/knowledge-medium/pr-preview/pr-1925/src/data/invalidation.js\":\"9f749d27eae40830\",\"/knowledge-medium/pr-preview/pr-1925/src/data/kernelDataExtension.js\":\"18c8a25a6c4972ca\",\"/knowledge-medium/pr-preview/pr-1925/src/data/kernelPage.js\":\"df22fad789dc5842\",\"/knowledge-medium/pr-preview/pr-1925/src/data/kernelValuePresetCores.js\":\"31bbdb210282c69c\",\"/knowledge-medium/pr-preview/pr-1925/src/data/localDbCorruptionSignal.js\":\"cd789bd79a28104a\",\"/knowledge-medium/pr-preview/pr-1925/src/data/localDbStorage.js\":\"3c2813f77903086f\",\"/knowledge-medium/pr-preview/pr-1925/src/data/localDbVfs.js\":\"7073afcc3d072d56\",\"/knowledge-medium/pr-preview/pr-1925/src/data/localSchema.js\":\"44df02f76ff91de9\",\"/knowledge-medium/pr-preview/pr-1925/src/data/maintenance.js\":\"608067041a3f8969\",\"/knowledge-medium/pr-preview/pr-1925/src/data/mergeProperties.js\":\"df79d891e5deb395\",\"/knowledge-medium/pr-preview/pr-1925/src/data/metricsConsoleHook.js\":\"01e894ec0ed10977\",\"/knowledge-medium/pr-preview/pr-1925/src/data/migrationsPage.js\":\"a72cabdce3a90332\",\"/knowledge-medium/pr-preview/pr-1925/src/data/mutators.js\":\"5219962efa9eb09d\",\"/knowledge-medium/pr-preview/pr-1925/src/data/orderKey.js\":\"ef143a35b96925ef\",\"/knowledge-medium/pr-preview/pr-1925/src/data/orderKeyPlacement.js\":\"7437efe0c1b6158a\",\"/knowledge-medium/pr-preview/pr-1925/src/data/outlineSurface.js\":\"852d868bbc1fd4b6\",\"/knowledge-medium/pr-preview/pr-1925/src/data/pendingEditorContent.js\":\"63a5b2c54ed80d96\",\"/knowledge-medium/pr-preview/pr-1925/src/data/pendingUploadsSql.js\":\"84e3a6b29d3c5d16\",\"/knowledge-medium/pr-preview/pr-1925/src/data/pluginStateExtensions.js\":\"7c07c7de91fb1829\",\"/knowledge-medium/pr-preview/pr-1925/src/data/powerSyncLogger.js\":\"ce881687723a9da7\",\"/knowledge-medium/pr-preview/pr-1925/src/data/projectorRuntime.js\":\"c263234d71a51186\",\"/knowledge-medium/pr-preview/pr-1925/src/data/properties.js\":\"a9d0e30656002974\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertiesPage.js\":\"68493d1353746286\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertyChildren.js\":\"cdee68f95c816b66\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertyDefinitionFanout.js\":\"ce3697a8d2c41651\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertyDefinitionMetadata.js\":\"aa5f0001fc6c54d8\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertyDefinitionRegistry.js\":\"95edfee31d14c65a\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertyDisplayMode.js\":\"f711c3671700e4c1\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertyRowCreation.js\":\"5d1f881b846c363d\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertySchemaCreation.js\":\"d02cd57759c11541\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertySeeds.js\":\"311ebc7b550ed211\",\"/knowledge-medium/pr-preview/pr-1925/src/data/recentsPage.js\":\"6670835d8bc0a54e\",\"/knowledge-medium/pr-preview/pr-1925/src/data/refTargetComparableProperty.js\":\"8e495bff29c4fdae\",\"/knowledge-medium/pr-preview/pr-1925/src/data/referenceBlock.js\":\"d3d0fe39ac94fdde\",\"/knowledge-medium/pr-preview/pr-1925/src/data/rejectedUploads.js\":\"6bf29f2c32afba9d\",\"/knowledge-medium/pr-preview/pr-1925/src/data/releasePowerSyncConnection.js\":\"fbc30532de6a9058\",\"/knowledge-medium/pr-preview/pr-1925/src/data/repo.js\":\"ba5cf7158ec6cb0c\",\"/knowledge-medium/pr-preview/pr-1925/src/data/repoProvider.js\":\"75b0a041bc66a75e\",\"/knowledge-medium/pr-preview/pr-1925/src/data/rowProperty.js\":\"1aa90360930962b2\",\"/knowledge-medium/pr-preview/pr-1925/src/data/searchFilter.js\":\"fba81abacceb3eb5\",\"/knowledge-medium/pr-preview/pr-1925/src/data/seedIdentityLedger.js\":\"2daaa14fce56939f\",\"/knowledge-medium/pr-preview/pr-1925/src/data/stateBlocks.js\":\"b95231827f9a93cb\",\"/knowledge-medium/pr-preview/pr-1925/src/data/structuralEditPolicy.js\":\"abd88e3982078013\",\"/knowledge-medium/pr-preview/pr-1925/src/data/structuralInsert.js\":\"8a0fd95f9446f7eb\",\"/knowledge-medium/pr-preview/pr-1925/src/data/subtreeDelete.js\":\"e6f8321730e81a23\",\"/knowledge-medium/pr-preview/pr-1925/src/data/syncStreamLock.js\":\"dddde91ae7866845\",\"/knowledge-medium/pr-preview/pr-1925/src/data/syncedTableSqlRecognizer.js\":\"de2be450aa1b2a02\",\"/knowledge-medium/pr-preview/pr-1925/src/data/syncedTableWriteGuard.js\":\"ef0c141b27ee806b\",\"/knowledge-medium/pr-preview/pr-1925/src/data/targets.js\":\"874db76a11357cd1\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typeColors.js\":\"9e70a07767c9063f\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typeDefinitionMetadata.js\":\"0b9bc0f9d61bdaad\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typeDefinitionRegistry.js\":\"ec0708bcd7ef0b26\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typeExtraction.js\":\"e2a5a68e5fc92442\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typeInitialValues.js\":\"bf0472a96a136a3a\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typePropertyGroups.js\":\"d5eed75c956ba9d0\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typeSeeds.js\":\"0dbf49e2b5e9ce86\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typeTagger.js\":\"83e8a5f8edfda4bf\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typedRecords.js\":\"880d73316e8294ca\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typesPage.js\":\"2c3d42cc638fb08a\",\"/knowledge-medium/pr-preview/pr-1925/src/data/userPrefs.js\":\"896877b9d34f320e\",\"/knowledge-medium/pr-preview/pr-1925/src/data/userSchemasService.js\":\"73d77aa2dafd42a2\",\"/knowledge-medium/pr-preview/pr-1925/src/data/userTypesService.js\":\"114ae65ef7996a02\",\"/knowledge-medium/pr-preview/pr-1925/src/data/valuePresetRegistry.js\":\"66148048efcb1bd5\",\"/knowledge-medium/pr-preview/pr-1925/src/data/visibleChildren.js\":\"5bd051691deca846\",\"/knowledge-medium/pr-preview/pr-1925/src/data/workspaceConversion.js\":\"f8b69685feb4ebbe\",\"/knowledge-medium/pr-preview/pr-1925/src/data/workspaceFirstSync.js\":\"4cbd9acff2493213\",\"/knowledge-medium/pr-preview/pr-1925/src/data/workspaceIdNamespace.js\":\"cbbf4f8a8c96decd\",\"/knowledge-medium/pr-preview/pr-1925/src/data/workspaceSchema.js\":\"dff0409e3ea2dba2\",\"/knowledge-medium/pr-preview/pr-1925/src/data/workspaces.js\":\"a6d720cee262ede6\",\"/knowledge-medium/pr-preview/pr-1925/src/data/writeAheadLog.js\":\"e0af5dac143e62d4\",\"/knowledge-medium/pr-preview/pr-1925/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/BlockPasteShellDecorator.js\":\"e31858367310ee91\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/atTrigger.js\":\"6e9d4e02e5a4a7d2\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/autocomplete.js\":\"015963d1d9363d5d\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/codeMirrorExtensions.js\":\"c6c59fbccb8e89bd\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/contentFlush.js\":\"9c3d06469a343a49\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/defaultInteractions.js\":\"00dee748bf0d6527\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/editSettleSignal.js\":\"c65e1caf9ed6174b\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/insertImage.js\":\"1bd2f16978f816d1\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/referenceCompletionRange.js\":\"29741521a29d0540\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/referenceTargetTypes.js\":\"c0c3420bed4b7cd6\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/syntaxContext.js\":\"51fc1b747a3625e3\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/triggerMatch.js\":\"98ae593e3168bc78\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/AppRuntimeProvider.js\":\"566dc0536ac20d8d\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/BlockFocusShellDecorator.js\":\"0d758d51c21124bd\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/ExtensionRenderBoundary.js\":\"844d31d053a4b32f\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/PanelContentRecovery.js\":\"e5a8e245c44a59df\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/apiCatalog.js\":\"ba903b8b09c1e2f9\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/appRuntimeController.js\":\"31733a0838ff1524\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/approveExtensionHere.js\":\"77547ab54d14ebf6\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/armedCutAppMount.js\":\"144c9464ca0d0dc0\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/batchableKeyedStore.js\":\"1c55478b8fa8b28e\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/blockInteraction.js\":\"2b0269ea2def3f8e\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/blockSelectionAction.js\":\"eecd014d7c049fb5\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/buildApprovalRecord.js\":\"08269246ce0a7d09\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/compileExtensionModule.js\":\"2bf3bf0a7b6e52cf\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/compiledModuleCache.js\":\"b4c5235256ef4b66\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/continuousGestures.js\":\"05c088a5a4a9fde9\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/core.js\":\"b24e254c1b7b623d\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/defaultRenderers.js\":\"4d88fc9619bcd801\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/definitionFanoutAppMount.js\":\"cdc1eae418c68808\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/dialogAppMount.js\":\"31bcaca0f31a37b1\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/dynamicExtensionSeeds.js\":\"6470c7c155a92506\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/dynamicExtensions.js\":\"f6f3d188389bd9e5\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/exampleExtensions.js\":\"097978dd7a6253ab\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/extensionApprovalStatus.js\":\"675ec5283fcdedd3\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/extensionImportPolicy.js\":\"e8d1725533d0aa18\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/extensionLoadErrorToast.js\":\"d851f4d742eed04f\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/extensionLoadErrors.js\":\"b655bef15c9a3c1a\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/extensionLookup.js\":\"b044327c80bdf0a0\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/extensionToggles.js\":\"b296358d3bfa1c0c\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/extensionUtilitiesCss.js\":\"daf1d466ae6f91cd\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/kernelPageDeletionGuard.js\":\"708486b2d99752bd\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/liveRuntime.js\":\"044becbe26a2a4b4\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/normalizeExtensionSource.js\":\"36e64bd34557b6d1\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/openExtensionsSettings.js\":\"b747793100815a57\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/overridesCache.js\":\"1da6a4861fcaaa95\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/pluginIds.js\":\"581c551c62f71833\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/processorRejectionToast.js\":\"9ed94c2f4804d22a\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/runtimeActions.js\":\"60fbd354ff616bca\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/runtimeContext.js\":\"dfbd00df13725d2e\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/staticAppExtensions.js\":\"0f42696146972312\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/staticDataExtensions.js\":\"89016b2ac99e41a9\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/toastAppMount.js\":\"42e9719b86262c03\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/transpileExtension.js\":\"c2558ae68d254c8b\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/useOverrides.js\":\"401c419046fb9be4\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/useShortcutSurfaceActivations.js\":\"10f7c8d8e4f69fa9\",\"/knowledge-medium/pr-preview/pr-1925/src/facets/discoverToggleTree.js\":\"dcde3b7167c7c476\",\"/knowledge-medium/pr-preview/pr-1925/src/facets/facet.js\":\"fc6d236eb0b40863\",\"/knowledge-medium/pr-preview/pr-1925/src/facets/resolveAppRuntime.js\":\"3848ce7f83dd0012\",\"/knowledge-medium/pr-preview/pr-1925/src/facets/runtimeEvents.js\":\"62f62e5ef58ab23a\",\"/knowledge-medium/pr-preview/pr-1925/src/facets/togglable.js\":\"e257afc852108e22\",\"/knowledge-medium/pr-preview/pr-1925/src/facets/variantFacet.js\":\"4a40104e1dc70276\",\"/knowledge-medium/pr-preview/pr-1925/src/facets/verbFacet.js\":\"468c136c1691b9dd\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/block.js\":\"598092bbf2a32f5a\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/focusedChild.js\":\"3af87c8dadbca28c\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/propertySchemas.js\":\"672b9f84a96159ce\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/typeRegistry.js\":\"0118d1794e5ecf8f\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useAncestorCrumbs.js\":\"61d171503c6e5ddd\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useAutocompleteListbox.js\":\"833ad6bc6ed7c9b6\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useDebouncedSearch.js\":\"6ff5e0ad5eabf775\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useDebouncedValue.js\":\"b1c3433bda88cf22\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useFacetValue.js\":\"feee3bbe96328bb2\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useIsFocalRender.js\":\"ae527be1f51cd67f\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useIsReadOnly.js\":\"ad69a1aa2cc9a6bf\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useMaterializeBacklog.js\":\"4f358284b0403811\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useMinuteClock.js\":\"a0f041490ff23118\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/usePanelLayoutProjection.js\":\"887ba0d8396081e0\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/usePendingInvitations.js\":\"cc8c74252d379ac2\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useRendererRegistry.js\":\"a139504550f24ac0\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useRetainedFieldRows.js\":\"f495e06250354389\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useWorkspaces.js\":\"1e08bbd0d22ebb75\",\"/knowledge-medium/pr-preview/pr-1925/src/lib/utils.js\":\"a7fc688ffc2b15f8\",\"/knowledge-medium/pr-preview/pr-1925/src/main.js\":\"26dd335a85248b67\",\"/knowledge-medium/pr-preview/pr-1925/src/markdown/MarkdownImage.js\":\"77179d360be47d60\",\"/knowledge-medium/pr-preview/pr-1925/src/markdown/blockSeparators.js\":\"e004d12676b13220\",\"/knowledge-medium/pr-preview/pr-1925/src/markdown/context.js\":\"33f56b41afbdfbca\",\"/knowledge-medium/pr-preview/pr-1925/src/markdown/defaultMarkdownExtension.js\":\"438e1035b68e925c\",\"/knowledge-medium/pr-preview/pr-1925/src/markdown/extensions.js\":\"4c945eb66d92f0bb\",\"/knowledge-medium/pr-preview/pr-1925/src/markdown/renderMarkdownHtml.js\":\"327762f4d7bb5ed0\",\"/knowledge-medium/pr-preview/pr-1925/src/minimal-editor.js\":\"93740ab9cff15e80\",\"/knowledge-medium/pr-preview/pr-1925/src/paste/armedCut.js\":\"8b1098560f250fde\",\"/knowledge-medium/pr-preview/pr-1925/src/paste/captureMediaVerb.js\":\"33fa303e3361e134\",\"/knowledge-medium/pr-preview/pr-1925/src/paste/clipboard.js\":\"ccc7dd3c1ab01234\",\"/knowledge-medium/pr-preview/pr-1925/src/paste/decision.js\":\"00cd69980ccf0e16\",\"/knowledge-medium/pr-preview/pr-1925/src/paste/operations.js\":\"008100f0da8e49bb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/account-header/AccountHeaderItem.js\":\"6de5a9cff15181b6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/account-header/index.js\":\"c6f5e58c47b17646\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"a0bea69e1951a0f7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/askAgent.js\":\"e932860bc8a7ec68\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/askedStore.js\":\"fe253c799ecbe79f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"59a1bf2594c2f444\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/chipState.js\":\"4d4255e7d8d3393a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/dataExtension.js\":\"66c5551b5e2dd70c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/index.js\":\"67343640452f6a95\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"68886ea83316ec4d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/retryAgent.js\":\"00f67fc08219cab7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/schema.js\":\"e6cc82fd8e7b38ef\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/AgentTokensDialog.js\":\"ed74d68cb9649418\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/BridgePairingDialog.js\":\"8404c4f199979dbb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/addMedia.js\":\"a15c7783ba6e65ed\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/backlinks.js\":\"4a9be4aca237e9d6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/block.js\":\"b438a46fee12f635\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/context.js\":\"232f5a335c44b10d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/displayIds.js\":\"ddf7a564cfba74df\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/index.js\":\"98fe919f88865b52\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/outline.js\":\"1e8b22886f2c3df7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/properties.js\":\"6e743197406bd661\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/refs.js\":\"ee8694a4959f40bf\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"ac60adb5016dfd6e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/search.js\":\"fb5ebf28f2031e6d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/shared.js\":\"3210766adb5bf824\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"8bd3091dd7c570be\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/text.js\":\"ee4ec764f98a282c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentWrites.js\":\"dcc3e1f6a6228d80\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/authoringCatalog.js\":\"c5c0966f396a51a4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/blockRefTargets.js\":\"a886c6931a5fd5a7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/bridge.js\":\"a2da557050daf502\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/bridgeLoop.js\":\"89540f4f641392d1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/changeHistory.js\":\"732edfc004886b7a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/commands.js\":\"d78d306d420b32aa\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/commentsCommands.js\":\"dfd4ef608402dad3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/dataExtension.js\":\"3fc4d01a25238c31\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/dataModelGuide.js\":\"2b9ad6640efe229d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/dayPropertyInputs.js\":\"edd8bfdd4989b75c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/describeRuntime.js\":\"bd87652ee64d3a3b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/extensionLint.js\":\"c64af94d47e96f61\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/grainAudit.js\":\"d5c6bcfefa57a46e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/healthCommand.js\":\"feb545243f5f1166\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/index.js\":\"f252709d8c5ad6b6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/presetIdentity.js\":\"f7373fed61e01975\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"4aeae4e4f8844fc6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/readMedia.js\":\"791242260679874f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/schema.js\":\"041cd322309332ef\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/serialization.js\":\"4de1f0913683a977\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/targets.js\":\"b24262d5da7fb5d6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/tokens.js\":\"2af280fe7521e7e1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/watchEvents.js\":\"20f62a80b4b81ce4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/workspaceGuard.js\":\"a4d22834f11d35b8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/writeCommands.js\":\"cdc2f029e8a90e42\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/AliasCollisionToast.js\":\"f43062e8d4b9b27e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/DuplicateNameBanner.js\":\"d9dc3230d84439c3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/collisionMerge.js\":\"462a91cf1a2d965b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/dataExtension.js\":\"71115838ad4b9dec\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/index.js\":\"e72c57ea3cbc350d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/mergeCollisionAction.js\":\"09fbf28916f56c45\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/pageStyling.js\":\"c1c7ad7d2a7cdab0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/rejectionToast.js\":\"e7e14ac6c6884c34\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/syncProcessor.js\":\"21b3b6eee4998e04\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/actions.js\":\"bf68060a42862e6e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/addComment.js\":\"8baac73a9876505c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/anchor.js\":\"56ae3c71257ed692\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/anchorState.js\":\"99307e0949c495c9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/commentLinks.js\":\"3ad957a51f30e994\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/confirmThreadDeletion.js\":\"59f2d8e6963bc4fa\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/container.js\":\"6cbcd4f09c9dcd8f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/dataExtension.js\":\"eb0dbafa961208d3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/deleteComment.js\":\"9abf7d97dcc98e9a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/highlights.js\":\"fd8d5b819c13f5af\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/index.js\":\"1de27e070bb7e80e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/linkedCommentsPill.js\":\"7753414ac867b407\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/margin.js\":\"99ae1bb45561d121\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/marginAnchorLinks.js\":\"4e220abfc6ace00c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/marginSchema.js\":\"ce0925e67f0c5c22\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/newComment.js\":\"b53bbadc48427597\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/ownThreadPicker.js\":\"ee2eca8f3b298f82\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/placement.js\":\"8ddacddd263a8f4f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/queries.js\":\"d86644cb3cfa0936\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/quotePosition.js\":\"166d0670dba6eafb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/quotedIn.js\":\"99de285ea320c05e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/quotedRange.js\":\"321c7bc735a71127\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/rangeRefs.js\":\"82d3502a5c53ca13\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/readHighlights.js\":\"3eb4c9b18d72a68b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/readSelection.js\":\"28c956155d083345\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/readSelectionUi.js\":\"12d9ad3b72c8ff25\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/reanchor.js\":\"4760688eab8627e6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/schema.js\":\"6843967c9ba061d3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/scope.js\":\"ff24b2d1d7f6fc25\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/scopeThreads.js\":\"35829c8febffd172\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/splitRetarget.js\":\"f9e223b4341a7735\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/suggestionCard.js\":\"7a224c73335a9a26\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/suggestions.js\":\"4418983cb47a07b1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/summaries.js\":\"d843799ee3a16c0e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/summaryBatch.js\":\"89d04c289dd3eec7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/surface.js\":\"96497aa1405aa269\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/threadNavigation.js\":\"110006e98b9b59b0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/threads.js\":\"d707bb705774df74\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/ui.js\":\"b4ce935ec3459c2a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/uiStore.js\":\"1de15e4d9d459463\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/app-intents/appIntents.js\":\"4967ddbe48006891\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/app-intents/index.js\":\"eee4204b24bbd9b2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/app-update-prompt/index.js\":\"3d6c2e48c17f4dbf\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/app-update-prompt/status.js\":\"41fe610c24f1766a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"97e5ea6c620ab02d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/MediaBlockRenderer.js\":\"c731107f79c33e42\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/MediaDownLaneReplicator.js\":\"0bf443939bb1ccf2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/MediaUploadReconciler.js\":\"29f86236d7c85de8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/assetDownLane.js\":\"dd0052fd8305febf\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/assetResolver.js\":\"23ea927b483212eb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/assetUpload.js\":\"3a3a256456405d61\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/attachmentCleanerIO.js\":\"a8e00017704f8c50\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/audit/supabaseAuditIO.js\":\"1c616755fe3a734d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/blobStore.js\":\"95bc8e83a87f6be3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/browserMedia.js\":\"cc2d1335ca7d24ad\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/byteStore.js\":\"aea08d9c7fe45355\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/cleanerIO.js\":\"624ee69ace38511f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/cleanupAttachments.js\":\"4443ff23b3137470\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/dataExtension.js\":\"afbb7cd958e1fe7c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/downLane.js\":\"279cca0d3c12fe95\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/index.js\":\"ed65bfb438c3d5b7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/insertImageContribution.js\":\"6da4770baba86be0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/laneArming.js\":\"f80ad74a15fb5618\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/laneLock.js\":\"a45f470f6fad1892\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/mediaBlock.js\":\"62d004e50584f42e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/mediaCapture.js\":\"1f642256e4aa18b4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/mediaLanes.js\":\"56c1887f6f45577d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/mediaViewers.js\":\"79ce4255367efc0b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/mediaViewersFacet.js\":\"adb9ca16eed9d02c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/pasteCapture.js\":\"1370bdf7a3914dfe\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/resolver.js\":\"876128079e23f4c3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/retryUploadsAction.js\":\"4e5db3ef5fd70d5a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/storagePaths.js\":\"a2c21c051edc1134\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/uploadDrain.js\":\"74d74841e5192122\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/uploadLaneStatus.js\":\"331d17e7cc585003\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/uploadReconcile.js\":\"ea37a244ba1b7cb1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/uploadRecovery.js\":\"bc0f229455f80bd2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/uploadStore.js\":\"e92a5dd0c531eb70\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/useAssetObjectUrl.js\":\"1b923ad6b6895f10\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"f53b0a59ba10f500\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks-view/BacklinksViewSection.js\":\"41e66eaf2690e25d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks-view/facet.js\":\"5e82913b0e8d64b9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks-view/index.js\":\"2be5cb18fa23e08b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks-view/prop.js\":\"fd18d2e92fcb067c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/BacklinkFilters.js\":\"282bfe924515236b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"b089835a37eedb34\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/BlockEntry.js\":\"663acd8f72adb931\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/LinkedReferences.js\":\"6eedd9abf1a8d2bf\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"6aea26650eaae806\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/dailyNoteDefaults.js\":\"8ba9fdfa75758409\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/dataExtension.js\":\"68bbccfd59f6dbd8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/edgeExclusions.js\":\"d2b569858e50bf84\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/filterProperty.js\":\"59c9fe5efd611be2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/index.js\":\"c1463e82cb14a94e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"512308db3f863aa4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/inline-counts/applies.js\":\"3527760cabe94eb8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/inline-counts/countQuery.js\":\"4a6bb10048cc7d99\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/inline-counts/expansionStore.js\":\"fcf6af6d1ad66a20\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/inline-counts/index.js\":\"5806e3d45326c07a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"f4515aa97b70b694\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/presentationInvalidation.js\":\"d687c2da185cc11d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/propertyEditorOverride.js\":\"14b04b8e4bfc18f2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/propertyFilter.js\":\"b37230ed6fbab456\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/query.js\":\"3d61fe92f38e4e91\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/resolveFilter.js\":\"99c5860fa584ee5e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/sourceBatch.js\":\"a4a92036150840d3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/sources.js\":\"c3e0dbfc827e3d2c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/useBacklinks.js\":\"5253502877c10044\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"08b8c46974b0a14b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/birthday/BirthdayCelebration.js\":\"963954b66fbe8984\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/birthday/BirthdayOverlay.js\":\"0313abff9c326f84\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/birthday/gate.js\":\"d94823b8dc25262a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/birthday/index.js\":\"186d5cb1f97466c6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/birthday/wolfTheme.js\":\"b468345db4c9a12e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-drag/BlockDragLayer.js\":\"187750430ba1db8d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-drag/dragController.js\":\"82035b4562a7047b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-drag/dropTarget.js\":\"9d688799d5fb1d4c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-drag/index.js\":\"ee8a3364edc6ad42\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-drag/projection.js\":\"4e65369c182fba86\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-info/BlockMetaCard.js\":\"e556fdbb8a764d2e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-info/index.js\":\"90259e0b7e95f576\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/AddTagDialog.js\":\"3c4e5ab6c4bdcf88\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"645d9c5d9790627d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/TagNameIssueHint.js\":\"6104b38b6382ff60\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/addTagAction.js\":\"5a28455f2237abeb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/appendTag.js\":\"59b940cc3eac9cf7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/config.js\":\"61a9c99697708304\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/dataExtension.js\":\"d8c8e44fde2c7767\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/index.js\":\"3d3623dcc541318c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/propertyEditorOverride.js\":\"5a9960480b77d85f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/breadcrumbs/BreadcrumbList.js\":\"13cee4b0bddf492a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"ed7ee01fc340f074\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/breadcrumbs/Breadcrumbs.js\":\"cef9553b783c31b0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"96273792dc93d197\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"5aef7bbe31e3c707\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/breadcrumbs/index.js\":\"66e534be832c82ef\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"cd5ddf91e970b926\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/CharacterCountItem.js\":\"d5420a3e40ac628f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/ProfilePropertyEditor.js\":\"c6d81667a768b030\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/actions.js\":\"6dc14d347aae13ea\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/blockType.js\":\"50e625b318c41c6b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/charCount.js\":\"9aae89bee1fbc74b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/dataExtension.js\":\"921b281ed21fd6fd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/index.js\":\"4c74f1a97ba16aaa\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/profiles.js\":\"c15cad541cfbde5b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/properties.js\":\"dd06d68bfb180d8b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/subtree.js\":\"371e879aa3019a23\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/textCounts.js\":\"5c69fb3527428804\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/colemak-keybindings/index.js\":\"ac82f301794da44d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/command-palette/CommandPalette.js\":\"adaff66f0cf7ca8e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/command-palette/HeaderItem.js\":\"61f4d2c33d1f2bd7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/command-palette/context.js\":\"9a1c6d6634cf8f98\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/command-palette/index.js\":\"37e4cdc25f856d97\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/command-palette/selection.js\":\"b777370ff6a7c080\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/command-palette/toggleStore.js\":\"3bae5f67188ec928\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/command-palette/useCommandPaletteActions.js\":\"752214bf88e28645\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/ContributorBadges.js\":\"a7148fa510265cef\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/ProfilePicture.js\":\"1741a4b52f08918b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/author.js\":\"297a344f58210e8a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/codeMirrorExtensions.js\":\"254e808bdb76bfb6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/dataExtension.js\":\"0649df757c98f71d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/index.js\":\"ee132e0cc82f5361\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/mentionAutocomplete.js\":\"b200b8a287f9b1c5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/processor.js\":\"2f843b5032ca9249\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/profiles.js\":\"3754a86863772245\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/queries.js\":\"3351fed522eaef09\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/schema.js\":\"010aa489c650076d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/useCommentAuthor.js\":\"f320ecbf25d69052\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"f3e64ee96b95d13b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/cursor-follows-scroll/followOrigin.js\":\"476e44c9c40d0470\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/cursor-follows-scroll/index.js\":\"be17743b43fa1725\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"b78cdc4d4b2e08ff\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"6c087182b563add0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/CalendarGrid.js\":\"3422c3b2ad393558\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/DailyNotePicker.js\":\"c7a86a427da48475\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"189c9774ae23285a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/DateNavDecorator.js\":\"d9694829f63e54f9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/DateScrubOverlay.js\":\"cb979b9f6fc32922\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/DayPropertyControl.js\":\"a708dd83cee09e35\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/DayValueReferenceControl.js\":\"ee81a13784c94098\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/HeaderItem.js\":\"84c1c852fc1d4ce4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/ReschedulePicker.js\":\"fb80049c3300de84\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/SpreadDatesDialog.js\":\"9e6a4bc2c2a903db\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/actions.js\":\"cf30924b93a6f2b5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/blockDateAdapter.js\":\"784c495e46b77826\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/calendar.js\":\"6b25837960eff6ad\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dailyNotes.js\":\"cb469229c35f3ae6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dataExtension.js\":\"50c8b38f919d6fbe\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dateScrubActions.js\":\"5819f97d8f8653b4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dateScrubGesture.js\":\"e3d0f215e5682949\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dateScrubGestureActions.js\":\"3d5d7b5b62f96764\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dateScrubRecognizer.js\":\"3e3966743dd69359\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dayProperty.js\":\"68fbd330df623efe\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"b92c3a8a43dbeba5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/deletionGuard.js\":\"46e76d121703a65c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dueQuery.js\":\"64be00d991431fe4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/index.js\":\"f7b336d18a73d4d8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/landing.js\":\"06fcb55f8f4d0123\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/localSchema.js\":\"6286253e9f1fabd4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/referenceDateAdapter.js\":\"c942effc11cd3437\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/rescheduleAction.js\":\"f797ff1fea6947ef\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/schema.js\":\"d7734d9ac3e8ef25\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/spreadBlockDates.js\":\"4838eca80cae3408\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/spreadDatesAction.js\":\"7307dd4cceeb2998\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/today.js\":\"7cadabe4878a02fa\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"2f35bbc42b1f84fb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"7efcb5ac357abeef\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/audit.js\":\"1211976bf4731f7a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/auditAction.js\":\"eae80d63d0234059\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/auditRanges.js\":\"579e14a726e73ce8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/diagnosticsSource.js\":\"269f52d7d9e85159\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/divergenceScan.js\":\"ae734ef3391762b4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/index.js\":\"55867c2bf0203e7a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/propertyChildrenChecks.js\":\"b1f34014f8ae9eda\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/referencesMirror.js\":\"4515fa1a7e3556e0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/rowJson.js\":\"fc9e7d457f01c8f2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/schedule.js\":\"2c42525cecfd7206\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/store.js\":\"e3c80f96518652bf\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-maintenance/action.js\":\"a608897f0e354855\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-maintenance/index.js\":\"a6f243010577221a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-maintenance/plugin.js\":\"9a2c603ce92fe7b5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"1980f6376459279d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/actions.js\":\"b6700826bfb00179\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/changeMarker.js\":\"6be9e5a6caa23d75\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/diagnostics.js\":\"8084c1330dd8731f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/fileSystemAccess.js\":\"716395728fc06a85\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/filenames.js\":\"7557c2390c82c6d8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/index.js\":\"4d04801a516e4ba1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/mirror.js\":\"85f896386c5c9b65\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/runLock.js\":\"640b2d11b7ccb8cb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/runtimeHealth.js\":\"2534ef19b918f248\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/schedule.js\":\"2db3f44c222bf7b4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/store.js\":\"c3a75132dc340b56\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/default-themes/index.js\":\"1329fc4780449fd6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/default-themes/themes.js\":\"177d40205a8fc112\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/diagnostics/facet.js\":\"e4c2f80ce64b21da\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/diagnostics/useDiagnostics.js\":\"b564436e92067178\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extension-prompts/dismissals.js\":\"b1e0d7f4fe70abe4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extension-prompts/index.js\":\"0c1b961e1551d3d5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extension-prompts/status.js\":\"43bc544841a0050c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extension-prompts/store.js\":\"4be32e35c25ef8b4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"3086838b1bff25e7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/ExtensionsSettings.js\":\"56e5e99be4d8897f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/actions.js\":\"0d890f685374ab78\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/config.js\":\"34b7825ce8140f04\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/dataExtension.js\":\"7ce5d078df8961fc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/effect.js\":\"8a8efd8c49df7dc4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/index.js\":\"55692e0ac271a227\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/propertyEditorOverride.js\":\"ca3d5bbb39405cf7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/useToggleTree.js\":\"396fc768d444df11\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extract-type/ExtractTypeDialog.js\":\"3ffb218d84fbfc9a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"29dbd39338d2d657\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extract-type/PropertyShapePicker.js\":\"2f4de5723066c7c7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extract-type/action.js\":\"778cd953e2a41c2f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extract-type/index.js\":\"86300ae21596c0ea\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/find-replace/FindReplaceDialog.js\":\"6d3ee7e9915f1b68\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/find-replace/HeaderItem.js\":\"2a3a120c66232804\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/find-replace/dataExtension.js\":\"cb6d51bb182def08\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/find-replace/index.js\":\"dc83c7e4f7518262\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/find-replace/search.js\":\"13cb14ac8a6139b4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/find-replace/toggleStore.js\":\"b7e7d3d9651c5430\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/LocationPropertyEditor.js\":\"6b9dcf81a2aa18cb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/MapView.js\":\"5c5164fce9007835\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/blockTypes.js\":\"23a5abe857399eab\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/codeMirrorExtensions.js\":\"dcd84ed64a1dd142\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/createOrFindPlace.js\":\"aac12d483d9d1cda\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/currentLocation.js\":\"5178c7d9b27383e1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/dataExtension.js\":\"f71ad2583f6a52b0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/geoContentDecorator.js\":\"46183f8cb73bfe2c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/googlePlacesClient.js\":\"e8529d1875a800f8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/index.js\":\"36ed98e661c32a68\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/locationsPage.js\":\"7473deb268472d42\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/mapViewport.js\":\"94b76f34d6c9040b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/pickCurrentLocation.js\":\"3460c37a5c21d563\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/placeAutocomplete.js\":\"139df36489a2c156\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/placeNameCollision.js\":\"89532abf8df9616b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/properties.js\":\"68bb8693ef5ed103\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/propertyEditorOverrides.js\":\"8b937009ff74b8e8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/query.js\":\"6579bea5b12d7eda\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/usePlaceSearch.js\":\"1b33f984291be232\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"c8afaae72cfe58e9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"d5066b06577126ca\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"8a88bd63b773afbc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/config.js\":\"49676e635a3f5889\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/dataExtension.js\":\"18c7a0a15d82d073\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/facet.js\":\"0e8ab680edc0143e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/grouping.js\":\"4cf414db74bed21c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/index.js\":\"b99a9042342c0280\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"4ff472e6e283f02b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/query.js\":\"d03f012386757e01\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/resolveConfig.js\":\"87b62f5ff29e7df9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"bb9cc970f9ab0a37\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"d5c9fabd0c488ba3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/HtmlDocumentContent.js\":\"ce3e26fc49decbc3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/HtmlFrame.js\":\"c35098c193883aee\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/actions.js\":\"742cc1af09dbecdf\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/blockType.js\":\"df57d62e33b8e123\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/confirmRunScripts.js\":\"6a75b40ad666233e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/dataExtension.js\":\"ebc18f3986c38230\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/frameAnnotations.js\":\"ae745c81ff54f5a6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/frameDocument.js\":\"4893650adc242b9c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/frameTheme.js\":\"6dfb5ea0509c800d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/index.js\":\"d24bc3f2933d7011\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/scriptConsent.js\":\"dcd25cae5e72fedd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/sourceMap.js\":\"b869f5a1ee4630f2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/useDocumentScripts.js\":\"0a0c2397b72d7e95\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/interaction-metrics/index.js\":\"d59ff2c057bb0876\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/interaction-metrics/record.js\":\"120f1eb2774c6084\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/interaction-metrics/recordStore.js\":\"a34e3a13ce6a73e5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/interaction-metrics/responsiveness.js\":\"e4cfaa267ea7d179\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/interaction-metrics/schedule.js\":\"cfaf46742703ef47\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/interaction-metrics/sessionContext.js\":\"44040b3d7079f8f1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"2dd113cf3d75887f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"5d8bc6d21c1fef83\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/actions.js\":\"772f899c3a642282\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/config.js\":\"408633e65494234e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/dataExtension.js\":\"e4f0bb5acd36d3a9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/effect.js\":\"719b6eb18de1760c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/index.js\":\"fa6a15944a1aa1a7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/keyCapture.js\":\"b9d1ed1391a56003\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/overrideStore.js\":\"8e30d1a9a2bf7ca6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"8cd85e44f2faa9c5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/left-sidebar/HeaderItem.js\":\"87f2252c64a4b946\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/left-sidebar/LeftSidebar.js\":\"79c6ee2878f00e2d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/left-sidebar/actions.js\":\"842c98deefd1228f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/left-sidebar/facet.js\":\"d72906dba86d7e91\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/left-sidebar/index.js\":\"97cd13f474cce001\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/left-sidebar/shortcuts.js\":\"0cb537a891b09150\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/left-sidebar/toggleStore.js\":\"055072415e867e8a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/merge-blocks/MergePicker.js\":\"34d45a1c1fd08a52\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/merge-blocks/index.js\":\"72875cf11733d8c2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/merge-blocks/mergeAction.js\":\"d40826307a3d77e5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/merge-blocks/strategy.js\":\"ad4e3227ec4ed72f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-bottom-nav/Button.js\":\"ee9cc9b562f4dc45\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"494302fe13906391\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-bottom-nav/defaultItems.js\":\"78e2a576e3ac6d6c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-bottom-nav/facet.js\":\"50ae497826120d74\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-bottom-nav/index.js\":\"a6ed5fe8b8ef0564\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"774f717398a77c5b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-keyboard-toolbar/actions.js\":\"fdb654340e385031\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"16c94a6c534d439b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-keyboard-toolbar/facet.js\":\"6da15a9b743e7c41\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-keyboard-toolbar/index.js\":\"51482c17180cb55e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/move-blocks/MoveDestinationPicker.js\":\"36f16fd67900d285\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/move-blocks/blockSubtreeMembership.js\":\"fa8f11aa5d55171c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/move-blocks/contextMenuItem.js\":\"8813ecc3286726e5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/move-blocks/index.js\":\"73f112dde002975d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/move-blocks/moveAction.js\":\"3ed8f0ecce20dea5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/move-blocks/moveBlocks.js\":\"9d4c802d8e129e23\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/move-blocks/selectionAfterMove.js\":\"4307144ac6acb63d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/TutorialBanner.js\":\"9a056306e990a216\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/action.js\":\"ebec538e3ed0f4c5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/bannerDismissal.js\":\"3d0283818220ab3f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/documents/cheatSheet.js\":\"67f910ce59b9d5e8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/index.js\":\"8d2e7c245a5d8c78\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/keys.js\":\"5c5ec2de142c7a34\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/landing.js\":\"2e21e79719bc6451\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/outline.js\":\"4fd339a010b9b3b1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/seed.js\":\"35c9e259d9e9795b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/PerfTrendDialog.js\":\"eefd007ad7b43dfb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/analyze.js\":\"7abda3a94a16b6aa\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/diagnosticsSource.js\":\"bb2b0d50b87429e4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/index.js\":\"874841c45e9d85c1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/load.js\":\"491229a13a95dcea\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/monitorRun.js\":\"768d1443f3a3a4f4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/schedule.js\":\"9ccec17d34abd4ab\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/series.js\":\"a16e32c7f8092088\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/store.js\":\"e3c701b0284020fa\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/trendAction.js\":\"63c7361774fb1673\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/verdict.js\":\"2358d1a585d27593\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/plain-outliner/clickToEditAction.js\":\"d19af25b800849ca\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/plain-outliner/index.js\":\"c2dc30adc4267215\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/plain-outliner/interactions.js\":\"2c6c4ca96a11a70e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"c999d5f87cf2b978\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/MigrationGate.js\":\"4b8f9de11705f5e0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/MigrationGateDialog.js\":\"52d089ab21f6e697\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/action.js\":\"d4240737cd142547\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/index.js\":\"b2e77987e40675df\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/localRunMessage.js\":\"4f718c0e7f17563d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/plugin.js\":\"c6605c6ef8a68879\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/progressReport.js\":\"5b5305424850f991\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/sweepProgress.js\":\"3e3d81e3de84cd3b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/FieldRowRenderer.js\":\"4362e4eefda6d51e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/ValueRowRenderer.js\":\"ec2a7717152ffc37\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/actions.js\":\"35ccb24fbfbbb94f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/autocomplete.js\":\"1fd7742f7af420d4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/fieldRow.js\":\"24776f198fdd00a5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/index.js\":\"ff151d9051b085fe\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/referenceWarning.js\":\"95dd89ffb2f13a30\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/valueAutocomplete.js\":\"4dfe1377b8fc8601\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/valueSchema.js\":\"e0c56362e9b354ff\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/quick-find/HeaderItem.js\":\"efcc3ebabd86f6b9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/quick-find/QuickFind.js\":\"dd88c17b92ea9d75\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/quick-find/index.js\":\"4e142d9108868c0b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/quick-find/recents.js\":\"8deb0c45aefee52c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/quick-find/resultItems.js\":\"d57641d4483eee96\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/quick-find/selection.js\":\"45ef0e09d08e5fb6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/quick-find/toggleStore.js\":\"4c57080cb719de8f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/recents/HeaderItem.js\":\"8ec35ccb5798a11f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/recents/RecentsPageBlockRenderer.js\":\"28ae2b1ef35e0340\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/recents/grouping.js\":\"bc34f4f91bd3ec64\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/recents/index.js\":\"9c651f7f557ccff5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/recents/target.js\":\"ce71a36c3401e1ee\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/codeMirrorExtensions.js\":\"ac11152973d921ed\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/contentPrefill.js\":\"bb68f6e0d6c8d949\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/dataExtension.js\":\"5f27681abb3e2217\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/index.js\":\"9481341a99262855\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"ac8608d31a7d5496\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/invalidation.js\":\"422adf5de737a932\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/localSchema.js\":\"283d1c21ecdc9fa7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/blockrefs/index.js\":\"ce8212c72a3a60ac\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"55fb81646b20a574\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/index.js\":\"c509ca965b97300d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/referenceNode.js\":\"b87d2ae3f89bda9a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/remark-reference-occurrences.js\":\"741d7b080558a0d1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"8badb7c8f11ffcf4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/wikilinks/index.js\":\"11a553939dac07f5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"65ddb33495ae7f18\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"74c558fdf78b937b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/mergeRetargetProcessor.js\":\"6717ab5faac58f78\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/parseFence.js\":\"4240dac0e7685bb8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/referenceParser.js\":\"766cdb2c3daaea97\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/referenceProjection.js\":\"f11b53b603eb0f43\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/referencesProcessor.js\":\"fd17cd67dce54c54\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/renameProcessor.js\":\"710584acbd51ab9a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/spanReplacement.js\":\"4e6100a5fd77791d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/rich-paste/htmlToOutline.js\":\"8281b19a504fdcd9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/rich-paste/index.js\":\"72d3342f382223dc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/rich-paste/normalizeClipboardDom.js\":\"0d7f468e2af5a422\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/rich-paste/pasteDecision.js\":\"5edc37fc32a55f2f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/action.js\":\"7c854e5f9199a78f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/blockIds.js\":\"f2a510cdba13b278\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/content.js\":\"f9dd0feb41b07536\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/effect.js\":\"014a1c311ff907a9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/ids.js\":\"d06cdc28d6b0f1de\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/import.js\":\"a5d636b6489b03e8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/index.js\":\"ace8bf3f092f723c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/plan.js\":\"43d70c44d5d41acd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/plugin.js\":\"67a22aa15760c89c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/promotion.js\":\"30363940138ffe7e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/properties.js\":\"822dc2e9c44bca11\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/references.js\":\"9014460fde24b9ed\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/report.js\":\"d20dfea20c61e452\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/roamMemo.js\":\"27c59f5364b3e607\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/runtime.js\":\"1073966cf20903e1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/schemaReconciliation.js\":\"9ff979a58c1226f2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/srsMarkers.js\":\"f853f71f4464f96d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/todo.js\":\"dab1c467977d2d3f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/typeCandidates.js\":\"a92157de41a56e14\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/types.js\":\"d8044bbcb9c671d7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/search-health/index.js\":\"8e786f489e1637bb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/search-health/store.js\":\"5ec9f649ef037e96\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/shortcut-help/HeaderItem.js\":\"387afb5c86e5409b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"ae1e1cb3045a1ccb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/shortcut-help/index.js\":\"c9f62a454c8987a5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/shortcut-help/model.js\":\"4af8c0e5c118fa49\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/shortcut-help/toggleStore.js\":\"d3da8c48a4c4715f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/shortcut-help/useKeyInspector.js\":\"b4a5dfe43d4984a0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"4989df79bf03db2b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/spatial-navigation/ShellDecorator.js\":\"7df73175cb2e07d5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/spatial-navigation/actions.js\":\"fc4074583556d669\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/spatial-navigation/exclusionsFacet.js\":\"de32dd291dcc1c9f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/spatial-navigation/index.js\":\"7a9476667805e7f7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/spatial-navigation/shell.js\":\"530afd4f0b870b97\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/spatial-navigation/surface.js\":\"c248edae52337fec\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/spatial-navigation/walker.js\":\"548bb051ecb8b763\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/RescheduleToast.js\":\"e2a48a24d63aa453\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/dataExtension.js\":\"57e030a4af42b252\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/index.js\":\"a1474623a6796bef\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/indicator.js\":\"972ccbb35faf1518\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/moveSrsState.js\":\"038cb06b980aa775\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"722f890e767c5340\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/scheduler.js\":\"e80e75779d8e0c5e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/schema.js\":\"3261276a65b73505\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"cd47eaef47a7bef7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/srsClipboard.js\":\"bef5e0fc740768fa\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"5f8cded8d017519d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/DailyNoteReviewHint.js\":\"5063ae5d639415f9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/DeckPicker.js\":\"774d41f3f6b9983d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/ReviewControls.js\":\"f9b84b090b5be2b7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/ReviewDeckRenderer.js\":\"7caedb664bb63e2e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/ReviewSession.js\":\"52e8cc6a7e5df2ed\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/actions.js\":\"78681b7ecebe15c4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/archive.js\":\"51b8cf606f4c3bdd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/dataExtension.js\":\"17671b62a5fc112d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/deck.js\":\"4fe333272819c54d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/dueQuery.js\":\"234fd3a492a2ebde\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/gradeDecision.js\":\"451f4c37c5270fd5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/index.js\":\"5d1f2b0068240a85\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/keyHints.js\":\"82da1cad3699d720\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/reviewCardLayout.js\":\"b11842df753a7e5f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/reviewProgress.js\":\"922def3ec7fb1a9d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/schema.js\":\"8e415442e8e3fab4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/useDueCards.js\":\"12918ca91909fe69\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/startup-metrics/index.js\":\"13a52573de0aa63f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/startup-metrics/record.js\":\"f3477f2d046848b6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/storage-persistence/index.js\":\"c290ef28e74d6fb6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/storage-persistence/persistenceStatus.js\":\"864242c3d418409c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/storage-persistence/requestAction.js\":\"82d64e1ec31434ce\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/supertags/TypeChipsDecorator.js\":\"30ce690cefe9b13b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/supertags/codeMirrorExtensions.js\":\"5eeb0895184f2f1b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/supertags/index.js\":\"48c0a7df93693108\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/supertags/typeAutocomplete.js\":\"7a5150919010e21d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"a126cdf9cd84766d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/swipe-quick-actions/actions.js\":\"e120374307088131\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/swipe-quick-actions/anchor.js\":\"f174a4de791e4364\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/swipe-quick-actions/events.js\":\"7d31f7a96ae32b02\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/swipe-quick-actions/gestureActions.js\":\"41f57af5a2983616\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/swipe-quick-actions/index.js\":\"cdce512388a046f4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"7ede248e84b8f4d4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/sync-metrics/collect.js\":\"f071e88e151f1572\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/sync-metrics/index.js\":\"e4c8261a25f3946a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/sync-metrics/record.js\":\"98d8b481edcd27c6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/system-status/RejectionDialog.js\":\"8383a13f618c34e5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/system-status/SystemStatusHeaderItem.js\":\"9ae06ed8fe9bde5a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/system-status/index.js\":\"3a03d126461cb37c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/system-status/model.js\":\"9e6b4314277191bc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/system-status/queueCounts.js\":\"b634b1f7a16cad1d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/system-status/rejectedHelpers.js\":\"c5599f5fffbc9250\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/system-status/rematerializeAction.js\":\"11039a0d983f7695\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/system-status/useHysteresis.js\":\"9292ed439a51cc99\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/ColumnHeaders.js\":\"c72364f231b5adde\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/QueryUi.js\":\"07408b2cb9ce5d1c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/TableLayout.js\":\"5cdb90c12e0e3695\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/actions.js\":\"8f78e02f837e680b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/cellEdits.js\":\"ffe3cb9b40b0cad0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/childrenViews.js\":\"9d53f724978862bd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/columns.js\":\"6ab8f34441fa16f8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/controller.js\":\"25abef8733d43e0e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/convert.js\":\"a2c556a4fa617875\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/dataExtension.js\":\"91b91f6bf7211e2c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/index.js\":\"70f8c276ebfe31fb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/keys.js\":\"ee3db9a65c7cb513\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/model.js\":\"6f670ed1b473947f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/query/QueryText.js\":\"35ecf926c098fffe\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/query/backfill.js\":\"e29dc216d116c315\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/query/completion.js\":\"3cf226c368efacf0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/query/format.js\":\"a96b1f2ee6839cff\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/query/parse.js\":\"2c08e4c854aeef6e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/query/queryValue.js\":\"d82d50cff468f487\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/query/registrations.js\":\"42894674d08e4f00\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/query/source.js\":\"9b260d69ce86904e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/registry.js\":\"45557e0770277c5f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/rowGutter.js\":\"181a783b92325e1a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/rowVerbs.js\":\"d9480ddc989e43d4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/schema.js\":\"49d8ec44bce91274\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/sort.js\":\"eec0b9233f3d057e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/theme-toggle/effect.js\":\"aebe27e7c9344763\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/theme-toggle/index.js\":\"8ccf44556ddfb898\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/theme-toggle/theme.js\":\"d6876983ce193d5a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/todo/actions.js\":\"c5991588ce73caef\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/todo/dataExtension.js\":\"04cd5c4e54eb5006\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/todo/index.js\":\"e6e722af267c677f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/todo/schema.js\":\"aaaafe9085eda79a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/touch-selection/TouchSelectionLayer.js\":\"181f2d659953863e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/touch-selection/actions.js\":\"115e8e8b23ced3f9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/touch-selection/defaultItems.js\":\"4fd92b8cad8e2459\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/touch-selection/facet.js\":\"60912b684cdb4cd1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/touch-selection/holdRecognizer.js\":\"609661b4f5a20994\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/touch-selection/index.js\":\"35d7b1e0a9b98419\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/update-indicator/UpdateIndicator.js\":\"a8afc784e3eb5936\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/update-indicator/index.js\":\"427051246264cc85\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/update-indicator/loadTimes.js\":\"4b5a7386d8f387e3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/VideoNotesRenderer.js\":\"3518ae0409d94fde\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/VideoPlayerRenderer.js\":\"da4d6f027cb09812\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/VideoTimeStamp.js\":\"ea74a654d88f20fd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/actions.js\":\"59563e30afbe2574\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/index.js\":\"dcf5fc234d6da5e5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/markdown.js\":\"5c01053d619be0ac\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/notes.js\":\"7c8f10e67603c96a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/registry.js\":\"bd03ec28f54773c1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/remark-timestamps.js\":\"db4446b76a7f520d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/view.js\":\"41199ec9f4ccf9e5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/vim-link-hints/LinkHints.js\":\"c995d1f9e833fdc3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/vim-link-hints/index.js\":\"9356ef0aa242f236\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/vim-link-hints/model.js\":\"9b22c7deb76689e0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/vim-link-hints/settings.js\":\"9ae63ab9f7cc4ebb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/vim-normal-mode/actions.js\":\"8e67d579c2474fbd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/vim-normal-mode/index.js\":\"27f566a835bea0ff\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/vim-normal-mode/interactions.js\":\"6b02f2e5baa824e4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/workspace-header/index.js\":\"d5c02a0ba1dde71e\",\"/knowledge-medium/pr-preview/pr-1925/src/registerServiceWorker.js\":\"c9e513da6d7939df\",\"/knowledge-medium/pr-preview/pr-1925/src/requestPersistentStorage.js\":\"be92444a691940e1\",\"/knowledge-medium/pr-preview/pr-1925/src/services/authRequestDeadline.js\":\"190bcfbb01b5f7b6\",\"/knowledge-medium/pr-preview/pr-1925/src/services/authStorage.js\":\"e1b8115b820b2699\",\"/knowledge-medium/pr-preview/pr-1925/src/services/powersync.js\":\"15f21df36474d258\",\"/knowledge-medium/pr-preview/pr-1925/src/services/supabase.js\":\"80cb8690caaa3d75\",\"/knowledge-medium/pr-preview/pr-1925/src/services/uploadErrorClassifier.js\":\"71be068e5c89e847\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/ActiveContexts.js\":\"86b798e648f1ea42\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/HotkeyReconciler.js\":\"dbe5c21088768bd1\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/WipeLocalDataDialog.js\":\"4b3a46ee400c7661\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/actionDispatch.js\":\"bbb0cec63189a13a\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/actionKeyHints.js\":\"6c6059f989ab9ea2\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/actionRefItems.js\":\"5cba7876b72a5ccc\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/applyKeybindingOverrides.js\":\"943658fc0581f897\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/blockActions.js\":\"ac30bc3f100a26b8\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/blockMergeGesture.js\":\"f6092fc22cddcc3c\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/canonicalizeChord.js\":\"bdc8c7f4b562d1db\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/defaultContexts.js\":\"06041859de94755f\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/defaultShortcuts.js\":\"8573dedee8317238\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/effectiveActions.js\":\"824f2d60b318d630\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/formatChord.js\":\"8f3f04643f81fe7d\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/gestureAction.js\":\"90a835124f597c59\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/gestureBinding.js\":\"bb831b830e017c5b\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/holdRegistry.js\":\"87302aa7662eaf27\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/keybindingConflicts.js\":\"8c3ace6b4232783a\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/keybindingOverrides.js\":\"26489df133d0499a\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/pointerAction.js\":\"c4e9a27ac714ebd2\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/resolve.js\":\"9d1466e0f668ff01\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/runAction.js\":\"a4b0c83f197aaa66\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/sequenceMatcher.js\":\"0130a65e1d0af3b5\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/types.js\":\"984b79aa2e6050ac\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/useActionContext.js\":\"7e35fc402fd99542\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/useActionDiscovery.js\":\"3474365a565f37f9\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/utils.js\":\"6ce83ae2f7022c48\",\"/knowledge-medium/pr-preview/pr-1925/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1925/src/sw/bootStore.js\":\"dcb19793e2c0e380\",\"/knowledge-medium/pr-preview/pr-1925/src/sw/previewDatabases.js\":\"c8c403391600454a\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/byteTransform.js\":\"978297b528b77307\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/attachmentCleaner.js\":\"2541a6d2a39a3c57\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/bundle/attachmentParts.js\":\"edb00bac509b2f96\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/bundle/bundleParts.js\":\"fdcf3eebd409f30c\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/bundle/bundleRecord.js\":\"54d1d05e47f10f0d\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/bundle/manifest.js\":\"1d510b2b63b7fd41\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/bundle/takeBundle.js\":\"cf33b2aa7f7b7f07\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/bundle/verifyBundle.js\":\"99f80231081a51bc\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/cleaningStage.js\":\"8b116060242b33a1\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/conversionKey.js\":\"0ec3c82ff0c5368e\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/conversionServer.js\":\"d1b36ee0ea8ac412\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/flip.js\":\"80da6a812334d879\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/flipAttempts.js\":\"e956aae5c152b94b\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/pages.js\":\"4b9a1553712f9beb\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/preflight.js\":\"4c6fcd208dee2c39\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/reseal.js\":\"61b7b1d55c55b917\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/runConversion.js\":\"a29f085fc1b619a2\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/runLock.js\":\"5cd166076b15450b\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/sealing.js\":\"d70d53ad5148aa9f\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/sealingStage.js\":\"07e3e7f5ff6882a1\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/stage.js\":\"0b42428db86e7ffa\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/verifyReseal.js\":\"b47a951042edcfd7\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/aad.js\":\"790456278509958e\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/aead.js\":\"4b76f2603528ae68\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/base32.js\":\"928228eb41ff09e4\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/base64url.js\":\"dfff209e2a06bf4b\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/binaryEnvelope.js\":\"45a273984ddb7931\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/byteAead.js\":\"20333210bd4e9e09\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/canary.js\":\"dac4d05a6572c918\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/contentHash.js\":\"b569fd31e2a1ae8a\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/contentKey.js\":\"d1589b4a69fe3b26\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/derivedIdNamespace.js\":\"87cc9f218dc8d01a\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/envelope.js\":\"d125c49ae28560d1\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/hex.js\":\"84985ac5e9d2a809\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/sha256Hex.js\":\"b6cc220139f73fb8\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/workspaceKey.js\":\"6e05ba5335fb7c8b\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/conversionState.js\":\"d2f603482d32322d\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/flows/createEncryptedWorkspace.js\":\"bbfce28e82de3117\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/flows/pastedKey.js\":\"ea42b197ac2ecda9\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"605ab19e8c33cb0e\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/flows/upgradeWorkspacePin.js\":\"f160b4f5c99cbfc7\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/keyStore.js\":\"7d6339c02f1d1c48\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/mintWorkspaceKey.js\":\"026f7defc2c7d8d3\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/modePin.js\":\"28c4f572322d238d\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/openWorkspaceKeys.js\":\"1253e8f1b863ac83\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/resolveWorkspaceEntry.js\":\"82062520fc144723\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/resolver.js\":\"abc5b4869a263377\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/workspaceAccess.js\":\"7599c9600d04eaad\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/transform.js\":\"317653de40656bc1\",\"/knowledge-medium/pr-preview/pr-1925/src/themeBootDefaults.js\":\"a1f893d2e12bc7fd\",\"/knowledge-medium/pr-preview/pr-1925/src/types.js\":\"7db739a912d35beb\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/ClientLocalSettings.js\":\"6c7311d39b203111\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/abortableSleep.js\":\"40d2ce7a8434443f\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/array.js\":\"91328f52206d225f\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/backlinkAutocomplete.js\":\"954a25e339cffa5b\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/blockCrumbs.js\":\"31de0cccac1ae57e\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/blockrefAutocomplete.js\":\"85f503fa1f4e02de\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/cadencedIdleJob.js\":\"1bfefeb07883c7a1\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/callbackSet.js\":\"bdb4e007f7203526\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/clientId.js\":\"c20622318408300c\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/codemirror.js\":\"218c8534c2f307dc\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/codemirrorCompletion.js\":\"1d601681d614ecf8\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/copy.js\":\"dfbd2eabc83e6635\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/dailyPage.js\":\"21bda4ca94fe4504\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/dbForensics.js\":\"b409b151d954bbb2\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/dbForensicsHooks.js\":\"2dc1884c707eda81\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/deleteBlockThroughUi.js\":\"d0ad4e152c13a76e\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/dialogs.js\":\"5c9020f78c0621b9\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/dom.js\":\"9496f08d8a9ab14b\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/downloadBlob.js\":\"b02a4cd1292298c9\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/drawnWalk.js\":\"81b759bebc9adf1c\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/exportSqliteDb.js\":\"6eb9c33001f716c3\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/fileSystemAccess.js\":\"e66e55c802f5a7ab\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/flipSlide.js\":\"f59913c33f254468\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/fnv1a.js\":\"a81ecc17009aa948\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/formatBytes.js\":\"afbbb56ea0dc231d\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/fuzzyRank.js\":\"95b9b73db6f63e60\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/idbKeyedStore.js\":\"6c32ddb93e4adf2f\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/idleCallbackPolyfill.js\":\"854fc3830d292791\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/keyboardAwareScroll.js\":\"536d8c501605ea87\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/keyboardViewport.js\":\"0413893e305e34f2\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/lastWorkspace.js\":\"579d4bb32b8f9e63\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/layoutColumns.js\":\"f37615ab7452a03f\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/layoutSessionDom.js\":\"b4831abe6bbb7634\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/layoutSessionId.js\":\"0906fa0386888807\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/linkClickGestures.js\":\"15dfba9e3fc86e36\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/linkTargetAutocomplete.js\":\"8afd977d5b7619dc\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/localDbCorruption.js\":\"ccb88329da9cbd84\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/localDbRecovery.js\":\"55f7bd6d9acb03ba\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/markdownParser.js\":\"ddad49b4d1c9809e\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/memoize.js\":\"82171e4e2fa781f5\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/nameFieldCommit.js\":\"0fb13d12b41791dc\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/nameList.js\":\"05985ab35e24a0b5\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/navigation.js\":\"a4cd9917f7649ae3\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/omnilinerNamespace.js\":\"0587ff769ea1aedd\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/opfsPageScan.js\":\"0595696b5dc953ed\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/panelClearance.js\":\"a1d0f3e1266dbe91\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/panelHistory.js\":\"45c557f2384ca00b\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/panelLanes.js\":\"f0781f86846dc034\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/panelLayoutProjection.js\":\"515e4ad18fad26b2\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/panelScrollAnchor.js\":\"297ffd3d2094ddf7\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/panelUrlFlags.js\":\"0872b3eae0af8742\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/platform.js\":\"8ab5838842e30476\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/pluralize.js\":\"df0136df8a69d620\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/propertyCreation.js\":\"a2ad71d344296dc7\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/propertyNavigation.js\":\"575dd2e030e22f81\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/propertyValueContext.js\":\"a254f6a107fc3af5\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/react.js\":\"93235db4ec8d26c4\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/relativeDate.js\":\"bb2691f37f2425d8\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/relativeTime.js\":\"4fb1ab4a669212d8\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/renderScope.js\":\"c5015b2f990a319d\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/resolvedThenable.js\":\"4349a573aa04b4cd\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/routing.js\":\"f892aa8a36fac07c\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/safeMode.js\":\"93d26ef7e6e2652a\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/scheduleIdle.js\":\"4f421cb9b3070f75\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/screenWakeLock.js\":\"18e8faecd90f3711\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/selection.js\":\"6bfeefe5055182ab\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/softKeyboardGrab.js\":\"0cc29bc27dff7662\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/startupTimeline.js\":\"70ab8d131e4afb90\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/state.js\":\"c2ef21c18436ebdc\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/string.js\":\"6920beac7adee6fa\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/surfaceZoom.js\":\"b9bc0eaec577cdc8\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/time.js\":\"756c87d22dff32cc\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/toast.js\":\"f35a0dc6c07ba7bb\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/toggleStore.js\":\"a8a4e6e1164931e8\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/untilStopped.js\":\"055ed0d2db1bd4d4\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/userActivity.js\":\"6be7fca9842cd557\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/viewTransition.js\":\"0e63b527fdf8e8a3\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/viewport.js\":\"ca5d08e328211f0a\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/webLock.js\":\"447cff3d29df36db\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/workspaceRecovery.js\":\"8435639105d9aa82\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/workspaceSnapshotStore.js\":\"5af01eb8460ebde3\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-compiler-runtime.js\":\"95fc43bc32da4d19\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-dom-client.js\":\"17eea8080a030cd2\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-dom-server-edge.js\":\"16795381af442560\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-dom-server.js\":\"f527ecff1c198914\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-dom-static-edge.js\":\"b1dda8f445e01357\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-dom-static.js\":\"44ea2aeb285aca44\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-dom-test-utils.js\":\"1fa8829b4328112e\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-dom.js\":\"b20ab3ed25891f02\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-jsx-runtime.js\":\"50cf8e1e0892bc65\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react.js\":\"8ae9a23dfcaf7cf9\",\"/knowledge-medium/pr-preview/pr-1925/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1925/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1925/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
