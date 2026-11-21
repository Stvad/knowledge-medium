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
		buildId: "afef2bf2b485-cd38af1b",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"5793c5e6afab1e86\",\"/knowledge-medium/index.html\":\"5793c5e6afab1e86\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-bdLp_rkC.js\":\"7a1d2935cb90baae\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"08de89ed670f4729\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-CLdvq8be.js\":\"001dc738d288f670\",\"/knowledge-medium/chunks/FacadeVFS-7amL-xzw.js\":\"fb42777e469ca30c\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-DppxiASR.js\":\"cf166b7923ce085a\",\"/knowledge-medium/chunks/MemoryVFS-BIJfHR_f.js\":\"d720f28ba10414d2\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-B8cebtxY.js\":\"8019cd4251bc3495\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-Dx8v3ZJQ.js\":\"67f50ae5e39dfe70\",\"/knowledge-medium/chunks/Preview-K1aj4Dpi.js\":\"8828dcfa8e24c072\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-_yrK-NMq.js\":\"66fa3da422641f24\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-DVSP7aAu.js\":\"0b867d8a541c8f91\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-BvJChQ9B.js\":\"b327c86664c33c05\",\"/knowledge-medium/chunks/react-CF3GPhKl.js\":\"93a2589167ffa405\",\"/knowledge-medium/chunks/react-Ce1QydiV.js\":\"815cc67ff1a3f105\",\"/knowledge-medium/chunks/react-CwTC7sFB.js\":\"f96d86278e423e21\",\"/knowledge-medium/chunks/react-D1bVBD3b.js\":\"ff4db89f04e43be0\",\"/knowledge-medium/chunks/react-DI0Z18nJ.js\":\"83123a96731dcb4c\",\"/knowledge-medium/chunks/react-DPDeQkqi.js\":\"c98cacd9790e4843\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-DNTKL15M.js\":\"29f454031b9bb7ef\",\"/knowledge-medium/chunks/react-dom-server.browser.production-DYUuamsE.js\":\"c026e41c61f13a3d\",\"/knowledge-medium/chunks/react-dom-server.edge.production-DDR2xBkX.js\":\"559632bb38d9f991\",\"/knowledge-medium/chunks/react-xKoOg9WP.js\":\"e63080eec2482c0d\",\"/knowledge-medium/chunks/server.browser-CbfiXQnw.js\":\"914b8bfa217eb590\",\"/knowledge-medium/chunks/textarea-BplUHAS-.js\":\"16b0f8487873a719\",\"/knowledge-medium/chunks/ui-mC9FdRXP.js\":\"4a561be751178e1c\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"58cc680d695b9ce5\",\"/knowledge-medium/src/appUpdate.js\":\"90ffe43d73bd8934\",\"/knowledge-medium/src/appVersion.js\":\"7271e0577f7c2589\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"c63e99127d65d743\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"20275a973cdeee0f\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"63c07997df11f984\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"0f2738ab283c6768\",\"/knowledge-medium/src/components/BlockComponent.js\":\"ca03b8cb8446564c\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"7ccc4658af3fece2\",\"/knowledge-medium/src/components/BlockEditor.js\":\"cf8f60acb8e9146c\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"70211a7daf092d49\",\"/knowledge-medium/src/components/BlockProperties.js\":\"0136e7ef7074b47d\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"3bedb799b767e10a\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"7c4467900f1b7b9f\",\"/knowledge-medium/src/components/DividerHandle.js\":\"cb892fcd7b73fcd8\",\"/knowledge-medium/src/components/DraftEditor.js\":\"294ae1d7307dbe43\",\"/knowledge-medium/src/components/GutterPill.js\":\"da87f0b2950db2f3\",\"/knowledge-medium/src/components/Header.js\":\"a3cf556492a6adc2\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"cf7e31eb51f12187\",\"/knowledge-medium/src/components/Login.js\":\"223d26febf6dbf08\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"6c90666bec19a356\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"98d750be13934e44\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"fa57136fc24fc516\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"83a8200cedbb3e42\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"af2e4cf514167447\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"65b5fd246695a50d\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"e15fcff2fe42b9f9\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"662c95e6c99cb8e9\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"9e177ac5f7beaa94\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"b8d8655cfd020019\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"a1603563a1ca31b3\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"88cebec8d8ff3501\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"9c56222b331b3ca0\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"b07e17ab0987fe54\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"89ed0dd932778a16\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"528044e28e67ed64\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"1fdded5e8346f43d\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"427c00011343d864\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"c9f1fa5f58de9979\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"c596790634ef90a9\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"cd4295cfd4b69e96\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"7c5e217f7ef1770b\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"bd011e1e43bc1877\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"f78985699b660705\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"7866093f24c4fb51\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"3e81553f5eda64be\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"17cd6ce7b7f2fa57\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"58c3ba7a8daef967\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"cd41ca08c6388a46\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"7447e252e7597f02\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"358d44969dfe8844\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"3e71b731972f3974\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"1d8783bba2c6fe2f\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"31cdf7c4226a1f67\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"1499de721ffda8f4\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"a54d6af172af8150\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"cff0c250cf54478a\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"538200ecb13aead7\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"17889c082082311a\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"9f10516a44179add\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"0c360890d2ac8315\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"e613b8f1356ff5c7\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"18b89959429778ad\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"a0d63034c2cca4d2\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"d9fbf7b59ddbd088\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"ced2f6e6832d7984\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"6098db539035ba75\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"dfec03ebb3f5bda2\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"0661c1d537bd952b\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"a117cc4567416118\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"cc1f9bc637282a2a\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"87815b40803b24f3\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"2487c285cdcaaa54\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"4470187ccb14606e\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"fde62dd9e3d147cc\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"0162ab267eb0c541\",\"/knowledge-medium/src/components/ui/button.js\":\"304beaa239491f93\",\"/knowledge-medium/src/components/ui/card.js\":\"52ffdecfe81e9910\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"b4c854bdea057c98\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"4b8a2c9f4b0f11ec\",\"/knowledge-medium/src/components/ui/command.js\":\"7fd6ef15b1481dab\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"497f7b2f8568f4d9\",\"/knowledge-medium/src/components/ui/dialog.js\":\"a98df84333a75baf\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"493cc55be5186196\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"46b8a3dd8cba7587\",\"/knowledge-medium/src/components/ui/index.js\":\"7e06057c8e433330\",\"/knowledge-medium/src/components/ui/input.js\":\"cb0e2400fe2e44b5\",\"/knowledge-medium/src/components/ui/kbd.js\":\"e308cf7df810a739\",\"/knowledge-medium/src/components/ui/label.js\":\"97c6cafeb28e7564\",\"/knowledge-medium/src/components/ui/textarea.js\":\"738be583dddf26ca\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"45c438603b75283e\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"cbe1852d2445b4f7\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"a46f53e2c0105f03\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"399517060c36d0b2\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"7fc6e1164830c32f\",\"/knowledge-medium/src/components/util/error.js\":\"12ceb4a3c6e99271\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"aec67ff94f0d5ac6\",\"/knowledge-medium/src/components/util/suspense.js\":\"d96c33ef9f9c4961\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"ba51ce2f8aca5aba\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"e829c7833cd24870\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"03584b82ead52873\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"562b9dd86f2bd1a9\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"6ffb700782825426\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"c3aa8c4965ef9544\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"c25c32ee39835b3b\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"bc485e658d01f780\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"69639b531a06dc0d\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"729612158b5417d7\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"da9f3e8c64658e3e\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"545369f4993e4447\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"3f5bd57f79fa59a6\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"3f96daec52248a3a\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"134c9e74f4741294\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"1eee4ab93a053b7a\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"7bc2706f55fa9756\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"17bb40baf047b332\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"8645fbe6ce3512b1\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"abf719859da42900\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"6fb1bb7d96b855b8\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"5e2da076df2cfcab\",\"/knowledge-medium/src/context/block.js\":\"1a629ac779259b64\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"49247cc5168ba48e\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"1b86100c17aa6a0c\",\"/knowledge-medium/src/context/repo.js\":\"0cfbac69c5299ea5\",\"/knowledge-medium/src/data/aliasClaim.js\":\"4ecc434959176bdb\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"5f58efc11f1946e5\",\"/knowledge-medium/src/data/api/blockData.js\":\"6e8d6c13a2a0c363\",\"/knowledge-medium/src/data/api/blockType.js\":\"59a71e3ad14ffba7\",\"/knowledge-medium/src/data/api/changeScope.js\":\"b575875d03d7b56c\",\"/knowledge-medium/src/data/api/codecs.js\":\"3ff734f3c8dd0c74\",\"/knowledge-medium/src/data/api/derivedData.js\":\"8aea041b097d8a63\",\"/knowledge-medium/src/data/api/errors.js\":\"8351281ebfacff1c\",\"/knowledge-medium/src/data/api/events.js\":\"bf2e86d605b26bc3\",\"/knowledge-medium/src/data/api/handle.js\":\"677cb6faa84c9578\",\"/knowledge-medium/src/data/api/index.js\":\"2e694cd401b4db0b\",\"/knowledge-medium/src/data/api/mutator.js\":\"8a2453d3444860d0\",\"/knowledge-medium/src/data/api/processor.js\":\"c82aa4fb16f6c5ac\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"586f3305416a9eb3\",\"/knowledge-medium/src/data/api/query.js\":\"ea3eb7ca728d56d7\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"3da143e6205db10d\",\"/knowledge-medium/src/data/api/schema.js\":\"677cb6faa84c9578\",\"/knowledge-medium/src/data/api/tx.js\":\"677cb6faa84c9578\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"9e96c34b6afd7b22\",\"/knowledge-medium/src/data/api/user.js\":\"c978d057ba06ae8e\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"d2d5a93ecc4fc36a\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"04d77f7e4894e1af\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"1dd453f3f2d8872d\",\"/knowledge-medium/src/data/block.js\":\"e6814de1fac9279c\",\"/knowledge-medium/src/data/blockCache.js\":\"953b8074311ad81c\",\"/knowledge-medium/src/data/blockId.js\":\"6256d11a6b2981f1\",\"/knowledge-medium/src/data/blockLiveness.js\":\"2d3349ee069f14b7\",\"/knowledge-medium/src/data/blockMerge.js\":\"e003fa58dde42178\",\"/knowledge-medium/src/data/blockSchema.js\":\"48b85c38e48d0fc0\",\"/knowledge-medium/src/data/blockTypes.js\":\"8ec4490979091448\",\"/knowledge-medium/src/data/clientContext.js\":\"91c143f572266c75\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"9e4b8e365080a88d\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"3bec2b48e4a0f4c7\",\"/knowledge-medium/src/data/derivedIds.js\":\"64edf5ab84f8f5af\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"a3c6a0ce2335e7db\",\"/knowledge-medium/src/data/facetBridge.js\":\"ec7580ebe322673e\",\"/knowledge-medium/src/data/facets.js\":\"256e35fe4a084799\",\"/knowledge-medium/src/data/globalState.js\":\"438b9843cec97ab0\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"178cd9c71c522ee9\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"2feff56192e79d50\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"4dc120a4f8ff9890\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"7982506c9823f0da\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"0a430170e18d4e2d\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"d6a0d832855928a5\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"317450fb33193f33\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"258242cac0989a79\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"e4848740df207053\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"9e74719315f09589\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"6fe475745e8c9075\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"a4b7ecd15021ff51\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"5845432d63080c04\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"a87801ca513a494b\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"159674e383e2422b\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"e6fd505f5c3f3f2a\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"fbd23e31175fbe87\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"4b6aed3a2b2a6527\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"99c429577c2848f1\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"b9d47c41931beb32\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"7da7a7f8da6a6ba6\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"aafd628db2e0f623\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"db9687af080d2edf\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"d28a25e5e992ed0c\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"22aa17f2c4983af2\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"2a02ce8eb81fe297\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"c0fa158fa6f701be\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"4a679eccc0202325\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"44bec413b3ea5cb7\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"94b59c08b80671dd\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"7bbc3677260f63c8\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"185194bb4733fbb3\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"7924d38552267ccb\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"a1e28dac1a2e06c9\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"fc02d0e47731b61c\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"05ab361f24f18b05\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"5f0b42c813b86f13\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"aa86aa3d1e114cdc\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"d6a68f0bdde05b3a\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"4d8884eeab0424c6\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"f92425e3de3efa08\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"1c89e2eeaa614a90\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"df600b4ac3240fba\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"a176ce04e79e220f\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"514daaec43fc0415\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"692863767b4e2e09\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"f6f87eb04286523a\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"7c2bbac62fdbe1e1\",\"/knowledge-medium/src/data/invalidation.js\":\"5d21090846b8a796\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"18839d9bc993e9c6\",\"/knowledge-medium/src/data/kernelPage.js\":\"922b22dba03f250f\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"a2b1f079cd6b6ab4\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"1588c0447f602df4\",\"/knowledge-medium/src/data/localDbStorage.js\":\"cf81629c25c1c0fe\",\"/knowledge-medium/src/data/localDbVfs.js\":\"7b7dfac472d82343\",\"/knowledge-medium/src/data/localSchema.js\":\"28735c5109800295\",\"/knowledge-medium/src/data/maintenance.js\":\"73c11e2d0f60107c\",\"/knowledge-medium/src/data/mergeProperties.js\":\"cace7b31533458d3\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"10eb58731a59ce8c\",\"/knowledge-medium/src/data/migrationsPage.js\":\"4df35b803f4a044e\",\"/knowledge-medium/src/data/mutators.js\":\"f72a69f6ea9c0a30\",\"/knowledge-medium/src/data/orderKey.js\":\"aa6f387e69881cb8\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"d9a429ea0636f06b\",\"/knowledge-medium/src/data/outlineSurface.js\":\"768488d94bcfd899\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"ac1826dc014f1421\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"cb2fddf6ce15dbfe\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"bd59860eceaa6f31\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"f988f393ed36b776\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"0375cb13b2709c3b\",\"/knowledge-medium/src/data/properties.js\":\"2de9f46d1c4e9613\",\"/knowledge-medium/src/data/propertiesPage.js\":\"d620840c17dad4f3\",\"/knowledge-medium/src/data/propertyChildren.js\":\"930d5c71056787b5\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"6a37a50d5ebd59be\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"2f51481ee80d1ef1\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"eb4f4c2f1f42036d\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"374f2b7ae600db71\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"6162f2e74b99c328\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"8c1960a3e5504d66\",\"/knowledge-medium/src/data/propertySeeds.js\":\"39e2494fbc9a34c1\",\"/knowledge-medium/src/data/recentsPage.js\":\"54d4f95791953863\",\"/knowledge-medium/src/data/referenceBlock.js\":\"8adc1cb0932cb1e3\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"d02c3aefdcc25ebb\",\"/knowledge-medium/src/data/repo.js\":\"133ab249925a6c44\",\"/knowledge-medium/src/data/repoProvider.js\":\"d7ffe00fb1be8822\",\"/knowledge-medium/src/data/rowProperty.js\":\"c47f7a28871e4ae8\",\"/knowledge-medium/src/data/searchFilter.js\":\"7c3b6ca5b384ee88\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"e7331b609c496452\",\"/knowledge-medium/src/data/stateBlocks.js\":\"0984b7a662273b13\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"e0b50071fc223ca8\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"60c4b32114891647\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"0c7834c0259a330b\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"ea1aefc0682208dc\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"231b222a079cfb81\",\"/knowledge-medium/src/data/targets.js\":\"71e80d03fc3a84d2\",\"/knowledge-medium/src/data/typeColors.js\":\"bcedab7bd754920a\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"27ae073c64b2ed0d\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"6800ca92ad5a1753\",\"/knowledge-medium/src/data/typeExtraction.js\":\"d28cfa0faf1658e1\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"53ca30869a63b752\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"5254e71c2b78ac66\",\"/knowledge-medium/src/data/typeSeeds.js\":\"9a4e46268c11cb72\",\"/knowledge-medium/src/data/typeTagger.js\":\"03342921a1ab2da7\",\"/knowledge-medium/src/data/typedRecords.js\":\"cc7dd1d45ec1ed7b\",\"/knowledge-medium/src/data/typesPage.js\":\"9df3918927b71d23\",\"/knowledge-medium/src/data/userPrefs.js\":\"73f4c0f2ceb8e645\",\"/knowledge-medium/src/data/userSchemasService.js\":\"bf3c87953b760913\",\"/knowledge-medium/src/data/userTypesService.js\":\"65696945a05157c0\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"73e53e8d1a4d1734\",\"/knowledge-medium/src/data/visibleChildren.js\":\"e2539c726d960673\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"aaf5e17e072814ac\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"ac0d78e6c786372e\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"77d5917a8fc4361d\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"932e4c72103ff5c9\",\"/knowledge-medium/src/data/workspaces.js\":\"f1069115e89478cb\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"aa4bee4c810bf1c8\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"e5f8f787788c2bce\",\"/knowledge-medium/src/editor/atTrigger.js\":\"2687c0789459aaad\",\"/knowledge-medium/src/editor/autocomplete.js\":\"a6f064792d03a301\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"a8ebe4298b2caabe\",\"/knowledge-medium/src/editor/contentFlush.js\":\"e12b40dcfe8893fd\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"2f0a94ea0596c34a\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"7f0b0e93298d186e\",\"/knowledge-medium/src/editor/insertImage.js\":\"3e4117fabfb85892\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"c9e873195440c3be\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"4c8dd59e9effd2a3\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"cbd95e352c83a911\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"8b138585e90b43d4\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"abc861263e8b362b\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"e89f65617fbd5b06\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"6cba87eae267513e\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"b7f8afe5d9af9257\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"220c873128551afa\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"71ac7af775654e3c\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"c48dd1665acd98c1\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"2a8dbf43dd959528\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"38293ff98511942e\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"b5acdd287fce6fd7\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"b5d0e92faa6a3654\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"27752e6079c31e8b\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"6879a2a2263bcec3\",\"/knowledge-medium/src/extensions/core.js\":\"16db689fffad95f1\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"474539a27b4db62c\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"c79bd0a3bfc02317\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"985b372e0e886ec1\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"25cedff27f414bd1\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"e0c22c7d41a3de1d\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"ab5a1bd80c9df053\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"9f6efb833f993064\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"cde5f012941d15f2\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"20ce8ce6f14a3a5d\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"abe64a3d9617f5ec\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"3fd5996210718ded\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"1b3e73a6ee528ec9\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"38c85790c03598ed\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"05f7c94fa2b51509\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"ec392252b7b37a0e\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"5875f5b117deabf8\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"fef2762f37b08bc5\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"278e39768fb2ed95\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"fe3b591b55078713\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"4f048d06461e1601\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"fccdd185b10b8302\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"8b1593a44965c0dd\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"712a8425ccc2dc7d\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"4bd1d20c4474db01\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"e46329b14e85b367\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"102631391e53e381\",\"/knowledge-medium/src/facets/facet.js\":\"ed670ff5f320b571\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"d22a0b632edd1ee7\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"d9a99c37d8a97c09\",\"/knowledge-medium/src/facets/togglable.js\":\"22b359f3f0017b29\",\"/knowledge-medium/src/facets/variantFacet.js\":\"a01bf84186fd21b0\",\"/knowledge-medium/src/facets/verbFacet.js\":\"4d9fc41f2b33c289\",\"/knowledge-medium/src/hooks/block.js\":\"56236bd325d00fbf\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"17aa41985b766719\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"4dacfaca59aa49a3\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"55f4f06dfc5afdf8\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"bd9aec6620f5a258\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"411431d9b943df1d\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"bd9c5614dabef80f\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"4d2477049d1ba98d\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"56c694a99f3a4fb2\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"510039ec3116887d\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"b7f1c85f712bcc0c\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"64b75481820f8972\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"6f8dad38f6a69958\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"0c947b4e0bc592b5\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"64be5d1a2036d914\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"b429e22abc671583\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"3aeff861a5d5756c\",\"/knowledge-medium/src/lib/utils.js\":\"88eb55378a53a250\",\"/knowledge-medium/src/main.js\":\"acf85d6d28095f92\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"648c79ee3ca3f48e\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"499beabafb78834f\",\"/knowledge-medium/src/markdown/context.js\":\"2997473bb8dd2be8\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"d12c097a8160bc2f\",\"/knowledge-medium/src/markdown/extensions.js\":\"7e631f542a779fca\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"fb8880ff535b55d4\",\"/knowledge-medium/src/minimal-editor.js\":\"a5a20142b492c797\",\"/knowledge-medium/src/paste/armedCut.js\":\"4d9a186b7a4d936a\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"e6d0844a2ea2faaf\",\"/knowledge-medium/src/paste/clipboard.js\":\"1b697403eb35011b\",\"/knowledge-medium/src/paste/decision.js\":\"3dccf20eab477913\",\"/knowledge-medium/src/paste/operations.js\":\"b8f8883a14ec011b\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"0eb9cad377bfc650\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"092db2a6e0ca66b6\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"88c60b4940fe1a88\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"8713f0adf7dcd6b9\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"b29f193bee42438c\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"179ffffda6320275\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"e60f49dad64a6760\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"e3d572d0d8e933df\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"07d4947d15635144\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"b768af03f2fb0e4d\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"1602b8b67445c983\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"5e703e858ea4739a\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"86d89a52418579ce\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"b8a9f304d2c3df01\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"a6602a063c913e69\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"d00cde317c32e3f3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"dfd72a21d07705ca\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"95c2c8179d54a918\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"30652c84ff746cb6\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"afe1bc4d4cb5ed06\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"50f9d463deaeb69c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"af124e85b55f9190\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"5432e2770c434eb2\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"8b56edb22bb410a9\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"3f56fd3a84ac36dc\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"fbc563c338486bfa\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"d83f399c1f36de3e\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"aa95d214fef15d85\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"09cc15695ec0f1f9\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"881fbd1d7d44afb2\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"d0b7587a3e3aaff0\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"54b6b74c6d082d39\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"a1366fc68d0cffc2\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"45e3a126fc0879fa\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"07b59d0a6833a2b2\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"12c686dc9abd1650\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"646d38c7a72ac063\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"a7e7d600b1d6dfae\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"c8e46248c7c376bc\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"e1e0179427f5fe79\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"5b10e78bc26bf1cc\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"909b0cc95834e6b5\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"496850d8328df661\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"c876a16369681f66\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"8b7972b4c1238746\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"d32dd28fe959008b\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"563e79fb577adf30\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"5883136c381fcf56\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"a2ccd18d6d4c3aa3\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"a4cc344316f43a93\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"74b59207e90e6c5d\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"c51af312074120ac\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"7f0744f8e74e9c91\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"8b9db0fb624a80eb\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"80a714052bb4facf\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"6e157e50e4ae5ce8\",\"/knowledge-medium/src/plugins/alias/index.js\":\"d55d9215b18311fa\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"3e920b42d357bfdf\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"11bd38011d303e46\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"41acbfa36561b521\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"442eeb04a9059bf6\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"f2008fb15c3d41d2\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"25a0517797e5a978\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"ffa70d0a947c3ea5\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"22ef0c815e5974a3\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"1e0aa3905e64f797\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"462c012bbb79bb5e\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"a08dc2e00c05c258\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"575d4837289b5d14\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"6e66ba29acf887e1\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"81315ecb19594e16\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"a07d30c4a96da2f8\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"430e53986ea481fb\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"90fb549d6af2c141\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"2275809e6dd87275\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"2b1a49a480463d0e\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"2b142677f5fc76ee\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"502f14131fecf293\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"79e1517adebf5e37\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"01abd905bb5e6137\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"79e349877b31326a\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"3d7ffa96f97e3eaf\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"e7a92edd24b8c531\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"9e255f3badb925f1\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"68e8da11cbb26984\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"8a821fd06806d4b2\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"2402b579cf2d161d\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"ff0f7bf4d3cfb172\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"2486afe46a52c989\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"e2e0d9a7bae0da76\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"3e149a522099e1ce\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"a489f21d65fb6d8e\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"eb7e195b3f77f707\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"0bf2acb0e029ce8f\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"c1f97cc28a538f28\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"8d1014d6fde8d846\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"ee266296c9aab94d\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"490af9758f4078b6\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"c5e0f88f9d258f0b\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"e920f2e5a57ef09b\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"926707481b84853f\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"7190caae5bc2a6f3\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"0f0dc48735eac98b\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"73ee6bda43233832\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"86a91f2aacb63bea\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"13cb6e3c9a6413a2\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"58c644a1e609f5e7\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"be76debb7b93918a\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"7017314c2488abc1\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"f206e8cf7b04450a\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"f71b1f4bad95b76e\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"dc368441ddc726c7\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"0ba18cd738043730\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"1904c6ca2e074d26\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"72b6321ca38f74a9\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"aff5d01a8fb1f632\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"e35416221e9de77a\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"d6839e52c6840699\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"73245abf5ee061bc\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"c7084e32bc933c20\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"63f2372772641c1d\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"4bb5c628ec7a3970\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"34171fd8b1aa03a1\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"af3aec1595b62fae\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"504833597cc27fd6\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"6b03ab8fa85da180\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"bf909c7f5a085f59\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"c8d9ab0f451906fe\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"7aadf1df65aed0a6\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"b9045b310cb75e9f\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"39867dff77380791\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"218d4d14020324ea\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"086596fa47ffc235\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"19187cf8f0ab02e0\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"a3f83234f9a546f4\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"af6e5dfa10638a8f\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"9c6f8a86ff8053ce\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"0d3e11531a675f30\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"742cff604f629142\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"b3368f8183f966c3\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"fd5142faf31438bf\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"1c34192774c5dece\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"196459243d0b6220\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"ad59626b441f727d\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"e13a846a20608e91\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"d1b05e89de1e1fb6\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"956405918ca4eb7e\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"a17783488ad591d0\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"7aacafd9fabdc00e\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"46e5585ebf3bbfd0\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"505b97ab380587b4\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"b10adc029ff419a9\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"d83bf91de16f4fcd\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"c74f9af4f7b54f4a\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"81a319a1e2780c33\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"96f52852913035f5\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"04cb9bfc6a054795\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"d5b7420b849b65c6\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"fca8619f94864b64\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"67b028e3b7030bfd\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"76d94d83ee8c2c13\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"fea9150052532b83\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"48dfbeefa11f200a\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"43d16c642386b3fb\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"f160d34a4e5d8a9c\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"79772fdb2e5b5a9e\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"3be2fca4ad587d81\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"27318fc146901898\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"76b2a8ab9fe7d9a0\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"a798adca549225f2\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"3940c182b3fc994c\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"1231673bf6168e1d\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"efd95ca30e73e3a0\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"a2ec7936432dfd24\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"9a6bd89f61aad8ee\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"9aca2bc4ceb620a7\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"c5f9c38b156e1506\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"32cbf5b18f4e4242\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"5f47fa4030db2039\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"7e00150f8918f115\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"09cb09439440fb36\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"27ab4f7adcb4ea64\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"06cd76d70fcd122c\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"bb6e264623b8d6cf\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"e15a1b2463ada064\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"bbad1370f3b8fe21\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"6f63bc83b2eff1be\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"b61a8c7fa7afe006\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"50b5dd682c6c5bc1\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"c92ac4ddd0965dce\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"d1529fd89c9e0719\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"e2e6dda7856862db\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"77410c976d29d9c9\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"8cae4303eb3f46d8\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"80e355631a8f9e24\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"c36fe6b7796d2606\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"1d5afec1b87bd97c\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"0b636fac875b947e\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"68257887a796a196\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"5bd8ee0f0af356cf\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"c73ed01bb8b4d452\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"d3f4223219d50bcf\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"6bfb09a21b0110e7\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"a5603dd8a354c8fe\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"e52f9895d258c017\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"8f4a9fb2db942c3b\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"4c22257b47f17cf5\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"62f5338882a48421\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"df54197bc38214ee\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"affed568e112fe52\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"227dada323b8490b\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"156bfec7cd1d0f82\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"ebc89390995f5c4b\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"ae0f5d5c31ba4474\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"fb8a0b0777a3aa49\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"424e35991609641b\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"07d66ad36d7b3ab9\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"0d654e8a87796643\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"efd29e7ee6bbe4a4\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"c3c4246a2c201ebc\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"2ef0634b300c7856\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"4c840b0567728d8e\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"7f01e331c819b233\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"ab1faf11bff9a579\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"cb62dd28f93cdda4\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"59298b7d38efb45b\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"fd9cff5429b7b47b\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"3779c3b9abc01628\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"b66afd6de8e445eb\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"d7559dd0faa7359d\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"c29ba3fa4d5f60dd\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"76894afe3c33182b\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"9e415370ace57edf\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"466152cd93571c19\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"abc4c71a6258cef0\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"cc3a586b28a04fdf\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"276c40ec69fa55f0\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"39d5add7126b9c59\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"adee8bcb45431f01\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"526dc9984cfc9132\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"27838ccfcc764035\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"1dd0a6bb4f388513\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"654895646fa66ce5\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"b576ed290b4a8ae5\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"e34fbf4ab6779b3d\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"14ef07eaeadc7d7d\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"9664ece942f07c9f\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"166eeb6f839d5d98\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"c8b9d4cba77ccc5e\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"48570d01ceae44d7\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"5c1499c8e266c1fd\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"840fbba36468097b\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"a315482a03927ded\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"4f82ecaae922a2cd\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"ceaac2892e2f4598\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"88243f6f020217cc\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"dda17cb97af587b6\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"65a6fa31450e9c9a\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"4a0e94c79fd49622\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"a8838dfb4352d429\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"62edd6487c00382f\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"4de06ccaee13487d\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"605009ec50910d69\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"76ae15f38052039d\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"6ba6aee732943ad3\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"2d49ab1c01190816\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"e7417f3961f7a714\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"84f4028c53a07064\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"b4ea1dbb0083e74c\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"1933866fdfdda80f\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"d712adee3ce38386\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"b75f396cc6ad06f3\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"a257876a09a8f591\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"b19b13fef24f99cd\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"b85c948cbf476fb0\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"1f3d741e49464364\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"ceb22ac014e9a43e\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"c39cbb3ba0f57f82\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"5a07bb7bf197b4ca\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"fe531e052e2abce8\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"cbcc3ace9c32d6b4\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"ef1ab2b74c4b9ece\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"38cfbba805ea02a3\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"9ecc82d7da7fdac9\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"b87dc904e87a309a\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"ef52363a4288a1eb\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"7621c9e9611aaa9a\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"bca1077dc5e2ea8d\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"48947d8621125982\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"2f34eec554900845\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"868ae549e2142146\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"4d5bc2a2871e1b71\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"b6b430c07cbcafd5\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"2d9c46bb5ab3490d\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"4d182cc6afd00d54\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"153d10a751616cae\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"5401074d8742dabb\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"cc865d84151907de\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"d65f7dfe069be0e2\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"5e1d1c0aff7597b0\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"334290edfbb136f2\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"6e5bdc57fdc23dd7\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"33f211d1d10a8d66\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"18d5d9ad5a69e200\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"8bef7673fc96d215\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"96456e3b0bafa1a5\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"c032ae5beca4eca5\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"59aed03df7c274d4\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"58251756d76d4b1f\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"65f61122e66c69ab\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"c566dcfddaf375a4\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"2a4deb01d25d4f4b\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"ac850c3ed5928905\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"ae7d2212e2b40c8b\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"dc8ffa7444ff5433\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"4277decdfd5c66a0\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"91864396d75a0c1d\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"0878a59bf3cb4eb0\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"82a8f22e26afde6c\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"2abb9f8fa9b5d74c\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"9666cef53dfeade4\",\"/knowledge-medium/src/plugins/geo/index.js\":\"2aedab87d340c4f1\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"7976b42a93231369\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"fc8f423b978abc09\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"206b7d850cede9a5\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"f34452d5dd28042e\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"7683c4f507c42971\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"b1255983f95c90d8\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"649e858322a7aa28\",\"/knowledge-medium/src/plugins/geo/query.js\":\"19713662765986c9\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"252b6c13be45b60b\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"2203bee52510e2a5\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"b680c9e5bd985463\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"76c558de332d6648\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"871baec366de65f5\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"39556423b5629df1\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"c022acdb20f70377\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"25892da1b4107bbf\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"c14cb24f9cf705b0\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"20317a6029d7c6c4\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"0687c00d943e5377\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"b34b3c6d73e9099d\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"5b53521407c29658\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"76d3ac4e4f91e2ec\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"0b1d3ed200b90d04\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"683343b728cd5b0f\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"e6e6f01fad315498\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"598f69f4152051a5\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"9192af66ad70334c\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"25e23bc6b70eb71d\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"e63ce28036356dd2\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"237dcbf08a5b2a6b\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"e9319b3f98a3fb99\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"1b155c27b361c069\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"02f825936d7dfb0f\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"40a20c9f2f18c2de\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"c7e5e9fe7147ad67\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"2941b02cfed21422\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"5eb9c0aa5302edc5\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"1cef295e03258710\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"e0bee93fefeed5f8\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"17b0269a3d69d523\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"7fdd028d622b6e60\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"00ab08430eb8619f\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"78968e1da28a1bb0\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"9f596e1609f03bc2\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"e595faf036453aca\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"96ca48be6d9e21bd\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"480cd5a03bd433cb\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"67f6c6770c89dc01\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"99fff2a6e96e2d2e\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"a95f8c1d9410a703\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"2bf6a2dda758db3e\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"4d60507c3e6b34b2\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"3ec9c516c78f666e\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"b75bb2c603e11b8f\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"2d9ee0d87634bd48\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"7c76dea415a04083\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"20b14dba997b5267\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"c5efaacab29916c6\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"fcc17e5a83e36b73\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"2946e01d7cd241d0\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"75bca5023fcb598e\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"722cdaea0d6621c0\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"48882c861c271825\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"11b9bda0b5bed9c7\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"8ddc587f6376be1f\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"75a823f22a7f7b04\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"7dc38fff1d33f936\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"b6c8b6b0f8294153\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"6e783dbdde633f52\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"7630dc89881c7dde\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"9b7bf630daaa6d0e\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"fa4d1ffe81a00561\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"1c11d33a1d5c9564\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"dc4fe254cb45f2a9\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"4dde7512f37b79b4\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"19935e8e44faab8e\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"de051953f11334f4\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"8cc77dc5ed48f2bb\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"4cdfe54ad4eeb7b8\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"073cf15db50e033d\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"b15aea78b3e75b31\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"8fcec585c9c9a016\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"2e599672d9cbfb1f\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"bf0a6d8db8d91f7a\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"246ef95233e1d888\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"8d7a90d4713ae646\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"b8d83e24160613bd\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"d180b70ae76f54f0\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"8542c34253c9f7ce\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"a5522a1304f54ab9\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"ff8fad760588bb7b\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"aa0fbb641a3aa58f\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"b6741413f940cbee\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"49e95106abd4b25b\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"b9fc7df5f3bcde16\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"812a1eea3bc2d17e\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"f354832e42b7293d\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"a53e7072b069e447\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"9e9fe7f73eada126\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"f3c1e2a12d3dda1d\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"2c733e509ec899a0\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"3e6cb09712766790\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"d87ea155a714f653\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"3ba67783edef3d07\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"be4a5430770bef24\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"011c5a1c41f9dd7f\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"e96518343ce5bd5c\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"fa2fc8fc2abb7c99\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"87e53593ca2c8471\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"d29bfbd3e555975c\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"a9254ddb6eaafd81\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"2069942d9e26b3ad\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"bb950eefb5fa7a71\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"4e0b76d7c46589f2\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"2411b41e23476698\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"8c2844ed6e9ae319\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"660e960734730d5f\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"9a09484dde73d4f2\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"4586e106c2040730\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"63ca440c3ef5b5d8\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"40b7d5693b6447d3\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"38f663e60079e4df\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"eee838d1ed8ce772\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"03eb7aaefaa16d8b\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"805b921f42839c1e\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"c157f05ff933eebf\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"774cba9d49539a8d\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"85e10301f293a6d1\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"1be78f1f1e038f19\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"c5b238baf02e85f9\",\"/knowledge-medium/src/plugins/recents/index.js\":\"8cd6624de62ba870\",\"/knowledge-medium/src/plugins/recents/target.js\":\"1b22569b4ec76f72\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"fb27dc0409e698d8\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"97961994d56950c5\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"b9c9512d7b51870f\",\"/knowledge-medium/src/plugins/references/index.js\":\"841cb2f345da704f\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"27fdaeb0a49a355a\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"f9ab166e3bcef113\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"a7ea199bab7b9064\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"acf45a9fecbde1f7\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"b30f25e50af81900\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"b249db785437cd1a\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"d8f04a2503d1af40\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"ff94ee58dca24788\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"9b676b052c42857c\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"037e87bccd9474b5\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"c13498d20c6a29c9\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"c4fa1db8521acd0a\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"c9a52fa734203767\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"7e7d62c201895723\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"c176f51644556080\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"65248c381bd88a8b\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"6c0fe1496f8c0518\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"0e6f5102b674810f\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"94ded381b19514cd\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"a34e2aacfd675dfd\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"70694b6a8f7a564d\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"4c8b12fbb2b9ab98\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"6a876b763c5b58e6\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"31b5886fe6f5360b\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"6d5b853daaaafcab\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"7bdc912b2fe56141\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"433a4f407f37cd8b\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"40b9dc81b9561bab\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"d0b18c7fb92c4867\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"4d1b9c365dd5cf1d\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"5ee1e6a80ec3c53c\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"18e83d8811f5a98e\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"fd04fbd992c26e13\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"39c9ea796e198af0\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"314a78f359f3c70f\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"f6b83c8c82266d73\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"aed320dc3d60872a\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"24dc7f17775539e0\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"ea4f6218371a5143\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"93b65c8970a23468\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"c0a5cf74d7af0a32\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"bdb3451b9abc825d\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"319443b319aa7ce3\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"4ab7a31ae6cbe820\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"61e9a4cbefe25353\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"527e590c6df0c9ea\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"9f03d27700d3504a\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"745fa2dcd579e775\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"8e11681aaf906c9d\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"f5888b01ddb3aee1\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"0bd99192faa63f4d\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"48bcaea555ec9186\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"d070a6610515153a\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"03f0d62053348c00\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"d0d046ab26921f10\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"691c5af361c91fe2\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"e4f83a11a87d3a80\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"a2a4f539d0a7e5c2\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"fff0b1226e51bc98\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"c72ec6f487ef0e03\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"0db837561b80517b\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"276605321c43672e\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"3130e97c22e1cc29\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"b395c3b250e32004\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"d00933a993c51476\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"88ae9333a236a214\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"b40876a96409660e\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"d42bfc16ec4ad453\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"058ecf77dc7297f0\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"ac47d84cbc1bdd35\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"13ee305c2fb44ed3\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"9b3f0bb814155330\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"10a12f3edc1c8c96\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"e17d33a37339095d\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"ec9532c1f32c93ce\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"4e1cbf3f15f831e9\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"2dc8e7a295bb6e03\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"cd740aaecff86f3b\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"ba59867ebdc3274b\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"3c9288e35320bc8e\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"66d7354b5381c40b\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"35ce47c6cd5455d2\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"d5644ad98db893c9\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"198fa2f0529e18bc\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"800d39d7421cd713\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"f7e8a442364cc4a7\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"7ebb95b3b229b807\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"d0815c732a17a56a\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"0f3872b4449909ed\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"565d4abf95e38013\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"cab76659d65ae2df\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"6d9a40e6c55b2019\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"161f7794ae3ccd32\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"39804c35f14c60f7\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"e22a23d496251fd1\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"c7e10532a71c296f\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"1e36d3ecc74763de\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"75d1269a772e0387\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"256b3ad1c25f4c87\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"fa5b0026f90dcd76\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"5c286adbf2457e5e\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"2398d0ee309821c3\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"f79c9e15a24a752f\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"0da3faf51237f622\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"114e3a0efae042a7\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"8aa4962491f5f7ba\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"da8fb336175e943d\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"e1611f254c66eb77\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"3d4d581caa555dd7\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"fd7a5745f0c565a7\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"c6106c4f69d9dd9d\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"5e4b5cee80cf55ae\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"0f4c7868b2589778\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"6545364e92678e45\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"78159d3263990c5f\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"0f520005cf6b6d22\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"87d8ac0adbca4b67\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"658a67fbd2f21c7c\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"5bcde91538166627\",\"/knowledge-medium/src/plugins/todo/index.js\":\"d8c2281036409504\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"9e92bad2999862ea\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"8e9632bf5af3e97c\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"5b799e0926f3756b\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"02385fc6780de048\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"7aa42e441924af42\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"014c3b7e356a8934\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"05cf4c96d8e3d768\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"3c2996524af5dad1\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"1ae83f40ccdc37d6\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"6cb1d6a646ebf59e\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"031fb77ab2138821\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"99bf690bab8e855d\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"865d88a02470c187\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"ba7c58c2da5071ac\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"14ee5182afe0a70c\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"25d677b8309c27e3\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"ddd049fc1a8c15ed\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"a8d232550bb67b49\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"4c5d20e9087e9194\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"866298f388cfdc60\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"89bbd74602f65fe3\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"d85fd8d659145081\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"c630c28cc0f446c6\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"758ba0a338ae419c\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"b04f07a8c2d32168\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"c08e1f48ad316aee\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"9ef31eef3951c670\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"3543a73904a5f4a8\",\"/knowledge-medium/src/registerServiceWorker.js\":\"a08cbf215ebcb086\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"49463d52df1e51a6\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"fb7175418e60896d\",\"/knowledge-medium/src/services/authStorage.js\":\"08489ed82288e45d\",\"/knowledge-medium/src/services/powersync.js\":\"2182b59538466482\",\"/knowledge-medium/src/services/supabase.js\":\"6a4fee38ddf0f7d2\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"e31afa93809660a1\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"9e23e8969d702aa2\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"01938c63505c2ceb\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"dbca54d7c290c6ec\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"39bcd77e48832c33\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"1ce1b55872bc674f\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"9d396b39b97ad700\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"6f6e32b82f401eac\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"427a09599f9ff3cf\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"5b33798de608e394\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"3c41da50bb48ceaf\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"87a70b24d7cb2ef4\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"403ad70772d4808b\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"d405e90a72765eff\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"84fd0fb0d53d6541\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"0cdf7b60ee43d864\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"e0eeba9c0cac5d2a\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"1064a836272a932e\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"6a8be388dabb8021\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"bade4f8bc8b5c14c\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"71a9580d5b642eb6\",\"/knowledge-medium/src/shortcuts/types.js\":\"7d721429a3733baa\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"235452d996b8957b\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"6fb62011cca0ecd0\",\"/knowledge-medium/src/shortcuts/utils.js\":\"ad6ded8a1f0259ad\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"32b4d1d54e5c4bfc\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"ecd1f9f8e5cfabfa\",\"/knowledge-medium/src/sync/byteTransform.js\":\"08853f2bfc4cb405\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"486da90eeb7d9dde\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"e16c0e1fc7bec600\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"4698ce512d950067\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"756f8b7b79116675\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"08c69ebb9aca0d04\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"7a3cf2be3b43f45c\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"72a47b799544af28\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"8d9649726fd9dabf\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"0c176b7b1179ce42\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"218f9d0f0afedfdd\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"cdee82c60f682620\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"cd77c44a4a841f14\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"da19756413837547\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"1ddf1914a9b9e9a3\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"2043287f51bab38f\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"013d2fc88596923f\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"4deae989f5be7f29\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"ecae4b360b44a9b7\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"f297d826d8240137\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"c70cf1b16e466bfd\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"8542682a50ae1c04\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"362d506fb3d807d7\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"e2bd64080d8e33f9\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"975b0004a5770a7a\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"a7e84eccbb85db5a\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"83b335263632887b\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"51a5e0a936901302\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"b7676957d2ee4502\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"f9d9b43e27d35bb8\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"452b0dc845f8c3e7\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"0dac307366a50bd8\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"bc196d2472c27db3\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"1e5a822a915cb6b9\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"73184b78f723ac21\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"efb497a461b5bc22\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"f3ac548a1a921483\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"f671e6e552f7b168\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"893d08707d43087d\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"afd89c3efd89e4ba\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"ce36557cfe58781e\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"140191ca10728ee5\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"1daf9a676f372c12\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"b5324e9a7498883d\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"7fe50a09519167c7\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"4b2a630aefc6ed94\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"87ab5a94428568aa\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"7e0d74654c07fcc9\",\"/knowledge-medium/src/sync/transform.js\":\"36de4d5fed7e88bd\",\"/knowledge-medium/src/themeBootDefaults.js\":\"39df8c79a6e766c3\",\"/knowledge-medium/src/types.js\":\"e15dfd4df36175ba\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"60f77c5a9dfcb1b5\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"998135381509d242\",\"/knowledge-medium/src/utils/array.js\":\"f249182d947f1b00\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"65c20a1d0e3dbf38\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"3c26256820c06e3c\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"bcd1b6df17fc4c2d\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"cd1cad11aa67b4a0\",\"/knowledge-medium/src/utils/callbackSet.js\":\"9a2c691f8f3de9ac\",\"/knowledge-medium/src/utils/clientId.js\":\"d32e202a57bbfea3\",\"/knowledge-medium/src/utils/codemirror.js\":\"2c78516775133a0e\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"0d7411715999daa7\",\"/knowledge-medium/src/utils/copy.js\":\"203c2a98e32cf058\",\"/knowledge-medium/src/utils/dailyPage.js\":\"f1c13decb6c7eddf\",\"/knowledge-medium/src/utils/dbForensics.js\":\"c0579af38b2004b6\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"738d6ad8061b6b3d\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"0fa9dc7d48df9ed8\",\"/knowledge-medium/src/utils/dialogs.js\":\"417c80502936f252\",\"/knowledge-medium/src/utils/dom.js\":\"dcf5406453398785\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"300179db3e20360e\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"40e199fec87f3cc9\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"bb4c9858f1ecbbd4\",\"/knowledge-medium/src/utils/flipSlide.js\":\"3c5773fa93b10865\",\"/knowledge-medium/src/utils/fnv1a.js\":\"91e924309bd21f5d\",\"/knowledge-medium/src/utils/formatBytes.js\":\"2ac883246d176b42\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"0974ef65a519ec45\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"92d762c989d5ec1d\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"babf7d0ca9763ab3\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"010247be70b12d79\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"f27a73395c683d68\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"ede536ad0026d294\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"7b1b8b6ba745b36a\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"7243951a29ad2a44\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"54a69e9019b73ae8\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"5a31d406c51ff11c\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"93e3c5b175cf82f1\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"5ebcfa52df31672d\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"785d9d0bdb0688a4\",\"/knowledge-medium/src/utils/markdownParser.js\":\"bc370dbc70918db7\",\"/knowledge-medium/src/utils/memoize.js\":\"ed2cc3bca7447715\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"f414d4369d72454a\",\"/knowledge-medium/src/utils/nameList.js\":\"43aa864c224896c0\",\"/knowledge-medium/src/utils/navigation.js\":\"f130e2c4fc84737e\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"d1b0b04b20f8a28e\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"821e91cb1989971f\",\"/knowledge-medium/src/utils/panelClearance.js\":\"748486fccc5de7a9\",\"/knowledge-medium/src/utils/panelHistory.js\":\"193cb8376f76a778\",\"/knowledge-medium/src/utils/panelLanes.js\":\"4afce1e964b5d200\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"5d334894ebb009cf\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"9a89bc0d7163a7d3\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"4bdd58d8776081ea\",\"/knowledge-medium/src/utils/platform.js\":\"5ecb6d4a6cf48dc0\",\"/knowledge-medium/src/utils/pluralize.js\":\"7c3188336881a6d9\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"224cb62a2112a58e\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"80ade5f445e8a628\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"d75ea7079e483d9f\",\"/knowledge-medium/src/utils/react.js\":\"5aaf73db03eedd78\",\"/knowledge-medium/src/utils/relativeDate.js\":\"cfe0da781cbd06f6\",\"/knowledge-medium/src/utils/relativeTime.js\":\"32bdc58d2521e105\",\"/knowledge-medium/src/utils/renderScope.js\":\"025a6077ef1d9f35\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"cad63e2385d1cc8f\",\"/knowledge-medium/src/utils/routing.js\":\"f26f42debede3a79\",\"/knowledge-medium/src/utils/safeMode.js\":\"9fb704f1ad8ac979\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"05e5970341609efb\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"ad410e9a0c7a3860\",\"/knowledge-medium/src/utils/selection.js\":\"5e1e5fcd8a9697bb\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"f66ef627681100fb\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"2a1763c68384ec6d\",\"/knowledge-medium/src/utils/state.js\":\"ba7477bde7b6cb10\",\"/knowledge-medium/src/utils/string.js\":\"a4ec6d18676e9bda\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"1dcdf16434740cd8\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"8db069ec6338866d\",\"/knowledge-medium/src/utils/toast.js\":\"a4aa3dd053a7dd18\",\"/knowledge-medium/src/utils/toggleStore.js\":\"b2d5713f0a043425\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"035e253fd3ec458f\",\"/knowledge-medium/src/utils/userActivity.js\":\"4a0fafaedd446be9\",\"/knowledge-medium/src/utils/viewTransition.js\":\"6fc60ee632eca648\",\"/knowledge-medium/src/utils/viewport.js\":\"9c7310fbafa03d3c\",\"/knowledge-medium/src/utils/webLock.js\":\"35c733896a519d52\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"d906b5dec1e3ba06\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"b9832f673642b0c6\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"907d1838d3ed3a60\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"b97e2d590180ce04\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"26fe36a09e2d22ec\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"d9127a03cac253bd\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"e247a24367e2111b\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"1bec0e0ddfebe530\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"f65a0b6972cb40ef\",\"/knowledge-medium/src/vendor/react-dom.js\":\"b5a76b4514370fb2\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"140cade8ca684794\",\"/knowledge-medium/src/vendor/react.js\":\"6d639d5703e0ab52\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
