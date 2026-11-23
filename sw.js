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
		buildId: "9afa1200a278-3a242662",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"b88e65737e5c1c77\",\"/knowledge-medium/index.html\":\"b88e65737e5c1c77\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-BS7mEYD-.js\":\"b41848abbd7520a6\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"939d88e09bdc79bd\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-7sPZasPM.js\":\"d1b88fc43976fba2\",\"/knowledge-medium/chunks/FacadeVFS-DMovdDIl.js\":\"21ce402f390adde3\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-BcQAgFFE.js\":\"b03329905c56c6d6\",\"/knowledge-medium/chunks/MemoryVFS-xQQUR6k6.js\":\"cc42a3fe90a6a890\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-BmEvnsEy.js\":\"16e48339686cee98\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-BXGUdc2W.js\":\"07991ac7ac923a92\",\"/knowledge-medium/chunks/Preview-DiXDdhfi.js\":\"14fe7d06f4e87a35\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-CjG6-sET.js\":\"c6114c449d383223\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-C01QKo6F.js\":\"cb6fe9552f6a7334\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-B_6YdeZG.js\":\"998e984fd6e813d7\",\"/knowledge-medium/chunks/react-BqaEFKMN.js\":\"acd11e791a2a0c56\",\"/knowledge-medium/chunks/react-C2PoYsrK.js\":\"70db1e7ab78fabe3\",\"/knowledge-medium/chunks/react-Ce-eRUDZ.js\":\"2f2af58ef821bb72\",\"/knowledge-medium/chunks/react-CqWyBOCP.js\":\"a58b1460f8ffc4ff\",\"/knowledge-medium/chunks/react-D6ih8PJy.js\":\"24d78b1c1edbcd3f\",\"/knowledge-medium/chunks/react-D_Efvyn0.js\":\"a224e9cdb52daf16\",\"/knowledge-medium/chunks/react-H8aXk6lq.js\":\"45fdb88da7d06368\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-BSYbLSVx.js\":\"5ea9a9794766fd97\",\"/knowledge-medium/chunks/react-dom-server.browser.production-RsXUoBvb.js\":\"20fe8753dd134d64\",\"/knowledge-medium/chunks/react-dom-server.edge.production-Clm_jz7B.js\":\"9dcfd8a7f00415fe\",\"/knowledge-medium/chunks/server.browser-BI24mHcw.js\":\"51b8392cbf2af9e2\",\"/knowledge-medium/chunks/textarea-C64lgKmo.js\":\"09c8d1071ab82e22\",\"/knowledge-medium/chunks/ui-CitXLb5I.js\":\"b14a86bb52080229\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"9ee381a24e705a06\",\"/knowledge-medium/src/appUpdate.js\":\"115e29ed65e7d374\",\"/knowledge-medium/src/appVersion.js\":\"e9071b37f3614777\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"30b5a60a7dabbc2d\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"acdde4ac6f477c21\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"5ca3c1f632252471\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"f02052d3c5864741\",\"/knowledge-medium/src/components/BlockComponent.js\":\"7caae88d1ad2014b\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"d0fd3687ad991296\",\"/knowledge-medium/src/components/BlockEditor.js\":\"ad73a0202113939a\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"fccbc069a6429879\",\"/knowledge-medium/src/components/BlockProperties.js\":\"0219154912167d32\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"48dbbc75bc79c200\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"2ab1e636987a4b5c\",\"/knowledge-medium/src/components/DividerHandle.js\":\"77ff54bc1764aa43\",\"/knowledge-medium/src/components/DraftEditor.js\":\"b96598c8e70a3567\",\"/knowledge-medium/src/components/GutterPill.js\":\"5b683cc180fc2e4b\",\"/knowledge-medium/src/components/Header.js\":\"0f792887ad4fc779\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"c5da95a2760d8d17\",\"/knowledge-medium/src/components/Login.js\":\"dae0ba557ab0b8b0\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"7db88d9be5f83d12\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"2bf326fd2c6342e8\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"18823cfc216bd4f9\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"6ae6eb6719dffa4a\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"79869ff2152bb51a\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"6e0db9d39945a008\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"e643be7ce1933214\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"72320480b3a45755\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"722c78f588b9f04d\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"635f1621f7458b24\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"aeffd18038588f44\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"687ed63a5965e9b6\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"4de0df91c771ea81\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"0f9979cb00cf97c6\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"1d19ee1be62258d7\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"efd14a5851c61add\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"644d457e506d84c3\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"a1938fb390d6cb3f\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"21ca47b922a52227\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"25ed8e670f3a6f50\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"3c31e74e2933d326\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"8819be9fd37ce179\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"6eb8d450d4045ade\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"4b0e86127996d8d5\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"b73fb1f368666fca\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"909edcb9c1d5ccfd\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"08cb2282358f786e\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"1488f45abbeec36f\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"825ada814f04f318\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"2554fdf1aa7328fe\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"f3f966845c12e447\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"5da2281bf4ea2562\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"6b3736f456c08a1d\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"1ef011886204f75c\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"809e550badf206bd\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"1228687754bd93c3\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"158b63173a030a50\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"71de89df0ffc749c\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"8939527d55343fdd\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"5625c014432eca1b\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"2d5ab0ff94359364\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"53e1ad37c096b562\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"1d8315780ce5a753\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"ddf4af7a727c19ee\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"8d4aa87beab293cb\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"7f897a2e21ae279e\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"33a00312fe317900\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"52ebda62f7d6d247\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"0afe5a5d399c6cc1\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"1c78b9ba17b4e6df\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"d170313eab00b9e6\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"e154ac2e23d0a851\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"7141da9301f9b886\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"f10a18e99521123b\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"68f0eeb63179a367\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"520c8fd426e02569\",\"/knowledge-medium/src/components/ui/button.js\":\"815b70d53d877dc1\",\"/knowledge-medium/src/components/ui/card.js\":\"76e0d1da39f09826\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"4eca9b7ea8f4a892\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"bc47a3d2f0c9f76b\",\"/knowledge-medium/src/components/ui/command.js\":\"ddcd90c4ff1699af\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"2c9c8b3134d15c75\",\"/knowledge-medium/src/components/ui/dialog.js\":\"8dff2d0392da985b\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"54787eaec0f4076d\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"45fe83fd50fd99d5\",\"/knowledge-medium/src/components/ui/index.js\":\"bb75a3b50da7dc49\",\"/knowledge-medium/src/components/ui/input.js\":\"a09222039c2db72e\",\"/knowledge-medium/src/components/ui/kbd.js\":\"e966a1aa10875e00\",\"/knowledge-medium/src/components/ui/label.js\":\"75a26b72bd359520\",\"/knowledge-medium/src/components/ui/textarea.js\":\"a7152856f049c967\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"35658ba82b1b43d3\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"906f5a11074ce3b3\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"ac8617e398b98e6b\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"c480eea6deee0c5c\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"182691f97c7e4837\",\"/knowledge-medium/src/components/util/error.js\":\"591d90a72fd36f30\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"966492b42a1756ec\",\"/knowledge-medium/src/components/util/suspense.js\":\"905a9693e98f8fff\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"1b56158c46e709da\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"b18cdfad08abdec2\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"94d743f44c449922\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"97afbd5fb13dea58\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"94bb82eb2990b372\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"6410c03f1bcd7103\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"0c461dbae8b57cb3\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"ea2d054d64fdb587\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"d6e2337cc8106988\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"4cf2a2bb57902f98\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"e2946be9ec609db4\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"6d86300c1d813904\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"12cbdfbcbf7e6748\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"d2ee0c6c79b53761\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"c4ba1dfeda5023ff\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"70c0831e4bbb862f\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"e070f7af1fdad0fe\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"026aa14f94e382fd\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"ee5a4b47cadd93e9\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"75f9cb9cdd3fc69a\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"ea2e7cb9c5c98df5\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"a36679bc245c6070\",\"/knowledge-medium/src/context/block.js\":\"c65029c3ac923c04\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"d643f3cd2bee4776\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"174479f88cabcc57\",\"/knowledge-medium/src/context/repo.js\":\"b10bd4d48d215e63\",\"/knowledge-medium/src/data/aliasClaim.js\":\"e41b428b23e43733\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"d50296173b6c1762\",\"/knowledge-medium/src/data/api/blockData.js\":\"1418aafe1ffb87a0\",\"/knowledge-medium/src/data/api/blockType.js\":\"13b7e5170a9fa05f\",\"/knowledge-medium/src/data/api/changeScope.js\":\"c381bf93129cc18d\",\"/knowledge-medium/src/data/api/codecs.js\":\"eaa1dba58ef8740e\",\"/knowledge-medium/src/data/api/derivedData.js\":\"a5e2aeea3f7348e5\",\"/knowledge-medium/src/data/api/errors.js\":\"0663ec98c6b593a3\",\"/knowledge-medium/src/data/api/events.js\":\"c989b93bfb0441d0\",\"/knowledge-medium/src/data/api/handle.js\":\"bf79240c120180d8\",\"/knowledge-medium/src/data/api/index.js\":\"f014988a92c2b1cc\",\"/knowledge-medium/src/data/api/mutator.js\":\"d6d42bdf87b383b1\",\"/knowledge-medium/src/data/api/processor.js\":\"f721101ec4662b43\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"6695334ef5820807\",\"/knowledge-medium/src/data/api/query.js\":\"e7999048b101bb6b\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"05d4dfc52a067cc7\",\"/knowledge-medium/src/data/api/schema.js\":\"bf79240c120180d8\",\"/knowledge-medium/src/data/api/tx.js\":\"bf79240c120180d8\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"60b005d45f1bf3c8\",\"/knowledge-medium/src/data/api/user.js\":\"84476dcd5ed36d37\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"9276a8d06c107740\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"525cd1fa7ee4d00b\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"22c44d7950a7e9ff\",\"/knowledge-medium/src/data/block.js\":\"9692d062a7e0e218\",\"/knowledge-medium/src/data/blockCache.js\":\"cb65288403b29e14\",\"/knowledge-medium/src/data/blockId.js\":\"1cc8f00193f8701e\",\"/knowledge-medium/src/data/blockLiveness.js\":\"32aa43ed1e2d3a8a\",\"/knowledge-medium/src/data/blockMerge.js\":\"c26dc9d4bbb7d22b\",\"/knowledge-medium/src/data/blockSchema.js\":\"e621cb8e5edc8df1\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"c1d10f54bc94f891\",\"/knowledge-medium/src/data/blockTypes.js\":\"8f1f837f71a9205a\",\"/knowledge-medium/src/data/childrenView.js\":\"c422b3c7e975257b\",\"/knowledge-medium/src/data/clientContext.js\":\"8aebb2f287a48138\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"e38651a2659e2f4a\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"15015609f6610499\",\"/knowledge-medium/src/data/derivedIds.js\":\"cbf76081c296022b\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"f6dde874ee022254\",\"/knowledge-medium/src/data/facetBridge.js\":\"63e436f171e5d010\",\"/knowledge-medium/src/data/facets.js\":\"17ed4f7ce539a56c\",\"/knowledge-medium/src/data/globalState.js\":\"d8ea724cf92b08f2\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"5aab095b7ed0a1d7\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"af2cdb91f6c51b31\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"82b598f3d5187ca1\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"3a6dba14fe031c55\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"dc412c32e4ef58a3\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"83db58b812afefa4\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"af0175938d87049e\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"471d0a0e9d2881dd\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"d31db7b3fc829a69\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"c224501ed98020f4\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"f44a17bff81893a2\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"23fc3a8dbcb22b87\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"af5f0cc89869bae9\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"30051df8dcfa26bb\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"5cdd4c557c4c7774\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"229bf6780db0c0e5\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"ce0873f41aead3b7\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"4c88e0d3669497b5\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"701b1f722847075f\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"5a3f63bbf3eaa962\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"0c850bf2248212d8\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"cf7fbe5374e77b9d\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"2ee28bf944b00d4a\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"abef0a937400f7cb\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"f0571415ca1c4389\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"f8e152d846c18822\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"b8895b95468a46fb\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"e714bcca29251810\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"20e2121f0e3bb22b\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"d82d19795ec4bd44\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"cc182d7a6eb83cfd\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"8d56b3876bcf696f\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"aaeebe898e7dc441\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"adb5c8bf64f5b7b1\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"ac206a8de9ac5d8a\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"48af0d6e933383f1\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"9dd2f4fdc7823fe8\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"f27c58ac1d62775a\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"0c7c5b54d3066d7b\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"ca8e51ebc6faf140\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"b2ff6fb64799b832\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"45c9e05c8fe7dc75\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"40dcd2d8c039b595\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"3f0d9a450d350d43\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"d0fe16830c39164e\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"9332d8c324c8c1bc\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"e117a4c489a23576\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"8a4ff2f322fdab6f\",\"/knowledge-medium/src/data/invalidation.js\":\"c231077a058e5992\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"a021a7087bf5e865\",\"/knowledge-medium/src/data/kernelPage.js\":\"c942b0e9d07259a0\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"2c16524cd98c115b\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"4eb4cef0ffcd09b1\",\"/knowledge-medium/src/data/localDbStorage.js\":\"629a1b841165cf3f\",\"/knowledge-medium/src/data/localDbVfs.js\":\"d4f85e2be727ae76\",\"/knowledge-medium/src/data/localSchema.js\":\"5cf1ca7bd04e2b45\",\"/knowledge-medium/src/data/maintenance.js\":\"bad6b7037667872a\",\"/knowledge-medium/src/data/mergeProperties.js\":\"d4625bd7d24a7c59\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"6eb461d4ff567dca\",\"/knowledge-medium/src/data/migrationsPage.js\":\"c3998370464c591a\",\"/knowledge-medium/src/data/mutators.js\":\"98d55196534f75e0\",\"/knowledge-medium/src/data/orderKey.js\":\"652f67d30a4a32ff\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"48ded9b78c8dc701\",\"/knowledge-medium/src/data/outlineSurface.js\":\"bc17bd226f2b29b3\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"c0b18dd200943128\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"ad3caa5b4f714e06\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"17cb2af87535f07b\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"2ed23ba77f78e8be\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"a0d9c546ebb2d1ee\",\"/knowledge-medium/src/data/properties.js\":\"694803f04208c0a5\",\"/knowledge-medium/src/data/propertiesPage.js\":\"f93dd321cb267689\",\"/knowledge-medium/src/data/propertyChildren.js\":\"6fe57e4ce838c1df\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"bcc017d28372ce62\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"dc8395de82d6abd8\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"647f3a15dbc67024\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"b82c491a1383ee08\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"4e00b75b512f3f26\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"ceeccee96eb29b99\",\"/knowledge-medium/src/data/propertySeeds.js\":\"3c4ef4a06553bf1e\",\"/knowledge-medium/src/data/recentsPage.js\":\"822ffa2d5ad0e306\",\"/knowledge-medium/src/data/referenceBlock.js\":\"28b5cec53563765e\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"c6a384e593ba23b2\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"710291813a0c6777\",\"/knowledge-medium/src/data/repo.js\":\"e700012b0561a637\",\"/knowledge-medium/src/data/repoProvider.js\":\"c4ac067225ecaf70\",\"/knowledge-medium/src/data/rowProperty.js\":\"4110a0bdba9d1335\",\"/knowledge-medium/src/data/searchFilter.js\":\"67a0c63e5940d3cb\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"237c1428bd64eb76\",\"/knowledge-medium/src/data/stateBlocks.js\":\"fae56ec103ca20b5\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"2532d9c044d52cde\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"cb5cf6d0d8270a46\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"fa759a066d16c135\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"6062878d4f45c72c\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"8fd8acd92df3e208\",\"/knowledge-medium/src/data/targets.js\":\"afc331f6b469fe65\",\"/knowledge-medium/src/data/typeColors.js\":\"f654a3ce5fc8b6ab\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"6ef2733744eefa9e\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"4198f997443be7ec\",\"/knowledge-medium/src/data/typeExtraction.js\":\"06fc7ab9216cbd43\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"3274937cc2a08270\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"ef2a565a530c0cf7\",\"/knowledge-medium/src/data/typeSeeds.js\":\"a2862342d5fba61d\",\"/knowledge-medium/src/data/typeTagger.js\":\"0dac885a6f4e901d\",\"/knowledge-medium/src/data/typedRecords.js\":\"1022371d6df5970b\",\"/knowledge-medium/src/data/typesPage.js\":\"fd1d447404e0ae12\",\"/knowledge-medium/src/data/userPrefs.js\":\"20f584515965961a\",\"/knowledge-medium/src/data/userSchemasService.js\":\"51c24ab27a00dff5\",\"/knowledge-medium/src/data/userTypesService.js\":\"c066891531c4a365\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"eec241b3c217332e\",\"/knowledge-medium/src/data/visibleChildren.js\":\"7dd67f3db903ca3f\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"4931a754c31c15d8\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"168ced7e763fb832\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"51b17b58d41c64e4\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"65a708eb068bc560\",\"/knowledge-medium/src/data/workspaces.js\":\"4d5e5d898f001587\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"3f4448195d791b86\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"93b49a1fc58d350d\",\"/knowledge-medium/src/editor/atTrigger.js\":\"9515c881e6761210\",\"/knowledge-medium/src/editor/autocomplete.js\":\"91f4e1731c3f0391\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"6d7b59efd0660462\",\"/knowledge-medium/src/editor/contentFlush.js\":\"c816a39c3013b3c3\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"6144a593c4e48809\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"ab3eb93686c12444\",\"/knowledge-medium/src/editor/insertImage.js\":\"f8d125df54ecf895\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"8e7b749bbd6b4efc\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"5e9265db87ad6e27\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"3771529036d42069\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"9efd5ad5b54cc8fb\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"c13602872dce0007\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"51d17337ca99be15\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"60ad8a17bc036ba6\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"21e3d60ec5f05b92\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"75efb244e0cae128\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"2c29c65d1f3234d1\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"ae099851fea69329\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"e5e58ad5047bda37\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"568a6224e99b5e33\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"a115dcaa5195e56e\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"057784a0966d9bab\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"7ea02c6087bb95b1\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"36e92a277459fccc\",\"/knowledge-medium/src/extensions/core.js\":\"aac4c95852fc3fcd\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"2358da85dd9dc5ba\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"2bb80508ba637ae6\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"fbaaf5ba051b8a23\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"73bb88728c86f4d2\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"8ef5f4ba954810ef\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"04f5d47c88a03aeb\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"776234d5d2e7dc3c\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"30107b7efda0b384\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"f35b27aa1ab0940b\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"8b912220771e492f\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"85b354a9b29fa00a\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"0a0512c808788058\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"6e308af11d84a49e\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"4a5cc979f0734384\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"3e0d195648f79892\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"3cad0ee99505b4d3\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"83b8af00575b8328\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"99d560260ce68969\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"b834d0fe71edf643\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"4502746e60a4ca8d\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"c8e22a16aa715a63\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"3c5828c65098dd58\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"587074470c245ea4\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"12378d7336fc5883\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"df8ff1e145687980\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"79be63a99f934351\",\"/knowledge-medium/src/facets/facet.js\":\"3951de690b58d339\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"db53fc9bc821538c\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"fd0f2d2bc4520655\",\"/knowledge-medium/src/facets/togglable.js\":\"cc4d658887e931ff\",\"/knowledge-medium/src/facets/variantFacet.js\":\"e751d99820770992\",\"/knowledge-medium/src/facets/verbFacet.js\":\"551344948a57f059\",\"/knowledge-medium/src/hooks/block.js\":\"6cbcca79fd64ee59\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"7dc701492cbf76c6\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"838b720f81c4bd15\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"57c51ab901e088a5\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"0e89dfff2007c3d8\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"6346c057ce050ac7\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"6ac8a14f5e39b247\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"1e6d9bababa948a3\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"69705b7c7bfb73a9\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"37372126edbaf57c\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"d2eeea158187da78\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"27da129b3f6f4122\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"029130aee3eca420\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"a42cd15413b59f01\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"bb6fffaf91d6cdaf\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"f3dc0d000509b4e6\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"819cf3d52cbe3916\",\"/knowledge-medium/src/lib/utils.js\":\"6743870a1d91184c\",\"/knowledge-medium/src/main.js\":\"67d3a8056bc8d110\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"67b8c6805fbc7449\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"4679dc7df5db01f6\",\"/knowledge-medium/src/markdown/context.js\":\"60fd68cf15eb7d2a\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"0697479f62561a87\",\"/knowledge-medium/src/markdown/extensions.js\":\"80868f1fb98e8118\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"2a23c8cbdd10532a\",\"/knowledge-medium/src/minimal-editor.js\":\"01e45a041860b6de\",\"/knowledge-medium/src/paste/armedCut.js\":\"8d18b21dfcb36620\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"7555d8d71b40795e\",\"/knowledge-medium/src/paste/clipboard.js\":\"057f9f9a074c6616\",\"/knowledge-medium/src/paste/decision.js\":\"4d7921ce8e3cadf4\",\"/knowledge-medium/src/paste/operations.js\":\"00e082f5e6abed8c\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"3ee906fd74196d73\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"a42ff6e5c28cc9c4\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"68cd1e736458cfe1\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"ea1b798942cd385f\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"10ed87205899de33\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"1e8a5f177f36c38c\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"62a6e50b1e43e259\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"a70f0de4f6d7896c\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"e57d7aa5a78f3bfa\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"4eddeb9aab2c2a25\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"ac769bd2e24d6a2d\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"063b2369cb443b24\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"58fa945946aed76a\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"e59e7e17c6d94745\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"9e9f1833b7a7a4ef\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"4bc37fad701dd4d4\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"b3f96741c379340d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"f3f1368e053142dc\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"d8587249e8fa61bd\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"d2a2b0a3ed64e2f5\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"06a302b1759afe78\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"eb4e725179c55823\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"582d2905cbc0bfad\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"ce80e0100c9b4c9b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"2dbfc7d7e0567c2d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"43e9e5a42ade7a69\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"67f4ef69e7101733\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"30f98e84cd243e72\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"162b6cb5a966f1aa\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"d4c86b75ec6a5b8e\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"de1fe62f3661f603\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"2c213342766e6fe8\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"7f4091a546019593\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"d4d9d4b3a46aed4e\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"a22cef7246c4064a\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"be8972ce94c89373\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"e39dea0facf2535c\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"2adc675265283b22\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"17e6b11fc5af1ce7\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"e44b4e9ac91ee113\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"3a367da25494f6aa\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"fff83f3543d9de55\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"3d1803d577177066\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"a596322e6edfef96\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"56075a09739ff10a\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"fecd15573ede4847\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"571591da7f3604cb\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"b5e07ba12472d656\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"869478b4848cb676\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"6808102738c9ce75\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"4127f230568fc410\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"1c2ea1bc09d7b42e\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"043f9630750eb79e\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"0ccb77746b3acc86\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"375f4a8725a111ea\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"56946f199203d8c9\",\"/knowledge-medium/src/plugins/alias/index.js\":\"e49c9fc39b45496a\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"821f8b4e46e3df2b\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"36aea5bc242e2b87\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"1a506cfb8d7fb6c2\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"c41584ae28ad0f73\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"a07387cc79de4c95\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"dd334a3ff21df4b3\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"9bef7388963c0c63\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"9dce1ba093c03cb2\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"2d1679774d0c452f\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"86c8b21fe1f33ab0\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"86d3f97a3ac7fc62\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"53efc313a4efb1e4\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"1ad206c35648a17c\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"0e28706f85b074ff\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"5c599831735cef39\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"2a064fe003477a4c\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"0f0365cee6140c66\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"f97c592b168bc7bb\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"4c517df3b9f058c8\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"3894cdf63ae1d99d\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"7bb11062bafa6541\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"4d65d32fe15ebd74\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"23a208c9842ec829\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"08cd9bec2f02a4fb\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"0bf2931946075bca\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"f3c7845eee22985a\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"097f800574329851\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"b78df8ff25db84ca\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"d10f46df90168931\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"87af86974695277d\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"fc8e1596d90024c8\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"a19ccf3e3aadcbea\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"7f1e7d1f24776aef\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"314e1d624856ad8b\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"0a0629ba2cdfa143\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"2639abe465ed13c9\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"7a029d16a2bd63a6\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"fb088a4d64a9083f\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"c1e98cca4c632ecc\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"75354c5eeb34e39d\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"bab941e2262fa58d\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"7a63e138f73805df\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"def6c76591df7aaf\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"a9d2c04f88254dac\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"076bd5ccf98e19a9\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"ab8a8d14f6c3fa18\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"61c679c234acbd2e\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"8081610f59a5c5c9\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"2217a459b88434a1\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"c066336be01f3207\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"68c458efba68e142\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"11ece395acd440d6\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"a7575436905a5a17\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"6ec937cf82622c82\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"1252eab437cbebd3\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"10419d8351933b7c\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"3f9a4fe125037c78\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"bcc77f3ad9d20b93\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"93c55aac3b16954f\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"0504b24f6d212f56\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"53f3ef4814da3b65\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"7dabf8a967cd9d3d\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"530cead3e8d8ac9d\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"fdfca6abc3750634\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"a7dcc00bcc104125\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"2ea51acdb1ba024d\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"382330d7bb0bf733\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"0d75eda0c21299b2\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"49cfc72bd0495a2c\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"d57b0024f2b1f594\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"16f18fba97e8cfae\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"a5f1b6291f191801\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"4c0901e99ac71885\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"505015c9376b782d\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"79d8eaeaabe207ba\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"e70f39f5662fd40a\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"1ffd6682324be93a\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"354182662d524aee\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"7cc75b6721dd20e1\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"3f0979a857145f51\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"c85afa09c64b1c3c\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"3425988cef9a3271\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"e536e8e15901f8d4\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"baa8444eb6065e99\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"296168f72826ce63\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"e9d30af4d082fbf0\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"8c7cbe23b5840403\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"715bb8a3b3932857\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"b03bb41a51b6260c\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"ce9de1b19da5d1db\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"6c6110cc6d689588\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"d630d4a52e2e1fe9\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"dadca554d80e0554\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"be3cb300bb7eca7e\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"c9648aa5082d5b58\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"b73a6c0892b37f97\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"1d2271fc8bceff26\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"0c52da0b239be09b\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"d9db67824a788e92\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"be0233b124e4f16a\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"f856f1fd0ea4dfb6\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"f25497d56f57871f\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"b0d69b263d514139\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"417429cf238adc3f\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"1e9be62ec7ff997b\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"55454f3717f6e2c3\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"94d1c5d603895870\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"61d409b88f8291b7\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"1864710507d08960\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"e9ab71682bc4b183\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"daf805cdc5072167\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"79d9fe6ead71440e\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"9ee524a556b691ce\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"dbef3f5b6b661a27\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"fb8b76877e13bfb3\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"e23e38ae653c1d92\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"18ab11f22e3f2276\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"c12fa81f7a290255\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"fd3f8907c43bbc5e\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"d6e979f677d7e818\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"dcbbb7889b32a8e5\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"31f00904a97d6617\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"2d4d228907eb3e34\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"704410e03ade6199\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"74fe0d4932ad8814\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"0f906f807ace0dad\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"ad2901242469c492\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"8711aaaa672ba18d\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"8970c1d91b33ae82\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"30603bf98240faa3\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"9305faab5c26ea80\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"aea48189228b5930\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"711c55cd1576941e\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"74e1271972733d24\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"6e7f441092e08fa2\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"bc1fd94e0caf74de\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"85298318f4793657\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"7fcb17ad622db5a9\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"6dcd9a1c4d370390\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"cc0ee80b09e7380b\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"73af407524429248\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"e278447e4852dd20\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"5c28699b817da418\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"c261c9a63dad80d8\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"dab0dc38bb7abfe5\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"7e4709d36658c8fb\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"65f69209ba7f07f0\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"bea0917a14d31299\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"b138bc479637edb4\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"d5cef97b3a19fd90\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"f788e4dd7e66b92b\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"ff1f315f3b1959a9\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"af0ca47b7115be61\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"dc2647f58e15b810\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"591c7c973dba2345\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"5d2ed9f0f7411eb3\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"e886a8bfffd09a87\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"e6c4752137001f24\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"3cba06ed93eb4dda\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"5f869dcebba1a785\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"ce6fe650df192e4c\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"7d44c10e2ce1338b\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"00d886c9458f50f4\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"237337207f9e4b61\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"fba4566848e5f0b9\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"292ecfd8b1231f55\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"f81fb87226ed2aac\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"ab1ef1409e8cf030\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"8f26d0136ede420f\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"f834d6d40d8c009b\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"0aaf54da805a509d\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"5108d94ed474f757\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"d946757d8a92c79d\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"81a6d21d3adc9d09\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"e878b4b521f4517e\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"f32e7b831240ae93\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"29ef2acbe446649c\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"4484044ba3126621\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"823320832a031ff9\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"6816d4cc37ad288e\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"ddc32f3d4062bb23\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"ae17b0c6823ff895\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"376585bf4345e766\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"a3441f040739caac\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"ade83e47ac5d82cd\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"f91c07072b461edb\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"e7895e75516e1e88\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"2e41a98fa12d0a58\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"bcf814d267e86190\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"ea3f054b018275ee\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"9d6d66f91bd5f303\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"25492cf76febb38a\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"bbdd1ecdfd200c2b\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"ee85cf145bc73bb8\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"abd856e64a97f830\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"71dba691eb08ea3e\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"72098d2d25c0dc04\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"dc9c5d71a204e05f\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"f156aceb8047f3cb\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"ac89db27ab4b473c\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"39e0d5b4cdc660f3\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"b8a72f15da4875a7\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"83adaf887a6fc0d6\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"32cb7a404bd262fb\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"3a8b1296bd4adf2a\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"c903063148d274f3\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"45d450a307e36e26\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"03085054c2602db8\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"096f4026d75d4be9\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"c6cfb6d77ec65ece\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"e1ae3d8a38731112\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"400ed95bc0004c7d\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"6dcc3f964319d5c3\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"8d1dc108ee40ea96\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"8b3579b978661f3c\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"46e9e771b138fee9\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"2165565c6e4d1f2a\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"22b875dae0e4d07d\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"b9709e84aa0dddde\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"6b019d320b67c847\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"0b48c0873e33ed7f\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"7f5fbdccddf77d11\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"3d33b0a0fb7cb532\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"76679c2df3ff831b\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"3e09efb9f581d2b5\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"4d5fed436aeb2b02\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"20dacff9f85fe0a8\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"c614d30558f1a277\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"8952e3889225274e\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"7734a3fa9dbea213\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"9010db9fa2130341\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"6ffd380c3adc1dc9\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"27234f07861ea59c\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"de383a4b746fa36d\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"e47c95214741dc50\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"c2c842ea07069ef8\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"29a4322aaf5e69a1\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"2ecb7c0ba643f258\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"752a0252ca33cd24\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"aa589c22a0db3370\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"751640681b67abd8\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"2aaa6b0ab4fc3eda\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"d900fecc2d989e65\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"146fca1fdd1ccde5\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"cf4d27618ea352f0\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"44c51533e5284b85\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"b9bfdd99d429745d\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"3ca524dab101ecf8\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"914168e0e515ef73\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"e612db36a5ae95cb\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"ee42a4bf57201147\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"c82f0412917911fc\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"5be24351b11c8db6\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"c58300cb4cc9a180\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"1914f64bf609191d\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"290126ce630f6034\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"ceef2e77b9cbe1c6\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"1a0efe6319840fa1\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"b00c81b63c5fd789\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"4523b968e1904e92\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"4079a7c64db8bd4c\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"4cde3c1c1e1d3134\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"3b8598a2ce19d5bb\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"2d41eeb898c8c532\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"4dfd2ea62df4b614\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"047773531fba6e99\",\"/knowledge-medium/src/plugins/geo/index.js\":\"fd4b23ee606f4c05\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"8177f4691e5975fd\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"0cb095d74e9e34b8\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"c4fa88900afa96ee\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"8997965de44cf9e7\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"f25c7b0159ac0120\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"cd36990dcbcf2180\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"9cdf1d3ab7dd1f4f\",\"/knowledge-medium/src/plugins/geo/query.js\":\"410d87e7871ee77e\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"cfefea2223f0d135\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"db640bdc2d61c266\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"76facb4f685065ca\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"5dc0bb4dabf9b156\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"414ac9779612ad29\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"8b99b8aaee6ff37c\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"010541782fcd7a86\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"7f645db8c9eb4d6e\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"eced9122915234cb\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"7568ecd076e603d6\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"4c0d48ce7d76f4e0\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"8aef69f6375a0dbd\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"b52e97b0bff7556b\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"70bf95aab77ca7ba\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"6e7c8a6cd62a5409\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"647de7ffd194aea7\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"3b330061703bcee1\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"217a2f7a15439913\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"229411f656e08b09\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"9d64abafcf9d8dbf\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"6ffa3aa3b546f366\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"318f5b87fbee3e7d\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"39768b7d8ebf4172\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"364bff13f98b807b\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"e9d2570879203ed1\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"8433e0a8421e8bcb\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"1426c0de6e4bec03\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"c8a46fbc7cb4bdc8\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"ac052b6f66cfa7fe\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"43cdc519696b3278\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"36480e9c0df03fb4\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"ae9b29075cc6f91d\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"758b31050956f868\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"2f4ff5a99c63afb6\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"3622f3a33e860b53\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"134d352006621b02\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"cd828f1b03115c82\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"83c0d11a7c86d0a0\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"de9c4e1b54ca4dff\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"0c1bcd91cc2eb270\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"8ecc117210e4a656\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"677cd22a2d09c50e\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"9ca03e7ceadfba53\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"34c5a89b5bcc7661\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"172006ce46157102\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"5e42ecd18bccf220\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"032a7178e2af06dc\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"41b3d3ea671adde9\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"f24be39b6ea6aec2\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"d59ee97fa626a658\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"2a64d5c160f20f57\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"692e2d38e243af75\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"810ea62c54212dc3\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"d85580be47797173\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"5ca93ef286f84d5d\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"b7968e189b36cd31\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"f1c3b4acc2f34d72\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"3516b753d39e419d\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"6786848f5b53f6f5\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"000f601447030ebe\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"8915213adc41335a\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"ab0b78a5841ca870\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"dea068380a0e4d67\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"e3b5c48c5efaa882\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"d32f89d0ca3b2714\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"b25486224b943e4e\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"cbbc585c163fb3e8\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"113b9d64822fd429\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"157ee54145bcf59a\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"75c6edd0fba18923\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"08097f7a5151e49f\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"33879a9bc55124dc\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"b21c8784af122a43\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"120e233a04486e00\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"e6c5ba15bfe7c740\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"d6338b7a722998cb\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"edc670db6bfa1636\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"30980e138411bc37\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"ed6138777be5362a\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"2ee0d6fd68da411e\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"243b760cc19ab0a1\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"b445f122bc58cc46\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"59eda32862d3a719\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"418f9526042eb43b\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"10c0c5d0d8d41294\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"26cae6e0e2e0bcfe\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"72a323ab2b85aebd\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"f2bf1efdaf59c8c1\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"7ead60ffffeb631e\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"48cd13c3e94bbdaa\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"fcfb577ac73dee6b\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"eb6736570cac08dc\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"fb8fd19d40296834\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"73e5bdc5055318b3\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"3b10144f216a1720\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"329eb9ee6c04e092\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"2713abe7d851da0c\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"0e013b022cba11bf\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"ad9b0355f117e5f6\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"6ebf8a02bcd542bb\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"b5fe7f8673222446\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"4e8fb7cda748c6e4\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"754990c018da477b\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"aa09a6eaec96ffc0\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"32089151d7fc4a10\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"0629e447443a36c1\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"4367c6814010e4b3\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"061486916922c1da\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"d7362b870f105e9e\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"ae2a51888194b84f\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"9f1c0d787588db58\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"76c10ace2137e392\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"183b95c18e5d890c\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"f1b4ff3f3c37168f\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"43c23f13d031d362\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"5323dc16ada05b50\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"7ffbcc0bb54f2353\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"8c189c5bbb901cf1\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"2b848654bb3a5a5a\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"cb78547a5bd3ba97\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"b5f7523a3c1a3877\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"c53e360fc4da7829\",\"/knowledge-medium/src/plugins/recents/index.js\":\"98c5ff143cb46243\",\"/knowledge-medium/src/plugins/recents/target.js\":\"645b6f008b44c370\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"fb30b590ee942518\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"80db44db32f28c23\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"cf0e4f50a50add66\",\"/knowledge-medium/src/plugins/references/index.js\":\"6d5a4d2f9876bf91\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"4eece8517d22dd49\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"e89214b9a2203f39\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"7b1ba43eee653ff7\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"3cb8ed26968454a3\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"f253c6828f8255a8\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"7f537b52a7e4ca81\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"18d8029a6d780913\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"b6e4db6bdd3a4ceb\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"82455b8139df06f9\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"077aa95927d8d46e\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"3845f9bf609601c9\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"563362bff4c82311\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"748c5e17877de2dd\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"f08e7e11ff146bf0\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"eee06d9d760d9a41\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"f7037130f01489ec\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"3cc97aa51371f7db\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"12dea3e7173704a4\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"4ef6f4a43320b211\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"08647c86799a42ba\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"ab4339e4711c02aa\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"3b1533f0b3fe84fd\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"3928cfcc0a99104b\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"7eb4bdebb6694c9b\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"b00aa81ba92e8ef4\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"70985b981a6858cc\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"3c5e72e201243b34\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"e65900dd56a5ce0c\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"6deba6411e2237ce\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"c55cf148b7e53436\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"9da97cff7802cd44\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"3997db6010dbf504\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"e16042f43c0cdd9b\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"6713b2179d76e4e9\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"2c5e9b4290b5de32\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"bd197d1b0473d066\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"c06b80f593daca2e\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"ed7b9cb243aa272e\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"3b261924b658f828\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"029f29a86e1895c0\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"1f5faeb183026214\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"549b390a6efbba52\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"93609c16b2d970a4\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"af3546e3fcbbad35\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"135d9aa0047b077f\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"baf3b0b99b6c2bde\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"65ca5113b1fb1091\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"ab3ca38d66d79f05\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"a3ead11369d4cfe4\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"e8d2b1799c093518\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"cbddd6165751347c\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"e4447fcf3545664d\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"d2f454eb4484d4d5\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"169e11094d5410c3\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"0df22811edcf7a81\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"9be520e0602601a6\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"0779562f878a81bb\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"6c2359c9d7afa3a1\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"e07f39055fb6ef67\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"6f371b1ceb30fc85\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"d9cb4f83671045ea\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"f59428b7b8205363\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"b998728615912073\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"d611af72819d1a48\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"68bde5ce9438f8c1\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"3847050875ef9466\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"1882f664ddf667df\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"156952378432c1d5\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"5bba8ba13f574b69\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"3f2f486003a92ae4\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"29b3fbc60cc2cb48\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"98fcb1fb3b26be6e\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"bc63b4afb2bf685b\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"af2df61cc55fa67f\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"289f49a66436cd67\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"6b2d5a18eccfccab\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"0ad82f40298541d7\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"99c2597b3e0c2e31\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"2ab2dba8b620024b\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"289902e6bdbbdf7f\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"40a224073f30fc1a\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"683fdd8ae1d3a1f3\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"f6e4571d02a5d513\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"555d012d51ae2ec2\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"cf7ad42d96ce6655\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"8b918bd3fff340d4\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"d2212e1d1facde24\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"13ac98468521a5ef\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"5b0993a9556f15db\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"d8d2d95456924e4f\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"75df1d8fc9be668a\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"beee6a49ac87e814\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"8efec98f155b63f2\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"ed88a5501d023eea\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"e64c5e2902a9a73c\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"8217733f58992fc9\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"d659fa4858825cbd\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"2b4e4ee345d31892\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"7688c4699030aa39\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"561d588219cfeb02\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"d4f6c95092aa3781\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"1e05164f54f55e3e\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"637a6824f2c19334\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"360e94e8c0c3fe0f\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"616ffd6ef4b8409c\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"5b12bacde456cb29\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"e41569806c9aff94\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"3ee7ebb3bfa38195\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"dacb4e0206184ceb\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"b2acf3cfc2374998\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"ad6855fe228a96ef\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"9c68d316410fc46a\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"c6369d6d1d8464b2\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"c2e4ea307ee78746\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"e0326839fb873d08\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"13f878084a6bdfe0\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"f1c9b5ecd6407fdb\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"4aed32eebfa9f31e\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"1c9e9a855eb65136\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"4934e6360c4adb20\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"b84ea726a6a6ff33\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"1cf9bd90aae1c5a4\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"8eb831e7d56d063c\",\"/knowledge-medium/src/plugins/tables/index.js\":\"4132492ba0405062\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"1d5054edb8f49187\",\"/knowledge-medium/src/plugins/tables/model.js\":\"35de50a6d4376a8f\",\"/knowledge-medium/src/plugins/tables/navigation.js\":\"30d3b428ac1c57d7\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"eb599cd0c9a004eb\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"d00d897d52bf04c5\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"ab0732dd66352417\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"bdfcbdde4029ce19\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"4a1397b60d9ed43d\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"1d9585f565002c79\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"ff4fa12ef7cdc933\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"6e2d1e922976dead\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"e4b4c0683413088a\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"32afffc1aac73610\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"1fbf62d719f78f5f\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"af48454dae4fd028\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"61080e6f14f5ef40\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"1afd3d0e90c3dd5c\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"8fbd784890fffc74\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"a33742044097b800\",\"/knowledge-medium/src/plugins/todo/index.js\":\"0cfe4f001558444e\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"2111ae2dc69547fd\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"dc247f8c52995088\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"4218f77a7bdd86f7\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"370f62d7b7050110\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"07ca2489c1ad4aa3\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"0862db37bd28180c\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"6f1f5e6c37e900a1\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"299a9ce5d61c0121\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"50ebc0d4684d5acf\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"80282c70749f3f47\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"db7e93553dbb8b2b\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"f7b6296fcdd6d67f\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"5023c1567082333b\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"310cec484371f2f2\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"f571e8bd9ae15d75\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"6ee4bde7d8fa9869\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"bf248944729615cb\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"bd65f11e1b87a31b\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"1ff3f8c1f655d835\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"8981a720e47bf1ee\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"f7036a9306499827\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"09a26138fd99f573\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"80941fc97c196f5a\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"e3b766441f74a78a\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"d9caf663c5414a36\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"2c7bc951f2c0a598\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"2545f4c51451db87\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"b4acad60eedaf462\",\"/knowledge-medium/src/registerServiceWorker.js\":\"29bee1ecd5a213ed\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"774b2411ceed7679\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"0b33ccff96a22745\",\"/knowledge-medium/src/services/authStorage.js\":\"3f5d86d2a70b2723\",\"/knowledge-medium/src/services/powersync.js\":\"c700067bc4498c8e\",\"/knowledge-medium/src/services/supabase.js\":\"ff4db60650b8aaa7\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"0ac861eea61cbb0c\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"5e7db98da636629c\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"d674a157e3438d0b\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"49510a3491020d79\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"2fb50198bac664bb\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"23bd5f99360c5b9c\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"c545be0a49bb6397\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"96e60c2fabf76680\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"5bc40d66d7365ac3\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"1e991adc3ddc2fe5\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"cdc25358f942cffe\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"f9cd17c9c1ea5444\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"cdf79371288f3944\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"e9208cb7e56d8ddf\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"bcda7a8aab6cad51\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"8ecc6b0cf54a592a\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"e19a8c8425444c7d\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"7bd9c8322427f369\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"ef4d615d07cb5653\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"c1f8863f4a73c62f\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"72b4db5d257957f7\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"5d9bc83f5c2d1a31\",\"/knowledge-medium/src/shortcuts/types.js\":\"5bebb4305abf2758\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"7a809391992126c6\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"1e79afa0ceb58101\",\"/knowledge-medium/src/shortcuts/utils.js\":\"bc2da46c221794ff\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"e893bd420dfb3bf7\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"4145d5e6d65dfb33\",\"/knowledge-medium/src/sync/byteTransform.js\":\"49d2574d42bc6343\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"b956fa25e5420b3d\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"496bb83601abec95\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"6353bd0730b0d74e\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"3101c23283a2dd27\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"3871aa1509b53d4d\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"3fd2a361d5e8bc90\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"6ac06a5515830755\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"17e900aab55d63bc\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"fa3c5d0428298b0e\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"51656bb626e4b2e6\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"9462ee743d983582\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"7514d05b18aa537e\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"5c0ce897b6f9ef05\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"34e5c39058a931c4\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"254d95b1a4397f9c\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"5661688d96c345c2\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"9ee5579bb77f49f5\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"ceab7a0defcb6592\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"3fde5ae0fb1b824f\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"f4baa80d0dbeec19\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"4a53963373f708cc\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"9414d8529ef6ed6a\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"c63ec04e1f1b85c1\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"a4ac8fe628b183a5\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"5b41a5ef7b20efb1\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"0879d20991088338\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"68cfadc3dde89835\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"fb3b3485ba1253b7\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"8a9ca27f5a0f1e5e\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"016f27860978926d\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"888ccee5451672ca\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"3b33bc638ad0d87d\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"178fb8583acc1592\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"b77184608a480480\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"77cd72b6c8a0431d\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"7db2d895f3c7be67\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"bb9f4014320d27a4\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"63b1507672ef932c\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"04a0843ba3c69265\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"46f72a349b768b57\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"449a78663b8b6a15\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"68c3b298dc46f179\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"f2443148e7d87cb3\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"f6166192ad4a79c8\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"b9a441ca60b986cf\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"9a2fcdf6fdf83363\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"fc95ab2bee4103a0\",\"/knowledge-medium/src/sync/transform.js\":\"702b5286dcd3c3b7\",\"/knowledge-medium/src/themeBootDefaults.js\":\"e8e4124cad29bbcb\",\"/knowledge-medium/src/types.js\":\"1190ef5c5c306389\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"58180541651fc969\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"a23467c346b9961d\",\"/knowledge-medium/src/utils/array.js\":\"fe2252a4bae94c05\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"79c96b9c0f184d7d\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"7d62d8d891fff8d0\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"23fa77dca47b3d68\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"e0a284281cd8de16\",\"/knowledge-medium/src/utils/callbackSet.js\":\"dbff3f75859cc4b1\",\"/knowledge-medium/src/utils/clientId.js\":\"b81ee03b72ae2e83\",\"/knowledge-medium/src/utils/codemirror.js\":\"f9d7c80e3adeb57b\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"6731b0c9f015dd23\",\"/knowledge-medium/src/utils/copy.js\":\"b2fb3e452746993e\",\"/knowledge-medium/src/utils/dailyPage.js\":\"f0aa4c0e7cf02616\",\"/knowledge-medium/src/utils/dbForensics.js\":\"b7f6663001109141\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"e0ecae746ad9015c\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"8f6747c067b33df3\",\"/knowledge-medium/src/utils/dialogs.js\":\"189d0e08ed372e64\",\"/knowledge-medium/src/utils/dom.js\":\"71f57e89fcb3eed8\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"428035f14a7624a9\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"655a886304d80da9\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"64a162824b248062\",\"/knowledge-medium/src/utils/flipSlide.js\":\"0cd94db38c21e285\",\"/knowledge-medium/src/utils/fnv1a.js\":\"3add63792e685b97\",\"/knowledge-medium/src/utils/formatBytes.js\":\"ee85ec646eb88b0c\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"3f3571336de8e56d\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"c2224d8a6511458d\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"cca84ddf13a366a1\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"9a22c66f87729815\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"efe088a4ec14cbd9\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"5aec6a7d9c2aab4a\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"9e51f349f53e9ecc\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"7fde3fabc1f42e6b\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"354c3074868d352c\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"02b56fdeb20a34e9\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"eb9c5b1f80c2216c\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"c3268f0c0c51d963\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"e1b6cbf88df37587\",\"/knowledge-medium/src/utils/markdownParser.js\":\"23ffda2ff4189c8e\",\"/knowledge-medium/src/utils/memoize.js\":\"9fb85d11f37b6364\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"6b973efb084c7d55\",\"/knowledge-medium/src/utils/nameList.js\":\"8f5aa3ba5a3aee43\",\"/knowledge-medium/src/utils/navigation.js\":\"f9c63745c95af8e5\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"1c365b85c040bf30\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"2f6a93414d20d6f1\",\"/knowledge-medium/src/utils/panelClearance.js\":\"2350826ae3722468\",\"/knowledge-medium/src/utils/panelHistory.js\":\"c5cc75b07c7d472a\",\"/knowledge-medium/src/utils/panelLanes.js\":\"bf209bec8eead7ff\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"54672c638a346f5c\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"1ec2d1ad1a54dd7a\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"9f7cfe21ab5e4746\",\"/knowledge-medium/src/utils/platform.js\":\"f9f84dd1ddab86e0\",\"/knowledge-medium/src/utils/pluralize.js\":\"0d88a3faf39c0ac9\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"8179e4ebe46f645a\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"0ffd90e56406f7d7\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"03e305f0629e1ea0\",\"/knowledge-medium/src/utils/react.js\":\"55b6a484245be5cf\",\"/knowledge-medium/src/utils/relativeDate.js\":\"3a93cfe59b4e5a4a\",\"/knowledge-medium/src/utils/relativeTime.js\":\"3a2b6daf76a153d8\",\"/knowledge-medium/src/utils/renderScope.js\":\"d4b352e95fc3d262\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"25369ed6bf3863f4\",\"/knowledge-medium/src/utils/routing.js\":\"ef95684b3ec5ff9d\",\"/knowledge-medium/src/utils/safeMode.js\":\"fd2bd84468ce8c70\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"e5d7094ca091fa16\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"c61e367f337103bd\",\"/knowledge-medium/src/utils/selection.js\":\"74d151e5cda886b7\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"10aa4c2ac5fbf2c9\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"b55b40a1869cf313\",\"/knowledge-medium/src/utils/state.js\":\"70c6a4474eb0e489\",\"/knowledge-medium/src/utils/string.js\":\"f0c4396704bb8855\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"6385b98890de4314\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"0eee5f6f7bc4b847\",\"/knowledge-medium/src/utils/toast.js\":\"b8720e26e6db867c\",\"/knowledge-medium/src/utils/toggleStore.js\":\"139081185cfc5b89\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"c22ea10c2ebd5cf5\",\"/knowledge-medium/src/utils/userActivity.js\":\"601a728e074133cf\",\"/knowledge-medium/src/utils/viewTransition.js\":\"0f5df9783c989763\",\"/knowledge-medium/src/utils/viewport.js\":\"6a0a2940a1f0760a\",\"/knowledge-medium/src/utils/webLock.js\":\"d6c962ed8e5ce082\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"ebea303a467d08c5\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"e157981ab1128ff2\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"d2283fa5875d383a\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"c20a2542c31f5eb0\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"38d3d1e88f8f094a\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"9788098857396b74\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"bb2e52c46e35524c\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"d29aa7411a12af06\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"a70833ae94037094\",\"/knowledge-medium/src/vendor/react-dom.js\":\"163ce2e67e3a2de3\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"07f2b96f88bf2f15\",\"/knowledge-medium/src/vendor/react.js\":\"05c2380381efe640\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
