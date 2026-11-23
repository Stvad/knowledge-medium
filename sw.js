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
		buildId: "64ac9862a3af-1d19a816",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"510221f2aba3b1e1\",\"/knowledge-medium/index.html\":\"510221f2aba3b1e1\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-TmvAX5-z.js\":\"c80fb1e71b0dbe75\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"b4621898615b3d56\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-P5LWhncn.js\":\"84bd0d2590158e63\",\"/knowledge-medium/chunks/FacadeVFS-CEhMSM_d.js\":\"b7719fda88d1a3a6\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-oYETLu9m.js\":\"85010353c9ca88b8\",\"/knowledge-medium/chunks/MemoryVFS-BhzUVR12.js\":\"cee069dd8046e108\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-KzYRON3i.js\":\"539f1ab2c17f2723\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-XNsrCI7J.js\":\"3ab79d89a2a2f72d\",\"/knowledge-medium/chunks/Preview-DuRo8xzy.js\":\"6346f22b1c7e3ec5\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-Dngrx6mp.js\":\"dcd45a2dad59dddc\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-CZt7Pe_T.js\":\"30357e36550c3f93\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-CPeXanPm.js\":\"ef973f37a66dfe42\",\"/knowledge-medium/chunks/react-CTy4AyUd.js\":\"063905ee3d333ee0\",\"/knowledge-medium/chunks/react-CnZrpwta.js\":\"9eb319b87720951b\",\"/knowledge-medium/chunks/react-D2hao1kZ.js\":\"29a727f75e6ec6e5\",\"/knowledge-medium/chunks/react-DIhuGMu3.js\":\"2a77d3578fb72ba8\",\"/knowledge-medium/chunks/react-UjpIlJOY.js\":\"041ed7716c46b583\",\"/knowledge-medium/chunks/react-al1WY-HQ.js\":\"e41759101f8556d8\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-BFOS4ibF.js\":\"4e716f2fa95411f1\",\"/knowledge-medium/chunks/react-dom-server.browser.production-YjIzqZ3C.js\":\"03418ed9e86a108a\",\"/knowledge-medium/chunks/react-dom-server.edge.production-BPUuIzK8.js\":\"f36ec68894179633\",\"/knowledge-medium/chunks/react-qtOqzr2g.js\":\"b0087786315e3251\",\"/knowledge-medium/chunks/server.browser-CDFdhN7T.js\":\"90b850e3a21b62e8\",\"/knowledge-medium/chunks/textarea-BIr6nc-m.js\":\"48c01c04ade6f266\",\"/knowledge-medium/chunks/ui-C8T2sJi4.js\":\"5b47de32c6e2af72\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"97b57403c4f28303\",\"/knowledge-medium/src/appUpdate.js\":\"a982a1326a61f24e\",\"/knowledge-medium/src/appVersion.js\":\"4d73479b1694f4b9\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"dd3abdf6127be72a\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"5c467d1fbc5942bb\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"8487f03b7054c950\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"8f2d53e9da63b990\",\"/knowledge-medium/src/components/BlockComponent.js\":\"e82e46d9adf72734\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"2ff7da0e4d831bb3\",\"/knowledge-medium/src/components/BlockEditor.js\":\"0d303b3b432e9d76\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"ee3078ecb912e031\",\"/knowledge-medium/src/components/BlockProperties.js\":\"50981ec5707f8d21\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"44f29e9815ebab2d\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"1afd90ed7928056b\",\"/knowledge-medium/src/components/DividerHandle.js\":\"0ebfe123b4b996ec\",\"/knowledge-medium/src/components/DraftEditor.js\":\"c8a89cb722fcbedc\",\"/knowledge-medium/src/components/GutterPill.js\":\"aaa22711f5583f5e\",\"/knowledge-medium/src/components/Header.js\":\"c74ed4d9d2af03eb\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"65612d37865685c7\",\"/knowledge-medium/src/components/Login.js\":\"c2301b4f4e6d0447\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"9920d0efef102055\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"d8f3d84730c5c547\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"1bd71754036518ac\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"1e09afa06b11bf46\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"735b83a9006600ba\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"1b32c96e3f1062b1\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"af51e94006fc6447\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"6e1e3e1ecfa7a3ed\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"6a84cc0231ab413f\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"4f70a61ef29b1db8\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"b8bccc9bfd1cdaf2\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"b3bcae929ef7ef5d\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"6c146d09b1cb27ea\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"1e539d77b031bef3\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"569fab6a6d167a55\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"571534931cab5d5b\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"afa027aa176db71a\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"533ada8e49e28ea7\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"1cb703d8de6a7a10\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"234344e9dac48832\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"529f25d77337c299\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"c60985d35f5603ad\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"4160e80afcf362b4\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"0da7b37534dd8e71\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"2b00811b71938b27\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"b392bb946bd10526\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"67ff7991fb33c31d\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"7ee434f769ed8ce4\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"6f31664c09d04bba\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"bb184b17ca9fbac4\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"9682f846b3f3b4dd\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"56f6d0fe0a0e2656\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"d72da5392085da03\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"57da24d4e45174da\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"44501d999b80b399\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"2c3445ba275a0272\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"c0f7d17be616d3da\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"165486aee3eee84c\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"979ef65c9111b2f2\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"03e099800d6ea126\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"4047aef2e6c8f7c4\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"06ff292432ce8141\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"e8a8e5cb3367a704\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"05993d7578256a25\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"daebcc5de98b4daa\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"8a7ceb671afcb2a0\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"59bf46fc9b1a3b64\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"c08b8573c6fb42df\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"00cdca3769e6c085\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"558edcfd566bc52a\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"d614fd73bf9511a8\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"9047bcc54f2c1636\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"ad71ba11e828ec28\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"f53d44b21e7a8d35\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"f05fd167da17c06f\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"91140cc6fad07315\",\"/knowledge-medium/src/components/ui/button.js\":\"c57dd9f88507a387\",\"/knowledge-medium/src/components/ui/card.js\":\"8ed7e037014b120a\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"74a308e695e9d807\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"22faffbe116ea169\",\"/knowledge-medium/src/components/ui/command.js\":\"aea0d7b952d12681\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"e8557141b34ceddd\",\"/knowledge-medium/src/components/ui/dialog.js\":\"37eee47e01149c12\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"02b3021ea0a025c6\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"06cda14d7b005b49\",\"/knowledge-medium/src/components/ui/index.js\":\"a9627f61f4574a57\",\"/knowledge-medium/src/components/ui/input.js\":\"8f4ec64b76b2e053\",\"/knowledge-medium/src/components/ui/kbd.js\":\"c0190fa68c1fbe17\",\"/knowledge-medium/src/components/ui/label.js\":\"1ce7fa38c95808dc\",\"/knowledge-medium/src/components/ui/textarea.js\":\"2b11dfc7c967561d\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"5c70c08569733ccd\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"cdd532661d2c73f1\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"7ea2eccff56901b7\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"67b4797d0c188900\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"1306f6817fbbc545\",\"/knowledge-medium/src/components/util/error.js\":\"125ac37823444990\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"b213f6d5d55ee703\",\"/knowledge-medium/src/components/util/suspense.js\":\"2d2d91ba4fc1390b\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"f3cc2639467720db\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"d8abc394519f2f25\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"4fdb2a1caa7ca71e\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"8214fa78c837ba2d\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"71177f067b5d930d\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"64bc02982dbc20e4\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"5774de748746b3be\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"977c680f1feaa5b6\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"8931ba091a67643c\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"d66d3db315e47a9d\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"be13dba6765b3742\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"3febcd2a8d1d2235\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"14af5094b7518fbb\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"c78610f907523004\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"fd0c883ad244b6bb\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"40a3445b60f3005e\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"4240a18cc03d1f6c\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"d467ec6dfe43d80c\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"1c020a8c87fe8000\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"d074b17c6c19959d\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"1a449e34b8502559\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"d8fef78995566881\",\"/knowledge-medium/src/context/block.js\":\"13490209c083fd84\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"55d2bf92b49286be\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"df8ecf4bf2d8ae24\",\"/knowledge-medium/src/context/repo.js\":\"c830f1aa86f6f8ce\",\"/knowledge-medium/src/data/aliasClaim.js\":\"66bbe70ce0e10204\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"35c6765d814d2afe\",\"/knowledge-medium/src/data/api/blockData.js\":\"b0eac3f738384e05\",\"/knowledge-medium/src/data/api/blockType.js\":\"6984b1b617b51521\",\"/knowledge-medium/src/data/api/changeScope.js\":\"d4d00135946ff440\",\"/knowledge-medium/src/data/api/codecs.js\":\"7722ea919e317c7e\",\"/knowledge-medium/src/data/api/derivedData.js\":\"f3cfc9efcce4f6e6\",\"/knowledge-medium/src/data/api/errors.js\":\"6545d1d7189511b3\",\"/knowledge-medium/src/data/api/events.js\":\"652cf290650ea16b\",\"/knowledge-medium/src/data/api/handle.js\":\"e9513255f83d3f38\",\"/knowledge-medium/src/data/api/index.js\":\"b83a0f36a0e02f84\",\"/knowledge-medium/src/data/api/mutator.js\":\"861b53e7932d7b7e\",\"/knowledge-medium/src/data/api/processor.js\":\"da713b7ebe24b0e2\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"95727a4c27408050\",\"/knowledge-medium/src/data/api/query.js\":\"66e14dc5fe1fd387\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"1abcd93456c22e6f\",\"/knowledge-medium/src/data/api/schema.js\":\"e9513255f83d3f38\",\"/knowledge-medium/src/data/api/tx.js\":\"e9513255f83d3f38\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"25142bfbee3be343\",\"/knowledge-medium/src/data/api/user.js\":\"2feb3147c21e2b33\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"2b566bd79d2beefb\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"650e3bc2d46146b9\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"b4c613baec6ad461\",\"/knowledge-medium/src/data/block.js\":\"65d9614eaf92eefc\",\"/knowledge-medium/src/data/blockCache.js\":\"89a183a05ed0bd35\",\"/knowledge-medium/src/data/blockId.js\":\"31c376985cf899d3\",\"/knowledge-medium/src/data/blockLiveness.js\":\"65c8da70bf3b9ffb\",\"/knowledge-medium/src/data/blockMerge.js\":\"545a25f08b5d0e35\",\"/knowledge-medium/src/data/blockSchema.js\":\"40302c8261f019ec\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"0533091712eb356b\",\"/knowledge-medium/src/data/blockTypes.js\":\"0648b40535d8b7c6\",\"/knowledge-medium/src/data/childrenView.js\":\"537a8ce19eca819f\",\"/knowledge-medium/src/data/clientContext.js\":\"731051aa971115ee\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"a3cbeb342fc7394d\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"99791b6cdf3aeed0\",\"/knowledge-medium/src/data/derivedIds.js\":\"6231d3b7bf86b53e\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"f7dc95913b743ecf\",\"/knowledge-medium/src/data/facetBridge.js\":\"4876a0052a480edb\",\"/knowledge-medium/src/data/facets.js\":\"42b012f0c2048648\",\"/knowledge-medium/src/data/globalState.js\":\"d1b33498be325e8e\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"1706679e7a1d986f\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"a42db7ba63b4ab49\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"b93611ce84e9ab66\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"b270e59c5b4202ab\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"1b428bdc93f740f6\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"cd0b6fbcd8252036\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"878a6485133db13e\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"78269dd99a6fca17\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"49fa5af921da02d2\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"99addfebf03ef7f0\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"80ae9d530b2a8e58\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"3ed7d7d68fff7cfe\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"d3dd60306626601c\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"df1ce29476f812c5\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"cb2e18d324265da8\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"4268c89c6f19cb93\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"b13f0f8e2f0b1a64\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"8e1f6dbdbe874ce1\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"81b9bb0d93cce46f\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"6b4fbfb9afe5500b\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"cb26ac394d4f1338\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"9bdc3147b8caa1fd\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"33bcd6c8fa776a6e\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"b0357e7644323f8b\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"05030e6c54aea5a9\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"0ccea83b359d3844\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"1b9c26ef8296b5e4\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"ba0c182b3024fbfc\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"8efebb42a585dc9d\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"aaa22f97c4c54374\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"38ad5e31acbe47f1\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"c9b72a5a32b2d286\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"cafdcbf9fc6a0cd9\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"eef43ae9f81bbdff\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"dcbd4bdec3419489\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"71fee8ff5e5441fd\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"9eb7741e073b63ec\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"e07e648f745627d5\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"cb1cb68a93597507\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"7a47621e93d72268\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"41234cedf9b7ff35\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"2300fa88ebd9d578\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"a3b917924695a162\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"ed46a51100ead4f0\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"d0d3f8cb2984ed49\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"f688a0e996727c2b\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"854d24800718a8e8\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"51c3c4bb32a24b86\",\"/knowledge-medium/src/data/invalidation.js\":\"251fbfa32aabb687\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"1556aa67d8842ae0\",\"/knowledge-medium/src/data/kernelPage.js\":\"2747b53b7d49ddb6\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"cc9a19c526c411bf\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"5e5256f94627b6eb\",\"/knowledge-medium/src/data/localDbStorage.js\":\"ee60eb3a62a35b95\",\"/knowledge-medium/src/data/localDbVfs.js\":\"c4c407553864bd0d\",\"/knowledge-medium/src/data/localSchema.js\":\"239ee7e42d8078b8\",\"/knowledge-medium/src/data/maintenance.js\":\"414c7378208324d1\",\"/knowledge-medium/src/data/mergeProperties.js\":\"5b91f6f9ec7d248c\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"f50fcc079910e10f\",\"/knowledge-medium/src/data/migrationsPage.js\":\"e5aff6f3cb764c60\",\"/knowledge-medium/src/data/mutators.js\":\"d643f72c58051450\",\"/knowledge-medium/src/data/orderKey.js\":\"31d8f02e7cedc55a\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"0245b82b69ce4fc7\",\"/knowledge-medium/src/data/outlineSurface.js\":\"0029998cae38c7cb\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"c394d3d9eecc33f1\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"351b33ed179095bc\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"3bd016b1e14d2fb0\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"6868215e8c5a4e0c\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"80141efacac0d71a\",\"/knowledge-medium/src/data/properties.js\":\"0b064f6458f8fc2e\",\"/knowledge-medium/src/data/propertiesPage.js\":\"47b8ee872914ed9c\",\"/knowledge-medium/src/data/propertyChildren.js\":\"6525b6ba00a466e2\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"01e96fd7f77d42f7\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"6c4a0a776e872f2e\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"289a12f93035d8ef\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"65cca4a852b33fa2\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"068c18364d698f6a\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"3f96140b6c240332\",\"/knowledge-medium/src/data/propertySeeds.js\":\"e7c286e0f38d7f67\",\"/knowledge-medium/src/data/recentsPage.js\":\"71ed0603d43507bc\",\"/knowledge-medium/src/data/referenceBlock.js\":\"4a7c1ff190b66c32\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"fddf566e73693e82\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"2a078752db824125\",\"/knowledge-medium/src/data/repo.js\":\"9bc23e1279fe6bb3\",\"/knowledge-medium/src/data/repoProvider.js\":\"f359f05c87ad6391\",\"/knowledge-medium/src/data/rowProperty.js\":\"bbb48ce5047a11ee\",\"/knowledge-medium/src/data/searchFilter.js\":\"787f449fdc7e756d\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"17934a1a66d5af69\",\"/knowledge-medium/src/data/stateBlocks.js\":\"5defb2659d9ee63a\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"3331061f282765b8\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"faa6525281d97812\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"949abb4705eea8df\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"0b8da0e3cde3def1\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"9988dd85d8cb370d\",\"/knowledge-medium/src/data/targets.js\":\"d20bd0957fbefbab\",\"/knowledge-medium/src/data/typeColors.js\":\"ea7bce39ea61b080\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"def2e5d538f64b9c\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"d274bf500ca111e7\",\"/knowledge-medium/src/data/typeExtraction.js\":\"6d5adede18b81309\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"1ee4ab5f48dacd0c\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"726dcf2b9d78f26e\",\"/knowledge-medium/src/data/typeSeeds.js\":\"75d49b7eb62ee964\",\"/knowledge-medium/src/data/typeTagger.js\":\"d459d5805a5e763c\",\"/knowledge-medium/src/data/typedRecords.js\":\"4a450f609fdb8961\",\"/knowledge-medium/src/data/typesPage.js\":\"16175b8d96b60dfa\",\"/knowledge-medium/src/data/userPrefs.js\":\"315f6e77d59b7eda\",\"/knowledge-medium/src/data/userSchemasService.js\":\"3d66d81d5bc40e0b\",\"/knowledge-medium/src/data/userTypesService.js\":\"99fc9b413b91f356\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"29a2fa784859e3ad\",\"/knowledge-medium/src/data/visibleChildren.js\":\"853d4c57aeffae6a\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"83c9351b03332cc2\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"c9b2e7939ffc84f6\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"d46f6e99cc00a7ba\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"b8b4643198ae0f6c\",\"/knowledge-medium/src/data/workspaces.js\":\"e5df725bf17c36b8\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"16f483a2b0ebfd4c\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"1832aee4c2dbea1e\",\"/knowledge-medium/src/editor/atTrigger.js\":\"cadd2c0baba513e2\",\"/knowledge-medium/src/editor/autocomplete.js\":\"25a364444f565e45\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"357e9dc5bb0570d0\",\"/knowledge-medium/src/editor/contentFlush.js\":\"9143d15ac6bcb528\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"367cc4b37c170a91\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"093f4aa97341d408\",\"/knowledge-medium/src/editor/insertImage.js\":\"8196adbf6add31f8\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"aef385a78f671022\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"d52fcd87ae7af5a2\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"b3cadf8f505570bd\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"5ee299317c22eea6\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"ff94ef42cf308b8f\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"018c3a9a5a73dde5\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"e561988a88a5e318\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"9a2cf47a63be415f\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"6ef746ef99830e8c\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"2a068c1b4e67f788\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"538850f0498532ed\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"a0a3716d1182f52f\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"55fdd76ecaaf561b\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"7ea6249b43e216b1\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"2f318885d0ec0bbc\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"5213f8eb02d5c0b7\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"e6b9cf9ddfae9fcf\",\"/knowledge-medium/src/extensions/core.js\":\"82de081d2761d5c4\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"aec351daf1c5a648\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"5a0c792797b7b1de\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"4b9c19144a7f4a3d\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"9f6f5a377239eaa5\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"5f49755d1391d779\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"7db24098baf12035\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"1fd2188cae02cd41\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"116fa555fc38cbc7\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"b605352cfd583ad3\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"526a75e889a1c2e8\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"803096d91800de7c\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"e4b0871636ab36d9\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"65553cf596efbb46\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"102cf4a756e56c42\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"fc996596f340b39a\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"0cbf943f9692de08\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"b3cc033f4372cdf1\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"1e9ff8634590c8c6\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"d82556e00807463c\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"120356c854354949\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"6302d539c9f54559\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"9d0af1c86cebe613\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"0623b2159cd2e130\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"030516d3b91d4959\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"bd21ec68ea0aabad\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"0bbf1f76b8e8a24d\",\"/knowledge-medium/src/facets/facet.js\":\"9fadb32596760169\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"10351451ecd96093\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"f5da43f140f5249e\",\"/knowledge-medium/src/facets/togglable.js\":\"5d6119c48de02396\",\"/knowledge-medium/src/facets/variantFacet.js\":\"a35b7c53a2984ba7\",\"/knowledge-medium/src/facets/verbFacet.js\":\"bbeb3b81f8af9df9\",\"/knowledge-medium/src/hooks/block.js\":\"ff7fc870a5a5df3c\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"8c51cd167c3936ac\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"e1556584a5810644\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"d26233747d748b71\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"4fa748ff4b507ad4\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"ee4601d518e78d5c\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"58cf8edf052264df\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"db6f13c6fa0035a4\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"8c1e8c8296b45278\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"9b340e7786bf17a2\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"ed62f86b8ba44e2e\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"f17c647d17436709\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"586dc96d8350d10f\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"9ed6de6b90d99cf5\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"640f8014691472ac\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"86e18d4842a37b71\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"f1efdb9cf3262428\",\"/knowledge-medium/src/lib/utils.js\":\"6be6c8f8d3894b3b\",\"/knowledge-medium/src/main.js\":\"baa5eb8c6520b307\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"0bce0d39989e0406\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"fb0d4a828635a065\",\"/knowledge-medium/src/markdown/context.js\":\"03471e5815956aed\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"ee0d8eb44ace6cc0\",\"/knowledge-medium/src/markdown/extensions.js\":\"ae222762739ca451\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"9909e06c883c5211\",\"/knowledge-medium/src/minimal-editor.js\":\"81449a4ff5dcaef6\",\"/knowledge-medium/src/paste/armedCut.js\":\"e4cbcf52bf358789\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"b1c8d8c817f9203b\",\"/knowledge-medium/src/paste/clipboard.js\":\"66615b5343150067\",\"/knowledge-medium/src/paste/decision.js\":\"5320f1506924e015\",\"/knowledge-medium/src/paste/operations.js\":\"01740dea4793e0b4\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"b9f2d2b79bff84e9\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"849f218c85669ddf\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"88210b244404d00a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"c20fd24548a4c212\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"f09935b4b2e41abc\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"3c3d5cb88df8a851\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"636e62ed2f6dc677\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"edba1b932b3b87be\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"10185f2d02e79f28\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"39e345f7bae8ad8a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"8db3a52082f59abe\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"43e54e375a4480dc\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"8430e946e978aaad\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"4e76cb8d42939c0b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"ae7a4df9020a549c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"e77a7e0199eace0f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"62cb0fa3b32bb7d6\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"5cfa675deda99269\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"1a6213c7e5d91de0\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"cdec968a3c6084c1\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"c8abaa4443fcfa1b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"064e49868d1788d3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"7bec5126074d918f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"9b413a1a4d6ade82\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"dfede43e9bc6ea55\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"373786bf15f9e9eb\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"a03a9a2f549a7345\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"b97d070d21f297e9\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"02635183adb7f92a\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"0ee7fa1b729f50a4\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"57c84c333de066f8\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"3d5b4bf58c73653c\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"ce8330f86c77ccd4\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"0f40925b4654235d\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"bdb3353123d44d25\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"0242f210034954b2\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"9e5a80ba02959caa\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"a41485656dbc84f5\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"b513a6ee0801a566\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"af3276ee9728675a\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"6e8d467ae2e0da20\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"994931ee933527cf\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"f5cac3858e50adbf\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"ec6ccaaf035292c7\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"5742ed3fed0e2603\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"d2ebdfecae56c30d\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"74cba775533f10d9\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"75f266984398e1cb\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"5983e77fa0675556\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"85127f3df8dc5b7e\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"ee12db57526dfc0e\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"a432c62dd7dc6aaf\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"6f2d7b1f8b69d2bf\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"d51007a8aac3fa0c\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"3f55a5725e98cbeb\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"6a149cc10a34526c\",\"/knowledge-medium/src/plugins/alias/index.js\":\"ea5b64e1ef87f391\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"68700646f9d4a55e\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"1735717d2cb7b949\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"fcebc29dc8776b91\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"3000446eaa7f42e4\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"734e344eb5b87adb\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"f93fce1cc74d7974\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"47f3018edd405a96\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"be032eac36a1e357\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"f45b81e9b1ed0e39\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"ba1fcae3ba9d5ce8\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"71bc71a53d07c955\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"3ea1290d7ddbff97\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"79dc6b7d52ce1444\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"84a098b6392884b7\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"43d910d81b887794\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"7cb52617c692cb87\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"d486b4ec01c90e71\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"d252a560eb63151e\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"c70e98da5cad50b7\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"375115dc22a57122\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"a512feca28227454\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"7fb563d7f28509f9\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"304589fb7e2a6c6e\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"47172072ff57c5b0\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"e8730e56a1e05253\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"9bdaa3a149a59bca\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"414996a9ecc31672\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"7bd0f973c7804f86\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"13ed7382ac9a4c6d\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"17fcc3b525ed78ba\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"cde4cd09a465b017\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"66b2a71478be98db\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"06721a07e75718aa\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"60cfdc2dbb3a21c1\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"d2b7f2143e1ef1c1\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"3519cc800ead25f5\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"c6d006f6f18dabca\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"ee0880ba4127df96\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"9314bdb3b1f0bcee\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"66128cb1c5786169\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"b5b9ff2ac9592249\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"9a6bbf8e5fc32407\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"4065d3e06fc26e1f\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"6dad3161e8ef2f39\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"c0ec41a2efb8e82f\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"24f0d77bb48fdd0e\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"6100e9f744dd7e58\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"2389c4a6d1a5f908\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"3d8d4ab27d8a5db8\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"bf5f6d14ab58908b\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"dbd3275be8defb7b\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"0b7371aba8f4e310\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"a8f88063ad94843b\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"30b23023198a3f87\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"64f2ae839b6dd388\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"ee6916c366215260\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"7924fdc4869b5822\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"378e65b6342f62c9\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"507fb59826bb7172\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"cbcca62155f2b62b\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"368bc21fb5c4a5f0\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"b107c2b495e25ccd\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"574839d5e74bf907\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"1a30b284942f2296\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"db349a8e3754f564\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"30bb3c9bb9ae9d1b\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"9d3a0bf433ebcb13\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"cd186a4d6eca4969\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"b947100b52f0ff07\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"56087d51ed27e269\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"2cf6a4d6e3d844c1\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"3c34eae9a2a65f9a\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"324b8646ead07096\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"58dae3bdc8924f11\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"339a51b74fc40b11\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"e93c33db592ab377\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"197d472b60e636cf\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"1db9ed11e44e99a2\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"6886855e3ca7eacb\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"97cea46945a022d2\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"522adb759efbf642\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"2371cea64c240a68\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"82ef39a92e90cfc5\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"078bcb31b4a9f42b\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"56481728aa7725c1\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"713744d664405c23\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"8e98219fb0e33d1d\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"228d1c7e22ef3044\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"d7c157df19d12247\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"6a3c7745cf23bd0e\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"f0e56fcc783e8cba\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"6873423853e2363b\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"df4fa9db861c2566\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"cf7b67fd3ef53cc6\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"351ddab40143d21b\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"3563ab764f6024e0\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"65e5474890e04d8f\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"065e3455a489a771\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"9050f6ca6a1d61ef\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"e7c1caf69857341e\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"ba7905a4c73c9038\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"8371a34dcf9b48df\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"21f6d9a66295702d\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"6b7ebd82a3603bd5\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"37e0234bcb81beae\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"1d2a58ab7af32728\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"b6d7dfdbb04b68c6\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"dbae49595802caaa\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"02cac45d868557fa\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"86096330c471acf7\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"99a4584fbd17d1af\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"94ae1dd82af5c052\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"ec9bfc67976b0228\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"e4a4e7175eba2879\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"9ff161d1fa3f72bb\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"91f32de9fa4438b1\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"4d70f81ad08541a9\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"696ed07aa783baa7\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"f502d2fb1dc1a602\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"7eb747fc2073b8f9\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"b88e411b8a8cca6d\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"632b77bd81c7c776\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"6660655a22f21b7c\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"056ce4cb5b575069\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"96f098f26fd261d4\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"e217fcb1788b3db1\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"fa2bf001104d6aa3\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"d5f130724c121bde\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"8c05d7e3e4d8e2f2\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"9e9e4976093c8d9f\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"f734f62b4eb319b5\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"7a70cb453e9f95a5\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"a76c2f175c928479\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"b9ccf3c7cc0492b3\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"d204fc216a264ab8\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"9c654ab40cf98eb7\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"b1ffb18dd391ca7e\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"3355922a8f58eb78\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"44e70e1d991cf1f5\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"e84065055b9d3276\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"ba6fce83af7f2741\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"ce02beee8bc7bd78\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"2b732b9900e1e178\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"a08182b3ebf1677e\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"3fb65a7e6c389a19\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"ddc1493791b636e2\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"0bd2a41dec579bca\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"0cece3a639cd78e2\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"05bb0b2fa7a0f725\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"1113f7894c3d059b\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"3aab4458f240d043\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"12f01f92c2084c64\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"f36a8ac21c4de3c9\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"876931f4392dab28\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"2f1478094bfad84f\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"e10c384a0a104763\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"0ec31613db9d6f5f\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"1fcc1d4202ed8426\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"cc2fef06e2564f67\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"8556e0dd52e7c3aa\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"d14f174ca22f45ed\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"06ad5efaf3764900\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"1cc976a1c151b33d\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"919618757415ab64\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"3cc9ce3504277cc6\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"e67688c34d36c93a\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"ef49507b7b7f2b26\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"0574c4ca46fcff70\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"ddd1c8aaf97d6221\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"33c3e161e0dd4b9d\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"9bd1fb69955c6ced\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"5a704acde392d8c5\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"0a2d07b1fe0d353e\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"04ae67d9d0ac25a7\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"85fb2940bc6f6050\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"3a49943cf78d8ebc\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"36890ee0670a16cc\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"52b3f865825d3eae\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"96719e6879ebad0f\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"1dacbe1044f8962b\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"a1f62fce9aff9eaf\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"dd2e82b2970ddfd2\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"200fc75b63fde6db\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"21807393d5020be7\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"aa36e2f19f0f66c1\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"6c3118d3ea90c46a\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"222fb5b8c1a42b7d\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"15f21edaa3f1db26\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"bbc576d10ceaf064\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"385a55fea1c4b865\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"aaaae74f585a4e79\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"4d605066fdc031b3\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"abaa2b5be8745f6b\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"0baf2a24342f40b6\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"8bd7a7d69972b82c\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"8c8096b2de053c5a\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"f1edde7cf6aa6631\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"1acf361c1dd9f91c\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"cd0e234c5563f4b6\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"ed5e7d41ab15d453\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"81c30a1369282ee1\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"d8a2dfd6b71e7e80\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"1bc180598ea3c9d7\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"447ea2311586e370\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"a43bbb3ad4d5e544\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"3f63c852b85a899a\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"63d0df2b931c61a8\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"63024fedcd2e29a2\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"35e560170eb6a307\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"6dd3e62342d7eeab\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"94fa77f5701cdb78\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"9ce680ace64757b7\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"03b727a7f3dc755c\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"e11f93520518c46f\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"0e56d1de6ae9c6e6\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"e21bb3132bb487f9\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"c3c946ad672644c7\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"d7324c1624530ac1\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"632f652980665d1d\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"b02d25ada9a1311b\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"dc64a659e2f9e0d0\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"ce977743e5e02cf0\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"efadc5b452225275\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"05495482c6db4d14\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"a6882351b43006b6\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"836661de8a48c5f6\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"1426b09e2274dbf2\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"f3136320c2a7c090\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"be5bb0aaa0af6633\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"da72b3eecf7aa7a3\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"a88e3b1798b9d573\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"e0daa9d26402dc24\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"99a538983be279d6\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"6ae6579fce0d8116\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"c39ca1047c845470\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"d05aa43bccb1e24c\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"4b5cf7ba8ae9285b\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"2aa4f6234e85bc04\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"6d1424f49134b22c\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"ba0d8527676f0a2f\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"3afc0c5fe4487b75\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"be3d99e98e64088c\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"73695a24aebb2029\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"243a7732fbf50fdb\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"f8a45fde5ec5ec08\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"8291b170c6947a4f\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"0efb3d0909a2a793\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"5d62a3e4130f777c\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"de8400f1606b480c\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"61b3e52d91086937\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"18bbb00f0733e324\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"514b84c2a87c0edc\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"e662d18a3ddc8c46\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"eb3cf682132176ac\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"8539d5c7eeba2e80\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"5a67372831b6f3cf\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"b948cfeffb395e01\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"8cbb1ec6786aa37b\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"5d8656a58fd80021\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"e8da4a0df9e1a810\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"b4b619a79d0841ba\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"eaa240fe2f0ac487\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"119ca0ff25e7721a\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"b48aa59cbb140aad\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"da75431d3eab3ddb\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"e4045c1b0f4d4fa0\",\"/knowledge-medium/src/plugins/geo/index.js\":\"d4a0a9555f6d93b5\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"98bd0ed6a75eb463\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"3b63feece099c615\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"bdc4261368db240a\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"22378efef6beed82\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"6675e0d52ef219eb\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"672a3d0cb8542f98\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"87586776ab51b84d\",\"/knowledge-medium/src/plugins/geo/query.js\":\"42d5615724c7eeae\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"19de87879a8a6f0b\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"a47ed95774995f55\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"2a473eb572d94e84\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"52391ce0cb1e600e\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"b8f0c7381040630a\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"2068df506270756c\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"98847c5700b528aa\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"75daa992d7406c38\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"ebe0eb80fc98b53d\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"573bea7da8fd525a\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"f412f1d6eac2af81\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"04af5e74158ddaa7\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"5188214b819c52ca\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"cfef31d1de662af7\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"aedae04039379f80\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"5d78a2573dfd798c\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"d39b451f01271486\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"f52c19a6315f57cc\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"722104fce29b79f5\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"dfb104f525ffa9b6\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"99b2527667526ce9\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"89cfd0ae7b8309b8\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"3bad87ce791b1fbf\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"3eabaa7bc99776d5\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"af698029d4780624\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"c693478d2087ac00\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"b753ace511fc68c3\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"7e8da048c7c4e638\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"3736041be4a1daa6\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"ef63ecd4445e2ced\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"d5a826938c07bc9f\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"1648fce6fe84142b\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"b9fd69312cfe6274\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"f5ef112bce60716c\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"4143c2f1a3822f67\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"033833c53bd9432c\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"63fa66866b48ad61\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"7c8e0889364e6ae2\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"f9fb90e7d4ccd598\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"b2761c3f2e3f748e\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"8e5b3722f29178d5\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"173c5811f30530a5\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"49595e63dd27c4b2\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"d3791db3ee68a80e\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"06a75907274ff75e\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"b333a367669e9856\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"43ce69542f8427f5\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"69ba3605e821e15e\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"620fe312908c1c2e\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"c3de7effbf223bf7\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"02e3b484fab1840b\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"d636dfc61102c4d8\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"08d1e8493b2db896\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"e1dc3542b764aaf6\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"f19c0fbfa9123d5f\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"706071d35b09646c\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"9a31d5187014e716\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"5f06e9f14d8f4da6\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"49e07979039e591e\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"0684486a8e42e6a6\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"75a1a7114eea2226\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"8b5fc2d26da58b34\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"ae150d5b5f11cacd\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"b4c4028f061c6ddb\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"939459924f2317a1\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"9695ed04d1533a7c\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"e9efe3558620f6d7\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"575e147f1c0e182d\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"86714aa7a6c16f07\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"5fbc085460d101f5\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"7d995326c7b6ed00\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"8c794404b06e1625\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"42de7f60c5817c50\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"97701f76ae8dad77\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"6051bd7800c12036\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"f6c52cb1cf247b6f\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"dfb774f09f5fc9e5\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"58ad9e76c639f3c2\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"b8fc0247db125aef\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"5d4bd5662cd0ecfb\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"41378ab732526160\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"d57d051770410501\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"19a39405acc65596\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"24b6910dedba8353\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"ac7eb72fd2a4ba51\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"d6637825c821140e\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"331dcae49c61f901\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"4fa8c3d96089ea02\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"e131e863ecee4170\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"42c624f65118543f\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"e4b2104cefb8de19\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"4fc1340fa072b8e4\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"e6cafad6bf5f849e\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"4d0ecbce9d841462\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"d045203fed67e663\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"66b32231ad5ff7ca\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"229a474e544eb152\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"f57464d37032488a\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"96638f269a151ff8\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"141df73554de468a\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"703dfe76d31f744b\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"e3d62cb0516b1142\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"70b58c5544c2f9c6\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"581a392817c305e9\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"2802c872f12466a7\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"f0c7a52036c80f91\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"fa1da3312ae0edc5\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"d096ccadfc3b4297\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"844d9dce3b590337\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"0263d81855eb8ed2\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"dc3d437e3e75b4d2\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"7b7804c69fbfd775\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"c6659013de12c4e4\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"36aea60c5ac1946d\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"a22a7315a84827f0\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"21b555a60f206f67\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"de12027a1326c824\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"d555dc0629c15295\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"428f4089b0d9d65e\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"c4385270997d4e9e\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"5ab832ca968cd24a\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"cc11346f6fac2d2b\",\"/knowledge-medium/src/plugins/recents/index.js\":\"18475bffb14d7bce\",\"/knowledge-medium/src/plugins/recents/target.js\":\"d002cd314cf89f71\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"a0e8914012e34430\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"131a465c7df3dceb\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"d516ea3eeb06b286\",\"/knowledge-medium/src/plugins/references/index.js\":\"47c3ceb28c8edf4b\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"e8117c853f9ad3a2\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"a13f4b045b1fb66c\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"356b9270aed12d18\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"738e1afc6d900a05\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"97b9429a18b6c474\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"bbc6ed8c2cf46e5c\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"c3e4f8fe3fd52aa2\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"580d3274aba6e7a5\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"be517b7b81b46dfa\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"9f60d7ca27af2b90\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"ceee355600c7b3af\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"ed7e0106810a606c\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"8dbec195bebbe9be\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"2bdd72318f093ba2\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"ed674986b3830a9d\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"cf9dc89982e9ecf6\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"96a97bdb4a1c2226\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"ec8d2a5cf9a0c477\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"d3224f2c6c59c70d\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"4a656b0148f1988a\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"76a6041d0f3735cf\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"657a166b2a76a5a2\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"7d3a7559bf214079\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"46b7442d1b7a7bed\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"419c6b4c8fa9ecc9\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"dbf8bf7cb5ab8eaa\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"c3e70d0dec63be14\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"ae5b177740649607\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"18176fdd1f809244\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"14b3284d43a9607f\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"590429af443aca84\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"eec4af827ff35c20\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"0c3ea79b435cc48b\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"e30534acbec6326c\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"fb7a1056ba81c862\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"ff6f1990e5bab511\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"8257ec254415be33\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"d54e7de090adc51b\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"3afcd24bb02be25e\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"c645a24720cfad99\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"a488d26d25cc0a4e\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"ce5be98c4e498d7d\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"10a944193743dbaf\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"55abd6c142d6e8ff\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"372d3b99e94bc40d\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"fd09194d9ee55aa4\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"362bc8d8ebc1a2cd\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"97c646daf8bb94a9\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"7cbfa635ecc00df3\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"b792863a7ae46ff3\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"191a1d401d3174e6\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"c9bb7c830fc09197\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"53cbc239a2fb55fd\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"5d1570907cccf4e4\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"790f7675b38a0e1e\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"2d6105bca6d7662e\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"6bf476c2db5c1ae8\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"9876e8e05e3143cd\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"2ec6d3c59bf3f43c\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"fedd021e734fb787\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"b83fe00df5f344ee\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"b88d9250d1faa9d6\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"f23c7918b5e8054a\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"3b5d1c26785e3fcd\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"ce72bfd74e5c13f9\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"2a163eb0bdc33d27\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"9e46890a1eb04baa\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"51e5b5c1f0a8eb82\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"faeb93aac6e13fa1\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"1a7480ebf53c63cd\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"a5789adbf6d77395\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"5af93da3fd64a238\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"eecd30c1805e86a2\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"74548ac2c537e251\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"f6f452da99c5e08a\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"e4c7dc2073d3da62\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"4d7e0d750d284624\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"bcfc6534ae3aa5d0\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"fe23c2d947a2cbdc\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"b0399c42b66246f3\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"a54d3d2e58d07d3e\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"9666e865a4534cd2\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"b06cfb8628cea557\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"ef83039c1c5b69e6\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"d546dab60140bd16\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"eafd89d7fa2dfc9f\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"2ebf3d6fde1125f7\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"2718cfa527f25d55\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"0157e69fddda8769\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"9764a29d8cb14fe4\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"fe591a2a383d879f\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"cd1deefdb6b12067\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"aa0b4e1439de69ba\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"ae4387ecb47c2e22\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"2d42cb1d91967ee8\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"68327d19f3fc3c38\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"67cd69147a78485e\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"f9fa8d418a5717db\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"a969f7c09b620fb7\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"7803f37ca23c210f\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"fb53aaa6a056fbe9\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"64b70ecceca4fc97\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"8978aa068d1f97b0\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"7fda7337bc4806ae\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"1a85495bd1d6d66a\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"66c2823a4c283f8c\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"2f254e867ad4eec1\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"c746b12b023c450d\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"aaf78e1b07eaef9f\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"35982fc533ffd350\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"78a8019e7ec79739\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"623e31616feb45fa\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"f6c2360848834f3f\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"f3ab0a24540f02aa\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"0f14dc4b7361a054\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"540245d8ece60e52\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"c52bc39af062a14c\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"c9cc98c182c832dd\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"e8c1572c906cb9ef\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"a8020b7397bca3c2\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"3e615ed2ed8995b7\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"7ad2ec806bdcf7ce\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"d059da3a31717476\",\"/knowledge-medium/src/plugins/tables/index.js\":\"ec6794628b2cca25\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"edb793b017f877ec\",\"/knowledge-medium/src/plugins/tables/model.js\":\"9b5d90714cfa27aa\",\"/knowledge-medium/src/plugins/tables/navigation.js\":\"7f40ed3d4173a834\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"eb7da7e9e796737c\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"f2506b4511e6763e\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"b6de4354469a99e8\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"fe33d97869aa90c2\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"9db562288bb3807d\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"da5efad7294a40c9\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"aedf790aa5bbd613\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"f7a0c9a51d8d0ab1\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"26539cac4568f988\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"08e93ea4af56061d\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"3af5e9f78855b1ba\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"2e13c78fbd26c552\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"a51f4fb6a68e37dd\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"52cbc6dbbaef04c5\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"fc7aa20ec633dd0c\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"cb3ec0e00ebe84a3\",\"/knowledge-medium/src/plugins/todo/index.js\":\"97b163155c073af2\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"8a06bc47e6e6e0c6\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"66f5435dada4932a\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"96de2d030d65b7af\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"a66852688a31d083\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"b72a198a26039c6c\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"42d18cc74ba07072\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"eaee07b2bff22259\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"5ee860defafaed77\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"ec95f658baab8e85\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"5c367b4dbde11790\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"99a2507aabbb2fdb\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"536c58bb5a80b0e2\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"c2b134d6ac25dbf3\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"068f911ac200172e\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"69b3b1bb79062a5a\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"c2501114ecace649\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"d3a02870e415a908\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"fb3ffa13dfed1495\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"814a534ad29269ed\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"bdeb00d327321687\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"7e0d98a8f9ce4af0\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"042c9ad90f45d4a4\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"fdd2295e910de16a\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"39c7ff9ad2e9efd5\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"1a99333350384438\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"00b039c99d9c8cd4\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"e0461c198a08efc3\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"ec01985f5884d9e7\",\"/knowledge-medium/src/registerServiceWorker.js\":\"38d16a87c7c9109e\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"33dce350d9683d51\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"8096b8e7e2426ec1\",\"/knowledge-medium/src/services/authStorage.js\":\"1129c5d7fe86eaba\",\"/knowledge-medium/src/services/powersync.js\":\"9bcab6801fbc60a7\",\"/knowledge-medium/src/services/supabase.js\":\"601c00fd72a66de5\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"4ea0992162b68508\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"73b21d796a20f1b6\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"44b6b2d78a7eec45\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"8bfd34e361c2c791\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"eaeaaa8e1b403e07\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"dea87688142e87ca\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"462f09fc784d8647\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"c33b42ce1de124de\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"78d65726ba78750d\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"c52004a33eeabcc7\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"59c26b76e89fd64f\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"5689c8b3cb91be6a\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"33a1fb2c7f5e0785\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"ba4c37b14bc9c625\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"50fb6787969f57de\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"cedceff910cef1c2\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"cc650cbf77b984a8\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"da2cc10fb4f20fa0\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"6d9482d8e1f9f8ee\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"7d621bf01ec761e8\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"4ed9f34d7973bd28\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"966793e808e51d09\",\"/knowledge-medium/src/shortcuts/types.js\":\"93b727b5b893943f\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"e8bdeffac108b669\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"01969cd2061ec21e\",\"/knowledge-medium/src/shortcuts/utils.js\":\"eb4748e058d6c830\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"d4bab171fe3f0504\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"ffe089759d212943\",\"/knowledge-medium/src/sync/byteTransform.js\":\"9efb5840d6f1bf5b\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"e7e09d1a6fce928c\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"47164ae4a802e4f2\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"c0b53c066885d3fd\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"1e39a24f4daad158\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"2e7188a773eb1979\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"4aac6706e51babff\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"127de2cdd7a9450b\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"eb46ed3831ffdf32\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"a43c8b4421fcde7a\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"579c9eae0dec6c33\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"2d57fb9462ed9d4c\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"f4a824635482cac1\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"c6227b33eef65d6c\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"5012a073769242eb\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"5c1bcd63c9ea9bd5\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"90442605e6198af0\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"d2576c10ffecd71e\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"8655175bfd63def9\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"39147bc27ee707c9\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"1a1636636b7651fd\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"d50e7b7f11b7ec63\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"e92ff98d127adbbd\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"84581fbf5fc46aba\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"4b01a265fdd4a265\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"cf76ae355134d003\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"0d439ef474f84c02\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"0d69ff4f680e1e05\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"e01ada477b058d6b\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"10a54fc6baf27980\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"97461bdfd819f07c\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"c3c69c126e3fa8ce\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"8d372c280d122e80\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"7366e3c5bd098272\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"de6b90fa426bc0be\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"adceed6fc19d1c50\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"3a82a2118fb009ff\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"3624148fa2587b5a\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"89d2c9910f55dd79\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"31f2ac0fe07b91fa\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"7c87f07710d9b0d0\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"3bc134c3cb7e8488\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"40e1f4177ca2c86a\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"23121dff4961724d\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"56f0aa2da9523af3\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"a40c443922ed1b94\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"f69abd6daa6449d9\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"4463298da58ad448\",\"/knowledge-medium/src/sync/transform.js\":\"31c84736d4f535ac\",\"/knowledge-medium/src/themeBootDefaults.js\":\"917c5863ca4f53e2\",\"/knowledge-medium/src/types.js\":\"1e548a7a3caf10fe\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"086d9c4e3870b699\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"89bb9d28ca42aa8d\",\"/knowledge-medium/src/utils/array.js\":\"c9aca02db7221d45\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"fb3395cc82826786\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"d5eff3457005e147\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"b708bdd1361bcca2\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"be8966fae93d716f\",\"/knowledge-medium/src/utils/callbackSet.js\":\"37d4e492020842f0\",\"/knowledge-medium/src/utils/clientId.js\":\"b20dbd2a2c83a2fe\",\"/knowledge-medium/src/utils/codemirror.js\":\"c33fe5fb0c679bf0\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"0dd90831ea35e1ef\",\"/knowledge-medium/src/utils/copy.js\":\"51720bedd3627031\",\"/knowledge-medium/src/utils/dailyPage.js\":\"f3cba04f312c0cd8\",\"/knowledge-medium/src/utils/dbForensics.js\":\"0878ea3aa1d18b40\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"e265f8f0948d32f9\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"6e81c657fbfee595\",\"/knowledge-medium/src/utils/dialogs.js\":\"cadae3470e37d129\",\"/knowledge-medium/src/utils/dom.js\":\"dbc3cf78d3ed12c1\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"0917cc25076d7aba\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"a1dc73af85bcbccf\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"c449e48cfe00f2e2\",\"/knowledge-medium/src/utils/flipSlide.js\":\"24e33580ad53f34d\",\"/knowledge-medium/src/utils/fnv1a.js\":\"51ff816ca709e76d\",\"/knowledge-medium/src/utils/formatBytes.js\":\"22503b8e9baf6fa6\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"89f3d9b43f6d8539\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"fed2a69c79cf4fb2\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"cdfc4111da5720bd\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"06548e3153bf36cf\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"5e5a863ad2a6d6b4\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"d1e5746b080fbfac\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"d084e3fe4db8266b\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"9c08b86c73c99c50\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"9fb9a29d42d39d89\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"d7e016ca2b78e5c7\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"1ed4d9e0b08d4c06\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"922a65cd5f815c98\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"88c87784bbf3d039\",\"/knowledge-medium/src/utils/markdownParser.js\":\"fdda63c3ace14526\",\"/knowledge-medium/src/utils/memoize.js\":\"dc2ae01fd9b3e7d9\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"4859b0144258ea38\",\"/knowledge-medium/src/utils/nameList.js\":\"c1e7e0d5d0998860\",\"/knowledge-medium/src/utils/navigation.js\":\"f9c45a31cddee6e2\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"b555fa9549e338a8\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"0a5f55abc79374ff\",\"/knowledge-medium/src/utils/panelClearance.js\":\"63433d2122271046\",\"/knowledge-medium/src/utils/panelHistory.js\":\"3a8606365097cabb\",\"/knowledge-medium/src/utils/panelLanes.js\":\"8f2ef7bc51a11399\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"fe050634e21df138\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"39a39671cdffaa8e\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"d8c5266c6f38303e\",\"/knowledge-medium/src/utils/platform.js\":\"85e8aef6e05e2aa6\",\"/knowledge-medium/src/utils/pluralize.js\":\"6618c06ea30a87bf\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"f7d27cda17a52fcc\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"bc78bce8d59f7e85\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"44bafc6c5cf80966\",\"/knowledge-medium/src/utils/react.js\":\"31fe34f5fa76fefd\",\"/knowledge-medium/src/utils/relativeDate.js\":\"7e07d7d421d2b150\",\"/knowledge-medium/src/utils/relativeTime.js\":\"0b30298aa6d287b6\",\"/knowledge-medium/src/utils/renderScope.js\":\"7175ec6bf7b378fe\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"e2724e9ead9fe10b\",\"/knowledge-medium/src/utils/routing.js\":\"2252e44c2bafe786\",\"/knowledge-medium/src/utils/safeMode.js\":\"f7f0289db03c0cd4\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"61d18304d5f1932b\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"9f1d70e119b5e71b\",\"/knowledge-medium/src/utils/selection.js\":\"1a1e2b96ff6479fa\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"2de8f106e849763f\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"ecece87ba01e6ef6\",\"/knowledge-medium/src/utils/state.js\":\"5f35452bd8d91455\",\"/knowledge-medium/src/utils/string.js\":\"5e0e7b6b8ef5f12e\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"8d9108a74596e81f\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"f38d2d9d16301826\",\"/knowledge-medium/src/utils/toast.js\":\"9e83e3b0dab14743\",\"/knowledge-medium/src/utils/toggleStore.js\":\"0bd210068a11bfe9\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"7549972fa27c3714\",\"/knowledge-medium/src/utils/userActivity.js\":\"4ff95781281b9dea\",\"/knowledge-medium/src/utils/viewTransition.js\":\"28a74086e9c9b0c5\",\"/knowledge-medium/src/utils/viewport.js\":\"4fc330cd07daf9d7\",\"/knowledge-medium/src/utils/webLock.js\":\"e3ac663b9a07d1aa\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"261d7cb64e4a213d\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"b7c4ce6bfdfc49b4\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"dcb4f7d7b5b38c96\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"8d54603dd08d1c7a\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"9843ca012e635b20\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"9a18480fde50fc15\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"e8cd3449bb0aa1f7\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"f59260c97d1edf7e\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"0eb9e5b9d52b065b\",\"/knowledge-medium/src/vendor/react-dom.js\":\"82e356a7f01f97a6\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"25b5f79597cf6cee\",\"/knowledge-medium/src/vendor/react.js\":\"408d4186169ca411\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
