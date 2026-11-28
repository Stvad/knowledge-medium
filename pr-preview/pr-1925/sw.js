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
		buildId: "e9644aae755c-09fff4fd",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1925/\":\"cb66072f2f3fc853\",\"/knowledge-medium/pr-preview/pr-1925/index.html\":\"cb66072f2f3fc853\",\"/knowledge-medium/pr-preview/pr-1925/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1925/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1925/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1925/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1925/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1925/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1925/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1925/assets/FacadeVFS-UqkQmcF2.js\":\"19a7bacbaa239c4b\",\"/knowledge-medium/pr-preview/pr-1925/assets/OPFSCoopSyncVFS-B5lcVDXt.js\":\"2b5f4faab885a312\",\"/knowledge-medium/pr-preview/pr-1925/assets/OPFSWriteAheadVFS-BvJp6tWo.js\":\"0dacd265bb208c60\",\"/knowledge-medium/pr-preview/pr-1925/assets/wa-sqlite-CZzDLRmi.js\":\"de99cbc7ce174a11\",\"/knowledge-medium/pr-preview/pr-1925/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1925/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1925/assets/wa-sqlite-async-C2Wp0erQ.js\":\"bb1fb700b13493b9\",\"/knowledge-medium/pr-preview/pr-1925/assets/worker-CAg0Ezas.js\":\"3153e78fc220408b\",\"/knowledge-medium/pr-preview/pr-1925/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1925/chunks/app-D4v4kqTY.js\":\"07b9476a17d6829e\",\"/knowledge-medium/pr-preview/pr-1925/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1925/index.js\":\"df280ffa8946e488\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1925/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1925/assets/AccessHandlePoolVFS-DapMNzXS.js\":\"8dd92e753a8b1740\",\"/knowledge-medium/pr-preview/pr-1925/assets/IDBBatchAtomicVFS-BNOaG816.js\":\"bd9068cae858888f\",\"/knowledge-medium/pr-preview/pr-1925/assets/MemoryVFS-DPRNBzV8.js\":\"abeda537707329da\",\"/knowledge-medium/pr-preview/pr-1925/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1925/assets/mc-wa-sqlite-D1Oe8RDV.js\":\"96f4368f02ea8371\",\"/knowledge-medium/pr-preview/pr-1925/assets/mc-wa-sqlite-async-DsPoeweY.js\":\"956fd2d5a513c7ff\",\"/knowledge-medium/pr-preview/pr-1925/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1925/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1925/chunks/AccessHandlePoolVFS-BbBxXbDs.js\":\"67be07f25fcbef4f\",\"/knowledge-medium/pr-preview/pr-1925/chunks/FacadeVFS-D5wCMknQ.js\":\"b9d8726137118358\",\"/knowledge-medium/pr-preview/pr-1925/chunks/IDBBatchAtomicVFS-C3g6yDUy.js\":\"97bfc41a23359531\",\"/knowledge-medium/pr-preview/pr-1925/chunks/MemoryVFS-CcpZATIU.js\":\"2ccfd976b701e08f\",\"/knowledge-medium/pr-preview/pr-1925/chunks/OPFSCoopSyncVFS-DPfwcIkD.js\":\"49e5ef4846454bfc\",\"/knowledge-medium/pr-preview/pr-1925/chunks/OPFSWriteAheadVFS-bzuRQkdv.js\":\"ad5f3802b2db3383\",\"/knowledge-medium/pr-preview/pr-1925/chunks/Preview-CYEd-qPm.js\":\"26afbb09e1b8951c\",\"/knowledge-medium/pr-preview/pr-1925/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1925/chunks/card-BRudCgQ8.js\":\"e50b26374274bf8d\",\"/knowledge-medium/pr-preview/pr-1925/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1925/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1925/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1925/chunks/dist-CcMEqxiL.js\":\"1b99163b20fcad95\",\"/knowledge-medium/pr-preview/pr-1925/chunks/freezeExtensionImports-BIkyGElY.js\":\"3cb5e32517f16c99\",\"/knowledge-medium/pr-preview/pr-1925/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1925/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/pr-preview/pr-1925/chunks/mc-wa-sqlite-BqzrwCH3.js\":\"33ee09053e5f1586\",\"/knowledge-medium/pr-preview/pr-1925/chunks/mc-wa-sqlite-async-jsg6LZLF.js\":\"9828e63f42c41444\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-BKUqfpin.js\":\"9d6d782f1343a898\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-B_Fbg4nn.js\":\"1690b21b79ab1fff\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-CCFH9bv5.js\":\"c2125bf0331b832e\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-CQUNFlPA.js\":\"04aef8ffbd6b5b62\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-CXLMUwov.js\":\"a1484aae0f3f35c0\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-CnFcRHTD.js\":\"65a80b3f4ed6a8e5\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-DGu0aA6e.js\":\"fb313c64ab017535\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-RCEMPicW.js\":\"f251049d3bea65f0\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-dom-server-legacy.browser.production-tgln8r4V.js\":\"a91b42588e64fbee\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-dom-server.browser.production-qdNwkVBD.js\":\"f16a9cb15014db47\",\"/knowledge-medium/pr-preview/pr-1925/chunks/react-dom-server.edge.production-BqRz6Mqx.js\":\"c8fd5728a75138fc\",\"/knowledge-medium/pr-preview/pr-1925/chunks/server.browser-BPHM0dDQ.js\":\"c20437b22a12618c\",\"/knowledge-medium/pr-preview/pr-1925/chunks/textarea-CrueDQ7V.js\":\"5c403fbb74cd9655\",\"/knowledge-medium/pr-preview/pr-1925/chunks/ui-USoH27Zc.js\":\"66486b969ee0171f\",\"/knowledge-medium/pr-preview/pr-1925/chunks/wa-sqlite-CwRJLjPI.js\":\"110c0baeee81ab78\",\"/knowledge-medium/pr-preview/pr-1925/chunks/wa-sqlite-async-DudyhuEa.js\":\"03fc0fdbd1d979b9\",\"/knowledge-medium/pr-preview/pr-1925/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1925/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1925/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1925/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1925/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1925/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1925/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1925/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1925/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1925/src/App.js\":\"da7e0d4ebd55e268\",\"/knowledge-medium/pr-preview/pr-1925/src/appUpdate.js\":\"c59691f4905b5b19\",\"/knowledge-medium/pr-preview/pr-1925/src/appVersion.js\":\"c271ccbb22446e6b\",\"/knowledge-medium/pr-preview/pr-1925/src/bootstrap/initialLayout.js\":\"388aa4e3bfcffe79\",\"/knowledge-medium/pr-preview/pr-1925/src/bootstrap/openWorkspaceData.js\":\"f88d940afbcb6062\",\"/knowledge-medium/pr-preview/pr-1925/src/bootstrap/resolveWorkspace.js\":\"0f08abd248a412c7\",\"/knowledge-medium/pr-preview/pr-1925/src/bootstrap/workspaceBootstrap.js\":\"a33f873a91c55def\",\"/knowledge-medium/pr-preview/pr-1925/src/components/BlockComponent.js\":\"95b5729756961233\",\"/knowledge-medium/pr-preview/pr-1925/src/components/BlockCrumbs.js\":\"ccfe28d529800d4b\",\"/knowledge-medium/pr-preview/pr-1925/src/components/BlockEditor.js\":\"a92794e5fe37689c\",\"/knowledge-medium/pr-preview/pr-1925/src/components/BlockLoadingPlaceholder.js\":\"d4e1f18e35fa470a\",\"/knowledge-medium/pr-preview/pr-1925/src/components/BlockProperties.js\":\"c2115f7f27e118cd\",\"/knowledge-medium/pr-preview/pr-1925/src/components/BlockSearchPicker.js\":\"dc8f4c0b8ed9d058\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ConfirmBulkDeleteDialog.js\":\"3d8f4bbda9354bfb\",\"/knowledge-medium/pr-preview/pr-1925/src/components/DividerHandle.js\":\"01abc3b17c576edd\",\"/knowledge-medium/pr-preview/pr-1925/src/components/DraftEditor.js\":\"bbdd19e41a750025\",\"/knowledge-medium/pr-preview/pr-1925/src/components/GutterPill.js\":\"d8949566a61ec2bf\",\"/knowledge-medium/pr-preview/pr-1925/src/components/Header.js\":\"6fad9deecd79f9ff\",\"/knowledge-medium/pr-preview/pr-1925/src/components/LazyBlockComponent.js\":\"8cd755873b95ab38\",\"/knowledge-medium/pr-preview/pr-1925/src/components/Login.js\":\"ae2231bf1282853b\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ZoomableSurface.js\":\"fec00db25929378a\",\"/knowledge-medium/pr-preview/pr-1925/src/components/editModeKeepalive.js\":\"732518a2cef53ae7\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyDisplay/PropertyDisplayScope.js\":\"370ecaad69c247de\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"8b10fcf56d82f7cb\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/RefPropertyEditor.js\":\"939028e5e3ac6da9\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/RefTargetTypePicker.js\":\"2cb34f9d42fdfff0\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/SelectPropertyEditor.js\":\"368734b53e4cf30d\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/TypesPropertyEditor.js\":\"e03c8e7b0639e545\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/defaults.js\":\"b5ecd1d5b244c139\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/kernelValuePresets.js\":\"6db6e795919ba934\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/selectablePresets.js\":\"eca13d238ccf18cb\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyEditors/typesPropertyUi.js\":\"3f1ce77f0631ee07\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/AddPropertyForm.js\":\"dfa5c06c5159fe4b\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/PropertyPicker.js\":\"b0199ef80eeddbad\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/PropertyRow.js\":\"dee5eda5106e75bb\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/Rows.js\":\"ded5041e3a153897\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/actions.js\":\"ff1d30425e04acd1\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/declarationOnly.js\":\"ecf33561aeee6793\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/layout.js\":\"26ed3c33b4d11a7b\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/model.js\":\"de2a4f2ccb5d33e0\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/shapeUi.js\":\"42c3975a2be76226\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/shapes.js\":\"ec34b7c69a0d3cbd\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/usePropertyEditingActivation.js\":\"18976ba3d0f47d6b\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanel/visibility.js\":\"759c786584405d77\",\"/knowledge-medium/pr-preview/pr-1925/src/components/propertyPanelSections.js\":\"ab9377a9090f0dfb\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/BlockEmbed.js\":\"8cab225ed6e64012\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/BlockLink.js\":\"a6daa7b77b9b6f91\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/BlockRef.js\":\"4aa29282f108f5c0\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/CompactReferenceLink.js\":\"96e02460b5c12b86\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/ReferenceLink.js\":\"13d5aad2368ced91\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/cycleGuard.js\":\"c3bba9def370d6f9\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/cycleGuardContext.js\":\"5bc973deabe00dfa\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/linkInteraction.js\":\"83301e5df6329505\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/referenceLayout.js\":\"a1bb33feb56403b1\",\"/knowledge-medium/pr-preview/pr-1925/src/components/references/useBlockRefAncestors.js\":\"7ecd1848d5f56d71\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/BlockGutter.js\":\"e7f052745ac5a409\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/BlockInfoDialog.js\":\"6548c56c244d92ac\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/BlockReadText.js\":\"017e69619e033b16\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/BlockTypeBlockRenderer.js\":\"7414a72dc8aa818c\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/BulletHoverCard.js\":\"4149bdd46d88bedb\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/CodeMirrorContentRenderer.js\":\"e6a8ed16fda1cad3\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"b6b013d32c337479\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/ColumnResizeHandles.js\":\"2921979ac39398e6\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"bf710ddd83a96352\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/DefaultBlockRenderer.js\":\"c7a96ae31c754d43\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/LayoutRenderer.js\":\"8de9e2058a40e5a7\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/MarkdownContentRenderer.js\":\"413d80d2b6b9313c\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/MissingDataRenderer.js\":\"54540a6b9a700a2f\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/PanelRenderer.js\":\"d25851665a5202b2\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/PropertySchemaBlockRenderer.js\":\"41920c06a32c1136\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/TopLevelRenderer.js\":\"495a305b897ae32a\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/blockGutterMode.js\":\"1e62ab4758afd827\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/blockTitleText.js\":\"34fecbccfc92bb59\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/fieldCreationKeydown.js\":\"8d65d1f5be68acd5\",\"/knowledge-medium/pr-preview/pr-1925/src/components/renderer/layoutRootContext.js\":\"260d9b59265f2585\",\"/knowledge-medium/pr-preview/pr-1925/src/components/typeChip/TypeChip.js\":\"0df39401e2357988\",\"/knowledge-medium/pr-preview/pr-1925/src/components/typeChip/chipStyle.js\":\"a9b43e66a5c1ba2b\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/anchored-floating.js\":\"05fdd286b2ea5961\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/button.js\":\"797e4e47ac7ef26a\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/card.js\":\"1b7a79aa219ee728\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/checkbox.js\":\"a672996f80348159\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/collapsible.js\":\"8492a2aa34a9753c\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/command.js\":\"5af76bfe58be11dd\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/context-menu.js\":\"ef5e24356fefb0e0\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/dialog.js\":\"39a25ddd4f923d2f\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/dropdown-menu.js\":\"746591bd6bb946a7\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/floating-listbox.js\":\"775771147a058178\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/index.js\":\"32a1aa89431ad1a1\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/input.js\":\"6c8a951de84d881e\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/kbd.js\":\"626518d6ae32e5fc\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/label.js\":\"ea572df525b6daca\",\"/knowledge-medium/pr-preview/pr-1925/src/components/ui/textarea.js\":\"d5806a06dad55d56\",\"/knowledge-medium/pr-preview/pr-1925/src/components/useEditModeYieldKeepalive.js\":\"2c419caeb3213d1b\",\"/knowledge-medium/pr-preview/pr-1925/src/components/util/BootFallback.js\":\"ac61340370a9a98b\",\"/knowledge-medium/pr-preview/pr-1925/src/components/util/FocusedRowLazyMount.js\":\"3e81d4a3aef30f6b\",\"/knowledge-medium/pr-preview/pr-1925/src/components/util/LazyViewportMount.js\":\"72bf6bf911f7819d\",\"/knowledge-medium/pr-preview/pr-1925/src/components/util/LocalDbCorruptionFallback.js\":\"7b65a4e6bbb51eb4\",\"/knowledge-medium/pr-preview/pr-1925/src/components/util/error.js\":\"7600994e7208e7fa\",\"/knowledge-medium/pr-preview/pr-1925/src/components/util/lazyMountRegistry.js\":\"578d15ec553f5599\",\"/knowledge-medium/pr-preview/pr-1925/src/components/util/suspense.js\":\"74d42d23c6c4173d\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/CreateWorkspaceDialog.js\":\"0ac012f1c1382786\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/PendingInvitations.js\":\"c8b7976d4721ff0c\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/SyncProgress.js\":\"81b545c759a404eb\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/UnlockProgress.js\":\"deffb886876bee99\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/WorkspaceKeyGate.js\":\"d69d31f086388dad\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/WorkspaceSettingsDialog.js\":\"67617d81f3a10867\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/WorkspaceSwitcher.js\":\"a654b96d2106bc45\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/WorkspaceSyncGate.js\":\"aacba3053ea0515f\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/ConversionFlow.js\":\"9f8d1bca68906ddb\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/ConversionFlowHost.js\":\"87204d7cb950f7f8\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/EncryptionSection.js\":\"9703878234e44354\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/attachmentPrompts.js\":\"5ae1dfab3b364e99\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/bundleFolderPrompts.js\":\"a85444b12227331b\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/conversionFlowDeps.js\":\"17235e9007e88851\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/conversionFlowStore.js\":\"6eecf089520a56d4\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/flowUi.js\":\"d0f565ebad4ab04a\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/conversion/useConversionRun.js\":\"62e1e64ddb658cd3\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/keyUi.js\":\"9f9541e0dfc924fd\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/useCloseOnKeyLoss.js\":\"e0c93f3642a23cdb\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/useCloseOnServerE2ee.js\":\"05124132bcec8a99\",\"/knowledge-medium/pr-preview/pr-1925/src/components/workspace/workspaceUnlocked.js\":\"59fd0c8dd07f5480\",\"/knowledge-medium/pr-preview/pr-1925/src/context/backgroundSubtree.js\":\"ce8e9a1dd2f29c68\",\"/knowledge-medium/pr-preview/pr-1925/src/context/block.js\":\"9ec76ef324e7fb5e\",\"/knowledge-medium/pr-preview/pr-1925/src/context/layoutWsContext.js\":\"0a512855f1b94081\",\"/knowledge-medium/pr-preview/pr-1925/src/context/propertyDisplay.js\":\"25e7c3c28324dd33\",\"/knowledge-medium/pr-preview/pr-1925/src/context/repo.js\":\"eaa5af146ee37cb8\",\"/knowledge-medium/pr-preview/pr-1925/src/data/aliasClaim.js\":\"bbd5df5586ddc444\",\"/knowledge-medium/pr-preview/pr-1925/src/data/aliasSeatNamespace.js\":\"4139d3dc116a6354\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/blockData.js\":\"9ec4047bf815cbe6\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/blockType.js\":\"3ee57a82f9e20ddc\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/changeScope.js\":\"45cd3d28e919c41b\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/codecs.js\":\"fb97bc61a1ef98fa\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/derivedData.js\":\"a8f3a85048678375\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/errors.js\":\"8238fdab2d7af2fd\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/events.js\":\"d11086740fca69ba\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/handle.js\":\"203d43794d775b71\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/index.js\":\"04951511dc4a58ba\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/mutator.js\":\"599a0e2e44579637\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/processor.js\":\"0b75fb14524ea316\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/propertySchema.js\":\"e0af01bd69301c13\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/query.js\":\"335cffcf60b9986e\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/sameTxProcessor.js\":\"b82ee57f7db0d82a\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/schema.js\":\"203d43794d775b71\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/tx.js\":\"203d43794d775b71\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/typedBlockQuery.js\":\"51a75b7afd1e6222\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/user.js\":\"e52cd4fd47ba147d\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/valuePresetCore.js\":\"c4b820d5a012c1b3\",\"/knowledge-medium/pr-preview/pr-1925/src/data/api/valuePresets.js\":\"4304c2f18ed126fa\",\"/knowledge-medium/pr-preview/pr-1925/src/data/attachmentCleanerIOVerb.js\":\"55c53211318c37b4\",\"/knowledge-medium/pr-preview/pr-1925/src/data/block.js\":\"2184aeaa30f40d45\",\"/knowledge-medium/pr-preview/pr-1925/src/data/blockCache.js\":\"7015e80efa75e34f\",\"/knowledge-medium/pr-preview/pr-1925/src/data/blockId.js\":\"651ff43b38036ba7\",\"/knowledge-medium/pr-preview/pr-1925/src/data/blockLiveness.js\":\"bb3bc59cc54764ff\",\"/knowledge-medium/pr-preview/pr-1925/src/data/blockMerge.js\":\"ff660aab443a32df\",\"/knowledge-medium/pr-preview/pr-1925/src/data/blockSchema.js\":\"fe464ee1745a7919\",\"/knowledge-medium/pr-preview/pr-1925/src/data/blockTypeLookup.js\":\"f179bad9358c3390\",\"/knowledge-medium/pr-preview/pr-1925/src/data/blockTypes.js\":\"78dd28b4b3ec7b45\",\"/knowledge-medium/pr-preview/pr-1925/src/data/childrenView.js\":\"4d03378a530d3e41\",\"/knowledge-medium/pr-preview/pr-1925/src/data/clientContext.js\":\"0b3dd98a21f07486\",\"/knowledge-medium/pr-preview/pr-1925/src/data/dbFileSiblings.js\":\"527d03068ce236c9\",\"/knowledge-medium/pr-preview/pr-1925/src/data/definitionSeeds.js\":\"85eafd8ee49879ef\",\"/knowledge-medium/pr-preview/pr-1925/src/data/derivedIds.js\":\"b744249225ca4779\",\"/knowledge-medium/pr-preview/pr-1925/src/data/drawnSubtree.js\":\"da57b46e467358d3\",\"/knowledge-medium/pr-preview/pr-1925/src/data/facetBridge.js\":\"f9afe67a39806398\",\"/knowledge-medium/pr-preview/pr-1925/src/data/facets.js\":\"b29e8b96175ea509\",\"/knowledge-medium/pr-preview/pr-1925/src/data/globalState.js\":\"340e2ff0007bae0a\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/aliasClaimRederiveProcessor.js\":\"1b300e4a0bf7c65b\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/ancestorBatch.js\":\"e6af9a6ff4baa5e2\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/blockTypeTypeifyProcessor.js\":\"b49527e94b373c4e\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/clientSchema.js\":\"d6fcd215edfe3379\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/commitPipeline.js\":\"205cab5339dd2a27\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/devAssertions.js\":\"59c3afdb1bce948b\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/firstSync.js\":\"8b2acba4e49a6ca0\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/freshInitialLoad.js\":\"51f6f9518e0b6120\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/graphBackfillClaim.js\":\"9e420729b10d59fa\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/handleStore.js\":\"2f6e75f34648e325\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/idleMarkerJobs.js\":\"e2d99a57f05c2712\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/initialDownload.js\":\"b498937fa149f904\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/initializeClientDatabase.js\":\"60fd13c8e5106f6c\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/jsonCanonical.js\":\"5e1a3215c398c810\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/kernelInvalidation.js\":\"1acca7b1168966c2\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/kernelProcessors.js\":\"a118efe1fcf6b362\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/kernelQueries.js\":\"d82a1300541e2a2d\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/mergeTypeMembershipProcessor.js\":\"6b8254faab781e36\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/normalizeReferencesProcessor.js\":\"5a28460e9f802e12\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/poolInstrumentation.js\":\"6e313dfa2031d561\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/processorRunner.js\":\"e02aa47376e264b5\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/propertyCellBackfill.js\":\"ff475c4485b56b5e\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/propertyChildMint.js\":\"1970f5cb27864d3d\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/propertyChildrenProcessor.js\":\"a2e79319e055ada9\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/propertyDefinitionChangeProcessor.js\":\"2e90a800a466ad14\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/propertyDefinitionSynthesis.js\":\"3d5d13cdfea07b96\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/propertyKeyScan.js\":\"0b19d8125172c839\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/propertySchemaResolution.js\":\"2aa335f3863eaa8c\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/propertyValueEdits.js\":\"ebc5cf5ef98e64f7\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/raiseProtocol.js\":\"a341903ee30718a6\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/readBatch.js\":\"1a8af1f5aeb662aa\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/refProjection.js\":\"68f49a48be3c3d17\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/referenceTargetLookups.js\":\"e3fda681738d5d31\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/referenceTargetProcessor.js\":\"7aeb9cfeca73be19\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/replayMerge.js\":\"69b754986c6345ab\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/sqlBinds.js\":\"d782901a55a83f3e\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"3ba0d04322ea256a\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/syncObserver/arrivalProcessors.js\":\"64b45d7cf8cd8f4e\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/syncObserver/invalidate.js\":\"f8fdd36086878ef0\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/syncObserver/materialize.js\":\"7cc935b484bc15c3\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/syncObserver/observer.js\":\"96b8f562221cea0e\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/syncObserver/reconcile.js\":\"1dbf13ff3a4e51fd\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/timingMetrics.js\":\"ff1d6a78000b2742\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/treeQueries.js\":\"a26a66513d85f11e\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/txEngine.js\":\"65bf4035e79d7912\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/txSnapshots.js\":\"c906de83a93558be\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/typedBlockQuery.js\":\"9fc1688b85a35b0e\",\"/knowledge-medium/pr-preview/pr-1925/src/data/internals/undoManager.js\":\"f54893bcee67e012\",\"/knowledge-medium/pr-preview/pr-1925/src/data/invalidation.js\":\"507e84f9fd589d0a\",\"/knowledge-medium/pr-preview/pr-1925/src/data/kernelDataExtension.js\":\"7adcf2f05b91a3ab\",\"/knowledge-medium/pr-preview/pr-1925/src/data/kernelPage.js\":\"bd6e82500d9bba7e\",\"/knowledge-medium/pr-preview/pr-1925/src/data/kernelValuePresetCores.js\":\"316299d4ccd2a625\",\"/knowledge-medium/pr-preview/pr-1925/src/data/localDbCorruptionSignal.js\":\"1ab3e35a8b7b9064\",\"/knowledge-medium/pr-preview/pr-1925/src/data/localDbStorage.js\":\"9fcd0e7febf9098c\",\"/knowledge-medium/pr-preview/pr-1925/src/data/localDbVfs.js\":\"d2a47916b7f4c906\",\"/knowledge-medium/pr-preview/pr-1925/src/data/localSchema.js\":\"7f9f2c3f23177dc9\",\"/knowledge-medium/pr-preview/pr-1925/src/data/maintenance.js\":\"ec40eb1b97f7c205\",\"/knowledge-medium/pr-preview/pr-1925/src/data/mergeProperties.js\":\"c316ca065fda2bc3\",\"/knowledge-medium/pr-preview/pr-1925/src/data/metricsConsoleHook.js\":\"a385943d2ae18f7e\",\"/knowledge-medium/pr-preview/pr-1925/src/data/migrationsPage.js\":\"8c2da5663a07f1ea\",\"/knowledge-medium/pr-preview/pr-1925/src/data/mutators.js\":\"dd8e432df752c27b\",\"/knowledge-medium/pr-preview/pr-1925/src/data/orderKey.js\":\"6dce7f23a4791009\",\"/knowledge-medium/pr-preview/pr-1925/src/data/orderKeyPlacement.js\":\"d62ae33d21bd35d5\",\"/knowledge-medium/pr-preview/pr-1925/src/data/outlineSurface.js\":\"8682712840bd127f\",\"/knowledge-medium/pr-preview/pr-1925/src/data/pendingEditorContent.js\":\"9e4f43549ac99c4a\",\"/knowledge-medium/pr-preview/pr-1925/src/data/pendingUploadsSql.js\":\"81f575ba5b6ee68f\",\"/knowledge-medium/pr-preview/pr-1925/src/data/pluginStateExtensions.js\":\"33c677e06e6cddea\",\"/knowledge-medium/pr-preview/pr-1925/src/data/powerSyncLogger.js\":\"86498dd69a5ec4dc\",\"/knowledge-medium/pr-preview/pr-1925/src/data/projectorRuntime.js\":\"e6a775ac448f4273\",\"/knowledge-medium/pr-preview/pr-1925/src/data/properties.js\":\"b2e22648a97d1461\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertiesPage.js\":\"ace92411fa42cd26\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertyChildren.js\":\"93b87d18163b7478\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertyDefinitionFanout.js\":\"1eaa50dc5657656d\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertyDefinitionMetadata.js\":\"d1dde4d80387a08a\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertyDefinitionRegistry.js\":\"074d775cf98cba52\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertyDisplayMode.js\":\"0e4250c8dff2f419\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertyRowCreation.js\":\"e61f931be18bc95a\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertySchemaCreation.js\":\"21f470330a80c2b5\",\"/knowledge-medium/pr-preview/pr-1925/src/data/propertySeeds.js\":\"00be50703cb192bd\",\"/knowledge-medium/pr-preview/pr-1925/src/data/recentsPage.js\":\"c01874c24b0acff9\",\"/knowledge-medium/pr-preview/pr-1925/src/data/refTargetComparableProperty.js\":\"7ad5890832f965d8\",\"/knowledge-medium/pr-preview/pr-1925/src/data/referenceBlock.js\":\"ff6b1c8d43e20edb\",\"/knowledge-medium/pr-preview/pr-1925/src/data/rejectedUploads.js\":\"786d14a310a427d9\",\"/knowledge-medium/pr-preview/pr-1925/src/data/releasePowerSyncConnection.js\":\"1e3a59b11757db80\",\"/knowledge-medium/pr-preview/pr-1925/src/data/repo.js\":\"cf707c244d4e5aa1\",\"/knowledge-medium/pr-preview/pr-1925/src/data/repoProvider.js\":\"e802710dc4bcc538\",\"/knowledge-medium/pr-preview/pr-1925/src/data/rowProperty.js\":\"75dd87ee77aa726e\",\"/knowledge-medium/pr-preview/pr-1925/src/data/searchFilter.js\":\"4b7096d8d74d9c20\",\"/knowledge-medium/pr-preview/pr-1925/src/data/seedIdentityLedger.js\":\"06610cad623c2ea5\",\"/knowledge-medium/pr-preview/pr-1925/src/data/stateBlocks.js\":\"428444239e6ef9b8\",\"/knowledge-medium/pr-preview/pr-1925/src/data/structuralEditPolicy.js\":\"ee5f7ea1d9174271\",\"/knowledge-medium/pr-preview/pr-1925/src/data/structuralInsert.js\":\"b944b63328fb6449\",\"/knowledge-medium/pr-preview/pr-1925/src/data/subtreeDelete.js\":\"94dfa1e8cdc98eba\",\"/knowledge-medium/pr-preview/pr-1925/src/data/syncStreamLock.js\":\"b0d343fd3e6a140a\",\"/knowledge-medium/pr-preview/pr-1925/src/data/syncedTableSqlRecognizer.js\":\"b1e906febc043899\",\"/knowledge-medium/pr-preview/pr-1925/src/data/syncedTableWriteGuard.js\":\"d374ede73c9576a8\",\"/knowledge-medium/pr-preview/pr-1925/src/data/targets.js\":\"d5bfb8c8abad35c5\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typeColors.js\":\"5cb970bcddebddb7\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typeDefinitionMetadata.js\":\"b8836a096c0eb1d1\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typeDefinitionRegistry.js\":\"74275409d6a2bb27\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typeExtraction.js\":\"114268f80800f0b7\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typeInitialValues.js\":\"2d8b71fce6f890b6\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typePropertyGroups.js\":\"4a12641d7a91e685\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typeSeeds.js\":\"ebf7462f1cc7a943\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typeTagger.js\":\"a54b26f75f8acdf3\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typedRecords.js\":\"4af6edb0281f24d1\",\"/knowledge-medium/pr-preview/pr-1925/src/data/typesPage.js\":\"bd83a90f78a0cc40\",\"/knowledge-medium/pr-preview/pr-1925/src/data/userPrefs.js\":\"71338f7f489f773f\",\"/knowledge-medium/pr-preview/pr-1925/src/data/userSchemasService.js\":\"b10f015210272efb\",\"/knowledge-medium/pr-preview/pr-1925/src/data/userTypesService.js\":\"99c55af92f2833f2\",\"/knowledge-medium/pr-preview/pr-1925/src/data/valuePresetRegistry.js\":\"e043566233a45450\",\"/knowledge-medium/pr-preview/pr-1925/src/data/visibleChildren.js\":\"d9bbc4a448afb327\",\"/knowledge-medium/pr-preview/pr-1925/src/data/workspaceConversion.js\":\"9043261746c2677a\",\"/knowledge-medium/pr-preview/pr-1925/src/data/workspaceFirstSync.js\":\"36778f3113cc9635\",\"/knowledge-medium/pr-preview/pr-1925/src/data/workspaceIdNamespace.js\":\"4d7b73e0b909165e\",\"/knowledge-medium/pr-preview/pr-1925/src/data/workspaceSchema.js\":\"06f16e52483b72de\",\"/knowledge-medium/pr-preview/pr-1925/src/data/workspaces.js\":\"cf24c173272ecd4e\",\"/knowledge-medium/pr-preview/pr-1925/src/data/writeAheadLog.js\":\"9e15b74134ee1928\",\"/knowledge-medium/pr-preview/pr-1925/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/BlockPasteShellDecorator.js\":\"e90452a3d97371f9\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/atTrigger.js\":\"e39cea08ff283449\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/autocomplete.js\":\"fcd5f09b957bd6e2\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/codeMirrorExtensions.js\":\"485175b88c415001\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/contentFlush.js\":\"de50e0839bb8b2a8\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/defaultInteractions.js\":\"8d15bb11cabe65e6\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/editSettleSignal.js\":\"a4a59c7e9e48a110\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/insertImage.js\":\"31f082f629a7b8f4\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/referenceCompletionRange.js\":\"1f234ca4a5a09cdc\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/referenceTargetTypes.js\":\"326d660e84afa274\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/syntaxContext.js\":\"b97c67d66790deb0\",\"/knowledge-medium/pr-preview/pr-1925/src/editor/triggerMatch.js\":\"3d99a0d79f1f34a2\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/AppRuntimeProvider.js\":\"04951c2b83ae34b6\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/BlockFocusShellDecorator.js\":\"2818bc9f0410df85\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/ExtensionRenderBoundary.js\":\"fa0f22f13990dcb9\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/PanelContentRecovery.js\":\"42862de0d83315b9\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/apiCatalog.js\":\"d1716b7e65712431\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/appRuntimeController.js\":\"6f7a7b5c4872c83e\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/approveExtensionHere.js\":\"62aad801084bda4d\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/armedCutAppMount.js\":\"79fb3b1d26968121\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/batchableKeyedStore.js\":\"69237e0218c4f5b7\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/blockInteraction.js\":\"dd44366a6a5d8904\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/blockSelectionAction.js\":\"8b599c2dc555e08f\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/buildApprovalRecord.js\":\"bf89ad7e19234aa6\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/compileExtensionModule.js\":\"b2ef7fd6952ce74f\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/compiledModuleCache.js\":\"910536b1a6749701\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/continuousGestures.js\":\"08180d2fe7b06e0b\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/core.js\":\"9ccd3702484edda9\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/defaultRenderers.js\":\"800900443e4628bb\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/definitionFanoutAppMount.js\":\"d27346929a36cbe7\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/dialogAppMount.js\":\"9e56b2a88ebddd46\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/dynamicExtensionSeeds.js\":\"5447b3a4d32a19fa\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/dynamicExtensions.js\":\"e89370e88405b167\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/exampleExtensions.js\":\"123c86470df12a28\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/extensionApprovalStatus.js\":\"90ad261d3c6d848b\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/extensionImportPolicy.js\":\"4b0ad8a331c9f55e\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/extensionLoadErrorToast.js\":\"c41d8c35bc172a42\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/extensionLoadErrors.js\":\"817791c90eba3802\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/extensionLookup.js\":\"986f1f2ce628ce48\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/extensionToggles.js\":\"9c7ed70ef224d5a7\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/extensionUtilitiesCss.js\":\"1a7a86fb99689add\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/kernelPageDeletionGuard.js\":\"c3474092eade2b0b\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/liveRuntime.js\":\"631a221fcc4b51ea\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/normalizeExtensionSource.js\":\"8e5d34d50652eda8\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/openExtensionsSettings.js\":\"2ba8c29620ea2cd2\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/overridesCache.js\":\"a3d2c43fea3e05c8\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/pluginIds.js\":\"2a0ed3d5e4f7e2b5\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/processorRejectionToast.js\":\"beedd814ff8375c8\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/runtimeActions.js\":\"f0b0c01254e49b66\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/runtimeContext.js\":\"19c6c7784cc58b77\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/staticAppExtensions.js\":\"da9d4e922acf5d03\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/staticDataExtensions.js\":\"0283bb763518ca6d\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/toastAppMount.js\":\"5aa9be7494ecab0d\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/transpileExtension.js\":\"62e8ab05e0829342\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/useOverrides.js\":\"2296b7d96f54712e\",\"/knowledge-medium/pr-preview/pr-1925/src/extensions/useShortcutSurfaceActivations.js\":\"d25bf508eb283e95\",\"/knowledge-medium/pr-preview/pr-1925/src/facets/discoverToggleTree.js\":\"4b58e4f83cc698ef\",\"/knowledge-medium/pr-preview/pr-1925/src/facets/facet.js\":\"489af5b87e1984bf\",\"/knowledge-medium/pr-preview/pr-1925/src/facets/resolveAppRuntime.js\":\"69fcbf33a8d249a4\",\"/knowledge-medium/pr-preview/pr-1925/src/facets/runtimeEvents.js\":\"f0ede0483aefb7c8\",\"/knowledge-medium/pr-preview/pr-1925/src/facets/togglable.js\":\"7251cdbec1584594\",\"/knowledge-medium/pr-preview/pr-1925/src/facets/variantFacet.js\":\"344748bf7c168e20\",\"/knowledge-medium/pr-preview/pr-1925/src/facets/verbFacet.js\":\"667e76d0fe12f744\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/block.js\":\"cacbae6db9d3b774\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/focusedChild.js\":\"c97d59121d1dafde\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/propertySchemas.js\":\"3f50cda75e398139\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/typeRegistry.js\":\"6a8b7ed167a61b76\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useAncestorCrumbs.js\":\"7c3796e1293277f4\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useAutocompleteListbox.js\":\"ffb27c0f3652a63e\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useDebouncedSearch.js\":\"99b9d14a8215aadd\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useDebouncedValue.js\":\"94844e8d068deb81\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useFacetValue.js\":\"9e9fc6b160ff89ed\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useIsFocalRender.js\":\"4e634806dc2e44f5\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useIsReadOnly.js\":\"b26fa6f12b8293a8\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useMaterializeBacklog.js\":\"3d19ef197b39806c\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useMinuteClock.js\":\"10b8a10bd6cf32b2\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/usePanelLayoutProjection.js\":\"eb6207d6c9a3d546\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/usePendingInvitations.js\":\"f32332b91c9f8620\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useRendererRegistry.js\":\"5c9bc3e92df52408\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useRetainedFieldRows.js\":\"da52bd46c494d4f1\",\"/knowledge-medium/pr-preview/pr-1925/src/hooks/useWorkspaces.js\":\"cb2536e35b42097f\",\"/knowledge-medium/pr-preview/pr-1925/src/lib/utils.js\":\"32039cfdd659eca1\",\"/knowledge-medium/pr-preview/pr-1925/src/main.js\":\"4ea2d5889ccca5e7\",\"/knowledge-medium/pr-preview/pr-1925/src/markdown/MarkdownImage.js\":\"17cd86bdf31b804a\",\"/knowledge-medium/pr-preview/pr-1925/src/markdown/blockSeparators.js\":\"b67374118eacb407\",\"/knowledge-medium/pr-preview/pr-1925/src/markdown/context.js\":\"7c910f08b1391b06\",\"/knowledge-medium/pr-preview/pr-1925/src/markdown/defaultMarkdownExtension.js\":\"1c5124a53ac7b4b2\",\"/knowledge-medium/pr-preview/pr-1925/src/markdown/extensions.js\":\"0beaf59b1bde96cb\",\"/knowledge-medium/pr-preview/pr-1925/src/markdown/renderMarkdownHtml.js\":\"ebddbcdeded8bd7b\",\"/knowledge-medium/pr-preview/pr-1925/src/minimal-editor.js\":\"a71adafd0e718040\",\"/knowledge-medium/pr-preview/pr-1925/src/paste/armedCut.js\":\"761229a8bd534431\",\"/knowledge-medium/pr-preview/pr-1925/src/paste/captureMediaVerb.js\":\"8082c1cbeb6f9b75\",\"/knowledge-medium/pr-preview/pr-1925/src/paste/clipboard.js\":\"42b14e10639449b5\",\"/knowledge-medium/pr-preview/pr-1925/src/paste/decision.js\":\"2b3441a8820f1781\",\"/knowledge-medium/pr-preview/pr-1925/src/paste/operations.js\":\"7277759d61720617\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/account-header/AccountHeaderItem.js\":\"74d90c35a57d31ee\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/account-header/index.js\":\"01b1a76cf0df81e3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"c77fe14583e5bee3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/askAgent.js\":\"34b63babbdb714ed\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/askedStore.js\":\"dcdb20380f81bb81\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"0801bddff6dd112f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/chipState.js\":\"f0818313eed9c91e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/dataExtension.js\":\"28eb04edf9e3edf5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/index.js\":\"4e01d608437c5ed0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"92aefb331ccc1a3f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-dispatch-companion/schema.js\":\"dd00af7650934e0d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/AgentTokensDialog.js\":\"d18bdf10838176a3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/BridgePairingDialog.js\":\"982d327b42f7abc8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/addMedia.js\":\"a76f9e5aaf1ae48f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/backlinks.js\":\"f611441bb4495eaa\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/block.js\":\"b74024f5b3f632d4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/context.js\":\"d2a00e967e6f57f2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/displayIds.js\":\"280ef4a12a283c1b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/index.js\":\"67d3bc316f389d5c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/outline.js\":\"6ef5d49fffb8ac2f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/properties.js\":\"8020294f5dd1aaee\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/refs.js\":\"00d1dab08b44b406\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"12fd7f05355bdef2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/search.js\":\"9059705e53504223\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/shared.js\":\"eabfc9e57406cce2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"950dbc80024f67dc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentViews/text.js\":\"b29920a98864e318\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/agentWrites.js\":\"64e62c4567690cab\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/authoringCatalog.js\":\"1e275050d00c41c0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/blockRefTargets.js\":\"84d484ac99a947f5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/bridge.js\":\"d4ba19608b298ec2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/bridgeLoop.js\":\"e41c8aa7c46247f3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/changeHistory.js\":\"43be527cfb90d3d8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/commands.js\":\"3f242f18605e9df6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/commentsCommands.js\":\"db4699336dee9119\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/dataExtension.js\":\"f3b7121d42b5a8e3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/dataModelGuide.js\":\"5490a6b796f96737\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/dayPropertyInputs.js\":\"ac4d06fdfc914b8a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/describeRuntime.js\":\"96a4560969c90c77\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/extensionLint.js\":\"daca3761a58d93cc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/grainAudit.js\":\"de049ea4c8fba59e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/healthCommand.js\":\"1fbe2f92aed09e3a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/index.js\":\"201492853bdaea27\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/presetIdentity.js\":\"6938e8e29bdf8a75\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"8b6ac097504ce71e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/readMedia.js\":\"91875a1750c5ca31\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/schema.js\":\"534de4512d05392c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/serialization.js\":\"de9427343b982fbd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/targets.js\":\"ca185c01239cda13\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/tokens.js\":\"8b2e57ac6b1c99ae\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/watchEvents.js\":\"0eca69901b90396a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/workspaceGuard.js\":\"a9953460a3404db9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/agent-runtime/writeCommands.js\":\"1a52fe7d53e13a2d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/AliasCollisionToast.js\":\"b3a4737b45d4a665\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/DuplicateNameBanner.js\":\"81ca781d64a92432\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/collisionMerge.js\":\"7d0c60698ce73bb0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/dataExtension.js\":\"b1a6483833c9c380\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/index.js\":\"2d0a6d08a7645342\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/mergeCollisionAction.js\":\"e4f7a877c6b0b935\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/pageStyling.js\":\"dd973a4885bce36f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/rejectionToast.js\":\"799fb7a37db55e07\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/alias/syncProcessor.js\":\"02ad43af9f2a229e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/actions.js\":\"4936cba0be8f6737\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/addComment.js\":\"33b3e7df874b9470\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/anchor.js\":\"773a33eb1b171e0e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/anchorState.js\":\"f1826319ff142ccd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/commentLinks.js\":\"c7d25f55f22e46e0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/confirmThreadDeletion.js\":\"70b099fb04f1ba1c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/container.js\":\"a05fcf8e0b1bca8f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/dataExtension.js\":\"2f4a111bcd99ffd2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/deleteComment.js\":\"6c3811572a50e9d1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/highlights.js\":\"b2122e0d11d7158c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/index.js\":\"81c299b83e6770ff\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/linkedCommentsPill.js\":\"4cdf364a23320d11\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/margin.js\":\"7ff89e197dac3a48\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/marginAnchorLinks.js\":\"63ef9d7035478bb8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/marginSchema.js\":\"7f912204ad586a5e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/newComment.js\":\"58db2f1b2f046fef\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/ownThreadPicker.js\":\"77d6e5fc8ce29520\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/placement.js\":\"4fe768f1bf6574e5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/queries.js\":\"9660f99c776f6a0a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/quotePosition.js\":\"da84270c3488a331\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/quotedIn.js\":\"d72acd0a96c6f208\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/quotedRange.js\":\"661f11d69ac87257\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/rangeRefs.js\":\"aee2ecc44639ee5c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/readHighlights.js\":\"b72db57ee1556bb4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/readSelection.js\":\"f5b831dfdf36c55f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/readSelectionUi.js\":\"ac83a46ed52cd0cf\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/reanchor.js\":\"4b4da8257b22cbe1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/schema.js\":\"6fd73761f204298d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/scope.js\":\"d161b0ef7aba1d5e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/scopeThreads.js\":\"b0d8b08f9e44e203\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/splitRetarget.js\":\"0fd1febaf830f88a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/suggestionCard.js\":\"9d84933fc31b3cff\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/suggestions.js\":\"9dde6e2a4940e46f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/summaries.js\":\"fdd9181c2d73ad30\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/summaryBatch.js\":\"3934ff9e2affb433\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/surface.js\":\"df0afc89ce02dbea\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/threadNavigation.js\":\"e4b261a27457416d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/threads.js\":\"52fa0e2d39eace66\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/ui.js\":\"2f721ed3adb1ec3a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/annotations/uiStore.js\":\"0c8aea793aec5231\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/app-intents/appIntents.js\":\"424c793e1fad6901\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/app-intents/index.js\":\"a3326cfc04d52a45\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/app-update-prompt/index.js\":\"9d61cef38b1b84c4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/app-update-prompt/status.js\":\"f9d6859a9f5cc885\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"f078e7b8c81c6432\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/MediaBlockRenderer.js\":\"a5e1f6d45f777229\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/MediaDownLaneReplicator.js\":\"82e2bd6367324c3e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/MediaUploadReconciler.js\":\"030b0fc4c7309314\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/assetDownLane.js\":\"f8182a098b9c499c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/assetResolver.js\":\"6c74280d2dc46a30\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/assetUpload.js\":\"b56b9dcc1eda8cdc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/attachmentCleanerIO.js\":\"388c4ac83bfde8aa\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/audit/supabaseAuditIO.js\":\"8dd27af8a5f09331\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/blobStore.js\":\"06bff240ae853951\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/browserMedia.js\":\"eb88c009205aa31b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/byteStore.js\":\"a4bee45b3f5b0d6f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/cleanerIO.js\":\"80745f2b63a83b95\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/cleanupAttachments.js\":\"78f4dff02fb89909\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/dataExtension.js\":\"137c0485f042d683\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/downLane.js\":\"d5caf3f29f9c2df9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/index.js\":\"e43d0b9d18c2bc07\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/insertImageContribution.js\":\"f13b7383bbea6e2f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/laneArming.js\":\"55460b109d0d52df\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/laneLock.js\":\"9a92c72f70fa688c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/mediaBlock.js\":\"f75f01f6db324a02\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/mediaCapture.js\":\"83b6ca9ded75ea39\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/mediaLanes.js\":\"27b7b34970ee2c20\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/mediaViewers.js\":\"85e69e0b4acdc787\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/mediaViewersFacet.js\":\"1af913fe72b3fd8c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/pasteCapture.js\":\"7e32244ed85f3d94\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/resolver.js\":\"a9263a3c6882e85c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/retryUploadsAction.js\":\"a261db3df91fff68\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/storagePaths.js\":\"d36eef69d4a8dc22\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/uploadDrain.js\":\"afae51887f9fef48\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/uploadLaneStatus.js\":\"d50d4236eb790950\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/uploadReconcile.js\":\"9e86189bda7722b2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/uploadRecovery.js\":\"b2d4585ffdb1c9b0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/uploadStore.js\":\"cb95c99f5b91afb9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/attachments/useAssetObjectUrl.js\":\"d4f536c2a1e8549a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"8a9c499f9a94514f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks-view/BacklinksViewSection.js\":\"cf1bb66e37154ed1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks-view/facet.js\":\"5f629d7f1eca4ac8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks-view/index.js\":\"a2f8d2b4ae696138\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks-view/prop.js\":\"b7bba5b63d6ebbae\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/BacklinkFilters.js\":\"fd4e8300557b0221\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"9929f0a9f07cee10\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/BlockEntry.js\":\"59d99042dad488a5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/LinkedReferences.js\":\"36e34beb4e854bd7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"97c1a5dc369b14b0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/dailyNoteDefaults.js\":\"da82c7181245607e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/dataExtension.js\":\"99271e8699348be3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/edgeExclusions.js\":\"339fe89c6d7194eb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/filterProperty.js\":\"4bfc3ad3a480357a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/index.js\":\"617171634ca9e231\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"e195ca6d264ba082\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/inline-counts/applies.js\":\"c4faddc901e85972\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/inline-counts/countQuery.js\":\"995b460019faa023\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/inline-counts/expansionStore.js\":\"5f1f0303a358dc7f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/inline-counts/index.js\":\"843e9289b5007f1f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"6c8516420f57663e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/presentationInvalidation.js\":\"cb00900fcd7fb29c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/propertyEditorOverride.js\":\"379bec34b32edfda\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/propertyFilter.js\":\"18f2c8a9b00e0fcc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/query.js\":\"a19f9730f3ae808d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/resolveFilter.js\":\"2d1c78ac86fcaac2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/sourceBatch.js\":\"cadece8b2e6a81de\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/sources.js\":\"470713aa617b06c3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/useBacklinks.js\":\"9ec2829b70b2c771\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"fc0371b01f87a4ab\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/birthday/BirthdayCelebration.js\":\"5b775fdd8d6ce946\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/birthday/BirthdayOverlay.js\":\"209f2b09bcbafa5b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/birthday/gate.js\":\"7c2370976295c4e1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/birthday/index.js\":\"e0fc9cc87c1dcc00\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/birthday/wolfTheme.js\":\"7a9db8706666d563\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-drag/BlockDragLayer.js\":\"f4396a475f031327\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-drag/dragController.js\":\"95201ece5fa37d7d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-drag/dropTarget.js\":\"cc220dbda450be27\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-drag/index.js\":\"566de87d6f71ea21\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-drag/projection.js\":\"339f35e3b224f668\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-info/BlockMetaCard.js\":\"ba2d4703e7b25072\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-info/index.js\":\"266b625fe3d8ee8b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/AddTagDialog.js\":\"a4f8c277881ad49a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"d5ee3d081beef5ff\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/TagNameIssueHint.js\":\"d806c0d07fdf3b3d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/addTagAction.js\":\"87313834a30cb387\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/appendTag.js\":\"80629f94d76f491a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/config.js\":\"e87c41b1da24efb9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/dataExtension.js\":\"9b19d9f6870ba266\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/index.js\":\"93430db249ff3f2a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/block-tagging/propertyEditorOverride.js\":\"cbe2ba243b548932\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/breadcrumbs/BreadcrumbList.js\":\"b95228952b61e8d4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"3b568bc095e6de41\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/breadcrumbs/Breadcrumbs.js\":\"6a6bb2b07c610dd3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"eeb1b5c59ca298a7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"56e70a16b9b72274\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/breadcrumbs/index.js\":\"b72e3fb331b3722c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"a7e96178d61090ae\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/CharacterCountItem.js\":\"ab0b3208419817fa\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/ProfilePropertyEditor.js\":\"d1dfe5fb2b3065f9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/actions.js\":\"885dbf3586e2380f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/blockType.js\":\"ef9360aec934b759\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/charCount.js\":\"931252aa40c8c5a3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/dataExtension.js\":\"7c792ad367fc3a0a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/index.js\":\"75613f11332cc0d2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/profiles.js\":\"79e655a369c8e197\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/properties.js\":\"baea14c80cad9906\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/subtree.js\":\"845babd1474cdccd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/character-counter/textCounts.js\":\"ee06c1e0f2c6c313\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/colemak-keybindings/index.js\":\"1cc07fd870ff73fa\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/command-palette/CommandPalette.js\":\"6df49a78a01a477d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/command-palette/HeaderItem.js\":\"56132b453f9ecbd4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/command-palette/context.js\":\"d18ebf2f279a4769\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/command-palette/index.js\":\"04e5b43f91df680b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/command-palette/selection.js\":\"90868a06c6b96572\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/command-palette/toggleStore.js\":\"9b8caa23375e9152\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/command-palette/useCommandPaletteActions.js\":\"d01a6c3b0eaaa8df\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/ContributorBadges.js\":\"12cacc5083bc1bd4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/ProfilePicture.js\":\"042d24bd4017d983\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/author.js\":\"90a83cc434bf9fd0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/codeMirrorExtensions.js\":\"c7871f4e1e96d2f5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/dataExtension.js\":\"9e62a2f63f8ed68c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/index.js\":\"a00c546ffdb869d3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/mentionAutocomplete.js\":\"03d96ac29ee44ae7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/processor.js\":\"c16fbf6eb250ca35\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/profiles.js\":\"d7c0a1ee021f925d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/queries.js\":\"7c258a6a1f1d8ddc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/schema.js\":\"b0d6e80a58330d22\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/contributors/useCommentAuthor.js\":\"abdc79127ac9eeb6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"adfc05586794b5fc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/cursor-follows-scroll/followOrigin.js\":\"98303d8ecd96dab9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/cursor-follows-scroll/index.js\":\"1cd8fcb5f1a1e46f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"36e4dc3b66fa50cb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"23671221b5343b51\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/CalendarGrid.js\":\"ca6a6998db8cfd2d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/DailyNotePicker.js\":\"ef0e8351b99df4c5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"31dee1e9bbe65ec3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/DateNavDecorator.js\":\"8903aa721c89b007\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/DateScrubOverlay.js\":\"803d2bbaf735ea07\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/DayPropertyControl.js\":\"17c906435a3f1fb6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/DayValueReferenceControl.js\":\"4efa1770a2d71ab6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/HeaderItem.js\":\"835cf465f1026e48\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/ReschedulePicker.js\":\"c1c3c81a33ad1726\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/SpreadDatesDialog.js\":\"a99a2bfce4452657\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/actions.js\":\"b8a8ba77dbd7b13a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/blockDateAdapter.js\":\"e141a36c9bdaee21\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/calendar.js\":\"4efc8494d88bc3d8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dailyNotes.js\":\"32e3f430c4855868\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dataExtension.js\":\"dde206a44929207f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dateScrubActions.js\":\"3b7c21ab982ace0b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dateScrubGesture.js\":\"df593115592199e4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dateScrubGestureActions.js\":\"86b535a45f2c865a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dateScrubRecognizer.js\":\"646984ffc520697d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dayProperty.js\":\"96daee2d3ce1288c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"76547cb3b351d1a6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/deletionGuard.js\":\"c04ca693ef567fd4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/dueQuery.js\":\"ec70b646568265cf\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/index.js\":\"8099747a9b579864\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/landing.js\":\"25de54e776b4ff5a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/localSchema.js\":\"eddfd03c48ccc4f6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/referenceDateAdapter.js\":\"d0d15fc690a876f6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/rescheduleAction.js\":\"145024e376b20223\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/schema.js\":\"85ed194d4dc06bed\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/spreadBlockDates.js\":\"ec98f1c3e3dc75cc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/spreadDatesAction.js\":\"90236517705f1897\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/today.js\":\"32928710400ef893\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"d594d804d1432069\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"9c94b6a037a062b8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/audit.js\":\"ae4e44bba8b64def\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/auditAction.js\":\"0b2b5730c08c239d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/auditRanges.js\":\"4be404d26c8f6e51\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/diagnosticsSource.js\":\"3989ba03c49b4e33\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/divergenceScan.js\":\"4b80fa0488e5e1eb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/index.js\":\"c0301aeb21f45c23\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/propertyChildrenChecks.js\":\"250f76d69deaad5f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/referencesMirror.js\":\"932603386b75745a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/rowJson.js\":\"775050db9773201f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/schedule.js\":\"b7706b4693e0f196\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/data-integrity/store.js\":\"d34f3e50650dbae1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-maintenance/action.js\":\"0bfe8171e33747fd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-maintenance/index.js\":\"3ec32f7908e7f188\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-maintenance/plugin.js\":\"6cdb3bc2b654c6cc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"fd77ed62fd08cb22\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/actions.js\":\"43b599f35ba3360f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/changeMarker.js\":\"8dc1502c15ac4945\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/diagnostics.js\":\"f7e5651106772949\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/fileSystemAccess.js\":\"f604ea53882ee458\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/filenames.js\":\"0ecb4ba38b39915b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/index.js\":\"e5afef6443fb98d2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/mirror.js\":\"d1b7666a049dd2a7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/runLock.js\":\"4b2e02c7fbdfc502\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/runtimeHealth.js\":\"7c91ef39d2f0fb6d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/schedule.js\":\"2368c810ad0a9001\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/db-mirror/store.js\":\"787dae3dff592a63\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/default-themes/index.js\":\"13a871d74f1c0910\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/default-themes/themes.js\":\"84c5ff830a82f101\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/diagnostics/facet.js\":\"be63ab7155e54253\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/diagnostics/useDiagnostics.js\":\"a9bad5a3823a8ec9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extension-prompts/dismissals.js\":\"62167f98ec20dffd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extension-prompts/index.js\":\"b2ca9e1a1fa6c915\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extension-prompts/status.js\":\"7f5f15ab1980cb5c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extension-prompts/store.js\":\"58dbc0cd94608822\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"ecb6efbe3a0fe5b9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/ExtensionsSettings.js\":\"614c8faefdd5d556\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/actions.js\":\"2be3a49d9d84d617\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/config.js\":\"c399684d43d11b9a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/dataExtension.js\":\"0dfd137177efce88\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/effect.js\":\"c69dc697770219b4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/index.js\":\"064719016f1d044c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/propertyEditorOverride.js\":\"3c3ee398ff42a87a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extensions-settings/useToggleTree.js\":\"fe70e189f8b83c5c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extract-type/ExtractTypeDialog.js\":\"7a82b601d290e8d6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"b20751f72f0381c1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extract-type/PropertyShapePicker.js\":\"adff460df24bbd87\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extract-type/action.js\":\"6e5b1980bcd79b27\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/extract-type/index.js\":\"37cfceb2f0892063\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/find-replace/FindReplaceDialog.js\":\"331200bdaa226d1c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/find-replace/HeaderItem.js\":\"4dec5225b03c81dd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/find-replace/dataExtension.js\":\"bdbe4d7d961f6ddf\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/find-replace/index.js\":\"0cbfe5ceccb9ee60\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/find-replace/search.js\":\"3c9eccf99dab9f80\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/find-replace/toggleStore.js\":\"867a41b459788d3f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/LocationPropertyEditor.js\":\"39120f85dc940b36\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/MapView.js\":\"23bbf093c4b32b3c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/blockTypes.js\":\"9afdade94db4548b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/codeMirrorExtensions.js\":\"92a33b54497c9fe9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/createOrFindPlace.js\":\"a549ced6cc739452\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/currentLocation.js\":\"aaf9dfdd3c95496f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/dataExtension.js\":\"c0a159589c6d362a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/geoContentDecorator.js\":\"a97a90b0140f96d3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/googlePlacesClient.js\":\"1c54b95f90b4fd9b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/index.js\":\"89cea98ecde89d3f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/locationsPage.js\":\"6055102c15ddeb97\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/mapViewport.js\":\"657e9d52cf4301c0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/pickCurrentLocation.js\":\"9d1461aa89485759\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/placeAutocomplete.js\":\"1e67f41e18c5b0d3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/placeNameCollision.js\":\"bc061b53926f8ece\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/properties.js\":\"8e97c9fe1dd50dc4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/propertyEditorOverrides.js\":\"ed1fd1da33665976\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/query.js\":\"7381ca404a213672\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/geo/usePlaceSearch.js\":\"33b10eb55d85a1d5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"21c6bd5a2509e2c2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"fee75d661771d1dd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"d15ae9d08707b810\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/config.js\":\"871e11bfdb00b257\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/dataExtension.js\":\"1497e87232f9f5fd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/facet.js\":\"56e502ac055402c4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/grouping.js\":\"0a9d4179b71dc452\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/index.js\":\"5642e3a1a23f528f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"d07bce774b22247b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/query.js\":\"05401d1d378b9ec9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/resolveConfig.js\":\"e9b1f6612250fb6f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"864509e184154729\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"8e4671ece3a0c378\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/HtmlDocumentContent.js\":\"c3dea7c7ab5abcdd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/HtmlFrame.js\":\"0fe511ea119a4bc9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/actions.js\":\"e6497fe3217131b9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/blockType.js\":\"4654a53cfb5082f4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/confirmRunScripts.js\":\"0bb2423c0cf39a45\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/dataExtension.js\":\"619103ab84d38fa7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/frameAnnotations.js\":\"439b8cbabb2583a8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/frameDocument.js\":\"996bf479c59b1291\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/frameTheme.js\":\"4ddc21e25de0845d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/index.js\":\"f99e214fc4aaeb18\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/scriptConsent.js\":\"683647b3e6997fcc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/sourceMap.js\":\"fed6cfc9714c5610\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/html-document/useDocumentScripts.js\":\"5eca1d228940aad8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/interaction-metrics/index.js\":\"0f3180e19eeb1735\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/interaction-metrics/record.js\":\"8830efed2ea69c39\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/interaction-metrics/recordStore.js\":\"078cc1c56f7f3bc0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/interaction-metrics/responsiveness.js\":\"0e571761483ec9ef\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/interaction-metrics/schedule.js\":\"f51c3fab9a57e774\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/interaction-metrics/sessionContext.js\":\"f0c6d0f4303299c2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"6e93f44c97619dd4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"642915f019cafc9d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/actions.js\":\"d3cef9397f83bdc6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/config.js\":\"18c149296425ca14\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/dataExtension.js\":\"9268457c1a1980b4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/effect.js\":\"53d61910907eac84\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/index.js\":\"48edef75da0c2243\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/keyCapture.js\":\"6b26e5d00b346ec2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/overrideStore.js\":\"20b761783e490bea\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"b7c96ce361cf82c9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/left-sidebar/HeaderItem.js\":\"0d20f3050aa49bfa\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/left-sidebar/LeftSidebar.js\":\"3b3b6feb4f2c84d6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/left-sidebar/actions.js\":\"a2477bbe5ad460ec\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/left-sidebar/facet.js\":\"4421a379b7dc02c7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/left-sidebar/index.js\":\"a1fcda31ed89b31c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/left-sidebar/shortcuts.js\":\"1abc283a607ff98c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/left-sidebar/toggleStore.js\":\"f96c76bca244f237\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/merge-blocks/MergePicker.js\":\"5f14fa88462b5a49\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/merge-blocks/index.js\":\"e484caf8c99ef221\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/merge-blocks/mergeAction.js\":\"280d82706f491865\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/merge-blocks/strategy.js\":\"f38d5aeb9b05bbac\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-bottom-nav/Button.js\":\"0a8b8738257919c0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"db5caab79b7013a6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-bottom-nav/defaultItems.js\":\"26876fa094c5f759\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-bottom-nav/facet.js\":\"4cec020bb1548eb1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-bottom-nav/index.js\":\"69381fca5be86d13\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"f2b25e5c34e80af0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-keyboard-toolbar/actions.js\":\"70e2a15b69755448\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"51101ff8ef9de454\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-keyboard-toolbar/facet.js\":\"e98e41300b69522d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/mobile-keyboard-toolbar/index.js\":\"3370a0a6c43e19ff\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/move-blocks/MoveDestinationPicker.js\":\"9f523d0e012e30ce\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/move-blocks/blockSubtreeMembership.js\":\"1d75f01978266c6a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/move-blocks/contextMenuItem.js\":\"dc3297ac0910dcb1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/move-blocks/index.js\":\"7b739b711d28372c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/move-blocks/moveAction.js\":\"207c9af45c59dc71\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/move-blocks/moveBlocks.js\":\"85411e2515cec01f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/move-blocks/selectionAfterMove.js\":\"5e0efc48cae1aa69\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/TutorialBanner.js\":\"36b67ff1e0e6315d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/action.js\":\"3b66710d4c87bd81\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/bannerDismissal.js\":\"f552775281e00e7e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/documents/cheatSheet.js\":\"7411b88fa0a21b86\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/index.js\":\"eb2417fd1a540539\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/keys.js\":\"caa581d9ad16188f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/landing.js\":\"7f868bf01c5ac5bb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/outline.js\":\"c132cbdcd39b2f71\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/onboarding/seed.js\":\"c68f32e0a009ba5d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/PerfTrendDialog.js\":\"80ab04a40f163363\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/analyze.js\":\"1b0164b7b97f8a33\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/diagnosticsSource.js\":\"61951b2f1b431d25\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/index.js\":\"83b40477485d453c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/load.js\":\"3e3dd5f89a0aec3e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/monitorRun.js\":\"e7cde5e14a5dcc67\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/schedule.js\":\"fad8333176c443a1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/series.js\":\"e68dfcef41325e25\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/store.js\":\"a85a149eade6e2a4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/trendAction.js\":\"03d4a501b438f02a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/perf-monitor/verdict.js\":\"452696237d547751\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/plain-outliner/clickToEditAction.js\":\"0d3a7dd6dc81b27c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/plain-outliner/index.js\":\"614f4eccfd7979d3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/plain-outliner/interactions.js\":\"e9038c40fafccff3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"98d80826b3d6eb63\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/MigrationGate.js\":\"19a9c7ae0ae0007b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/MigrationGateDialog.js\":\"2c0e43ac2910672a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/action.js\":\"3660ce3facdad809\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/index.js\":\"40db5f46651f2c21\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/localRunMessage.js\":\"5a2f146e7867fcbf\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/plugin.js\":\"6e9b9e28d99b7b17\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/progressReport.js\":\"ddcadfeec7e4003d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/properties-migration/sweepProgress.js\":\"4740f4d5f4974af1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/FieldRowRenderer.js\":\"1f8a778da59e915a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/ValueRowRenderer.js\":\"ea7683566c07d58e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/actions.js\":\"7deb613e64765085\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/autocomplete.js\":\"36bca244b86e5fe4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/fieldRow.js\":\"4dfb9593cbb10b5c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/index.js\":\"1a0695f98e078a9d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/referenceWarning.js\":\"08fcce70e5239333\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/valueAutocomplete.js\":\"5961127327787587\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/property-rows/valueSchema.js\":\"ff82d0a70e337d3e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/quick-find/HeaderItem.js\":\"25117ee96a02b431\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/quick-find/QuickFind.js\":\"abff97214067f10d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/quick-find/index.js\":\"0ecc90fd1ab96ee7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/quick-find/recents.js\":\"0b6935942a0991f0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/quick-find/resultItems.js\":\"19ba820de0735538\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/quick-find/selection.js\":\"c4df8519d75119aa\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/quick-find/toggleStore.js\":\"9eb393a00d4c6264\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/recents/HeaderItem.js\":\"f84389d472ff5c26\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/recents/RecentsPageBlockRenderer.js\":\"ad55ed97d53bacc2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/recents/grouping.js\":\"36986af398dd74a7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/recents/index.js\":\"0981d10adc2933bf\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/recents/target.js\":\"156b31d617596b9e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/codeMirrorExtensions.js\":\"86e7222bad9133aa\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/contentPrefill.js\":\"9e280abeb783e0a9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/dataExtension.js\":\"89e95b33f0c9d3b1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/index.js\":\"a07e2635b7f2fe73\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"f8c5eb7c52163167\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/invalidation.js\":\"7eb24f1d5237eac8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/localSchema.js\":\"9c1a49cb106624ad\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/blockrefs/index.js\":\"ad7c7ed0947625b6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"c86a09baf93bff86\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/index.js\":\"ff4be403f4e065d1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/referenceNode.js\":\"cb3cc7282d730342\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/remark-reference-occurrences.js\":\"dbd85489768aec1d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"d11e3a26c3885694\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/wikilinks/index.js\":\"b7aac3e37878fe0f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"ccdbfc86f4c55872\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"a05a891d3f082584\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/mergeRetargetProcessor.js\":\"bb3698e5b87f5deb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/parseFence.js\":\"a0839d4c6589fcd6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/referenceParser.js\":\"d1e9bec2190be820\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/referenceProjection.js\":\"3cac28eec995de87\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/referencesProcessor.js\":\"09cb2ee1f4a4c77d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/renameProcessor.js\":\"f65798efca9348d9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/references/spanReplacement.js\":\"5bf17fded73b7b3b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/rich-paste/htmlToOutline.js\":\"54aabb2279aa55f2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/rich-paste/index.js\":\"59ada79ecd6a849e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/rich-paste/normalizeClipboardDom.js\":\"cfa0615c08022c8c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/rich-paste/pasteDecision.js\":\"28cf54125531b757\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/action.js\":\"ec00ac94c2cd710f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/blockIds.js\":\"95c273714287d0fc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/content.js\":\"72a397ba49da76a6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/effect.js\":\"8623cf086dabce67\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/ids.js\":\"cdf1b96c450f1981\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/import.js\":\"8e15d8150df16424\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/index.js\":\"5f243a1ba2fc533d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/plan.js\":\"b9d10e6da9221e3c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/plugin.js\":\"7aef59fee525a0e6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/promotion.js\":\"f7fbe0e93b297943\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/properties.js\":\"2db3e7134e97a15d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/references.js\":\"fad59f1c17ce713c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/report.js\":\"bda88d71ac895b39\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/roamMemo.js\":\"393aade95a43c84d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/runtime.js\":\"8c9bb836a84d7993\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/schemaReconciliation.js\":\"351b0ef81586cff1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/srsMarkers.js\":\"73f82e4f85bfbf7f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/todo.js\":\"0322e4cd1c11abc4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/typeCandidates.js\":\"c458b9e79d7c923d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/roam-import/types.js\":\"8eeab6d40b05f156\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/search-health/index.js\":\"4fb1c6a450b5dc9f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/search-health/store.js\":\"8f914ccb5171e40d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/shortcut-help/HeaderItem.js\":\"465e1cf874f96540\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"39a4f3ed81b88fbd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/shortcut-help/index.js\":\"5eab66a18ade331e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/shortcut-help/model.js\":\"6996b3d7da9dd766\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/shortcut-help/toggleStore.js\":\"108cb230fbdb953d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/shortcut-help/useKeyInspector.js\":\"f44a28cb2f933017\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"160710c6eb29237b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/spatial-navigation/ShellDecorator.js\":\"b34f5895809dd6f0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/spatial-navigation/actions.js\":\"483c83a3b57aea30\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/spatial-navigation/exclusionsFacet.js\":\"a9821d80d148da79\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/spatial-navigation/index.js\":\"8fec2ace6ef7e858\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/spatial-navigation/shell.js\":\"69b30ae379243543\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/spatial-navigation/surface.js\":\"6735c72ef137ba19\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/spatial-navigation/walker.js\":\"96ae30450a460f29\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/RescheduleToast.js\":\"5fe76a1b45e6f932\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/dataExtension.js\":\"c5ec53f4d57524ee\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/index.js\":\"66e0bd2894eca50c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/indicator.js\":\"96ec4c3d214ac1ac\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/moveSrsState.js\":\"6b29b2b0ec74aa08\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"3704dff52b4158c7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/scheduler.js\":\"23f116d31cafa6ef\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/schema.js\":\"47cda90143fb407a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"d5ec1f3c41a438f2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/srsClipboard.js\":\"05b28c872d079970\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"bf9f4c3e6542312c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/DailyNoteReviewHint.js\":\"7fab79dfa65bbcb9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/DeckPicker.js\":\"39822591f5230af4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/ReviewControls.js\":\"fdcf085533bb1f21\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/ReviewDeckRenderer.js\":\"de0698be42b5c26a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/ReviewSession.js\":\"12f07b3797640adf\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/actions.js\":\"bf13b4da662028f4\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/archive.js\":\"a2ac8d846c88b30e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/dataExtension.js\":\"db0de19afeddb2eb\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/deck.js\":\"5304d8dd5106cfd1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/dueQuery.js\":\"99aaa18ffb6a8a92\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/gradeDecision.js\":\"62f5631bc6dc5f9e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/index.js\":\"368ffc2e0c1e41da\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/keyHints.js\":\"0d56c9071ab9b77b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/reviewCardLayout.js\":\"38588ebbf5db6a75\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/reviewProgress.js\":\"31a164f130e63252\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/schema.js\":\"5978ab08bac36d31\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/srs-review/useDueCards.js\":\"a2be2811bf3ac57f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/startup-metrics/index.js\":\"e7dc93fbec492f74\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/startup-metrics/record.js\":\"ea0465b1ea73870a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/storage-persistence/index.js\":\"30a73a57a88f31ab\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/storage-persistence/persistenceStatus.js\":\"a9c0126e8f57d128\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/storage-persistence/requestAction.js\":\"79657769b6239832\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/supertags/TypeChipsDecorator.js\":\"3b459332f8b3cdcd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/supertags/codeMirrorExtensions.js\":\"917b96b439b0cf3d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/supertags/index.js\":\"564091af225ad7ea\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/supertags/typeAutocomplete.js\":\"0b5653b73c6f596d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"cf0e4cf50a8792c7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/swipe-quick-actions/actions.js\":\"5c01d4f6b408e696\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/swipe-quick-actions/anchor.js\":\"6fc1f1c98085c347\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/swipe-quick-actions/events.js\":\"74bf69d5144a4609\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/swipe-quick-actions/gestureActions.js\":\"3c260b82e5d68d03\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/swipe-quick-actions/index.js\":\"b002726a8db7f77f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"1457e031c2eacdc8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/sync-metrics/collect.js\":\"1b155a91912cb6ad\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/sync-metrics/index.js\":\"d0f001e0364ea763\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/sync-metrics/record.js\":\"b6ac5a25b3bfba6a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/system-status/RejectionDialog.js\":\"fa3c7d84af7205d8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/system-status/SystemStatusHeaderItem.js\":\"d639fed65712b4f7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/system-status/index.js\":\"91b68ec88ac3d936\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/system-status/model.js\":\"52b31f81b39114f5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/system-status/queueCounts.js\":\"511337e2a569775d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/system-status/rejectedHelpers.js\":\"b806fd9b92c39a95\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/system-status/rematerializeAction.js\":\"141e97229f145c03\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/system-status/useHysteresis.js\":\"d59c95388f8eb311\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/ColumnHeaders.js\":\"1d38bfda28cc50e1\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/QueryUi.js\":\"45d981a64f28bff0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/TableLayout.js\":\"d260a11d7d978139\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/actions.js\":\"7e2f450319860d9e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/cellEdits.js\":\"f354b9ff9737acfa\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/childrenViews.js\":\"dce7ccc5b729179b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/columns.js\":\"84a828ccb8c7b301\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/controller.js\":\"47245abb5e226c53\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/convert.js\":\"f840cb08de1da886\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/dataExtension.js\":\"6e7d19e2d1987ec2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/index.js\":\"51d57a1fb4fcb140\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/keys.js\":\"e466133eafa12234\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/model.js\":\"fd9444024c461536\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/query/QueryText.js\":\"a371ec0e3dcf1ae7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/query/backfill.js\":\"e5e6abcb6969a30a\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/query/completion.js\":\"6a8627b852caaf8c\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/query/format.js\":\"320ec1cee1d34daf\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/query/parse.js\":\"dc01ad990ea29afc\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/query/queryValue.js\":\"7bf22d0e1f9b6c50\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/query/registrations.js\":\"47010c378cbf67dd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/query/source.js\":\"60ad3b8434bd5f46\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/registry.js\":\"f3e6046c8790de63\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/rowGutter.js\":\"2ca2d5275328286e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/rowVerbs.js\":\"840c9a5894baf6e2\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/schema.js\":\"2c5f58d9258e09e8\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/tables/sort.js\":\"51e61f1958511630\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/theme-toggle/effect.js\":\"549c980fdbeb3a56\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/theme-toggle/index.js\":\"fea4df31b4872b34\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/theme-toggle/theme.js\":\"5c54576df577d708\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/todo/actions.js\":\"a84f36d121530021\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/todo/dataExtension.js\":\"6285c554d8fcfbc6\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/todo/index.js\":\"57379311fd9e1da7\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/todo/schema.js\":\"fca7374469286ad5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/touch-selection/TouchSelectionLayer.js\":\"f5f6b466fe4da760\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/touch-selection/actions.js\":\"815b1f25ab1a869b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/touch-selection/defaultItems.js\":\"c35ce46cf7761031\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/touch-selection/facet.js\":\"7f9e9d2e35e3caf5\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/touch-selection/holdRecognizer.js\":\"97233b199fb55876\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/touch-selection/index.js\":\"2bf0fb454614d0fd\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/update-indicator/UpdateIndicator.js\":\"b7588da6834f026f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/update-indicator/index.js\":\"b291b8429d20444d\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/update-indicator/loadTimes.js\":\"a7e7f113eaa2979f\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/VideoNotesRenderer.js\":\"1f3a1a61a0eebb68\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/VideoPlayerRenderer.js\":\"8a230ab1427d9e39\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/VideoTimeStamp.js\":\"04e580d59367aee0\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/actions.js\":\"07ddc3a0be49297e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/index.js\":\"acfb598da9690fd3\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/markdown.js\":\"0758986a1d6672ed\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/notes.js\":\"a4d7890e388c0250\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/registry.js\":\"176487b6dfe96527\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/remark-timestamps.js\":\"537ba9c1793ed8ff\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/video-player/view.js\":\"cb598b74733e4499\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/vim-link-hints/LinkHints.js\":\"1f4d99603b3a6847\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/vim-link-hints/index.js\":\"16b12b08a1cd3c0e\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/vim-link-hints/model.js\":\"f5a33c84eef336e9\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/vim-link-hints/settings.js\":\"e1bf6747eb71ff37\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/vim-normal-mode/actions.js\":\"b1e1097824e0d78b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/vim-normal-mode/index.js\":\"72a30ebc3b1e0a96\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/vim-normal-mode/interactions.js\":\"da628bcf2f33c43b\",\"/knowledge-medium/pr-preview/pr-1925/src/plugins/workspace-header/index.js\":\"8e8053b21044aae2\",\"/knowledge-medium/pr-preview/pr-1925/src/registerServiceWorker.js\":\"1be5b5d8fa962170\",\"/knowledge-medium/pr-preview/pr-1925/src/requestPersistentStorage.js\":\"b1bd21e3d0a59051\",\"/knowledge-medium/pr-preview/pr-1925/src/services/authRequestDeadline.js\":\"7205debfa7200984\",\"/knowledge-medium/pr-preview/pr-1925/src/services/authStorage.js\":\"e91a65b15b628f57\",\"/knowledge-medium/pr-preview/pr-1925/src/services/powersync.js\":\"b04f22180e8e737e\",\"/knowledge-medium/pr-preview/pr-1925/src/services/supabase.js\":\"b04b2bd1b629a11a\",\"/knowledge-medium/pr-preview/pr-1925/src/services/uploadErrorClassifier.js\":\"6a6840f439a1d0de\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/ActiveContexts.js\":\"c6eda70902bd949a\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/HotkeyReconciler.js\":\"bbe12c5e1df8a2ac\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/WipeLocalDataDialog.js\":\"b0839a10b6f23c22\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/actionDispatch.js\":\"f23bb6a84ee2c75f\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/actionKeyHints.js\":\"131bc2bf76bf6e96\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/actionRefItems.js\":\"919ebd6390b79d33\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/applyKeybindingOverrides.js\":\"abfa6315a5e376f6\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/blockActions.js\":\"c08b02044dcbd3f4\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/blockMergeGesture.js\":\"464037b615455eed\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/canonicalizeChord.js\":\"968e5e0fe0d989cf\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/defaultContexts.js\":\"2d79bee1f5b6674a\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/defaultShortcuts.js\":\"972d94c90fc5a964\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/effectiveActions.js\":\"5666ea8309169fe8\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/formatChord.js\":\"de9edb7785838f70\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/gestureAction.js\":\"35f655bf0ed3d0a1\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/gestureBinding.js\":\"d0d7f1e438f966f6\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/holdRegistry.js\":\"33ff80d129b716fa\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/keybindingConflicts.js\":\"745fd34d1b016b16\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/keybindingOverrides.js\":\"42830c7398293d3e\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/pointerAction.js\":\"2aea490452307755\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/resolve.js\":\"fcc9c4c46bf7d24d\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/runAction.js\":\"30521fa019308a1f\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/sequenceMatcher.js\":\"3aee31516756a1c7\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/types.js\":\"fcfbb11e95c126df\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/useActionContext.js\":\"e6c065e73e9a8108\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/useActionDiscovery.js\":\"ceff7589a01ad89b\",\"/knowledge-medium/pr-preview/pr-1925/src/shortcuts/utils.js\":\"b0e2a59257f82ab8\",\"/knowledge-medium/pr-preview/pr-1925/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1925/src/sw/bootStore.js\":\"bc1cd7bc0c5fa7cb\",\"/knowledge-medium/pr-preview/pr-1925/src/sw/previewDatabases.js\":\"e0823090d936ae8c\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/byteTransform.js\":\"69c7f4730126ed18\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/attachmentCleaner.js\":\"da78df38c45c724a\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/bundle/attachmentParts.js\":\"9676a2b124f17fa6\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/bundle/bundleParts.js\":\"b08592548ff3ff06\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/bundle/bundleRecord.js\":\"570f2990e8cef8cd\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/bundle/manifest.js\":\"b15b40cf27b1353e\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/bundle/takeBundle.js\":\"a7c29693b2a5d4fc\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/bundle/verifyBundle.js\":\"050ce5b70e2c4b03\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/cleaningStage.js\":\"8240bfbe5fad18be\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/conversionKey.js\":\"c3df5f84bd0a33b2\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/conversionServer.js\":\"92741eb27db03417\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/flip.js\":\"2da2d2b21dc0b367\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/flipAttempts.js\":\"c4e11fa6a73b5c1a\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/pages.js\":\"cd628361840d2209\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/preflight.js\":\"153a8775c491b243\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/reseal.js\":\"638755f5c03952fc\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/runConversion.js\":\"7eb20858b4ed9f26\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/runLock.js\":\"20bdb161a1e2aca4\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/sealing.js\":\"8c496b192f91bf28\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/sealingStage.js\":\"5d8ca1f6e0c91e18\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/stage.js\":\"adf8d9e2c0b9da6e\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/conversion/verifyReseal.js\":\"f11580db7a2c9973\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/aad.js\":\"1b0f64025e1c1ddb\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/aead.js\":\"5284202b917d3844\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/base32.js\":\"1d4265bc7fae8b5f\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/base64url.js\":\"f94277c11ead8815\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/binaryEnvelope.js\":\"c3693c3af2c702ca\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/byteAead.js\":\"0705d6b57ca9bf49\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/canary.js\":\"8294df1ad8de0583\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/contentHash.js\":\"3e76f937a13d0b34\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/contentKey.js\":\"6761cd971f500ac3\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/derivedIdNamespace.js\":\"930fd5a90c733f34\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/envelope.js\":\"21730b237695c377\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/hex.js\":\"a4cfda06d2b25d73\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/sha256Hex.js\":\"b1ef16ae4a570546\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/crypto/workspaceKey.js\":\"d1f3fbffca71e683\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/conversionState.js\":\"aa17da9df393e6af\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/flows/createEncryptedWorkspace.js\":\"ecef3fe90fa62442\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/flows/pastedKey.js\":\"978961df27d5e009\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"33806024fdae4c69\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/flows/upgradeWorkspacePin.js\":\"2d90ec814861fa10\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/keyStore.js\":\"9d3ac2c457aca752\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/mintWorkspaceKey.js\":\"05260849312f4fe0\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/modePin.js\":\"61369164d269a6e8\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/openWorkspaceKeys.js\":\"e23f89b6851f1993\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/resolveWorkspaceEntry.js\":\"3d8f06d642258b37\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/resolver.js\":\"12731f001a35b80c\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/keys/workspaceAccess.js\":\"76fb50d787c36429\",\"/knowledge-medium/pr-preview/pr-1925/src/sync/transform.js\":\"21c262267d820912\",\"/knowledge-medium/pr-preview/pr-1925/src/themeBootDefaults.js\":\"59a9a1f89b952d41\",\"/knowledge-medium/pr-preview/pr-1925/src/types.js\":\"9c13309a581a4cf4\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/ClientLocalSettings.js\":\"5f04a1e073e8a6d0\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/abortableSleep.js\":\"2047ec5791e6d4ab\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/array.js\":\"2ef2fd731a333911\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/backlinkAutocomplete.js\":\"9adc84d8cd1c6468\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/blockCrumbs.js\":\"4d6ff0d6fb433ac6\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/blockrefAutocomplete.js\":\"251f29608f60a118\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/cadencedIdleJob.js\":\"3afd2e8daa5d8ae9\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/callbackSet.js\":\"1371f135afc891ea\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/clientId.js\":\"ac3023b83cafee3d\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/codemirror.js\":\"84dcded821853da0\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/codemirrorCompletion.js\":\"2c323a8ff8f6095f\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/copy.js\":\"6dc133630f140e97\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/dailyPage.js\":\"e92ceb739f74b825\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/dbForensics.js\":\"4f1d1074347d3783\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/dbForensicsHooks.js\":\"6be70d3fb22b6ee1\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/deleteBlockThroughUi.js\":\"b214b7aadc3e3fd5\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/dialogs.js\":\"73ca7cb48b5bda44\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/dom.js\":\"1123ec6e7c154bb8\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/downloadBlob.js\":\"e4c54c3859709c86\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/drawnWalk.js\":\"3c0c1f847cb92f75\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/exportSqliteDb.js\":\"0a74e78d8761dc71\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/fileSystemAccess.js\":\"4858a03c790cd657\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/flipSlide.js\":\"39ab90f53471600b\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/fnv1a.js\":\"2b59ec9913b14929\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/formatBytes.js\":\"4e944178a385c6f0\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/fuzzyRank.js\":\"952d7ce9259cb812\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/idbKeyedStore.js\":\"0116d0b3460995af\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/idleCallbackPolyfill.js\":\"585c2c8811de40f7\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/keyboardAwareScroll.js\":\"17346f6cb08b9aa5\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/keyboardViewport.js\":\"ed23c2633d26de4e\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/lastWorkspace.js\":\"161972c57f0d2238\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/layoutColumns.js\":\"703fdf577fc85935\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/layoutSessionDom.js\":\"4312e2064c9d3971\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/layoutSessionId.js\":\"ae8db5120c7b6915\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/linkClickGestures.js\":\"f91252d7d7987b4c\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/linkTargetAutocomplete.js\":\"8398a6e819f8202e\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/localDbCorruption.js\":\"4d3436d80e901791\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/localDbRecovery.js\":\"4e6f80e3c44675f0\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/markdownParser.js\":\"ef6fea36773261bd\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/memoize.js\":\"a5d8d34335a6e0f2\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/nameFieldCommit.js\":\"2baff9d9fedd89c7\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/nameList.js\":\"4af7ef9b3cc6fe13\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/navigation.js\":\"f5ff0364d03cf50a\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/omnilinerNamespace.js\":\"9892d427a9b4a52a\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/opfsPageScan.js\":\"497f1cad8171a716\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/panelClearance.js\":\"9789c88cf17caaaf\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/panelHistory.js\":\"a1cc79f3d47f6f44\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/panelLanes.js\":\"0c65d9296c5fe33c\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/panelLayoutProjection.js\":\"ae848601d7d24fff\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/panelScrollAnchor.js\":\"571004f02a76b955\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/panelUrlFlags.js\":\"eb2650e951b1bc83\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/platform.js\":\"e44edacccac1bed7\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/pluralize.js\":\"d360e207b0d80be1\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/propertyCreation.js\":\"ec72e791c7b7ca8f\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/propertyNavigation.js\":\"5fc85b1a70d7a0e5\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/propertyValueContext.js\":\"f564c2c797597d2a\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/react.js\":\"5d46724fa43137bc\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/relativeDate.js\":\"c1304daee96aa9fd\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/relativeTime.js\":\"1d6ba5b7e3657e51\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/renderScope.js\":\"fa5679d1df10c4bf\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/resolvedThenable.js\":\"bdf82588dc53b946\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/routing.js\":\"777a5005fa453e24\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/safeMode.js\":\"3ce803dfd0a12a85\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/scheduleIdle.js\":\"62413f1d5e25f0b3\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/screenWakeLock.js\":\"10dd3f208bbe961e\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/selection.js\":\"45588adf11060c92\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/softKeyboardGrab.js\":\"7b828404d0b17322\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/startupTimeline.js\":\"27d42fdb1ce5e6fc\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/state.js\":\"0b05f6708b36298d\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/string.js\":\"b49a3cfe5b8585f5\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/surfaceZoom.js\":\"692916141e0ed6bc\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/time.js\":\"209a51f2a76a12ff\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/toast.js\":\"22cb6a8e1ae4000d\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/toggleStore.js\":\"172efa6c42ae20f5\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/untilStopped.js\":\"1cb9ad297349ae1f\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/userActivity.js\":\"c9946fb83cf1e1ba\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/viewTransition.js\":\"54482b83a86ff97e\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/viewport.js\":\"6d60578c710ce1d5\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/webLock.js\":\"708036de40c898c7\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/workspaceRecovery.js\":\"90a9148923a7dc38\",\"/knowledge-medium/pr-preview/pr-1925/src/utils/workspaceSnapshotStore.js\":\"e887b2a9e8d7ba86\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-compiler-runtime.js\":\"cc276b5d577a5111\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-dom-client.js\":\"6087c5884e65bca4\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-dom-server-edge.js\":\"76e25035b4f3ac8c\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-dom-server.js\":\"fab69311719b8829\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-dom-static-edge.js\":\"492a2e2d60594fdd\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-dom-static.js\":\"780034aa7c4d1ff1\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-dom-test-utils.js\":\"37e6b5919412cc72\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-dom.js\":\"cea848b776aa2070\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react-jsx-runtime.js\":\"6fa0e3efdda4396b\",\"/knowledge-medium/pr-preview/pr-1925/src/vendor/react.js\":\"bed476b914755e77\",\"/knowledge-medium/pr-preview/pr-1925/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1925/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1925/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
