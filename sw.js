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
		buildId: "bb4f7e07a443-8d67e129",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"21a7ed405f69954d\",\"/knowledge-medium/index.html\":\"21a7ed405f69954d\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"141c7ab4732fe1ad\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-DlrBuiZp.js\":\"bc7639741b04723f\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"e352d9e8ec3d4774\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-BVYWK0md.js\":\"f5e5e0892f3c9071\",\"/knowledge-medium/chunks/FacadeVFS-Dsm7UySj.js\":\"043bfa60551643b6\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-BJiFjhjm.js\":\"51f6b75c41e95b7c\",\"/knowledge-medium/chunks/MemoryVFS-DgNHEgfE.js\":\"1be26330808ff05f\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-C9br5ibH.js\":\"463be542737c7caa\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-BWktgT5e.js\":\"05170798e3139d17\",\"/knowledge-medium/chunks/Preview-DBtIVLyy.js\":\"cbfc98745c657d12\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-GOgH1Vdf.js\":\"a102b3552b768d45\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BGZj0pDg.js\":\"795db2d46cb68feb\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react--mzSZfaO.js\":\"a17acfad3b654f19\",\"/knowledge-medium/chunks/react-BWKapZA7.js\":\"d89f51c9852f5747\",\"/knowledge-medium/chunks/react-C4xm2cz1.js\":\"9318c96c4b480a94\",\"/knowledge-medium/chunks/react-CkXGi7ov.js\":\"95ada30367aab61d\",\"/knowledge-medium/chunks/react-CzkAOMGa.js\":\"0258b2327bd82a0a\",\"/knowledge-medium/chunks/react-D6NDZRCk.js\":\"fe4ab4a038927603\",\"/knowledge-medium/chunks/react-HQyvcKWk.js\":\"6808553b3d633df9\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-BdbiXT4N.js\":\"3f7a86ba180579b0\",\"/knowledge-medium/chunks/react-dom-server.browser.production-C6_Y45gF.js\":\"cc5c79e14bcaec5d\",\"/knowledge-medium/chunks/react-dom-server.edge.production-1bKnZVQ5.js\":\"078dfa51c8f38569\",\"/knowledge-medium/chunks/react-lGrpyYz9.js\":\"f941824cfc203131\",\"/knowledge-medium/chunks/server.browser-DqS0hHmX.js\":\"0645f839acd8a72b\",\"/knowledge-medium/chunks/textarea-DhaTIexG.js\":\"89635279820e5f2c\",\"/knowledge-medium/chunks/ui-JIix71a0.js\":\"08e6b8ce16d6b56a\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"1a2b9a89fd3a3bea\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"c7bf22574002395c\",\"/knowledge-medium/src/appUpdate.js\":\"5da88bb104990635\",\"/knowledge-medium/src/appVersion.js\":\"c1a76d646a618186\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"e78d54456b769041\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"1783121457fe9857\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"48e602b2dff68a99\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"749399eb52f26bb5\",\"/knowledge-medium/src/components/BlockComponent.js\":\"6446636de5a6b138\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"688805826d3dd478\",\"/knowledge-medium/src/components/BlockEditor.js\":\"b4fb5557160dc2f4\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"126968c71111123c\",\"/knowledge-medium/src/components/BlockProperties.js\":\"7551b4872bc6ce2c\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"4e7b8b75b94743eb\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"30201ed857eb7447\",\"/knowledge-medium/src/components/DividerHandle.js\":\"28c3dbfe43285e7d\",\"/knowledge-medium/src/components/DraftEditor.js\":\"08423d8500879e55\",\"/knowledge-medium/src/components/GutterPill.js\":\"6db5b2c6c8674da9\",\"/knowledge-medium/src/components/Header.js\":\"b00a29885b73eb28\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"4ba8c87ffa3cecf2\",\"/knowledge-medium/src/components/Login.js\":\"9bb8e8be16852de0\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"3bf7002bd9a29a06\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"94931ee8d97a3d59\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"fc9c7fd38117e14f\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"6cbaf72879a5b130\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"71a55c773db55821\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"19acc694b258b079\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"bc430889f048812b\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"9d0cc930ea8b0348\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"5f069665c0c6d5e3\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"241065933aa6455d\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"90f41db41d694fd2\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"0ef0cacb8bc41338\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"748d06e1915fdb63\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"d48c817bbf237f08\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"7243a1b2e9c0a93f\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"2ea40d16f8d400c1\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"935e0eb8c5959687\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"7c4d6da4b736ba47\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"64c0a7b420495dab\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"5b7a98a12d35f1a3\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"2d19c1ae031c8222\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"f98e44b976719a36\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"a2db0a9cccaa3bb3\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"2a51de1fe42ec3be\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"f792f7b473af3a98\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"6724a76f9445cf3b\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"ad2122a78dfb7070\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"bdfd12537f10de11\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"bb8a385bd175b0a9\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"ca1f831e23d76706\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"8304ed4432d6a4a1\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"2fb308c817876c46\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"92a33e0421f19297\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"9b31b873d30947f0\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"7ab382bc0bddda4a\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"ecba18c272652cab\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"cd560ade5ffe49c4\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"3dda41c938d42128\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"be7e8e1646a6bfde\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"940413de3b07c5d9\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"4cea1959125501f4\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"416b90abc896ba7f\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"13e5441e96440234\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"f81eb85d769648b8\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"84e678b38ffbccf8\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"c872af573f7419fe\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"7135a9e9dc5f21ad\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"451d6f12c59f0c8f\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"5fb6b85a8bc3ff39\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"b8a0d98d1e69468f\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"ae6fc691e3ecabb6\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"151cda20bd0ddb30\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"20c3735041ba38ba\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"a77febf110f4e2cd\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"97718694d7a0d4f2\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"ac171f73ab9d4541\",\"/knowledge-medium/src/components/ui/button.js\":\"1f69c26b2cd4726d\",\"/knowledge-medium/src/components/ui/card.js\":\"da9d2f2d6320b474\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"a62bf82b7c875eb1\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"4e5216a3330d369b\",\"/knowledge-medium/src/components/ui/command.js\":\"ec5a121c8077ea83\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"753c084e5932cf85\",\"/knowledge-medium/src/components/ui/dialog.js\":\"2e9b65e2a0f438b6\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"abdb15f60f476be4\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"2b55e763f93e01d0\",\"/knowledge-medium/src/components/ui/index.js\":\"9af55e770ba87b97\",\"/knowledge-medium/src/components/ui/input.js\":\"99c5bdb02cdc30e7\",\"/knowledge-medium/src/components/ui/kbd.js\":\"cd87568919566218\",\"/knowledge-medium/src/components/ui/label.js\":\"e39a65c8a4763936\",\"/knowledge-medium/src/components/ui/textarea.js\":\"6da00a21888f85cc\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"b704ede614f52989\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"79f5548647dfa0a2\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"b67029411a28d136\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"8800650062567ae2\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"f7e26359b89ec0e2\",\"/knowledge-medium/src/components/util/error.js\":\"e6cd042a13cbc88d\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"85110bc4835ec0ae\",\"/knowledge-medium/src/components/util/suspense.js\":\"e491d27144aaa572\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"fa631adc77b48c8e\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"7f64dece3e107dc9\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"8187447e9204751a\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"37498582dfdd51a6\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"71c1592bffbd0f2c\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"c8ac6546b368d596\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"4316238355bcf138\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"52460f4499ce62f3\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"bd0e98ca66c080cd\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"3fefc480d41bee1d\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"8c5f156b10cf92ba\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"7499f58057562e31\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"06384940734552f2\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"3f7f419a73606bae\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"aaac06e48bc21fdd\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"846c7b1e89adffda\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"65f3e2f57223e0b8\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"f10d1fd3ca05eb02\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"567b7e634da4b919\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"87e2ed9cde27ae09\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"6310b4dbd70d587b\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"0906ad215912d6d1\",\"/knowledge-medium/src/context/block.js\":\"467934edb4c8d3e2\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"bfd98f37e9ccf5c6\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"abdaca5e326e0299\",\"/knowledge-medium/src/context/repo.js\":\"64d0b306df37af34\",\"/knowledge-medium/src/data/aliasClaim.js\":\"95f4f437be25f7dc\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"8b600193bce971b7\",\"/knowledge-medium/src/data/api/blockData.js\":\"401b6fa6b127de38\",\"/knowledge-medium/src/data/api/blockType.js\":\"607d4c704f43da10\",\"/knowledge-medium/src/data/api/changeScope.js\":\"66ff84821acff13b\",\"/knowledge-medium/src/data/api/codecs.js\":\"c0b3169599911a56\",\"/knowledge-medium/src/data/api/derivedData.js\":\"98a12784e9b15f76\",\"/knowledge-medium/src/data/api/errors.js\":\"6510dd151fce135b\",\"/knowledge-medium/src/data/api/events.js\":\"9a0ab978464e4289\",\"/knowledge-medium/src/data/api/handle.js\":\"4da7d87b8a47c48f\",\"/knowledge-medium/src/data/api/index.js\":\"dce091eb141af3d4\",\"/knowledge-medium/src/data/api/mutator.js\":\"0f4603632a085cf8\",\"/knowledge-medium/src/data/api/processor.js\":\"1123240084f8e9d6\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"8de61e6ff12ec339\",\"/knowledge-medium/src/data/api/query.js\":\"0b7042b4e1598547\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"ea0380210b2e2ca7\",\"/knowledge-medium/src/data/api/schema.js\":\"4da7d87b8a47c48f\",\"/knowledge-medium/src/data/api/tx.js\":\"4da7d87b8a47c48f\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"6be7fb15144089b5\",\"/knowledge-medium/src/data/api/user.js\":\"bfa4fd480515ec6f\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"50fee95eee8b4db2\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"1bea5127c86457e8\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"32e1070a0aef0db2\",\"/knowledge-medium/src/data/block.js\":\"e7722b2862f97f13\",\"/knowledge-medium/src/data/blockCache.js\":\"7706cff71ba8edde\",\"/knowledge-medium/src/data/blockId.js\":\"7900817b5c8a3838\",\"/knowledge-medium/src/data/blockLiveness.js\":\"d0ee8a0c1b6a4a47\",\"/knowledge-medium/src/data/blockMerge.js\":\"39e5bb6ff50f23eb\",\"/knowledge-medium/src/data/blockSchema.js\":\"1c94b38494e33582\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"9e6440c477673d47\",\"/knowledge-medium/src/data/blockTypes.js\":\"2f1e0e6e7c58d1c3\",\"/knowledge-medium/src/data/childrenView.js\":\"9adb3538c81d67d2\",\"/knowledge-medium/src/data/clientContext.js\":\"874178ed067de0f1\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"1b34a212bf2fcb2c\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"d676689cace4db62\",\"/knowledge-medium/src/data/derivedIds.js\":\"dd87e60ececab4e6\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"629431e34a7d3972\",\"/knowledge-medium/src/data/facetBridge.js\":\"b6e9932208923106\",\"/knowledge-medium/src/data/facets.js\":\"75c79b596a7e45b0\",\"/knowledge-medium/src/data/globalState.js\":\"eb2aa019ba2f16ac\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"bbeaf7cc6d96950b\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"653563561465152c\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"cf49b82d20441335\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"d9123de211ed94c8\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"d1f24f757524ccb1\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"9f7eeed5e54035a1\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"14b7c40e2f7f7f4f\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"67ad16c1b641e004\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"28a1541cb7b6006d\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"61ff0c1ae031b469\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"e18fae1dc2650c17\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"6cc6a34cee947026\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"19e25e41b4219459\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"6b49b98bacca6028\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"2e60804bf56e39ab\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"7a6952c97291682a\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"8e5fadfb08b888a4\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"18e048829c496ab6\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"d1c6998279a184cb\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"ba8ec40deea95745\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"6799263e95315ae4\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"1cc948ae386fc8f5\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"cbbcf3a4f7c99caf\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"6054d73d39e396bd\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"0e46c7a10377aa9c\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"dea161c18f0cf4a1\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"6f6af426c233438d\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"8ff8f6ff325757f8\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"f4a8575282159045\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"9435ff88ede56f1e\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"1cbb9b46478cba94\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"57d8344c72e847c0\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"791c76ca2abc3d42\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"f9cdd513acc1f2a0\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"8b759a006ba4d932\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"99e8539b477929ac\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"3b745aff615e2244\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"256ab6d36d93f2b1\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"4dc554d21fbf5208\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"b3124a73d50ed948\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"12d909e58f6136c9\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"9616dc25d7868fb8\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"ea4a32a58351d84a\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"c4d289165a61fee1\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"1af33a4fa5acfe75\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"4124013365c2e729\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"375df71b3a0fec39\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"9d1f2bb93575416e\",\"/knowledge-medium/src/data/invalidation.js\":\"11e6795bf6ad2329\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"f51aacc4e6fedee0\",\"/knowledge-medium/src/data/kernelPage.js\":\"f0253695541b2962\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"3d8373dc467ad523\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"3cdf43cc7dbb65a7\",\"/knowledge-medium/src/data/localDbStorage.js\":\"03362ddfaa1a6005\",\"/knowledge-medium/src/data/localDbVfs.js\":\"961d0eacab4eae15\",\"/knowledge-medium/src/data/localSchema.js\":\"d35eea8c07df0f5a\",\"/knowledge-medium/src/data/maintenance.js\":\"a76f2f4a141f67d9\",\"/knowledge-medium/src/data/mergeProperties.js\":\"d675d309f616bf54\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"c0dd618d5f6c09e4\",\"/knowledge-medium/src/data/migrationsPage.js\":\"df5934e33a9c84d6\",\"/knowledge-medium/src/data/mutators.js\":\"79445019a286989a\",\"/knowledge-medium/src/data/orderKey.js\":\"1722154039ea2875\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"0781371c92c966b7\",\"/knowledge-medium/src/data/outlineSurface.js\":\"787ad58c469d45b1\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"13b8aed650036e0f\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"ede62a7862b7ad5d\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"35697ab88812ba44\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"078a08b7042adead\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"fcd85ac1e1db9f2a\",\"/knowledge-medium/src/data/properties.js\":\"ac6b45ddff8b01fd\",\"/knowledge-medium/src/data/propertiesPage.js\":\"1350f4486b49bde6\",\"/knowledge-medium/src/data/propertyChildren.js\":\"fd8aaa52c843dc3b\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"3d873d806cf2fecb\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"8b5e2aca8226d094\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"46ffc6ce7bdcb6bf\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"03a7e048bf3195a0\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"ae0ad7c520d8d92b\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"abc075f540d6bb54\",\"/knowledge-medium/src/data/propertySeeds.js\":\"50ad066dc80d1046\",\"/knowledge-medium/src/data/recentsPage.js\":\"eccd93d1c5847739\",\"/knowledge-medium/src/data/referenceBlock.js\":\"279833c385d5f981\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"97dfde33e3d52355\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"7ec9bf7ed53e07be\",\"/knowledge-medium/src/data/repo.js\":\"bdd5b150dd34950e\",\"/knowledge-medium/src/data/repoProvider.js\":\"6bf98752e1e37287\",\"/knowledge-medium/src/data/rowProperty.js\":\"36bcbbd09c0a04c5\",\"/knowledge-medium/src/data/searchFilter.js\":\"78eea7890f98a9a3\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"40b8f1917bd1b902\",\"/knowledge-medium/src/data/stateBlocks.js\":\"38849854885ffeb6\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"28277e250b269814\",\"/knowledge-medium/src/data/structuralInsert.js\":\"127af29dfa535a8e\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"7b9c54be937a83b7\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"d323e791cf3868bc\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"f106fe9661649bfa\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"5c9a8c1e709866db\",\"/knowledge-medium/src/data/targets.js\":\"31d152ce1a248f6d\",\"/knowledge-medium/src/data/typeColors.js\":\"529468a4be7c7044\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"6c6a096f3dcf78ef\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"e81267e88e2bdf2d\",\"/knowledge-medium/src/data/typeExtraction.js\":\"17bb1b2cf3e50310\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"97d753ea741ca84a\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"5b217ab0a1a2648b\",\"/knowledge-medium/src/data/typeSeeds.js\":\"95d24c9aaf1842d6\",\"/knowledge-medium/src/data/typeTagger.js\":\"30df50a38f0b0977\",\"/knowledge-medium/src/data/typedRecords.js\":\"4f1a56f77241b310\",\"/knowledge-medium/src/data/typesPage.js\":\"cbb7ce5c35d9a9b3\",\"/knowledge-medium/src/data/userPrefs.js\":\"a678f462bfeb9087\",\"/knowledge-medium/src/data/userSchemasService.js\":\"d7c9e601cd713016\",\"/knowledge-medium/src/data/userTypesService.js\":\"21747bdcca0e2e37\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"fdf1f133adf0a938\",\"/knowledge-medium/src/data/visibleChildren.js\":\"9b1a342d7dffb568\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"97bb5cb6148d6899\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"2c23a32db8411c5b\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"8fb53806f98ab117\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"ade785d0df2569ca\",\"/knowledge-medium/src/data/workspaces.js\":\"b48e443590611b76\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"cbbe6a1b14ab8656\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"3536c990fbace783\",\"/knowledge-medium/src/editor/atTrigger.js\":\"9b4193a298f08ab3\",\"/knowledge-medium/src/editor/autocomplete.js\":\"0491521c880d1048\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"ad0dbf6bffdc8b0e\",\"/knowledge-medium/src/editor/contentFlush.js\":\"eed71f6fe5eae596\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"1660174a6812b0d3\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"f76e550d3877a695\",\"/knowledge-medium/src/editor/insertImage.js\":\"800e2881af04b24c\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"bc51356cb05db900\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"1e90152c82ee3ad4\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"135e624d8a787cbe\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"087178da507dfc48\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"12aee9a7ec6629ec\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"2b355b7d98c2ef16\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"020315e4f542747c\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"000acb5b8ffe7edf\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"1af817c0d17df1fc\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"db490bf65483973c\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"8d72773883026723\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"103fbd42531b7968\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"bd5f1121a518fdf3\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"0082bad54acfb055\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"abdfdaf7c11efc52\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"1d32030456fc0ab0\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"dbf28a491bf9f1a9\",\"/knowledge-medium/src/extensions/core.js\":\"30385a4e40da89a9\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"6c46ecb4c01659a9\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"b641e1141c9ef806\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"b10b447de0e2c265\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"b181cc531c800f2f\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"104ed3def7f86c79\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"fef02569fd1fdd04\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"252cf9052ed67e04\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"07d6631cfa546cce\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"56fc47145369f6ef\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"c65b86659c3c4c90\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"7cfe5b37b26938de\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"e3905ca1510819bd\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"8dab2306f94dc3c4\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"c69caa5096b72971\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"93ed64ca6791bee2\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"83ffb8c6b8435b2b\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"f991b07738c2c565\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"aca79210b1d46ecf\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"c676c6e7f1237b3d\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"4688d9fe29380533\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"cec535e08fed598d\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"2bb98586482793e0\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"194b60b5c7d55a32\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"79c2854087038de7\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"2f9f43446da7ef13\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"f7df324dbbb11754\",\"/knowledge-medium/src/facets/facet.js\":\"b976dd9cf82c9f6f\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"f940a53f5025c1cc\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"50430506a05516a0\",\"/knowledge-medium/src/facets/togglable.js\":\"0ab2c7307a147339\",\"/knowledge-medium/src/facets/variantFacet.js\":\"82d6ba9ab598ab92\",\"/knowledge-medium/src/facets/verbFacet.js\":\"ccf9048d070f58b3\",\"/knowledge-medium/src/hooks/block.js\":\"112d66f86e976457\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"d1bd55c3057bb1a0\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"d312f981e4e0c9a5\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"5b7e99292174003f\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"831824b8e0e908b0\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"683bbc37bcfe1847\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"abe721ee4c82fe6e\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"3993593f8dc62e56\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"732c7ce1e23f5be1\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"c0ede4a3bd164c45\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"7aa540bc63b5c707\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"115533d4b2bcfd97\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"6637f192427c71a4\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"6d118d1ef78fcc06\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"5e3e8b9d33684e75\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"6085ece48347e559\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"997f57f73aafa19f\",\"/knowledge-medium/src/lib/utils.js\":\"42eb97e9c150aca4\",\"/knowledge-medium/src/main.js\":\"bdeb8ea11f9c4931\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"9cd8f3a62a0fb513\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"ad67ae22820f4697\",\"/knowledge-medium/src/markdown/context.js\":\"d822f82f68f0f228\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"80c37f3aa0b535ea\",\"/knowledge-medium/src/markdown/extensions.js\":\"d5aeff35ad93a209\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"1d81f4111753b470\",\"/knowledge-medium/src/minimal-editor.js\":\"2db46f8db8e7010f\",\"/knowledge-medium/src/paste/armedCut.js\":\"1815c5ff060f25e4\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"eeb67d9273afac1d\",\"/knowledge-medium/src/paste/clipboard.js\":\"8d5242cd417a0c8d\",\"/knowledge-medium/src/paste/decision.js\":\"a9399acb5d2a0b08\",\"/knowledge-medium/src/paste/operations.js\":\"3addac58b0be6302\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"a0607ce627965ea2\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"3682818194c69b28\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"8c446e5166b17113\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"a2a4d0df19242961\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"7ae2ef9739868d11\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"8faae82de0ac2a22\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"5cd9d735c30bd9ce\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"b4bd5fa31c818ea1\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"13dbeb69c7815de1\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"2f165a2ac0e568ad\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"e7f255a360b42b65\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"718f61b11b29ab82\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"6d8505cd40f34005\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"f230921cf09c6af1\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"673f570942c76b7c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"82d0f163e61747f9\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"cd06a767115b972f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"c9c56a6e975211f3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"7b69be02e676df0b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"9c52567223d5b0c3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"84e5df318853680c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"1bd0866f44bd0f56\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"c98bec0abef209a2\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"e0cbc644fdf7ce7c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"42f4560ab098e580\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"9d5c3ca7b86d6a71\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"963dc27bffd8306a\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"1c723410dcf2c637\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"1bff1e94f8e31ddf\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"2d4b6036c61cb723\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"6fd47ee96b0cc333\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"ac84085acebb6273\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"d4ce65c410b863a8\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"4b0feb2558c22920\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"124ea5043c946eac\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"c9d258b2bfea2e63\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"f752f993f9013d6b\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"c00852d69ebb812f\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"d3f77e758b3cc5cb\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"75bcb281b6e91062\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"c565b73e5ed3d3b9\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"5da5fdae036a37b2\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"dab64cffacefc4da\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"bb3d3f90b2311b46\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"490a4d218fd81082\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"b2d316e96b375716\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"7ec293b705d612c9\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"736b825f9e28dc6a\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"9e5c762d20d7b93c\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"f63a76787a4afd6b\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"854f9cf156a9ec1f\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"450ef5025478f0d1\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"7515753a81629650\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"bd7e13ed26a2a058\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"f762526d48419095\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"c9aa09d5e71e905a\",\"/knowledge-medium/src/plugins/alias/index.js\":\"ea4eec166f2aa6dc\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"68911b5296357c32\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"461b673e9f12fe20\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"391a8d25e18d28f9\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"18a22b3dd5f5e36b\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"82c8219ccc092077\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"1ce9d88c34fc1c52\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"b9d89cba9057be60\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"5aaca2a7a4e5c63a\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"0140ae0d07213a64\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"7dbc599293871031\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"1a3640679a9a7673\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"cff487dca860f6df\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"25d96a6bc5ee963c\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"cde5b47e21161d05\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"9eeaad1770a2b411\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"34e14d8e8b9057bd\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"790ad67f64d60a31\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"d28e8b1206228026\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"ef6b0c3e380dbbff\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"a3467c421987efa8\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"03f8dd5221879101\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"c49df5fce7a3f149\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"9195abf830e2d72e\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"a95eb83101fd2f32\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"61b995c22e77dafe\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"36e84c3d5c3418a0\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"194a4bfe5f177f88\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"fb7545f505c1a18c\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"3bae2f0bb05aef07\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"0c274859dc0f6fd4\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"771f6fb2bc6a47ed\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"aa0e8552e0b4e15e\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"68e9124dc5721222\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"2694690fe0a867b3\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"18d541204b10626f\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"cc3a20eed98dd24d\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"3705111ca789c79d\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"fa789566e6dd4a0d\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"59ce57ebc137018f\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"7414ceb3ce2ac84d\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"59a70c15034b15d4\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"6b9b8b6ddd7cbf37\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"f3a399bd6bcdd6b1\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"f0993ba0c39b381c\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"87de8569a0ce2714\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"7314e829110b2ce8\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"8d1e679070950821\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"25fd7cabde6f1b7f\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"9ae6d8ad81d0d039\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"7b03d5aba0ef3096\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"0fd97e9f058a807c\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"1d727b0b91afc651\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"81abee0903d2b7b9\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"ab697a9ba40b63e7\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"f02dffbcebd416e5\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"e6743ec7d27f7651\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"14cc88bea7637920\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"14980f7acf49609a\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"34d3e4b125b19fb7\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"9c3636ee48e41fc1\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"36bd38a66581c59a\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"51f1a0b557ba047f\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"527bc8e96472d185\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"d6f394759f38988d\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"6d6a1c0b8fbc1e41\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"05b32a0e92e4bdcf\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"7c77dc8b9ac6ab9f\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"b711d8b4c20f2ae1\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"22ecc2c882af09e0\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"ccb30e973ccc9728\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"8dea24b9b12fbe90\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"526c8589f154c4b4\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"d172937c13934ccd\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"4c726dc351444d5b\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"1cdc91cc0cfa4fff\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"34654b593f8a14a8\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"6838604ac1e91c48\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"948d02d9a648e295\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"3e5284e2f5a16d8a\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"af9a80ff38b26c46\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"147a4a2b69bfd673\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"1320bcd8e9429b5c\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"bb7c43395af01251\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"f0f72b34f22579fa\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"d428cd2b9fd7548c\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"94f39eb2e4783807\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"6c95c756e61ff35b\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"63f12de6d21ab77a\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"cc2a23d31d8a79e8\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"8123d3128fdbf1db\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"2004af74248645b6\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"aeeeb3c23081ef25\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"be3fcf42fac1934a\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"8d9b14279dd65fc3\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"9fe15f96b8058ad1\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"9db78817f7289974\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"4425706741e2c696\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"469eba622636db59\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"32892c2b720eb751\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"27d204a7dc202b9d\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"d0f0dae41d45d31e\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"acec69645da389da\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"32402d4b1d6f0862\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"d10c75542e42bdf2\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"4ddad4b9b60f2929\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"e204a3a17ee7a83c\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"8186ad8e941cdef9\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"73c0180de1b1443b\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"70305107220c2e84\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"8fae05653530d3a7\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"7d61bb0f022f30c9\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"6c46e9ac745cb284\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"a089c2f847151b7c\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"f8d7e2ca5028f0a1\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"877f94f169726702\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"853cdaa7716dd2a0\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"3985df8da6f91c7e\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"d70e371f5e49bfd7\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"e0ad43b5d34718e9\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"e184deed3259d5cd\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"a82f9dedd463b833\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"d5561fda979d0bd4\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"93410df57c911d1d\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"21008c772a8d263b\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"57106927efd156fc\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"4ca08345b235edb3\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"66aaa3edfea9a2a6\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"a14718e7090099ac\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"aacce460e210fd7b\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"3cfde48ce55c2446\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"eada269799f172a2\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"fbff2aa3870a7223\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"620b0c257bcbc15f\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"886b3132cbf3f5b1\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"0018b9b01f623b5d\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"9b3124bb4a5e1125\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"324d256c9b87876f\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"f2b3b955cf7b8c07\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"a477f7d6ce2adeb9\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"736a3962db3761d1\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"61f9016d8047658e\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"2af912626e175e2e\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"5820d07d9a577d86\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"a6a080bbc74f67e2\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"b11ae845a51a0bcd\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"4714d68a1c7d390a\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"9dd5def4a21c58ad\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"b32a5a124884babc\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"b987ab61dba9cae1\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"71b8f236ee588b44\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"f9cf3bc99237899b\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"3e845b558d7af92f\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"811074fb8a2e8b64\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"0509706d634cd384\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"7f7ab1bbfca715bd\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"fc9acb252f26ba81\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"66f6f508758d471c\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"bce3492acbd585ea\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"028d0103c6f2b470\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"e729297ba01d069b\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"39e203ed77b4b45a\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"093f6a2a1f109ada\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"0384ccf9c40056ef\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"d51081f94bb6bffe\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"881449105b98b0f2\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"e3ac4574ee0799cf\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"c9474682629be7ec\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"c985a5f077c2b6f4\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"931fe65dae6794a2\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"75e5a8a7a7b0e22b\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"1042b23941de7c57\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"c33d478a0866d808\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"04b7dbf214c42d96\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"456014cc60446c37\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"15a4c96dd761cfa4\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"42deb71ae602b51f\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"c93b4f9754747ce3\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"1cf582619a733509\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"bc1e669d0e3e3e19\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"404c0303516e3fa3\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"2c915a62da23a79b\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"ad68174b7d7cc3ad\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"a9f8dfcb1912543d\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"d0e2a98ee90296a3\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"d2b1a18971b6aa30\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"f427c3378ad19153\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"10195549b2d5ead6\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"e4b17066b3b57b70\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"d2a1cea87571236d\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"eeada5eb9612e2fe\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"688490ec6227eddb\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"2c4ccad08b10c46e\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"01cf50474e360e10\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"3b69fdcca2b75239\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"79acbc6d22931afa\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"7ccf4442b686fe8b\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"b602257662f4223e\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"4faf2e6288189191\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"55c49e50b4dc8010\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"85810f600276c7ee\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"59e525945161a045\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"f7f73b122f0a767d\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"6064c5000aee9b9a\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"4f75d2838573c079\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"8eb32532cc3cc7fa\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"38b8376215bc843d\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"01f94cf457d27c0c\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"903103965d51c10f\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"39b9b947c8847117\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"d468cde1406c3431\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"95a0db92c76c6788\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"a2544ef6d1e9f5c0\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"99bd8a640e60301c\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"8ac8f3444cd92322\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"b0cdf67ec10e4ab6\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"47faca02333824d0\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"30f22eac73f4f33d\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"d46a203ea70800f8\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"0e8b86ce5ccebdc2\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"427d75e4269ed44c\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"bdd31ff4d09bf09a\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"ebfb671f5966b8ed\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"87f23169f559531c\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"cf299bfb9c2556f4\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"ea7a746193fac001\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"bfd3b007df387bd1\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"69e0625f37f41650\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"dbfcdacefb5d31fe\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"96f0c50bb8d158e4\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"9c8361f16d77a2c9\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"25484c42b5b705ea\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"8ed207354197fa28\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"7e3c74769eca11e3\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"a977f41403520238\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"d4124325004c06c7\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"fec32c8b4497461b\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"8258bec51c78302e\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"c82eb4eef88e3bad\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"d5ef500af18c5146\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"33fb841a889e1eb0\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"e58e8c5fbe965bfc\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"30f1e35b98091838\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"952752a2096709d7\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"b1f8504452d5a03e\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"89140fca9b3eeeba\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"8b2d0de81ec33d0e\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"0286fc08477f1e7f\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"fad14be0997999a3\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"48a17a1c0c2ebeb2\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"96e881c25eadd044\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"7de3c5ebbefb25d8\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"04012c596483aa70\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"22f9e3adfb8b3e15\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"4930879b85974eaa\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"7cee47829fcb065f\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"b50b6964b0484a52\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"168009d0ac322c74\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"88ba8629901cb92f\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"b3cece7bdebb7625\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"cab2edf30ada5ef9\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"79383dbb8711ce62\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"840488b1737f8fd4\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"160e2a31c024f880\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"7b0d2f2ad33da41b\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"7eab942619594f48\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"19d949481762bc65\",\"/knowledge-medium/src/plugins/geo/index.js\":\"484bb86f9eb73044\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"769ee129754acfac\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"f56621749c9be4ee\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"c72bc04084849403\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"b60ef9e614ad07ff\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"621b0d89975a6ef3\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"1a44b3a420e4b180\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"7941ac6eed6233e4\",\"/knowledge-medium/src/plugins/geo/query.js\":\"4d3dc2841a39b452\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"538f1e18c0f80c8f\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"3902a9cec631e84c\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"376173285abc7884\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"ff12fdcb85af0aa2\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"3a057e41568b9ab0\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"cfced147082d8e80\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"c02b62be9b40fc30\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"1bfe847859fdb9e3\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"f19e055990c4f382\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"dce868aaaf8989d8\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"7a1640f671da0fbe\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"2953491186aa26c2\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"9d7ad532cc184027\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"058f62c30ea353c6\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"95b93c2c9c4b9e76\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"fa72fb2d77cb944b\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"5191898b98d5e4b7\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"4a6dff161d9778a2\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"a4581bf0205af04a\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"3cefefb5308ac439\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"b5b556e5d9771ba5\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"4c5778fba8cde0da\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"0a48cdbc3b6b500b\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"ea19c71815a97aae\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"c9211de8621dc5f5\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"3e90902341fa9098\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"84894fdeb6064910\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"7697b9c822c4c1bc\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"f35a34a87e1397cf\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"7f6f32b75c7ce17d\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"3ceaa14d5181339e\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"2bc02ff474901c35\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"56b9511cea4a608b\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"47e1704126c41151\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"3a4f328816c0c49a\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"2c091dd6c2671f0a\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"d21f1ef1a5fc7b76\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"dddbfdfeab0a61b9\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"9efc075cc411d478\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"1a45793b40ccd28d\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"a7433cf21cf78f65\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"bb89bd0557871fad\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"ee1a615c70d7c07c\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"2901e3c3dbb56910\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"092bf381b6730bd8\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"c0d36644bf992f12\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"03f6265e726c86b3\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"dd8252c6128e0985\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"16384da87ea65f57\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"e3c0e5384593ad3b\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"939fa6a9d2ba1f1c\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"3163a39a795d2440\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"284db354bedd39bc\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"5c2dafef9a2bc592\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"771adc6b67c0ffd4\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"e1a4d0b6b642bda6\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"a19cbe0dde5da1a9\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"b3ebc031370206ba\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"f883d8e9fc086b12\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"57d57eb2d61045ec\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"f4f362b30045dc61\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"7564410b5105729a\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"95aaf02af260bd50\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"8a96b49223d9822b\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"6d80d3421cf0a258\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"9aa7fc3db22f654d\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"0b21ba22717d90f5\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"98172d2fe627b00d\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"8b9acb3cce46b32b\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"c897d04091abc0c9\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"fad4cd5e668e7cb3\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"b4a04cb16c41c307\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"dc75ed84018d4346\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"258b38952a1ffcf0\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"7b57d0334a31ea99\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"17581fc2cfbbbad1\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"17cedada5e3f71c0\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"03563c1f9e798d71\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"ff007598dad3fb81\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"4abc0eb25d7e9285\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"3db2e3eccc998719\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"fe85d1df2705aa52\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"aa41a46bcd946071\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"6b05db51f095e159\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"ca533566b2be7da2\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"bf809b6654697a16\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"b88ea1d79f127010\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"0fa22a3341dc98d9\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"1b994c1192bed5d4\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"737ebcad965f64a2\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"f92c562b85ba60fe\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"564dfdb106aad1fe\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"37e0c977fb80239a\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"6b3d6dbdc90752b4\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"466d58878d213fe6\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"5e042208120ad18a\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"fa3ab88a983f2e39\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"d3069692ca84319a\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"9e43cbb736eacb20\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"7debd39e8d3b535f\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"0e8b639845f68cc6\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"2fa2aa3ff2e9b600\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"9b71763a7a1b3554\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"238f8ef5836a1ece\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"11b13e1f9c3bd593\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"1bb98ba936f23f62\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"d4da3daf713f4549\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"6751e2ca298bfbe5\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"be144d820c5e98d6\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"9236689585135e5b\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"219d31fa791adc03\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"db6e4dfa6eb3da03\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"24891d053e8c61ce\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"3a4ab44e5d112d88\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"4402ff7c42b9a7ee\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"dadb80ddec3597ac\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"7b590c3e2921a0e2\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"383e9324d0de3979\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"52cc1d2dd924daf3\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"e6e8cfeddb2492e1\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"9937d3fd7a51bc83\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"0cb04bbcfc690feb\",\"/knowledge-medium/src/plugins/recents/index.js\":\"25d515d658f9810f\",\"/knowledge-medium/src/plugins/recents/target.js\":\"7dcaedc7c583c089\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"a6cb6414c50b69d5\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"7e15763471d485e7\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"e7db6b1d1b893126\",\"/knowledge-medium/src/plugins/references/index.js\":\"05982ec453050bbd\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"bbd6d84861c690ec\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"525bf4017e1ba720\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"1ff49d3708e878b0\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"e5e2f267de5b9db0\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"d0ee1c516775db9a\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"af0ff3d333849b4b\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"9e9253c69db4f12a\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"50e2f8a1bbca4452\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"6d8abce8d6c41ae3\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"0377b2727e0dfc36\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"35273810c5f0d634\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"d5d74dceacfab2fd\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"3f9e960946d6712f\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"ec54e6e2bae760a0\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"c4a1eef1379b1ccf\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"4daaef61d2adb8bc\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"0595ca6b805b710f\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"485c33da53a5d423\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"63616d01a642a4a9\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"59e4d15f23d8fcdb\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"6067c299f78366cf\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"54bfc25363e8278f\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"19f40b260df0295d\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"0d1873f66bcd2e37\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"34ba52c3886fb219\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"ece507a889a102fd\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"0d6ef4e6aff797f3\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"3d3ffff2c6bb7c06\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"d46b1b0343f982fc\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"d2742b7c031dfc10\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"1316bfa90327aa0e\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"8ed306e4e5d04c97\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"089b69a35e555868\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"a306b09123da7910\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"5cd543cf63a28094\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"854957382d37ff69\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"13680badc263e068\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"18fdea79b1f8922e\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"137198134055a492\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"ee749b5628113e1f\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"6c538e5382589d43\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"ced12b601b829768\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"2073842966e8cddd\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"79000f606af31dcf\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"e0b711c36425ec63\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"6ddcc2a4138b1c97\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"535f560a994aa866\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"a00d5e94be88e684\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"4a7c537e230a3db4\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"d67039c936cc669b\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"ddfbca1b28a9ef95\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"47b4991ce58b9872\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"9195f290a44b91b8\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"f8c9ddfdb13b3654\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"590c83de3f7659dc\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"815c55495ff0f45e\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"70e05df4b6cbf527\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"4c4f9cee075d7f84\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"52fd75987cbbef76\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"1b51c85977320b03\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"48a8d91114ae0fff\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"40e5b209393e4f2d\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"089c79fd8b667f52\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"26e247fffb3c7b0e\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"ebc2eeaf2e6f6ced\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"c6014041cf3bf6d4\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"d48ff1fe33e9db1c\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"3f0ad1cb62445976\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"cc122c23c971055b\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"ffd52cefc919f204\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"392ae2c3bc6327e4\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"e74d2764d81aa393\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"5c56baacbc1164ec\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"de79a038a6d4873b\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"c27d579d7ff85cb3\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"02ba32489b079149\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"ffdc80dcc3f049ee\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"2a46f7571edfafe1\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"9d9101ee767f92c1\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"c76b7a8714fc3336\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"4f01f7e2ad223109\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"4ad96b9f0553bfff\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"76438909457263bb\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"fbf7e2d9fd346a6d\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"7650a41924bc8e64\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"2c7e1cd3dd72f0a2\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"7c55ca9ae0565ee1\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"3dc7a3fee8de874c\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"462a5924f8a7fde9\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"6e38e3e7d61690f2\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"09741a6103d13f8a\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"a129147daa254b11\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"7745fdba2b8222f7\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"933ced804bce45f6\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"c5ebf0b3d4742e77\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"5daf4049ef9c2fcc\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"4ea0b975de43d2cb\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"6a71fc94f397e0ed\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"610668e25d230a15\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"edc45e2b3b7c88c6\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"1ccd8698f188c4a9\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"2d30d2c91075f5be\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"5c8089daf84e6f5d\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"1f5a495932088648\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"1ca20f76fa55ba0a\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"e92a9e3d813d0233\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"dc03214624ef691a\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"687e9871cbc5ce72\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"2363a82bd645afaa\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"e933500085f6ae50\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"4b5db5bbaf8a0c25\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"8dcb3aa8716c542e\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"ed7986f8723873d6\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"c149f884ba895433\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"ffa80ad77018aa33\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"498245247d9ee562\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"360c9f5bdf47f309\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"619318bbac230ada\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"781035859f04c32f\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"04acab980252959a\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"64b26828996919f2\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"c1361d5ff0f36987\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"55510be882da5a1c\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"73d8c113facbb279\",\"/knowledge-medium/src/plugins/tables/index.js\":\"00466398347b7497\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"fe626d697adb9948\",\"/knowledge-medium/src/plugins/tables/model.js\":\"4ea26718979bdeb8\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"487f4102a92ab666\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"f2d186c1038f0f90\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"1d0590d9658c4011\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"4900bd611cd3b23a\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"8bacfc47ed0f67e7\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"6ad9ac5a7b7e19fc\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"fe3ca1711059fcbb\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"6f841ff9a9705cb0\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"45b7bc91e3bf1b0e\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"e1b173a899319e19\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"c30f50f2e347cd94\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"894301e914389254\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"98498554eba2b0c5\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"37392f38ad26a382\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"8a9e8f40ded8f2b3\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"fa1d7c9992486670\",\"/knowledge-medium/src/plugins/todo/index.js\":\"6ab0e501eff2617e\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"49898af0ec01d08e\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"1bd76fde2d15322e\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"ee59b6cbe1fefa94\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"a461339492b196d4\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"b580f1ff6c1a0b86\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"e01943bb2a129cb5\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"2799f6eb28231531\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"336fcff81e7178e6\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"0378795c1745b870\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"e7e888a054a57be5\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"23a17a3f76b49242\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"65c522373e54687a\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"8938409ab2bab348\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"e9bb4d3bae717b39\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"96ff4db0fddcf2ee\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"b52c944b1a6ff50f\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"602ba3579dd8ac91\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"cb1d2b5737316f60\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"c9b99f2004b09dfd\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"c99de34c755264cd\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"d2f9cc3f4c74b0bd\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"5950c7187d3b73b4\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"676e81ab3b3ddadc\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"e101f9555197fc33\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"4ff25be9725ddf26\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"6ab858ae6a453843\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"9322900249c2cdc4\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"f20677e75ba0c138\",\"/knowledge-medium/src/registerServiceWorker.js\":\"60afb4025ea1079b\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"ccea638a77b9e7d3\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"b2cf668f8b9271e0\",\"/knowledge-medium/src/services/authStorage.js\":\"6ca159f6d152ae7a\",\"/knowledge-medium/src/services/powersync.js\":\"e2f57aad86bb67bc\",\"/knowledge-medium/src/services/supabase.js\":\"75afa4f87a2b5b80\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"c54af038dfc6e600\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"07b09c0b4c80c22d\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"f3b4ae93ebb3b3a3\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"7db07240af53b40d\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"694e73c7080e7649\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"a0b46b76ad48d6f0\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"af7c069208f921b0\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"8e1ebccfdd8a7902\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"44c0e6ed46fdf1c0\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"40ef3bbcd97b37f9\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"0dc9eb7197a7fc2f\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"9d0cceec1a41a186\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"34d43180e1618076\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"1102fe7bade72ebb\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"eeca330804f07903\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"a46a0cf625ca3077\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"6d509501dc783cbe\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"577ab6ea539d9f82\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"08558885bdeefa69\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"6c5208615ae4eb33\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"0370c6b900fe2480\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"fa7c87ccfd48b5f5\",\"/knowledge-medium/src/shortcuts/types.js\":\"ed731a6852632752\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"c24b0e1b4e1f84fe\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"f51e183e721b7c2d\",\"/knowledge-medium/src/shortcuts/utils.js\":\"1a4e000fec52e73c\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"c7137e308d07306a\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"fe51cb0d893f9102\",\"/knowledge-medium/src/sync/byteTransform.js\":\"f9718e23ace70b6e\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"5f4946f240509a0f\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"11e75b9bfeccac6e\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"f320979bda4679a4\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"b2f491458e996eba\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"8d7a4a852edb5067\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"18c81f56c0cc5b3c\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"70d39d6a1c9ab270\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"aef279330026a21a\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"1d590212bf948677\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"3932a588b94cf47d\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"1db6ec625f26fbc0\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"39b4240d1acfc744\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"3599a2a0314db47d\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"290708ca3bf1e1cd\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"d2d70b9e9f168447\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"ddef7c7cf8311eeb\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"1047c701d5233230\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"a8d6c29db8848499\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"6caac8c8f85d540f\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"f385833709b9d8d4\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"33f6967b8105c4e0\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"10bd006f1462969b\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"b533f6a525c4b570\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"b4ccca8597f4a977\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"c2c73a19c475d436\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"2e22a080a85f652e\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"8c23ad6b53862898\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"e62d4564769ed497\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"0aca7940fa4bf14d\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"1dace529c407dc1a\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"ed98e6d7a885090a\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"43d5ca296b599138\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"d8407de2c0059ef6\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"b82ae1522acbc22b\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"b86b3a00fa6f02f5\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"e4cd6b914869987b\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"6c04d80a6cdb6fa8\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"7a39c99ea2823fff\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"fbeb926b136fd803\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"6d87455127297c24\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"eba4852fa22f5c02\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"d867eff9f4573cd9\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"9475861f0b7c5d1a\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"e308819d317be5ac\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"975ad546b47acee2\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"70a93ba59e0b4ae6\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"1193e937c85f24e8\",\"/knowledge-medium/src/sync/transform.js\":\"fa3fd1c72a6cae13\",\"/knowledge-medium/src/themeBootDefaults.js\":\"a9154bb4d257be5c\",\"/knowledge-medium/src/types.js\":\"f1965735a8d1ba25\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"6efa71ba66fdc380\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"1468ef6259fc648b\",\"/knowledge-medium/src/utils/array.js\":\"bfb84de12e0d50ad\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"a97a6f62942ce7e1\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"ddb83da37efcb113\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"96170a980f727f32\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"aaf24418e89c9a4b\",\"/knowledge-medium/src/utils/callbackSet.js\":\"f58558568b36f507\",\"/knowledge-medium/src/utils/clientId.js\":\"8909bfb7001a5c0d\",\"/knowledge-medium/src/utils/codemirror.js\":\"272fd0325463a113\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"78b02e3175ff6420\",\"/knowledge-medium/src/utils/copy.js\":\"722aca19249b2c3e\",\"/knowledge-medium/src/utils/dailyPage.js\":\"4ef53c3a773e38ea\",\"/knowledge-medium/src/utils/dbForensics.js\":\"74709210c350e618\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"58a380b62d54dbbd\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"d30fd246fb96ba22\",\"/knowledge-medium/src/utils/dialogs.js\":\"bd5bfd8aebe3198f\",\"/knowledge-medium/src/utils/dom.js\":\"baab092b3c658700\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"86dc462fd2637c38\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"d01996cea50bde19\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"299b7948377e30db\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"db1a0a5754fc4514\",\"/knowledge-medium/src/utils/flipSlide.js\":\"13e27829c2800067\",\"/knowledge-medium/src/utils/fnv1a.js\":\"8a7995276f64d0c8\",\"/knowledge-medium/src/utils/formatBytes.js\":\"ad916b4fb5ea5b0b\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"d1fb72f3442490bc\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"3f311e04091aef43\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"8f48d2a3924cef0b\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"aad097a2d2bd33ed\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"a82d41198ecfb7b3\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"8c60e59e4aa5bedb\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"857f7bf550b6f6c4\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"b9dddac74dc3c2a9\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"dc6efb5688d052ac\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"2eea985a75acf79c\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"7b735b90cbad211c\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"b7ddaad1d666088a\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"9092f38a2c350f67\",\"/knowledge-medium/src/utils/markdownParser.js\":\"89b9f14872266f63\",\"/knowledge-medium/src/utils/memoize.js\":\"d228591f9f9d7697\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"3702e18ccdcda528\",\"/knowledge-medium/src/utils/nameList.js\":\"08e7a4051301292b\",\"/knowledge-medium/src/utils/navigation.js\":\"648e250790bacdf0\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"c9a5388126cdc645\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"ff3ee31adcfa907c\",\"/knowledge-medium/src/utils/panelClearance.js\":\"0d735a09f686c676\",\"/knowledge-medium/src/utils/panelHistory.js\":\"1ec9d146cb6953ea\",\"/knowledge-medium/src/utils/panelLanes.js\":\"6365860f83ad7320\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"b5dcd0399ab60ae6\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"53609fe522c1f34b\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"2db796e4bbb07f51\",\"/knowledge-medium/src/utils/platform.js\":\"4ce845f3334848cb\",\"/knowledge-medium/src/utils/pluralize.js\":\"4c7d15785469e3e2\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"b51206ce36c40613\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"b524228a2bdd36d9\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"56c8fa4f3ddbe085\",\"/knowledge-medium/src/utils/react.js\":\"ef675da9a4d3de13\",\"/knowledge-medium/src/utils/relativeDate.js\":\"288a9c59407f595b\",\"/knowledge-medium/src/utils/relativeTime.js\":\"7c49f81d50ea8829\",\"/knowledge-medium/src/utils/renderScope.js\":\"b14d23c88b2de18c\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"d0cd092c03bbe831\",\"/knowledge-medium/src/utils/routing.js\":\"861709e74b80fb55\",\"/knowledge-medium/src/utils/safeMode.js\":\"8b7576ae6ba00e76\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"49d71fedc0ab2c22\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"0f6b595329e16a63\",\"/knowledge-medium/src/utils/selection.js\":\"a3bda8485fab1cec\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"b50f8ccd5da696bb\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"088b309e6db8760f\",\"/knowledge-medium/src/utils/state.js\":\"afc5fbb75973646a\",\"/knowledge-medium/src/utils/string.js\":\"1713fafb085d79c8\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"331ef44a34f3e90c\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"1f3caeb79383b6e2\",\"/knowledge-medium/src/utils/toast.js\":\"6d9cf9ffa634c8cf\",\"/knowledge-medium/src/utils/toggleStore.js\":\"bdcccc0d573ef674\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"662d8b6f70a76457\",\"/knowledge-medium/src/utils/userActivity.js\":\"cb9a05c1fb5a9b2d\",\"/knowledge-medium/src/utils/viewTransition.js\":\"69a0ace1a130d34e\",\"/knowledge-medium/src/utils/viewport.js\":\"4df3bd672b4fa119\",\"/knowledge-medium/src/utils/webLock.js\":\"286c6df795be32f5\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"c8e31880d07713e8\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"14b6aab538cf1128\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"21cf19a5ab4f5c70\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"268c29e1a8cb69de\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"b45d5cf52f7a9306\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"d2e43858f14f147d\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"2117e5eb1c9e9b19\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"64bce1938e0292ba\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"8ec4d1ca55f5ef5d\",\"/knowledge-medium/src/vendor/react-dom.js\":\"e30587181dd49ab8\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"bde30d1471da43cf\",\"/knowledge-medium/src/vendor/react.js\":\"bc32e92c27d78e0c\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
