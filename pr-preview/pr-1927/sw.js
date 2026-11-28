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
		buildId: "3bda0ae3ca49-06e0d0e6",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1927/\":\"6435e70925e6e2ef\",\"/knowledge-medium/pr-preview/pr-1927/index.html\":\"6435e70925e6e2ef\",\"/knowledge-medium/pr-preview/pr-1927/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1927/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1927/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1927/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1927/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1927/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1927/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1927/assets/FacadeVFS-D-xS29VW.js\":\"50c25588ea5a3fee\",\"/knowledge-medium/pr-preview/pr-1927/assets/OPFSCoopSyncVFS-BSbVWoRg.js\":\"6aa5e80c25935e55\",\"/knowledge-medium/pr-preview/pr-1927/assets/OPFSWriteAheadVFS-D0tqIQBw.js\":\"891cfc28eb006654\",\"/knowledge-medium/pr-preview/pr-1927/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1927/assets/wa-sqlite-TtSSQ2SN.js\":\"60f1a8908cba5807\",\"/knowledge-medium/pr-preview/pr-1927/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1927/assets/wa-sqlite-async-Dqimtu6B.js\":\"083c877357848d5d\",\"/knowledge-medium/pr-preview/pr-1927/assets/worker-DhE0lGx8.js\":\"a01c66f995358ec3\",\"/knowledge-medium/pr-preview/pr-1927/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1927/chunks/app-DnB6vLQt.js\":\"b04bfd2a0d67934b\",\"/knowledge-medium/pr-preview/pr-1927/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1927/index.js\":\"779dff54982e4828\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1927/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1927/assets/AccessHandlePoolVFS-DgeOmeif.js\":\"94138af2428caf38\",\"/knowledge-medium/pr-preview/pr-1927/assets/IDBBatchAtomicVFS-B7tZc2WS.js\":\"96ad7bd01f6f5987\",\"/knowledge-medium/pr-preview/pr-1927/assets/MemoryVFS-C8kRYWPx.js\":\"79e544fcbf13e348\",\"/knowledge-medium/pr-preview/pr-1927/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1927/assets/mc-wa-sqlite-DaWDR0XT.js\":\"49dda39c8a2ce7c9\",\"/knowledge-medium/pr-preview/pr-1927/assets/mc-wa-sqlite-async-D0ioipo5.js\":\"cceaea95d39735e4\",\"/knowledge-medium/pr-preview/pr-1927/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1927/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1927/chunks/AccessHandlePoolVFS-5sIeNkjc.js\":\"b7476e21394cc35c\",\"/knowledge-medium/pr-preview/pr-1927/chunks/FacadeVFS-CNoxPgk9.js\":\"2b213c20c1fbb2c1\",\"/knowledge-medium/pr-preview/pr-1927/chunks/IDBBatchAtomicVFS-B09Ho5g-.js\":\"24e62a28036d3212\",\"/knowledge-medium/pr-preview/pr-1927/chunks/MemoryVFS-Cq-whXGa.js\":\"c234784eb0bf3ce1\",\"/knowledge-medium/pr-preview/pr-1927/chunks/OPFSCoopSyncVFS-DnkkuKrD.js\":\"a9308fbd1afa8401\",\"/knowledge-medium/pr-preview/pr-1927/chunks/OPFSWriteAheadVFS-CTj_pZIS.js\":\"ca31e5dfc6246f92\",\"/knowledge-medium/pr-preview/pr-1927/chunks/Preview-BKFtFJV5.js\":\"e6c8925fa96b324a\",\"/knowledge-medium/pr-preview/pr-1927/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1927/chunks/card-Lcxec0Qh.js\":\"af071d9bab243125\",\"/knowledge-medium/pr-preview/pr-1927/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1927/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1927/chunks/dist-BUxTWSKI.js\":\"c1d463c5a484a951\",\"/knowledge-medium/pr-preview/pr-1927/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1927/chunks/freezeExtensionImports-CEe02f27.js\":\"54a1f34d1d51607d\",\"/knowledge-medium/pr-preview/pr-1927/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1927/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/pr-preview/pr-1927/chunks/mc-wa-sqlite-akOOlSJe.js\":\"f664ec0d3aa1a2fe\",\"/knowledge-medium/pr-preview/pr-1927/chunks/mc-wa-sqlite-async-DLjOU1cc.js\":\"d65e6ea5008590f4\",\"/knowledge-medium/pr-preview/pr-1927/chunks/react-2h4gI_gj.js\":\"00ea265703742f80\",\"/knowledge-medium/pr-preview/pr-1927/chunks/react-BIF5Gwq5.js\":\"cd867b43a12acc83\",\"/knowledge-medium/pr-preview/pr-1927/chunks/react-BsvcbDjY.js\":\"75be01cce3b100f9\",\"/knowledge-medium/pr-preview/pr-1927/chunks/react-CUO6dzw1.js\":\"38b5eb80ecdfb980\",\"/knowledge-medium/pr-preview/pr-1927/chunks/react-Dr1V98B_.js\":\"f756211553632f30\",\"/knowledge-medium/pr-preview/pr-1927/chunks/react-DwOSHF1W.js\":\"ae7c38d60bf097e3\",\"/knowledge-medium/pr-preview/pr-1927/chunks/react-dom-server-legacy.browser.production-C7CBU1f6.js\":\"f0ce9f9d4fcad686\",\"/knowledge-medium/pr-preview/pr-1927/chunks/react-dom-server.browser.production-CVbCdimi.js\":\"cdddaf321c26e2a3\",\"/knowledge-medium/pr-preview/pr-1927/chunks/react-dom-server.edge.production-CDEOz-mW.js\":\"047dbba7f65ac69b\",\"/knowledge-medium/pr-preview/pr-1927/chunks/react-jsVYrAvp.js\":\"3569d94497d4c1ee\",\"/knowledge-medium/pr-preview/pr-1927/chunks/react-oHkYXUB8.js\":\"0355c454205684ed\",\"/knowledge-medium/pr-preview/pr-1927/chunks/server.browser-CTkG-tEV.js\":\"e301ef9231e48309\",\"/knowledge-medium/pr-preview/pr-1927/chunks/textarea-5mOTEAen.js\":\"9a08d783969895a2\",\"/knowledge-medium/pr-preview/pr-1927/chunks/ui-eOCxHCcg.js\":\"502d7e2e1b14d447\",\"/knowledge-medium/pr-preview/pr-1927/chunks/wa-sqlite-DWWTzmmO.js\":\"9809b34159bfa4ef\",\"/knowledge-medium/pr-preview/pr-1927/chunks/wa-sqlite-async-BOSz8b2N.js\":\"7cf8ebcff3e4e0c9\",\"/knowledge-medium/pr-preview/pr-1927/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1927/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1927/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1927/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1927/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1927/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1927/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1927/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1927/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1927/src/App.js\":\"dc3ab49f8daef598\",\"/knowledge-medium/pr-preview/pr-1927/src/appUpdate.js\":\"a4402317207837ba\",\"/knowledge-medium/pr-preview/pr-1927/src/appVersion.js\":\"3dcf4115696690d1\",\"/knowledge-medium/pr-preview/pr-1927/src/bootstrap/initialLayout.js\":\"aa74a271615ffb56\",\"/knowledge-medium/pr-preview/pr-1927/src/bootstrap/openWorkspaceData.js\":\"6ab56626890196ac\",\"/knowledge-medium/pr-preview/pr-1927/src/bootstrap/resolveWorkspace.js\":\"9b1185947c708a91\",\"/knowledge-medium/pr-preview/pr-1927/src/bootstrap/workspaceBootstrap.js\":\"32217be9fd3730d3\",\"/knowledge-medium/pr-preview/pr-1927/src/components/BlockComponent.js\":\"55792961201781fb\",\"/knowledge-medium/pr-preview/pr-1927/src/components/BlockCrumbs.js\":\"d9ff8e6b2169b286\",\"/knowledge-medium/pr-preview/pr-1927/src/components/BlockEditor.js\":\"357051600bc2bd68\",\"/knowledge-medium/pr-preview/pr-1927/src/components/BlockLoadingPlaceholder.js\":\"006d7e4605764f0c\",\"/knowledge-medium/pr-preview/pr-1927/src/components/BlockProperties.js\":\"bc84bc54aa5de182\",\"/knowledge-medium/pr-preview/pr-1927/src/components/BlockSearchPicker.js\":\"a64bcd699586b281\",\"/knowledge-medium/pr-preview/pr-1927/src/components/ConfirmBulkDeleteDialog.js\":\"eb65d26ae34bcd48\",\"/knowledge-medium/pr-preview/pr-1927/src/components/DividerHandle.js\":\"c65aa383394d5066\",\"/knowledge-medium/pr-preview/pr-1927/src/components/DraftEditor.js\":\"c577244450016adb\",\"/knowledge-medium/pr-preview/pr-1927/src/components/GutterPill.js\":\"d9a21c95ffe036a5\",\"/knowledge-medium/pr-preview/pr-1927/src/components/Header.js\":\"dd02b2375bd0adff\",\"/knowledge-medium/pr-preview/pr-1927/src/components/LazyBlockComponent.js\":\"f2bd64e8332a627e\",\"/knowledge-medium/pr-preview/pr-1927/src/components/Login.js\":\"2c0dff722ce25c25\",\"/knowledge-medium/pr-preview/pr-1927/src/components/ZoomableSurface.js\":\"996f868b47807899\",\"/knowledge-medium/pr-preview/pr-1927/src/components/editModeKeepalive.js\":\"857aa258c3a54f2e\",\"/knowledge-medium/pr-preview/pr-1927/src/components/propertyDisplay/PropertyDisplayScope.js\":\"fc8d359794a8960c\",\"/knowledge-medium/pr-preview/pr-1927/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"5d0018ae50141b7a\",\"/knowledge-medium/pr-preview/pr-1927/src/components/propertyEditors/RefPropertyEditor.js\":\"1c7eb9c923b1fcc1\",\"/knowledge-medium/pr-preview/pr-1927/src/components/propertyEditors/RefTargetTypePicker.js\":\"057ddb3ac30d9a73\",\"/knowledge-medium/pr-preview/pr-1927/src/components/propertyEditors/SelectPropertyEditor.js\":\"3f59b437e42c69ad\",\"/knowledge-medium/pr-preview/pr-1927/src/components/propertyEditors/TypesPropertyEditor.js\":\"895401af1cfefd7a\",\"/knowledge-medium/pr-preview/pr-1927/src/components/propertyEditors/defaults.js\":\"664f1642cb3ddf31\",\"/knowledge-medium/pr-preview/pr-1927/src/components/propertyEditors/kernelValuePresets.js\":\"d0a8c671adf64bc5\",\"/knowledge-medium/pr-preview/pr-1927/src/components/propertyEditors/selectablePresets.js\":\"8c7adc6c4e02103f\",\"/knowledge-medium/pr-preview/pr-1927/src/components/propertyEditors/typesPropertyUi.js\":\"e8181ba4bd31b11b\",\"/knowledge-medium/pr-preview/pr-1927/src/components/propertyPanel/AddPropertyForm.js\":\"944cfa6cb61d4efd\",\"/knowledge-medium/pr-preview/pr-1927/src/components/propertyPanel/PropertyPicker.js\":\"76964dc8e43b0b88\",\"/knowledge-medium/pr-preview/pr-1927/src/components/propertyPanel/PropertyRow.js\":\"a3c5ec1d17f98bae\",\"/knowledge-medium/pr-preview/pr-1927/src/components/propertyPanel/Rows.js\":\"94a4cd8d976ad0b3\",\"/knowledge-medium/pr-preview/pr-1927/src/components/propertyPanel/actions.js\":\"03260da9eb6ede84\",\"/knowledge-medium/pr-preview/pr-1927/src/components/propertyPanel/declarationOnly.js\":\"73cb30514e7b64c4\",\"/knowledge-medium/pr-preview/pr-1927/src/components/propertyPanel/layout.js\":\"bc250803c845c40c\",\"/knowledge-medium/pr-preview/pr-1927/src/components/propertyPanel/model.js\":\"dd629d8836869a0a\",\"/knowledge-medium/pr-preview/pr-1927/src/components/propertyPanel/shapeUi.js\":\"59ccb4dfe7d3b39b\",\"/knowledge-medium/pr-preview/pr-1927/src/components/propertyPanel/shapes.js\":\"aeba74dfb6672281\",\"/knowledge-medium/pr-preview/pr-1927/src/components/propertyPanel/usePropertyEditingActivation.js\":\"487bbd7210a58b66\",\"/knowledge-medium/pr-preview/pr-1927/src/components/propertyPanel/visibility.js\":\"5d201d8b3258cb45\",\"/knowledge-medium/pr-preview/pr-1927/src/components/propertyPanelSections.js\":\"abfdaa8239c322a7\",\"/knowledge-medium/pr-preview/pr-1927/src/components/references/BlockEmbed.js\":\"59d98c269d5a67cb\",\"/knowledge-medium/pr-preview/pr-1927/src/components/references/BlockLink.js\":\"c08b0e6fed6e0467\",\"/knowledge-medium/pr-preview/pr-1927/src/components/references/BlockRef.js\":\"8f21cd6bf4d610a5\",\"/knowledge-medium/pr-preview/pr-1927/src/components/references/CompactReferenceLink.js\":\"11d489edb2051191\",\"/knowledge-medium/pr-preview/pr-1927/src/components/references/ReferenceLink.js\":\"84b73d1ae4ea36dd\",\"/knowledge-medium/pr-preview/pr-1927/src/components/references/cycleGuard.js\":\"43d41fed163153c0\",\"/knowledge-medium/pr-preview/pr-1927/src/components/references/cycleGuardContext.js\":\"1931eb935404942d\",\"/knowledge-medium/pr-preview/pr-1927/src/components/references/linkInteraction.js\":\"a9bf6ba7d97552c1\",\"/knowledge-medium/pr-preview/pr-1927/src/components/references/referenceLayout.js\":\"f661b5d8b388df4f\",\"/knowledge-medium/pr-preview/pr-1927/src/components/references/useBlockRefAncestors.js\":\"43ef92edc22532ff\",\"/knowledge-medium/pr-preview/pr-1927/src/components/renderer/BlockGutter.js\":\"4f2af33d8201107f\",\"/knowledge-medium/pr-preview/pr-1927/src/components/renderer/BlockInfoDialog.js\":\"ad3a2c1743d39ef6\",\"/knowledge-medium/pr-preview/pr-1927/src/components/renderer/BlockReadText.js\":\"bb91e19cf5744aff\",\"/knowledge-medium/pr-preview/pr-1927/src/components/renderer/BlockTypeBlockRenderer.js\":\"3aed7a4c373d9c9c\",\"/knowledge-medium/pr-preview/pr-1927/src/components/renderer/BulletHoverCard.js\":\"55516e64fea5abf9\",\"/knowledge-medium/pr-preview/pr-1927/src/components/renderer/CodeMirrorContentRenderer.js\":\"9007774ebc39a1b9\",\"/knowledge-medium/pr-preview/pr-1927/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"a1d542f923e0ad9a\",\"/knowledge-medium/pr-preview/pr-1927/src/components/renderer/ColumnResizeHandles.js\":\"d9a66d1be8d6203b\",\"/knowledge-medium/pr-preview/pr-1927/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"61ec5831d60e4bc4\",\"/knowledge-medium/pr-preview/pr-1927/src/components/renderer/DefaultBlockRenderer.js\":\"7c49e063470966bf\",\"/knowledge-medium/pr-preview/pr-1927/src/components/renderer/LayoutRenderer.js\":\"ac2603ca22d55c35\",\"/knowledge-medium/pr-preview/pr-1927/src/components/renderer/MarkdownContentRenderer.js\":\"e4513c32cfd21ee5\",\"/knowledge-medium/pr-preview/pr-1927/src/components/renderer/MissingDataRenderer.js\":\"d9d6e6e92dd80f4a\",\"/knowledge-medium/pr-preview/pr-1927/src/components/renderer/PanelRenderer.js\":\"2a3774d5c98ce3f8\",\"/knowledge-medium/pr-preview/pr-1927/src/components/renderer/PropertySchemaBlockRenderer.js\":\"01a51fbba07d85d9\",\"/knowledge-medium/pr-preview/pr-1927/src/components/renderer/TopLevelRenderer.js\":\"bb6e63d3a664745d\",\"/knowledge-medium/pr-preview/pr-1927/src/components/renderer/blockGutterMode.js\":\"87e25f025d148abb\",\"/knowledge-medium/pr-preview/pr-1927/src/components/renderer/blockTitleText.js\":\"a7bc2adefe234ee5\",\"/knowledge-medium/pr-preview/pr-1927/src/components/renderer/fieldCreationKeydown.js\":\"b1736c54264fcb60\",\"/knowledge-medium/pr-preview/pr-1927/src/components/renderer/layoutRootContext.js\":\"9f0195a66691e603\",\"/knowledge-medium/pr-preview/pr-1927/src/components/typeChip/TypeChip.js\":\"a6875c9c3cd02a55\",\"/knowledge-medium/pr-preview/pr-1927/src/components/typeChip/chipStyle.js\":\"47a7bffbfe71002f\",\"/knowledge-medium/pr-preview/pr-1927/src/components/ui/anchored-floating.js\":\"af4cf8fdea35dffc\",\"/knowledge-medium/pr-preview/pr-1927/src/components/ui/button.js\":\"5444445793719e93\",\"/knowledge-medium/pr-preview/pr-1927/src/components/ui/card.js\":\"ee17840001b89fd3\",\"/knowledge-medium/pr-preview/pr-1927/src/components/ui/checkbox.js\":\"47ece0a9ce628b31\",\"/knowledge-medium/pr-preview/pr-1927/src/components/ui/collapsible.js\":\"f50a22859e9e9c34\",\"/knowledge-medium/pr-preview/pr-1927/src/components/ui/command.js\":\"41f179c659963dd9\",\"/knowledge-medium/pr-preview/pr-1927/src/components/ui/context-menu.js\":\"7ef2ebaa11736bc3\",\"/knowledge-medium/pr-preview/pr-1927/src/components/ui/dialog.js\":\"106dc3e99f8fcc07\",\"/knowledge-medium/pr-preview/pr-1927/src/components/ui/dropdown-menu.js\":\"2be2cabb2da9f503\",\"/knowledge-medium/pr-preview/pr-1927/src/components/ui/floating-listbox.js\":\"bddf1647538fbddc\",\"/knowledge-medium/pr-preview/pr-1927/src/components/ui/index.js\":\"0e76d32b301c4f72\",\"/knowledge-medium/pr-preview/pr-1927/src/components/ui/input.js\":\"0eb0269e465ce4b5\",\"/knowledge-medium/pr-preview/pr-1927/src/components/ui/kbd.js\":\"cf4a6262cea874e5\",\"/knowledge-medium/pr-preview/pr-1927/src/components/ui/label.js\":\"e56f8b4440d61ff6\",\"/knowledge-medium/pr-preview/pr-1927/src/components/ui/textarea.js\":\"de9b4d5efd79523a\",\"/knowledge-medium/pr-preview/pr-1927/src/components/useEditModeYieldKeepalive.js\":\"f0a11c6163a06e4b\",\"/knowledge-medium/pr-preview/pr-1927/src/components/util/BootFallback.js\":\"d6f484fa32041afc\",\"/knowledge-medium/pr-preview/pr-1927/src/components/util/FocusedRowLazyMount.js\":\"c7d437715fc0ec23\",\"/knowledge-medium/pr-preview/pr-1927/src/components/util/LazyViewportMount.js\":\"68ae6b8dc22bb748\",\"/knowledge-medium/pr-preview/pr-1927/src/components/util/LocalDbCorruptionFallback.js\":\"7d8d5cfef89f54f1\",\"/knowledge-medium/pr-preview/pr-1927/src/components/util/error.js\":\"dd083ec6d6da5066\",\"/knowledge-medium/pr-preview/pr-1927/src/components/util/lazyMountRegistry.js\":\"430566bcfd00a6cf\",\"/knowledge-medium/pr-preview/pr-1927/src/components/util/suspense.js\":\"7445e87cd3be5a1f\",\"/knowledge-medium/pr-preview/pr-1927/src/components/workspace/CreateWorkspaceDialog.js\":\"f9ca9bd1cd4f6221\",\"/knowledge-medium/pr-preview/pr-1927/src/components/workspace/PendingInvitations.js\":\"dad9df4d3e2f1f60\",\"/knowledge-medium/pr-preview/pr-1927/src/components/workspace/SyncProgress.js\":\"6aa132c6d9618121\",\"/knowledge-medium/pr-preview/pr-1927/src/components/workspace/UnlockProgress.js\":\"f2c3cbad50b3871e\",\"/knowledge-medium/pr-preview/pr-1927/src/components/workspace/WorkspaceKeyGate.js\":\"2df8aa4e0787d5dd\",\"/knowledge-medium/pr-preview/pr-1927/src/components/workspace/WorkspaceSettingsDialog.js\":\"558e25e05fa092ac\",\"/knowledge-medium/pr-preview/pr-1927/src/components/workspace/WorkspaceSwitcher.js\":\"ddfd387bb02c2198\",\"/knowledge-medium/pr-preview/pr-1927/src/components/workspace/WorkspaceSyncGate.js\":\"0e7bd7ede2abc10c\",\"/knowledge-medium/pr-preview/pr-1927/src/components/workspace/conversion/ConversionFlow.js\":\"9c2f5a4e23746a25\",\"/knowledge-medium/pr-preview/pr-1927/src/components/workspace/conversion/ConversionFlowHost.js\":\"214fe323fa6e63eb\",\"/knowledge-medium/pr-preview/pr-1927/src/components/workspace/conversion/EncryptionSection.js\":\"70683c0ee493e091\",\"/knowledge-medium/pr-preview/pr-1927/src/components/workspace/conversion/attachmentPrompts.js\":\"0008550df120eb60\",\"/knowledge-medium/pr-preview/pr-1927/src/components/workspace/conversion/bundleFolderPrompts.js\":\"d9a77b56f56df4cb\",\"/knowledge-medium/pr-preview/pr-1927/src/components/workspace/conversion/conversionFlowDeps.js\":\"ce182405cbf112bb\",\"/knowledge-medium/pr-preview/pr-1927/src/components/workspace/conversion/conversionFlowStore.js\":\"f8fe39df4e925841\",\"/knowledge-medium/pr-preview/pr-1927/src/components/workspace/conversion/flowUi.js\":\"66fed7ffd82fec5d\",\"/knowledge-medium/pr-preview/pr-1927/src/components/workspace/conversion/useConversionRun.js\":\"e7b2404173a6a7ef\",\"/knowledge-medium/pr-preview/pr-1927/src/components/workspace/keyUi.js\":\"817409077c64a82e\",\"/knowledge-medium/pr-preview/pr-1927/src/components/workspace/useCloseOnKeyLoss.js\":\"8e6fea8a8fbf35da\",\"/knowledge-medium/pr-preview/pr-1927/src/components/workspace/useCloseOnServerE2ee.js\":\"9603dd8d480281b6\",\"/knowledge-medium/pr-preview/pr-1927/src/components/workspace/workspaceUnlocked.js\":\"bc7753a66bc2f637\",\"/knowledge-medium/pr-preview/pr-1927/src/context/backgroundSubtree.js\":\"0b4577912cfb8145\",\"/knowledge-medium/pr-preview/pr-1927/src/context/block.js\":\"00a4c6ebeb89a2bb\",\"/knowledge-medium/pr-preview/pr-1927/src/context/layoutWsContext.js\":\"f07a3a659a94b6cc\",\"/knowledge-medium/pr-preview/pr-1927/src/context/propertyDisplay.js\":\"49ead6d8e22c7aff\",\"/knowledge-medium/pr-preview/pr-1927/src/context/repo.js\":\"9dd990e367c5c5d9\",\"/knowledge-medium/pr-preview/pr-1927/src/data/aliasClaim.js\":\"91b34951ca3df045\",\"/knowledge-medium/pr-preview/pr-1927/src/data/aliasSeatNamespace.js\":\"2f6dd0aa703b2e75\",\"/knowledge-medium/pr-preview/pr-1927/src/data/api/blockData.js\":\"c7abc8dee77df4d0\",\"/knowledge-medium/pr-preview/pr-1927/src/data/api/blockType.js\":\"66aaeb0ac7e1acb0\",\"/knowledge-medium/pr-preview/pr-1927/src/data/api/changeScope.js\":\"b1da656e15bab3ac\",\"/knowledge-medium/pr-preview/pr-1927/src/data/api/codecs.js\":\"ab9ffc7e89dfbfaf\",\"/knowledge-medium/pr-preview/pr-1927/src/data/api/derivedData.js\":\"b5cfeb7843ac7292\",\"/knowledge-medium/pr-preview/pr-1927/src/data/api/errors.js\":\"d97df051f283f1ba\",\"/knowledge-medium/pr-preview/pr-1927/src/data/api/events.js\":\"59e194af443661ca\",\"/knowledge-medium/pr-preview/pr-1927/src/data/api/handle.js\":\"7816467dde64a91b\",\"/knowledge-medium/pr-preview/pr-1927/src/data/api/index.js\":\"0d752eb04c42c2a2\",\"/knowledge-medium/pr-preview/pr-1927/src/data/api/mutator.js\":\"74cc20d66fc64b8e\",\"/knowledge-medium/pr-preview/pr-1927/src/data/api/processor.js\":\"8dd9b2a23507680a\",\"/knowledge-medium/pr-preview/pr-1927/src/data/api/propertySchema.js\":\"f6621cfdef52ca91\",\"/knowledge-medium/pr-preview/pr-1927/src/data/api/query.js\":\"17ec95500f263683\",\"/knowledge-medium/pr-preview/pr-1927/src/data/api/sameTxProcessor.js\":\"05d91a4d598560c6\",\"/knowledge-medium/pr-preview/pr-1927/src/data/api/schema.js\":\"7816467dde64a91b\",\"/knowledge-medium/pr-preview/pr-1927/src/data/api/tx.js\":\"7816467dde64a91b\",\"/knowledge-medium/pr-preview/pr-1927/src/data/api/typedBlockQuery.js\":\"8df6788e4ed803e8\",\"/knowledge-medium/pr-preview/pr-1927/src/data/api/user.js\":\"79e9f0fe49f549c4\",\"/knowledge-medium/pr-preview/pr-1927/src/data/api/valuePresetCore.js\":\"7291dee89afed1a7\",\"/knowledge-medium/pr-preview/pr-1927/src/data/api/valuePresets.js\":\"9462d73d51faf019\",\"/knowledge-medium/pr-preview/pr-1927/src/data/attachmentCleanerIOVerb.js\":\"25de37b8f276f607\",\"/knowledge-medium/pr-preview/pr-1927/src/data/block.js\":\"59fdcf4f33d7b53c\",\"/knowledge-medium/pr-preview/pr-1927/src/data/blockCache.js\":\"1e19fe87dd68240f\",\"/knowledge-medium/pr-preview/pr-1927/src/data/blockId.js\":\"b2c0335e8896e8bc\",\"/knowledge-medium/pr-preview/pr-1927/src/data/blockLiveness.js\":\"4d4fd745931fa0f0\",\"/knowledge-medium/pr-preview/pr-1927/src/data/blockMerge.js\":\"5b061acc1b07f720\",\"/knowledge-medium/pr-preview/pr-1927/src/data/blockSchema.js\":\"eccbf64029fdcc2f\",\"/knowledge-medium/pr-preview/pr-1927/src/data/blockTypeLookup.js\":\"06667da767a80e43\",\"/knowledge-medium/pr-preview/pr-1927/src/data/blockTypes.js\":\"49da3a722b21bb2f\",\"/knowledge-medium/pr-preview/pr-1927/src/data/childrenView.js\":\"f4edf48284133f0e\",\"/knowledge-medium/pr-preview/pr-1927/src/data/clientContext.js\":\"0fd4384c2987cee5\",\"/knowledge-medium/pr-preview/pr-1927/src/data/dbFileSiblings.js\":\"a41cf4fc8644a686\",\"/knowledge-medium/pr-preview/pr-1927/src/data/definitionSeeds.js\":\"46b08ea0c8ab7ec1\",\"/knowledge-medium/pr-preview/pr-1927/src/data/derivedIds.js\":\"5963314a15635301\",\"/knowledge-medium/pr-preview/pr-1927/src/data/drawnSubtree.js\":\"9c1e75e4609b0c21\",\"/knowledge-medium/pr-preview/pr-1927/src/data/facetBridge.js\":\"ea3bf6b811b9bd1a\",\"/knowledge-medium/pr-preview/pr-1927/src/data/facets.js\":\"a3f8e9d770e81077\",\"/knowledge-medium/pr-preview/pr-1927/src/data/globalState.js\":\"a12bfdff9b4e879d\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/aliasClaimRederiveProcessor.js\":\"29dc8b610562f55a\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/ancestorBatch.js\":\"d5af2a5f19feb430\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/blockTypeTypeifyProcessor.js\":\"16924bb754a5b732\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/clientSchema.js\":\"14ce70b6ce0d762e\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/commitPipeline.js\":\"67a5acd9b0ca65cb\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/devAssertions.js\":\"e26d20a36b6887d9\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/firstSync.js\":\"69816e72a2ab965c\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/freshInitialLoad.js\":\"7636dc7d9368378a\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/graphBackfillClaim.js\":\"e2a39ef7114ea6b1\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/handleStore.js\":\"424f3f2778392ac7\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/idleMarkerJobs.js\":\"f1a884beb9294220\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/initialDownload.js\":\"5085aefcb04bfe85\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/initializeClientDatabase.js\":\"740dcc7431729b40\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/jsonCanonical.js\":\"2e1017721f1ca57d\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/kernelInvalidation.js\":\"c1d948e9a3eefb6e\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/kernelProcessors.js\":\"4d765afc94b9046b\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/kernelQueries.js\":\"0afb62f30ea291ca\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/mergeTypeMembershipProcessor.js\":\"7480b4d6c47b1a0d\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/normalizeReferencesProcessor.js\":\"a9b2268a4b1c4395\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/poolInstrumentation.js\":\"d505536390eb89ae\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/processorRunner.js\":\"18df8f304e6fd56c\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/propertyCellBackfill.js\":\"f8194b07cb6972e0\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/propertyChildMint.js\":\"98b09282ee24042c\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/propertyChildrenProcessor.js\":\"ce1cd9c2c970e60d\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/propertyDefinitionChangeProcessor.js\":\"a81558c72893a7c6\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/propertyDefinitionSynthesis.js\":\"90576666e6ef98ce\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/propertyKeyScan.js\":\"e0aa5fd3b7e47efb\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/propertySchemaResolution.js\":\"32a8d51f559542b3\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/propertyValueEdits.js\":\"ccc449b8103b49ba\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/raiseProtocol.js\":\"09de9f153bf521b0\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/readBatch.js\":\"78d9646a166f0b5d\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/refProjection.js\":\"cd73f7c229b83b87\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/referenceTargetLookups.js\":\"e1d6463a66f435f0\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/referenceTargetProcessor.js\":\"dcbaafe476ce8869\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/replayMerge.js\":\"203769d889d69e48\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/sqlBinds.js\":\"630cda954bf592ec\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"0cbcfe2f526ea6d1\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/syncObserver/arrivalProcessors.js\":\"41321a05c9415ec2\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/syncObserver/invalidate.js\":\"a64615182526c39a\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/syncObserver/materialize.js\":\"8a798d01e3f98265\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/syncObserver/observer.js\":\"c68fe36828973fc1\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/syncObserver/reconcile.js\":\"f378aaeadfe66d85\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/timingMetrics.js\":\"3bf243bc30832c40\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/treeQueries.js\":\"d883874d5225a01b\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/txEngine.js\":\"74ec0372be7809c1\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/txSnapshots.js\":\"15cc8bb0ebde7355\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/typedBlockQuery.js\":\"5546da396d846106\",\"/knowledge-medium/pr-preview/pr-1927/src/data/internals/undoManager.js\":\"49aec0142b4830af\",\"/knowledge-medium/pr-preview/pr-1927/src/data/invalidation.js\":\"9f53890f75487a1e\",\"/knowledge-medium/pr-preview/pr-1927/src/data/kernelDataExtension.js\":\"c43d9906435239e2\",\"/knowledge-medium/pr-preview/pr-1927/src/data/kernelPage.js\":\"e9591d51c9b7f402\",\"/knowledge-medium/pr-preview/pr-1927/src/data/kernelValuePresetCores.js\":\"dc6f3f6629bd6f7d\",\"/knowledge-medium/pr-preview/pr-1927/src/data/localDbCorruptionSignal.js\":\"04414bd12aaabb2b\",\"/knowledge-medium/pr-preview/pr-1927/src/data/localDbStorage.js\":\"bc381796fbe1f7a3\",\"/knowledge-medium/pr-preview/pr-1927/src/data/localDbVfs.js\":\"38a0913746660769\",\"/knowledge-medium/pr-preview/pr-1927/src/data/localSchema.js\":\"787a00d8c1662e28\",\"/knowledge-medium/pr-preview/pr-1927/src/data/maintenance.js\":\"43d24985e8da6dcd\",\"/knowledge-medium/pr-preview/pr-1927/src/data/mergeProperties.js\":\"fa3e99b81f3b1ba7\",\"/knowledge-medium/pr-preview/pr-1927/src/data/metricsConsoleHook.js\":\"aecf97d990c196c0\",\"/knowledge-medium/pr-preview/pr-1927/src/data/migrationsPage.js\":\"9cbff165515ea8f3\",\"/knowledge-medium/pr-preview/pr-1927/src/data/mutators.js\":\"0da6d5a9137ee5b3\",\"/knowledge-medium/pr-preview/pr-1927/src/data/orderKey.js\":\"a027938fa2b70dfa\",\"/knowledge-medium/pr-preview/pr-1927/src/data/orderKeyPlacement.js\":\"498fbbb74006d8f5\",\"/knowledge-medium/pr-preview/pr-1927/src/data/outlineSurface.js\":\"b454e571399805be\",\"/knowledge-medium/pr-preview/pr-1927/src/data/pendingEditorContent.js\":\"dfbbc8015d2f94c5\",\"/knowledge-medium/pr-preview/pr-1927/src/data/pendingUploadsSql.js\":\"ce8d8f5d659ec361\",\"/knowledge-medium/pr-preview/pr-1927/src/data/pluginStateExtensions.js\":\"cedff016366e14d7\",\"/knowledge-medium/pr-preview/pr-1927/src/data/powerSyncLogger.js\":\"13801bbcb145824a\",\"/knowledge-medium/pr-preview/pr-1927/src/data/projectorRuntime.js\":\"7be4592b1b3d8278\",\"/knowledge-medium/pr-preview/pr-1927/src/data/properties.js\":\"fe6754292e1e78ee\",\"/knowledge-medium/pr-preview/pr-1927/src/data/propertiesPage.js\":\"f217260f569c81d3\",\"/knowledge-medium/pr-preview/pr-1927/src/data/propertyChildren.js\":\"5d790c0876edad66\",\"/knowledge-medium/pr-preview/pr-1927/src/data/propertyDefinitionFanout.js\":\"527c417e886a08f3\",\"/knowledge-medium/pr-preview/pr-1927/src/data/propertyDefinitionMetadata.js\":\"3741c4ca044884dd\",\"/knowledge-medium/pr-preview/pr-1927/src/data/propertyDefinitionRegistry.js\":\"e98657f1372fc0c8\",\"/knowledge-medium/pr-preview/pr-1927/src/data/propertyDisplayMode.js\":\"c891264b115a355d\",\"/knowledge-medium/pr-preview/pr-1927/src/data/propertyRowCreation.js\":\"c9ce30915b5001f8\",\"/knowledge-medium/pr-preview/pr-1927/src/data/propertySchemaCreation.js\":\"c400fe402aa1a6c4\",\"/knowledge-medium/pr-preview/pr-1927/src/data/propertySeeds.js\":\"c917f3c7e7da25f8\",\"/knowledge-medium/pr-preview/pr-1927/src/data/recentsPage.js\":\"75d938e42e6ffae1\",\"/knowledge-medium/pr-preview/pr-1927/src/data/refTargetComparableProperty.js\":\"13914500e44c6d92\",\"/knowledge-medium/pr-preview/pr-1927/src/data/referenceBlock.js\":\"fc709bf72a9397a5\",\"/knowledge-medium/pr-preview/pr-1927/src/data/rejectedUploads.js\":\"a4ccae015a3fe6a2\",\"/knowledge-medium/pr-preview/pr-1927/src/data/releasePowerSyncConnection.js\":\"e362acd5b2c31c96\",\"/knowledge-medium/pr-preview/pr-1927/src/data/repo.js\":\"547346dc63237a41\",\"/knowledge-medium/pr-preview/pr-1927/src/data/repoProvider.js\":\"dae97020b6fd1663\",\"/knowledge-medium/pr-preview/pr-1927/src/data/rowProperty.js\":\"fe1004708b619d74\",\"/knowledge-medium/pr-preview/pr-1927/src/data/searchFilter.js\":\"f01fb9a0ea80d829\",\"/knowledge-medium/pr-preview/pr-1927/src/data/seedIdentityLedger.js\":\"d5a4ad3e86171736\",\"/knowledge-medium/pr-preview/pr-1927/src/data/stateBlocks.js\":\"7d13474d2c844d9f\",\"/knowledge-medium/pr-preview/pr-1927/src/data/structuralEditPolicy.js\":\"0bd771493b94eb3a\",\"/knowledge-medium/pr-preview/pr-1927/src/data/structuralInsert.js\":\"f44f12b9ba7343d2\",\"/knowledge-medium/pr-preview/pr-1927/src/data/subtreeDelete.js\":\"d4822c6387abc400\",\"/knowledge-medium/pr-preview/pr-1927/src/data/syncStreamLock.js\":\"3ebb905271e5f705\",\"/knowledge-medium/pr-preview/pr-1927/src/data/syncedTableSqlRecognizer.js\":\"cbccb294e82364d8\",\"/knowledge-medium/pr-preview/pr-1927/src/data/syncedTableWriteGuard.js\":\"ca5b3957d1630246\",\"/knowledge-medium/pr-preview/pr-1927/src/data/targets.js\":\"8f9ad6d6ea7aeb12\",\"/knowledge-medium/pr-preview/pr-1927/src/data/typeColors.js\":\"a3f591dd13afdbda\",\"/knowledge-medium/pr-preview/pr-1927/src/data/typeDefinitionMetadata.js\":\"472d1a782446fcbd\",\"/knowledge-medium/pr-preview/pr-1927/src/data/typeDefinitionRegistry.js\":\"930ceaeeced186c8\",\"/knowledge-medium/pr-preview/pr-1927/src/data/typeExtraction.js\":\"aac322ac6a0b6164\",\"/knowledge-medium/pr-preview/pr-1927/src/data/typeInitialValues.js\":\"9cbab943ec03e536\",\"/knowledge-medium/pr-preview/pr-1927/src/data/typePropertyGroups.js\":\"d3b493c293d05e67\",\"/knowledge-medium/pr-preview/pr-1927/src/data/typeSeeds.js\":\"f0a42cb87e39530d\",\"/knowledge-medium/pr-preview/pr-1927/src/data/typeTagger.js\":\"b5cc0c7c403e0b34\",\"/knowledge-medium/pr-preview/pr-1927/src/data/typedRecords.js\":\"c9caac25bb5e5165\",\"/knowledge-medium/pr-preview/pr-1927/src/data/typesPage.js\":\"c050c637f3b2a0cc\",\"/knowledge-medium/pr-preview/pr-1927/src/data/userPrefs.js\":\"ee9401d1756d8391\",\"/knowledge-medium/pr-preview/pr-1927/src/data/userSchemasService.js\":\"32f9a0bbe3776ded\",\"/knowledge-medium/pr-preview/pr-1927/src/data/userTypesService.js\":\"048c866b0265e3f7\",\"/knowledge-medium/pr-preview/pr-1927/src/data/valuePresetRegistry.js\":\"84f9d6ccc2cd5112\",\"/knowledge-medium/pr-preview/pr-1927/src/data/visibleChildren.js\":\"2999017f71773e74\",\"/knowledge-medium/pr-preview/pr-1927/src/data/workspaceConversion.js\":\"3a18c198b72e90ea\",\"/knowledge-medium/pr-preview/pr-1927/src/data/workspaceFirstSync.js\":\"95816ba860635819\",\"/knowledge-medium/pr-preview/pr-1927/src/data/workspaceIdNamespace.js\":\"2526b0edbf85478c\",\"/knowledge-medium/pr-preview/pr-1927/src/data/workspaceSchema.js\":\"4ae88ea4e72b4de9\",\"/knowledge-medium/pr-preview/pr-1927/src/data/workspaces.js\":\"7c830283fb94c6a8\",\"/knowledge-medium/pr-preview/pr-1927/src/data/writeAheadLog.js\":\"8defc7c1449db47e\",\"/knowledge-medium/pr-preview/pr-1927/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1927/src/editor/BlockPasteShellDecorator.js\":\"0d3fe33edf4eabc6\",\"/knowledge-medium/pr-preview/pr-1927/src/editor/atTrigger.js\":\"bde5ea0e1b85e234\",\"/knowledge-medium/pr-preview/pr-1927/src/editor/autocomplete.js\":\"7f1a61a13aea3ab6\",\"/knowledge-medium/pr-preview/pr-1927/src/editor/codeMirrorExtensions.js\":\"cdc68d3b76187e0d\",\"/knowledge-medium/pr-preview/pr-1927/src/editor/contentFlush.js\":\"1bf9c3898b4438a5\",\"/knowledge-medium/pr-preview/pr-1927/src/editor/defaultInteractions.js\":\"512efcaac76490e5\",\"/knowledge-medium/pr-preview/pr-1927/src/editor/editSettleSignal.js\":\"fe53f5d0bb61885c\",\"/knowledge-medium/pr-preview/pr-1927/src/editor/insertImage.js\":\"606a9668de2a8041\",\"/knowledge-medium/pr-preview/pr-1927/src/editor/referenceCompletionRange.js\":\"235fc688c3942967\",\"/knowledge-medium/pr-preview/pr-1927/src/editor/referenceTargetTypes.js\":\"99058ea5b8cb2b3e\",\"/knowledge-medium/pr-preview/pr-1927/src/editor/syntaxContext.js\":\"72f24b6a2a5d732c\",\"/knowledge-medium/pr-preview/pr-1927/src/editor/triggerMatch.js\":\"754a6e088f466410\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/AppRuntimeProvider.js\":\"7d3f6dc2d8e86e0f\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/BlockFocusShellDecorator.js\":\"057f988e083ff8aa\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/ExtensionRenderBoundary.js\":\"7861e4fce598cf07\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/PanelContentRecovery.js\":\"19c731d90e760b0e\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/apiCatalog.js\":\"d5b0412ad3eb5e48\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/appRuntimeController.js\":\"abc54b953f1df6e5\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/approveExtensionHere.js\":\"9d6e7e16d94a7d6f\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/armedCutAppMount.js\":\"4a8a824324baa5b8\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/batchableKeyedStore.js\":\"7fd203aa4c67ebe3\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/blockInteraction.js\":\"263183ca009aa157\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/blockSelectionAction.js\":\"823bc42b7cd00aa7\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/buildApprovalRecord.js\":\"6f3b067af2327eff\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/compileExtensionModule.js\":\"36f890aaab0ca9c3\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/compiledModuleCache.js\":\"9817d75efbe9a0f1\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/continuousGestures.js\":\"b9cd0d37fbdb7c3d\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/core.js\":\"61a1357d2297efab\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/defaultRenderers.js\":\"50962708f32ed502\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/definitionFanoutAppMount.js\":\"d282ea1c9d601c3b\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/dialogAppMount.js\":\"f781acf5d65dcebc\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/dynamicExtensionSeeds.js\":\"1d25e01dc4c39d1a\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/dynamicExtensions.js\":\"cd70fc2cd6e9ba5e\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/exampleExtensions.js\":\"56e7a9e211134300\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/extensionApprovalStatus.js\":\"035301e8cc4320c6\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/extensionImportPolicy.js\":\"e8df16b01710e4d9\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/extensionLoadErrorToast.js\":\"a8a0773ccbbbb468\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/extensionLoadErrors.js\":\"34545f1a9b56b81d\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/extensionLookup.js\":\"dc74410d7ca813f3\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/extensionToggles.js\":\"13842963e6a3d82d\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/extensionUtilitiesCss.js\":\"ba0fa533825fe691\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/kernelPageDeletionGuard.js\":\"b22dbb2546caef56\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/liveRuntime.js\":\"daba4586e9ab885c\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/normalizeExtensionSource.js\":\"34bc7ba474afed03\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/openExtensionsSettings.js\":\"f4871de812411706\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/overridesCache.js\":\"d15a5e961764b09e\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/pluginIds.js\":\"49636d91802ecaad\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/processorRejectionToast.js\":\"cd9b8052fd564cfd\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/runtimeActions.js\":\"ec3436ebf89e386d\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/runtimeContext.js\":\"6e524d392c5a252b\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/staticAppExtensions.js\":\"cac6dff7b46b44c4\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/staticDataExtensions.js\":\"b0e151e1bce9eb16\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/toastAppMount.js\":\"b74f613fd7dcc76d\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/transpileExtension.js\":\"91401f3649495c8f\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/useOverrides.js\":\"f536bbcf2b6630f5\",\"/knowledge-medium/pr-preview/pr-1927/src/extensions/useShortcutSurfaceActivations.js\":\"de417dfef1dd7afc\",\"/knowledge-medium/pr-preview/pr-1927/src/facets/discoverToggleTree.js\":\"4c9c15d4c6e34557\",\"/knowledge-medium/pr-preview/pr-1927/src/facets/facet.js\":\"03c2066b0d3f191f\",\"/knowledge-medium/pr-preview/pr-1927/src/facets/resolveAppRuntime.js\":\"562163b692436451\",\"/knowledge-medium/pr-preview/pr-1927/src/facets/runtimeEvents.js\":\"4701a161ffa24372\",\"/knowledge-medium/pr-preview/pr-1927/src/facets/togglable.js\":\"37579c72b62f1503\",\"/knowledge-medium/pr-preview/pr-1927/src/facets/variantFacet.js\":\"ae72f6be7fbc5917\",\"/knowledge-medium/pr-preview/pr-1927/src/facets/verbFacet.js\":\"b138a2b745216a28\",\"/knowledge-medium/pr-preview/pr-1927/src/hooks/block.js\":\"2b8f4b3154ec0576\",\"/knowledge-medium/pr-preview/pr-1927/src/hooks/focusedChild.js\":\"c5ae9b78b652226b\",\"/knowledge-medium/pr-preview/pr-1927/src/hooks/propertySchemas.js\":\"e3836fb4a076e297\",\"/knowledge-medium/pr-preview/pr-1927/src/hooks/typeRegistry.js\":\"a74d7965fa4be3ad\",\"/knowledge-medium/pr-preview/pr-1927/src/hooks/useAncestorCrumbs.js\":\"040ed07e0ab52a8c\",\"/knowledge-medium/pr-preview/pr-1927/src/hooks/useAutocompleteListbox.js\":\"fc2b5dd39d87c84d\",\"/knowledge-medium/pr-preview/pr-1927/src/hooks/useDebouncedSearch.js\":\"c6c095a527a9435d\",\"/knowledge-medium/pr-preview/pr-1927/src/hooks/useDebouncedValue.js\":\"46e36244e196fe0c\",\"/knowledge-medium/pr-preview/pr-1927/src/hooks/useFacetValue.js\":\"7de67469dbc51b51\",\"/knowledge-medium/pr-preview/pr-1927/src/hooks/useIsFocalRender.js\":\"954ae44a08308fb1\",\"/knowledge-medium/pr-preview/pr-1927/src/hooks/useIsReadOnly.js\":\"987af88942fb29f9\",\"/knowledge-medium/pr-preview/pr-1927/src/hooks/useMaterializeBacklog.js\":\"8549af7ed4bb08cb\",\"/knowledge-medium/pr-preview/pr-1927/src/hooks/useMinuteClock.js\":\"b7f624590d0831d6\",\"/knowledge-medium/pr-preview/pr-1927/src/hooks/usePanelLayoutProjection.js\":\"151cebf8cb1a819d\",\"/knowledge-medium/pr-preview/pr-1927/src/hooks/usePendingInvitations.js\":\"357569327fd2c406\",\"/knowledge-medium/pr-preview/pr-1927/src/hooks/useRendererRegistry.js\":\"9d29afa1bd0c9e1a\",\"/knowledge-medium/pr-preview/pr-1927/src/hooks/useRetainedFieldRows.js\":\"a89633aaf375dacf\",\"/knowledge-medium/pr-preview/pr-1927/src/hooks/useWorkspaces.js\":\"0ce6fe0048840b88\",\"/knowledge-medium/pr-preview/pr-1927/src/lib/utils.js\":\"8144f1743cc44d56\",\"/knowledge-medium/pr-preview/pr-1927/src/main.js\":\"6144dbf4ca9e942a\",\"/knowledge-medium/pr-preview/pr-1927/src/markdown/MarkdownImage.js\":\"bda1ba03116865c3\",\"/knowledge-medium/pr-preview/pr-1927/src/markdown/blockSeparators.js\":\"7e2f037aedcf5395\",\"/knowledge-medium/pr-preview/pr-1927/src/markdown/context.js\":\"dde60ed9cd6882fe\",\"/knowledge-medium/pr-preview/pr-1927/src/markdown/defaultMarkdownExtension.js\":\"9889d41961090080\",\"/knowledge-medium/pr-preview/pr-1927/src/markdown/extensions.js\":\"50b302838eaaa9ec\",\"/knowledge-medium/pr-preview/pr-1927/src/markdown/renderMarkdownHtml.js\":\"860ee5072dcc7fc9\",\"/knowledge-medium/pr-preview/pr-1927/src/minimal-editor.js\":\"1ed190ceb04480a5\",\"/knowledge-medium/pr-preview/pr-1927/src/paste/armedCut.js\":\"e5541f6e3f48bcb2\",\"/knowledge-medium/pr-preview/pr-1927/src/paste/captureMediaVerb.js\":\"6d0dda3a77365dea\",\"/knowledge-medium/pr-preview/pr-1927/src/paste/clipboard.js\":\"634478c42c0b29dc\",\"/knowledge-medium/pr-preview/pr-1927/src/paste/decision.js\":\"f1105d6370d1cced\",\"/knowledge-medium/pr-preview/pr-1927/src/paste/operations.js\":\"739fecc832890b27\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/account-header/AccountHeaderItem.js\":\"81080315024ee717\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/account-header/index.js\":\"50776fce6e4f8bd5\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"81443a2715ca9ea5\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-dispatch-companion/askAgent.js\":\"616741d2bfc9c743\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-dispatch-companion/askedStore.js\":\"278dea1a8533b6c6\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"2be4aaf525550518\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-dispatch-companion/chipState.js\":\"03758a4e8671272e\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-dispatch-companion/dataExtension.js\":\"cb6e27fa9cd5d713\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-dispatch-companion/index.js\":\"be3b07a932664c57\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"4f9af639b7f89348\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-dispatch-companion/retryAgent.js\":\"e35e41e9458d2298\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-dispatch-companion/schema.js\":\"0327a91c0ed6bd63\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/AgentTokensDialog.js\":\"9b455aa76d0b0793\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/BridgePairingDialog.js\":\"cead1fd721f9bcbe\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/addMedia.js\":\"d1b34f180147975d\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/agentViews/backlinks.js\":\"9deaba7e117db9e7\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/agentViews/block.js\":\"9da910cf58aa6208\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/agentViews/context.js\":\"f8086f8c27221fb4\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/agentViews/displayIds.js\":\"ccd825c568ad2989\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/agentViews/index.js\":\"9afa11617b415a30\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/agentViews/outline.js\":\"b50b326e5698d522\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/agentViews/properties.js\":\"f655ad9fa699c9a1\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/agentViews/refs.js\":\"7e0ebace4866c49b\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"60abf3b41a22dc28\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/agentViews/search.js\":\"1a888b3c7013b8f4\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/agentViews/shared.js\":\"12b610340b745d96\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"eaace89758957a33\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/agentViews/text.js\":\"92756a5d7d231dcf\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/agentWrites.js\":\"62a39016de1df97f\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/authoringCatalog.js\":\"f42cf2fb3a564284\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/blockRefTargets.js\":\"d96994af4c6e33cd\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/bridge.js\":\"84803f9434d31ba9\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/bridgeLoop.js\":\"b4943d7eac5feb93\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/changeHistory.js\":\"7a0edb46cababace\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/commands.js\":\"816a3265f5ed708a\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/commentsCommands.js\":\"00f910185898cffb\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/dataExtension.js\":\"61b74a54d4601e55\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/dataModelGuide.js\":\"aa24420a4fef3493\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/dayPropertyInputs.js\":\"9a1698330eaf29ed\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/describeRuntime.js\":\"5d9de2e69780a2f9\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/extensionLint.js\":\"bfdc22ce2a5ff1f2\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/grainAudit.js\":\"6b8fdba465fae90b\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/healthCommand.js\":\"84eb57614f4c56d4\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/index.js\":\"52fb439faac2d35f\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/presetIdentity.js\":\"903a6e2e6d099c12\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"a488d61fce643bfc\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/readMedia.js\":\"5bd165b7de28a828\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/schema.js\":\"23b4e8145a4a7bcd\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/serialization.js\":\"57c6d5198f926c98\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/targets.js\":\"392b394c8599b436\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/tokens.js\":\"58be8854fd204ed8\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/watchEvents.js\":\"b0ea3db03ec2106e\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/workspaceGuard.js\":\"d3edfbac1190cc4b\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/agent-runtime/writeCommands.js\":\"4aa0b0228d039493\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/alias/AliasCollisionToast.js\":\"f8572d648acfca3d\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/alias/DuplicateNameBanner.js\":\"b4ef5348bc9d014a\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/alias/collisionMerge.js\":\"556c716b1068b5db\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/alias/dataExtension.js\":\"bd634dbefc13476d\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/alias/index.js\":\"24b6debb15860d25\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/alias/mergeCollisionAction.js\":\"78d33d31f995cb99\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/alias/pageStyling.js\":\"eb395e5aac7e64ac\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/alias/rejectionToast.js\":\"c087b64530bb4666\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/alias/syncProcessor.js\":\"f2ac241d3b875f7c\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/actions.js\":\"dd7ad5bf966c7e41\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/addComment.js\":\"3ebd89bbee8237a8\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/anchor.js\":\"a001b0aaed884a18\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/anchorState.js\":\"5e21513f2b4a4283\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/commentLinks.js\":\"aec8787827101300\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/confirmThreadDeletion.js\":\"a5813b5524f8ab95\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/container.js\":\"d79542ff44651028\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/dataExtension.js\":\"98e15ed7f8ace972\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/deleteComment.js\":\"7a450210c9bd7411\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/highlights.js\":\"831f497de8bc20e4\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/index.js\":\"8bb7b841a9c02212\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/linkedCommentsPill.js\":\"b872bd86bc07a322\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/margin.js\":\"f920d0ca7f5a298d\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/marginAnchorLinks.js\":\"1d8b7ae873e6fd55\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/marginSchema.js\":\"83f578f509641ae3\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/newComment.js\":\"87ed127c11374067\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/ownThreadPicker.js\":\"a03efc44cdde6eeb\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/placement.js\":\"77bf05cd56ba615f\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/queries.js\":\"ea4f67d1689ab02b\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/quotePosition.js\":\"ac3ec4be8709040a\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/quotedIn.js\":\"5ecd74412458b241\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/quotedRange.js\":\"a270ec8934bc4073\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/rangeRefs.js\":\"291f301d12db6e8a\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/readHighlights.js\":\"48929d377788b3dc\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/readSelection.js\":\"b8cd53bfacb2a9c6\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/readSelectionUi.js\":\"22ba297db7107f2f\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/reanchor.js\":\"af4ecc08c2c10454\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/schema.js\":\"79d481278c877578\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/scope.js\":\"17b32cb7080bb671\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/scopeThreads.js\":\"6148e8f72bfaf7a1\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/splitRetarget.js\":\"2f94c39e6afd588a\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/suggestionCard.js\":\"4cae08566d485812\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/suggestions.js\":\"efc5d90511adac2a\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/summaries.js\":\"9155719df3956a8b\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/summaryBatch.js\":\"1838a264329bd9ee\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/surface.js\":\"22ada8e041de8651\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/threadNavigation.js\":\"8d7182dbbe7b76de\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/threads.js\":\"dd4e4d2c33f3416a\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/ui.js\":\"7c7900580b85c757\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/annotations/uiStore.js\":\"9517652ef31ecca6\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/app-intents/appIntents.js\":\"a222021b8176aa18\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/app-intents/index.js\":\"e79f5646667fff87\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/app-update-prompt/index.js\":\"aa3d72ea0e7ec6a2\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/app-update-prompt/status.js\":\"ff9e4aebd553e6b2\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"fd228f415d671ecd\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/MediaBlockRenderer.js\":\"d349ebc0733ff59c\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/MediaDownLaneReplicator.js\":\"5edd04fc232297d4\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/MediaUploadReconciler.js\":\"90f2e639ca775390\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/assetDownLane.js\":\"98111372426b078e\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/assetResolver.js\":\"65d5741eba867f81\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/assetUpload.js\":\"18912a2b79ae736d\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/attachmentCleanerIO.js\":\"b255e927575398bb\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/audit/supabaseAuditIO.js\":\"7041dfb96c98bc84\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/blobStore.js\":\"57d1d8ff495eace8\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/browserMedia.js\":\"09e1852b40ac6867\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/byteStore.js\":\"50a83af92c3f7c65\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/cleanerIO.js\":\"f5591feac38723b2\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/cleanupAttachments.js\":\"058f3ac40cdcfc2a\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/dataExtension.js\":\"41f074a6409ccfa7\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/downLane.js\":\"c85eee679a9ab028\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/index.js\":\"23db808f416c7f27\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/insertImageContribution.js\":\"8c1000489eb96f04\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/laneArming.js\":\"083043ac2ac5999d\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/laneLock.js\":\"e0ec498a5f115cff\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/mediaBlock.js\":\"ece4028ed95c68f7\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/mediaCapture.js\":\"c7fe1833b71bdeef\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/mediaLanes.js\":\"00ec19c85b1d4b13\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/mediaViewers.js\":\"0580a8e6365fb074\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/mediaViewersFacet.js\":\"381d20525ab6ec3a\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/pasteCapture.js\":\"23cbda4e57c36331\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/resolver.js\":\"4450ed78a8b876b8\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/retryUploadsAction.js\":\"52cdf75bcf1c38a6\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/storagePaths.js\":\"af830b4f2ceb389b\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/uploadDrain.js\":\"882023171ec277ee\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/uploadLaneStatus.js\":\"d5d9b0eba22ae204\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/uploadReconcile.js\":\"2efa913047cc6fcc\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/uploadRecovery.js\":\"0553f19abacce422\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/uploadStore.js\":\"f16406ee4b54fd59\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/attachments/useAssetObjectUrl.js\":\"3a5e17bac06d6b58\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"d3117341f4dc1bbe\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/backlinks-view/BacklinksViewSection.js\":\"43b8e9f495dddb8a\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/backlinks-view/facet.js\":\"c94af5196d6ca2e0\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/backlinks-view/index.js\":\"bdb2f047f5f10142\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/backlinks-view/prop.js\":\"0d5a867dc7c90069\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/backlinks/BacklinkFilters.js\":\"ffb993a1d4e06090\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"6e897284da7ce60c\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/backlinks/BlockEntry.js\":\"b45710c0c2908668\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/backlinks/LinkedReferences.js\":\"dca72fd824a526c5\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"ab0424dd6c948dff\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/backlinks/dailyNoteDefaults.js\":\"eefe224df47380a9\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/backlinks/dataExtension.js\":\"613d6745e1dc0a33\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/backlinks/edgeExclusions.js\":\"242adb7a47159723\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/backlinks/filterProperty.js\":\"a5b69bbe4a6e5091\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/backlinks/index.js\":\"4832c1450edc0bc8\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"1ebcd510064c22da\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/backlinks/inline-counts/applies.js\":\"60d2dc28ae7f2407\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/backlinks/inline-counts/countQuery.js\":\"758ab578e20355c3\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/backlinks/inline-counts/expansionStore.js\":\"adfd195d8286462d\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/backlinks/inline-counts/index.js\":\"d10d2dc7909c5797\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"936f117eb8da94a3\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/backlinks/presentationInvalidation.js\":\"ad3ed759ba62ce28\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/backlinks/propertyEditorOverride.js\":\"4e5faa35fd06b5e2\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/backlinks/propertyFilter.js\":\"d78f29e4fdfbcf31\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/backlinks/query.js\":\"df5da846ebcac61b\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/backlinks/resolveFilter.js\":\"ad8602910ca48e4a\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/backlinks/sourceBatch.js\":\"84c16ba36c0f74a9\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/backlinks/sources.js\":\"eb6c85e1c9859089\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/backlinks/useBacklinks.js\":\"60d9978a0c769783\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"af7402df277edf19\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/birthday/BirthdayCelebration.js\":\"3beb801468f63f63\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/birthday/BirthdayOverlay.js\":\"6cf796177c40134e\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/birthday/gate.js\":\"4ac9b23efd93e7dd\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/birthday/index.js\":\"8a7adb9ee348b1a7\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/birthday/wolfTheme.js\":\"30fa8972c6c1032e\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/block-drag/BlockDragLayer.js\":\"391eb36fc154eb82\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/block-drag/dragController.js\":\"895fff8e5c40ab94\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/block-drag/dropTarget.js\":\"574eaf7d2b174074\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/block-drag/index.js\":\"204ce14cf7d3e0ae\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/block-drag/projection.js\":\"359f47370ee24183\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/block-info/BlockMetaCard.js\":\"29edb1aebb284155\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/block-info/index.js\":\"7efa2e104c7319d7\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/block-tagging/AddTagDialog.js\":\"44e49febb349a6b8\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"7757d0e4b47549d0\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/block-tagging/TagNameIssueHint.js\":\"66d36898635a0993\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/block-tagging/addTagAction.js\":\"b57a302d8487d76f\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/block-tagging/appendTag.js\":\"9c25fa9ff686a188\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/block-tagging/config.js\":\"ada5179fb2d5d4ea\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/block-tagging/dataExtension.js\":\"4f7d65eca58d83da\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/block-tagging/index.js\":\"a439e16e8a72dc80\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/block-tagging/propertyEditorOverride.js\":\"4c93ea8a17714e62\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/breadcrumbs/BreadcrumbList.js\":\"b395dfa1f0d4455e\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"cd60a7c364ec991e\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/breadcrumbs/Breadcrumbs.js\":\"4ebe9dd00bdb5c82\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"41ecb8f30c33a185\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"14cbc5cfbaa87a55\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/breadcrumbs/index.js\":\"74fd56995eb584aa\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"51dc9ba09f598f17\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/character-counter/CharacterCountItem.js\":\"4cbb7a0efcd73812\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/character-counter/ProfilePropertyEditor.js\":\"fa6677c70c766177\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/character-counter/actions.js\":\"b2cb530b8bd8ea78\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/character-counter/blockType.js\":\"8dd8660fdab89971\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/character-counter/charCount.js\":\"5971052ad9fe4c82\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/character-counter/dataExtension.js\":\"4ff21790928bf9e3\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/character-counter/index.js\":\"3ff1825c9d9aaeb9\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/character-counter/profiles.js\":\"797467be082dd4f5\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/character-counter/properties.js\":\"bf53427b83563e5f\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/character-counter/subtree.js\":\"e895e31e1d3349fc\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/character-counter/textCounts.js\":\"f0309be13dc4b6bf\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/colemak-keybindings/index.js\":\"61f3c048bb6c7da8\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/command-palette/CommandPalette.js\":\"de7f5f228673faf7\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/command-palette/HeaderItem.js\":\"adc4f2a55f2e6d81\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/command-palette/context.js\":\"41a8ebbc2bce15a9\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/command-palette/index.js\":\"d270d50736eb068a\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/command-palette/selection.js\":\"17c7c49375182d32\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/command-palette/toggleStore.js\":\"dafd1f7c29de35be\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/command-palette/useCommandPaletteActions.js\":\"ce86c6247ab9ce42\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/contributors/ContributorBadges.js\":\"69c79871a328dd11\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/contributors/ProfilePicture.js\":\"4b31d5b694021a96\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/contributors/author.js\":\"b9a7b0958301aac5\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/contributors/codeMirrorExtensions.js\":\"a84d0501e8ee2eab\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/contributors/dataExtension.js\":\"059075686ded6a8e\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/contributors/index.js\":\"c0855a38f182d816\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/contributors/mentionAutocomplete.js\":\"504e278525153c3f\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/contributors/processor.js\":\"ef9bfa8a2ab1cd3b\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/contributors/profiles.js\":\"6db79aea8c500da1\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/contributors/queries.js\":\"95011f164b508626\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/contributors/schema.js\":\"ffe0a08b7e3b72d3\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/contributors/useCommentAuthor.js\":\"d89e77e918eef0dd\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"84cfe95b57fcc45f\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/cursor-follows-scroll/followOrigin.js\":\"c882aea0b023fcfb\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/cursor-follows-scroll/index.js\":\"fef446f5cf196bed\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"65eadf59741963c8\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"2b34839758ef2feb\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/daily-notes/CalendarGrid.js\":\"48a87708d7f0e8d8\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/daily-notes/DailyNotePicker.js\":\"67d4796e2ceeec74\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"8b086ab6dcd39dd8\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/daily-notes/DateNavDecorator.js\":\"0714cadea1e52b24\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/daily-notes/DateScrubOverlay.js\":\"76045bcbd869ddd5\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/daily-notes/DayPropertyControl.js\":\"951e7c34c2a7a771\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/daily-notes/DayValueReferenceControl.js\":\"d560fcf90e2206fc\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/daily-notes/HeaderItem.js\":\"4877a8e72426ed55\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/daily-notes/ReschedulePicker.js\":\"595790566a866658\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/daily-notes/SpreadDatesDialog.js\":\"b5dc8df52262a394\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/daily-notes/actions.js\":\"e3a41ae37c958314\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/daily-notes/blockDateAdapter.js\":\"6f36b032b2bb2a92\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/daily-notes/calendar.js\":\"6d000c1cb5abc055\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/daily-notes/dailyNotes.js\":\"85964006a11fd800\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/daily-notes/dataExtension.js\":\"bebde5211008f730\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/daily-notes/dateScrubActions.js\":\"2c08c09ebba5783d\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/daily-notes/dateScrubGesture.js\":\"ffa0a962ff52f236\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/daily-notes/dateScrubGestureActions.js\":\"a9e1f6e9e14e57d8\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/daily-notes/dateScrubRecognizer.js\":\"ea3837dfef1b54f1\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/daily-notes/dayProperty.js\":\"f1f612951196a615\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"070d9ab88e50f6e3\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/daily-notes/deletionGuard.js\":\"e56ad30748481134\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/daily-notes/dueQuery.js\":\"61560b58ff738162\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/daily-notes/index.js\":\"379000240cf1028e\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/daily-notes/landing.js\":\"5123d52e42451e1a\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/daily-notes/localSchema.js\":\"5ef479578cbe685c\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/daily-notes/referenceDateAdapter.js\":\"7349d7fc6e8fa36f\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/daily-notes/rescheduleAction.js\":\"8415d17100193929\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/daily-notes/schema.js\":\"03f94e07d19c67f2\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/daily-notes/spreadBlockDates.js\":\"685583a046287553\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/daily-notes/spreadDatesAction.js\":\"23dc20aad9a20f61\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/daily-notes/today.js\":\"b1c58d103d5da32a\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"ea3fa6284e38f5a7\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"6cf4c4ca7c18607e\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/data-integrity/audit.js\":\"a0d19cf932674544\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/data-integrity/auditAction.js\":\"16d6c492cc25129e\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/data-integrity/auditRanges.js\":\"1fce72aa1cd54d4e\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/data-integrity/diagnosticsSource.js\":\"0a2f9a78938a1148\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/data-integrity/divergenceScan.js\":\"fbf2a557e516dcfa\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/data-integrity/index.js\":\"2b208e2c76e96ea7\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/data-integrity/propertyChildrenChecks.js\":\"b8e6cc301f9995fc\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/data-integrity/referencesMirror.js\":\"86e0b9c61c5c806e\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/data-integrity/rowJson.js\":\"53f3039ecaf84caa\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/data-integrity/schedule.js\":\"374ce8714c622d83\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/data-integrity/store.js\":\"dce3f891f7dba49c\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/db-maintenance/action.js\":\"89394339c3b58c59\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/db-maintenance/index.js\":\"858643512b70152e\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/db-maintenance/plugin.js\":\"6db3be05e6209e43\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"2bbc79bb632e0c3b\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/db-mirror/actions.js\":\"710dd3bd31220fdd\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/db-mirror/changeMarker.js\":\"b7353933f68298f5\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/db-mirror/diagnostics.js\":\"e7d1df3e4fcd40b0\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/db-mirror/fileSystemAccess.js\":\"ed7edcdb8832f0fd\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/db-mirror/filenames.js\":\"774887543c68705d\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/db-mirror/index.js\":\"ae70e9a936f431b2\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/db-mirror/mirror.js\":\"bc46a70e053590c1\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/db-mirror/runLock.js\":\"e177b205445c2681\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/db-mirror/runtimeHealth.js\":\"19787dd2fd63b0de\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/db-mirror/schedule.js\":\"ee027644a2ce3c09\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/db-mirror/store.js\":\"8e6a95aff19edbfe\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/default-themes/index.js\":\"88b10dd2d5bb8088\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/default-themes/themes.js\":\"e7e48beac3038263\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/diagnostics/facet.js\":\"c9ebee7a566f4e08\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/diagnostics/useDiagnostics.js\":\"e8fdbaea49c2db7f\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/extension-prompts/dismissals.js\":\"533595b8e3afb78d\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/extension-prompts/index.js\":\"e65a30a321d1107b\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/extension-prompts/status.js\":\"eda11d01287f9bc7\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/extension-prompts/store.js\":\"03efdb325d08c130\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"5f18b0460918545b\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/extensions-settings/ExtensionsSettings.js\":\"7761ddf1d187964e\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/extensions-settings/actions.js\":\"ef43c2d12bf55190\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/extensions-settings/config.js\":\"7767d4c3bef26a97\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/extensions-settings/dataExtension.js\":\"17c8653d9126dd2e\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/extensions-settings/effect.js\":\"e0e40273c5345165\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/extensions-settings/index.js\":\"6a220a9d83f3cbed\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/extensions-settings/propertyEditorOverride.js\":\"1a506bb376edc1e2\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/extensions-settings/useToggleTree.js\":\"b88810faedbb37e6\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/extract-type/ExtractTypeDialog.js\":\"91b0b76130806215\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"9ee6ea00f6ceba9b\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/extract-type/PropertyShapePicker.js\":\"116a30b15587d7c3\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/extract-type/action.js\":\"2440a34935a26f87\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/extract-type/index.js\":\"c73fb89a1dad31b0\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/find-replace/FindReplaceDialog.js\":\"73713fdf3b176cbc\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/find-replace/HeaderItem.js\":\"00ee6f4570011dd9\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/find-replace/dataExtension.js\":\"3f4aec9432b1ec1c\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/find-replace/index.js\":\"49debc4cca4d93a7\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/find-replace/search.js\":\"3a443d2a1f9e9a63\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/find-replace/toggleStore.js\":\"780f5b2baa17deab\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/geo/LocationPropertyEditor.js\":\"845feacd957011db\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/geo/MapView.js\":\"58716a38e4917880\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/geo/blockTypes.js\":\"519c690b6766e828\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/geo/codeMirrorExtensions.js\":\"f39dd09f1237eadd\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/geo/createOrFindPlace.js\":\"9cd7696d43afcc12\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/geo/currentLocation.js\":\"ebdb297f410a39c9\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/geo/dataExtension.js\":\"3fbe82f70d34b483\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/geo/geoContentDecorator.js\":\"bcca1a3e303a5e11\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/geo/googlePlacesClient.js\":\"bc97407dff5164ed\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/geo/index.js\":\"3128f49c0dd85da6\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/geo/locationsPage.js\":\"cf69a0ee2f596b0f\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/geo/mapViewport.js\":\"c72753c2b42e6244\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/geo/pickCurrentLocation.js\":\"29080e6d38ca17f2\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/geo/placeAutocomplete.js\":\"91210072ea17d888\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/geo/placeNameCollision.js\":\"022d240b9a43a333\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/geo/properties.js\":\"5b958e51b3302438\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/geo/propertyEditorOverrides.js\":\"86daa0db66efb596\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/geo/query.js\":\"e2d331dc6d544642\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/geo/usePlaceSearch.js\":\"b2b3729e1d6ea9ca\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"c1d1d4eb98e9f3d9\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"c11d1af0f0adf962\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"9b7f3c361ce14ed8\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/grouped-backlinks/config.js\":\"b5f6b2abda816395\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/grouped-backlinks/dataExtension.js\":\"394c058f4250d4ad\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/grouped-backlinks/facet.js\":\"42fe1dcb4aa4a4ba\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/grouped-backlinks/grouping.js\":\"53de596e6f2f45d0\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/grouped-backlinks/index.js\":\"22235a5c78459f05\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"64e1ee6375cc7851\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/grouped-backlinks/query.js\":\"5952f6fb52473ba4\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/grouped-backlinks/resolveConfig.js\":\"5d2cc68c70140469\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"d8b6d9709922c6e2\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"b83862c4d424c711\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/html-document/HtmlDocumentContent.js\":\"eb037814db504eca\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/html-document/HtmlFrame.js\":\"604a2ad22a08d593\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/html-document/actions.js\":\"a9c66b843b764a72\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/html-document/blockType.js\":\"f0f768d491daae76\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/html-document/confirmRunScripts.js\":\"47f37775dbc7db7c\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/html-document/dataExtension.js\":\"aadbdda72130d5d0\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/html-document/frameAnnotations.js\":\"f994d6259fc87f9d\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/html-document/frameDocument.js\":\"ed5ed4dea29fd58b\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/html-document/frameTheme.js\":\"76be2266f38fe64c\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/html-document/index.js\":\"7278b5ba0503aee9\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/html-document/scriptConsent.js\":\"6c96e4bf2db2b0c2\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/html-document/sourceMap.js\":\"1720a5c85d15f22f\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/html-document/useDocumentScripts.js\":\"caad0ae7b49b8ae0\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/interaction-metrics/index.js\":\"1730f059d31baba0\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/interaction-metrics/record.js\":\"cd07f9a95a9d11fb\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/interaction-metrics/recordStore.js\":\"65d4573f6a63a97e\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/interaction-metrics/responsiveness.js\":\"c2369129819e12f5\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/interaction-metrics/schedule.js\":\"eb6c6aebe6360544\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/interaction-metrics/sessionContext.js\":\"edc1d2aa1293a48a\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"515805a28bb75c0e\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"cec5d3baed99775a\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/keybindings-settings/actions.js\":\"f111c05032875209\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/keybindings-settings/config.js\":\"3f2d271ae560d9ee\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/keybindings-settings/dataExtension.js\":\"7928acdabb168e50\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/keybindings-settings/effect.js\":\"50df909d46e59945\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/keybindings-settings/index.js\":\"4e0b1c49406bd89c\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/keybindings-settings/keyCapture.js\":\"fedac1a8812ad219\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/keybindings-settings/overrideStore.js\":\"c6ec12a74328565c\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"bdd97dfbe7935839\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/left-sidebar/HeaderItem.js\":\"04c7ceb43e167982\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/left-sidebar/LeftSidebar.js\":\"3a93d731b379ac93\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/left-sidebar/actions.js\":\"452384b99695297c\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/left-sidebar/facet.js\":\"b9ce46ca435a63ff\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/left-sidebar/index.js\":\"d5460159d7dcbe42\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/left-sidebar/shortcuts.js\":\"0497c2cfb0ea8d37\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/left-sidebar/toggleStore.js\":\"d890102c568db38b\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/merge-blocks/MergePicker.js\":\"42a0e23a0dc21d55\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/merge-blocks/index.js\":\"fa434ed9efc8c3a0\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/merge-blocks/mergeAction.js\":\"4f0baea3053b7f1b\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/merge-blocks/strategy.js\":\"a2be2650a03ee2a2\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/mobile-bottom-nav/Button.js\":\"b4ac67235d009bcc\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"bc592b01e165ede5\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/mobile-bottom-nav/defaultItems.js\":\"04a543edd633527f\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/mobile-bottom-nav/facet.js\":\"add7fb6a9707296f\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/mobile-bottom-nav/index.js\":\"13c7a381db1be7ae\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"0e06029a8237ea14\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/mobile-keyboard-toolbar/actions.js\":\"12f6ebfd76480b64\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"d3b7330d5598e0c5\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/mobile-keyboard-toolbar/facet.js\":\"456b466bfef96b01\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/mobile-keyboard-toolbar/index.js\":\"c194d254e3052c55\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/move-blocks/MoveDestinationPicker.js\":\"ed8bff7a03c8a49e\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/move-blocks/blockSubtreeMembership.js\":\"1e74d966d34a2e0e\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/move-blocks/contextMenuItem.js\":\"34e1c9afcf4c293b\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/move-blocks/index.js\":\"d8dbe3bc3b2bf2ff\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/move-blocks/moveAction.js\":\"14b5eece8392e0a1\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/move-blocks/moveBlocks.js\":\"817f5bcc82a1271a\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/move-blocks/selectionAfterMove.js\":\"dafbd1e0333d010a\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/onboarding/TutorialBanner.js\":\"2cefc33a2aabb431\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/onboarding/action.js\":\"ad187eec5da3eded\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/onboarding/bannerDismissal.js\":\"4971f44375ac2d2a\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/onboarding/documents/cheatSheet.js\":\"cffc72343cceac92\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/onboarding/index.js\":\"0b14bacee230698d\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/onboarding/keys.js\":\"1e61fac52a6d1272\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/onboarding/landing.js\":\"31511dbcaee3899e\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/onboarding/outline.js\":\"6af112e68c465048\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/onboarding/seed.js\":\"bdb2fcd299e4f166\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/perf-monitor/PerfTrendDialog.js\":\"4484455951e83986\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/perf-monitor/analyze.js\":\"3305941195b44fe7\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/perf-monitor/diagnosticsSource.js\":\"9ee558886236832f\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/perf-monitor/index.js\":\"a15a289e93493c7e\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/perf-monitor/load.js\":\"816f444f094a328b\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/perf-monitor/monitorRun.js\":\"ed8b26043d7c367a\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/perf-monitor/schedule.js\":\"dc23682a95c59e74\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/perf-monitor/series.js\":\"57135f7ba07504d2\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/perf-monitor/store.js\":\"9acc3886d166ed29\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/perf-monitor/trendAction.js\":\"61f1664a8d70e339\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/perf-monitor/verdict.js\":\"05370a84b1baa518\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/plain-outliner/clickToEditAction.js\":\"455bea80fd541257\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/plain-outliner/index.js\":\"206569b4fc27d4af\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/plain-outliner/interactions.js\":\"ce9725b9ec9e9f13\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"9301d578e8ea6fd5\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/properties-migration/MigrationGate.js\":\"adce3e125df71cce\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/properties-migration/MigrationGateDialog.js\":\"1e0cced07063fd7a\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/properties-migration/action.js\":\"23383cc4e63e66ba\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/properties-migration/index.js\":\"706cd9690c6155fe\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/properties-migration/localRunMessage.js\":\"3d3de4ca81133b0a\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/properties-migration/plugin.js\":\"3070fa23976ddef2\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/properties-migration/progressReport.js\":\"85de6f15cacbdd9e\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/properties-migration/sweepProgress.js\":\"17adee4b030301cb\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/property-rows/FieldRowRenderer.js\":\"d8e6df0b5b929f9d\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/property-rows/ValueRowRenderer.js\":\"66a0a007bf6781b3\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/property-rows/actions.js\":\"a695d7494b38a348\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/property-rows/autocomplete.js\":\"95e014cb262b5be4\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/property-rows/fieldRow.js\":\"5150e544b9da848c\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/property-rows/index.js\":\"73f75c4acd165fd3\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/property-rows/referenceWarning.js\":\"d3ad57091ca39a33\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/property-rows/valueAutocomplete.js\":\"0e301a270375ba11\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/property-rows/valueSchema.js\":\"8c26dc747d300f67\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/quick-find/HeaderItem.js\":\"16d0b2c913004c4b\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/quick-find/QuickFind.js\":\"953f6bcc2d5b6a3d\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/quick-find/index.js\":\"53572d78e8ff1aeb\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/quick-find/recents.js\":\"f58d0f600e525202\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/quick-find/resultItems.js\":\"ec5d169f6ffedbe7\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/quick-find/selection.js\":\"ad709dbdcbf63ee5\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/quick-find/toggleStore.js\":\"c5e879d427334fb8\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/recents/HeaderItem.js\":\"62a29fc9b3cbfa32\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/recents/RecentsPageBlockRenderer.js\":\"575e1252dab1a78b\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/recents/grouping.js\":\"bd69c72401ce967f\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/recents/index.js\":\"2cab3071130e5cbd\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/recents/target.js\":\"2fee2fa2bd8ea05c\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/references/codeMirrorExtensions.js\":\"dd0968f171f0e13f\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/references/contentPrefill.js\":\"f7dcbd1cd11b392c\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/references/dataExtension.js\":\"c6eda5b20785e917\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/references/index.js\":\"db7ac9a00df391a8\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"1efd01c2f39961b6\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/references/invalidation.js\":\"91c2fa9dbf98c3a1\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/references/localSchema.js\":\"7d0afa354247af90\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/references/markdown/blockrefs/index.js\":\"8eca0b2f572e80b2\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"a037e0e1175d0c45\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/references/markdown/index.js\":\"9e4af00cc615cfa3\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/references/markdown/referenceNode.js\":\"877bc0a67c7077ad\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/references/markdown/remark-reference-occurrences.js\":\"93a4c2cd4a3a34ca\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"38dc97ad00fea20a\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/references/markdown/wikilinks/index.js\":\"379beeba79461176\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"1068919a855c236e\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"fc55486e98cf5377\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/references/mergeRetargetProcessor.js\":\"43b1ad62a35fd6f7\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/references/parseFence.js\":\"ff191e78f23987f2\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/references/referenceParser.js\":\"dc217289b3044e73\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/references/referenceProjection.js\":\"02189fed20ed796d\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/references/referencesProcessor.js\":\"8633e93ed4b710ff\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/references/renameProcessor.js\":\"5049e0a960f01e76\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/references/spanReplacement.js\":\"9faac78e0eedcd6b\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/rich-paste/htmlToOutline.js\":\"d850d31abe085b22\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/rich-paste/index.js\":\"1447798ad5f6a470\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/rich-paste/normalizeClipboardDom.js\":\"a84a2c9b224ab279\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/rich-paste/pasteDecision.js\":\"9cdc6fcb29923f55\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/roam-import/action.js\":\"00719988760c5e38\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/roam-import/blockIds.js\":\"29b02d6c2616be83\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/roam-import/content.js\":\"7ca1f889c4aa653c\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/roam-import/effect.js\":\"59364cc362d3f740\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/roam-import/ids.js\":\"14262f86246efc36\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/roam-import/import.js\":\"5a9da2f342421924\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/roam-import/index.js\":\"cd67163b40c70ea9\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/roam-import/plan.js\":\"4fe6f4095b769b23\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/roam-import/plugin.js\":\"64f5e052c2c955fe\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/roam-import/promotion.js\":\"7d323ccad115da2d\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/roam-import/properties.js\":\"8a30d3bacc9a23d1\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/roam-import/references.js\":\"20cf48d4f71912ec\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/roam-import/report.js\":\"0e76b509e9937471\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/roam-import/roamMemo.js\":\"d7be9259f724d972\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/roam-import/runtime.js\":\"c2e5c2d579e8cfd2\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/roam-import/schemaReconciliation.js\":\"a3acdd44bed4bb55\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/roam-import/srsMarkers.js\":\"c41fcfaaf9c77528\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/roam-import/todo.js\":\"7702838990f85259\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/roam-import/typeCandidates.js\":\"fa36a52836d74c18\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/roam-import/types.js\":\"a4743e2fb6af1ecf\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/search-health/index.js\":\"8558c0afa9aafdf7\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/search-health/store.js\":\"38fcd6d6f5931b50\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/shortcut-help/HeaderItem.js\":\"745ce18a4290e147\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"19e417c6c3a43ccf\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/shortcut-help/index.js\":\"d53f4e584235ed18\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/shortcut-help/model.js\":\"0468824d069c379f\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/shortcut-help/toggleStore.js\":\"df3ef043b1d32578\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/shortcut-help/useKeyInspector.js\":\"d8b538b2f72f92b5\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"4cb9730ed169caa1\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/spatial-navigation/ShellDecorator.js\":\"d7ea12c6f88c6a48\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/spatial-navigation/actions.js\":\"b8f7fa9bb11e87af\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/spatial-navigation/exclusionsFacet.js\":\"cca0aa94560d1c39\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/spatial-navigation/index.js\":\"71c8c1fdf9349bd0\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/spatial-navigation/shell.js\":\"c48a3fd6c3f9ec89\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/spatial-navigation/surface.js\":\"ed78faa703b5a768\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/spatial-navigation/walker.js\":\"9d569232fecaa98e\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/srs-rescheduling/RescheduleToast.js\":\"e13762ae0b715b59\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/srs-rescheduling/dataExtension.js\":\"0e831836bdded7d7\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/srs-rescheduling/index.js\":\"a0be9b8c589eb694\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/srs-rescheduling/indicator.js\":\"b41c4d0ec0e4421b\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/srs-rescheduling/moveSrsState.js\":\"57ca939cbde9046a\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"c36848312b7c361a\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/srs-rescheduling/scheduler.js\":\"963b14e937fb94a5\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/srs-rescheduling/schema.js\":\"40b2e4ba6591f1f6\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"a801db0b6ac79b5b\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/srs-rescheduling/srsClipboard.js\":\"04c26c1ffff230d0\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"39190e789a47e89e\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/srs-review/DailyNoteReviewHint.js\":\"fbea73886d457294\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/srs-review/DeckPicker.js\":\"66d0a6d3a8da9a0f\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/srs-review/ReviewControls.js\":\"59a8319d014b4922\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/srs-review/ReviewDeckRenderer.js\":\"17677f17088923eb\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/srs-review/ReviewSession.js\":\"f7752c2f199c68ae\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/srs-review/actions.js\":\"ca7b6bb84f253aff\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/srs-review/archive.js\":\"b4285fabe1cb0654\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/srs-review/dataExtension.js\":\"fa0a8c198a0df347\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/srs-review/deck.js\":\"2166bc0cd364aaeb\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/srs-review/dueQuery.js\":\"a4d779483713c665\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/srs-review/gradeDecision.js\":\"99b27e99881b87e0\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/srs-review/index.js\":\"383bdad41a4db420\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/srs-review/keyHints.js\":\"f37d9e00f7c1f579\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/srs-review/reviewCardLayout.js\":\"1a236a74fbfc26e3\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/srs-review/reviewProgress.js\":\"b24ff8c548992a23\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/srs-review/schema.js\":\"a8988149f1fe64b7\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/srs-review/useDueCards.js\":\"4be2e06fe65287c2\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/startup-metrics/index.js\":\"16c80950914897de\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/startup-metrics/record.js\":\"f8106b74946e17da\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/storage-persistence/index.js\":\"31c5a08864e3b76e\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/storage-persistence/persistenceStatus.js\":\"480f1d8d19eb40db\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/storage-persistence/requestAction.js\":\"584f10ab7322d06c\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/supertags/TypeChipsDecorator.js\":\"3b5500391e4a0d77\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/supertags/codeMirrorExtensions.js\":\"7d15d85de7da6111\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/supertags/index.js\":\"d3208c6a063c722d\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/supertags/typeAutocomplete.js\":\"34c81735c64be239\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"13f3dc77c6a7f3d5\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/swipe-quick-actions/actions.js\":\"652ef7bfa1afc170\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/swipe-quick-actions/anchor.js\":\"e4f73cac181f4e2f\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/swipe-quick-actions/events.js\":\"e4403ec69bd499bd\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/swipe-quick-actions/gestureActions.js\":\"6d75845349a91880\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/swipe-quick-actions/index.js\":\"26ee20251aaa01ef\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"174add723be59680\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/sync-metrics/collect.js\":\"28d385fa065efdb7\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/sync-metrics/index.js\":\"254d4029e220ab6b\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/sync-metrics/record.js\":\"0f48316bbf8fd7bb\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/system-status/RejectionDialog.js\":\"c2345e5af7ae3504\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/system-status/SystemStatusHeaderItem.js\":\"551947aa44e25c4a\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/system-status/index.js\":\"ea7857d2d1d547d2\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/system-status/model.js\":\"c7b9291df8ef2825\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/system-status/queueCounts.js\":\"2fb42f854e475476\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/system-status/rejectedHelpers.js\":\"97318f5c6e7098bf\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/system-status/rematerializeAction.js\":\"cdb4fba05f78ad6d\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/system-status/useHysteresis.js\":\"2fc19645dee6f937\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/tables/ColumnHeaders.js\":\"912fccdec3096b39\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/tables/QueryUi.js\":\"fb9054f2e672494e\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/tables/TableLayout.js\":\"4b4768ade0e2a8fc\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/tables/actions.js\":\"2d726e67c2ed6102\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/tables/cellEdits.js\":\"8dda71b44d4dd360\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/tables/childrenViews.js\":\"bcbb381ff060a597\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/tables/columns.js\":\"319a1cebd555854a\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/tables/controller.js\":\"440c3eb88b819b24\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/tables/convert.js\":\"7f2cc1772405bfc7\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/tables/dataExtension.js\":\"8c404765c6fc45da\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/tables/index.js\":\"3e1066388bb79aa5\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/tables/keys.js\":\"1f102162869ca2b3\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/tables/model.js\":\"1aa3d833f7d91ffd\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/tables/query/QueryText.js\":\"dff6d42b296cc02f\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/tables/query/backfill.js\":\"4e21484b10d28bf2\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/tables/query/completion.js\":\"5e11d72ce0d2581b\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/tables/query/format.js\":\"32f21e15464a933c\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/tables/query/parse.js\":\"54ed70569a0dd62f\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/tables/query/queryValue.js\":\"a18ca6ef9749557a\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/tables/query/registrations.js\":\"5a5d7a1f94e60838\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/tables/query/source.js\":\"683a395f797be840\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/tables/registry.js\":\"282425f78755eec8\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/tables/rowGutter.js\":\"75726ec78c5562e5\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/tables/rowVerbs.js\":\"ea6611c82560d58c\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/tables/schema.js\":\"e0e5255711c65cdd\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/tables/sort.js\":\"3736c1daafbac296\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/theme-toggle/effect.js\":\"736235de6fce5183\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/theme-toggle/index.js\":\"3a1b0ca77f0ab70f\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/theme-toggle/theme.js\":\"c5e78d872aea570f\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/todo/actions.js\":\"78acb86395c5e983\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/todo/dataExtension.js\":\"3b28fb1cc0218e38\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/todo/index.js\":\"9cc51dc75c038d0f\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/todo/schema.js\":\"70f15cda1ce9bfda\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/touch-selection/TouchSelectionLayer.js\":\"dd3209ce8d2e121a\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/touch-selection/actions.js\":\"14df635b80128f31\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/touch-selection/defaultItems.js\":\"44e1fa901c4fc242\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/touch-selection/facet.js\":\"30a991f087dd20b4\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/touch-selection/holdRecognizer.js\":\"2aa74495c7542781\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/touch-selection/index.js\":\"223228cae31a02e8\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/update-indicator/UpdateIndicator.js\":\"04d77eb1b999b65c\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/update-indicator/index.js\":\"a3eeb265a23ae6aa\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/update-indicator/loadTimes.js\":\"369604098fcbfd84\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/video-player/VideoNotesRenderer.js\":\"77f8f3dbf33b4f6d\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/video-player/VideoPlayerRenderer.js\":\"fd6477546b19c33a\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/video-player/VideoTimeStamp.js\":\"b31fed8199534094\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/video-player/actions.js\":\"851d8a787d5eb104\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/video-player/index.js\":\"d6016645a4874daa\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/video-player/markdown.js\":\"51922a0e69c80422\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/video-player/notes.js\":\"83a766e1c3ae1699\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/video-player/registry.js\":\"1faaf8c730751f13\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/video-player/remark-timestamps.js\":\"257694340b5ce4f5\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/video-player/view.js\":\"56ffa3f594b32705\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/vim-link-hints/LinkHints.js\":\"1ac595120f0f8274\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/vim-link-hints/index.js\":\"5515f39597230501\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/vim-link-hints/model.js\":\"41ed42bc6434bd6f\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/vim-link-hints/settings.js\":\"c705b5e4ac04ba98\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/vim-normal-mode/actions.js\":\"4be712022e5658b2\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/vim-normal-mode/index.js\":\"9b4af6573e48e3b9\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/vim-normal-mode/interactions.js\":\"e4e4df3c2f1f913d\",\"/knowledge-medium/pr-preview/pr-1927/src/plugins/workspace-header/index.js\":\"29d3b1292dde8a20\",\"/knowledge-medium/pr-preview/pr-1927/src/registerServiceWorker.js\":\"08a48fef665c72a7\",\"/knowledge-medium/pr-preview/pr-1927/src/requestPersistentStorage.js\":\"abe742d984f3b929\",\"/knowledge-medium/pr-preview/pr-1927/src/services/authRequestDeadline.js\":\"3971fb8076480aed\",\"/knowledge-medium/pr-preview/pr-1927/src/services/authStorage.js\":\"8e41247c2d89d574\",\"/knowledge-medium/pr-preview/pr-1927/src/services/powersync.js\":\"2d4e91f218f19d1a\",\"/knowledge-medium/pr-preview/pr-1927/src/services/supabase.js\":\"147c6c4054dba70e\",\"/knowledge-medium/pr-preview/pr-1927/src/services/uploadErrorClassifier.js\":\"2afe3be79c876b53\",\"/knowledge-medium/pr-preview/pr-1927/src/shortcuts/ActiveContexts.js\":\"00ee331f55da6008\",\"/knowledge-medium/pr-preview/pr-1927/src/shortcuts/HotkeyReconciler.js\":\"4adbb97df54e6d22\",\"/knowledge-medium/pr-preview/pr-1927/src/shortcuts/WipeLocalDataDialog.js\":\"6127ed1e03a7c867\",\"/knowledge-medium/pr-preview/pr-1927/src/shortcuts/actionDispatch.js\":\"f3eb8a1e94a1371a\",\"/knowledge-medium/pr-preview/pr-1927/src/shortcuts/actionKeyHints.js\":\"6b20e81971b2ba32\",\"/knowledge-medium/pr-preview/pr-1927/src/shortcuts/actionRefItems.js\":\"0a5e5ba5b6ec0059\",\"/knowledge-medium/pr-preview/pr-1927/src/shortcuts/applyKeybindingOverrides.js\":\"b1b224029af7ebae\",\"/knowledge-medium/pr-preview/pr-1927/src/shortcuts/blockActions.js\":\"adc5ba6767134c69\",\"/knowledge-medium/pr-preview/pr-1927/src/shortcuts/blockMergeGesture.js\":\"ce105b17b6941be3\",\"/knowledge-medium/pr-preview/pr-1927/src/shortcuts/canonicalizeChord.js\":\"fd906886481fbe06\",\"/knowledge-medium/pr-preview/pr-1927/src/shortcuts/defaultContexts.js\":\"1fcedb001e468b3e\",\"/knowledge-medium/pr-preview/pr-1927/src/shortcuts/defaultShortcuts.js\":\"854a84859ee4ee1b\",\"/knowledge-medium/pr-preview/pr-1927/src/shortcuts/effectiveActions.js\":\"a8241d7cc1f52c44\",\"/knowledge-medium/pr-preview/pr-1927/src/shortcuts/formatChord.js\":\"d00504a7ffc53536\",\"/knowledge-medium/pr-preview/pr-1927/src/shortcuts/gestureAction.js\":\"cfe0880201c24608\",\"/knowledge-medium/pr-preview/pr-1927/src/shortcuts/gestureBinding.js\":\"458764c2da4af78a\",\"/knowledge-medium/pr-preview/pr-1927/src/shortcuts/holdRegistry.js\":\"4faa8a39334b0a34\",\"/knowledge-medium/pr-preview/pr-1927/src/shortcuts/keybindingConflicts.js\":\"0b09cec0785b642f\",\"/knowledge-medium/pr-preview/pr-1927/src/shortcuts/keybindingOverrides.js\":\"505d1b7998e38c39\",\"/knowledge-medium/pr-preview/pr-1927/src/shortcuts/pointerAction.js\":\"73f6bb080f8cbbb5\",\"/knowledge-medium/pr-preview/pr-1927/src/shortcuts/resolve.js\":\"d1a14c7b2e450dea\",\"/knowledge-medium/pr-preview/pr-1927/src/shortcuts/runAction.js\":\"3a666196044a4c22\",\"/knowledge-medium/pr-preview/pr-1927/src/shortcuts/sequenceMatcher.js\":\"9eeae03920d4a3ae\",\"/knowledge-medium/pr-preview/pr-1927/src/shortcuts/types.js\":\"68aa323bd8a1624f\",\"/knowledge-medium/pr-preview/pr-1927/src/shortcuts/useActionContext.js\":\"c17cfd1e2142681e\",\"/knowledge-medium/pr-preview/pr-1927/src/shortcuts/useActionDiscovery.js\":\"11aeee658e833f42\",\"/knowledge-medium/pr-preview/pr-1927/src/shortcuts/utils.js\":\"919cfafffc396820\",\"/knowledge-medium/pr-preview/pr-1927/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1927/src/sw/bootStore.js\":\"c81894f48fe156c4\",\"/knowledge-medium/pr-preview/pr-1927/src/sw/previewDatabases.js\":\"26eebf486f485cb9\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/byteTransform.js\":\"d095607b29d7e41c\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/conversion/attachmentCleaner.js\":\"e52d7cd9abbddd81\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/conversion/bundle/attachmentParts.js\":\"bca21be14bdb8a44\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/conversion/bundle/bundleParts.js\":\"12bda3a3e406ef6f\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/conversion/bundle/bundleRecord.js\":\"11186040cd34402e\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/conversion/bundle/manifest.js\":\"bdc4ecaa79f9cf24\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/conversion/bundle/takeBundle.js\":\"0d7d2f138004cc1e\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/conversion/bundle/verifyBundle.js\":\"d20e245f2dd78dbb\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/conversion/cleaningStage.js\":\"f372545e2fd60fd1\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/conversion/conversionKey.js\":\"2753e5457fa0a146\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/conversion/conversionServer.js\":\"ad53aa618971f0d9\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/conversion/flip.js\":\"6c8b4c0bb1e81cb1\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/conversion/flipAttempts.js\":\"6a29b6b9cd498cf4\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/conversion/pages.js\":\"1ab22ba1526550ce\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/conversion/preflight.js\":\"773976be5792c4e6\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/conversion/reseal.js\":\"8326cd7a89b3dea2\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/conversion/runConversion.js\":\"e29aa251adffeb0b\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/conversion/runLock.js\":\"9599cf81c9eb51f3\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/conversion/sealing.js\":\"29434ebf5217a63b\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/conversion/sealingStage.js\":\"e70d516a770b62c8\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/conversion/stage.js\":\"49ededbe4a989e91\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/conversion/verifyReseal.js\":\"683e3d64997a32ec\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/crypto/aad.js\":\"e82914c7fee7dafa\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/crypto/aead.js\":\"7c7f0128a1e7cbb0\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/crypto/base32.js\":\"891c1be5fdd7c05b\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/crypto/base64url.js\":\"76b2ff5d557ef6fa\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/crypto/binaryEnvelope.js\":\"94599ee36feaf980\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/crypto/byteAead.js\":\"9f1428e6786a3ead\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/crypto/canary.js\":\"1f1a9f556c39678e\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/crypto/contentHash.js\":\"4ac46355b1c89c6b\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/crypto/contentKey.js\":\"9a4b028a1369372c\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/crypto/derivedIdNamespace.js\":\"58737fd53a6896a0\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/crypto/envelope.js\":\"ba41bf5c8fb0c29e\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/crypto/hex.js\":\"463c04dd9a355552\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/crypto/sha256Hex.js\":\"6de746d4d0e2e139\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/crypto/workspaceKey.js\":\"86f427250fcd1af7\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/keys/conversionState.js\":\"80aa383bc4ca7fb4\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/keys/flows/createEncryptedWorkspace.js\":\"6d1eef1d28b9aa4e\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/keys/flows/pastedKey.js\":\"9e4857a56b3002c2\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"33013203b280567e\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/keys/flows/upgradeWorkspacePin.js\":\"94345410288632da\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/keys/keyStore.js\":\"d3dacff1bf0de337\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/keys/mintWorkspaceKey.js\":\"9a7bcc0b7ee65bac\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/keys/modePin.js\":\"6ad802f780542a9b\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/keys/openWorkspaceKeys.js\":\"7ba600d14de56a7d\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/keys/resolveWorkspaceEntry.js\":\"ef5937764ce8a7b1\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/keys/resolver.js\":\"30e01330c93fe789\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/keys/workspaceAccess.js\":\"517181e36d4bcace\",\"/knowledge-medium/pr-preview/pr-1927/src/sync/transform.js\":\"4ceaff6f2117b8df\",\"/knowledge-medium/pr-preview/pr-1927/src/themeBootDefaults.js\":\"da12dd5a6a94b0df\",\"/knowledge-medium/pr-preview/pr-1927/src/types.js\":\"062e085da95df624\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/ClientLocalSettings.js\":\"108ee3db8ad20bea\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/abortableSleep.js\":\"5f20be8fb2184201\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/array.js\":\"50effd9b291d0669\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/backlinkAutocomplete.js\":\"a75ee6a1ca35ac72\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/blockCrumbs.js\":\"c9a6a20707c521a6\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/blockrefAutocomplete.js\":\"adab71d1dcf02bf3\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/cadencedIdleJob.js\":\"8da67381fc24b07d\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/callbackSet.js\":\"b156c15b74904c99\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/clientId.js\":\"54590ac63d07572c\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/codemirror.js\":\"b501a5478b7d6ba9\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/codemirrorCompletion.js\":\"d772c7be09c9795c\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/copy.js\":\"a810b2a22075cf68\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/dailyPage.js\":\"651ac798bcbb9692\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/dbForensics.js\":\"06dccdef824006ab\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/dbForensicsHooks.js\":\"5782891d913e384e\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/deleteBlockThroughUi.js\":\"06dac7617fc21f12\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/dialogs.js\":\"15c5fc3e4c04a56d\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/dom.js\":\"07db57600e7ad531\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/downloadBlob.js\":\"878f4e371f3da691\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/drawnWalk.js\":\"bc95136764ffe39b\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/exportSqliteDb.js\":\"140204970fad0ab2\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/fileSystemAccess.js\":\"69e0248acd764a96\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/flipSlide.js\":\"b9346661d2f633ab\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/fnv1a.js\":\"67b2be793f79313c\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/formatBytes.js\":\"2544b5e604bd30bf\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/fuzzyRank.js\":\"c94bfa058990ce6e\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/idbKeyedStore.js\":\"852970f81d2386fe\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/idleCallbackPolyfill.js\":\"ae5a9451ea4fffdc\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/keyboardAwareScroll.js\":\"762f676cf8ffaf4d\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/keyboardViewport.js\":\"bba0a1f45274dcb1\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/lastWorkspace.js\":\"d54b19c567e65b75\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/layoutColumns.js\":\"aa23f046f21193ad\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/layoutSessionDom.js\":\"0bcaf9267d69a399\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/layoutSessionId.js\":\"665f370ca292a486\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/linkClickGestures.js\":\"aabb22b0d2b7f36b\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/linkTargetAutocomplete.js\":\"d265302bab77f9b5\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/localDbCorruption.js\":\"141a115d1dcd5be5\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/localDbRecovery.js\":\"4ed61341678df5a8\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/markdownParser.js\":\"3e1ea2fc103c352a\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/memoize.js\":\"6040f5a16e169544\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/nameFieldCommit.js\":\"1492766f9f9e985a\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/nameList.js\":\"126048d4c92a73e9\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/navigation.js\":\"bdcf53479e84d4e2\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/omnilinerNamespace.js\":\"4ecb5de31a0b55d3\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/opfsPageScan.js\":\"f42e669bdd8db5f5\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/panelClearance.js\":\"24d5d4750944decb\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/panelHistory.js\":\"c3589b8bd6fee24c\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/panelLanes.js\":\"5e2aebd3a84b45b8\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/panelLayoutProjection.js\":\"5953f97111f9c8c8\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/panelScrollAnchor.js\":\"841034811a49ef55\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/panelUrlFlags.js\":\"a48421edd0982d2c\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/platform.js\":\"e3d93cfd05e31fa2\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/pluralize.js\":\"ccee931041bcd5d2\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/propertyCreation.js\":\"dbb726ca1715e602\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/propertyNavigation.js\":\"af55cae2ec9aafa7\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/propertyValueContext.js\":\"deef97712f7dd68a\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/react.js\":\"ee49601c82b1118d\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/relativeDate.js\":\"8675e95b4b66af92\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/relativeTime.js\":\"7338275b4fbf12f3\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/renderScope.js\":\"dd9cc3d14809d526\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/resolvedThenable.js\":\"55d4e45ba7868c69\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/routing.js\":\"cf6cea02b4b24cab\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/safeMode.js\":\"2e83b03fb129551d\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/scheduleIdle.js\":\"e0e5a0451f405e98\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/screenWakeLock.js\":\"410c529b92bae652\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/selection.js\":\"1fabdf3dd80be99a\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/softKeyboardGrab.js\":\"e079127c0dd311b8\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/startupTimeline.js\":\"29facd2c82a12bdd\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/state.js\":\"f03e703bf257c128\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/string.js\":\"e5643e956c6bab6b\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/surfaceZoom.js\":\"94ac44a9c3b6ec77\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/time.js\":\"94eb18158ad24852\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/toast.js\":\"31352e7336a7bba1\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/toggleStore.js\":\"edeeb16871a4d843\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/untilStopped.js\":\"55b6733eacdf2e14\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/userActivity.js\":\"dc51078a089d7dfd\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/viewTransition.js\":\"07d982afb3af84be\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/viewport.js\":\"a9ed401fc80ae6c3\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/webLock.js\":\"ed24fdc5b4115b30\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/workspaceRecovery.js\":\"89791138cb5b2aad\",\"/knowledge-medium/pr-preview/pr-1927/src/utils/workspaceSnapshotStore.js\":\"cf6cc925c5d7cfc0\",\"/knowledge-medium/pr-preview/pr-1927/src/vendor/react-compiler-runtime.js\":\"ccbcd5694bf1fa57\",\"/knowledge-medium/pr-preview/pr-1927/src/vendor/react-dom-client.js\":\"c7b40e723a71683d\",\"/knowledge-medium/pr-preview/pr-1927/src/vendor/react-dom-server-edge.js\":\"32116184084a5e67\",\"/knowledge-medium/pr-preview/pr-1927/src/vendor/react-dom-server.js\":\"8f894daa9390ebb5\",\"/knowledge-medium/pr-preview/pr-1927/src/vendor/react-dom-static-edge.js\":\"fcbaa3d8e38ce3f5\",\"/knowledge-medium/pr-preview/pr-1927/src/vendor/react-dom-static.js\":\"fdc2f257e9569e91\",\"/knowledge-medium/pr-preview/pr-1927/src/vendor/react-dom-test-utils.js\":\"4a470b8c6f4b3192\",\"/knowledge-medium/pr-preview/pr-1927/src/vendor/react-dom.js\":\"480f2cfbd2434831\",\"/knowledge-medium/pr-preview/pr-1927/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1927/src/vendor/react-jsx-runtime.js\":\"777e601d4e233000\",\"/knowledge-medium/pr-preview/pr-1927/src/vendor/react.js\":\"0a81968933820e46\",\"/knowledge-medium/pr-preview/pr-1927/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1927/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1927/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
