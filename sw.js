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
		buildId: "6a0d1161d450-d9ea59ef",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"696230c9ce77dc2a\",\"/knowledge-medium/index.html\":\"696230c9ce77dc2a\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-D3dCZbad.js\":\"049e4a8dfb5cc71f\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"6c8ead35bd37018c\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-BpvGxOqd.js\":\"422e96006deb6ac7\",\"/knowledge-medium/chunks/FacadeVFS-Dw-01YE6.js\":\"5be8786b437647f8\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-cEnSLRXd.js\":\"7fa5220b909c5f69\",\"/knowledge-medium/chunks/MemoryVFS-BpUFqZYM.js\":\"c1bd0202dcc67713\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-BdYJLdMH.js\":\"aaeafb2c381daf71\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-Dapu6Ze6.js\":\"1d4423d517776ad0\",\"/knowledge-medium/chunks/Preview-CysNADin.js\":\"30ee3ff2a21ed99e\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-TbaeNoSa.js\":\"270ca790be7258e7\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-CrLbplQx.js\":\"90e745e97e2a1bc7\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-BoR8uPFs.js\":\"0e56193da1e4d737\",\"/knowledge-medium/chunks/react-C2w71aIG.js\":\"c8c59ec861c4981d\",\"/knowledge-medium/chunks/react-C4KMF0-p.js\":\"a29a75f7d7d7a9d9\",\"/knowledge-medium/chunks/react-C5PPxVcy.js\":\"90d0b9e404e4c4b7\",\"/knowledge-medium/chunks/react-CBcKVxKh.js\":\"eea2e60b4393bb7c\",\"/knowledge-medium/chunks/react-CZMwCHJQ.js\":\"617b2323f7e53d88\",\"/knowledge-medium/chunks/react-Deg6cq-z.js\":\"8cef192a592446a5\",\"/knowledge-medium/chunks/react-RWXmXigR.js\":\"7e23bb807ec773a9\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-CrSYrAM5.js\":\"5098bebc79a4113a\",\"/knowledge-medium/chunks/react-dom-server.browser.production-oVeVTpjb.js\":\"b7df09ac71e5c536\",\"/knowledge-medium/chunks/react-dom-server.edge.production-BmVyrH6U.js\":\"2f82033ee932ec9c\",\"/knowledge-medium/chunks/server.browser-DDoe9LlI.js\":\"8a4c84ebad2df6ef\",\"/knowledge-medium/chunks/textarea-C6_JUYfK.js\":\"a2776d821215a4e4\",\"/knowledge-medium/chunks/ui-BshbSGeu.js\":\"4b1d84d3b9daeaa2\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"beee77ad31d447d8\",\"/knowledge-medium/src/appUpdate.js\":\"af3f7b9aa075528e\",\"/knowledge-medium/src/appVersion.js\":\"23ae6ea8c233cdc6\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"a21c52eb600c8e8d\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"e11575e704c40379\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"85fff4ea2c2da36d\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"0d2d6a3649c4d4f8\",\"/knowledge-medium/src/components/BlockComponent.js\":\"3edce70953f9f3f0\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"a254fe171c797eb0\",\"/knowledge-medium/src/components/BlockEditor.js\":\"a7e9f162985c7f5c\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"eb9951d99cde4c36\",\"/knowledge-medium/src/components/BlockProperties.js\":\"daca45a6199772f6\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"6987f36b0f5f2544\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"ffe89591d7ef93fe\",\"/knowledge-medium/src/components/DividerHandle.js\":\"3e9c28dd5c2009e0\",\"/knowledge-medium/src/components/DraftEditor.js\":\"488f279e263052f2\",\"/knowledge-medium/src/components/GutterPill.js\":\"20539958e8929daf\",\"/knowledge-medium/src/components/Header.js\":\"c1ed805a6859a830\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"b16038cda0898943\",\"/knowledge-medium/src/components/Login.js\":\"6301cfc511361356\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"b9460f1bd98e2469\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"71a087649dcb1034\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"06067ae0cb1d08a8\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"4da1b2832c12b2a2\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"96f719fe51dd0092\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"3f5b9df9342c0962\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"1c4ecf4fd5a70d29\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"c844957ed328d5bc\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"cc62e2d5dd3e592d\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"1420698576abfefb\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"dea04716ac17be96\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"464493855f674bd8\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"705757b064913f9b\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"5955b2cf8911b676\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"36cde48dca107892\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"565842dc0bc76096\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"4b130474d4679c44\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"079891b87d11dac3\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"8bbe134648c47e7d\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"991c7a8a84435eee\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"677032db2eef8ba0\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"3f0338adfb179aa7\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"acd04fb01f8b6651\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"6dc8de5b19b38c52\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"4e6f8156785fc171\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"6a78efe31f357795\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"7138c06b1bbaa520\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"44c2fcc9ee994e07\",\"/knowledge-medium/src/components/references/CompactReferenceLink.js\":\"7ecd0c0be2c6e446\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"902c06f9ae971ff3\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"b7bcf96e7ea3f6cd\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"993f1b5913401674\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"24637dad3525a564\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"fe50c67b062128ef\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"a4ba8e8224c55efb\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"87943f4ff295cd7c\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"ba05808d3cca9c2b\",\"/knowledge-medium/src/components/renderer/BlockReadText.js\":\"15326783f2b6dd7f\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"0532cc2b289f053d\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"426f62ad8f5aee37\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"c051dba064f743ae\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"b45a9cc764303c93\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"f0c60a53b3c8bbd6\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"ba192b19a6b7fc68\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"0e90a31af8801246\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"d893fa39942dfa9f\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"220b530f5d6da5d7\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"0a2c0611a8b70c79\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"c4e6b63b80e1a145\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"85db639edd9d4ba7\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"1f99b9aa3bff8c83\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"314fc6ce270c93c9\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"aa398d28b96686d0\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"8793d517fc9fcb5a\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"0f548cec098e2056\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"1fd78cce0264cd40\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"47aab6a1b78b2065\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"6ac905aab1fdf91d\",\"/knowledge-medium/src/components/ui/button.js\":\"ab7a78b175bcf180\",\"/knowledge-medium/src/components/ui/card.js\":\"595b2739987058cd\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"4c4e87f5c03847ac\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"a38beda84053c0d0\",\"/knowledge-medium/src/components/ui/command.js\":\"ee05e082fc74be5f\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"5701714c56d97381\",\"/knowledge-medium/src/components/ui/dialog.js\":\"0b2cc6a9b6acda95\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"2475a0bfa8615127\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"98c2a4bd91c14642\",\"/knowledge-medium/src/components/ui/index.js\":\"ef9a960facbf2bfe\",\"/knowledge-medium/src/components/ui/input.js\":\"6a5a8e8f5a62a7c4\",\"/knowledge-medium/src/components/ui/kbd.js\":\"0b5d8717c4b5887e\",\"/knowledge-medium/src/components/ui/label.js\":\"3bd24e70735a6852\",\"/knowledge-medium/src/components/ui/textarea.js\":\"702a89012a90a899\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"b0eb85c6fbf8a7ca\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"0ed63804218707d5\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"90a0e149a6eb4b51\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"b01f7d6ddd75d1da\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"9a1e4ecbd3a828d5\",\"/knowledge-medium/src/components/util/error.js\":\"94ed9afa6712dd44\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"95f96d7d7a61bee0\",\"/knowledge-medium/src/components/util/suspense.js\":\"ad8007930b115358\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"4d14266129d22025\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"668c12c91c785b31\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"1c15628a1277b9c6\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"7227f78c3ec5925e\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"e7108bd3d1fdf602\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"64aaf8b8de603da7\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"915d451fbda49637\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"dda6851a64dbda44\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"009ba610d73af168\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"d3b7fe53ac33f44d\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"ba510fc1397db6e0\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"5d07bf7a98996249\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"302b01eeedf222bb\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"78955ad598b57910\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"aea644ee966b1ecd\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"4df513ac65a1b346\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"87e505a30c512217\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"0ffe896684c0cbb1\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"8c02661a016bb2b3\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"4ce96b4650f47d1a\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"39ee62bec4316e77\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"def69abdd9c8b85f\",\"/knowledge-medium/src/context/block.js\":\"1fdbddaf308bb056\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"78971a9bab1e11ff\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"30b44d570662098a\",\"/knowledge-medium/src/context/repo.js\":\"e609682f19b07b89\",\"/knowledge-medium/src/data/aliasClaim.js\":\"fe3645d40f24b905\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"26ee25015eda8052\",\"/knowledge-medium/src/data/api/blockData.js\":\"4b5008b4220ec905\",\"/knowledge-medium/src/data/api/blockType.js\":\"afd594f40943e7a2\",\"/knowledge-medium/src/data/api/changeScope.js\":\"436e7696fc378a16\",\"/knowledge-medium/src/data/api/codecs.js\":\"8246991d07d872d1\",\"/knowledge-medium/src/data/api/derivedData.js\":\"54df1cf03ac3090e\",\"/knowledge-medium/src/data/api/errors.js\":\"dd3143e8477d05fc\",\"/knowledge-medium/src/data/api/events.js\":\"e50e404295f8094b\",\"/knowledge-medium/src/data/api/handle.js\":\"1dc94c26560b3fea\",\"/knowledge-medium/src/data/api/index.js\":\"60c03453f4661b53\",\"/knowledge-medium/src/data/api/mutator.js\":\"8255601b25cdf023\",\"/knowledge-medium/src/data/api/processor.js\":\"fad960a6681c8100\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"8755aa865d8646c1\",\"/knowledge-medium/src/data/api/query.js\":\"793fed67ad488308\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"376935b126551b9b\",\"/knowledge-medium/src/data/api/schema.js\":\"1dc94c26560b3fea\",\"/knowledge-medium/src/data/api/tx.js\":\"1dc94c26560b3fea\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"57d62e715643a602\",\"/knowledge-medium/src/data/api/user.js\":\"b7b1a4ad9bf48e92\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"b1c4b3b3add98025\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"b3979d707aed9c6f\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"90b14e5d555f57c9\",\"/knowledge-medium/src/data/block.js\":\"f8ddfea9eb7169d1\",\"/knowledge-medium/src/data/blockCache.js\":\"63062a6670bed408\",\"/knowledge-medium/src/data/blockId.js\":\"c005d152d7ee422d\",\"/knowledge-medium/src/data/blockLiveness.js\":\"bf52571c27f95958\",\"/knowledge-medium/src/data/blockMerge.js\":\"cc969948fd329959\",\"/knowledge-medium/src/data/blockSchema.js\":\"a815ca6df503a7da\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"da24c2d2821674a1\",\"/knowledge-medium/src/data/blockTypes.js\":\"ac6dc24b29c4c727\",\"/knowledge-medium/src/data/childrenView.js\":\"fac0ce19032e54a5\",\"/knowledge-medium/src/data/clientContext.js\":\"04325bb8257bb98c\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"b1e555cd6c0b51f8\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"d3b88dab0987b120\",\"/knowledge-medium/src/data/derivedIds.js\":\"21b53608e125a5fc\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"ba5e2468ac8c883b\",\"/knowledge-medium/src/data/facetBridge.js\":\"29bce7ad5a318efc\",\"/knowledge-medium/src/data/facets.js\":\"b6273bf98ff92fef\",\"/knowledge-medium/src/data/globalState.js\":\"d6613af3c4c3e9b3\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"64d0ba61e3a34ca5\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"92a897bebfed21c4\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"32215ef3bf272cc8\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"43a7b0fa043dcf4f\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"65f8b9cfd77e8f78\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"a3a04d7025bccb6b\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"f8f8ccf11a0fff1e\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"69b2dd4f90d656d1\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"f33a7fd59138bf94\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"98a6a0f39e109e79\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"5a3b1be0eb9c32ec\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"c6c53583187de766\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"469863114c5149ba\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"9c959539bcca9689\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"8c56af5387721da0\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"04064cb7d06c81f1\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"30949e007c932daf\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"02d5dc125f8b514b\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"51f3ef75cffee3bd\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"4150a2567efe08e1\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"c3157359018028c3\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"b1c7d480603dad92\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"002f1462a66fcd55\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"a9c312c71b04509a\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"04f10274d89c9598\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"94539b28da71f435\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"b2cacc8f2d3acb6c\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"88f63d20c2e22d0a\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"b600c1196fd3ad13\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"5c9e1f89561bc134\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"19465848830770b3\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"f47e8b5613fcfef7\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"078db95ab2758311\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"c6817eeb6809f312\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"6329f6acff518a88\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"5fb5d9149f12af70\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"f280bee975d0b39e\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"1eb8f1d165414604\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"5bb8508737380ecd\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"0de3367410cfbb82\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"fb8c2596351c1fba\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"653c77a9a1473657\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"2726d7bf05ac8103\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"c2a5af5f5feb19a0\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"d7770bb04197321e\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"143e2924d8673883\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"04f8f76a267e5027\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"cc61ba7d890536db\",\"/knowledge-medium/src/data/invalidation.js\":\"c51321b5320f6507\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"df346d60bd6fc20d\",\"/knowledge-medium/src/data/kernelPage.js\":\"69514d640cb251e6\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"c3ac2efeee98277c\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"3a45fafe76924914\",\"/knowledge-medium/src/data/localDbStorage.js\":\"b72b33124d5259b9\",\"/knowledge-medium/src/data/localDbVfs.js\":\"64b8a06d1e57dd9f\",\"/knowledge-medium/src/data/localSchema.js\":\"62e2d6f7f9e71a67\",\"/knowledge-medium/src/data/maintenance.js\":\"cbafaafd5026a2ac\",\"/knowledge-medium/src/data/mergeProperties.js\":\"faa98b9fba8e108f\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"e40ea3e9cc1437d4\",\"/knowledge-medium/src/data/migrationsPage.js\":\"f5d74528d7988c4d\",\"/knowledge-medium/src/data/mutators.js\":\"51b6a93b67d6edf8\",\"/knowledge-medium/src/data/orderKey.js\":\"9ea71d15c5f39c25\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"cffb1437a406d46b\",\"/knowledge-medium/src/data/outlineSurface.js\":\"cb2bf0b0a44b9e87\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"dd77c471416744f2\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"64edfc204838ebb2\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"005a5bc0c6a3672e\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"145eae759ba79ba4\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"50f7f04a032019a0\",\"/knowledge-medium/src/data/properties.js\":\"5ae58f29473ae065\",\"/knowledge-medium/src/data/propertiesPage.js\":\"2e9128a333299d54\",\"/knowledge-medium/src/data/propertyChildren.js\":\"4f053ae364c8c9c7\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"2b5cf98c7e8c2dd1\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"81c7fe3c4744b151\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"edf3148ab71eecf6\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"4cbed46b8d315676\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"76a45569405528d0\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"a5dd5d669ae433c8\",\"/knowledge-medium/src/data/propertySeeds.js\":\"85217851d6128791\",\"/knowledge-medium/src/data/recentsPage.js\":\"03bc1edd5f6df3a1\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"813d51c539f83124\",\"/knowledge-medium/src/data/referenceBlock.js\":\"62eba738162eff85\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"5f7af3dde02e06ba\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"d3059c33fc6bc716\",\"/knowledge-medium/src/data/repo.js\":\"5217e6ec0ee69216\",\"/knowledge-medium/src/data/repoProvider.js\":\"123a380f61695a35\",\"/knowledge-medium/src/data/rowProperty.js\":\"2bc6bee64414c61f\",\"/knowledge-medium/src/data/searchFilter.js\":\"92d4ed66fd16b115\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"879a5b009a5ad5db\",\"/knowledge-medium/src/data/stateBlocks.js\":\"6c644ef94f2de149\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"1aabffb8b650c3e9\",\"/knowledge-medium/src/data/structuralInsert.js\":\"f0ab2e75f12c2aac\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"11a7c6b6699447c5\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"8e58d8a6c6e9e240\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"29e868d2e434904a\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"6c8d3a7e476774ed\",\"/knowledge-medium/src/data/targets.js\":\"3fcecde4466d5a3c\",\"/knowledge-medium/src/data/typeColors.js\":\"8e9df2094e59bd9a\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"324c8d912ed1a6bd\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"b9c215b07c9f36be\",\"/knowledge-medium/src/data/typeExtraction.js\":\"5311344d014d8c98\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"248da2f911c55d04\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"f550c64923f9399d\",\"/knowledge-medium/src/data/typeSeeds.js\":\"c5bf429ccc07eee0\",\"/knowledge-medium/src/data/typeTagger.js\":\"eb05084678e01d88\",\"/knowledge-medium/src/data/typedRecords.js\":\"b4521e5111a6034e\",\"/knowledge-medium/src/data/typesPage.js\":\"206c66fcb7d83e4d\",\"/knowledge-medium/src/data/userPrefs.js\":\"400b44f47c2694e9\",\"/knowledge-medium/src/data/userSchemasService.js\":\"19c9e79eba84ae5d\",\"/knowledge-medium/src/data/userTypesService.js\":\"9e3bc4dae3ed0c44\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"974186be294079c2\",\"/knowledge-medium/src/data/visibleChildren.js\":\"20560befb28bc2bb\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"6b90432955126927\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"a970b9bd91daf672\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"e089e98de5989da7\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"e203385604d837e2\",\"/knowledge-medium/src/data/workspaces.js\":\"c9bef68e9a3c56aa\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"6858eb34925b6866\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"c73017e169f5fdd3\",\"/knowledge-medium/src/editor/atTrigger.js\":\"9cf32c4bd87ed883\",\"/knowledge-medium/src/editor/autocomplete.js\":\"6a1d01f2906d9e8d\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"c406f47a148d3a65\",\"/knowledge-medium/src/editor/contentFlush.js\":\"5d8c681e69ce1547\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"2a795c2083fdf97f\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"4ecd31918b0a6fb8\",\"/knowledge-medium/src/editor/insertImage.js\":\"52ca5c6fcc5abde5\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"fdac090d832a68a8\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"a728207cdc9e10bf\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"50436d715e624387\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"02fabaec8aad8b3c\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"40158f951957e1e2\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"f343a1a17899f74a\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"f7c06ba33818c298\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"268380af122cd91a\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"09cb8482dcb463e5\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"ec2c37aba4f1686d\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"5d874ead96a919e2\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"7a020169db402d5a\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"95714393b4e8d239\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"dd5f9b5aaae50960\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"4adb0cdfe4e0431c\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"4eddabc3bb61b0c4\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"8ec9e4a6b79f9f85\",\"/knowledge-medium/src/extensions/core.js\":\"a2c065e298ca95db\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"5077d1ed43769a98\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"ff756a2e2cb58cba\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"821bfbd8ba87fcae\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"cec0a4c53a75c842\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"6ed1235f5e78f408\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"6c5faa37d9623d0d\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"21162aac919a8ec6\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"178b9a0f9410ead5\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"4d91514afd6a0b4a\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"55197f5ec16baab8\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"4c7d7bef4f354dc7\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"8b375a22eacc5a74\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"c883fecd031cd5d8\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"6742c4d6d5d9bc6a\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"4832d03f6e9f6eca\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"a02f33d4226dbe0b\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"2c01523def010d74\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"c3c3b27d310f1e76\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"ec6d50d215029732\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"be3a488ae72548ad\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"4d40a76bb0a42f9c\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"dc2e9bba45ebe8bd\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"8ae50faedaf36332\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"23b0b5296e2bcca1\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"59f22e5f5ed84db8\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"99911c4ba42b89bd\",\"/knowledge-medium/src/facets/facet.js\":\"b8233b77335671d5\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"66b4afabbb995e82\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"5a1a49907317db70\",\"/knowledge-medium/src/facets/togglable.js\":\"c5dffd79a2c7a90b\",\"/knowledge-medium/src/facets/variantFacet.js\":\"4b010900d5f5c731\",\"/knowledge-medium/src/facets/verbFacet.js\":\"f8233057bea6aa08\",\"/knowledge-medium/src/hooks/block.js\":\"9289b89fc80bb20b\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"eb83916787ff5c3d\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"47fc5939dd356f6f\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"19337f76251cdec4\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"c9c6abaa3d6bfa49\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"45976a6bf0f54258\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"6dbad1223cfd169d\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"073f4aaca56f5fe4\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"7bfcf1c819aea320\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"0bcffe242061583a\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"92a078010876cff6\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"82ab557d3bd634c2\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"28b0f7f0f0086e17\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"450545457aac240a\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"fff9afff21bcde30\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"fb3813f0c7a836f1\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"c85fd94c3a48217e\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"7489f64d023d281e\",\"/knowledge-medium/src/lib/utils.js\":\"4bf59c67b5fd1b67\",\"/knowledge-medium/src/main.js\":\"a3aa00d34259f4ff\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"828e2b95ae9fac90\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"b09aa155c125ce6a\",\"/knowledge-medium/src/markdown/context.js\":\"6724985c04a2166a\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"2bd44a7bbdf4311d\",\"/knowledge-medium/src/markdown/extensions.js\":\"e55ee1783bcfcaa6\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"43096510e47800a0\",\"/knowledge-medium/src/minimal-editor.js\":\"99f0b11b00d003a6\",\"/knowledge-medium/src/paste/armedCut.js\":\"0fd3a200920184fe\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"30be0f59163b7f15\",\"/knowledge-medium/src/paste/clipboard.js\":\"47bd6b4ca913a857\",\"/knowledge-medium/src/paste/decision.js\":\"d9d05437875e7578\",\"/knowledge-medium/src/paste/operations.js\":\"1dac15dacfe095a4\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"ee680ab24703c688\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"00379419b5e5f852\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"56f88bae1378af77\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"a79dd81fcf709e8b\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"68008d6b5a41b755\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"0cc7a92d58c11367\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"b910fdf466943a82\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"2644f8fb61b92e17\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"753daa0046d7ed40\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"624eb397dcc6d4bc\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"ad030d110b4dbd7a\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"3c2d82868afec3d3\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"067ddfe1aecf28ea\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"5de5d60b6ca87fb1\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"f93a603954c6d07b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"22ac16a5ad17560e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"8f3ef6e52e6319aa\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"c5fdcc3ce6cf6a97\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"1e18f4c6848a8b88\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"6668613aae4ec9d9\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"ef5059a23a217b2b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"22a39b3d62b3a073\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"39555f219c8cdecb\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"0c91609d6d9c8084\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"d367aefc0d92d681\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"a734645a495e6096\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"d679e8018195cb7e\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"51083606ce40f2be\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"ab0ee7e98e0bcba8\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"c8c7931badabb7ed\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"6f43237e96aba274\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"66ec9dcdb72dd2b1\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"8a75ba4aa2fe8cdc\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"a209cfeef4b2ed99\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"52756a95927e5ced\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"3eacc987b719bb14\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"75a29bc9178ff061\",\"/knowledge-medium/src/plugins/agent-runtime/dayPropertyInputs.js\":\"46aec1e7770c455c\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"906366ef6e2bdd4e\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"b5eb4081ce054c29\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"7f9bb7bcd93bffb7\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"ce90330829853077\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"a524cdfd34e8f0d3\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"3494146c957ef7d3\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"a2b58dd367725418\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"91525a980d3d0423\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"b72caa6a8c80de2a\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"f282d16a372cac4e\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"173edaa4f50add07\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"a8528b9b3abf1a70\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"370ff59f1389e44c\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"b8fa535a07325851\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"4eb2fbe816047f90\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"0aa2d47d5e79cca0\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"5622142ddfba306a\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"5da03878c5d1c417\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"d50e9da5e9e6794d\",\"/knowledge-medium/src/plugins/alias/index.js\":\"3f5546a579b26526\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"334f1b76c73ac00b\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"324f069ad3b78f9f\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"bdc0000fc45b76fe\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"93e27a8e0c2f034b\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"e871e70dd9c85761\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"66e9750edaf46847\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"fdf2d3f7b726ab7e\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"7271c131b3394c6c\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"31a581814d6775a5\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"147918df61e7c56c\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"5377f27d96cee95f\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"3d060063bf83f1a7\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"aed3bab50048e7b4\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"f9ee8b68586175e7\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"0e877273e638b89d\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"be97946e88361ffb\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"c974a2e24b832a08\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"dd20456676b2af04\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"447b04e79b318243\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"dc0635c79e944824\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"f913eada3a028d1d\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"72ddb7883fcdae4a\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"b93b95cf2a11a13c\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"766cd3c373aa8b8e\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"df6596f40f746cd2\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"f22951dafd65412f\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"6fed81ceeff7608b\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"62bf5136493ef56a\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"cee4aa0867fc281e\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"cb4ae8fc19148500\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"5828fae6559c7e04\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"d1e6f3dbb723cdf0\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"534aecf8b41af553\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"2d435b5dc9188390\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"0fcd09427cd997d8\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"ba37a1c6324da341\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"c0f8f810cb8c4d00\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"2c5bd5c2c0a0c858\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"aa57939aaa33242f\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"47dd2e4ee09b8c2c\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"6d4b11174296d17f\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"b295b3461880cc82\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"5ea36098c5f26a72\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"6753118602e6fe61\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"969cbf84664a74fa\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"e539a94409c9b893\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"592ba9719f49f8fb\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"5e8946bf57ab12af\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"120a0e2950e44fa8\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"e7a44e63e4e9d360\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"e198a8e38be3efb5\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"2b9fe4de9609b2b1\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"a84c187ef5cf708b\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"288f975cdff77eaf\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"221d12f1d52985f3\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"0dc07cc15b866bff\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"625ab9a0ae44d513\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"b07650adb12be1b8\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"f56c4f0e0f6a8339\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"dce3640de2bb77f5\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"11f04413c4acce7f\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"d9a433fec0df6f48\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"2b4004fe55a17fde\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"9855f949ce90d016\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"a4bacb42f30ef8ee\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"32f75f5dea22e962\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"5bda0ccd4a38bd5c\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"f15b9b589acc30a4\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"a41728016acf6cd8\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"2d8eb73cc5f16a5e\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"1deff67ef36c3ca0\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"3dd6c0cd7f843a48\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"d3de5e3333fa2416\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"395ee79e8c160324\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"0cec543e0946e0ea\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"1992f2e323c92d67\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"12afec4d110013cf\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"52c17885c058f2d6\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"139d492845a54db3\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"6864920da48dfabf\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"7a98f154ad85bfc8\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"c5a82d60e9cc6855\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"fff3f04300b7aad9\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"c43c897b278943a1\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"37efb2fabfc40883\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"334f84fa1a1ff86b\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"2246646c5bf8206c\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"be688e08d400f838\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"07a35ad65302b18a\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"41b0c69ce6fa7501\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"8e7cf7472acdd654\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"678242eef6f1d6a9\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"bf67521a5149d6cb\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"76a884ae03be4c06\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"cd3d694f3181ceaa\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"a8cf457b333fca97\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"757a8fe42520aa59\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"61658b984b6a9adf\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"303e7717da1d710f\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"b2a352c1576e6660\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"c3abc0bbb05abcb0\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"1f339f6d1e91902e\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"731f0b3102bcca0b\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"837fa2b2cffdf309\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"9dab5cff11361aba\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"ee98716b12b10a0a\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"a244b45c7c372676\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"eb8e3c59fce18bf9\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"30d0f2271d88181e\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"080b1ebcf49b37a0\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"cf1ae882959024f4\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"3e40b83dfc4e49da\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"aba31b74ca1892b2\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"7f60a6d776936c59\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"51997c51204b769f\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"43706dcd82475e52\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"0dd4121abdc6fe38\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"df7a75ca43c0b1e6\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"0f87f5135d21b9f5\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"ea4adfc194751507\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"c7a4d6bd4c1242e6\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"f0e3b600cca5d56b\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"ba6871b8364d8e77\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"7d9843e63e5ba3c6\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"38f3dc51bec78db0\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"4ea609eafde06113\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"608d5d7db32665a4\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"620790c08deeb617\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"38bf2c57575a5ddd\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"b3ae27539bd1644d\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"a43aa18e961d6780\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"04de7f21884572c5\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"8e3cba1b46eb9aac\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"953f6e73a6de4d83\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"e853feb9bb3e997b\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"7a87b7f0e67fe5f6\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"23515523f2fd4888\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"af49ce39098e5536\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"6d4d454330c72196\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"81479accb3c54f72\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"fa0b28c94b27af00\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"0c00d76d1ff4d94f\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"90bf072460977b75\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"2074f32dc10ee2cc\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"2e0569f38178e633\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"dafb07a53256fbb8\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"ef165075ceac4322\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"320229cce36c690f\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"d2cb6eb0883641b1\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"74395cd9677929a2\",\"/knowledge-medium/src/plugins/character-counter/subtree.js\":\"a3f04ab86aee524b\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"27e0604255b75e57\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"bf93edf67c85851d\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"6f7aea82d4db754e\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"4a953977e6bb5042\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"73eda25922318bc2\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"83428d013afa5f4c\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"c44e39cfe2092d5d\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"941321b6453992b8\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"e99699f1dc727746\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"e697b63c5c9e2559\",\"/knowledge-medium/src/plugins/contributors/ProfilePicture.js\":\"94b614cc3ed69516\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"e9f77559686fcb1c\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"33811acbd940a9bb\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"c7b122f9a070b007\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"3a303b51294e7ee5\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"a81a3100bf6d23fb\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"6d4b944f51006f66\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"19a88f86351cc58a\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"4105a7d3f742383f\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"490c15b44611a9bb\",\"/knowledge-medium/src/plugins/contributors/useCommentAuthor.js\":\"b9fb134bed10ba3b\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"802bb8dd75e1d14d\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"07d04323aa2a8a34\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"0ccbd14c0a4d3049\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"112d8ff3dce83a60\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"08e7a866f339a482\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"4c7d836987dedeb3\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"017d62969da2977e\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"04f8b8107e64381c\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"8c00b86174eff87c\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"26d4239624554eec\",\"/knowledge-medium/src/plugins/daily-notes/DayPropertyControl.js\":\"94a60c2396e51903\",\"/knowledge-medium/src/plugins/daily-notes/DayValueReferenceControl.js\":\"4d590e8bcc1e745e\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"43bf67280b69d92b\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"2784e0417c3fb6c1\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"938ab340d0dc816b\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"a0085d4479aa88f0\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"4441f915d9ed62e4\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"ff3e322bee2b9c31\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"42ad4a590c521617\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"d7628b0e5a6a5003\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"2e35bbd339e56af2\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"9043257029a6eefe\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"26b049888792e94b\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"9c94bbbc6abec051\",\"/knowledge-medium/src/plugins/daily-notes/dayProperty.js\":\"2cfee4a2d48063c3\",\"/knowledge-medium/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"abaafd565b652d1f\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"355c1947271e2a69\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"710310a132ef848a\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"d5bf10615c273dad\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"defb2f6e2e353fb8\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"c41d1fc6a6b18f24\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"52dd6fe2b048ebaa\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"be3ba00028748af0\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"40d88aaa611899dc\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"737c19a8d8cf3745\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"fd907ca1ea1c9f64\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"94e50b6c34b22158\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"09250d36abd7a4a2\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"df6a40ad9ab08685\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"bcd1281979eefed8\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"ce5d0470901dc522\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"97070c90976124b2\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"8c00fd5f1cc37c70\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"f8cd70968d92e7dc\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"e78e2d294bbc0590\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"11bf8e116fdf7a06\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"342d9609bd0acd62\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"ea43ff55c311c6f8\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"6e9fb04e859e4278\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"23fb02264cf32190\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"408fb888c3d4e63d\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"0810012bc1b08e2e\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"705b298db56737cc\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"71eb4850af0d3d9a\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"ea41f0fe24824baf\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"b475412968db1b41\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"cc9d41cc61259243\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"4b83dedd293232c9\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"dca7d30a8595bde4\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"1e7477f34da78774\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"4c79a17b05debadf\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"8dc908e24d1c8e7f\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"ce25d061dcc5a5d9\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"873c03a2e9adfa93\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"22f6d700d10ac71f\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"9de3c6437f2a5861\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"fc149395ebb4cc25\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"a10e0f7087ba1173\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"dd2d602a33fd9b16\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"525582ae16fb9303\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"b86149c5181379a1\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"e6f4cd5359117987\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"35f6c4955fa9bbd0\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"ccca3da0172ee34f\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"d0e71987763e9b57\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"31d7731614833f15\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"c846060759d73d16\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"f4913459652e8449\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"94e0638da17457fa\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"58370aff8fc2bd63\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"09c654c00e032e62\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"b00483dcf31eadfc\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"e6a2ba400b009cbb\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"d2d9a91d59cd0d97\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"42b914b31b60e0cc\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"b0cd80f284f2fe03\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"b51e022f331bcd3d\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"deef7896513afc53\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"c4e2bfeb4b287b45\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"f66c08d101d310b8\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"8b64ed0d2822208d\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"8cb8e28aab524991\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"5f78b9926735a51d\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"c1996f14823d61d9\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"c17e39bdc5cc4bc6\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"08aacec96ca89475\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"987fff9dfa2db972\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"8b58b39a78d2947c\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"6fb68395549caf68\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"64b41482eb3ee3e5\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"f2b909659ca41ee1\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"cf211c1ef6ad44c3\",\"/knowledge-medium/src/plugins/geo/index.js\":\"61e262480dd28b25\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"d47e63897050774e\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"000a06fa1b595620\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"8f163e407bd989c5\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"5aa76fbe750d8dd5\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"08b0ddf6a2917c58\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"14a7e23e90792b46\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"0edfa22653d4fbbe\",\"/knowledge-medium/src/plugins/geo/query.js\":\"8bd17165c07f7fa9\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"02721f67aaea3239\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"94d4603a3fc5076f\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"61a085ac8709975f\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"016a3b67b99021fd\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"62dc084a6c225d69\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"246b8d5cb364fedd\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"886a226c4211d894\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"ce98feaf605c35c1\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"4f41726c64450a3d\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"5cb77761bac41af3\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"d9391eb0135afcff\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"79d8023dda69ac88\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"63ae141fc8d4d9d6\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"163470c63b51c586\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"f09e5a3ce05e50fe\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"6cdc9ecd45b18077\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"3cbd1ac29bd506ca\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"b279e04d92833aa6\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"838f192e1b6d5a04\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"8b8b33192fa032da\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"948d26de050e26a2\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"333aa60f3e4164f2\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"2b94d5913b0e5241\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"55dee7de0d5de4fa\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"4653a48d745d797b\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"40120554815a87f0\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"e56692796d71588e\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"7e38bd0a4aac0c49\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"e5814b120f6a7d0e\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"7d7c1dbe1e159892\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"0ffddc019ba8adcb\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"e15980514c970122\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"a19f1c092e30243b\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"c7b9f5f5b95039b6\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"1af54d8986605399\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"14334282b148b2cb\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"4c9fba3a93f38539\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"399a6e65f7b923d2\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"e376d44477cb9d93\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"d795a55e7bd95667\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"5aa58b623a06fa98\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"da5d7bacfb7b9869\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"9ebe4d59555a4cbe\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"78b61990b8ab8a51\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"00a5590a718ce23c\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"f4a8330527a46402\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"bd78d1e3cebdf867\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"4a9d86456af8e8ee\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"a678c6cbbf8bb9ab\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"2d5c79bdf16efc8d\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"0c8fa49eaeb77102\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"59ac15c4638c5aee\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"13ca4b1a7e1925f9\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"4281aab966adbaa1\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"85ea09b51e0b17d7\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"3ba8faebd2f1cd5e\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"96de7d7102bac455\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"0db55f041c7a2d68\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"f063bb9447c5330b\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"901cf9f2dfddf4ae\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"fba3534e0353471b\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"95335dc35cb4a433\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"a1cea4227c68b0f1\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"e03c8797c2ef2b02\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"753d1c8a3e9f2b2f\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"c201bbc61a795e75\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"cc4ce92a82c1b422\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"806c2fcfe177b71d\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"ae7dff46f6009994\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"f7b48c167628054a\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"b9584098b663488c\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"23a556dd726d9cb8\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"63cfa5d41d411a8b\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"bc08fc4709e8d381\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"128eeaaf3e54fc43\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"8e09249476c32df0\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"7e963ba0d14b4c90\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"d3e2f82f3c2ef0fc\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"8cbf8e3fc3f3149e\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"d459a24715b47fe4\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"80dcd0014f4c05e8\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"53fcf9430c7f35f0\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"cbd9047f98af5a37\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"e4603f5e5ca2e52f\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"53ed9bdd8b4ac4b2\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"af77ede43869c9c0\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"d2d5308e6b753d73\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"b52518f6d40a4d2f\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"616e90618e4d8173\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"27f8bb84b03f8c61\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"725e0123c9c14b24\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"34c265523acf3cc9\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"ae84e1311bc47cc9\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"df1579a205ca4e63\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"010a89f05204eccd\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"1efc701628a0253d\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"74fc4f90dd3b78fb\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"a76012a003f7fdc9\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"e16f18d82bd88c8e\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"850a3eb776ef2cca\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"8f79fdaa85f4a0e0\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"92d83839976cf99e\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"8c5472d9c5222b62\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"ccbf63961b8a5243\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"bad0b9051d19fc2a\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"e3b36acb084d04fc\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"c212c4a7680d4960\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"d7f9188cc083c739\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"457ffe92697bc379\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"a83b2b8a3a5af23a\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"fa5fa42800330b8a\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"ebbe94454daead89\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"8cc87681bff4f32c\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"14fe5ff5cdb7fe24\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"93410f3ddfe78fe9\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"4dbe049322155a45\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"312cb4959410ff26\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"9519a5cd0f344ad8\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"4b8f98729783cfc4\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"73d8a791a690b4ef\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"f0d50bf8f5e20df3\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"1996106199cb19a2\",\"/knowledge-medium/src/plugins/recents/index.js\":\"d88c0e4144872065\",\"/knowledge-medium/src/plugins/recents/target.js\":\"a087b0c0c9c6ed11\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"e5582515c56da11d\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"625ca9144e18233f\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"08d9413d22f6b0a7\",\"/knowledge-medium/src/plugins/references/index.js\":\"bd65fb5eb00e7a35\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"50e9ebc83c9cff82\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"881587762fc8e00e\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"7c33e8818bf8a44b\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"6d4551266ebf4f64\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"a1c0b82102d4eca3\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"79ec9a67ff854e7a\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"cc879e909e045f43\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"7722535d4ddb2613\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"71a25a0021c3cc00\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"776b472a0695d677\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"6b66f09b097c016a\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"f14ce2ad7f0edbea\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"0d8ecda2650703a3\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"6f3ff9d1837e01c0\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"520f8af01f2bb1e9\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"e705b19fe9cfb41d\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"942a42fe45f22332\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"c54baf686376ab2b\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"5d25911183437aad\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"30391d675784bab0\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"7e2d7cf6acb47022\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"e84d231a499ff5e8\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"491ea77b563fc318\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"8c1cde6bd350de66\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"3665eb85a36ee047\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"c0f45aeaf7d0c765\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"7f97d6bbbda76f6c\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"fc72989264a85135\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"0b8db21c1ecad285\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"a808cbb39b47d939\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"134dfe41b20e3152\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"963b68e8b2af8479\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"182973eb0ea39b56\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"eeb875021d90764c\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"d582c70dd70b67fd\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"4d81550cc4b33eb2\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"d2266bcba3a3beab\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"9ca2f648154534be\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"16887ee58e83cec9\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"23225dea96efe20d\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"5b60d060b35e0448\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"1732d4e7a2d67925\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"9b83be584c87b8c7\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"a16684a1dcb8d9f6\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"21919cdca3ee5691\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"a6faa45290ff024d\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"c90b9d3ea1508527\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"8ffd2b9c833d0ff3\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"b1934e89f269adef\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"fcea9c1f2904f844\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"62bcbad10de32e30\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"50c1df133e049983\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"6c044b2854c57f08\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"22f8ad786fea2a8a\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"8ef21bc308b2c32c\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"16effcb18c2179ed\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"102dd31ce1c1a710\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"ba92cd83fd4cb5ac\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"bd8d5f510de43e83\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"ac0619f8efb036bf\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"821b3ec2b3eb65e4\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"117af951bcf04244\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"1c2907ec1666e0cb\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"a9e1ff994644e01e\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"97e5103ecbd8c69a\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"e8833faa5106745a\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"8e38b555128ae1fe\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"fd086f148bee81b9\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"5372cb5d4a543ee0\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"6a248afe302d438f\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"e46c468d6d5ca307\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"212691e2ad7375d3\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"31463451d851accc\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"dd803394759c95cc\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"11593f22b322d841\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"5f946618df95680a\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"7fb4b7a75763dafa\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"730d4034c1c54c8c\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"d278f16e843b4f2d\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"e771d9aa5ae61ec1\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"289153d159279fa5\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"39d64f281a957709\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"2dd3e3e002502287\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"6ac4890e76a8d995\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"4c32d836b9b2a4b3\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"0bbd5a9ef2c6cb44\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"05b4e37652a391f7\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"82bfa454a1e323c5\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"77c348a64cd075f5\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"22ab134893bb22e4\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"12b8a234ab006f46\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"780885c9c0be7b6a\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"da80f76423b57d48\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"c0b09f959afd690f\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"651e8b3cdaaad2dd\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"34d72a55fe5bad4c\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"3b2125bda43c8040\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"2d8163b6ff0840b3\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"34f6a1e8197e1561\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"d99d747a3d2da98e\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"99c952d074a5ab06\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"91e0f66aff0f1faf\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"5fc3d8eb1c256908\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"f513dc279bb7da9b\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"6669bd34dfb5ae6a\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"978ab03d32729533\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"85bbbc30831fb8c5\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"db202b9a2a6b7b3d\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"9714e1c2af971ada\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"cd5bd3474ab2f86a\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"0c4df7995c443849\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"00b119bf231550ce\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"a0b521ec4be07085\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"85264c8ef598c0bc\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"ac048dc23340781a\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"0c0b53f96bc76e02\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"a4e51b97b9224838\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"50705859755ed8ae\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"3d4aa31e1f448ca1\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"987728c6522b6c1b\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"b698373e9db8dd61\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"701ca2b85c7b62d3\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"26531474c2f2396f\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"93bcc59a2b339005\",\"/knowledge-medium/src/plugins/tables/index.js\":\"9791ecc5277f2e3b\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"d63cd9f57bda3d92\",\"/knowledge-medium/src/plugins/tables/model.js\":\"d772a2ca91a92e5e\",\"/knowledge-medium/src/plugins/tables/query/QueryText.js\":\"a745e8565afbb065\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"afa33dd869154603\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"ecf27ea343227d08\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"91c805f7bb7b3e4f\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"9b6b3f8384c79cd7\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"6b027f7498c8907f\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"d2df130506cb49c1\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"65fe0b5eee9651e3\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"e31206bc8c26697c\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"744b564ae16e7918\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"8cbdd4b611aa0ccb\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"4dda2787a59469d7\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"55cef5d651eb7d73\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"264336b5016b74f5\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"724670416d75e3b4\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"51787e407597637b\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"0353f1f038be16c6\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"f54a960ce29b9afe\",\"/knowledge-medium/src/plugins/todo/index.js\":\"83caaa38ef4c493f\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"b64c3a48c7851790\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"4f18eefb168fe3a5\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"0c4f8675f952c70b\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"5ac9927eaf125ce2\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"a662d9eaf4becc57\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"0b726abd9f49a4ea\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"d703e821eb6c0bff\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"cb65d5cbf6d68a41\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"b70b5e7a8780e4b1\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"66dcb74f9eccf83e\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"cf447ceb385a1b96\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"e3094376dd505ba0\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"4b621d18261f2fb8\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"88b0163eae0e2b02\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"2f44424d26293151\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"78ef8c16799b2c91\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"df783023ac25f690\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"7ca66bef29374b36\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"8e11192b7760fa70\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"ee6ddc01d3371bca\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"3db0250b24f5074c\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"7897e9e464149b15\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"250fbd22392f3678\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"caa421f830941105\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"46b446d10c945071\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"bdf91621be2f47e5\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"8f350dd722693dd2\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"490a0f2e1735825d\",\"/knowledge-medium/src/registerServiceWorker.js\":\"33043f6c4f557d35\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"b0a90d2c38e9f6a2\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"734beb8008f88727\",\"/knowledge-medium/src/services/authStorage.js\":\"b59680e2d4587a68\",\"/knowledge-medium/src/services/powersync.js\":\"13fe8a6ea54f4a50\",\"/knowledge-medium/src/services/supabase.js\":\"731231cecda900da\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"e67222c936333af4\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"0d50e6b7e68b11ae\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"6aef9bf4876f34f3\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"0cb6c095af5119e5\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"5a647bb5d5c00089\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"5624c607f2bd2646\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"3ea77eef212b38e5\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"af1db8d81c75f529\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"4767d9621f187e31\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"e434104fc7c52343\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"0cdb9f239c8cea35\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"7953f06416f904f9\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"ddf5e078f9f8e0d1\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"600c9ca7e4d11729\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"0db4468a77ab4b1c\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"b0920dad9005c7aa\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"44b93407c1e8e91c\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"1c0312ee54db0a04\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"0288e82b5f2f493e\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"19c50768c61db421\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"7935dcecbce6756c\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"023c4da9f2038533\",\"/knowledge-medium/src/shortcuts/types.js\":\"2b4686a3af863e9f\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"975be949c6e86a36\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"cbe7434144e2457b\",\"/knowledge-medium/src/shortcuts/utils.js\":\"30819a072e0d2997\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"482992b62c222cde\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"a3b0524255f9d341\",\"/knowledge-medium/src/sync/byteTransform.js\":\"0d136d60d5a0977e\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"9740a0d94f859dfb\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"a1f80b8c2c7d197f\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"932237df73ecbc0e\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"08eb9279122978f6\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"f83dc266c9c5a654\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"a7de9788701383b4\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"95eb61816da96786\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"6244d79f29f66fb7\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"0346ebb4204a2043\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"501e22dd125c8f18\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"ee26f15069d7fae6\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"b30e61dd2b2b0988\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"249e74cad6381d19\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"f6e5ef24b4970a75\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"7106a79bf08b9e3a\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"8a525436016b2181\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"efcea5bc2c2aa35d\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"2526c8212101108c\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"37ea6497ce7ee766\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"e3fac05239590699\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"9d701fb281b59b87\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"2a0ff3726b5ba88a\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"eb31646218ec1d06\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"abc2b8d7c8075139\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"d0d33fd0fc50f48e\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"67a02c3ad58b954b\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"b63bbdef4dc5fa99\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"b1f204eb20f7023a\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"773a318a8b7aab98\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"e348f2e666e560d3\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"0cae3c899f6e54e8\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"002957f123c4022d\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"85cb32e387de9bf3\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"21285b2f475d7f6b\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"848c373cc1053a51\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"a1da075341565d4c\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"3afd582f96d95b10\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"06c7d447aafc41e0\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"bdec45a5dd525602\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"9734af54835da861\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"8e853e0deeaf7fba\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"7f0194d57b7b7f1f\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"677b894b5ef6f729\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"1007fffd62cf3c04\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"d763f2be554ced77\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"f6ae3220c5b83aca\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"c481fb7bcdfaba5f\",\"/knowledge-medium/src/sync/transform.js\":\"f5d1246500d99c9a\",\"/knowledge-medium/src/themeBootDefaults.js\":\"8eae98b83400ef6d\",\"/knowledge-medium/src/types.js\":\"ab4bc75be4c01b9f\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"80586c6740a5a9d1\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"e2ffeda1547dc74e\",\"/knowledge-medium/src/utils/array.js\":\"8d6c85e3a3084ce4\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"a211fffb6ce05036\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"6dd23b8d7352f49b\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"ff41b7cd1470453f\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"4bbde63253c7e2b9\",\"/knowledge-medium/src/utils/callbackSet.js\":\"e24bb68cec013466\",\"/knowledge-medium/src/utils/clientId.js\":\"60b7a817d245b3ba\",\"/knowledge-medium/src/utils/codemirror.js\":\"69d719fe71405230\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"95dd08ac7af624c1\",\"/knowledge-medium/src/utils/copy.js\":\"60c78321b7d3c87d\",\"/knowledge-medium/src/utils/dailyPage.js\":\"4d2acdd042acc4dc\",\"/knowledge-medium/src/utils/dbForensics.js\":\"6ced0cc9fe5b254e\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"f413a1a24afd45cf\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"21ec5f6430b86101\",\"/knowledge-medium/src/utils/dialogs.js\":\"e232af78cb2ee6aa\",\"/knowledge-medium/src/utils/dom.js\":\"407251e5f3a75b29\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"ad0e8cb280b436e8\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"a52351ddda4e86d2\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"b16e084abbb027d2\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"46e4d89d85ba460e\",\"/knowledge-medium/src/utils/flipSlide.js\":\"1a832571ddbf9049\",\"/knowledge-medium/src/utils/fnv1a.js\":\"1fc04e9bbce6c825\",\"/knowledge-medium/src/utils/formatBytes.js\":\"c4e89885aab5f943\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"b84b7f25cd53422c\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"acbccff99c729f9f\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"330bc688b3c00bc7\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"4ee03556479f7152\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"0f6644133985670e\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"de25bd4cea53ac42\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"c0ee14a908b622cc\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"69304e9eb99afe7e\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"6914da97e81ee53f\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"dff8c0c665f89663\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"26be3e06887796b1\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"d1cbe3687e47c552\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"124ccecb15ba58c8\",\"/knowledge-medium/src/utils/markdownParser.js\":\"94951bf2690d328b\",\"/knowledge-medium/src/utils/memoize.js\":\"83c984477f45f4c0\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"d9bb45db05346902\",\"/knowledge-medium/src/utils/nameList.js\":\"4a3a871f3c2f0861\",\"/knowledge-medium/src/utils/navigation.js\":\"1414a47103c173e7\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"514cdc7be1c35f0f\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"da8d922b17474d59\",\"/knowledge-medium/src/utils/panelClearance.js\":\"6aa51ad2ad4d0ab1\",\"/knowledge-medium/src/utils/panelHistory.js\":\"0508a93c90fe97c2\",\"/knowledge-medium/src/utils/panelLanes.js\":\"e7155ce522f2b948\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"ee8b0ad004e40ac4\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"e6a43d22360006f9\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"991117e7a66d3229\",\"/knowledge-medium/src/utils/platform.js\":\"635a1b523b6868f4\",\"/knowledge-medium/src/utils/pluralize.js\":\"21feb757ea3954ed\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"c7627d0a41a5f29d\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"5cdae11c4c81ad4e\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"ebe0e6fa33d31421\",\"/knowledge-medium/src/utils/react.js\":\"44e8222a929289e3\",\"/knowledge-medium/src/utils/relativeDate.js\":\"88e34dd7b4ef5364\",\"/knowledge-medium/src/utils/relativeTime.js\":\"a82122252e67826b\",\"/knowledge-medium/src/utils/renderScope.js\":\"6e4cd309f5899eb7\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"e34e50250b614b2c\",\"/knowledge-medium/src/utils/routing.js\":\"a6c8501f68c69319\",\"/knowledge-medium/src/utils/safeMode.js\":\"253c261361609e6c\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"a76c82d51c5ade88\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"7016c2438e096504\",\"/knowledge-medium/src/utils/selection.js\":\"e448a42cadd97e5e\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"8fdf76a72845c4cf\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"fcfd6b9d1d1b2a8b\",\"/knowledge-medium/src/utils/state.js\":\"dc4f2b18e9f97392\",\"/knowledge-medium/src/utils/string.js\":\"c3cc1a8caa976825\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"ee26c881268956e9\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"1e432f9224d3d9c4\",\"/knowledge-medium/src/utils/toast.js\":\"65dbc340ab62de0d\",\"/knowledge-medium/src/utils/toggleStore.js\":\"5ffbf4e07e7341aa\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"d95a781d4ffbddfb\",\"/knowledge-medium/src/utils/userActivity.js\":\"699f56f0989333f2\",\"/knowledge-medium/src/utils/viewTransition.js\":\"5bcac121d746189d\",\"/knowledge-medium/src/utils/viewport.js\":\"da748d4c50b6ca8f\",\"/knowledge-medium/src/utils/webLock.js\":\"19c2bf4d8a3b69aa\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"81b7a38d214bd515\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"0117b7585e156640\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"4a573dc10108e9fe\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"46f55979a1c44b38\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"852a46d7001116bb\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"935468cb399dad75\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"1e0c7751a94e26bf\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"42484e8dced6cd9b\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"a4ab60de266485ce\",\"/knowledge-medium/src/vendor/react-dom.js\":\"480aca0c8458ca66\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"941eb53784fcebb8\",\"/knowledge-medium/src/vendor/react.js\":\"46e57e291d6e7f5f\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
