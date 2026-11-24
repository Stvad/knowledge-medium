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
		buildId: "87831aa6e7b0-634ebe4b",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"d1a6adc746b03321\",\"/knowledge-medium/index.html\":\"d1a6adc746b03321\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"141c7ab4732fe1ad\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-CGS8CdPA.js\":\"77da44f5e8ebfd89\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"d1f424371bf5c9d9\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-Dj-V5Wzt.js\":\"7d517a9114f443a8\",\"/knowledge-medium/chunks/FacadeVFS-DfMrmouJ.js\":\"dd0dbebb8b088b84\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-B9Adnndj.js\":\"44a59271c884d5fc\",\"/knowledge-medium/chunks/MemoryVFS-DaiZTZ5H.js\":\"d2765f2e5e1ca701\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-Bqw-NKJq.js\":\"2a42abdd550ea9e4\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-BTShTKvE.js\":\"c3bababb418837d9\",\"/knowledge-medium/chunks/Preview-B0XJ5HS_.js\":\"eab94f3878ad6998\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-B_4bOEUT.js\":\"7b9ecb867504eb2d\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-Bc414xbX.js\":\"26bca7b5e45bc357\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-BeWiRMtv.js\":\"228bbafa0ae69c80\",\"/knowledge-medium/chunks/react-Bmb0cGYH.js\":\"f290a972f36d61a6\",\"/knowledge-medium/chunks/react-BnIIV35t.js\":\"42493afd36e58391\",\"/knowledge-medium/chunks/react-Bots0fC4.js\":\"e24d6345cff6929f\",\"/knowledge-medium/chunks/react-ByVzZrZN.js\":\"97c576ada8be4e06\",\"/knowledge-medium/chunks/react-C2wtskp7.js\":\"a9ab411f76f733ef\",\"/knowledge-medium/chunks/react-CjnlKRrv.js\":\"20c9dca1a5f39154\",\"/knowledge-medium/chunks/react-D1hvmy-x.js\":\"5d8512645c53aa4c\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-Cir1da__.js\":\"64077e20c491e7f4\",\"/knowledge-medium/chunks/react-dom-server.browser.production-BzyQuoFC.js\":\"b11dbe7e845b937b\",\"/knowledge-medium/chunks/react-dom-server.edge.production-CtRQr8vj.js\":\"5cefdd5acad06fd8\",\"/knowledge-medium/chunks/server.browser-BQIkSQcc.js\":\"ba4c3e7b3a038145\",\"/knowledge-medium/chunks/textarea-Bnq3PFp6.js\":\"4d65f1a3fc66c409\",\"/knowledge-medium/chunks/ui-BAM7Irn1.js\":\"c131aea46a4d0743\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"1a2b9a89fd3a3bea\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"24b391ec75e29190\",\"/knowledge-medium/src/appUpdate.js\":\"c7cf13efaf800b48\",\"/knowledge-medium/src/appVersion.js\":\"24bd08eb5f70697e\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"ec47593f8fcd147c\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"3d4210c5350f6705\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"49a86aa9a830921c\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"171c298a597adc9e\",\"/knowledge-medium/src/components/BlockComponent.js\":\"ad78d6f63b0b2187\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"c8dc3d806477af4a\",\"/knowledge-medium/src/components/BlockEditor.js\":\"892923fd22070c29\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"97b65e5be6f0b5bb\",\"/knowledge-medium/src/components/BlockProperties.js\":\"013a25449f1c468e\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"82d7395ca553aac7\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"820863b3a90b3bd2\",\"/knowledge-medium/src/components/DividerHandle.js\":\"9714a0fe5f62c001\",\"/knowledge-medium/src/components/DraftEditor.js\":\"ac8ae646bb3f0a66\",\"/knowledge-medium/src/components/GutterPill.js\":\"c5775568bed38356\",\"/knowledge-medium/src/components/Header.js\":\"84efdc196939a2c8\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"4d670136d4842b4a\",\"/knowledge-medium/src/components/Login.js\":\"9c5835fde9cd36a9\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"4f815d0e32944613\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"485e0864a0aaaed6\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"c3aa2e3667d46ffd\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"a939daa8ab3ccff9\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"6c3ff468d860b41c\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"158e8f4e7444444a\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"d4b8bc539f1b7359\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"88895fc9ac333a43\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"6a8b625f072647f0\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"c67cfd8a9613f6e0\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"39c2b7a2e3c3cb35\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"187d0282aeb53512\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"e20cd8f8a384d52e\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"155e3e0f0758f282\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"36d5a1e550163b7e\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"16feb83a7b078fcc\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"1db32990285f06fa\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"4e92235b9d8e0e89\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"1243b43fc492530f\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"af292fa2a8972fe5\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"fb06c28904501837\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"c14d474f80d988a5\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"10e9913e4dab9cb7\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"989fd02e768ee618\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"dbd83fd871293df7\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"a3682be804f602b8\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"435117612be8a30d\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"6a37fef8b216da5a\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"24f0d2f9239727d6\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"2f5c44378ca126d4\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"5323c773b7951a91\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"314d36ced66cf7e9\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"35ddbcc42a26afd9\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"439386f544e20012\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"1e71228c2cfc12d6\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"205cd927e978e905\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"7210fdfed87ce45a\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"b7903fba7e7eda1a\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"bdaab5324e43d849\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"f299aba0632585b4\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"208b6f10aa3e7ebc\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"dec641de3462d8bd\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"a68385c293049902\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"7fae074e1b8372d6\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"293899cf8a1797a4\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"4e2cd8bcaa00892f\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"cdc4c31d1c25b8fe\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"7ab6cb4ef0096995\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"eb207db3d517535d\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"908faae288c7bdcf\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"96d9485cb066e9b7\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"54198805193852bb\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"d4c507ea5833d9d4\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"cf2b7e4fc1123cce\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"8cd612047ab65e9c\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"958e3933448ad0a1\",\"/knowledge-medium/src/components/ui/button.js\":\"345ec62683bab5d6\",\"/knowledge-medium/src/components/ui/card.js\":\"fc249ba69a409468\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"cc3fcf36b7d70144\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"6eb342b9aad95ace\",\"/knowledge-medium/src/components/ui/command.js\":\"057ef726a2491e76\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"d0ec7c85a4d20a78\",\"/knowledge-medium/src/components/ui/dialog.js\":\"27c7d979a6245a39\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"6ada903dfd10e15a\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"f8be8fbdd1eeea9a\",\"/knowledge-medium/src/components/ui/index.js\":\"61a63bdc61587d3a\",\"/knowledge-medium/src/components/ui/input.js\":\"7a4875f15b620b34\",\"/knowledge-medium/src/components/ui/kbd.js\":\"da7d4c49ef72f03d\",\"/knowledge-medium/src/components/ui/label.js\":\"51b5cca2cecbfbed\",\"/knowledge-medium/src/components/ui/textarea.js\":\"836180afe86a3e9f\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"1762ebcde965ed10\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"d0563068365b331c\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"8ab51b8db1d9f015\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"3bca71f0a78478a2\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"3243178fe33bbdab\",\"/knowledge-medium/src/components/util/error.js\":\"585b7098fb1e22ee\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"c6c95a808e596d36\",\"/knowledge-medium/src/components/util/suspense.js\":\"5c975c9eac7cc79d\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"22bbfa0e03b41829\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"3b4b0aed3ff38220\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"7dd69b6e4618df73\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"608dec470f0f05f4\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"cf084fc740fa8468\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"e1115be1bfdb0167\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"c76fa301ce6ee667\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"ca87616754953334\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"44aa3723d9a8b58f\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"69c0c965f84dfc5b\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"a908e0276b81f873\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"cae25a569b78090e\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"798258983de6b3c8\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"ec2f2e7ded5f8226\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"8d58942242ff96c0\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"d0c1507d30e9a29f\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"6bf4fa538f77f9ee\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"bdfa6477af18255c\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"dc3be7606a6c7f9c\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"509f54f5e973a17b\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"fe2121da5d97386c\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"fa0e95e5a77f6446\",\"/knowledge-medium/src/context/block.js\":\"91353d7dbc351201\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"243389b09b0e97e8\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"8e5b4dce29f24eb5\",\"/knowledge-medium/src/context/repo.js\":\"ff734de687c0b439\",\"/knowledge-medium/src/data/aliasClaim.js\":\"f1eae5ba081a756f\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"83e02bb3909e6c12\",\"/knowledge-medium/src/data/api/blockData.js\":\"7d7aff424fa590ec\",\"/knowledge-medium/src/data/api/blockType.js\":\"72afcc295d40c4e6\",\"/knowledge-medium/src/data/api/changeScope.js\":\"fd7e74740d42b950\",\"/knowledge-medium/src/data/api/codecs.js\":\"b4aad3eede29f56a\",\"/knowledge-medium/src/data/api/derivedData.js\":\"0b08d14e947b37b6\",\"/knowledge-medium/src/data/api/errors.js\":\"9538955a8edd3683\",\"/knowledge-medium/src/data/api/events.js\":\"71308ddf2bba04ab\",\"/knowledge-medium/src/data/api/handle.js\":\"f6242e58e26e16cc\",\"/knowledge-medium/src/data/api/index.js\":\"b3ff96fd98fd79e4\",\"/knowledge-medium/src/data/api/mutator.js\":\"39259b8c3d9e8835\",\"/knowledge-medium/src/data/api/processor.js\":\"41023bb2e1e56ffb\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"16a2a2a6da83a320\",\"/knowledge-medium/src/data/api/query.js\":\"b644f379260d0697\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"e8d093720651e11a\",\"/knowledge-medium/src/data/api/schema.js\":\"f6242e58e26e16cc\",\"/knowledge-medium/src/data/api/tx.js\":\"f6242e58e26e16cc\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"7bb0c82a709c75a3\",\"/knowledge-medium/src/data/api/user.js\":\"a09bef29efaabae7\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"257e18fce9ae0d9f\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"d93ee2f790bc5730\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"a25266915f37f3bc\",\"/knowledge-medium/src/data/block.js\":\"87cdf49e1ff083c0\",\"/knowledge-medium/src/data/blockCache.js\":\"028c15c38f906b59\",\"/knowledge-medium/src/data/blockId.js\":\"9bbaa79ef11ca27c\",\"/knowledge-medium/src/data/blockLiveness.js\":\"75391ee7f6035299\",\"/knowledge-medium/src/data/blockMerge.js\":\"d45cceeb9a690ff6\",\"/knowledge-medium/src/data/blockSchema.js\":\"fc5f740d09ed01f2\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"238a2cec7f32365a\",\"/knowledge-medium/src/data/blockTypes.js\":\"e76bc45a32b45084\",\"/knowledge-medium/src/data/childrenView.js\":\"6a4cafc5bedd9199\",\"/knowledge-medium/src/data/clientContext.js\":\"f560cc0661fddfcf\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"46fa11bd8d6e0e6c\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"c805c5e866c258fe\",\"/knowledge-medium/src/data/derivedIds.js\":\"3bd0703b7781b226\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"904b380272a87368\",\"/knowledge-medium/src/data/facetBridge.js\":\"51abb0460a1bf701\",\"/knowledge-medium/src/data/facets.js\":\"5764d15eb3b5e5ad\",\"/knowledge-medium/src/data/globalState.js\":\"645a02390f976bf6\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"d089d9d3ef28c1a7\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"f2ac3da361b8200b\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"45590794d4051f33\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"87f099a688c7bcda\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"6ffcc32e093d34b8\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"0deb346d09894bab\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"603e3c89dea09a92\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"2615d2c5dee498a7\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"6d345f23c6db2ca0\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"bce64c03a7d9e236\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"8699e700bbec73f2\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"b91954fb3b7e5789\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"2da1e7f598fee1bc\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"c857d208a0e57950\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"4e6f1e6b604cd619\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"31daa02a129c593c\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"be0fc78e484d81d5\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"5a02423c3f19f101\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"af7b0a5cdd7e393b\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"7dc2f5b696f898c3\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"e06d81ace69e1ac6\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"af4b400aae04f86d\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"4a68187fc9399630\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"44f40cfaf13a5c5f\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"d77ba1f94542c8bc\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"b81a71d5f7bdb6f0\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"0514b889069c9611\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"cc4f687af03c6dbd\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"61d19129e1a6b5d4\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"17307549b7c91e73\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"1e4e2e4892c63c15\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"2778de3ea7ffa94d\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"a97b1fc7e4fd680c\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"6e9c6a68a10d4aa2\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"33ce6b6e3077e848\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"3ae38c9f5287c301\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"7f3cb979d8f44429\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"4eddaedb61d95ef2\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"b62e48669387a33e\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"8213d1ad82c9b748\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"3635a84cf0aec6c5\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"540c66da97e9613f\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"bf3b2439a814ba20\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"2c5096b33cf427f4\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"b330dc198e873526\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"c3affc5209be477a\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"fccfbebbc38deb49\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"6851742c44174643\",\"/knowledge-medium/src/data/invalidation.js\":\"3e44f7c8e54152c7\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"b1499476bfe72d66\",\"/knowledge-medium/src/data/kernelPage.js\":\"5b9b00cb149c886b\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"16c99f077a3c0c57\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"7c0fff94b6781e88\",\"/knowledge-medium/src/data/localDbStorage.js\":\"811ef39ac439fdf2\",\"/knowledge-medium/src/data/localDbVfs.js\":\"a2e93dee0fdf3e09\",\"/knowledge-medium/src/data/localSchema.js\":\"9d6f668a0703287d\",\"/knowledge-medium/src/data/maintenance.js\":\"e011908895522345\",\"/knowledge-medium/src/data/mergeProperties.js\":\"e8dd370aa000467f\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"2454f4009a6d5f5b\",\"/knowledge-medium/src/data/migrationsPage.js\":\"1eb9d51296264fbc\",\"/knowledge-medium/src/data/mutators.js\":\"3e52a36bcaac3618\",\"/knowledge-medium/src/data/orderKey.js\":\"8d6575946e76db1e\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"49b97ffe3f7eb767\",\"/knowledge-medium/src/data/outlineSurface.js\":\"30e0eac7c4e3eed1\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"4180558d0ac8f1d5\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"11696c525ac5dd66\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"2934a588bc58322e\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"b920b33b098fe775\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"cd34e6fb077191c7\",\"/knowledge-medium/src/data/properties.js\":\"3883dc112feea08f\",\"/knowledge-medium/src/data/propertiesPage.js\":\"532f8d533417b77e\",\"/knowledge-medium/src/data/propertyChildren.js\":\"912a1490af05589f\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"a22c7e03ca80f6b7\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"63f9ab47826b2795\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"d6045891588a41a8\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"863ba23cde6e82eb\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"dce1773092184fde\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"4bd0b3a3ee2cad46\",\"/knowledge-medium/src/data/propertySeeds.js\":\"7c6353094ee9fcf7\",\"/knowledge-medium/src/data/recentsPage.js\":\"9c5f282494103577\",\"/knowledge-medium/src/data/referenceBlock.js\":\"6c818d725d02086f\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"45ab6466e5bfaa8b\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"25aa4924eebd4d42\",\"/knowledge-medium/src/data/repo.js\":\"fc015278052c6ff1\",\"/knowledge-medium/src/data/repoProvider.js\":\"ee016398dcffbc04\",\"/knowledge-medium/src/data/rowProperty.js\":\"014b53ff7e71f294\",\"/knowledge-medium/src/data/searchFilter.js\":\"43bd6461e0171abe\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"47ebe38844af57f0\",\"/knowledge-medium/src/data/stateBlocks.js\":\"4cc4c186e31bfdea\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"ae3738cb23c6f9e2\",\"/knowledge-medium/src/data/structuralInsert.js\":\"c948721e181f706b\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"e1b7fd4a712f8b44\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"d595de82fb63bf25\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"43ad2550b367f236\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"7bcb0b039687ca64\",\"/knowledge-medium/src/data/targets.js\":\"c15a1125ca9b576b\",\"/knowledge-medium/src/data/typeColors.js\":\"14c7f8dc39047e76\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"1e3dd217a0b73830\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"733d8fe836a0075d\",\"/knowledge-medium/src/data/typeExtraction.js\":\"0d03a6b6a2e9c0ab\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"faa9ebccde50fb49\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"2dc968561ca6ae28\",\"/knowledge-medium/src/data/typeSeeds.js\":\"619aa6b35392d2e8\",\"/knowledge-medium/src/data/typeTagger.js\":\"7468d8213bb36364\",\"/knowledge-medium/src/data/typedRecords.js\":\"d8e082a36404ee14\",\"/knowledge-medium/src/data/typesPage.js\":\"f5dc588600666345\",\"/knowledge-medium/src/data/userPrefs.js\":\"376394b063eb6662\",\"/knowledge-medium/src/data/userSchemasService.js\":\"1b2e728b5b8869e4\",\"/knowledge-medium/src/data/userTypesService.js\":\"645b2481c78050a7\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"b30b12826237f4f9\",\"/knowledge-medium/src/data/visibleChildren.js\":\"55c8115f2237185b\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"ecb9e410be4b153b\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"960232a77230ea4e\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"ed0f8fa8077c145d\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"b531285c306b2d8f\",\"/knowledge-medium/src/data/workspaces.js\":\"97c25894a8f558ce\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"b86c3e83f1687c97\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"76f11fc0ae612a2d\",\"/knowledge-medium/src/editor/atTrigger.js\":\"7c24b0bb359fd42c\",\"/knowledge-medium/src/editor/autocomplete.js\":\"660f1519f7f637d5\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"da9005c56b4d8970\",\"/knowledge-medium/src/editor/contentFlush.js\":\"b1ee7adc3e423b95\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"70813160e4ec6402\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"0066bd3cd2ffe6b0\",\"/knowledge-medium/src/editor/insertImage.js\":\"7d455e74c5cc4299\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"53ba55cceb0add21\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"d5a455ccb0e4abf4\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"0429f8e5dcae6d1a\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"1ec0e6cf9205aca3\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"20e52589b834a655\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"655e77197825ad76\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"716a7b3d1ae2c4b4\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"749579178f81d526\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"7ccab8ee1e2825a0\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"84b2bf63434e0a9d\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"90532a3062128ef1\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"5001eb7593210c23\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"8e5ab093364aa6c0\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"cc4ddf49b1847904\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"2e04d38d4599d24d\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"fed1b4065c840882\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"49f18dbae0845ff3\",\"/knowledge-medium/src/extensions/core.js\":\"4ca9218b0452f6a4\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"fa1bab5bc05be9ed\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"adf986fba7af38ae\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"069dfa365d20d5bf\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"6c11a3d51d0ba46b\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"25d6c3e0bbccc815\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"1e9ca041216c44e7\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"1f90f3ccc9df4739\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"b3c6ad459271c771\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"4010495b610c483a\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"3a8c82a997ce5f73\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"49e859a80bf34ff3\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"2019bcabc5fc6919\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"34cf69fb439b9cc8\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"9093808229f20530\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"f4ea61c66bb132da\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"84f906eb2e105a26\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"3be203865de97e02\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"4fe79a31b3fed1db\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"51706684a746fc6b\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"c409036244074eee\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"8baa7aa341017880\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"efbaebff576049d7\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"244904a8bef0edf9\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"9068d9aea45966d5\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"d02fb1625cb9ebe0\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"cff9c606b6150616\",\"/knowledge-medium/src/facets/facet.js\":\"24a20c85cff6b250\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"c3faf2f37b4793c5\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"25236f116e6c136b\",\"/knowledge-medium/src/facets/togglable.js\":\"8823c7cd8abc8498\",\"/knowledge-medium/src/facets/variantFacet.js\":\"cfa54172c5f1ab3f\",\"/knowledge-medium/src/facets/verbFacet.js\":\"ee0c4ca8a9185aad\",\"/knowledge-medium/src/hooks/block.js\":\"abc8b1e844bbd552\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"95b1cdb2d8851bd9\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"4a9e24cf8e236f38\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"cd1910f6f619c71d\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"3c3c2f0a36ce86b6\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"5a43c70bb898fee2\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"c79f9428a4ec7ba0\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"1a6f24cc2707c9eb\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"3fe1e1b06d96b994\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"93480bb97b5de627\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"020776abe16eaa12\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"91f36a2b05a51556\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"64995b4936337987\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"736f53970254b403\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"7bf9cd11cd5af66e\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"d13e13896926d0b0\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"2bb23fe3f9958005\",\"/knowledge-medium/src/lib/utils.js\":\"da67a9619ba98c36\",\"/knowledge-medium/src/main.js\":\"0f797d20b4e14508\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"24b523b53f67f02d\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"fed278e737e0cc8c\",\"/knowledge-medium/src/markdown/context.js\":\"4d82b9323129aea6\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"0202eb545cf6792e\",\"/knowledge-medium/src/markdown/extensions.js\":\"12a2bd9e4b407bae\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"4ce6338cdcea2508\",\"/knowledge-medium/src/minimal-editor.js\":\"a2a0c9050ac1252a\",\"/knowledge-medium/src/paste/armedCut.js\":\"27f0a912d9bca333\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"b72ef7897044e427\",\"/knowledge-medium/src/paste/clipboard.js\":\"b5f47dcbc5c22ae9\",\"/knowledge-medium/src/paste/decision.js\":\"d0a30bf199434f81\",\"/knowledge-medium/src/paste/operations.js\":\"53f1a22acf8dbfb6\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"79b8ec8df038c368\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"ae6f7a0a519968ef\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"ddfb69fb14ecd0e6\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"2756e604e3dfd1f3\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"27cfcfe489cc9b80\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"91122895663c98a7\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"e0faf1f05e42dde2\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"c701da31e1795a0c\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"9b56145b344e1802\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"5f2b845cfbb37b58\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"976fd5cb53a43c8c\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"a1edc5077568cd45\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"892e0e322d4d8b21\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"7bdcf7a44c774231\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"4c76254ae38aa5b0\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"f7b66eeebe0e3afe\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"e12bad8a7c4357de\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"03657dcdcaf634ee\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"925424f99593cf99\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"cc31fd9bf04287ea\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"0b8b315145e25ed5\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"cd348104b1aadb38\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"4d201aff42c1367a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"8482d72e8e4435f0\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"b7ccdff1395ba957\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"7c9f40dd7001a773\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"53543977c05d31bc\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"a146327ed4d370e2\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"0280019944dadcbe\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"f45c85a15a1a52d3\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"05ce5da04e04c6d8\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"07fb49e4c0e170e7\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"a7a7c10370064e38\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"b1116e60db8934cb\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"258b675233de0135\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"9b6596b3eda5fc00\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"06feb5dc7366f626\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"5d8b5b80c6de2073\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"e588d3b15e32bfa4\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"c8ee031edd8439b0\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"9e5ca96b9aa41aa4\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"54e65fd27f37735e\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"ae692a01bc251186\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"8be518246513d344\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"315bc35a511c9a53\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"bc48dab314c4262d\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"7b7f78952510ddd2\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"d9e723030799601e\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"adda00031d9b742b\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"3ee2de0ce602befc\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"7faf6bfd7965d17f\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"88ce15c8474cf75c\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"1a543270816eb86a\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"2156bf47b8362b22\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"3abe3eac8be3872c\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"8e581fa052cc30e7\",\"/knowledge-medium/src/plugins/alias/index.js\":\"242d3ef1b1d6fe5e\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"7b23f69c6b1b362b\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"f6efeab023d77532\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"f800c44968842057\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"a7312985f5a3927f\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"f7e9cc6f6e75bb55\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"442385ec2eed8381\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"27e374b962a70c6c\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"8b30a0eb6b3c30a2\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"0ec251b11df31786\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"dae2cee5d7e5ce5b\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"1fcf36bacf1bc7aa\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"6d7295cf5432b579\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"ec1c7f8f170880ea\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"90a1debf8e87a852\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"b0d98aefca90ed97\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"b7cd2057bbd0c12d\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"b826ecf5a48f5997\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"52defdce739ed456\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"0186602e9c2a411a\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"fe3c15a129691b23\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"b41e0c2a08724dfb\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"8f134870af01363c\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"1a5d806582f8af36\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"150c805ad4021d84\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"526b61a925625081\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"f2922a169fdef90c\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"02a46591b4c24bfa\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"ad2bcbb55a60cd69\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"9a42424962586d54\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"fff6ae0213867ce0\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"c1c6190e00e39d99\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"115a09524a6d2e43\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"23356f1f8f29506c\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"d3f1da972480729c\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"2c4d9f6d5560a6ce\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"7b9fdcd2dda0c422\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"e2ff9eb72c6f2cd2\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"681589b9cbfa7f9c\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"9beb346476d92320\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"ec9d2e36e2babfd3\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"506076de88ee7df3\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"ed52563c1e214797\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"1da9fe7c0514f6cd\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"bd23266aad3d730b\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"7c906da921d8a7d2\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"60505c6c546e21c1\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"243ce59cfae764fe\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"fd0d329ae3a7c73f\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"2566b277f1c1237c\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"2c7870f39dc9b0ba\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"f8d9b57cf8d0352a\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"9e1a8701015b48ba\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"84c9ea43c2ee99e5\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"359fc26b4a1fa23a\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"e9a987b46355c21f\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"bba337cbdf23353d\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"82387cf25372347b\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"5f3001097cead842\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"fff3d85cef2c090d\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"325edd186ec7490c\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"9687d2acd7bb5b1e\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"ff3d43f3d620f97b\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"ac3a48bdc2ae178e\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"4e62739eb2e5e701\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"33cecac827e8156f\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"12a878c95428f765\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"6e98f8e431effcdb\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"c03d4457f16ce43f\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"861dac24bff77ae8\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"4d4ec5d30110c9ff\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"731db096d9dfb4a4\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"9872551c0fabe03c\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"83248310d8bfb17b\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"17c6a6cede1da670\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"9cc9610713b3d8be\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"c76c0663f6b94641\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"dc0ffbb94a98ac99\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"f7e5dd17df80af4e\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"b2effb2af49bbffe\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"4b69bc1e8f1d86d5\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"9671f882ae570924\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"79657b33d4bc5d12\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"c110b5b247f493d7\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"a7d478193d2aaf29\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"c9d1da1225da44e5\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"a4516285b6e8d079\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"36da7e295d3a1267\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"8a770df5ccbb92f8\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"9d68505aa744c52c\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"ca19a4a6b4935837\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"9fb42e837a7de59d\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"550a53dd85e5f118\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"c12c3d98e925cd71\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"3184b35cbe969bdd\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"403e1e320ad483c6\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"d982b22c1e6513bf\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"612cc9feff81ab3f\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"d12c6cded4f3f0ff\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"6309f6c942bedeb2\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"26fa3b8fd97527d3\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"b884ed421f32be58\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"6aeec1a53498b132\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"9ab4fc44ac7b4abe\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"ebb289aced92a19b\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"b7c2380d1bff2180\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"1aa98cfaf9b2d580\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"0d22ed5462482d22\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"8393d7566c28388e\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"1f076d813cc50e46\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"229d050e60c5d5d5\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"22043277102641f3\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"2ed6981d1efbf33a\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"2e964e9a28412826\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"e8c920791d0674b9\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"02113ed20eecc96e\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"b939e3c44b584a76\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"a7c5e1be3cfcf85f\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"cbece3c0a702108d\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"bc254d1a005ceff8\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"7f9bf0b2d2bdd01d\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"07bf04584b8611be\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"bca5dab27ac39c2a\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"6d1623ca74ca15a7\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"c208b1b3a70bdf1a\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"88be6fdd9947b921\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"3c7d22b251221095\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"7ec6f962294cef95\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"0ca53765b0dd78ba\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"c554b11c9d4bee34\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"dc6d74b966be819a\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"10329e3917f7a901\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"4c5c2c16ca2474fd\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"39f991345951e5bb\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"f9cfe0f48c8e29fc\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"f152316e51ac078f\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"9408693bcf125c9d\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"c2c7863d1040b0c4\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"0901dddb40aa7ca2\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"e31a40ec60934b13\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"7c6e94a117e7a8bd\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"a8de57cd15b7f791\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"1412b95f0f36404b\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"b6914b4c3b37caf4\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"f1bda5e329cfc7c7\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"e9541b7072616d4b\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"b4954a891e00eec1\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"64ff896420fc8be7\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"470dbb290010db6a\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"fd7317f7af25807c\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"cc9546dabafbd4dd\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"337c1eac4cc498c4\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"47f0847c9514c2ff\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"b9f9c7bb5629b69b\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"896bec0a62564712\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"c47ad3c99bfba6e3\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"9c8b216c39fa3385\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"b9a7cfa486fec5e5\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"7d2100a742320851\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"a0c448c3ea8cee3f\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"517c9b0027775e3c\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"60d49a5c45f24ae1\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"12cf0d21857d7789\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"d442199e783eb370\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"af5f32d05285be70\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"6fe77103e7e12e3d\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"c7a6249618b5a947\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"f8024a737bfa7d5e\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"7d02c5c137ec4674\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"abae8f5205a55341\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"52f63cd8345e7351\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"6887cbb8091c838d\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"7d46a5c7bb93f316\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"0fd4f2bce8723967\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"edbc8379e1ca2a65\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"e0a5320ec9a56c58\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"704095f561d94e5c\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"4a1c36bb59186403\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"1c3fcac5eb1bbcb8\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"656ba47af1f94139\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"a378199829995bfb\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"fc287a762ddf4055\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"227239ac22e030f7\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"611b471509497c51\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"7c9faa2d7c27e169\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"54f4ad239107d016\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"dd3b2c0d9ab5a198\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"5428f55821c52790\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"c335d4b1d1b614f1\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"38afdd1f78384ccf\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"b2e4f02cce2812c4\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"cd5babd4cddc79b5\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"487e778f6667f985\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"b1e42be9f239d7ab\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"49823fd7552bece7\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"6c8979093bf01c84\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"8dc07a7ffb0490f2\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"3c1c46d3b3a882e0\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"ae3d266bca8e420f\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"3292aa6292e1b8aa\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"4efdede51e1c3cd5\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"3e08a8cdd3d09399\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"d0a359707cc63070\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"34f9859bf8b95c83\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"c2b2818a045f9900\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"aaf887533b591256\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"66b0cebde90d2d57\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"dec2968a17c4b183\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"331827ccd048bb63\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"796b0f5e2c0d595b\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"d6972f56d982a273\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"bec1b85e895f392c\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"0f089d96f47caf9d\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"0c29accb7addadc6\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"f7e5c4ea458f3289\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"54cbb417fe51907c\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"beeaed7ffd68d9ea\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"4df854bb4ce50a18\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"178a8dba117ab7e6\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"75102e76218ed5ee\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"7a4fffa58b69a7fb\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"e00fe976db2e2e26\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"925010f4b2471c57\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"1277f09a4d3eeb2f\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"ffde3d8698ec482f\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"6386638366db81a3\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"24bfe4e75accc9e2\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"cce5b25ce1f4acbb\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"3fd4b9a0910c25ed\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"0506c93c4af5f71f\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"31563cf3ec7707bc\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"d4a05739ac6f9fdd\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"4e436f4bf1c7525e\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"b5370d15c5d34860\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"047608a46496dd19\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"efaeef3c7f52f526\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"89b3989b49c9b11e\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"f8e933b32eb7fba9\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"6ce1001343bd146a\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"fe1bb71992a5ef26\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"8625567493013b08\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"c122a73ed0d242e9\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"4f9c0b71dd3c35a5\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"f6448dd6c9bbcfc3\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"a7d87bfb6ffd581c\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"a6b5025d42f196b9\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"edda96164ed44735\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"461ad2dc0f2ea537\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"98995c6a4597a25c\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"213a68ee44957474\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"617e3e4f4d813926\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"d47ce6768c7d58c4\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"61c4e6bcdc47644e\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"17c1fed850403978\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"9b0cfba8e8a16328\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"534382d4e9d11117\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"faa869253a17f184\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"5fc0d5bc28b4b922\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"1e28024708d3cce6\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"c8abe3ff05108ef2\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"9f4ba95c80b29ea1\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"5c3d8d4b62971162\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"d1541ee8b812b5ec\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"4b7f110b17c44702\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"7b263ab51a225a43\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"631fb37678326f78\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"98644afe5180a649\",\"/knowledge-medium/src/plugins/geo/index.js\":\"53aabe7957101ddc\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"396d9da996f5c02b\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"53439441b7054bfa\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"3d04ce08bf04974c\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"983fa5f7b4896c00\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"70e424b76242fdb7\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"504e4518b7179976\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"fa5173845a35a083\",\"/knowledge-medium/src/plugins/geo/query.js\":\"72468fa4f71b9194\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"c4738e7d593f9439\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"60c2c85824a3e451\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"295015503813ed69\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"92a1d3317cd234b4\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"5ef1a11f128e11a8\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"c7c8b4975c3147d6\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"058d91d1e68f20ab\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"c0b7009b34177d0b\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"bce2703a04ef45e4\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"4057fbf18a0d0160\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"dec722be96e709fa\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"2746390d295d0764\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"465c1e0ee7771397\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"090e917d51d65411\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"654ab2cdd453afa8\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"043d1336255c5203\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"1610608090b9a197\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"911c5f79ef9390cf\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"34addfb92d349cec\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"54aa3074308d66c1\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"f7246eba302f3945\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"84e5ccf295f75daa\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"8c43c6c2cda1039b\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"158d9e7711e50003\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"71bd49fa5ee7022d\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"21eaabba34525c35\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"a32a855bbd71b023\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"c3e6cd1dc60c6c30\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"87def251495bd371\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"09930d5cfc53ed81\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"7e6bbcefe4521c86\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"f21888e85ff7dc85\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"bd81c078e9640164\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"caafe38ffe3cf473\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"d912e0f3b2c26db8\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"2359957e7657dc50\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"3fad573fd1dd8e04\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"3d58391cf35d6db7\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"c22281ad13c33c1b\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"4d9212ab1ccd68f6\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"b5a79f858da5083e\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"7a3a9eab04551131\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"f0ed6337ca3af079\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"5c3e8c77670a727c\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"44dcf68bab335b82\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"4df1da3286b13c30\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"fc720702089a97d2\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"cd0ac21109e12d8a\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"01c2caf37b094497\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"abcdf0f3dc39da3a\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"2eb72e806d0752da\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"6ec4d5e0d0496831\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"6f01176852c5d29f\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"f9bf31ace199ad7b\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"76a6fcddc951e013\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"81b2f5be10dced96\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"68f700e7d188839d\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"2e4b44af862e8a87\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"36211cf3778228a2\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"76a766579fb1aaf8\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"ac0ffd1a7ccf9efa\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"78c83be7f153bd2d\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"ade184ee3603a78d\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"41fd15ecc9107806\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"39297991f5bab57b\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"fedbcf7eebb15129\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"1b625a2ea7800e7f\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"537807b769e98df2\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"bce49c28fc6c062b\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"d5d0db1bd3296d5f\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"b2a72aee649eed8d\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"a0f9262d53c6d3f0\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"e0d51a31fa4b30b7\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"3b4f43d46df3baa3\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"3144ebb710f37048\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"b85eed617d331838\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"7f681bb2c6dbea51\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"392435fdadb68945\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"5c1b7cb39c64773a\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"62e7e086bf2c2f76\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"4838265e1782f0de\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"0c340ffdab35eafe\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"fdffd4a174e9a478\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"101ec2b85e0af3ab\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"5d790d805a6885dc\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"d0b7515a510abcfd\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"aff798ac55182e91\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"ec13a3f0388c47d3\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"4afb6019683184c6\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"dad395f0afd17e8b\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"0222434376bae168\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"9040e3a3c5246669\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"4e4ff31ede8789f0\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"dda77ad87a7f207c\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"b95dee9c9b8f8088\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"e8faea7b47c530e4\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"124411f57f881196\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"5caf8c9c71f9d47e\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"b020ed0f5a46c123\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"d761bbd503143af3\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"a2fdbc5e8e34ec74\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"b7f4ecefb13e1439\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"21c80587cbfff79a\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"e03d6cbd347ac279\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"a27f89bc4dffdfff\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"4da632892fbda7a1\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"e39684af1311d5a5\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"9889f5ef1953cc0a\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"bfdda924487158b1\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"2a3dff2fccf81913\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"b6fc40972132edcc\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"39bf6ba87e9d4777\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"877a83cd42fa267a\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"96149b4d4455dcda\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"a0ff491f6de1c3d0\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"73f4f54bba298b46\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"bd5c36973f6af99f\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"0aee27adddc1ab62\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"c1e5a09e53a82298\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"571bd5092112b8c5\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"b54c9313f9093581\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"6decbd5b8b8c8d34\",\"/knowledge-medium/src/plugins/recents/index.js\":\"62d3434b7544c748\",\"/knowledge-medium/src/plugins/recents/target.js\":\"e65d11e96c37186c\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"928d269949f09eef\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"9d31c700e0a85f53\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"2979ba7e07412153\",\"/knowledge-medium/src/plugins/references/index.js\":\"261be2e3f6240043\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"e4332f39b688a89f\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"fd09969df060c47b\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"dd6135c517859734\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"4d5fb290ed95a811\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"2f4374e2eb66bcdb\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"084d44c32bdc94e0\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"d7e6ca44febd77f7\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"d18f38265cac81c8\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"f30593666b76c948\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"8ae4f75b21b29c2b\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"ea6f95ec16352284\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"bd0ef3f7a4e09c61\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"fc58260acf118b4c\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"214017b3753a6ca8\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"36c8aeb96658d01e\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"dee8100b63d03201\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"6884cdde4e2a4c5e\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"8f1c54e4575a7656\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"11a1339d7196bdb5\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"1bbb348d11a67656\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"d7f0a073c173a2d2\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"18e47df79e35886c\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"84aebecbfecc4828\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"83f7dae1f63480ef\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"24ac0faa0eff3ec7\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"22e5eae4d5fad76f\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"cd384a3263092f8a\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"692d9941deb1cf96\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"052ade898802a7e2\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"fc5db1d3b0871b60\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"891b2e230096a2a9\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"4df2b14653c942ab\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"15345481d3479b65\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"b4d933c86a7c1a4c\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"2839ce27de085205\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"212c9f4f51a5d834\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"2ed7ea9830da34fd\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"e818d0476f68517f\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"c64cb008fbe512a6\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"1047fdfc1416d54a\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"56e3b7044689d392\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"b59af0a08bbd289b\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"a4efc11bc31d3cce\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"6e63a2501d436eea\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"1402115083ebaad8\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"3015ee6a1f2e1bd2\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"705dafef70ebb341\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"5768fa13a7686a51\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"2b16e422262fedbd\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"0d8982526ba0d654\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"2be0f2ae1ba3d3d0\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"569f4bbbc2aa20d9\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"e1477df255edb79a\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"c988884cf2a33ff5\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"b01f3068a1012737\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"0f767c4616e9c5b5\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"f04da3c56a0874c3\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"78a75ea7915b4663\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"048ab96d2f279825\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"366e3fbf6d29a82b\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"0ef8149516ed1ede\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"c9d8f22f589fce9c\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"91dee83d3c3de29b\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"63042cc694d062b9\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"701cd314d51a1641\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"1ae60ebdc11298f9\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"8619faf2f96127bd\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"7cd780303a7248e4\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"a4f0e8272cfbe6ca\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"651152a82b70885c\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"f816a4dd0b4c778a\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"da08875f7f2e1e64\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"cc413bc8850d52c9\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"cca398041e7f2a07\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"4cec97784746867d\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"deb9d822eff84d65\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"c6144c606ba42894\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"48e42160ba34d783\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"600ef0caf98baff2\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"f01dd92a28b994f4\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"23f33851154a2436\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"3dbcc6609be18b9b\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"019df6017c09300f\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"160e45cea204c74a\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"36735b10ac63dabc\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"743b2d299380fc3a\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"0f880502dd3d77d3\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"08c52d39e13f0765\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"e46f9b2739851dc5\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"e50106db5f1ffe92\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"e6ed115d4e4c7b2c\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"d6b36f6c3b302097\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"e0cf089cb8c11d43\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"79b10836abd8c2d2\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"b62427266123d365\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"476d51fa64012cfc\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"04f46c08d98ab10f\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"df84ebdc8e0be512\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"13a12e6a3acab4be\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"9dac32fb3e558506\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"91441348d2467bdd\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"f7d0c3fac6e2e78c\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"7cc054ed471f5705\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"244065e88f63e498\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"f5a921008fe3dcde\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"f00f239a5cbf46f4\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"900242a90ac4de67\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"35990281ca7eb866\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"db40eefa416adc99\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"e87a6ba1e8a31194\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"6395f92082e88ea9\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"a7a21ffccc6bfcef\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"b5d4d4050d4eae62\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"99cbdd4732ca792a\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"4342118d723cf9d5\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"b7ee5d026337ce09\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"2d0a6467e1061cb5\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"982ab54365495685\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"ca6b8ab998653cfd\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"d6b7616d1da7a5f4\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"ab6519c075285afd\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"cf3468f13f2da390\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"0d403fd37cdc3698\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"e4861e853520492f\",\"/knowledge-medium/src/plugins/tables/index.js\":\"e6e4972f28e9f7f6\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"1c0d8483cd9aeb5d\",\"/knowledge-medium/src/plugins/tables/model.js\":\"e7600af5f025b28e\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"5ada9aba1181b767\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"41674e07e6877545\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"e1b381a4b71f366f\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"37db94533e5af779\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"7843fb83341d1abe\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"b7625b536f29721d\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"7d6aa7a5b253e851\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"fb369df24f87f30e\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"ef89ec425b81e630\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"eb25addfcd5c8404\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"053b9137341467c0\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"511dabce33497623\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"a2999aa6166c2e77\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"d72ac979d53efbc5\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"7f9056f03624f1f1\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"b777c12a14f099f5\",\"/knowledge-medium/src/plugins/todo/index.js\":\"a2dbb1569510ae0f\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"d0246729929728ee\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"4df66cf014f078ef\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"ac7fa248919223fb\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"fcba4327e7c76557\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"857a35bd81e88e36\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"d98cfaf33ba35dc4\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"efc7814dfbc12402\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"9b3f90859bdb5a1c\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"907626b4948e02c3\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"56dcade64f55a218\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"a12359e6af58c971\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"ff82f5211901e98f\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"ca048c1d4efecf64\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"2bfbe2430966a982\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"2d3e98e0cc56f2be\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"22f7adb9a064c5c2\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"88c215480591faf6\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"3f07c62f027cbf62\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"3b936c14f2fa6659\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"7cc9fee0053f74a5\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"53b2de79f5de23c5\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"2f5dd22b58aae72f\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"ba8db63f04b8235a\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"d90276445ea78888\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"25619b1886885af5\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"8e5f3c5d9cc20150\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"7da144f001a83f69\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"a03e8505316c05bf\",\"/knowledge-medium/src/registerServiceWorker.js\":\"058d186374c76b6d\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"4e17405b67822bdb\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"b381ac8c339f8d00\",\"/knowledge-medium/src/services/authStorage.js\":\"4f775014f667b6e3\",\"/knowledge-medium/src/services/powersync.js\":\"2d28a0ccbf6e6fa4\",\"/knowledge-medium/src/services/supabase.js\":\"e70b1a8e208ce358\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"875eed2d81a18e76\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"ada8ce80d67391c0\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"c920c1e0764d9056\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"bb1eb962552fedcb\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"d56282bb29b684f7\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"f03f25340d17f094\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"4c631ed3486381d6\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"80f3e0a8cc45fad3\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"907244c0e3f1c3c7\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"85988591327de576\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"3ae646342166df0a\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"679155170f91b55c\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"2dba2e156ec29154\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"052ab377714ef51a\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"4d5bc39ca4398a17\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"02cb7e4828f69975\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"14cdc0e0ded3a2e7\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"252b05fb0e2f0d76\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"6041556cc5134ebf\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"c926b3ca96a6142b\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"2b54476bec159a15\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"055c3e4658b865f8\",\"/knowledge-medium/src/shortcuts/types.js\":\"5fb037a2360cacee\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"a6ffb0e913f9b8c5\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"8ad2a6ade55c48df\",\"/knowledge-medium/src/shortcuts/utils.js\":\"66a4ad6bfd9a8ae4\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"cb7071d929088e9c\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"45e367150a89e5c1\",\"/knowledge-medium/src/sync/byteTransform.js\":\"47ff101b3c461215\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"6f324e23907b8efa\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"f7ff68ae7373c399\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"e4932a64a710d802\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"8695a88b9e013179\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"f2a6ba3b201fe46d\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"22bf7bd8d8af8935\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"e5bd4e744c784600\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"7d629cba8a428d82\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"94508c72e5f8eebd\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"c2ad171e34c620b6\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"93a6f58982c9be42\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"5c6ecf3134de456e\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"3dcbd7c273c0f5d9\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"651da718f3ab6943\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"3679bd525c633a65\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"21a0f07d9e04c681\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"0f5884f81280ece7\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"3136b5b98c86f119\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"59b1d64bdd63ee6c\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"d92ab880722281aa\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"a423d6aa4e2ef6e5\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"94f92c2d2f746e7a\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"753680d34aa74050\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"7dfc5b44cedbbbdb\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"b2f888b190afa89f\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"6c368df54438cdac\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"7519c936d56a65b5\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"c8c4c321734d6daf\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"7038e80052e313b3\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"747e6a3e05bec193\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"09d2e0d420844463\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"514e6963a4f81a2e\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"8ff7e742c028eddc\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"0dd499338b86cdae\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"cd2dd204e1fdeecb\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"60244923e8cd38df\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"26ce6c16f74d4157\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"af448a0e6352cf7f\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"5188a36d27aae41b\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"221cbf8227f74f37\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"979c0049ab22bdb1\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"49cd2a38c5aae1fc\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"0a03467563f397be\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"c5f902bfc3ec8a75\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"ac99be01e15ba706\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"3bd18973887f9910\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"6c8887b7e727be77\",\"/knowledge-medium/src/sync/transform.js\":\"87a1fa597af84e40\",\"/knowledge-medium/src/themeBootDefaults.js\":\"0e39c2da01fcc5ef\",\"/knowledge-medium/src/types.js\":\"4799649a84306c50\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"3828883081e51249\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"8cbb6d3d66c583c1\",\"/knowledge-medium/src/utils/array.js\":\"52d59a4bf15e4d07\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"3c48c37387b54d45\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"61cf12946985966a\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"43358e1abf21070b\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"163cc96cb40ed7ea\",\"/knowledge-medium/src/utils/callbackSet.js\":\"940198384ace345d\",\"/knowledge-medium/src/utils/clientId.js\":\"287396c09a0b9ce1\",\"/knowledge-medium/src/utils/codemirror.js\":\"a471a7fe45c8ac40\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"d62a9f7548314fcf\",\"/knowledge-medium/src/utils/copy.js\":\"dd62c143e5ccb828\",\"/knowledge-medium/src/utils/dailyPage.js\":\"a0b0f01d1d269fd0\",\"/knowledge-medium/src/utils/dbForensics.js\":\"40b7b75bf005ba0d\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"86b4764c8183a513\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"af14efa132befe6b\",\"/knowledge-medium/src/utils/dialogs.js\":\"8c57542410eaa78a\",\"/knowledge-medium/src/utils/dom.js\":\"d1e433b0e98b653a\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"09acdaea981e82bf\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"1d0b453d8e0ca601\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"41d6bcafdb3da98f\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"e7f94758e14c1b1c\",\"/knowledge-medium/src/utils/flipSlide.js\":\"0e35ffacecd8c7d9\",\"/knowledge-medium/src/utils/fnv1a.js\":\"dfa98ccc94a7b23c\",\"/knowledge-medium/src/utils/formatBytes.js\":\"fbadef145d6ef399\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"1ceb29b8346d7431\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"5f3e223f83733c01\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"ee6a428503334cf5\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"050e2c388ebd065d\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"9213bb12253ba550\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"12cbe36026217ea5\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"5e290c63ecf0c851\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"7020980d79de3857\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"8e7a3e3f1a65fe8d\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"4c2590f0c1d97722\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"f4f3bed28e940b45\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"37237e91bd7fa6f8\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"4854eb411e649688\",\"/knowledge-medium/src/utils/markdownParser.js\":\"37f13f621c234f01\",\"/knowledge-medium/src/utils/memoize.js\":\"5c85af73f6c48d41\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"8e9c252ce4441fbb\",\"/knowledge-medium/src/utils/nameList.js\":\"f51d342bf8e0d0c5\",\"/knowledge-medium/src/utils/navigation.js\":\"6744197ada8ec204\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"4813a01e8edabfc7\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"481b970c2f03173e\",\"/knowledge-medium/src/utils/panelClearance.js\":\"45379e63ffb05f7d\",\"/knowledge-medium/src/utils/panelHistory.js\":\"8c23e78852a67f58\",\"/knowledge-medium/src/utils/panelLanes.js\":\"e349304aca4d332c\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"8a88a911c7f94939\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"973e8247337d09e4\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"f62b5f73f24065c6\",\"/knowledge-medium/src/utils/platform.js\":\"ade98ea6a323e955\",\"/knowledge-medium/src/utils/pluralize.js\":\"11eb1996ef1e7c9a\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"3ae7d179602b0aad\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"c135ef545c0a0a97\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"e023660fbdc25644\",\"/knowledge-medium/src/utils/react.js\":\"a51972d143411ab0\",\"/knowledge-medium/src/utils/relativeDate.js\":\"0086569b5ae9fe6c\",\"/knowledge-medium/src/utils/relativeTime.js\":\"c9249d8eb38d92f1\",\"/knowledge-medium/src/utils/renderScope.js\":\"466fdb37f13720bf\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"a5a99406afcfafcf\",\"/knowledge-medium/src/utils/routing.js\":\"9c41ec735e4b349d\",\"/knowledge-medium/src/utils/safeMode.js\":\"af0a72ae39c729c5\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"b83b620072ff91c7\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"ed8afd89834a4a80\",\"/knowledge-medium/src/utils/selection.js\":\"c51beb89557dbdbb\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"a736e7edee0ad088\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"8f045add2fda2b83\",\"/knowledge-medium/src/utils/state.js\":\"fd40fa3385938acd\",\"/knowledge-medium/src/utils/string.js\":\"5aebfd5202e2d38c\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"60b449cb6df5cd0b\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"242265db7ad73d22\",\"/knowledge-medium/src/utils/toast.js\":\"3c471ad5335614fb\",\"/knowledge-medium/src/utils/toggleStore.js\":\"95af83a5eecbeda7\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"f2c5bbe2adb81095\",\"/knowledge-medium/src/utils/userActivity.js\":\"3889871eba3358e7\",\"/knowledge-medium/src/utils/viewTransition.js\":\"413aa24f903497d0\",\"/knowledge-medium/src/utils/viewport.js\":\"2b9b60468613fa7f\",\"/knowledge-medium/src/utils/webLock.js\":\"5b74fd4ce26d0c97\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"7a37d192b2125d80\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"67aa87f13f75e0b4\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"828913a13324477e\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"3dc764e45260664c\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"e2c6b1e5b45d2dd6\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"71400547ad1c03ec\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"16c69afe3e3fef50\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"c6189aa92e69737c\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"164492164a666cfb\",\"/knowledge-medium/src/vendor/react-dom.js\":\"9d8c9a7ba6ee8c4f\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"6aad99e601e705e3\",\"/knowledge-medium/src/vendor/react.js\":\"502cc38db71bbfea\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
