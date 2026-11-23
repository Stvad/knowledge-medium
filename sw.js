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
		buildId: "9ac61389c3ec-07cb06d4",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"58630a4f29db7419\",\"/knowledge-medium/index.html\":\"58630a4f29db7419\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-CeZGnfJ7.js\":\"15bb1100584180de\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"51ddb09f6eab8713\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-gXUa_2ZR.js\":\"8a3e06705eb8d458\",\"/knowledge-medium/chunks/FacadeVFS-7YebdbXH.js\":\"e4766b14aa8d0100\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-Buecn05r.js\":\"f7a4030bb8891ca7\",\"/knowledge-medium/chunks/MemoryVFS-CdWkco8d.js\":\"2102c56f42690554\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-BrHZbCUP.js\":\"ba0a5dede29b79fd\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-6LOxXphH.js\":\"044015f591b80a4d\",\"/knowledge-medium/chunks/Preview-DNU2pFP8.js\":\"952b217948fe0c64\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-B9IHYPc0.js\":\"c8afc028b08a19ec\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-gyoVLp8E.js\":\"bf62fdb45979c6af\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-0MxVG0Pt.js\":\"a124e7a6cbea824d\",\"/knowledge-medium/chunks/react-BFq-C96h.js\":\"cb67ebdd507c01ca\",\"/knowledge-medium/chunks/react-BOIa0NCc.js\":\"186a8aa891138a8c\",\"/knowledge-medium/chunks/react-CiMN3IJh.js\":\"fd18512f65d101d3\",\"/knowledge-medium/chunks/react-DytM5Fg5.js\":\"5c51aa4eb24c8957\",\"/knowledge-medium/chunks/react-Gzqc702m.js\":\"88ebcf98c2a22f58\",\"/knowledge-medium/chunks/react-PaV87rRj.js\":\"f24693a4926d88aa\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-B_nqg4f0.js\":\"8927b8fb019cce79\",\"/knowledge-medium/chunks/react-dom-server.browser.production-CBsqjQ0T.js\":\"be4b96f6d34a89ec\",\"/knowledge-medium/chunks/react-dom-server.edge.production-Bz_HvPDL.js\":\"a5351598da2bf7a1\",\"/knowledge-medium/chunks/react-tZeYNd8z.js\":\"ec6151e284ce3b2d\",\"/knowledge-medium/chunks/server.browser-BUjs78ND.js\":\"0fefd4a1cd93115b\",\"/knowledge-medium/chunks/textarea-Dz0VDwtY.js\":\"35b35bd530b4b2d7\",\"/knowledge-medium/chunks/ui-CszAnJFV.js\":\"f5d01bb805a97cfe\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"baaede76f21892af\",\"/knowledge-medium/src/appUpdate.js\":\"7663a4f22406ad44\",\"/knowledge-medium/src/appVersion.js\":\"169684360dfab801\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"d1b10b5377574fcd\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"5c4a6b427d3d7cf1\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"b8aeea46731c0746\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"96fdd144793dc2d6\",\"/knowledge-medium/src/components/BlockComponent.js\":\"5d3b739c5e9f7f65\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"10ca25cb53b3ad77\",\"/knowledge-medium/src/components/BlockEditor.js\":\"2082a5e0be75eb43\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"df76662b59cd8b34\",\"/knowledge-medium/src/components/BlockProperties.js\":\"e24c053ac593dfed\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"40db9e277cb42313\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"aa5eb6e3201504dd\",\"/knowledge-medium/src/components/DividerHandle.js\":\"a3eed4c50d6acbb9\",\"/knowledge-medium/src/components/DraftEditor.js\":\"0d046fc43ed09abd\",\"/knowledge-medium/src/components/GutterPill.js\":\"94ee20f918eccdc3\",\"/knowledge-medium/src/components/Header.js\":\"c74b0db59ae8bbab\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"ab53236c3ad4f778\",\"/knowledge-medium/src/components/Login.js\":\"9f8ba03ab9355692\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"bf04fc62aa83838f\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"c690e289951130e0\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"97be27244a90ac6b\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"9d635166ff3c1b17\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"329b4b444c986f05\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"e11c6c3afc62b950\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"b3a0566f410b4f73\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"93442d96e0774f1b\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"d22e35f6a0d52068\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"1d49a2ed3fa1f2c3\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"ed3fbd3269dcc1b2\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"f14a29701c8c31da\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"40fc4b926293db7f\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"cc571c67537a1478\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"ef48595d4a3d1fd6\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"e11b651a5bc8164b\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"8e7889d327bd0d08\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"524d98a144b0ad88\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"5e648e61becf8f82\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"b38019283abeb988\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"6e55cc4b69630193\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"e7c852ae438b0703\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"8c14e62d4c90e067\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"3a750c60aa391dce\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"dfe6913c02008c11\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"bb120e52de3df1a2\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"47a1161cc9477a72\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"6535f10405fc4cb4\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"3dccc799df0ed26c\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"9a9c391cd0fa98c4\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"4ab8a821eeacf3c1\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"ae8be0c152303131\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"59ad1d20a17295ab\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"f8c9e18a8af7366e\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"79230c8ca1686420\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"c03beeac22711bd9\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"1f43c6a828ae926f\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"2f2ef5375b667a5e\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"dd81cecd1b766f34\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"49925c65aa867ddf\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"344ec533af46dec6\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"9f15fbc5e1132e96\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"25624dd274fc7305\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"ed78adb3dddc052a\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"f80ef5ed1426efe4\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"115b137c3e7769d9\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"88de81370699115a\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"fb1b97922b9090d7\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"52a02722ce151307\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"e01b8af58d543f63\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"24b3d230ce50882b\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"9939462d7b8b9c97\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"3dcdd8fc010b94f2\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"e103989dabaf6540\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"95b307604ab7ecca\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"0e4e10106a0e9769\",\"/knowledge-medium/src/components/ui/button.js\":\"d3de8c902532c2af\",\"/knowledge-medium/src/components/ui/card.js\":\"e740f97cb4ecc544\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"4cb33689f88c3428\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"51025277f00e8bb2\",\"/knowledge-medium/src/components/ui/command.js\":\"7d3d77a53e608f5c\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"d6828964bba20469\",\"/knowledge-medium/src/components/ui/dialog.js\":\"2a9e8c43a9024588\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"8e01b8aea13a75e2\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"0bf651fa74d757ad\",\"/knowledge-medium/src/components/ui/index.js\":\"5dd27a790967834a\",\"/knowledge-medium/src/components/ui/input.js\":\"c5f9b7e3fd46ecbe\",\"/knowledge-medium/src/components/ui/kbd.js\":\"ccabdd455f336831\",\"/knowledge-medium/src/components/ui/label.js\":\"355235d93617e3be\",\"/knowledge-medium/src/components/ui/textarea.js\":\"0b651705e566a717\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"dcdeb730a4101a08\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"36759ae62b5d181f\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"50d2127f9db14c57\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"e05de8569a36bf50\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"07676dcae0d04fcb\",\"/knowledge-medium/src/components/util/error.js\":\"39db88066a39e29b\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"4346498a3c8d8ac3\",\"/knowledge-medium/src/components/util/suspense.js\":\"c09265f4be576231\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"aab48cf30069ac1e\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"4967073ee62c97ad\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"15e0ecd1544c1fa2\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"c7158c659e539c0b\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"14f42bcd42babb2a\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"f841ccd693fea7c6\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"23e3c517b1fe3aea\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"a8b7c1f266946b07\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"e77e2a08076e5951\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"cc5e4ea40cea5bce\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"64d178bd2432cb76\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"aaf8e20a5e0e7017\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"bd951b3a5d049d0a\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"907e72ec1b972eab\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"fca7428cec762658\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"a27f0dc4ea6fb681\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"7346672d2205da80\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"a6542391d2c1fcd3\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"e2d85c7fc75a1356\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"bab72dccf27540ef\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"9b70074904bb31d1\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"69e52d50e289f9f3\",\"/knowledge-medium/src/context/block.js\":\"0aef6c7ebfd4864e\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"8a73459490eaba2c\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"0eee239cfeb02900\",\"/knowledge-medium/src/context/repo.js\":\"5648532ad255f730\",\"/knowledge-medium/src/data/aliasClaim.js\":\"3ca24047938db0a0\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"566d0b7ffdd95049\",\"/knowledge-medium/src/data/api/blockData.js\":\"de26b98a9e3ac783\",\"/knowledge-medium/src/data/api/blockType.js\":\"c11dc6680b946f36\",\"/knowledge-medium/src/data/api/changeScope.js\":\"861cae53e59a0632\",\"/knowledge-medium/src/data/api/codecs.js\":\"184c3bde4f92df9e\",\"/knowledge-medium/src/data/api/derivedData.js\":\"7141c51b500845fc\",\"/knowledge-medium/src/data/api/errors.js\":\"2aebd2ed4fc4f85c\",\"/knowledge-medium/src/data/api/events.js\":\"32bd849f72e2c8e8\",\"/knowledge-medium/src/data/api/handle.js\":\"b8e71a44bde5f088\",\"/knowledge-medium/src/data/api/index.js\":\"fce28e3fff10a103\",\"/knowledge-medium/src/data/api/mutator.js\":\"96d0caf66c5043ff\",\"/knowledge-medium/src/data/api/processor.js\":\"00bfe91e1e522bf5\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"e3190286ae6b2dda\",\"/knowledge-medium/src/data/api/query.js\":\"52c0c0f84b86699b\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"f833dff5b3040848\",\"/knowledge-medium/src/data/api/schema.js\":\"b8e71a44bde5f088\",\"/knowledge-medium/src/data/api/tx.js\":\"b8e71a44bde5f088\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"2dacb06312a31664\",\"/knowledge-medium/src/data/api/user.js\":\"f359b6a39c8e1518\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"45aa0e81ae1d71e6\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"f2b9f163cff718dd\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"1f8c87ae61c1124d\",\"/knowledge-medium/src/data/block.js\":\"d298f7af82a792c8\",\"/knowledge-medium/src/data/blockCache.js\":\"9b1ff23548f19054\",\"/knowledge-medium/src/data/blockId.js\":\"6fea57c309404b3d\",\"/knowledge-medium/src/data/blockLiveness.js\":\"085005445fdaf63b\",\"/knowledge-medium/src/data/blockMerge.js\":\"e134b9aba84585bc\",\"/knowledge-medium/src/data/blockSchema.js\":\"9ddc67ee0637a9db\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"408fef32e8dea884\",\"/knowledge-medium/src/data/blockTypes.js\":\"2c02642b43e76e80\",\"/knowledge-medium/src/data/childrenView.js\":\"cb67cabe449ad790\",\"/knowledge-medium/src/data/clientContext.js\":\"e99effe236109050\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"e114d3349fcc27c8\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"ea4599b164b65f4f\",\"/knowledge-medium/src/data/derivedIds.js\":\"1f142550b386c88f\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"cc44c027b22e3735\",\"/knowledge-medium/src/data/facetBridge.js\":\"e26e6617a802b0be\",\"/knowledge-medium/src/data/facets.js\":\"f66923285835ac93\",\"/knowledge-medium/src/data/globalState.js\":\"fbfa79695094684f\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"ce72ad33cd36f88f\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"fd3bbc89b0593c0a\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"dbc19ca7de340f65\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"ddf9d0e1f20fddf8\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"0cfaadaf2d08f42b\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"b13b3d337833c10e\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"f64b165957876f7d\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"a1de03c6e1531086\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"68bc0ba003851805\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"074e6bf89646abdd\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"b4ea52d74a7e6a00\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"889fceae3191fde2\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"0cb81dc5e004e48d\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"71be59d18e705447\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"6027385cbc571016\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"28e744b1fc6b0807\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"4cebdb336bf7dc4a\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"993aba952ed850f9\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"b1906b0d9582eb3b\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"16ff37699a36cce8\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"7c5eace445d9af22\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"e01376d9566204e5\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"55b355adf4003ce3\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"e9eca8dbec869afb\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"c3777ba8d1bed944\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"59fa5bd4d9f2ef39\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"566d3a35b8146f4e\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"b3bd5376d9d2aa81\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"29abca27d51794df\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"1688a15f4a5f5f86\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"02652e9046206ae8\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"a899d1df213e192c\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"ffe61bf44eeebe99\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"73df74c639ca01a4\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"738f4561a1b823bc\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"bb461e5e82a35ff3\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"463e8ea818e1a0d1\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"3ad32c9b21b0f011\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"721ae32e13d04d64\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"f1ad4dbf192e116a\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"553e1ab82c2fc5f6\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"317d7e1502067b9c\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"d092b8c291897cd8\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"782c8e45229ea129\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"342a87d6d34ee643\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"5801d0106c51e913\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"8b6f624f67b725a7\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"088f5ad4752b8f75\",\"/knowledge-medium/src/data/invalidation.js\":\"7293f74837578b77\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"822e08fbcff44668\",\"/knowledge-medium/src/data/kernelPage.js\":\"7d2bb2dffd7bd5ad\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"8b2e1071d2beb00a\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"639ceb3792d689e5\",\"/knowledge-medium/src/data/localDbStorage.js\":\"f01cf972908c7fa9\",\"/knowledge-medium/src/data/localDbVfs.js\":\"f4c96a231b99571b\",\"/knowledge-medium/src/data/localSchema.js\":\"e2e5a25e43f5055b\",\"/knowledge-medium/src/data/maintenance.js\":\"421c2c72dc4188fa\",\"/knowledge-medium/src/data/mergeProperties.js\":\"2afe56f2a4bb70c9\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"084fa346c386a195\",\"/knowledge-medium/src/data/migrationsPage.js\":\"c4df2ec0d9709834\",\"/knowledge-medium/src/data/mutators.js\":\"ec1a51e54c54e9cf\",\"/knowledge-medium/src/data/orderKey.js\":\"6110b2389181a713\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"d7997086060df92f\",\"/knowledge-medium/src/data/outlineSurface.js\":\"41c42a88cde43b54\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"ce8800e51251bf0d\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"9825b066b4d3ceef\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"e2566adf23abdeaf\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"edb8198c571ea534\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"e1010e5521bed5fe\",\"/knowledge-medium/src/data/properties.js\":\"e1f512148df4ae41\",\"/knowledge-medium/src/data/propertiesPage.js\":\"c2a1e6d01f09aa97\",\"/knowledge-medium/src/data/propertyChildren.js\":\"e9efb48d6a1d81bc\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"1b4cd08863e7f182\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"64e07960e9b2925c\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"e38ddfc4840d6907\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"9c4a9609aad7f27e\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"aae01c5f6ed03ad4\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"fd14ac341f5aa9ac\",\"/knowledge-medium/src/data/propertySeeds.js\":\"2f682f81ecc5ed96\",\"/knowledge-medium/src/data/recentsPage.js\":\"571fc40178267876\",\"/knowledge-medium/src/data/referenceBlock.js\":\"4d1df56dce59a947\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"d7040c06d8e2919c\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"8436804e85e5a6d2\",\"/knowledge-medium/src/data/repo.js\":\"cce29f6d706030d1\",\"/knowledge-medium/src/data/repoProvider.js\":\"d6485b0fd532952e\",\"/knowledge-medium/src/data/rowProperty.js\":\"6ec76cc164fea31d\",\"/knowledge-medium/src/data/searchFilter.js\":\"5646b2b185cedb06\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"c415aafbef9f5a7c\",\"/knowledge-medium/src/data/stateBlocks.js\":\"27fc64d12a255cb9\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"9fb0fd2197217ce5\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"f86ed7799054a6b3\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"b8e18a5dc59f83d2\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"a90841102749ec5f\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"5900fc2fb204f893\",\"/knowledge-medium/src/data/targets.js\":\"4c7fd09203ba3904\",\"/knowledge-medium/src/data/typeColors.js\":\"c5aa4c32bad438fc\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"56c5f31c95262720\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"84986b9060b960e7\",\"/knowledge-medium/src/data/typeExtraction.js\":\"c795222cf6f66046\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"59596d78ee92781f\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"aa009df7bfd6a0c6\",\"/knowledge-medium/src/data/typeSeeds.js\":\"83d3bc6adf748ece\",\"/knowledge-medium/src/data/typeTagger.js\":\"0647a0456ac6a914\",\"/knowledge-medium/src/data/typedRecords.js\":\"980eb2fde398ef32\",\"/knowledge-medium/src/data/typesPage.js\":\"00a59f63bf3ea4b9\",\"/knowledge-medium/src/data/userPrefs.js\":\"5272f84887e17882\",\"/knowledge-medium/src/data/userSchemasService.js\":\"4de1f5d642867f4a\",\"/knowledge-medium/src/data/userTypesService.js\":\"34a2ea4a8ca7e852\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"09023c14712e182b\",\"/knowledge-medium/src/data/visibleChildren.js\":\"eebc7f3ebf51b509\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"d05e64f6040f4e7f\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"327234c79d846993\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"545886d5ee3a0c4f\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"a2ee9471bff2b698\",\"/knowledge-medium/src/data/workspaces.js\":\"5255744e2505b943\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"c668f6fe1e78bfb3\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"eecc1f2387255f37\",\"/knowledge-medium/src/editor/atTrigger.js\":\"b9457d19664d0e88\",\"/knowledge-medium/src/editor/autocomplete.js\":\"006d693e303b7507\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"1a6773cbbec7bd96\",\"/knowledge-medium/src/editor/contentFlush.js\":\"8a15b67cd33591e2\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"eeea962c93e3852a\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"3e1b1640c510c868\",\"/knowledge-medium/src/editor/insertImage.js\":\"6efcf5562d12d63b\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"dec0b3d43acbd932\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"4b50e41910c2e307\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"b8569df637fb5ed2\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"95b30998cf2665dd\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"434a5851597e3445\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"1588ac21f1983a44\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"304c71aad6d6e387\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"d9a0bb6199b18ac7\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"4cb5615bc75f8bf2\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"df8d14c922bc9e22\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"dff4ae20d0771f99\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"39a88d8b219b94dc\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"9747f2168c3de179\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"bc2c35d80a97e573\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"25c29a63d89eaca0\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"c6098752efa01ae6\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"3aa224e1ad09611c\",\"/knowledge-medium/src/extensions/core.js\":\"71f60d40eec88dd3\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"32f090703d45b14e\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"a8e032fa17e9fabe\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"f524dadd48e153c0\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"e9e192220ef148ce\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"7d0d1f497fd68b96\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"6deaef9471685cf7\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"be71b60a8185f015\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"9277d02dec8b3c0c\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"3ab66b18298110c0\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"e016e5fbfd5046a5\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"ef643fcc81511727\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"8582d758ae59c8e7\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"360f485be0fc52aa\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"e27a2c30b1f1359e\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"6746f2c9e91e60c7\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"fd8a3555f0be57d9\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"d269d7f1b9527f71\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"d20720cb1090f6fb\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"fc79d2a1cf61bd79\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"95bee82f850eb1d0\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"e73ae82b59ab3968\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"1e674427cc8436d3\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"5e2597ceef276a8d\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"daa46da979ab88a3\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"56c525a76d9de5da\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"728e59db901c426c\",\"/knowledge-medium/src/facets/facet.js\":\"09a5de3854c313cd\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"3dbdcd3cd83868da\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"24350b8c22eebf61\",\"/knowledge-medium/src/facets/togglable.js\":\"932a6addcd52aca0\",\"/knowledge-medium/src/facets/variantFacet.js\":\"ff1d3a04a474e898\",\"/knowledge-medium/src/facets/verbFacet.js\":\"22cdbb1382ca9cb6\",\"/knowledge-medium/src/hooks/block.js\":\"fb2e105a32f20f91\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"b895476d7fc49cec\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"916e9241310b7350\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"de230ac0f165752c\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"7472b2c0fb36593e\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"6a42cb0ea1e0975b\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"31c827915814ed21\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"01c6751b91f20446\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"13f452a78f41b3bb\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"f6ff03b8f9ace021\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"af8e8e13f2a01f6a\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"9dfcfa29cfe8c846\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"e2a36a56eec6086f\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"e5044f49d1e12814\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"9120c6ce7fd86ce5\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"17429975f2cc4d4e\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"5da05865721b6288\",\"/knowledge-medium/src/lib/utils.js\":\"0cdc2c9e4a93f1af\",\"/knowledge-medium/src/main.js\":\"2ff0e5a411a8fdef\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"87a8a1c060a8e9d6\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"c66cd9ca7cc06df7\",\"/knowledge-medium/src/markdown/context.js\":\"c80c519ce0f56b85\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"fa8b5bbd0021afcd\",\"/knowledge-medium/src/markdown/extensions.js\":\"ff6224d33e337e57\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"d719712ec4abe24e\",\"/knowledge-medium/src/minimal-editor.js\":\"bb1c1a748bc07f86\",\"/knowledge-medium/src/paste/armedCut.js\":\"7d84e0c616369e25\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"ed1da156553fdc9e\",\"/knowledge-medium/src/paste/clipboard.js\":\"3dfd72599ea9a6d4\",\"/knowledge-medium/src/paste/decision.js\":\"a15eb1c4d4563923\",\"/knowledge-medium/src/paste/operations.js\":\"9838ac65ba8c99a2\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"ea67748b55f29075\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"6978068056dfe11e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"0614323ece90ab78\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"8470833dfa392a65\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"327333dfbe01897c\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"ea36548fc58bda64\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"ffffaa036ce1f6a8\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"b2a364623f788a57\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"25983f29c8d51448\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"bfcfa68df1f83296\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"6c7092be2eb12b00\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"c3ade0fd17945589\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"b699ae5046917e5c\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"b23dfa06fdb2b179\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"3fe17bc98624cca7\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"91e933b447d2da69\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"06934c33e7cb44c1\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"dad590b2d88826b0\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"df1fa352ea6dfc0a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"8288e2e88d0c9696\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"a29e3bb751611b10\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"ec5a423d17842bf6\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"b055d84f342da259\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"2744ce407daf5670\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"78d43b0ca8ee46b4\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"1987c3f6875eb356\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"397bdf1e709848d8\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"cbc1f178e158c551\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"7bf8df5478ffe76e\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"9afedab29e7355a0\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"69e975f6d2e933e1\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"9f470918540272a8\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"1d701d95665fc5b0\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"35c1b3de1045516b\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"6557a1a7b57e85ed\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"058c9a8595519c91\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"0ebcadeebec148c0\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"61582f63b9a9e903\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"81a1705711fc4e85\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"cc72bcd319eadaaa\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"0e5769defef0aac8\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"93ab99e748b40413\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"bdc430cf9ee8855c\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"b6ed44b3e6d5ee16\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"07d3e0d33e9f65c9\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"91a5e2c15a34f093\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"b5410ef4327c5de6\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"98ba83dbe4a205dd\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"ad6abc8c40ce4010\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"99d1ee74af4c7454\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"adfcdb8dc6b5cbb7\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"e421e9c95938e061\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"cbde04dc92ca9bb9\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"d894ee54f4a95a69\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"26e7bc302c1fcbc3\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"5816f7ae0d44d490\",\"/knowledge-medium/src/plugins/alias/index.js\":\"76d2adb851fa2379\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"dddf3b4b49a2d328\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"3e3218f187270028\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"2139297561faeac2\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"187186ba4afb889c\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"e1ad694add59856a\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"aaa1aebd447e26fc\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"c99cf53b47559c86\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"b98719531397ca43\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"f9f1eb73d1249387\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"435b84e5f80bfa59\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"c200dfd5601435a1\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"4bb808682a950a34\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"5908425b27214343\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"91f85d4977845fea\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"98436cad1b193b47\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"d452e1daa0e010e3\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"374d01aea0446e15\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"d44b2ef6cfedecf0\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"da5733192c8160e2\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"f94f40acf9d37ab5\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"b99c9f1f221a6734\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"c8661185cfde8d91\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"30764656d42bf8f7\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"d0213adf67d6128c\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"3608cac3b2f0f8c2\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"b2ebd19fc98cec5e\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"9847f03b7393a2d6\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"ffff94415a42cf17\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"bdcb8e265cd5c146\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"1b3844326537e16d\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"4ce4105aa2724f86\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"aeab137bf6eb350c\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"d45b11969ab57dff\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"d9da911975535b1f\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"58ca398f2293128b\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"f0ae1925d01fea94\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"4c15ae1336fcba3c\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"f5470d47cd882dbc\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"6cc736ba350a97e0\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"28ab458b5e779431\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"21d1413a2e61019e\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"f602e103099a15ea\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"bb727906a4a5abb5\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"e52850b760682a62\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"d8fcbd64bf90a37e\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"dab21eb1d593ecd6\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"021fc825b0d295ac\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"0c3b52b28d1f6ac0\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"cb07ca549d18aeac\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"d06ebc10963c3fad\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"b076b04bae2b0171\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"8296331393775ab1\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"1be267660c94af1c\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"3f3660e61df44cae\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"12d6e2c3eaf8ce1e\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"29b3104d91454ac6\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"dee6e4f45d6aeccf\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"446ee018d028d712\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"f02b022339f5f8ae\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"96b5aacc0412f64b\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"9a813d7ed5083b2a\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"f14d9efbe0921c1f\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"c0b6246eb36f7e1c\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"f244089f884d2b8a\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"a5b770d13c3932a0\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"1ce94450c1306fdd\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"65a2edfc72bc75fc\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"6aba9750fbc67801\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"0a6121d9a688d776\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"7e70a75f9e8ca43a\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"a10377fc03fa7534\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"4586cb1162e81216\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"a3b1f28eb89be92d\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"8c9dec40ae76b774\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"23920a4de82af135\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"8f32e7acb90ce0f3\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"8a73c98268f7a872\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"6d74312af70b9ae4\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"1dd4878c76096059\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"4e0224240a536e83\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"534f35ca129dc2ee\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"1a0e279f37314298\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"f0d9b7b2a6fcb420\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"6bb98768683aed45\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"940a804dff0b61c6\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"62f225178e4c553c\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"25cc12002210286b\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"f7801092c1efc358\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"135c41c441406153\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"b565b2638c94c9e1\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"4b4d9b6411b86d88\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"3916cc894571cad0\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"3161f31a7a68b3be\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"15db9576e1be0c4a\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"e614a175e7240d32\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"78fc3333f87e5065\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"3816999467e0289c\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"a214c499ea28d2b1\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"98a85cfffc169334\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"cd227817c5e5381c\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"f859cdf468974d8a\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"f5cdd1c105749ab4\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"87734cc1ee1b36ce\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"25c82651dc7e1d4f\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"f40011208aa42f2a\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"21dd8e8697caeaae\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"3bbe021df30e7f72\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"c0bbb9fa09060a75\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"cd6a69dd79d34240\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"67dc678a5468cd7d\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"1668d018fb515563\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"75c95e85160d762c\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"af93d972b6bb5dec\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"c887e5fa20b76edb\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"0fb6f41425add8e2\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"25e30983ebda4983\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"1008cc64d7ef2892\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"b190a376701f14f2\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"52adb7f18ea67abd\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"f12877973eb42adc\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"7c2a8384809c5d2a\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"47ab6c6c9782b9f9\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"abd2872d78014240\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"11fd174723c3fe6c\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"836322538c23d87a\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"cb735e04d2d985b0\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"6d136d2a64cee412\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"1c91f12bacb69b90\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"6bce42d009498b4d\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"0b28c3ea6cdb39ec\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"20b0048910670f3a\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"df37e84e0f401a0e\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"a67c3191d822d3a6\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"72009e94c66ec3fa\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"fa52675595f3c30a\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"228a375b46a9f437\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"c67400e41d312c71\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"f61eecad33d7682e\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"5def52269b1ba1e8\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"e8a883ac8619aaf3\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"49a2cdf54111f6ab\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"6c7ad7ca3c3856be\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"1adae0978f83c779\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"73b1e6cdd1cfafea\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"4337fec504714cba\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"37b2b776b5fa29ae\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"46e2c4d667bdcacb\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"29f9a2d64dff1aae\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"1f629cbbd0589d7f\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"41b4b2da337e605b\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"317b3abcb91722e3\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"b1d9f39fa4ba35bd\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"ae21d506ac814caf\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"9b4a2047c0654432\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"c128b106d762798c\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"7ee6e75b8202acfc\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"ee884829466434b2\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"559784c506313c43\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"64d1430416c628ce\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"6e188475d5d3cfb5\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"ac660d6aca37434c\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"a223875ca008ff1a\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"7abadb8487b925aa\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"a63f920cfd535168\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"d3da5262e293c818\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"245cb367974f1b99\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"ca27364c9761ed47\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"4cd5c2749608c959\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"28f240f22a3676f9\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"a8fc7cf6d5a8b623\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"bea7f45ac4618f6d\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"42c49c187241a7f6\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"f3613e35a4b672a8\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"be7dad1553a05b43\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"937985961a507814\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"2296795331bc0476\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"1e3a440b0ef04690\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"b2332a2bf9a0dadb\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"c4e2308ffee057ec\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"5ad236959de04f33\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"4c63f23ba91048ac\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"c335b7d184504dd9\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"84430233325380df\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"a14d4e483144290d\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"3eb5ac4c8949e394\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"356fd78b2d1d15fb\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"69fa71caa5c21e5c\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"5dde99ac5a085d36\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"0a1506f9a208e539\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"744cb76546aeebd9\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"98aede61f4bdd052\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"2a04e62d65e77db9\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"be417609f64f70b7\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"480dda57366c0a83\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"04952f5e949760f9\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"a1f67eda241259b5\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"4b0efde27489aae2\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"9c5ae375f72ad7bb\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"a824b433f1b4766f\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"99d0c18cb14d2d9b\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"8a4b1a149df3308a\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"b9c9fd815f8ca786\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"581b819fb29a4e1f\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"093bf36f49cd7290\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"e27d3efb30fdd37b\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"340b2b164c71bf16\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"6ef1c8503603287c\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"100553b5ad5268a8\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"9d9eed7158411e39\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"81f251163a26345c\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"50e9dd92063549fa\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"c5f5d1d4c5a38d09\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"8e95ec8f3d119073\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"018fff7189cc111e\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"7a12089f579641ad\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"e0a1946f06082d91\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"da10eee20961ec7f\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"a89349f50c0c49af\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"6f54f4cceb567f85\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"033dd5b549b9bc1b\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"c4ba07db4fc4dc39\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"205008ed4144107c\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"7c81ffe0102fcdf4\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"26e82c137a349b66\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"a404836fb3b24e38\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"2dd281fe1df41271\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"786c39d513738ab8\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"1241347f7211f567\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"4bcf5894d9ccedb2\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"0b4b000561d12f10\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"bc374db106d4bb21\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"753304b38fe77c1d\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"77b338408b4786c8\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"8f625c5563d8d917\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"bb7e6c6c2e16ac38\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"d30812a50e551368\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"f0afce540f6d10a2\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"1096c2c0c1d9475d\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"8e2416b672bfb6db\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"314de12f63c08794\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"ef5975a2005f329b\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"fc3734226ec8909c\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"e9ca9f7e1c2c62df\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"9c3c344657529d29\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"4b92c5835564f9fd\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"7ab70f2aae70c90d\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"31b3e9b5810f8297\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"735c81a5a46542ae\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"12860cd6bafc27e9\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"30bcc0b138d0766e\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"5ea456bb61981744\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"e4bd0a9273325831\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"0eaee4515f15a0d1\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"f0bfdc465c0c8c48\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"3115f262b593dc8b\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"6ba5f323e02f246a\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"b55950405a58ad09\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"f6689e37ad8aad9f\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"91bbe064984886e6\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"69e2db9f485e5ce8\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"07681f03df751d33\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"40936d313f2d674b\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"d0de6c723c406266\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"f930323c5f289f30\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"d570a5be66a9b301\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"0fcb3b978783c976\",\"/knowledge-medium/src/plugins/geo/index.js\":\"36dd7ca653d47365\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"1a7e84121aa5169e\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"102afa64b30fa871\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"e368ca27c709f101\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"d996c4fec72e0083\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"9e2fcf56de708d30\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"b9658fcecb5077e1\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"d0c56b7dffebfe44\",\"/knowledge-medium/src/plugins/geo/query.js\":\"9574310c012b8947\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"0647803853116e47\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"04ee82c33f10309b\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"8213316a4869acff\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"2329553b6dadcba4\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"aa94b6c7e86f9c0d\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"58441ec2126c2b1c\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"f1080c750ded8b1c\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"0a2fc9625d66f65c\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"c8aa48b6a0b5cbb0\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"2b9e3e332a9f1f6c\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"f6a26c15b9214ee7\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"7ebd490351c65581\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"08f66a1145717e6f\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"1917c0e2783f0def\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"d3963dc86f12e27b\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"8b99a99f08daa78e\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"a92cc57ad6737df8\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"14da875a99119627\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"2c90356cc1b382b0\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"a42b553864a27039\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"3ada20832bb07f0a\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"4d682a90b2122659\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"f52f07850ade09ea\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"0230fb2cdbb8e904\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"a7daf6ce9ea70171\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"c7c0aaa02e18fb2e\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"a9f1129fd0470f84\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"c295885d418dbce6\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"818bfc48cc703f7e\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"57f819beba5a70dd\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"23cfe615dc8ef24d\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"d410df8724af46c2\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"015932613ce49be1\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"581e3e6121438dc2\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"fd524440780f76aa\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"888f52fd25382b9c\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"102229a1fe16b465\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"ccbe1c7eadb3e32b\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"08252acf292e5be8\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"f85077916bb37ecd\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"ec3996366a0cb90b\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"efee0d8df81d1c3d\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"20035ad807b330f1\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"3b624998366ecdb4\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"c70db25998b0672a\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"c6d8d4e14527cb27\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"0dc6b213c6743f02\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"9c840af0cb8b22db\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"b4ccaad2fa095f9a\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"fec2dfb1760c2d15\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"af8bf09ac7ae1592\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"62b3dbb5e24c3ad5\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"210f488d48e5d245\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"4b4edd2eace8575d\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"b5f3365f99285b51\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"718a544c99c79025\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"e5c574f3a9c4e940\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"b11e849384e1f1de\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"25912010b80b5671\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"cdaa0a38fe14b700\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"04a36709c13d3266\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"f8c0e27ffe3efab8\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"c2037382cde01fc7\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"808d874ee3cced0c\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"de1a6faba2e51914\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"6c985d3734eb9223\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"1b1fe55f52717c54\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"f456034babc82d34\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"70ffec0296a6ae56\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"10c67ffd6f3c0ec3\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"61679745d396516c\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"8f59c6376580723d\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"cf901cd396b38ab2\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"2afa7ff0ee1b01ec\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"2250ddb01c98ed4a\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"8aa9f00dfe497e82\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"87d06761dc019220\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"0823b03d583b6279\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"cc7117b5ec834f57\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"e529f87b88071b75\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"fbefa53e70cb119c\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"503ce0dbb1dba373\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"8cf1b31c357c1700\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"f75e9b3dbae579fa\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"d73892af1129437d\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"c1a7a699e0a72cd3\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"2e0f1044a3dda40a\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"fbc4549d9fa4e173\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"0b8cd0c8d87b9629\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"e2db5969009b1103\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"d03498f8c1c3c8c5\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"20aae796332fac24\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"e5ee831acce188e1\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"60643d3ae0a6f010\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"ade88a9847c527d5\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"f36476e53d32ff5d\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"4ffbb308df124947\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"4d57a93408731cdc\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"a8bb6a95e047a2ff\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"2348b1e72c29f65f\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"f4451ea2b7181ff6\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"8876c2dfa95ba035\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"f6b3f8ea75764bc8\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"731bb6739b2980ec\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"3a67b475bee0c3a3\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"b2e6763550f8f2eb\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"5694a48c42d1dc49\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"abe551e189e7c537\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"6475309a422d30bc\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"cd03e68c411513ee\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"066b129c8bbee921\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"43ec146cf50e2674\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"75f8361893e56452\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"d66e9cb195234664\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"53681c38055a2d00\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"3cb311f64f159461\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"d6068762ffd88910\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"f05898faf4fc3d9a\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"67d206290e7d45c1\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"bffdb2473a7f2205\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"dac030ea50d864bf\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"dbda38a1796e6587\",\"/knowledge-medium/src/plugins/recents/index.js\":\"8898ed98dc198235\",\"/knowledge-medium/src/plugins/recents/target.js\":\"f0cf468953ea07f8\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"3bd48aefad5252db\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"76bfaa60319d7663\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"8c849d73cd5dd10c\",\"/knowledge-medium/src/plugins/references/index.js\":\"d3e5c4874d9e8f05\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"291cb4dbf7d62026\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"603d1d3be59ea8bd\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"c1cf0684537d44a8\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"e356f350c7dcab55\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"02b159f15e92f2e0\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"309cd7fa2944eac7\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"cf91a376a44c24ae\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"b9d37354df46dc92\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"ded435b0d7140b55\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"10daaa19719ee747\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"91146427b767b579\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"0c7ff541b3ef7012\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"c27cd21b298d25b1\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"195f727c30287035\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"157ed05ef13bc373\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"d63a19d118a55158\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"f35e401e3c99a937\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"551eb9a62d4ba1ba\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"c4402176e6226d7a\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"1168aa3da0a8a877\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"6e1389bd6f4fd062\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"4dc89d11a298cff6\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"5772c21fa1ceaf69\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"827dfb92d305c8ac\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"da7322d3eec9ae55\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"8a5471db14f40d9f\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"df513d42b33a02c8\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"24d6f35b1b1031fa\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"deaf494fc2dc20ac\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"9277af1896a11f35\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"216df645182ef431\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"8d91bf71d3cd785e\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"0f4c1a50d38889d9\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"ad667f150d972bc8\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"1547578b4de56935\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"12eb04b2b059da65\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"56ca2f4e8d64ccf2\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"89331be5fbbf170c\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"10d2657091e004e7\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"319557290bd15305\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"994e46863d5bc995\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"288cd4b1a0c89ad3\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"d320cd24e43713ab\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"ba690527cd25cf92\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"1fb95599828c6174\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"e8ba2ee60accc601\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"a50cc2a98eab8648\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"cb81c970673d1dfb\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"389890e4e2e1a1ff\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"b8c5fb8dfd5ddafb\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"fb91b56f4a7e8710\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"6b48b1d583acb11c\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"e2f5734df82d8669\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"647e9dcc5ef9a4cc\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"d4b2ef5c15122b59\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"d76b28456d447de4\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"665c9b972ac3b77c\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"d945632500bcfaa0\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"6dbaff418eafb9de\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"4d895e397b4c68e1\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"4338ea0a381a6c85\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"1f3cc0fd02abd123\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"a3e39d69daf6df82\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"9ba10da54f419d9e\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"37832079f8a3c661\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"8e2884d48075d016\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"b2ccfa22bf5db032\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"7ba83b19e1e7ba04\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"0ede88e27eb3c8a1\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"433b533758f2a865\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"1b2ed55ce95eee5f\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"c2a0441db18fe7b4\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"1cf5a7e04128cde3\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"8e0bfe1483d5b188\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"87781b27156d2d3b\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"6c552e4870e3d1b3\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"304afd13eead3417\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"b7a903a43c3c6b05\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"ccca0942269420b7\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"ae9656c9c46322c2\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"e4f31eea49321c15\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"0368b8fd428169ed\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"0a1b5d95da789f8e\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"7f16480d6a1fe998\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"206943d58065d250\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"5e56e9222bd4f708\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"3dcabecdd9e6995c\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"6b97a86f8eaa4f6d\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"ec4a118bfeac96fa\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"7451ed55785130f1\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"585b86776b4d70a2\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"0361c3d85e80822f\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"7c5241bcb27e44f4\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"afe82b33f42efcf6\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"8fceb110d472cc0c\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"cacbfc8adbfe63de\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"d84678d66f12763b\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"1d9f5f72c84ea5fd\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"8f4e87ff302a5cfa\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"d2e022bf7f091a91\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"0cd84159e3eb0cfb\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"d61f935e208eba06\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"f49dc88e2f169ed4\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"34fa906b1c589f48\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"1b8d2541e60e5ac9\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"f3db2d01b08c99e3\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"337aec1ec1e2f74d\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"64bf707ba5052ca2\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"e45ed0585ae15a87\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"cc423f20105468cc\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"5bfcd603565b8f11\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"2a022dbea117cc57\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"03df98ff983aa89b\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"ecc056ee3da1e3a6\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"8aa1f8f6badf5796\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"7a96db58e65d68ff\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"195c002aa46cf513\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"e3151952ebaa9ad7\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"c60a322ea54c436d\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"6bfcaa0829125c99\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"25a721d6d746343d\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"3f2de2398c58ba1a\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"f1a50363faee65b5\",\"/knowledge-medium/src/plugins/tables/index.js\":\"582e43a4d8c8a1de\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"d9c7b3cfea4752e6\",\"/knowledge-medium/src/plugins/tables/model.js\":\"dc4a3dcc34129d32\",\"/knowledge-medium/src/plugins/tables/navigation.js\":\"714c14b85d6f08af\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"4f1605a71ab8a477\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"742fe6b7bf4d8953\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"c316caebfa06f74a\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"79de16bb73e8e42e\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"f2788efb010fcb8c\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"0c7c3638fdf35720\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"9c240889c626015f\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"231dafc620596770\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"6e11284e9dca6448\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"28d48d55a334c6df\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"ae3644a044b0c5d9\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"3425c365850f5b6a\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"60fe0409d6740c58\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"ce40495f6e4ffb0a\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"62c9780d6f9e34cd\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"75447aa8b99e9e12\",\"/knowledge-medium/src/plugins/todo/index.js\":\"26a81575421884a0\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"6bb1f5cfcb472227\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"393c9b645af57be6\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"f50ad9ffde774d14\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"a2b8968624a91984\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"91502eff0a33b874\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"031c9bf958ed8bcb\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"b3891765bc28b368\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"3eebb919f663802b\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"5a4f6538d93e956b\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"6b7c48cd17e35e67\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"5c71d8d3f508fee2\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"0babcba9d0a39c91\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"1c96daff6727ecfb\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"ac9be99eaa981308\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"bda023a96199db4c\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"488bdee45058f642\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"80b6cdc863ea19f7\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"a4a886afa178e07f\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"93d4e198a097cfb6\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"e1a69032a9cc12c7\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"724e62b32baf861f\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"f846a38d874cb6be\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"42aac19b8f9b462e\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"38d4d62ed17983d7\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"8d2111e2fdb2caa2\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"44bb31adfac7a7a5\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"966b0fe0cc1dc7f1\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"6aa01de080a4697d\",\"/knowledge-medium/src/registerServiceWorker.js\":\"4b7b4c98ed2498ed\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"059d7f8a44da7a3c\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"eec93f840838a985\",\"/knowledge-medium/src/services/authStorage.js\":\"41fe9ebf8bc2f45d\",\"/knowledge-medium/src/services/powersync.js\":\"fca187718f6f3784\",\"/knowledge-medium/src/services/supabase.js\":\"7de602388dc55752\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"82b09353880c1361\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"faadfc713016c48b\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"c680b9e9320adb6b\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"524a0991f6397438\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"0b041188f62aa715\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"04fa4643931b7b17\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"d1ebc10d10e9896d\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"e9bf6f5ef8f772d1\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"9cb4e1ffc99a9dde\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"d27091d986167040\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"9b94a61d411df16c\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"0a24e4738a9fff43\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"b1acb39bd7ee48b7\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"193bacab243e5821\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"bbb241be6e0e8a2c\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"f70012a20423b433\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"e552a39c7ca11e5b\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"54cc34e6205d2884\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"047cf52127afc380\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"f0db7be01ebad293\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"1acc0e57a5094e3d\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"5fc778e4e6401d4e\",\"/knowledge-medium/src/shortcuts/types.js\":\"c5ba38ffc8ed2ef4\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"4c45f6ada8fb9207\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"da129f13d8106e8f\",\"/knowledge-medium/src/shortcuts/utils.js\":\"d04ec67747186105\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"3e8662ee3edf3e84\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"d86f28a9c6a6e645\",\"/knowledge-medium/src/sync/byteTransform.js\":\"3c851b4db5bca1be\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"d612b1e1b1bc1701\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"e5d87c1b7f99e36f\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"188821e17119cda8\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"eb9809a6a374f97e\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"057389ffdcdfa6e5\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"e60410934a6af022\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"5f0ef0d28f07e415\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"426a3d36c5a3d0fd\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"231386ca8bd195b7\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"35ee3245b2cca692\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"b9d88c5f904051ea\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"eb5f282e557b0fb6\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"fa94bbb78195971a\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"059d5fa3e23a06fd\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"45c30b7de79c2167\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"9b75e3a48f7b04c5\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"977d0191ad3a9f67\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"d61f6bce36992a83\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"b4133b342475b622\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"42219f8c28b94379\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"19fa92b3b260d283\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"1927ec10c04745d3\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"1488fabb402bc6be\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"e1069a549122578d\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"22daf1517ebf4152\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"aef92027d96c0639\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"6f06d87db8d5c708\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"b8185eb59dbdc075\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"9d88c31ebf257c6d\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"6689812ff9c6fedd\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"86902533c087bd64\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"42780643491e3d73\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"e12a287f891dfc6f\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"6dd75aba3b83568b\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"5352b686ecf60e10\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"80f21f91d76b1166\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"c7ea6864420adfad\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"155c17999e5d6061\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"5197b78f1baac897\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"59bf9c6486a3993b\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"7998d6caad5ed7d6\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"19360d83f173b08a\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"ea73f1fb47f8bb16\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"b530f45bbc84356c\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"83b03b82ec366907\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"ed519b41578c6ac8\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"d83d271fce26fff8\",\"/knowledge-medium/src/sync/transform.js\":\"5a6ec4ea80dcdc36\",\"/knowledge-medium/src/themeBootDefaults.js\":\"5007539cbb69c1be\",\"/knowledge-medium/src/types.js\":\"902fd2d8ba119d8c\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"d14beccb1f094796\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"b64e975be6257ff5\",\"/knowledge-medium/src/utils/array.js\":\"e943a499f39262a3\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"50eee625288bd1a4\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"372a4311825d7d3d\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"b3813b01ad923e2e\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"2a3fa3ecaa798cbc\",\"/knowledge-medium/src/utils/callbackSet.js\":\"ecef18793d3351e0\",\"/knowledge-medium/src/utils/clientId.js\":\"3ec4132a1700dc62\",\"/knowledge-medium/src/utils/codemirror.js\":\"2dcbfd2112947aff\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"873bb8c73be25e85\",\"/knowledge-medium/src/utils/copy.js\":\"aa893791121bf243\",\"/knowledge-medium/src/utils/dailyPage.js\":\"e846b0d891dc4147\",\"/knowledge-medium/src/utils/dbForensics.js\":\"26fc244e4566258e\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"4c7197a9f4964f64\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"dcde94c70f91f41b\",\"/knowledge-medium/src/utils/dialogs.js\":\"fa0e25968e24a65a\",\"/knowledge-medium/src/utils/dom.js\":\"28f90b5b7d811871\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"037f21c94066baf0\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"12c43f248a0c1fbf\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"24b20f9cb31ab062\",\"/knowledge-medium/src/utils/flipSlide.js\":\"6d57e7c89c101bba\",\"/knowledge-medium/src/utils/fnv1a.js\":\"86954563edebd355\",\"/knowledge-medium/src/utils/formatBytes.js\":\"0c9fc793afca2d3f\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"1254465e6c4a4e38\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"e3bd2eafe58821aa\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"a4767d4ab1b0c9ce\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"8351db371dfaf40e\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"c053ef08d1d5ffff\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"a5b96e8744922e12\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"8376bd9a860cf153\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"f1e58c91bab1b007\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"661059904485630e\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"bdc740bd1992ca73\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"998e76a386b4e99e\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"9ce3dcf3d2c197dd\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"5a452abf9c4d5a00\",\"/knowledge-medium/src/utils/markdownParser.js\":\"4f002189ad883303\",\"/knowledge-medium/src/utils/memoize.js\":\"0865cafb94dd199d\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"14da43e85353f0d5\",\"/knowledge-medium/src/utils/nameList.js\":\"e2b70363750a5173\",\"/knowledge-medium/src/utils/navigation.js\":\"078c0ff962336037\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"cc4325ea819b7b26\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"ec779617861fc207\",\"/knowledge-medium/src/utils/panelClearance.js\":\"122e45f505e922f3\",\"/knowledge-medium/src/utils/panelHistory.js\":\"3376403e0ed1d3c9\",\"/knowledge-medium/src/utils/panelLanes.js\":\"5314970b2adf6a1c\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"29e7b710c41a4558\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"9dfd94939ce09e16\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"9e85828e1acf4a3a\",\"/knowledge-medium/src/utils/platform.js\":\"18d820dc10d614e3\",\"/knowledge-medium/src/utils/pluralize.js\":\"228255596177f3ab\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"bd091b9ff85e538e\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"6fe1cd622973851b\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"03df33fa1b90269b\",\"/knowledge-medium/src/utils/react.js\":\"e8bde33722b7c00a\",\"/knowledge-medium/src/utils/relativeDate.js\":\"76698255d71cfebd\",\"/knowledge-medium/src/utils/relativeTime.js\":\"ddd8500828c7efd8\",\"/knowledge-medium/src/utils/renderScope.js\":\"1b45717efdc34c80\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"5c691fcc5946b0fe\",\"/knowledge-medium/src/utils/routing.js\":\"fbca1d9053371791\",\"/knowledge-medium/src/utils/safeMode.js\":\"56ef4706ab962d8d\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"75f583f9611c7fbc\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"d62c9dfa655d1fd3\",\"/knowledge-medium/src/utils/selection.js\":\"2350d711e84e303d\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"0a9ede91e38136a4\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"e9e1e196aaa6a4e1\",\"/knowledge-medium/src/utils/state.js\":\"59bdd64b7c8b4688\",\"/knowledge-medium/src/utils/string.js\":\"29fa16a72452146e\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"75b5691d98c13f54\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"9f821d9db9eba37d\",\"/knowledge-medium/src/utils/toast.js\":\"8b0aeb49113a69a2\",\"/knowledge-medium/src/utils/toggleStore.js\":\"9c8d39ad8683df61\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"396b615be3b0e439\",\"/knowledge-medium/src/utils/userActivity.js\":\"ec02242e40a9ff65\",\"/knowledge-medium/src/utils/viewTransition.js\":\"e290d2edf44de618\",\"/knowledge-medium/src/utils/viewport.js\":\"b78c0e369d663d4f\",\"/knowledge-medium/src/utils/webLock.js\":\"ff10681cb2f778ec\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"5f811ea0defb46a9\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"529534e003957891\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"d04e787650c1190b\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"40ab53b2f7ac8e64\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"820606b46ca6a820\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"14032082ec348016\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"93fe0b05d635c8bd\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"3a82e5c623bc9abc\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"48c2002f2250c0d3\",\"/knowledge-medium/src/vendor/react-dom.js\":\"82d3d249ea3ec509\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"e523cf45237e7736\",\"/knowledge-medium/src/vendor/react.js\":\"38815eec4f60f9d9\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
