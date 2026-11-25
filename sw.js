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
		buildId: "bda345a229ec-9517e810",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"e229af68ada002f3\",\"/knowledge-medium/index.html\":\"e229af68ada002f3\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"6e3bd4a005b4bc56\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-DmF83xgw.js\":\"9df9da27b1a67394\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"c848484afe56184e\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-CPeeFMrw.js\":\"74471affc4964620\",\"/knowledge-medium/chunks/FacadeVFS-Db4vqXcW.js\":\"04aefe8eda971d38\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-B_OqwJX5.js\":\"c4d98ab8bf112cec\",\"/knowledge-medium/chunks/MemoryVFS-B1XgPq-e.js\":\"b9ceaf153f48264a\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-k-ICFIN8.js\":\"595893e4b10c3bda\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-A0Xi4HTr.js\":\"405c6641f6dff8ed\",\"/knowledge-medium/chunks/Preview-ABqp6oIA.js\":\"17be24bbf9f7387d\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-BELTiqXT.js\":\"b5fb63fdbbab3937\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-CN4gVl3x.js\":\"b46faf4a58ade2c9\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-7NE_eUZu.js\":\"be3cc3242db14afd\",\"/knowledge-medium/chunks/react-B6ZrXGVW.js\":\"c1e6480d8a21cd33\",\"/knowledge-medium/chunks/react-D6vL0Sb9.js\":\"54f2fcbc2d439b65\",\"/knowledge-medium/chunks/react-DdsoNDNa.js\":\"e9265c8d6fce733e\",\"/knowledge-medium/chunks/react-DtGCnsPH.js\":\"5caf538c624122f8\",\"/knowledge-medium/chunks/react-OgsVNUNS.js\":\"ad730c01d27669b3\",\"/knowledge-medium/chunks/react-VEcSM6aW.js\":\"15ea50ebec535c47\",\"/knowledge-medium/chunks/react-a7cnjKrz.js\":\"0c0bac5191c9c9df\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-BA9UBvrz.js\":\"a4b24a7e0b2e1fc4\",\"/knowledge-medium/chunks/react-dom-server.browser.production-C5GK3J1Z.js\":\"cb528208779a0a45\",\"/knowledge-medium/chunks/react-dom-server.edge.production-D0_EQWeP.js\":\"191dcefb0c3a6ba8\",\"/knowledge-medium/chunks/server.browser-CAeDEaAE.js\":\"29c5d248e145c750\",\"/knowledge-medium/chunks/textarea-DEuDaokA.js\":\"df90754ce571e8d4\",\"/knowledge-medium/chunks/ui-DlQV3A4G.js\":\"1950ad608a8390fe\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"d939c4575e1c3411\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"a2fcbe7fb7651f75\",\"/knowledge-medium/src/appUpdate.js\":\"0d6bf992a3c684c5\",\"/knowledge-medium/src/appVersion.js\":\"6bc692e16f365a28\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"a8615cc234f54c7e\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"bdaca38a65de997e\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"fe6e79cf3386de40\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"bd1ca0c32fd7e784\",\"/knowledge-medium/src/components/BlockComponent.js\":\"cd141a5aa76d6e67\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"bb305e23894d36b8\",\"/knowledge-medium/src/components/BlockEditor.js\":\"e508cbc1a995d89d\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"a778b40a67f62670\",\"/knowledge-medium/src/components/BlockProperties.js\":\"bcfcf2d8ece12467\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"012d67a7fb7596b2\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"744c200de88cfc29\",\"/knowledge-medium/src/components/DividerHandle.js\":\"ad14af041f1e1d5e\",\"/knowledge-medium/src/components/DraftEditor.js\":\"8fbb68f301e7602a\",\"/knowledge-medium/src/components/GutterPill.js\":\"f8fcb9ca5ff27a42\",\"/knowledge-medium/src/components/Header.js\":\"b5c35bca9e275433\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"cd495d371ec89550\",\"/knowledge-medium/src/components/Login.js\":\"8a9e6c51e198fa84\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"cced66380d4e305e\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"d3962ed09cc7f00a\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"86b215dab522feae\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"4ee67f9cee93529e\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"3fea1d59630b37cb\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"74e3a72f8b58f789\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"1dd64a057b55d615\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"3924ac008972acac\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"f44771af8bbbc7d5\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"0386cc8a233d3c81\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"b4a216c0f73e6aba\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"29eca91f337281e2\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"50e0846c7e7934fe\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"b4120224107c89a3\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"970c11625f12f1f3\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"44b8990002594d26\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"c2fbb354409be957\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"9c0452d9711c189b\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"94425e20d00977c1\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"a166614100b1dde0\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"7ff5b4fc36fc31b4\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"a3c5cee584114921\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"9c76eac261e4adea\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"e482daf4e992fa6b\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"6422ceb03eed4a58\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"dfa088c58465a1ba\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"299fe17cc6c4a2a0\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"a8895f84014d5fbe\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"07d3092128836e90\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"71625763a60067a2\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"e2cd54b063b76a35\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"5c45f367cb4136fc\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"e206ad20c4178a60\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"6a1393f774723d0a\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"c56d17a904840f79\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"51026519e464e7cf\",\"/knowledge-medium/src/components/renderer/BlockReadText.js\":\"c790480638791d7c\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"a613737c8bb44cf3\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"37f60d8f64d3e22a\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"4dcd118c973bd357\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"0198a054edb525c8\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"8754fc431b2734f2\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"be01004181b8ac05\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"11c147475cbb65b6\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"ceb59aeb38555273\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"832d80bc6c571bb8\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"9234bb1739252270\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"1be4dc01a38f5bb9\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"04bdca7b784aa965\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"04e3ebfa806c7d3a\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"644e14fdd43288f6\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"92df5971cb81f01a\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"edec748a5afcafdb\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"87097075525616bd\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"047d07c2959c63ff\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"d8c589f03621c68e\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"20aa388cfcbe2938\",\"/knowledge-medium/src/components/ui/button.js\":\"99fd8ada96cefdb8\",\"/knowledge-medium/src/components/ui/card.js\":\"4fe88a3d2426cfdc\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"559ae6a39dbb5844\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"fbe6929ae71e69f9\",\"/knowledge-medium/src/components/ui/command.js\":\"c4ff373759015dae\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"eaf382f00c38ef96\",\"/knowledge-medium/src/components/ui/dialog.js\":\"75455198127a0823\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"275f2e411ee4e570\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"0665fc2d95fb9f02\",\"/knowledge-medium/src/components/ui/index.js\":\"5cc96dcb1e82b28b\",\"/knowledge-medium/src/components/ui/input.js\":\"d5e81d93930f3a26\",\"/knowledge-medium/src/components/ui/kbd.js\":\"b8bd322d7864a25e\",\"/knowledge-medium/src/components/ui/label.js\":\"0c8483358a7ffdbd\",\"/knowledge-medium/src/components/ui/textarea.js\":\"9f09e691b7ee04f8\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"22c355e8647a4235\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"17e584d15e413716\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"da66bb37dc19e42b\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"285601d8db2950a1\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"5772fc716aa18245\",\"/knowledge-medium/src/components/util/error.js\":\"1262554804e90739\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"2a41df82852aeb1d\",\"/knowledge-medium/src/components/util/suspense.js\":\"ef1f8b14568d38d5\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"f2118ff2cbf16078\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"e98f9013fc3835a6\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"be5f5103640decbf\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"57385f06431c85a6\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"edd757ab1370e93b\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"d5a3aea166d46069\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"fcdd8b11603d30c6\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"0f86c3d8d5e5ca20\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"6031781bb32eb304\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"825a882ee0eca820\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"92100938a99c8516\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"071c6b306e64afde\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"eff458c41f58ac6f\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"14c4d8172549ee63\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"2f8911520eda3b72\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"a3495bd9a97cd61e\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"3544ef2512faf8ea\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"369b354c41250656\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"98ce33a5c654a538\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"85220fcd45c469e4\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"b961741156f2e776\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"93e0695f4b61aeb5\",\"/knowledge-medium/src/context/block.js\":\"ee828a4bf20a7657\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"36d291f59526e8dd\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"3aee4a1fa022944e\",\"/knowledge-medium/src/context/repo.js\":\"8d0791d0ad74748c\",\"/knowledge-medium/src/data/aliasClaim.js\":\"8b825f9ff153a105\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"35ab300f428e2de1\",\"/knowledge-medium/src/data/api/blockData.js\":\"a9a9f4cc45c67cf5\",\"/knowledge-medium/src/data/api/blockType.js\":\"dea127e6ef074636\",\"/knowledge-medium/src/data/api/changeScope.js\":\"d5b7061b87c21568\",\"/knowledge-medium/src/data/api/codecs.js\":\"0fb34bc9af8f6ac7\",\"/knowledge-medium/src/data/api/derivedData.js\":\"cd2431005db107ac\",\"/knowledge-medium/src/data/api/errors.js\":\"3a0127ccfb9d3d4e\",\"/knowledge-medium/src/data/api/events.js\":\"03b9ffc9439b0612\",\"/knowledge-medium/src/data/api/handle.js\":\"728e0665b7de11d7\",\"/knowledge-medium/src/data/api/index.js\":\"6c8b721c01b55f7a\",\"/knowledge-medium/src/data/api/mutator.js\":\"bc67b436783bf575\",\"/knowledge-medium/src/data/api/processor.js\":\"8058375bd8adcd7e\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"27ca8c4a20a8533f\",\"/knowledge-medium/src/data/api/query.js\":\"0d77b03a7c97ca52\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"b3a38ac208aba05f\",\"/knowledge-medium/src/data/api/schema.js\":\"728e0665b7de11d7\",\"/knowledge-medium/src/data/api/tx.js\":\"728e0665b7de11d7\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"c04b194d810dfac3\",\"/knowledge-medium/src/data/api/user.js\":\"679ecc273fa0a541\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"82c62a84c311fd9e\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"025016fc6601f8e4\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"618f53bbab74dec8\",\"/knowledge-medium/src/data/block.js\":\"0a98833d739bd6d1\",\"/knowledge-medium/src/data/blockCache.js\":\"eeeed4267e57def1\",\"/knowledge-medium/src/data/blockId.js\":\"6a46a7ae65778ca7\",\"/knowledge-medium/src/data/blockLiveness.js\":\"18d91f642fc38c2a\",\"/knowledge-medium/src/data/blockMerge.js\":\"0237cbc453320019\",\"/knowledge-medium/src/data/blockSchema.js\":\"12b802ce64099e2e\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"739ba9c5bd3f92e9\",\"/knowledge-medium/src/data/blockTypes.js\":\"b22c039929a57371\",\"/knowledge-medium/src/data/childrenView.js\":\"c92aba8eab477484\",\"/knowledge-medium/src/data/clientContext.js\":\"f6f0922b4a61d742\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"fb477b90fc4be80c\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"a49fb862b1118824\",\"/knowledge-medium/src/data/derivedIds.js\":\"e97213c2671579d5\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"2ff3db79a6754b89\",\"/knowledge-medium/src/data/facetBridge.js\":\"e44a2b0ae326558d\",\"/knowledge-medium/src/data/facets.js\":\"f0518154af00809d\",\"/knowledge-medium/src/data/globalState.js\":\"4bc0ce03e9892eb4\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"146ccb5f75bc24a1\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"fb26b0766d2bfb95\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"1bfa7063f84a46b9\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"e921bb60af0ed810\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"3ec31a1431241b97\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"d1a625d084633937\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"5fcdde1c2c4b330d\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"9864237f8a3f36c2\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"b18584f930bdaef0\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"ac132b2a7547f070\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"78100f7d16bd0ef6\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"aabfd2887223a4da\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"99a15ca63c452d3e\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"62f67736bfb91c07\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"c67e12ebed0c1b8a\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"5b214321411a4656\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"3a47db46e2cff817\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"3b7fd00800a2bcb4\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"95cbc067e2a694be\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"ef189f8514bd2388\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"02a86474e09b86ba\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"615c78edd2f23d73\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"202c57d9ecbf26bd\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"45d0a9329d4c0926\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"74274657db85dadb\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"6ceff72a71bf573e\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"2f09f39b349822fc\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"be03818c39e42654\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"b55b35fbc345add6\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"502fa3d8e01f3293\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"3a5c8ce3cbeb71d7\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"ea459ba0e8235614\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"874a2e6d80237497\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"ac25c1fb19da442a\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"d774decb437f0848\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"30e37d03f2e7e37a\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"c9697708f2108898\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"dbf9f5a55a50e5c6\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"0e4f9ad2ddbe012f\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"0c82904346b77f46\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"8eb33b493e607ca2\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"63d63e7632de156b\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"93c79dcc67dc247a\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"7c806e24dfa00996\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"685a344440f63396\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"64adb97d22833ac9\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"530ed545949574a0\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"f4bb4673ecec2f2b\",\"/knowledge-medium/src/data/invalidation.js\":\"cde61d0759d25a89\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"a1fc218d355f8116\",\"/knowledge-medium/src/data/kernelPage.js\":\"e0e565895618c004\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"2b5a3de0fe9684df\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"7c85fbb1e02ea315\",\"/knowledge-medium/src/data/localDbStorage.js\":\"9d93675fcb650f7e\",\"/knowledge-medium/src/data/localDbVfs.js\":\"b31f6406af22880c\",\"/knowledge-medium/src/data/localSchema.js\":\"90496d633e52f494\",\"/knowledge-medium/src/data/maintenance.js\":\"888228037ac7d264\",\"/knowledge-medium/src/data/mergeProperties.js\":\"b983b6f06e640157\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"a51bb521cc63a0f1\",\"/knowledge-medium/src/data/migrationsPage.js\":\"17d0c22c9788edd7\",\"/knowledge-medium/src/data/mutators.js\":\"28058d324b33cc93\",\"/knowledge-medium/src/data/orderKey.js\":\"237f62a98e76a346\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"b712a8bc432dc84a\",\"/knowledge-medium/src/data/outlineSurface.js\":\"23be15fc8680386e\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"7a81d2f158c316d6\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"9226002113a4be57\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"2615d04ea2166f1f\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"2f697e325a459ed5\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"7da265cb9b0821c0\",\"/knowledge-medium/src/data/properties.js\":\"b0da6d604217df82\",\"/knowledge-medium/src/data/propertiesPage.js\":\"5d43d03ecb0d4f20\",\"/knowledge-medium/src/data/propertyChildren.js\":\"dfe0671775002a51\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"6ae71123b2ce3a29\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"6c0fad1fd9ada356\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"10825f23e2cc389c\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"89a393f5a0c1328f\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"c99efba9ddb338ae\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"9c54657b2cb58fcf\",\"/knowledge-medium/src/data/propertySeeds.js\":\"1a9ee9b652a4a5c7\",\"/knowledge-medium/src/data/recentsPage.js\":\"c5a1e2ef3b4509ee\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"bb2afeefffc72b33\",\"/knowledge-medium/src/data/referenceBlock.js\":\"22b27eef5dbce72a\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"43c3c47128df566f\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"a2a72d2c9d6ebb6e\",\"/knowledge-medium/src/data/repo.js\":\"e1f85bb483bc0ce5\",\"/knowledge-medium/src/data/repoProvider.js\":\"8a17a3ec5921d90a\",\"/knowledge-medium/src/data/rowProperty.js\":\"22664790edf48b2f\",\"/knowledge-medium/src/data/searchFilter.js\":\"539f935021c18143\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"15f67e41b18c0330\",\"/knowledge-medium/src/data/stateBlocks.js\":\"909c870cd42ee227\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"ac152ee6670ec2a9\",\"/knowledge-medium/src/data/structuralInsert.js\":\"52b1dbc07b993766\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"fd5c237da42b406a\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"ca3b7309c12c4de0\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"cd2fd4b048932994\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"5d6205b98d7014e6\",\"/knowledge-medium/src/data/targets.js\":\"c989a2f672db5f81\",\"/knowledge-medium/src/data/typeColors.js\":\"9e22bf2d6fbd3e40\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"370cb7a5c304d132\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"589f260cde4f024e\",\"/knowledge-medium/src/data/typeExtraction.js\":\"d6ea4157bdfbe72e\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"b65120f1e34ab3ad\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"167c4fc73890f479\",\"/knowledge-medium/src/data/typeSeeds.js\":\"e2e7a81be83052f5\",\"/knowledge-medium/src/data/typeTagger.js\":\"f9bc048bb909dc15\",\"/knowledge-medium/src/data/typedRecords.js\":\"31ea337547a70c43\",\"/knowledge-medium/src/data/typesPage.js\":\"cbb1b325388b2d37\",\"/knowledge-medium/src/data/userPrefs.js\":\"af1e5e9f25ff2f85\",\"/knowledge-medium/src/data/userSchemasService.js\":\"d764a1d859f66786\",\"/knowledge-medium/src/data/userTypesService.js\":\"b61be6b01834cbf8\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"5e7eac979e30fa4d\",\"/knowledge-medium/src/data/visibleChildren.js\":\"8334bf3e36480e08\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"dae0a6930cfbdb1b\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"fdaef621cb7e4f83\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"b00f0b3bd04f3683\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"6ed3a8573c2ce6fb\",\"/knowledge-medium/src/data/workspaces.js\":\"789c6d618dc61250\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"75042dccf156ed9d\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"426c305889915061\",\"/knowledge-medium/src/editor/atTrigger.js\":\"30f1e98276b29a0e\",\"/knowledge-medium/src/editor/autocomplete.js\":\"068b34fe3128989e\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"670ec32470659fd8\",\"/knowledge-medium/src/editor/contentFlush.js\":\"45e62835b4442999\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"fde24112c9653310\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"faa22adb45841db1\",\"/knowledge-medium/src/editor/insertImage.js\":\"2ceb031d7d9b1159\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"0ce717b1d8059fa1\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"caf9f74fc4311d63\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"429549aa67def62f\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"d0bae0fd15967dd3\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"cc7fdf2e780d4a32\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"63568872df0fc134\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"8e2ad7c2ae9f22ff\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"6bf273f487f6eed9\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"ecae6a47d48280f1\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"d65f9ada48e10f68\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"ed6fa34d1a743066\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"ce847c7814309dc2\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"24dc3f2305c2cb9a\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"c91e2028194233d6\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"3f71a04dede4a7cc\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"e8c92016a05fc751\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"a64206c4ab59a62d\",\"/knowledge-medium/src/extensions/core.js\":\"263944a65c26e3c4\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"f79d92a28d94283a\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"42e4486dbb0ff56b\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"b2b1198c5ab6ce65\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"267bc1a08573e678\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"8887c9aaa28fb9f0\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"1986c7fbdfbf46c7\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"cde6672251a09984\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"ada18ab5dd28d8a6\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"9478e40b823e1109\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"cfca042837989801\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"e35202e8bcd7b710\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"54e96de00daaf61b\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"9f8e329e01ea510b\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"e1434dbfc0c477a7\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"70832920a9cc9b34\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"6a07d9cd00cd9831\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"5f84104b7db186ea\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"ac799f07d65eb431\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"0aab5245aa98a8c8\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"fbda19b1541ad1bb\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"a336c74eed15a980\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"a63aaf39a4b49860\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"01d68670a73e6991\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"c162dc95e5ce37e8\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"47ed30f702d19881\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"027fd99d1fa0a4a8\",\"/knowledge-medium/src/facets/facet.js\":\"8205eb0a4f8c0741\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"532c3ca6ff3e1c06\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"9fed348d4afee150\",\"/knowledge-medium/src/facets/togglable.js\":\"5f18c91b72b6daa9\",\"/knowledge-medium/src/facets/variantFacet.js\":\"3f7a63bb3329555e\",\"/knowledge-medium/src/facets/verbFacet.js\":\"c14624c28b4dad06\",\"/knowledge-medium/src/hooks/block.js\":\"457ab007473c903f\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"ed4b6a5f54e7d931\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"bb73db2392e3aa1d\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"ef5d3f3c6e6410de\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"50a1d82d6df379a9\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"9047158f0f3c6621\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"af343e98aae2c652\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"cd7514df026746c7\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"c66cf9ac62b56c7a\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"8523e19489194c16\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"dc141d217c9b7419\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"7ae062e95d9972db\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"c7d58ba330d1b828\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"3fbac7ff8decd717\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"a6a9b2be40273dd7\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"3c98f3920a4c974f\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"8aca889e43fd8ec0\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"a2fb96dfa6acced7\",\"/knowledge-medium/src/lib/utils.js\":\"349d0afada24bc8a\",\"/knowledge-medium/src/main.js\":\"6b848c047219c453\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"93424afd0d24aa10\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"c61857f9fe706b66\",\"/knowledge-medium/src/markdown/context.js\":\"e654c7a2646cea12\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"b98869b54413edfb\",\"/knowledge-medium/src/markdown/extensions.js\":\"ebb0207f54f53016\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"c0b9e967a9ef7fe7\",\"/knowledge-medium/src/minimal-editor.js\":\"42e24ddd5c800c56\",\"/knowledge-medium/src/paste/armedCut.js\":\"2c9a81169095b192\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"cc2d20ffa9b45f13\",\"/knowledge-medium/src/paste/clipboard.js\":\"42c2a82a1656d371\",\"/knowledge-medium/src/paste/decision.js\":\"6fd9930b116ed2bb\",\"/knowledge-medium/src/paste/operations.js\":\"88f90de0899e5991\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"e5bd61f9154f2b1a\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"d660ac3012ca71d0\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"0ef3c1554d9a3b41\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"175213d329fa9e6b\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"90a836176c1d2d7b\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"370ea89657187482\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"bd902af069626ca0\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"7b9594a56fe7ef0e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"bd757a0e3e2a18ab\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"67f7ee33921c8c55\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"08576201998f66c3\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"ef7a3938eaad249c\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"829969cf9773d1ce\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"ee9e56c29bf55918\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"d0480a46d8c8d68a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"576699a285762769\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"5df01384fb14534d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"f4dc0b5b155ccdf7\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"c940c3c8292a0d9d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"1f5555a791f4a719\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"fc7985daf1421c8c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"0eedafc3fd8a1579\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"13b829e8daf37b53\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"ac4d4b961ac749da\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"f10c2295bd53f5ce\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"376316b57f8f34ac\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"533143699aeaee27\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"1b4946c784b826ff\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"715a522777a1ccc1\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"0d2741eab6a515bf\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"da017ea1f406dcf8\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"3398063860e21534\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"56c5677c4e08c860\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"60840dafdeaecc52\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"f6560ca8dd966e73\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"e9d634f91e59e224\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"19401835eaa54316\",\"/knowledge-medium/src/plugins/agent-runtime/dayPropertyInputs.js\":\"7eb6b00a9623b3a8\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"5739e6e83c1a7fd1\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"74345d54408fd04e\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"d491d503c313b88e\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"c0e6c5a7e76b7860\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"a3dee426f7a4d069\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"14c0c2bad46de3c9\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"02eb836178704107\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"5d88eb8a03c89665\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"571de3b944034760\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"0f08c33844db31df\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"205455bd2ef9f99c\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"f86249de6d63c522\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"ea01875da228a26d\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"0f18ca13e91c71ce\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"2dc278d0dd58b52a\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"f386127d89018bd9\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"1778feb0b29c05c6\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"fb6501943c6821f3\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"1e2e2092d8d058ff\",\"/knowledge-medium/src/plugins/alias/index.js\":\"be0603c5761860a8\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"c66fe44160108081\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"4cbf29189ebe0986\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"a69e16f82e53e494\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"3da3020735103ef9\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"3861e69aed228266\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"8dec940b1baa5919\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"1f41ed315f96b229\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"e64d8dedb969ce7c\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"1f0d8ec6b7d9531c\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"bba0fdc00d902d8e\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"48d2ded720e7adec\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"e9ef76154c08236f\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"7178e31fc8be01c2\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"d5b67dfddfb79139\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"7d4a6cef3da44df0\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"aa2c59b382056e45\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"edf9df445c4dc5e9\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"a5988bc49952a1f2\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"0b55f6609c43ae4d\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"fb7ed541cfb68371\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"f212be3fc6c5d0f9\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"0d30c8dedfe11ad0\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"a14b0be21a64ea0c\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"2f9ba85d86e2bc70\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"5f723ffe5f7b432e\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"da3096ac6ac5812c\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"5271f49bd82ebf80\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"9204844e33e80941\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"a91ba9d8e0f4cf81\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"d03b89c7c39d096e\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"125157bb69e5613e\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"160650914fbe3d25\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"da42ad10e6bb14b8\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"1b483d3297711e73\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"2ce1e839039bdc49\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"36f68264d0a9d2e4\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"16fa0e5f4ef87ba4\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"1c9ea79be7ae4b92\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"a1631242e3fcf7b5\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"ccf693777100cd2c\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"3a2707a6f739738c\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"804b25fcf32e5abc\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"0778702c063caf38\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"3dfddebb3eb00b83\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"0681690f40abd8ce\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"0f9f4c867b706fbb\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"5564126b665477ae\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"5e7e7520a54326c8\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"2aed512f83a9e69c\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"64e7746364e25f71\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"32dc0302d5e15696\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"8b53a9c73e0d4cbe\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"16fa673f78583161\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"33b7107eeedaa0e2\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"d5b4631767039ae6\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"68470195f5d97b10\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"b6ad2993cd05a4ee\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"eaad1c478b51f9aa\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"ea39b543730145a6\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"cc3ee2fec46677c7\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"651c156652874aba\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"a91f0fb0a3050c5f\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"022f4d97542d1177\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"34f69e45447084b9\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"8d3dd5d33f7264f1\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"623ad10bf73e7c6d\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"ac56b711444a2e56\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"2500ee5ec310cc79\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"4bef4821b22af164\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"151451f33e0c1fa2\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"639b2555aca43fd1\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"dc4bc57024664140\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"b0fe31095ff877d7\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"8c3902640af0b6be\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"a18c28143689c47c\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"da9e3982f0d7a5b9\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"eb27589836bef28f\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"22445a65a31d161a\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"e67a5392aee07de1\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"e2506d2fdf67af38\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"c770180c61f36dc4\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"baf64747f551adc9\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"e1188d746da95978\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"3f501d2930640e35\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"fbfa6025f1e243a8\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"d2cf660098b4fe5a\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"a4eeba79c8272281\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"5ceb4048b601eab0\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"4d6875b554146f3e\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"0e1262e1a32366ac\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"2801b247884a2f94\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"e55d1b06217cda93\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"56da6c6682c31b97\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"7774299eee7fc7fd\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"c51ef4abe381416f\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"6eec003e3d24ffab\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"c14229c13bf3857b\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"ee8f3c4820357c43\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"185b4c9dc264e088\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"b7b45f91d60f87dc\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"bcc8126b13b8c1ff\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"7415fa32d31dbc48\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"d9462059aba5a7fa\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"95aa71ad75f9fbb8\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"44af8d0963bc2e15\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"5fe6f3ef9e6d3623\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"da68db735a5902dd\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"75d1011c656c44ba\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"e5c1bece71cf2d41\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"04ebf0eba75cd78b\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"e42ec6d99e8c4004\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"93cf54e5b4e63d46\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"e90849e043212c7d\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"7acd0923fe57f7af\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"f10a24c288848f27\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"a17271046eb7841f\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"a75eb916b6ccf129\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"12852b5a1d62a6ed\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"a6358b450fbe4af4\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"676116efb1457e27\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"da400bc8de0428ee\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"e6c176b3a7cb00c7\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"85bac87b47d79719\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"f29b091b986c9d79\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"a118be37aca59cac\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"9a2b845424d14163\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"aca42ba429a9c775\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"8ba72e39e4aed6ca\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"91d58c119480d812\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"95743131e2197570\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"f8f0f4db72052214\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"f1d1a9751f4e2e33\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"29b571117a0854ce\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"87bdd6d93ec0a629\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"69007228295d640f\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"2d5cd34a31bb2721\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"14dd56df92dea679\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"bae779cd8debeba3\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"058c25df398d41e1\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"5ee353e99c16815b\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"5682666e3246db33\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"c0f827357d3a8cac\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"6b4683c6ce115ff8\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"14379c13fa8d780e\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"d83d7faa114f8d84\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"6f757e841ca5547e\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"f9557137a94104c4\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"26a62ab6261a93e3\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"0f1e0f333c7f5ec9\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"51a4cd29431f7651\",\"/knowledge-medium/src/plugins/character-counter/subtree.js\":\"e2ec8d1fd3bd9fe6\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"7fa33829cfd12fb5\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"a701d11e4d22547c\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"71ab42a58976272e\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"9fa33ff8400545f8\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"24f88e073096ce08\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"d2ab04cd21dba8a8\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"7b384ec44a110f5c\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"a43bca6368784a80\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"a2087721df084544\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"7e531056a4f12063\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"d2f15b438ac37ab8\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"778f3c7f40fe18d2\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"2a76bee643076e72\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"21188f9fb7ff3b70\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"ad20362648c6f352\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"e9459827f9809f7c\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"a49fd629b37f3536\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"d46c2ea5a3f28473\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"45acd41834ea53e4\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"06f4c4f2fda1fc4e\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"c0ab54a1878a49f9\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"2703c2c17ba09a71\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"66c6a951e26e2c33\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"2ee69984d937fa4a\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"47669fa03a325eaa\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"4d7ea5d87cffe1a1\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"4701092f9c7e7f88\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"ca0e941deb1918bb\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"3b7aad704eb69ffa\",\"/knowledge-medium/src/plugins/daily-notes/DayPropertyEditor.js\":\"0d184f557fc5c253\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"ea0c589399b5764f\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"f06dacbfabd12906\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"51606d193493f061\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"d8c8fa0675b3d8bb\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"11a20d0c6fd8ed4a\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"8aa377e2d4da6cec\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"2942b52a77dd170d\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"f7c0fce5980e1873\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"8427b6007082ee76\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"4215697a3f8ffff0\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"c8653581a815a4e0\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"22344ef510bf530c\",\"/knowledge-medium/src/plugins/daily-notes/dayProperty.js\":\"984808548a9291e9\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"1add58cc6df5cfde\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"98b5ee07f46f9b68\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"f3f62e89a7a16d83\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"219a092719279bb4\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"2a7698a280aaa9e7\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"067e32ec90aa4580\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"003a3e7733b2d33b\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"c4ce3db6a720ddcd\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"25c18685efd58273\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"2a8e268ed4bfb9e6\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"6f69f3e903821546\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"25f99a366565b4d9\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"9e2704c61b711e33\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"9f3282e6f1cb37b2\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"40de191d67eb473e\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"4414a482d9225445\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"10f76a742e6ae1d4\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"089ffc82575821e8\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"9a1f96fac2d3af07\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"9a2e55cef5ec9964\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"cb3546db23e88d0b\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"8c961cdc8ef69194\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"8814ddedd2044349\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"edb6783ad7dc8e1d\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"527a4fcef2bf7718\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"25314d24e1a6a099\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"2c53597efc3ffbd6\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"f92788b72c140294\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"1eb90378094e89c2\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"9436146339d85b5c\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"528befff9f3f65bf\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"6d2e829b9e4c1539\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"ca7ac4a965dc6bd5\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"5d20e48bbe47187d\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"4fb84abd789dd5bf\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"cbddd26ede011d22\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"ae435742ebf52c00\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"64ddcad9a20bfa1c\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"a01443b670023f02\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"d83b1eb710a39841\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"1775de8115eef10c\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"16a5e7c4ecbe9b19\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"6b29b83ea3485237\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"cc73d6a563760ba8\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"29d8046b885d0fda\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"a3e527f4748768e9\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"2002623430e48d85\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"9fae89ebfe8ae881\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"ecbb6f1f9d3b7ce3\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"02b9122abfc7c7d4\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"4b52ae22c36a6614\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"596a7880be709669\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"65d39480a85b14ea\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"376386a9663f60df\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"7322b1c55e2b2360\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"3f539d953e4af8c1\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"7556beb3d4f90a12\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"d0bbc66f8d79c675\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"402837a89a7a881c\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"1d284f28a1c7861a\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"be4c692979c15a4d\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"0d46e47054d4c106\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"498f03b62afc2996\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"abf47b4969e0fe09\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"382cf5fcf710d42b\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"d806b67355a9b067\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"412c0613c1135ee0\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"50fb98dfa4f11fb6\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"604504765640f51b\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"377327813cf7facc\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"60241507fe6c1810\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"9d5e9e0bae164eec\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"3176ca6ccc4fc177\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"46ba64d194224f7c\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"4eab0b85d8e9e7a9\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"84caddd8eb2351bc\",\"/knowledge-medium/src/plugins/geo/index.js\":\"763de8a5b7d30c0d\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"e3b5cf01a68f7efd\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"386b77cc84e9bbf6\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"66c3857b52577219\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"ff0cc64cd6c41cb8\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"80be1dd3c8515108\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"790edfa3c193bc32\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"3b68ea65b49d4bc8\",\"/knowledge-medium/src/plugins/geo/query.js\":\"0a068cea95556385\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"dc02701fb18a28fd\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"55757aea34460d47\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"0ffa277b8459d4cd\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"7d393784fe24e643\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"2b21539c6274924e\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"e7e41f603bcb1b25\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"0a1d6c93203e7950\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"6ae379a135c6e107\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"f50da84a9cb29261\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"f943e96807f296d2\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"f57e4910958abe61\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"68386d59f878fe09\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"a7835ca80b89b52a\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"be161e1a399dd3cf\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"6f7c781f905df03c\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"c608157d07240694\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"adbfc376d0b4a1a2\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"f750fc220092546f\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"f1dda142cbfb3ba9\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"ce49b5093b9d9cb7\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"60002fe1e8c07444\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"612d3f2756259382\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"990036d9f9ea0136\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"7704ed13a3593132\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"1c2b40189545b7a3\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"ec2864b7689a0a0c\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"927bf8b9167e3d8c\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"f20475fcc16f8ce7\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"e1095b4b7b182f34\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"4a536d4b1e7c4ba2\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"90902b6f3111fde2\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"2e76e56bbdbad290\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"e7dbb0c173c52e98\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"949f255e88d48fae\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"0a4498964abd712b\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"eedbe1da4b748c2a\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"09529524b5cd49b6\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"91f89d5bad4c3ff6\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"f2220849e2675570\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"d4c32fbae6488764\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"4b46910b1c770baa\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"630c0264a9f575b3\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"0c01c3e9c7f950c3\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"31803c3d5e431545\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"d82fc1499266d9d3\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"1a4d30a9595bc560\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"ba38e391fbe9a8e3\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"95280bd59afca6e1\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"d851ddd1e0f9e527\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"e8835c6f75358e67\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"86981a752f3ef962\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"21e018d9aab4b8c5\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"221c27ee6e1a3fce\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"7781b9825e48caed\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"ba716bc48b87c868\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"cdbb7e4deed43008\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"3f9eef8ff354f846\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"a2b3e5525185ecd1\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"bb2888c965826f76\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"1294609ba9c841f2\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"756248213ecdb74f\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"6e31ab7a01ccfd76\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"d049aec30c8ea483\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"4715b50260322bbd\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"2b33e1a20b24ae66\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"bca638ea7a054df5\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"9389319bfb3a1460\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"f165c8b6238504c1\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"f6aeb00dd533aed8\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"bf3bf29b28ff3d21\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"20837176c48ebddb\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"4cb3dd8154823277\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"c61b5bb053dfc934\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"9f5d0ebd4156d31c\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"07cabac086a8a353\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"a6a728478ae808b2\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"cf61a760ef7aa121\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"9d5edf194a9bdb43\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"d5690c856d173ef0\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"44802b1e991e3a93\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"b0c528af0653529e\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"bc0906dd02d4bb28\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"dc50aa0a18e82fdc\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"d731238cf6dae869\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"1d1511c874f833f8\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"ee5add2859e7fcea\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"32bfe03150f2ecf3\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"f8fbac6108cc6bb9\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"f0dc48d2be333e35\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"dd40b8fa0d9f8bd4\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"d7143ca837677056\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"b18998fb3dcd4f9c\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"c2d7d9295e1233d0\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"89c75661fef7b56b\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"fee05b9843d4364b\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"c8076cd3acee12ff\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"770e2680f372129f\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"12ec9597d4b313aa\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"0f54433fbde55756\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"6f1a407b776f5293\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"1bc2361b85709751\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"e25b07781957dfbd\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"09b3e425398b503a\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"3665204296d07e69\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"e959d5baaafcc7bc\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"273bfff4c7558c31\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"87fc4b199dd5b222\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"a3650ffd7ecdad49\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"78b5a967dcaa5d24\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"630824c267d44532\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"4ac50ea98f940c13\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"e559df61f565dfee\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"377d28c1ccc1febc\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"8121486f62e9d426\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"524a338419fb0215\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"fb3c03e2d1a1a2da\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"309b154d2741e26a\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"6dbb66c4413c4a41\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"241f4621666b8593\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"7ae2e5b4ca4c2a3d\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"07e30dfaedc2df28\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"74e5dac051ffb3d2\",\"/knowledge-medium/src/plugins/recents/index.js\":\"6ffddef41273e23a\",\"/knowledge-medium/src/plugins/recents/target.js\":\"bb85b87b22a84fc5\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"8f2dce02b8e81ab6\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"03c8b5f56b0a4f4d\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"383b7a2599913fd9\",\"/knowledge-medium/src/plugins/references/index.js\":\"0a47d81aaa544dd9\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"3db9ad4ad94c871e\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"fb97e63d5ce455c0\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"eb274b7cc0c5a9d4\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"405dafbcb6a63cbb\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"e72e87bd3f729db2\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"e49c15f8fe5edfc1\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"c9a0d45834a3d800\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"4f3837b201a7afd3\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"753f2d94ff05e586\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"35036c29f79979b2\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"f1cb2e4704499d8d\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"ca161e4873cf2721\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"07452dabcdb80bf4\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"b18d352b1e0766cf\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"c79c8c697bb49acd\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"9dcb4e783aa6b775\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"eda12a207f7e6f39\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"38016d93d7a29db0\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"81b3571205403570\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"f25ff0b849c729f2\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"3b9d33e976ecc8e8\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"08f22f9f60ab1768\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"faa2ffe0abf85d85\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"7e9492322a60dc5c\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"4d726021f86263a7\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"ba2443d41487f5c4\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"ff2960e56c59f631\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"c4b9f547e379f24a\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"51beccf8b5a26a76\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"c3de30275c2dcb7b\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"4b3fc3555c5668fb\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"085d61917e9441fc\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"484e3b7d8acd6023\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"002a00a37653a90f\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"88132fbbb6ac8381\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"55eca1fee7665818\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"fe73a8a94d49b08f\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"02cdb8f322a29843\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"1da5a3c564e18d27\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"ed4db6dfe3953d60\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"48ca413f48517019\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"817a1151615e697a\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"593f36ece03ac667\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"b5e501f9944c33e3\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"28179c0c599b7367\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"218521eb658baf6e\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"361c5f8c8d2cd0d8\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"c1ae617d23a0ea32\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"de1f6ffae4d72cd8\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"4be4828de6fa807d\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"88fed4230bbc034a\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"8eeaa49b36073e39\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"c458fcf59db84c47\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"0196b3e5ec2df7fc\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"bdb9687e21b34315\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"d9f1d72e389f4eee\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"64494f2dbe7a22b2\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"9fa70de4f8fd0d00\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"38d823582feabfd5\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"ba846858daa56f84\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"5b9121bfb43f0bab\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"15ecf8f43da66ece\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"405dc2b738071200\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"e502c18b76d7a501\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"3c2125b5a3d5de88\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"9bfc349544ce819d\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"6fce3f918b278823\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"bbec588eef0dfc2e\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"f79eed58ab3eb8fd\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"4f6680ea5c2de3fe\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"2a761f2ec20ca8f4\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"620da28cba0c873f\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"c022cd0806d56272\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"f628d2b3919fa66d\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"d3f7dc32ac3df940\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"d6f31cde589a7ef6\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"4d190701ea33acfc\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"356947037ada1d77\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"a8b8935af3345ce0\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"05776cc045015037\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"de43bc68b31aa40b\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"fdae68caf4a074eb\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"eef8e92c98133472\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"c5483ffb2296c76f\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"312da35198eb9d57\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"013cc8a117e374b8\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"899bcfccf52bc8fe\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"cf199780aaaefbb0\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"df23b13bb49d2134\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"f8c35fb9d0baadbe\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"ae17be7fb48c055a\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"b98cd1234daf192f\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"c8068e5f7506673d\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"276de0a22fad1123\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"a3596f4576f970de\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"08c0e76cc0d3d6e0\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"ce0fa7928eed5ac0\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"b99594d4fa3d6511\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"6241d39548b5a310\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"1eb61e31a021948d\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"a50c02386aee6786\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"0f5921a2e4737296\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"afb3450ccf556a96\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"74147876ccb8dae3\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"4739dd78aef249c4\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"2cee8b74705d8cd2\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"210c9803ac36e6f1\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"a1c555002ac817d2\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"62e6f43ae5881b4f\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"3d9eae2eeffa5ab4\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"de278eab542d3e8d\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"23b11baf6bcf6e08\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"2cb4e6630643562d\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"c0bd8b996ae85690\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"c4cbf16ada8e8060\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"c03e2bf238f57801\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"1345568d45b0aceb\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"3e4fb18f7ef391dd\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"2bb368c7836300b7\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"c70fd003badfe525\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"a80fdbf41aaa850a\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"1e186f82538e0ccf\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"e19424a14b8000cd\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"5ab3ef3dc6cb910f\",\"/knowledge-medium/src/plugins/tables/index.js\":\"34977d66139c807b\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"60edaef8bb8ef819\",\"/knowledge-medium/src/plugins/tables/model.js\":\"5dd70b779ebdfb3f\",\"/knowledge-medium/src/plugins/tables/query/QueryText.js\":\"9930992c58620e04\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"544f1a1696a50230\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"c416cf4e8dacff34\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"667cd89a41910f1c\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"da1258d6afd5f99e\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"9e0bea536e870673\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"4b10030b91b811dd\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"95c381f362093b04\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"ddf8b7422790477e\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"30cb91c2501c4d37\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"2b0ace1e6639027e\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"ab9d6e7db27895fb\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"a9b4b2b2420997d0\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"e516aa56938919ce\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"4fcbc414d5538ffd\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"974ccef2226acc71\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"6ad714aeb702cd61\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"9c03374366daca3a\",\"/knowledge-medium/src/plugins/todo/index.js\":\"998cdc0214b6a35b\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"32e53dba474047d9\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"8345322a80301e8d\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"9be21872af9b8a4d\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"734226bee03d5b4d\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"0e8ea1834fff1d50\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"654d863e6decedab\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"96a0c4ef693ce06c\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"f7e8bb0dd9116f6e\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"207a8f2aedded9c5\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"42b2c138e0a57550\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"86e46b3201697f3d\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"17da1d831188d8c3\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"7f3632cef14cf901\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"31db55b04fa6b0a2\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"67addeb3ddf0691a\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"13284c3e3dd9fe1a\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"110d210ea4858777\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"8595a14e814bb359\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"24e620f8610383e8\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"ead0c9818f2e30bb\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"61db9ad6a8a531a9\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"9021259cb626a79b\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"742d6d7ea1cd3d6c\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"69580be1b0a9bd1c\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"b8a5689bb4fb41f1\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"c8e1d6fb22d2f7b4\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"e4994756495f08b7\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"552a7e92ccfb6d49\",\"/knowledge-medium/src/registerServiceWorker.js\":\"0582b4033614ee7a\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"6f7ff3c9f1828a3b\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"ee1ec46a200a6343\",\"/knowledge-medium/src/services/authStorage.js\":\"739c5a70eac0062b\",\"/knowledge-medium/src/services/powersync.js\":\"18c2c6bc32eb840f\",\"/knowledge-medium/src/services/supabase.js\":\"14d6ca482874c55a\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"8945c8f02dceca2f\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"e042d1f7fdd370da\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"055ad8530734ce09\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"8e8e73ac9159d93b\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"03d6f922fbc323a8\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"0d665fa359fe9642\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"2d7b2521c996b180\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"1f8ddd388dfda40b\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"6f5b4f9c73718961\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"6b0ab2cea03ffe69\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"3dcb1b0361ed10ff\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"802f48f973cab1ba\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"6beb340ca55dcd31\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"76591d1afa902338\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"a44dee2273c81ad2\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"c76af409d9dd0cb8\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"39515b428c089010\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"b6928a332f7eb875\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"d58afdec5a646719\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"043eef4aa8738ce2\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"5ad56ccf6b46606f\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"2c6346b7f0740151\",\"/knowledge-medium/src/shortcuts/types.js\":\"660e0851ef22b091\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"50aee1d10b2a93b7\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"1be522f5bb4f01a8\",\"/knowledge-medium/src/shortcuts/utils.js\":\"bb569aedf747ab6f\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"47b52ac169cff0c5\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"0944eec8669044f8\",\"/knowledge-medium/src/sync/byteTransform.js\":\"a4af82b464218787\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"07e48541a4032a94\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"49c2b7cb1a9d6c8e\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"d5b8ad728dafd12d\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"cb8b9f51929248f4\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"fcd3d73eb545991b\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"6b2541570f3aa5a8\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"a29815fff8f42295\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"55337c3cadc35090\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"30f930347c22803e\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"854ba3f5baf20d6f\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"1eee0e1e6f93b81e\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"436ca4c3d837c9d1\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"7fd91da674b2d1a9\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"0e0d7ead2c54c2e1\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"16493aeefbb7f3d0\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"5d01d195dc425dae\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"d42c4db8c1a7e73c\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"681c8bf0b3b6a234\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"e27b17e64e83a49c\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"514e10a15ca76753\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"a0888c99fe4b6cb9\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"2a8c71ca0c83895e\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"24b7a7a8f56df532\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"39a4c82ac9ec07fd\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"31141b0bfdf876e5\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"c3ef3d711491897b\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"cd6bfc5c209d2930\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"db981820edd36e8b\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"eaa515464b3c3d19\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"033955b65ad5e38e\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"b7fbee998b8c47fd\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"0c9bf4a08bc32788\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"430a6439ec7b94af\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"6e4237076b0c846e\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"d3fbdda46c6f05bf\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"1dd1df1b164d236c\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"fcee7047f4277b29\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"a88881f39f0ff2b8\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"9050130b9dfaa10c\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"013de414972c1578\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"0a22b6f86ef9c067\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"33dabe9583bfa629\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"690d19548aa9e952\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"698bbdae03b3562c\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"08e455f1fd7f8173\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"a15a65380e75686b\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"944000e5f87e91ae\",\"/knowledge-medium/src/sync/transform.js\":\"1cada4be30d331b0\",\"/knowledge-medium/src/themeBootDefaults.js\":\"39efa6fad677c4d2\",\"/knowledge-medium/src/types.js\":\"fd45370b2e045ca1\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"9a8548cfc8f0712c\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"d76d55d6ac93adba\",\"/knowledge-medium/src/utils/array.js\":\"2099ebcc75df88bb\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"c851f0503d0eb941\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"39f510bc984d9ac1\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"c8af791c41cb3120\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"d7a044845964607b\",\"/knowledge-medium/src/utils/callbackSet.js\":\"8216c5392a2caff3\",\"/knowledge-medium/src/utils/clientId.js\":\"6772f55a5911e048\",\"/knowledge-medium/src/utils/codemirror.js\":\"c6b68f85a31bf746\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"c617c6c716fd48a6\",\"/knowledge-medium/src/utils/copy.js\":\"13df53c9ef4c9356\",\"/knowledge-medium/src/utils/dailyPage.js\":\"11a8f2f88d4d7d48\",\"/knowledge-medium/src/utils/dbForensics.js\":\"0ac2add2db9f8b9d\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"0bb3b509759112c9\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"b0134aa92d1c59c3\",\"/knowledge-medium/src/utils/dialogs.js\":\"0f4ed36f393cbe8d\",\"/knowledge-medium/src/utils/dom.js\":\"03948d32c2ed7849\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"bcbe4bfbb0325cda\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"7848209d483d2bd7\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"5f2522ed4204e02a\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"6daaf1bc3eda1d0a\",\"/knowledge-medium/src/utils/flipSlide.js\":\"324a93421619f6f1\",\"/knowledge-medium/src/utils/fnv1a.js\":\"4539d00c22d5b9b3\",\"/knowledge-medium/src/utils/formatBytes.js\":\"7002452a686f6c5b\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"6e3f823bbdd00ffd\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"e1216795b87fe501\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"48208ac48bd270a9\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"956ffcbb7c5682a2\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"5e09f1a5460e9406\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"700888de0dbac4d3\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"6b7321f2389b3966\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"07cd0dac67349468\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"59b0bb63838f041f\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"4563684d57909d0e\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"2760b3ec640c1c6e\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"dcfc540732a83541\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"5530308165485845\",\"/knowledge-medium/src/utils/markdownParser.js\":\"fe7dade3f2ac6a26\",\"/knowledge-medium/src/utils/memoize.js\":\"d4f7e68ac20c614a\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"c26f4cf8ed985c55\",\"/knowledge-medium/src/utils/nameList.js\":\"ff92fea5475dd053\",\"/knowledge-medium/src/utils/navigation.js\":\"1054735abd4888af\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"fcd09ecae3226b00\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"a0730a19380c3f6e\",\"/knowledge-medium/src/utils/panelClearance.js\":\"1dcba85c3549f08b\",\"/knowledge-medium/src/utils/panelHistory.js\":\"4f073e7cdca14ce6\",\"/knowledge-medium/src/utils/panelLanes.js\":\"3009f896e5ffe060\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"de720ef1db49c969\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"8af20a88f8848eff\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"74629bfb1eeed54f\",\"/knowledge-medium/src/utils/platform.js\":\"0e044b349032a001\",\"/knowledge-medium/src/utils/pluralize.js\":\"181359298b63c77e\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"fe61a057620072b5\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"ae4e351990da4c13\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"650b12cf4a403fa3\",\"/knowledge-medium/src/utils/react.js\":\"05a1f66c9ea11f99\",\"/knowledge-medium/src/utils/relativeDate.js\":\"24ce035a4f2e6694\",\"/knowledge-medium/src/utils/relativeTime.js\":\"ebd9a5267a69b15d\",\"/knowledge-medium/src/utils/renderScope.js\":\"b25a1e4c60a3f021\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"053b24e7bd190123\",\"/knowledge-medium/src/utils/routing.js\":\"1acd7d77b80e388f\",\"/knowledge-medium/src/utils/safeMode.js\":\"c1d40bc2c62c6bcb\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"31d1a42ea6c78fd9\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"df4bca89abd5a84f\",\"/knowledge-medium/src/utils/selection.js\":\"8e7d21938fa866d5\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"00bd2629b8564a77\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"7bd94f9a236cf572\",\"/knowledge-medium/src/utils/state.js\":\"a433fd019ecc84f4\",\"/knowledge-medium/src/utils/string.js\":\"1c1ea8ba1511ba7e\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"2f479a13d7de0f06\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"e52fbbc1d46b1921\",\"/knowledge-medium/src/utils/toast.js\":\"a8c70990b94e1f55\",\"/knowledge-medium/src/utils/toggleStore.js\":\"66a147195abe7a41\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"d2a93fba4a8e2ca4\",\"/knowledge-medium/src/utils/userActivity.js\":\"7d4b78088b4413c9\",\"/knowledge-medium/src/utils/viewTransition.js\":\"40118ca14a813200\",\"/knowledge-medium/src/utils/viewport.js\":\"8fe66485d8189f40\",\"/knowledge-medium/src/utils/webLock.js\":\"c7ec29354cfab3c9\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"0accbb6313784e25\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"bf1be1427d2d7934\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"247c305217312685\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"6e7ddc53ba2ad17e\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"c7ba99df8f3b93c7\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"99567cc4f7a5c073\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"824c1d925b2d2a39\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"dfbcb711b1f5e5a5\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"37e30754608bafc6\",\"/knowledge-medium/src/vendor/react-dom.js\":\"300850c9ff314c90\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"435e7ca988b85144\",\"/knowledge-medium/src/vendor/react.js\":\"2fa07d93cdd26bd3\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
