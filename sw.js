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
		buildId: "f38a8436794f-c599ae6a",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"3ed0b24f40a7d39f\",\"/knowledge-medium/index.html\":\"3ed0b24f40a7d39f\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"57e38bc41f8f0860\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-BYMQWZoI.js\":\"fb0daa61c71e6762\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"5e99a080452109d7\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-Bxm3sRNw.js\":\"263fa069fe08c02c\",\"/knowledge-medium/chunks/FacadeVFS-BSO4J4bc.js\":\"f42a11c7e5620dbe\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-BCKKgwyx.js\":\"5fcb6f5cf4fed1b1\",\"/knowledge-medium/chunks/MemoryVFS-D4FmNJk7.js\":\"8c83bd91416bf91d\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-B1nVfyZ_.js\":\"fa4e9f86f625d86e\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-DWRwYLWx.js\":\"66e9012438a58d0e\",\"/knowledge-medium/chunks/Preview-fNUuqDb6.js\":\"7cf255323630f383\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-1Y3C_F5k.js\":\"c5f54d065edfadb4\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-DnAkjkhh.js\":\"d70a5d75dd5ae3d7\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-CYupQwlH.js\":\"b0a7b15a122cdfba\",\"/knowledge-medium/chunks/react-CojhD_EX.js\":\"2c4f043b06dd432c\",\"/knowledge-medium/chunks/react-DCmb7SNb.js\":\"9aa4bcd4c6da0e54\",\"/knowledge-medium/chunks/react-DIurdgtQ.js\":\"92796e5702fc85ac\",\"/knowledge-medium/chunks/react-DfPQifnA.js\":\"37698b8fc8a798ed\",\"/knowledge-medium/chunks/react-DnSSeNYp.js\":\"f48cb551cc597502\",\"/knowledge-medium/chunks/react-LrIPVRE4.js\":\"e73b98e36a892495\",\"/knowledge-medium/chunks/react-d2Q6G2y7.js\":\"5cf8008fa744dddf\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-DO5f2Mok.js\":\"67e6a51b58b02dc8\",\"/knowledge-medium/chunks/react-dom-server.browser.production-ChuammmB.js\":\"e2916ad33ff25457\",\"/knowledge-medium/chunks/react-dom-server.edge.production-BRZZ-7jr.js\":\"5abfbeccaaf5021f\",\"/knowledge-medium/chunks/server.browser-LeG05jsZ.js\":\"f232b550621c3988\",\"/knowledge-medium/chunks/textarea-CMntC6gz.js\":\"b1f55eb16bf74b7b\",\"/knowledge-medium/chunks/ui-wDXuzU4r.js\":\"13a7dffa008ed836\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"6a42adb5180e6328\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"1723c7ead0dc6e29\",\"/knowledge-medium/src/appUpdate.js\":\"cc453a39980ff203\",\"/knowledge-medium/src/appVersion.js\":\"cdbb21042cb18dbb\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"c44398068a540a7f\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"5c6ae6fcc7023e5c\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"e64f04e116618e23\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"099971c39fcfd415\",\"/knowledge-medium/src/components/BlockComponent.js\":\"c12bd1e42b0c7654\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"13b01040127505b0\",\"/knowledge-medium/src/components/BlockEditor.js\":\"6484b35c0dfafe20\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"34711f98f3e5ce50\",\"/knowledge-medium/src/components/BlockProperties.js\":\"59e074867cc0d8fc\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"27372ecc682b0046\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"26153af3e34e7e6f\",\"/knowledge-medium/src/components/DividerHandle.js\":\"7ddc8e6638965f38\",\"/knowledge-medium/src/components/DraftEditor.js\":\"f01bf49ae5d37714\",\"/knowledge-medium/src/components/GutterPill.js\":\"63f2f0d8463a796f\",\"/knowledge-medium/src/components/Header.js\":\"af1f1b998c5bd504\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"d2163da218bd4995\",\"/knowledge-medium/src/components/Login.js\":\"8dc048881c43dddc\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"ec1a545c2ec46abb\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"81bbf97be95693fc\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"2ee40223ec39ed30\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"8f27d4ec3afa1941\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"e7aabb463aac5bf3\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"7441efb9e3224645\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"ff387bfe812b0618\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"de34707897c6f447\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"a8d3baf53c8cb5fc\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"fb18aa0350b95d68\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"84ff823fa3934d13\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"5b25aee8099477b6\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"18c87074381adf53\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"3c95c82a6abbcc48\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"433297cc2c6a20ea\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"ec12904113798557\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"aa2f41fecfec731b\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"6cf12d32b38f308b\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"8d08ab4f4d5bf7f7\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"8b65c7293f07d374\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"c7e1e87aa51d20d9\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"8f697823d7eebcb2\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"65a1955e7a84ad1f\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"0ea2155522f2e7dd\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"e0c7973cc8f0da7d\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"51c632198f8993c5\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"3093fb44f9ef4cd7\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"d92bd4fcd7632796\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"fe9ddcb9401a4fe9\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"33fee15552451888\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"06a57de13c722056\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"00df398c76b44b96\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"4c7ae4f6702cab46\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"1dcabf3b3efca5c5\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"555851ab4e653e5d\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"f1f1e9438c5f63ee\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"438868493e6a10b5\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"c2e212013de26caf\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"f070ada973a51e0b\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"c61fc11844e1a733\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"a3d919d45942b96c\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"4f7ba5cbd8ac121f\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"2cdd81400c16dbeb\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"78a7575399331f25\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"124cedf43650fb7e\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"6a376c3465977572\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"c3467cd6998b04ce\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"a464c1a9586a86a8\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"fe459c153f638222\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"fd1f868ce51981b8\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"e56a10cecc9a1051\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"a5e6c84facc6c64e\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"ee58b741db44e482\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"69573a803b722af4\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"b8cf87d190cc610c\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"0567080a5965318b\",\"/knowledge-medium/src/components/ui/button.js\":\"fb71b57bf2e50d61\",\"/knowledge-medium/src/components/ui/card.js\":\"9425cae0dfe52ca4\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"4f2eea20e5f9ffe2\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"8fd2bd587890a4c4\",\"/knowledge-medium/src/components/ui/command.js\":\"b0aa40054e22ca36\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"dd0ee0f540d50bd6\",\"/knowledge-medium/src/components/ui/dialog.js\":\"c113249edfb2ac16\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"c5c5ccb1b8093c74\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"053822c1b53b89ea\",\"/knowledge-medium/src/components/ui/index.js\":\"7bd80f5fbc680283\",\"/knowledge-medium/src/components/ui/input.js\":\"40ea522da33b8953\",\"/knowledge-medium/src/components/ui/kbd.js\":\"a7a7a0e2819113bd\",\"/knowledge-medium/src/components/ui/label.js\":\"957835e970ede10e\",\"/knowledge-medium/src/components/ui/textarea.js\":\"36660f80cc1ccbc2\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"0a36467d72690e9f\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"5417e3396630f0bd\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"0dd6c3f6fd6e7d10\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"fe9b11955566a1f6\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"522d8aadbb8747b4\",\"/knowledge-medium/src/components/util/error.js\":\"c42376c6f06b4334\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"fda6d5311de7e806\",\"/knowledge-medium/src/components/util/suspense.js\":\"ac5b5a8522dc9ea1\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"7a016759c5046f22\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"357cf001d967dc17\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"8b0c732d52e5fdfd\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"44c38164675cb6c8\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"885143e74b138f2c\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"367f6d7c4dfe83b8\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"cb0205d809577cc0\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"ccd8c2e4c843a212\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"e25fb2786b57b9d4\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"4176cccaab52c004\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"c9aa1c0262814d52\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"e78a1e621c590209\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"f277148e943a55f3\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"497f6a5585b9d28b\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"a7d313727228510f\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"c200b4a8cad3e8ea\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"ff4da899c1c5628a\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"f44e87b063b60193\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"259377aab4014a7b\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"c16bfb5a967aca27\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"5ad23b563fed2589\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"8fd1ca9fc0130260\",\"/knowledge-medium/src/context/block.js\":\"3174997f2d6ab72f\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"90f6d774711db3a5\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"ac5ccb637a460aba\",\"/knowledge-medium/src/context/repo.js\":\"749e97a573e6b4fa\",\"/knowledge-medium/src/data/aliasClaim.js\":\"9ce653a8d954a2be\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"b438db6b01c2d526\",\"/knowledge-medium/src/data/api/blockData.js\":\"f6789e417fa1c190\",\"/knowledge-medium/src/data/api/blockType.js\":\"81d418ee0332d945\",\"/knowledge-medium/src/data/api/changeScope.js\":\"5672c51f6e801ad3\",\"/knowledge-medium/src/data/api/codecs.js\":\"083a7cd12d0f412c\",\"/knowledge-medium/src/data/api/derivedData.js\":\"1bf9359ebcd4652c\",\"/knowledge-medium/src/data/api/errors.js\":\"0cde6bbec586411f\",\"/knowledge-medium/src/data/api/events.js\":\"862bb771ca3c7891\",\"/knowledge-medium/src/data/api/handle.js\":\"8c19e512008633ae\",\"/knowledge-medium/src/data/api/index.js\":\"e2481e9444d982ae\",\"/knowledge-medium/src/data/api/mutator.js\":\"049ca38fdeb2a518\",\"/knowledge-medium/src/data/api/processor.js\":\"295b487d005cbdbf\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"4a1a1f31afd1f684\",\"/knowledge-medium/src/data/api/query.js\":\"1888fe3be697d353\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"20606bfc373ae2cc\",\"/knowledge-medium/src/data/api/schema.js\":\"8c19e512008633ae\",\"/knowledge-medium/src/data/api/tx.js\":\"8c19e512008633ae\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"a5d9ca178d0f3dc1\",\"/knowledge-medium/src/data/api/user.js\":\"d66e241cc570f5d3\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"ef84f11a5c3fa796\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"ebb054f9a152d83a\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"caf16e8839ab411b\",\"/knowledge-medium/src/data/block.js\":\"65806833265bfc12\",\"/knowledge-medium/src/data/blockCache.js\":\"9450d7e9cd13d38f\",\"/knowledge-medium/src/data/blockId.js\":\"b5a9d747dbd377d6\",\"/knowledge-medium/src/data/blockLiveness.js\":\"6bcd72f034c94825\",\"/knowledge-medium/src/data/blockMerge.js\":\"23a7a678d8409d34\",\"/knowledge-medium/src/data/blockSchema.js\":\"2a268bbbfcb513e2\",\"/knowledge-medium/src/data/blockTypes.js\":\"0eaa06f7c999bfc6\",\"/knowledge-medium/src/data/clientContext.js\":\"74927d3dba05d4a9\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"b88d94de927c6330\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"d4bc67be7f1a776a\",\"/knowledge-medium/src/data/derivedIds.js\":\"0c74490edb5e79f0\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"6e70357b87eb9cc7\",\"/knowledge-medium/src/data/facetBridge.js\":\"58303fc4b45a465f\",\"/knowledge-medium/src/data/facets.js\":\"871a7e6fa6bbf528\",\"/knowledge-medium/src/data/globalState.js\":\"d4f7764a0ccbc800\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"922496638db85a57\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"01f9cf2fd5d1d02d\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"f657f642408c860d\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"31a0744d61ea8df0\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"13142ce50dbb0a49\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"b9b1f4dffea1c574\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"06d401b18dc2b891\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"4f4dec8a369aaafb\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"3aef5c05275c82fd\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"e8d844d0895183cf\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"ea54a8385a35ca84\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"5cd7d5a027c200ae\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"e225e5539557d9b9\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"07afab7dc33e47e7\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"faf9b932ee40c9b2\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"49101c0690ce354a\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"378fe6ad13e49576\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"38cdea864245223c\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"b71ad8bf67199d23\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"460b77c5a0864194\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"76e05be119870ec6\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"1fb73b6aae5459cb\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"313afa683ccf02b8\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"64913669b0621101\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"b22644a199e42094\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"b49ad1f2594cc000\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"2f4e9ad344c4c998\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"2fadeebb50bdd7a8\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"0e27938ce206c341\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"f87bfb62e1d26a03\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"fd44d941f4eabba3\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"b44682610586fd1e\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"07caa3c23e86f31d\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"75c6edb15fdff342\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"0a6cf2203ffac58d\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"2946e8d305928576\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"2830696d9892d97d\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"fc1bf70bc3bcee65\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"2fc80c6332127c88\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"dfffdef2da1b5e04\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"850b63489ddfc423\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"dc912c771f4f9157\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"977b12f771031d74\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"ba84e17641b1dc3c\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"20d1543421a7f5a6\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"bc77830e00c4eccc\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"051d4b5667cf89ce\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"806056e563605151\",\"/knowledge-medium/src/data/invalidation.js\":\"4dbaa44ec5a80f1a\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"a9b8f95ec1664cec\",\"/knowledge-medium/src/data/kernelPage.js\":\"98f34931a6eb03c2\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"b5121ba1df13b16d\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"88cc46b31f8f546d\",\"/knowledge-medium/src/data/localDbStorage.js\":\"5a447f3574ce7f31\",\"/knowledge-medium/src/data/localDbVfs.js\":\"5ffc27b2a026e7d3\",\"/knowledge-medium/src/data/localSchema.js\":\"51b8d05748c57efd\",\"/knowledge-medium/src/data/maintenance.js\":\"9c63f29132d7358f\",\"/knowledge-medium/src/data/mergeProperties.js\":\"3cd57a1d26de9942\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"79c7287d88535783\",\"/knowledge-medium/src/data/migrationsPage.js\":\"d58e7f3e9b8e616a\",\"/knowledge-medium/src/data/mutators.js\":\"ab223b452b6f79a7\",\"/knowledge-medium/src/data/orderKey.js\":\"2a5cbfc8266d303b\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"d895ecc96706c667\",\"/knowledge-medium/src/data/outlineSurface.js\":\"c9e902f1da1267a1\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"d6317edd33c98993\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"2caa26f484035fda\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"adc2db68291237cb\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"6ab027b066233cee\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"d0c014d9adfd79c5\",\"/knowledge-medium/src/data/properties.js\":\"76100f6647f18d8b\",\"/knowledge-medium/src/data/propertiesPage.js\":\"6c122126a9b5d1f2\",\"/knowledge-medium/src/data/propertyChildren.js\":\"5c947b8b845095a6\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"26b501dc4f73d450\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"24f65ded32db7584\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"839feed36de5c32a\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"405bc4323778a70e\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"8ebc7c1e045afa26\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"fc3bc2c233ef11fa\",\"/knowledge-medium/src/data/propertySeeds.js\":\"d83e908cc4e37f27\",\"/knowledge-medium/src/data/recentsPage.js\":\"7089aed6c83e77b3\",\"/knowledge-medium/src/data/referenceBlock.js\":\"196a48455913f1d4\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"2146a1dd83ab583a\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"e601c91df625ed23\",\"/knowledge-medium/src/data/repo.js\":\"c0dc3b090d53080c\",\"/knowledge-medium/src/data/repoProvider.js\":\"f75bce1d4f679ac9\",\"/knowledge-medium/src/data/rowProperty.js\":\"ed8ab5fd56b8463e\",\"/knowledge-medium/src/data/searchFilter.js\":\"b7b8d50babfb69e6\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"99b79ae21a2d6ee1\",\"/knowledge-medium/src/data/stateBlocks.js\":\"2ea16362ddfb9071\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"9178a08ff97de33c\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"06140a17fa234262\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"ab369b3013dabeb7\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"c4abaeafbaf8813a\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"3ffa5bd5c377c126\",\"/knowledge-medium/src/data/targets.js\":\"2317878236b8c846\",\"/knowledge-medium/src/data/typeColors.js\":\"8a13deafec4cf8f4\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"4fb7e26715a3745b\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"32815078593020f4\",\"/knowledge-medium/src/data/typeExtraction.js\":\"ef93a9b7f61aca4b\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"b267fe894aae8b03\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"47c01502d8abdf34\",\"/knowledge-medium/src/data/typeSeeds.js\":\"79414b7b09ba03b7\",\"/knowledge-medium/src/data/typeTagger.js\":\"224d743495421def\",\"/knowledge-medium/src/data/typedRecords.js\":\"2163a91b96a0ad06\",\"/knowledge-medium/src/data/typesPage.js\":\"17fa728cb39b77de\",\"/knowledge-medium/src/data/userPrefs.js\":\"bcba67cf94601647\",\"/knowledge-medium/src/data/userSchemasService.js\":\"d07d3574de01d0d5\",\"/knowledge-medium/src/data/userTypesService.js\":\"694f54b166536b5e\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"f68a4bd594042aa6\",\"/knowledge-medium/src/data/visibleChildren.js\":\"9e04f2dde549f059\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"bc5de6d777a7d4a9\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"d08f8709e5828057\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"f480b34c74ead25c\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"de503b9a19090626\",\"/knowledge-medium/src/data/workspaces.js\":\"55861c60318d6fd4\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"5733459364d9b90d\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"4e821e1f784805a6\",\"/knowledge-medium/src/editor/atTrigger.js\":\"d97d7fdd62c5c280\",\"/knowledge-medium/src/editor/autocomplete.js\":\"1999ac39461c1ce1\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"27371b91cdba1f4b\",\"/knowledge-medium/src/editor/contentFlush.js\":\"c4f1523062e1f1b1\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"4dc9c5c81e1a2140\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"2f087d9b86c42caa\",\"/knowledge-medium/src/editor/insertImage.js\":\"544af72c4b1db15d\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"46ead652301ee8b9\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"0f984098c9c0376f\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"e4fdfdb1128bff74\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"44c384d2d7cb1f6c\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"a1bc65bda990072a\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"eca10dbf955eaddc\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"b3708c8042c0116e\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"f389dd600568e165\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"7b3876bb156c556a\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"89e3a1e4b97a83bb\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"33f546ed37e73be3\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"bd4b9c095dad9451\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"1d36a3eac0a01133\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"c432a2ab1d447bae\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"9382ba55c800cdbc\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"7bb36b3e133fbc40\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"a0e2c5af7142bfe5\",\"/knowledge-medium/src/extensions/core.js\":\"8e709f57a87abf79\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"fc34ad9b2ea06a33\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"97d370bd7d8b9e25\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"ca357394d710d7c4\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"027f4bf84eee0155\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"6533d906ede47af5\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"37cc0266494e5696\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"b8934b944dacdaaf\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"32709ad09eeea3e7\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"942e52da53121e90\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"0f1109f928058c97\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"57079d91e88268f8\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"8921b59ee5aef33d\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"8f96839e408f5c1c\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"c21559abe6f31bf9\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"f5b37079b253e1d5\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"67278c61830f78aa\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"4ec730e32bd128b3\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"35e5ca7caf9d197d\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"ed5466b9a9d9c0c5\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"8c6d2566d2187dbc\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"c8ccd6fd2080a4de\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"7620550b16a5bc7c\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"3c2a7a112ba9cd7f\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"090bf7b768614383\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"544bc8ad2ca149a2\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"01750885072ebbfb\",\"/knowledge-medium/src/facets/facet.js\":\"88121ba9685c667d\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"a28c09c7544e89ba\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"bdfbb6b0eb8aa5e2\",\"/knowledge-medium/src/facets/togglable.js\":\"e10b9da111e646de\",\"/knowledge-medium/src/facets/variantFacet.js\":\"df1e9b2c91c37cbe\",\"/knowledge-medium/src/facets/verbFacet.js\":\"5303d6c3e9a596f0\",\"/knowledge-medium/src/hooks/block.js\":\"83d34b1dddc75993\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"a51e116c704c7e3a\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"7db5fdbaaa6a5521\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"a5ccf9dcb392be55\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"04e39a5276c67511\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"6a9f755522b9d6b0\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"69d76b803a98512f\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"dec7b7039d0c6f14\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"7fecd05e4741dd3b\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"e01a89cc24513813\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"f5b7c0b3c7850e19\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"315b372a8864178a\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"455aba56420cc6cb\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"bd8d09839746d909\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"6969c0f1e6fbde1f\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"b3fd69c156b28e6a\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"a91bf83b4d0098aa\",\"/knowledge-medium/src/lib/utils.js\":\"231b137d87ca2b35\",\"/knowledge-medium/src/main.js\":\"25a8c85ec8a2abd8\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"8681b216a8b33a10\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"1e6a34667860f947\",\"/knowledge-medium/src/markdown/context.js\":\"4c16655d36a584e5\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"a561eef77b842d16\",\"/knowledge-medium/src/markdown/extensions.js\":\"2ab817b5fc2dcff7\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"79786c3581fd244f\",\"/knowledge-medium/src/minimal-editor.js\":\"5626946e94d1f0e8\",\"/knowledge-medium/src/paste/armedCut.js\":\"0d189012ddbee249\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"981d5c76e3f8e588\",\"/knowledge-medium/src/paste/clipboard.js\":\"4fa1d26a3e7ae34d\",\"/knowledge-medium/src/paste/decision.js\":\"458975250b27e9a0\",\"/knowledge-medium/src/paste/operations.js\":\"ffedc18cffb2a85f\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"158b14d9089a6984\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"d9eeba37bf167b35\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"79462ad47a4dcd8d\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"58394095d0411430\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"ab053188060e4d8f\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"9bd202c22ce96cf7\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"62079a10b3b4d9a5\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"d3a665da626462f2\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"3536894489542d53\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"9487086bc8d0445d\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"b37a13b9bafb7f2a\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"58fccaa04e2eb5dd\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"2a8573ab0f0f45b1\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"b2f86edd8adb7cd5\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"138e60eb2d149631\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"7db3eb35ad49e81a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"15ecd8f1b8e93be1\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"10313bde5ead1ff1\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"41956dbf0a675cb0\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"bc31cffb5ebc12aa\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"aaaba1958a2cb1e8\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"da7aa56482fb51c4\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"9d2f7d4cc90c3700\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"19fcbf5ddd21951f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"609ba5b7bd8b8b7e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"ec91682152303913\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"5fc188a09222491a\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"10ea53d8a6435782\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"fe9d2c4d3492c5f1\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"e8e792cde146a200\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"acd6b946ccb91f8b\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"092019e53fea6310\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"30ae6cb72303014b\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"9ecdcafb6c7131b7\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"1f8934928aa20b12\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"7fa5e801d0e5146b\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"9a5fd5d9b521dedf\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"cc349b17c6c84334\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"16d4614792c501e4\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"24977930d672ecf7\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"0ea321caf4ba631e\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"87590e4b001369c8\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"f3ad5dd9f2337125\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"02cabd12f3bef4a2\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"ae266716e8c32a72\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"1632ffaee3fc1431\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"eeac99395926e53f\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"444f135241fd63c4\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"85685bfe0e765fb8\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"2009561e5d620978\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"12532f43fe13e0cc\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"421010be9308670a\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"f7be13b243144925\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"5c0f433fc47b9174\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"431efbe3d986c3a1\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"5c2c032055c11ed8\",\"/knowledge-medium/src/plugins/alias/index.js\":\"d1c64ba595df6781\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"05d4f5811a5cf30b\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"d2090a2ac5fcbf05\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"614e98a03ff1887f\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"3c41aeab50557136\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"98a686da353de363\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"11219d5506f6393d\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"0c2adcd761aaadff\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"261839857b04ed13\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"18e8ba6a1f33c897\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"da305e3566954c8c\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"9a11031e5aa3cbc2\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"a6fbddc36c5735d5\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"ad8b43422ddbec02\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"2e1b9aadbb714508\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"bc716d43ae016d0b\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"b07c2d3ff5befec6\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"333ffe8215bcf240\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"2e79fc7ea8327602\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"1962366dc2d68804\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"45944e3d9e559cce\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"3d35c8fa9710eceb\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"c442faf17745dbfa\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"1e8c07917a63b350\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"1f1d0708a4646249\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"8ff8adfbd8cbf95c\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"4c3d973cff9f8b34\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"6ec05b0935f8847c\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"dbd96129072f5fae\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"8ae0ab11198fd1c8\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"06743051e40bc08c\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"f5b170c226c99698\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"867d7c67c776557c\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"09ada5439422a178\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"bbe58cde3f28c5de\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"50efd1c76fd3d48f\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"74f6e0019743f9b4\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"02a028ae6f054405\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"de022e6dbbcda771\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"a6e5ecdfa8a3a6f4\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"e2a94ffe49eae1a7\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"71fa9f82e41618d8\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"590865a197919737\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"be8d0dc930d21ded\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"0e28757fd9e0daab\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"8eee5d973a3bd226\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"f28afe01e8af4803\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"47cbc39c5927ecca\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"34277bdf50224638\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"9d221c0a8ecad8d8\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"9cc91d347b632aa1\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"4b757b2e386afbd8\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"c0ef2e2d9e4b35d4\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"b63a7b62f343589c\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"91db17872552e710\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"2944b212c98720f1\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"322ff0e4a64fa7fc\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"d021c63171eca578\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"32df83e4b4d05d52\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"643ef62e88f423cc\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"4653183b47288045\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"b926d44fc656c210\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"053ed748cdd54739\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"9b9ac0dd71a4c1f6\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"e779ae3c5f30dacf\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"820fdbecd17e1e67\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"627d6f3b35ff56f4\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"ef893d6006fc8ba3\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"cb702945c3bdb9ee\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"66500f4676ae9ae4\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"9ff66c11148e0e9d\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"ef40981eec9c7cea\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"307898ec74202d75\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"19014bfffee6533d\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"098558fbc2ff75d5\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"ef511b0be0162224\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"f1c4b2fbf1c3be06\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"e9b6e7dce7f6f25f\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"1cdc4c2cc9a836fb\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"d88bd402d948b29b\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"fd71b2e944f03a13\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"759775292f056be3\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"61e692509c1eade8\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"8d4810ac170c449b\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"edf495b7648db0b5\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"000ed5764312bb1f\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"b452228dc34982a5\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"7a8b3c7f443c67ad\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"6612b33f0e734092\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"80dd63a644da4595\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"6b6a8bd35587b1e7\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"ce9bad528af28b15\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"b792d3a6e83cd022\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"e5f88f745e7f9348\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"36f987da4d3c1d74\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"4628a6b3b01ee6bc\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"61e7e1161709c210\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"fb84699721c4e33a\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"a7cb6920bcfb473b\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"ed82c817d373f3fd\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"af88dffac427d17c\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"0afdba330882308c\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"df4521538332cf83\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"9690ec16d8b19b44\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"5a2e17510f043a5d\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"497c70ef52fa5510\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"b437580ca3b11c92\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"c3235626ae10b1b4\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"81189087e89ae3d3\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"16f8cf3c37c0135c\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"65039135ea4fecf4\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"a0defd0b84f24061\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"9f1337eef0a5ba1b\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"61c0ec03fbaa28dc\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"e21d38c905449838\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"583942842fd79e70\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"dcc23c417b64d1bd\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"5b84a94eaf0ecbb9\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"8743fa8bccf93188\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"0297ae6be031574d\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"7d43501dbf27fb42\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"05f79e87fa951586\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"2bbc05844ed5df07\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"81c8ad6c721d06ee\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"b2fcec9349d7e0cf\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"477bf7877319e664\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"711736eb11ac9e77\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"730f074ee1aa3e25\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"d931558b7fb65d8c\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"a218d7acc041a0be\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"3496480b201e3725\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"1b39ad762013d70f\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"679290368596f190\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"5bd9f70a675f9692\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"263b34d1576de7e3\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"51a93463bebcd564\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"fd9b76134ddb1b54\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"cdaf0cbd21ab498c\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"d85491bfa2496165\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"503fa199e62fc8d2\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"b059f57d9af81207\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"c6852cb57b1ba976\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"da7629d21ec341f6\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"739aac3283d1e2d9\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"afa4f992fbf9af3c\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"cdd167a5746b89fd\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"0a3ce123e027e4cf\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"acefabf9284439fe\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"fc5325a3f0a28a52\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"e8c313d461d78ac6\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"1404c90cee1222fb\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"f9cac4cec5196ba2\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"0676e2a4611294b6\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"de81442f94cd3ad2\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"d6b2b955110cf861\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"78d45c678af31d72\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"9be96dd9c68521b8\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"2b657187a732698d\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"9fd9ef8fb712f6c3\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"b7f4e312194c4071\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"f9b93debcd4be4d6\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"2e1b657537738913\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"7afb5ef71d041e22\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"5d5d7f10b3d534e1\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"0071bea216a5e294\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"fc812df381723639\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"4250e2892eac5728\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"8b0e3f56fb594d7f\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"10c35468aefe7d36\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"a4fb7cf28e3bb09a\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"f314ed0ece296182\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"e62b1b83c805feae\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"41d347b0bd01fb02\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"b291b92be8045235\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"07c642089f89221a\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"860216736b917324\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"f3ac74421804a388\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"e65a083dd6a2184e\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"e4ea39fa30f3e3f8\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"eb8a484fc9f1a328\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"e9bfd3ae42885919\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"2250b4e3c1baae66\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"bbb29c602e41297a\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"7ba523a610eae263\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"8d5a4306f1e05437\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"11ea94ed29ae42dd\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"2467c6c452deb7f0\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"3ef8d6a35de4195a\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"3ffd7507137d5056\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"b40245a3e335b6dd\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"340e41e42a1dd84c\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"d7c0ae263410f82d\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"e236652412710ad4\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"6e8cec90eb6967fa\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"a0e815f62120cb5a\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"573c587fb62f7221\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"74ce83543ae32589\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"14e19a42bd46b48f\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"97ad5e2f3b9f60af\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"9c6dcd3dede699ec\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"0069015599e1f200\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"aef0d72e939ecbb8\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"02ee9348d31a6682\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"9c3444b22c516c87\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"13d90c3f32bf21ee\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"074f1479ef300039\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"5dad157232bb4acd\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"baac8d75c6858ab5\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"38a944a040a2b8fd\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"9f0166f406b97453\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"ecf6eda977ebb503\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"3dc66066850b3aed\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"575386dd61a2db22\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"9d83adac70ea8581\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"cb5aacaee25defbd\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"57b071d7e4f5deef\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"5da17c610de26e50\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"f8ec5175d51dc920\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"5a334d71c44d9705\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"f2889555d73e41f3\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"ea2d714cbbb0abd1\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"12bc43761a1cecaa\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"74923edb4bba750d\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"fc4e7eaccb9a5103\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"060097eff8880fcf\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"d032e035dbadb1c4\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"b09130b46edca71b\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"4ed1de508bd1856a\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"c7e543eac249d401\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"5bc703c132db5e21\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"389bd6ddb7434264\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"29a1f600657d6b59\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"d6ec26c11565637c\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"a65405d13788ee07\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"18343655afe01316\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"4b3457493feab19e\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"349d49df47a29461\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"3b61da0d2721beda\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"dfb74b4d22a91420\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"33091cdacc112f52\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"134f30573311545c\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"a8b0b389643b5388\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"839cc2de32b4169b\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"3b3919c9f6f6b179\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"58f973ef02f821dd\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"79605da7a6fd3af9\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"a4ea74dd30c94ae3\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"787cb3ff57d2f741\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"b1aaafb1d1532590\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"139e2d7579a95fd3\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"facdfd3bf8c3cb73\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"04cafd228f3edbf6\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"a0cf1b600aeb93ac\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"13a68bb1f03cecd4\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"a0eca88c3b9d6c26\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"13a2fe8fe78b4d71\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"8e9e51a08aa7a87b\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"7885f17da6cd19f4\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"d749789ad8e12d33\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"c3fe13c710f43a24\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"35ca424af64eea71\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"250dc19144a24f84\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"0779c2ab91c29793\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"ab7ef9f2a1b72baf\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"6d0eaac565ae0a1c\",\"/knowledge-medium/src/plugins/geo/index.js\":\"bd14b27869303399\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"a51be4a85d08997b\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"c77de57f8f3a2d26\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"138025756f772f2d\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"7f6780440c3620c9\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"3447ab7533c044da\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"bce4d6b7e353776f\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"0c9d9af923469a7f\",\"/knowledge-medium/src/plugins/geo/query.js\":\"390e6eec1651f9a3\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"ed15bc88ed1e9b3a\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"d7f96def50c7c85e\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"b0140d16059795bc\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"29b6ee9e3da35e68\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"feb4866c49d79053\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"64986d045b34d162\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"0a4abe93d118d6a4\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"e8e25d626aed832c\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"9dbb7af114b8c3e3\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"452f2236a40b9919\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"a007022a7ed3f05a\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"2f648375f43daa95\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"ee4b1cfcb4a29a98\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"50e2c8b1fbfd7497\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"e5abf1a78790709b\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"be2ce410db74b0d2\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"68e9c31455e14260\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"0e328862a11de750\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"54160ccacfa17fad\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"283bbba9156cde7a\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"1c2d6f9c1098e3bd\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"f3c424288f2cc479\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"f2c42256b68eceee\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"9b1999ab9faa7d82\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"8c9a980d06402a65\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"3eba5d8f14b9d9bc\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"4e7592234ae138bf\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"2cc3378a86317f0b\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"35adbf8398fe35e4\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"0ea92bbfa8f0e128\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"aae94308b05e785c\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"1d4e455eeb0ea05b\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"7ffc2334f253acb7\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"93bd4892526b8b5a\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"48cc6501927d1323\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"fefcd95f0f241537\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"871c1062624a6d28\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"6255d096acd419b3\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"6fe036c58bfac802\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"8dec4c5072bfe9b8\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"879a005223b7ff83\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"83830330aa243cb1\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"0ef29755b0e1d585\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"4bd1e25e678c64f0\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"9f6e14785157d5c8\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"49df1765f01b5114\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"e9b0fe6c392f047f\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"62043004f3dec587\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"dbb6ef8f15a3cf14\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"4e4491a79a04fc40\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"cc1a78e41fbe287f\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"c70ce63787500b32\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"62c5b7efe55a0ad6\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"1d3349fab6389f3e\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"392df4a0d36962f7\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"cdad32c96b456274\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"e68cb62369ccafaa\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"0068d694dbcdd35f\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"1190bcb775683df2\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"8dd80c18f397268b\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"a059216404118c1a\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"de82c170f37a02d7\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"1125776bdbe96442\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"cc4b5c30d58cb00d\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"78bcfbd56343d713\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"e00fb6c5759fef8e\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"e1caa8754d51eba6\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"409cae34a6399afe\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"3446041d8eb0249c\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"287bbecd5882eaa7\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"90e5d2df442cd4f8\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"cf9314339b05dbec\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"538f6b80cb147760\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"484a65b11e4150e6\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"88065fa495564f92\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"e4a29a6d81736e7c\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"c3b929ea9e319186\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"50d0a074be8fc416\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"c88253f3e3d4df31\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"701b8e48cf1feb33\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"03f7f5d75153b968\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"77ff9e178580ac0c\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"186b329d54c6a1df\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"c47b22478bbe53d1\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"3709b8cf4dc053cc\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"427418543629276d\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"9b4c1457e391a0ba\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"91f4ec2aed050f54\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"185ce683cd9d66ec\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"017ee622c140a3af\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"a4c87e65454da17f\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"0f123723eec2ba53\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"58ba9a3bf83efe16\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"524de703c1cfad20\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"e26e30b0d0f093d0\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"48953e66d32bbaec\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"e3f70aaf3b6150c5\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"e34cc7ce3b8e33b2\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"099275bfdb5883b1\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"60113ba33eb66c43\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"1176a5298cdabbaf\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"5490ef5a4f7db2b8\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"e8839d0afd0170ea\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"af3b52d89ac797e5\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"45bdb6b779d3b810\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"5a6adc24a4b1f7b0\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"7122656a6746f79b\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"95ac9322da8b6589\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"b3cede7fa2449550\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"d99364149d626ff5\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"a80f235b39bccf3c\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"a044a2bf1b4bfd18\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"6f9e6c454c1d37b2\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"aea6b75f19c8873f\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"806f2b7cfa2d3303\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"0bc3d029f07e3f55\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"8059c27aba257cc4\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"b574132f6891c69a\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"684b0160a8287305\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"0bd475d47ec824e7\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"3b5b5de65959555e\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"bb2083eafabba318\",\"/knowledge-medium/src/plugins/recents/index.js\":\"33cd00d7e3e2dec6\",\"/knowledge-medium/src/plugins/recents/target.js\":\"c7752ae7a51d27d5\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"58c74fa86e39b6c8\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"7f205c3bbf76ba7a\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"3d960b2e5a1e77cb\",\"/knowledge-medium/src/plugins/references/index.js\":\"2a7c2260f353f4bf\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"b37a93b7b7aa6788\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"0a8dd16160b2a337\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"20f534c69260b4c5\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"c378ec1ab78b1868\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"035f03238a0ddc21\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"9e70bca5ec8a68d3\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"9a90bff83fb8c6ad\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"a2142ffac525963f\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"ffc95b7193fd1834\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"c5bd880a3eff2fb2\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"9fe8621c3be78115\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"5912e2a427ecb7d0\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"f4bf46eaee148aff\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"5b1ca503a841b56c\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"0bec62d2768fb779\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"914feb4a3ff197cc\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"82c5633c81518999\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"a15a6d2e3ea82553\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"70caac393fa9b617\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"d84671a7f5598e74\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"d10c9125fde35d09\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"25c03536d4faaae6\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"632c628f98789277\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"89777982c2a7228c\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"ae1db2e975664e37\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"346274ca3efcca69\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"4e14b35bfffb6f18\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"c45a7ca061a99bf3\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"e9db160cb486866d\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"2d6625ab45afb61f\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"e9f9be6cc3693ac5\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"e94b39be0c988730\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"bd7cc9d9c92161a3\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"bc7f324055d648ca\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"36e487059fe21d10\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"bfb26778c5c53b96\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"384d2ebef503ad44\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"ec7155dcaccee267\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"a29f9bbd7cfa2181\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"0d6837a9b7828280\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"94959a1f9d4fc2a8\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"5ca7ed9a92a73094\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"8d96f5c58d32b001\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"1b2845b93c79c35d\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"e3d50e2c9653dfca\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"6a4e253cc6cc6c15\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"dd6ccaa0c6cc684e\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"86d4c480765ed0ac\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"1e2d7f0584bddbd8\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"0cfb0779551225d3\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"2788e4a03c5c4be6\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"ef7f74bf4932d787\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"593ecd7306b01c43\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"eff2624cf409b508\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"02107f443ac9934c\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"e2c44c9eab6c13dc\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"32f7de5a91b0b7fe\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"b211a47cfb425d9c\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"04d34c9674bf0312\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"c9ed070e84cb570f\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"a9188b4b1b219980\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"d54251b0145a1efc\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"7690ffd1a8bdfc31\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"200759a2bc678a10\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"3284dcfb8a66fbe0\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"487f215ea3d92ce6\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"d82cb00f197a3fdf\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"57afe3f2b47ee10c\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"e7bb45a0dfcd5d2f\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"19bfaf31b2040352\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"490ce4f59f6fe591\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"68f8fd4addfff066\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"a79696ee0515cd54\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"82d07bb3b39335c3\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"6d078653046cd1da\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"c4ca572da595838d\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"ff48d02bfdaae94f\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"31785784ee23f712\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"b1011189350bb218\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"0e06bad6b2bcd588\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"ec9ef21b835b743b\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"6ef0ffcd7179fc1f\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"92a77b3a584c0c03\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"2922fa4ccd499c8a\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"c6afb31cc9fb22ac\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"6154dc1141d8bd5f\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"38fffb4f852fcea3\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"188d058bfdd9d733\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"67e9ba58b873b7e9\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"0f61282589223420\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"f742ebbe25d29dbd\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"b1c0b608a3b2df20\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"56849ec3af0f0345\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"afd9eecde992271a\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"68b28869623de110\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"a3519e15b18dd2c2\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"3a68ba93e552d1d2\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"d561cbd5a1b6b6b0\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"ff14245185660088\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"fe7b5d1e26f8ef7a\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"4b71a98f7f1ab6b0\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"6a47f6c0b78dd50b\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"3bc5cb80810e2a7e\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"f0212738c3122690\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"a9dd6d570a0a452d\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"5b6c7c5037c17bb5\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"7a4b8b6382c643e1\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"3ba87e80a2b4989a\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"3bf55f79ab9ea4a6\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"c9c7320387004683\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"0e5f927b3b74a105\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"948256ea76077a44\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"4e3453c89570fa1a\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"cc7d72de5933ef3c\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"b071b3957d60706d\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"21214698123d2b99\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"fcde8b419ddbae14\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"8f3e714ccffb7dcc\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"1183fcfad78bc068\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"0b45ecb0ba777f3f\",\"/knowledge-medium/src/plugins/tables/index.js\":\"a043de44854732bf\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"28dae7aef6d03f5b\",\"/knowledge-medium/src/plugins/tables/model.js\":\"819d8d73462fcf3f\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"02d67bce2532bc02\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"614e8ca1cc118287\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"0d815b70e8c6839f\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"92d17b2909c7946c\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"9272dc56dc1f8956\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"8c7baa98482cb942\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"d2a6f67800592b33\",\"/knowledge-medium/src/plugins/todo/index.js\":\"47dc5a67f4f00bd9\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"b46fd41a1aa48e19\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"ad02a8dafa957423\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"819823f1adb3486c\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"f37f4f5ed2290de4\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"d268bd8de76ce064\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"38f0c652d3ec0c75\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"6780a4b1be95f20c\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"696875b07f38d63b\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"21091eee1de2460a\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"f0d4aa5187632396\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"f3171f6e2074f75c\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"c66b8e6c4a3cc419\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"1e07bfa959a98279\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"a7bbf376a1ab8652\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"4670b1c034b2c141\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"901282dbbad3e600\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"77adbedd127b0b78\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"fad4729ac39a6f74\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"7708494e2eab490a\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"85212c52e1a0540d\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"67a299e307b85e07\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"860294535861e15b\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"732bd083b0b6a3f8\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"97f1295bcb03b208\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"d61f2bd4a0c91041\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"ff1f89edfed84b0f\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"fa6de565d5c8cf08\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"dd768f4ef92e78bb\",\"/knowledge-medium/src/registerServiceWorker.js\":\"482327e36e5e0d7d\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"392f440866f07488\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"2c17e52a301b01c1\",\"/knowledge-medium/src/services/authStorage.js\":\"d12713cc8c80b496\",\"/knowledge-medium/src/services/powersync.js\":\"35ef86482d9a3c9b\",\"/knowledge-medium/src/services/supabase.js\":\"1ff3438dbda7df68\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"e0cb481036abb484\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"e3162d43cd1d3e43\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"604ad6b65db34be9\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"4ca9b5350ec50262\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"14db62a9ee964e67\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"807404e69491d431\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"d660ad1f579fc777\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"1f8b90f77d4df733\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"b2839eb00e1fe0d0\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"fce4f101a07af6cd\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"4abf299c4626291d\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"1a2c9ba11d9a21e1\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"8604126d4e112608\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"f6c91c06fc6ba7e1\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"33464bcc77e30bdc\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"629f9f97a1dcb15e\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"d24d7ab93fadc430\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"815e6902c0ca7d9a\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"596f6bf6fcec9248\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"bd429ae733366afc\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"38a39310eb19efd8\",\"/knowledge-medium/src/shortcuts/types.js\":\"a126094dbb3775b7\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"8161bf737d98febe\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"024c4beeb851a874\",\"/knowledge-medium/src/shortcuts/utils.js\":\"67ef699c8496a192\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"60f71c6acfeab345\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"33f76f6de5e14067\",\"/knowledge-medium/src/sync/byteTransform.js\":\"0df2c656a74ea49c\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"2fa8a06911a98639\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"7f9a923f2a9289b4\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"1709522385461d06\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"c16407681edb0213\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"c1fdd1957ae728ed\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"9575b5335c5d9d44\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"4581892c9d106208\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"054f800fcdf28af2\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"d3b16b29df6f91a1\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"a563774e79dfc043\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"c6fa649bf504d645\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"d3963235c9edd369\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"ed406e66fba18866\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"f360d3f19a1f5b7a\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"0e23a0b8ac2bf51d\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"b05db0e6eb833bec\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"5d21782906e4dfd9\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"7ec669f88510ea27\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"2c29ef094a3431eb\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"b12a09c3c46824d2\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"872d1e4ffa85d8f6\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"3c06cfba3ef3e5eb\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"4c51466658e379ba\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"2f8a06dd58040f01\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"fdfe9634bf50e9de\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"93799c9a1d4c5920\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"36f943577a867080\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"c912bcc9721a6f2e\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"ad847b5f2aea8989\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"794b11dd4c772c30\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"6910b373809e745b\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"1940434701e9572f\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"26c27dfe4f20883c\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"8c33866ad3256b2c\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"f2ec3323efe076af\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"2d90e4b2563f21e0\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"5b43d83adb569f36\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"ed99c8cbd2be731b\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"59de80636d97d6c0\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"7d496bee28cccab0\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"cb1c05636cee6114\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"2a8b9cfdf61a246c\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"b3f4bd57a6defe15\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"915d182120b0d7a8\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"5db35ffefac50751\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"e6bb2207ffcedf6b\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"e6f571206acd26fd\",\"/knowledge-medium/src/sync/transform.js\":\"20a9e6b05d58ea4a\",\"/knowledge-medium/src/themeBootDefaults.js\":\"5d1a20886a07373f\",\"/knowledge-medium/src/types.js\":\"b3fafeb854c1511e\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"53035d78ed6d35c7\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"e603733178896631\",\"/knowledge-medium/src/utils/array.js\":\"dcea19a5ef96cc72\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"4cf136dd60becaba\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"f13392fdbef9e39d\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"336e4476840d9cc6\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"5f90e235c3b6435a\",\"/knowledge-medium/src/utils/callbackSet.js\":\"b9e772f3c6509810\",\"/knowledge-medium/src/utils/clientId.js\":\"a195ab6d77d7aa12\",\"/knowledge-medium/src/utils/codemirror.js\":\"5adf7ee1e1076695\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"328529054da42a0e\",\"/knowledge-medium/src/utils/copy.js\":\"a4c4f7ab090af5a5\",\"/knowledge-medium/src/utils/dailyPage.js\":\"0567b4026aed8b82\",\"/knowledge-medium/src/utils/dbForensics.js\":\"d0b3b277ff0abd50\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"6b7e7f907da39321\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"44f53dcc737b02bb\",\"/knowledge-medium/src/utils/dialogs.js\":\"0575307b8b55be4f\",\"/knowledge-medium/src/utils/dom.js\":\"ba2481370bfac96a\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"77b4d00a7631fcde\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"a6b962e20cb8c5e2\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"e0ec3b2fbeb81fa3\",\"/knowledge-medium/src/utils/flipSlide.js\":\"036437d0a5953ab9\",\"/knowledge-medium/src/utils/fnv1a.js\":\"2d69afc2943e7e10\",\"/knowledge-medium/src/utils/formatBytes.js\":\"66bc553615898253\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"92688cb9fd283508\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"d82e04a24db5ba53\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"6035db311a5e4de3\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"b8116af606fdc581\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"876c3489852978c1\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"160dad41c5898e98\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"f99e5c89b84dcc8c\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"55ed1646f51c5275\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"e4ec25fc003080a9\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"1099fb4c31eb1a6b\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"3cf22bbb68907964\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"f64c3e93e7cdb657\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"30b31c5f784f0b19\",\"/knowledge-medium/src/utils/markdownParser.js\":\"3435a4571d44d5d6\",\"/knowledge-medium/src/utils/memoize.js\":\"84929dc93486398f\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"121d81c493ebed3f\",\"/knowledge-medium/src/utils/nameList.js\":\"6a918134be322809\",\"/knowledge-medium/src/utils/navigation.js\":\"16d6fda4d7f2810b\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"2686c09b2e317612\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"7afd29e71cbe7a6e\",\"/knowledge-medium/src/utils/panelClearance.js\":\"24f2b1fe9cbd96f3\",\"/knowledge-medium/src/utils/panelHistory.js\":\"3a8d4687b151759c\",\"/knowledge-medium/src/utils/panelLanes.js\":\"62e6c6a36f0daf6a\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"e85362266543efd7\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"d14be186b0ed6423\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"4839366a60e8a93b\",\"/knowledge-medium/src/utils/platform.js\":\"6f6e12a18a4a6980\",\"/knowledge-medium/src/utils/pluralize.js\":\"af80803473126909\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"03d80bb8b6bdcf36\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"e30f74aae8c72832\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"3c6e777076642d74\",\"/knowledge-medium/src/utils/react.js\":\"84317043c65bd87a\",\"/knowledge-medium/src/utils/relativeDate.js\":\"ebc1ff3b16dc4c66\",\"/knowledge-medium/src/utils/relativeTime.js\":\"765510d26002b084\",\"/knowledge-medium/src/utils/renderScope.js\":\"0586733bf5347fee\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"04576947ad9eacb4\",\"/knowledge-medium/src/utils/routing.js\":\"fa21dcbb26372a49\",\"/knowledge-medium/src/utils/safeMode.js\":\"b6ac41cb015f925a\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"fd3619c47f289872\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"b6a2e9ebf238a425\",\"/knowledge-medium/src/utils/selection.js\":\"0bb6cee26eda96eb\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"bf2900f40ac5af5a\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"5fe04f2e5b95fe8a\",\"/knowledge-medium/src/utils/state.js\":\"fe270be3df0c1ba2\",\"/knowledge-medium/src/utils/string.js\":\"90d6ce1b25c3da6c\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"e3d667a04a5c0fb9\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"7ff963b7eee02f08\",\"/knowledge-medium/src/utils/toast.js\":\"2356a86c09e4f12d\",\"/knowledge-medium/src/utils/toggleStore.js\":\"6abac914586a7d19\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"8d51aab9af227700\",\"/knowledge-medium/src/utils/userActivity.js\":\"065c80ea6c2274ed\",\"/knowledge-medium/src/utils/viewTransition.js\":\"25262e57a84ee472\",\"/knowledge-medium/src/utils/viewport.js\":\"cae906042ce1da9e\",\"/knowledge-medium/src/utils/webLock.js\":\"b903d9eb04127bec\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"617d1547ba69e650\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"36fbbb56c9e45d2d\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"3324923f05906cfe\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"d2244dfcd9d3994d\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"a8141b935d878878\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"d77a6cdecd4f2ac5\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"3fb5a74f278eded3\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"4fca1c2518327a91\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"62a352a882542b23\",\"/knowledge-medium/src/vendor/react-dom.js\":\"09c296aa33ed00e6\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"d4172bcc9c587250\",\"/knowledge-medium/src/vendor/react.js\":\"9af9d872f2efcdd7\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
