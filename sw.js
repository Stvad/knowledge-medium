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
		buildId: "c70a5a878da3-e87ac0a1",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"b9e6dd88a18ac204\",\"/knowledge-medium/index.html\":\"b9e6dd88a18ac204\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-CEA5wUg6.js\":\"f3f7924045e1638f\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"8ebd8f6824a192db\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-BBf1w4qb.js\":\"be384211db335d93\",\"/knowledge-medium/chunks/FacadeVFS-CK_A62Ss.js\":\"2316a55312d30595\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-BeamwnlM.js\":\"767480a23db5b90a\",\"/knowledge-medium/chunks/MemoryVFS-TqPK7SYe.js\":\"b74f7dc90340d820\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-BNbusHGy.js\":\"ce34b26cc620b14d\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-9AAcin2u.js\":\"1fa1fc743608b8bc\",\"/knowledge-medium/chunks/Preview-vMFoAMOU.js\":\"34e746ed319622b2\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-TNeEVZCp.js\":\"2471783d963ab9e2\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-Cbolc6W6.js\":\"c49b5788629bec20\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-BQVbV2qI.js\":\"c5e91629d16e7e41\",\"/knowledge-medium/chunks/react-BRCr80H5.js\":\"c0d3dbc6964cc546\",\"/knowledge-medium/chunks/react-BYEijuqx.js\":\"af84449d1e087ffa\",\"/knowledge-medium/chunks/react-CAJa6qkA.js\":\"1547fb6eedd55aec\",\"/knowledge-medium/chunks/react-CzesU3TC.js\":\"5fffb82ae7b31469\",\"/knowledge-medium/chunks/react-DgCd6cV9.js\":\"ab22ae3b1044d968\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-CI5ZvITx.js\":\"4758c65c8f07e78d\",\"/knowledge-medium/chunks/react-dom-server.browser.production-D9iEA1d5.js\":\"eb0278b4f2fe4f02\",\"/knowledge-medium/chunks/react-dom-server.edge.production-Pp0TgF6Z.js\":\"3b768c28265e4502\",\"/knowledge-medium/chunks/react-hJ4tbm7d.js\":\"0e099f3429ade326\",\"/knowledge-medium/chunks/react-njZeeJOf.js\":\"13991a79bf13c358\",\"/knowledge-medium/chunks/server.browser-CRZIzSdq.js\":\"73415a9c1b278071\",\"/knowledge-medium/chunks/textarea-B_LrZXJb.js\":\"463a84278c8fde11\",\"/knowledge-medium/chunks/ui-PRWgasM_.js\":\"130849c94a693f25\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"b4fe49a5a1d4548d\",\"/knowledge-medium/src/appUpdate.js\":\"8b4f8c618272aa04\",\"/knowledge-medium/src/appVersion.js\":\"e623322cf953461a\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"5428a484bfcda04b\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"375462281c67fe7d\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"c8f6c556f9925bb8\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"0c3bfdfb795dd106\",\"/knowledge-medium/src/components/BlockComponent.js\":\"eb03887d7e3c8a48\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"b11ba9f5743dcf16\",\"/knowledge-medium/src/components/BlockEditor.js\":\"b846efa7a6519ee4\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"051bfcf67b96be50\",\"/knowledge-medium/src/components/BlockProperties.js\":\"7201d43d4f43239b\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"80909e363c881dbc\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"fda982f0d1405c4d\",\"/knowledge-medium/src/components/DividerHandle.js\":\"90b250f1187c70a0\",\"/knowledge-medium/src/components/DraftEditor.js\":\"e4f18d557ffab6eb\",\"/knowledge-medium/src/components/GutterPill.js\":\"1b2c258143d945dc\",\"/knowledge-medium/src/components/Header.js\":\"b5cfea5972ba324a\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"96cf7d85fba71d21\",\"/knowledge-medium/src/components/Login.js\":\"959a6875303827e7\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"59ae0f471cc782d5\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"3e70379e9a50cbfb\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"041b21d40aa7941d\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"4f977917b2b2def1\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"2a6728f538d90295\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"2d372531f3ec64d9\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"44003724f6e466f7\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"412293021bcd5d4c\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"f29ec9350a871ead\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"54cd384a09a2d124\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"bf5d04ecc58a9fc6\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"e60f5dc3b86dde8b\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"5619248219db0f17\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"c7687d35801be9d4\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"db3f10c1b0b05cae\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"e8b49e10590c564d\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"7e0bae72a6a01643\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"4dc64634436964ec\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"c6d1807cf05afae6\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"7db46ae94aeb2b73\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"69d1fd40d1910865\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"e1f70190ef9f5635\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"fd14a3f6d9a1694c\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"b22927c919ad34cb\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"b1bc1540f32cf1ac\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"8942b26e1e395dbb\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"a4c8e64bff9b0f2a\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"5b3d4ed4298f42c4\",\"/knowledge-medium/src/components/references/CompactReferenceLink.js\":\"f76b638a67230611\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"580d54ba138c6115\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"0c1d95bf6e752e72\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"cd4b77e8d24b8fc3\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"dae70d20c62187cb\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"b31ab7989ed082f3\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"20ae2e2a5f6ae532\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"756f6cbc1e4dffee\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"40a311ac498f1257\",\"/knowledge-medium/src/components/renderer/BlockReadText.js\":\"a0326bcc9717075b\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"a846c80ca30b8655\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"ee78ed1d19c5436f\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"39a44531591338d1\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"1c6821d24accff85\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"feef34a0b7090727\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"da6ce5f4bc96d879\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"daef70b3cb585983\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"26695176cdc9c103\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"fed1463e3914ff80\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"1428165a0ed0b5eb\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"be889dab7a368e67\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"d86f9967dd535f58\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"e9fb52c7b1f3ea7e\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"792e3b49204e2553\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"7918ec9ea6f8f338\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"207364b71c4c0fdd\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"db3e15ef4d6415a1\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"3e8d7f40dc73f4e0\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"45a9a8b87e3c01de\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"4f45d741683d5e25\",\"/knowledge-medium/src/components/ui/button.js\":\"086169357e10112b\",\"/knowledge-medium/src/components/ui/card.js\":\"118c2ff813f475da\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"03727c1beb6a7192\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"8f66a14c2cb6b958\",\"/knowledge-medium/src/components/ui/command.js\":\"beb7e22ac71acc69\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"a02697a73e59d3c9\",\"/knowledge-medium/src/components/ui/dialog.js\":\"839227f032022120\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"09392bc9f4cfcec1\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"cc3160ee74cb06cd\",\"/knowledge-medium/src/components/ui/index.js\":\"752a4df0faec534e\",\"/knowledge-medium/src/components/ui/input.js\":\"5c10e9962b3f5d8e\",\"/knowledge-medium/src/components/ui/kbd.js\":\"9d581a9f7b404aa4\",\"/knowledge-medium/src/components/ui/label.js\":\"de423eb2c75ac188\",\"/knowledge-medium/src/components/ui/textarea.js\":\"6da916184a892a85\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"c8c55a45b1c33e49\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"81e615e6564818e5\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"212cfd356d97be1a\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"20bb83f98b129692\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"69245c0cba3b600b\",\"/knowledge-medium/src/components/util/error.js\":\"cb476db576fc0e97\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"3ceaedae38c02474\",\"/knowledge-medium/src/components/util/suspense.js\":\"60ce0cebebf387e4\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"18855ccbe442b834\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"631c8d9134196ac1\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"a0c26a2ff7d3cf85\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"70f49ce8f975773b\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"d117c2fe5c8e6918\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"68371acbe43d7bc5\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"9e634c42a5c4b688\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"06fd4d42aa5817b1\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"3786aab3ff0f77bc\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"90f715b5c234ae44\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"954707ec5ab432ea\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"93d38c581fa48302\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"67e9d102f019b6d8\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"c7546d036470ea85\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"8dae4b9d357b8447\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"994f63d07c199f21\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"fc4ed1e2d2427f02\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"8022df54c1c1d66d\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"76d42a9312c9001a\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"8658556403579536\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"4b78508ce2a2b8e4\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"057565a1ec0116f2\",\"/knowledge-medium/src/context/block.js\":\"16e8d7536295c7f6\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"c44e47a2d2a93ce5\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"b62e97825b56140f\",\"/knowledge-medium/src/context/repo.js\":\"f44634dd3070b70c\",\"/knowledge-medium/src/data/aliasClaim.js\":\"f21db5e1e4028bae\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"d217100d958574aa\",\"/knowledge-medium/src/data/api/blockData.js\":\"83f24b552a454548\",\"/knowledge-medium/src/data/api/blockType.js\":\"dcd470b8396c2d8a\",\"/knowledge-medium/src/data/api/changeScope.js\":\"c2711ce0c0e0fb8b\",\"/knowledge-medium/src/data/api/codecs.js\":\"0cb65f66fd863af4\",\"/knowledge-medium/src/data/api/derivedData.js\":\"7b36866155ef26a7\",\"/knowledge-medium/src/data/api/errors.js\":\"fe8b04cee38cd134\",\"/knowledge-medium/src/data/api/events.js\":\"89ad681fcce4337d\",\"/knowledge-medium/src/data/api/handle.js\":\"894ccf9aa3a0a47a\",\"/knowledge-medium/src/data/api/index.js\":\"b972b2e5b20448c0\",\"/knowledge-medium/src/data/api/mutator.js\":\"878dbd1a6e46a54d\",\"/knowledge-medium/src/data/api/processor.js\":\"6bee529682d1a78f\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"b8f48c12a18a8a49\",\"/knowledge-medium/src/data/api/query.js\":\"73f0ca072843c40a\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"d0f686bb7f23aa78\",\"/knowledge-medium/src/data/api/schema.js\":\"894ccf9aa3a0a47a\",\"/knowledge-medium/src/data/api/tx.js\":\"894ccf9aa3a0a47a\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"eb06e15c10d33c1e\",\"/knowledge-medium/src/data/api/user.js\":\"e23d0a24092362f2\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"c7ab94f2ea28dfe6\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"95b9e5d9266b2866\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"2dd5ef7fee472808\",\"/knowledge-medium/src/data/block.js\":\"210eb1660139fe7d\",\"/knowledge-medium/src/data/blockCache.js\":\"85ea3400472773b8\",\"/knowledge-medium/src/data/blockId.js\":\"714452ac241c5c0e\",\"/knowledge-medium/src/data/blockLiveness.js\":\"2421b36afa56ed1c\",\"/knowledge-medium/src/data/blockMerge.js\":\"8b68e89e9ae80faf\",\"/knowledge-medium/src/data/blockSchema.js\":\"3f9c2f75e09779b4\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"57e6af091e2d5e04\",\"/knowledge-medium/src/data/blockTypes.js\":\"d822cd5fb2c0942a\",\"/knowledge-medium/src/data/childrenView.js\":\"06a27527bdc3d30a\",\"/knowledge-medium/src/data/clientContext.js\":\"34c49e5c5fcd7432\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"71c3fdd663827470\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"eab00ab46698c27c\",\"/knowledge-medium/src/data/derivedIds.js\":\"c5b96eb6b0813201\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"f39f74245c0eac1b\",\"/knowledge-medium/src/data/facetBridge.js\":\"417e8e4a6814892a\",\"/knowledge-medium/src/data/facets.js\":\"3fb3cb6c7fe5a212\",\"/knowledge-medium/src/data/globalState.js\":\"1edb3a825588fa17\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"3911ca26531b0df1\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"36754c6be6f22c17\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"288a0736a81f0d63\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"76ee9a86e807598a\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"20c5ce16ddc8c49b\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"0a888195647097fc\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"0978a0524410825c\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"ef445d3c5311d3e9\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"15aa916826c5c9b1\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"116dcf09c43b165f\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"e8c206e42aa73102\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"0f35aefd128a7936\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"cd25b926153cb1fc\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"0f882ac1bf887758\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"5a480df4af4d8382\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"7d94a4d06cdbb9e9\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"7dc4f4fb57615270\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"84651514cfa622fe\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"6abd02e073948a06\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"593caa2d833a9718\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"56a293b06e7d4fb8\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"cc22a9594c41238e\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"24e75f5235de150b\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"c2dc3075da7e203d\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"5a67a18db46e9f91\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"db0d5eee30a5298d\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"e7ea4bd3496b0abd\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"11d8f5438db68cd6\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"8168479c19abb380\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"b19cb4f0c9ea78ed\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"fc39d9a312f3e149\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"ee29903f86b4d8fd\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"072b1ddc4f428eab\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"0f8d5523f6726faf\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"d645cfadeb47ba5a\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"85eb391354b3b70e\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"634cdbf4ad567ec1\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"518906b6de72bea9\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"5b6324482b3af5cc\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"cfee5414800d1c11\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"f210406b36443a17\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"fe4eedd14309fcc1\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"26ed37effe9f2de5\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"8bfe734f5a96548c\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"3e04a49b04161ab5\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"22bf1b73f4216408\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"089dfbff9c634d94\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"ad0bf04d3c77cacd\",\"/knowledge-medium/src/data/invalidation.js\":\"54a21b8c0f5c52af\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"04bc73ad693653d3\",\"/knowledge-medium/src/data/kernelPage.js\":\"b924b5ada2bc7c9f\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"131cb8702575d85a\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"215316ec9af03922\",\"/knowledge-medium/src/data/localDbStorage.js\":\"c935905a4a88b669\",\"/knowledge-medium/src/data/localDbVfs.js\":\"a1aa1f2fff382869\",\"/knowledge-medium/src/data/localSchema.js\":\"a5cad3bda05f27a6\",\"/knowledge-medium/src/data/maintenance.js\":\"0ac86d8864e2b60b\",\"/knowledge-medium/src/data/mergeProperties.js\":\"a30fe748dbad7ba3\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"a42dd092c8c71b79\",\"/knowledge-medium/src/data/migrationsPage.js\":\"83d8561ca344b181\",\"/knowledge-medium/src/data/mutators.js\":\"c3cc1d240d23c6d3\",\"/knowledge-medium/src/data/orderKey.js\":\"58fd2fc22d6a7c34\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"6e2f6fcdf48f7ac6\",\"/knowledge-medium/src/data/outlineSurface.js\":\"93ffeb033de53f7c\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"585db9cf28cbe2e3\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"b2586526b532bc2f\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"3b98425b041090cd\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"1f881d858df278fd\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"776d4326e1d45166\",\"/knowledge-medium/src/data/properties.js\":\"84475eb76df1b2f5\",\"/knowledge-medium/src/data/propertiesPage.js\":\"294c0d18e7cc1c74\",\"/knowledge-medium/src/data/propertyChildren.js\":\"3434697bd4d9e700\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"e2d863847f35c930\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"7db449d2a99e9095\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"b92f963a27dd7941\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"598dd772c738cd42\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"b70be0e473c30672\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"7e2d6858bac3e08c\",\"/knowledge-medium/src/data/propertySeeds.js\":\"b24a34091e57fd7c\",\"/knowledge-medium/src/data/recentsPage.js\":\"5f8a14507cd178ed\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"d733c3da2daaea99\",\"/knowledge-medium/src/data/referenceBlock.js\":\"0f768d176d30d04f\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"90c7f3d17d864d78\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"4983eb2b98e12b71\",\"/knowledge-medium/src/data/repo.js\":\"686088f730699101\",\"/knowledge-medium/src/data/repoProvider.js\":\"eaa28533edc6ca19\",\"/knowledge-medium/src/data/rowProperty.js\":\"a30930bc20ef8535\",\"/knowledge-medium/src/data/searchFilter.js\":\"cd1d927b8db32f89\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"8fa0e49e6543965f\",\"/knowledge-medium/src/data/stateBlocks.js\":\"2d75897aa6ae6bbd\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"ecc703a21c7aa253\",\"/knowledge-medium/src/data/structuralInsert.js\":\"3db3880d00621682\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"656015374a171d45\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"49b9ff2d24c56366\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"90be4992c3314724\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"d823e612a1f0cfa6\",\"/knowledge-medium/src/data/targets.js\":\"b402cfd08e043cfa\",\"/knowledge-medium/src/data/typeColors.js\":\"efd3ed909c1420dc\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"3bc72d459e937d01\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"0d30e6da281f3d76\",\"/knowledge-medium/src/data/typeExtraction.js\":\"a3f300a2b3c41493\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"8df804bd164b3b92\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"86311ecc42f2746d\",\"/knowledge-medium/src/data/typeSeeds.js\":\"5e2331f01acef5e4\",\"/knowledge-medium/src/data/typeTagger.js\":\"24fbe30ae1ae28b9\",\"/knowledge-medium/src/data/typedRecords.js\":\"bba08732e972d21f\",\"/knowledge-medium/src/data/typesPage.js\":\"b8e1a0c0e7335c1f\",\"/knowledge-medium/src/data/userPrefs.js\":\"c5b9b61eff8f1f7f\",\"/knowledge-medium/src/data/userSchemasService.js\":\"87f20d5a7b094af9\",\"/knowledge-medium/src/data/userTypesService.js\":\"08adbf91bfc87f60\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"645369fee215a14d\",\"/knowledge-medium/src/data/visibleChildren.js\":\"4cdc66d4323c5b77\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"4284e690ed91e5f3\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"df3842e6463faa02\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"b2dba0876c70249e\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"295be935c7f9e99c\",\"/knowledge-medium/src/data/workspaces.js\":\"1b6bdf90d4885b97\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"1a9bb52295e4697f\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"71740e16880d21bc\",\"/knowledge-medium/src/editor/atTrigger.js\":\"d085469ef7e8e684\",\"/knowledge-medium/src/editor/autocomplete.js\":\"3f8148dbb9c4b5ed\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"cac98455a9c5323e\",\"/knowledge-medium/src/editor/contentFlush.js\":\"8e5fb047e9460847\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"8dd607155c7fe5eb\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"a45203af5a7fa52a\",\"/knowledge-medium/src/editor/insertImage.js\":\"78d624906fe7238f\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"79f54c6b518ee2d2\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"312ecf9e43086c5e\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"76b8ba040f1643df\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"7d0939467166cc73\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"29bbbd9a213edd04\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"f6b52c70db7929c4\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"e61f34555edd6ebe\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"b003e4cc3871bbb8\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"8c7b7407b4f4bbfa\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"f4374031a933a6a8\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"318032efb76b4f62\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"e3989ee2ceb0a08b\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"d75a9d530f13ac34\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"7accc19c37514174\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"aeeca2b9287bde5e\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"ef7c62b8d20c7483\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"8258c683d87cd76d\",\"/knowledge-medium/src/extensions/core.js\":\"91b3b7c4e27a3142\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"544ba62645fd02c3\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"59f9dffb84fe3faa\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"bbadbea08dc77a1b\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"8382c5507d97b29d\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"726fd2cb78ca0200\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"a555cf172807d6bd\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"e292b8e2d4822f96\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"35d80f6c5ccc0815\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"cd6a85a15f1dfa59\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"36d8d91530b7ba31\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"e9096b8c5d745470\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"e181174e92915c39\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"e0158827418266c9\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"c27cb7893fc43ea4\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"f4e7f7c704c9fb07\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"831523fc67e9fc37\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"299cbdf3064c6880\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"7c4dc35feccb75ab\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"dc70de1cf512327c\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"bfe0be2925736ce0\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"2fe16fa8c24d793d\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"e0aa35c64679240f\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"20f9c799cb9bb447\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"e98faffb8717b825\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"9f9c80ca77d40fde\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"e5384f5ba07a2553\",\"/knowledge-medium/src/facets/facet.js\":\"2924d2e3ff3bf18a\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"aae9de29942bfa9c\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"e5068f1e3aaa79df\",\"/knowledge-medium/src/facets/togglable.js\":\"b98d81cc03a85fe5\",\"/knowledge-medium/src/facets/variantFacet.js\":\"cd607b2d59cad099\",\"/knowledge-medium/src/facets/verbFacet.js\":\"30ce1f7629f088e8\",\"/knowledge-medium/src/hooks/block.js\":\"5612fc189e1e895a\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"f566e88ebb4ef536\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"d06175de8af0728d\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"65bc50617093360c\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"a74bdacccad1bd8c\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"e115b2b458736ca3\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"135ca36d2b67fd76\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"6f1a1fe1612830e6\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"8bf4e9e067a1242e\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"d83e2d1ada04288b\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"cd99bf89e553807f\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"8a5056bac6c8e45b\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"6ae35cdfd09038c1\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"3dc3272ab7cb8b15\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"893f04c1ed792abf\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"bd54707788615580\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"16104ecb7e3f1391\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"40f8b9cf08ef84ed\",\"/knowledge-medium/src/lib/utils.js\":\"67a0cbee2e6912f2\",\"/knowledge-medium/src/main.js\":\"b56f6870d594f7e4\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"38588b2247a1e485\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"5caf0e0c4a06d2e0\",\"/knowledge-medium/src/markdown/context.js\":\"fb5e6df13bc937a4\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"a407205320dce5af\",\"/knowledge-medium/src/markdown/extensions.js\":\"140f8c90dad4369d\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"4982b3559cdc1fd3\",\"/knowledge-medium/src/minimal-editor.js\":\"b67d1a20167db0cc\",\"/knowledge-medium/src/paste/armedCut.js\":\"4a42ce1f73cc9cab\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"125e11bfe0803af1\",\"/knowledge-medium/src/paste/clipboard.js\":\"a91fcb7f12162e74\",\"/knowledge-medium/src/paste/decision.js\":\"907daff7c89353c6\",\"/knowledge-medium/src/paste/operations.js\":\"a287b9b2e2e278ea\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"fdf84690f06e47ba\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"e118f1c622ed5d16\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"b3fbda857dfcf6e3\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"0daebe83a7972ef0\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"fe253452386b8bb2\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"1201fe79f1351d20\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"a405197a8ec200c0\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"c76414cad0709404\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"ae6f1936aea9bc95\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"d250dbb869e1556a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"862fd21ca76280ee\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"fb654008c868c264\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"1954e82bdc16a085\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"75ccb8e1ad4190a2\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"8d90509c226ee5fe\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"c01a23de799df84a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"4c41b9e4803e1e16\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"706f7324a1a74318\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"e3201b05d76c2eb8\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"b252087c9f07f81a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"12902a244e4a2c1c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"3e1febafbbbbc6f3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"49a3e392b8b1fd00\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"53b253f3a47c0ef2\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"d827846222b9befc\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"8f4f3c165a9956e5\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"7e0762138949e838\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"a71710cbb53cb26e\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"8b62ba0762bfad09\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"07c22ce38fde2dde\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"74839639e13efbd7\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"ec8f5f5c0a745371\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"cf27484bf8b33042\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"3a48315f8522c953\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"a118f5af42179013\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"1a641df26496a10e\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"57e3f5e7b7bc3dbf\",\"/knowledge-medium/src/plugins/agent-runtime/dayPropertyInputs.js\":\"c5f3a85d9dd020da\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"f2642466f6869938\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"5b14971788d96968\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"6021ff46ff1fd762\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"cfb9b36901cb51e3\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"a6e0c6c3feb2538d\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"e77a0ebdcc232e92\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"9f307763183b8e13\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"777a29044ff6589c\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"bb560881bafe6c35\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"5bbf67bba509a355\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"0188708e91613f44\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"0513e2ae1ae7ba7f\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"7a1cb65fe44b4681\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"fe1a4840b4050525\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"a6dca9cb484ecb34\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"fdb20496d59075fb\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"ad9e4a3b540a0321\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"f30e72bfa14ba197\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"f50ef53e95a36b88\",\"/knowledge-medium/src/plugins/alias/index.js\":\"3f71db8ec657115f\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"c28e3b9de768c889\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"279b4d4f5d726380\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"f04831a6ebf11b7f\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"c956539d477ff7d1\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"ba07e929e840c151\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"df06ee0819cbbdd2\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"a9e34275ec113bc4\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"263361ff2c41a858\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"9da9ed05fd07ce82\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"794236d13ca8b90f\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"7663d2a9e2c5c950\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"fe53d116aacf2936\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"af61452eda9d8ba1\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"9b350e4649891f29\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"f86c7164248e4160\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"ca3b0b9405b7d5d8\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"3425034c915f8460\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"f9d6be04e874dfe7\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"c3f77eed36c812a9\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"69751d97021e7420\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"87998aa83114de83\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"9574683bef37e77c\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"ebce55ca401ea667\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"a00afa3e63779cdd\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"abf734a03a2c0ef2\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"8acdca4242b626bd\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"46c15f924afbf1b7\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"911586fc8fe135dd\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"9837c086797f5bfc\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"6c745cb619126025\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"5caf45e9e1cf81b6\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"ec8e409e379670b9\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"fb5852705fee5516\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"3ccba2ccf7ebf12d\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"83c8affa1cc22e97\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"c76c93ac9fdcdcad\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"1ab817d16584eb61\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"9c4f7444e5542efe\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"268fe86e570c3204\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"13d107a01787e87f\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"3165cf9983105c62\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"d2e311d03c9bac71\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"b58ffb45923498ae\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"0946db72d54b0f47\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"61b4d322e8bbe294\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"c69785c809f83de9\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"cfd1f06ce59248df\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"be98273415410db6\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"42c51f16d10c0bfc\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"0c138c68956bc233\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"9e07cdb2e5c58391\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"8ec6536f41ce7d13\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"24125a58597d8780\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"6f056902c08b4547\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"632e530c9e3ca5dc\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"013b72a824cd2b63\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"6288e93a48535ed4\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"3cff6f3d183bbdc1\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"6fd59cab4ecfb088\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"fed8862988dd15b9\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"81396d7cc6cc467b\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"737d43cc20da2a76\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"8c4d30d275f1229d\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"f91acae7ece6d0c7\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"ddc4fe2ab6d32b87\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"20522a6debeced0c\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"1ce8ed675aaa6b85\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"0c40c491ab4eea2b\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"6b55d4f9c1599b08\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"7f464f6d48df4937\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"546eee617a00efe5\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"05598decd77dc36c\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"18f72c20d7000567\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"047970c35155c70d\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"feea7106b06c34ed\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"379e28fb1fe8960c\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"31e574e9d102e001\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"4b5f0778fde482f2\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"a2f2a75a061ac81a\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"6f066a62c856dbe7\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"d2fcb39054142be4\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"bca08ade19a402f6\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"8e4d9f59ff7b52aa\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"2fb21356feb8c12b\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"5aba1b391963cf53\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"35053711cb7b71c1\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"ad448be6efe08ffa\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"1f59ec69e95681c5\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"179f194c92d650ed\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"3f0fbdab6b087271\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"b8f19e8735433bea\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"b491069200ee706d\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"e68bd622e232b6ba\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"b3ef8fdbf30a517c\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"60bdd69ac4c7dfd3\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"7693faace4ed6f6b\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"797e502723dacb6f\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"1ed20b4fe81beb83\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"37dcc496b7f82111\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"f7a0deac111bf506\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"6cefa9e8d4f8cc1c\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"bbcf87eb855e9ccf\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"0d71c4add6f4f98c\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"b28e13fd5cb8fcd5\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"7991822781ad78b1\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"b8d93e3bf688b8e3\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"ab9fda214682030b\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"95b66882705bf086\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"484d59fa2d3693af\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"c155840fd1aac506\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"ab917691c606c059\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"7164c210eb7fff53\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"d79467e85094672c\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"4f1f1528359b8549\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"635b961d4d8e6262\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"0ec50305f3fe8c85\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"7f0d5e9924ddd6d1\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"c1821c411110cfff\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"446d5a0669597269\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"51cc7c5410ae749f\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"736507c59495b5db\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"6584ae55ded4d4e5\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"3d61f873d740dd0b\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"90ad25f529d71e90\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"ebf0dcd2acd95031\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"730bef8f5277cb6c\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"537b04f70169bfd2\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"583e97cd62b71161\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"c2247b3602e5b61d\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"b0bb298bb5f1f20e\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"399027fa80d02727\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"91af07dc4efce249\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"4008a2c267009de7\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"1f60231aa84d3ef5\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"0e3fc1e0942d444a\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"d23cc72f9ff32709\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"0df3024eb4c94103\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"e17e2c192da598ae\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"d08d3c9b07a51b42\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"f9165e6c0d52a0a8\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"1e19cda2ce50d15e\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"f732ef3afbe3a63b\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"8b840351876f48a5\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"a1846c5b0557e934\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"7cc38005e6c678d4\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"723bce1019e75463\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"afe2998385cbf6b5\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"554749f859505a67\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"e8cdca63d62448e4\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"cb79debf98855dcc\",\"/knowledge-medium/src/plugins/character-counter/subtree.js\":\"d8c11f4a62f478bd\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"35becbbfba3d274e\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"399e9bc9da212356\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"c1e8dfe698b6cea6\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"e439fbe409d66f72\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"709ae31d14ba8fdc\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"d8bdeb18082c5527\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"cf26b248922a3325\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"18c335f397f8d1a2\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"a41632f940790d1f\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"da9fb9f9be75a937\",\"/knowledge-medium/src/plugins/contributors/ProfilePicture.js\":\"c3b5c86358a77818\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"d29ecc1337fd2abd\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"4210aa356430021b\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"e1cf18b42d441671\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"0a8d1d0c8e95c7a4\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"64bc1573ba27efb4\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"627e7c3cebe60aa2\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"363ec30f00aca59d\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"9457bf841ecf7d4d\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"43aad3ce61610090\",\"/knowledge-medium/src/plugins/contributors/useCommentAuthor.js\":\"b0e4aa3dafba1a23\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"1f393aff81305837\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"ba26a9071ba3d611\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"1a9946ec582b435d\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"7f87e04eb0b1dc0e\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"b71b7d4d3e5f1a55\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"cdc3935d9cd99f8f\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"0a986873a98621c4\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"e23a5a61b831d16c\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"871aa1515622148d\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"e896655ca0f4e628\",\"/knowledge-medium/src/plugins/daily-notes/DayPropertyControl.js\":\"e0193c9ef8394849\",\"/knowledge-medium/src/plugins/daily-notes/DayValueReferenceControl.js\":\"661d121a3f398628\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"37f8bc1d8f1f76dd\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"a1841b6a8f432ca3\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"b9e3812bfa245a54\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"b4553fae99dee9c8\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"25550621c5960085\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"7aa6afe301414094\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"d3c4a467c1b0b681\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"34d9f8fcd066c340\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"6c4f4160296b7762\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"3214ad5c8d9c4851\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"acf242c60ba112ce\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"7c8ff4a5e1c33508\",\"/knowledge-medium/src/plugins/daily-notes/dayProperty.js\":\"f2b7ee56d5158f58\",\"/knowledge-medium/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"a0fd07416927829e\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"820f58e296630eec\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"11e8dff84a6023a6\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"7caba7b0e7fca335\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"9b7f88c102c50a05\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"127f5a8055dffe2d\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"bf73115af41221d1\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"411c6f14bf1d03d9\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"30aa3db9a72e0c81\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"ae742b8a86594d83\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"54a62e887836d30f\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"067c187b6be712cc\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"3aa46494fe5a7e00\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"18ba7cbcc21cd992\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"f84dda247400e2dc\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"9c50bcb9c6f7bbee\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"587b09de6f403da1\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"0f3116b210fa840f\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"419a2dc8d5d3e628\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"c21473c1b0e691cf\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"242d097bd8d92e3d\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"c3ad8cb9d4d5e3e0\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"d180645ff724aa95\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"1634fd734b23e499\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"ed03603961ed6b1c\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"ac697605a2968084\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"b7af2586eb46c698\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"fd3f32391ee60d24\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"4b8e766b59f81a8d\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"da711e2b9f01158f\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"b15fde36320f011f\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"3975ad2878cbcd14\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"3c090d1149770481\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"664883f593b1af00\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"1379b7b62dd3c76d\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"572eadd9d05e9ea5\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"f02e8b56471a4e1d\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"39abb50fa3e19de0\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"c7a2c2c35e011604\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"7bba7681e927daf1\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"7fabc572ab1d5205\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"f15f9b3f42baa272\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"a81aae3f3ccd3257\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"eee254468c7cd2f8\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"c1b234c2ce4c4b2a\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"f5dc9794154dfb2c\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"ff233686059cc2eb\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"c9d3481541c6e10b\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"08a55bf487029d16\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"249ca3f6da835c9e\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"e8dc78c62e30ce6d\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"b96eb25216842c00\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"fc28a7bcdbac4489\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"d9964c330dc36721\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"621ed720439f9c30\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"a35c8fa81a4e3ca5\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"13004ef76e2e1e86\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"c8f66fa470f0bfc5\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"86a11b6d7495566d\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"833d93d2788ca991\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"d458a1c26a97a2a2\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"503df3136d12eab9\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"41ca7888c496b685\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"513fcbaa5bbb0617\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"fec98cac39721b23\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"832624702b6eca5b\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"be9c101da6439af8\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"8152ae5b52771e62\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"f91390dc4c3307b0\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"78f5ab94a7fca901\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"492ee592c277a4b1\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"f690887bde28a34c\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"c02d6916b2872784\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"789db702e936690f\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"06b045db503cbd74\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"f86d804aef458e34\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"137a7cb868b1bfdf\",\"/knowledge-medium/src/plugins/geo/index.js\":\"73bfa7744a7e7689\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"5431c402a74f3785\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"aa05b1727765dece\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"1c24ad46fcd32c30\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"5be6fd35872f29a9\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"bfc6736f9c0e81e8\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"7292ace3859da7dd\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"cda2efbdf7a765c9\",\"/knowledge-medium/src/plugins/geo/query.js\":\"511c768a436b5806\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"1b2fb6f3481acfc6\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"74986bce6f4e71e6\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"c84d27b3784d784a\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"5d7b34e4facea8a8\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"279958998fd99daf\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"ec96912b061a1f4b\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"a11e270d7d92281c\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"04b86ce8693fcbb3\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"5ce9628ff05613c5\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"13c6fced4edbf1ba\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"4fcb995e76d7cfb4\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"088fa9ab23fc6e62\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"de170694250efd50\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"4e2b6f33e826a4b8\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"20161c03ffc4fd0e\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"37f8d46d6e2a8830\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"0f5280b7df9a6810\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"30cb9c16333f5e84\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"31106c5e39349355\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"4e1f96edf2ac6283\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"f69fe6fcf71a483d\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"a0fe09625ab8f99c\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"0e8efdf9237c08a4\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"15a88f9f66e3788c\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"8a7878fd09ca6600\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"c0db0f70c87f24f7\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"f30748f74b1da37f\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"c55a9e6256357444\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"a7c95ce704b4a4e5\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"ef8d3b816480cf6a\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"7b4f714e88cd5d60\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"3f3b0c04fd979b20\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"3efea6265308c276\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"029b0f6fc4bf2ca7\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"9578ce9aeacca066\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"50182d7ca2ce6258\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"fc14f5aadf2197a4\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"691f3bac81d33fd8\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"bba7298c65bbce07\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"ac4a67f61edfe3ab\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"ef293d1266576a3e\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"2800103e96dc9e3d\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"eebe275b4517657d\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"51287f492d365596\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"96083ef3bf208dd5\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"b6d2b0a5c0904c60\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"37126d6d5129d8dc\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"3ddf50d81e593adf\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"20a20f2b9d8d9520\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"3b486042a452c6ef\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"c25a65da6e616b10\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"3d7d20beabc9c498\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"2e7155c0e0d64765\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"b18d90df6e8c7d59\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"287a104d6aa5baca\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"e08c0ba19fe9880b\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"28ffc89abc5c51c7\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"f384e8fe2f003d26\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"b5c955347642fcd1\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"c0fe9e82f96523be\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"4326c9d14f4bbd10\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"7dcd9878edf9523e\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"4a08a4caa5cc329c\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"a63229110f5b7c2a\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"d2fa8ef2e9ca1b0d\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"8353a6557e509002\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"8d9a26ec922b9dbf\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"d063e1bd3a5f858c\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"cb6c13aea18ab3e6\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"4ea7c9da654fe26f\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"638377043f55e5b0\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"60b6acfa674ce0b7\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"9ed8cc8ca8187873\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"81dccd5476be592d\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"eda7044c075436a1\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"39a0ea2364005976\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"97fd9a564bec0b93\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"a5b29713bc3018cc\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"dff3a3c12a916184\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"3c259308da4c8c1d\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"65f8839883d89097\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"79f9f98a233729b2\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"d5b522a853767fae\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"fd9b52ca76e15dec\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"8b9c39d386417b19\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"76e95d646e8c2f47\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"248538c342b76edf\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"414faeff2af12be9\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"191deb593b5a6be9\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"e52463df2b0fb329\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"6c7c9888d5f5b8dd\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"a8417d28607c662c\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"19714fc4171caa6c\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"2e28d35ec13a1af8\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"d99e638de2fe622f\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"3b09e19fb6f95725\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"36d9ef5c545e548b\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"0563f71e193d6bed\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"2a2ea018597427b5\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"ef0fe8ae275f7c06\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"884b89b6790f72c6\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"e7cd742d0ec56f9e\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"475f49c3b8493f44\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"e4ca03fdc2d56762\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"ba671cd74cf77584\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"d7d06ed06d59de06\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"d0465f1c2c90b746\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"931ec1e8c6d77a72\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"7acb55b303e9b6c2\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"30d16f93d8152ceb\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"3eb9f2a147cf1bba\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"c5a38286f63b1271\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"d51d2cddec0dbd2f\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"0850aeabda208339\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"8cc77181b735fc92\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"7475eea3546e819d\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"457018c86ec1cff8\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"567c35ba0d0f6158\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"e48bab98f3df6b7d\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"9df4f402d47803df\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"77dcf10a6a2ff91c\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"86713a9bf2a5e691\",\"/knowledge-medium/src/plugins/recents/index.js\":\"95fd8ff079ece0d6\",\"/knowledge-medium/src/plugins/recents/target.js\":\"296c10e152e6e47f\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"2cdda70bbf35055f\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"9042ef9f2b179526\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"6e153464391cf0e8\",\"/knowledge-medium/src/plugins/references/index.js\":\"5c79423f5ecac958\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"a930cb90510acc1f\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"8a148adb55f44ab9\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"c12abcd788c279aa\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"32ad24e1a44189ea\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"e8f724847bea252b\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"ef7e8e25bc812595\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"2adeaa53a82fd696\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"fbfd3fbfa48e00e8\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"8e1d3a6936d343b2\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"7473348b55f77041\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"44b176eeb4f67ae9\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"73e243b1188e8254\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"52204d780a0338e0\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"bb33b04bff897c07\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"13ef813571e60893\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"c364c5ec27f2b136\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"d6ad29cf6eb80538\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"85a7bbf3c2fe219f\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"cf2efad061693975\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"354d94b1e101628e\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"6ff467ca1d6fce65\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"457f40d6ef3ab49e\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"6df8f85852d6335d\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"8f8ffc358c89353c\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"b69c0e848c3759e8\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"e48c6fa591799fd7\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"3b2368ba075209df\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"f594c373c6d1b177\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"1a94d0d3dbf80c14\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"b9a401d2a48a948c\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"0f1d5e8bd7c1ff4a\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"0c2b9fe088d0548c\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"7724c5b5806b6cbc\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"acf4af489594efca\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"9d67a49075367cc5\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"1f46c71ca0314df3\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"2e987105c904a227\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"83cc3b7664a49da5\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"c279e49aed5b34ab\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"c356eb057cef8e49\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"b6e3708371b321b0\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"67288f1db55042ae\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"a0fe1179d0cd5ca6\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"b197051f0a9fd019\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"16d996a7261b6bc1\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"2985396289a82aa9\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"80a37404c74c71c7\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"527f76ec4a28036b\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"2ca5a19ff347aa93\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"ab3aac999bbd2df6\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"de139169dbc8023f\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"cd88a1b2e360d8bc\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"0d8fcb755188bc15\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"d735835afc9eb748\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"f7cdcd81c210b622\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"ac2b8cae48b39701\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"7cfd1b1f698de47e\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"ac31ae219131692b\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"5df4e2f035c5cabe\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"65881d355e9ba65c\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"abde818386b1671c\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"1efa9dfa18ae057d\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"a42182fda639238d\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"d73dc598dad6bf09\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"1ab519e9591b6d21\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"fb7ea8a2d9b4d500\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"b4e5027bbf9c118c\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"45a1ac57e1a87acb\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"eef476c45582230f\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"9b636d95ac6faac3\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"4a27da444f695dac\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"2c9b4ca9f6eb27e3\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"aba188431d42db73\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"1182e2b4504b1604\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"aca82d8ec8737bb6\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"5a150c6275f2adf1\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"6cd230be89105bc9\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"f5db6cd966bf3800\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"0927b8b4ff5aed36\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"294237f4ee2c7f40\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"f79773b735f1fa36\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"83b9234562815e78\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"c5c841693897954c\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"7744fc2bdf5ae52f\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"405ab16d98821003\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"e1adc6ac3cef5122\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"d2b87bec62d4ffb3\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"27fdaefeeb7a5918\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"a8ce369f2a69fd3b\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"03ff1cbc6ab7029e\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"c33ae5d5a5de7748\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"0887be9e13b5b205\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"6441e2bf8ca8e268\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"1f45e425c5b17d26\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"8bfff4d95f580389\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"392681714b746150\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"af29c9ec3f9ff3a3\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"9ebbc0d7338fafbf\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"e932fccfc91f5a7f\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"7c5273c53ccf5a0e\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"f23c1025ed6646a6\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"cec97642a301306c\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"3f52315e79a4b982\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"ae5812a768f0700d\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"a005b883c6aa69eb\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"806b2b49571b72f9\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"81ebd52cfe7b8ef5\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"501c3885f85051d0\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"74fd57662a0f46a4\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"227f26bf10134808\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"1b96bdb1aa4156d3\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"1da9f9257bd7e7d4\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"deef0ccacbc8638a\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"2a041332a350a11c\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"4f4ba7e44096d8c3\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"2e3c20bb9c7d1891\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"52b23488b12cd9f6\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"91a31569d67f9d3a\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"db77fc630cf3e59d\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"bcd9a3eb71fd8663\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"67c465980d61b99b\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"ec958b84aee03c3a\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"7eb0059e537699a7\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"8e500ea3c3056da6\",\"/knowledge-medium/src/plugins/tables/index.js\":\"04cf8ee98c3c27c7\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"a5b1cd4e8ee48f0f\",\"/knowledge-medium/src/plugins/tables/model.js\":\"2da2490c506c4745\",\"/knowledge-medium/src/plugins/tables/query/QueryText.js\":\"ad8daf3d2afd0976\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"ce1181abde4bda4b\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"e189b87ee58a3bab\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"6d7cf16f42c1826e\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"1d61a41b31f45399\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"3ea99cb1976f7275\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"11ca2d36aa8040b2\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"6f4e5a730763ac7e\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"1054bfc2e3ebc624\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"0fe5da13823f675f\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"20b3127013b36d3d\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"49acd78764470d18\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"a5d0586566a8027d\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"c3955e644e7b1887\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"2517087d098bdd86\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"25b0e9f96fd476c5\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"97435a50dec9f43d\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"d8c24ef2bde0e999\",\"/knowledge-medium/src/plugins/todo/index.js\":\"f606eba6cd5cb58e\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"35ac6b5d4bd495ff\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"89b6315553637ce2\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"b5c5c4b59f2df725\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"033aa397c0932b57\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"d6ea5f212d1bf873\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"0d7bd710bc60b899\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"4344249eb6dd0bb7\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"d28be320c55548a2\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"ca6da0459bbdf021\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"4903e6073079d6e1\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"2bdac06b7fd37fb9\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"c9ea8fa80e50a8a2\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"c900876ba4c9037e\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"14ef69cc24c5e92d\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"702d762ba7d138a2\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"292ea70b4fd9384c\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"3b8e87bc4e1bebf5\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"d394a7b98b088b17\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"4d3d3fa034e51050\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"54c7fc3d4fab228b\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"bba71ed9189b7534\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"05985d3b9c2c1b0e\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"3a4f8dfdb5caebb0\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"5304df51907e4f52\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"6c55301c8981e7af\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"e40c6f9b0488c3a3\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"f6af840020da5f39\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"49252a890469057d\",\"/knowledge-medium/src/registerServiceWorker.js\":\"ba12c4729ffddc0c\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"9d35ab7b53146073\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"13b014660dc3dd13\",\"/knowledge-medium/src/services/authStorage.js\":\"f97e52218e915fcc\",\"/knowledge-medium/src/services/powersync.js\":\"677f0b6c748ddb1d\",\"/knowledge-medium/src/services/supabase.js\":\"65186bc40ae2cfed\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"dfa87cb092ed9198\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"86ef835cf071badc\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"59f4ab41bab6bca8\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"ea5b61a5f9a6ba0b\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"bc2c0456812adc9b\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"c8c7ecb4f9b11736\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"c606fce91b286f62\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"30193f24fa764b71\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"3c32da469e29291e\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"cf39cc80ace8b8b3\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"ac74436af21c366f\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"52f57cfb3b186b61\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"f91a52327bcb3434\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"c3b6b5c3895c0a2e\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"32c205100fd8a770\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"f03c61f67090f0e6\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"7414dcc895ee1554\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"6b0a04fed9ff808e\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"8bcab593adf3a1da\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"f4619b88a69d84b2\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"dce33e4fb54785f7\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"8601118c406517a2\",\"/knowledge-medium/src/shortcuts/types.js\":\"45b62dd840b8fd27\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"21e4e7a82d537f27\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"c8223016f6ca625c\",\"/knowledge-medium/src/shortcuts/utils.js\":\"4c55ee5a04282d21\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"08908b2a7f0619fa\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"f70de347f24614d9\",\"/knowledge-medium/src/sync/byteTransform.js\":\"43b5f0ae3d60de09\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"1ac685564f4ba387\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"b4f6631fdbe058e3\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"07d68baf56d48380\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"cd9a145a06e957c4\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"44cfc428fdc8936a\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"4d293866b4055e06\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"571a34a765115145\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"c40eb11ccca4113c\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"371b5a18620b9600\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"565f019193316281\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"52e8a6dae5b4a13d\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"d90c9a7920871881\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"2f87cd171d3d68e6\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"56a3e04ab00ccf74\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"438c9b08edfc37ba\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"75c738cb0b4fc284\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"f42edf43433f7327\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"e0db70e0570e6854\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"22a0d2e2b6f0a780\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"d96c466d974166f7\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"8223f013f4d98d49\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"b0079f08415667c8\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"1af6f2235e92a850\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"9738f0613f446ab0\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"ce6d3d1f59d900a7\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"95d5e40c7bdbc3f1\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"809e9f306404f501\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"a6bfae0c36e66568\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"2b40c4705a9208c6\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"3ba0bff350808e01\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"c12fdd557d6e9b08\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"3b507c9dcd651bac\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"203d95e4fe343d4a\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"51d7024d3c9e78b0\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"5240f984b187af8c\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"96646fa9be73dee6\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"d35e6dded0d9e8fb\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"a6265f0981882abf\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"7cd183ce495ce42d\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"846fcc714a72e8f5\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"d265c40b9737ced3\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"b409b63771543812\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"77b980815ee26dd8\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"f0d8dbca03773411\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"6f4269e96913a9cb\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"9f7165964a6c3752\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"01006ddc311664ee\",\"/knowledge-medium/src/sync/transform.js\":\"80b4acb5999c2a22\",\"/knowledge-medium/src/themeBootDefaults.js\":\"7c4903bcb0ba2eb2\",\"/knowledge-medium/src/types.js\":\"2ecd9404d83c213c\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"70b0a45299731a6a\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"5ab00be1eae566b1\",\"/knowledge-medium/src/utils/array.js\":\"771819ef62949ca0\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"9e55e653e4710120\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"9a741abf66b4e093\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"2468fd1df1adf00e\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"53855b07a203883f\",\"/knowledge-medium/src/utils/callbackSet.js\":\"a9b479da4b940d92\",\"/knowledge-medium/src/utils/clientId.js\":\"12af3a53f849a723\",\"/knowledge-medium/src/utils/codemirror.js\":\"7bab722f59db1232\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"ea34c72f5d65993f\",\"/knowledge-medium/src/utils/copy.js\":\"5ec9380e1df0bb3a\",\"/knowledge-medium/src/utils/dailyPage.js\":\"ac5c5a7bbfb96e6e\",\"/knowledge-medium/src/utils/dbForensics.js\":\"70ae79200f169b75\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"60847307f31f5bf2\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"8f7245bd613a457f\",\"/knowledge-medium/src/utils/dialogs.js\":\"3e93ec658aa96f58\",\"/knowledge-medium/src/utils/dom.js\":\"fb01893bc88c5769\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"b7d9188d4f6aafcf\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"7f21c9dd71db98e4\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"1d233d66257e8e00\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"1697178c0c6b2acc\",\"/knowledge-medium/src/utils/flipSlide.js\":\"2f5886f27791dada\",\"/knowledge-medium/src/utils/fnv1a.js\":\"27a74cdd7071eb43\",\"/knowledge-medium/src/utils/formatBytes.js\":\"a91723cc0e25650a\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"74b42be7399617fc\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"ccb4f16bb657270b\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"b2d06b3cb31a780e\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"9fb722904a88d708\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"ffc5355ba203b453\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"40311ea0130f4bf4\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"e79b614a2197e659\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"2159a5a973ec9747\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"b76353b5b8cb83aa\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"7db38c1611403869\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"44d45de8a4d63e8a\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"5ff501468f454f52\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"4f8a0171b45b38a1\",\"/knowledge-medium/src/utils/markdownParser.js\":\"9e790010ee1b8dcc\",\"/knowledge-medium/src/utils/memoize.js\":\"df800d6dd24b128d\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"9dc6428bd468d597\",\"/knowledge-medium/src/utils/nameList.js\":\"a504e9e96491d2df\",\"/knowledge-medium/src/utils/navigation.js\":\"815b2e854fb41e1b\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"406e70f420eddf6f\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"23072c799a23de9a\",\"/knowledge-medium/src/utils/panelClearance.js\":\"aa4adca5694b0039\",\"/knowledge-medium/src/utils/panelHistory.js\":\"93f3958652291b4b\",\"/knowledge-medium/src/utils/panelLanes.js\":\"3a2be199e8cb42d8\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"cdc85d4ff3ea95ef\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"05f21015dfa7e406\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"a3071e72f797bc6d\",\"/knowledge-medium/src/utils/platform.js\":\"dc4ae3c1e8e50064\",\"/knowledge-medium/src/utils/pluralize.js\":\"338314fb3ed8e0ac\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"b1895a152f5ce4fd\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"3f1a990107578fe1\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"38a6b7224aa8aa53\",\"/knowledge-medium/src/utils/react.js\":\"3f2b1d1e7281a2a7\",\"/knowledge-medium/src/utils/relativeDate.js\":\"f84fe354d3e4fec6\",\"/knowledge-medium/src/utils/relativeTime.js\":\"06427f0a0fd44618\",\"/knowledge-medium/src/utils/renderScope.js\":\"bde4f17fef45cc73\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"b934e3b406170e10\",\"/knowledge-medium/src/utils/routing.js\":\"05defe603cce7ff0\",\"/knowledge-medium/src/utils/safeMode.js\":\"c02377c7675ef483\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"d24ea2d5e18a3c43\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"3d68d1861d258497\",\"/knowledge-medium/src/utils/selection.js\":\"c8c59cb5285591eb\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"1a3296d009d86e41\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"89336fe38eeb8741\",\"/knowledge-medium/src/utils/state.js\":\"179f086e7548fba9\",\"/knowledge-medium/src/utils/string.js\":\"53b60fc7b8123295\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"02c595a92c21c5c4\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"99344969274e58e2\",\"/knowledge-medium/src/utils/toast.js\":\"c3522512d39b7b8d\",\"/knowledge-medium/src/utils/toggleStore.js\":\"37222d4f72fdc16a\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"62d001b8677e4b49\",\"/knowledge-medium/src/utils/userActivity.js\":\"81e34569ed812667\",\"/knowledge-medium/src/utils/viewTransition.js\":\"70e262e50d5beea0\",\"/knowledge-medium/src/utils/viewport.js\":\"dfb32bae68ca06fe\",\"/knowledge-medium/src/utils/webLock.js\":\"76eb402d6a8b2092\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"b5cabe0f3d755d57\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"79ed0690e386d765\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"6ebfc617ad90ad86\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"1d0ca5ed59a7ed08\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"b268e733f40b63ea\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"3967da6d5b9c0788\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"0f8f02c67ecf116f\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"bd4897ee1fdb18c4\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"866ed416f3009a20\",\"/knowledge-medium/src/vendor/react-dom.js\":\"158a697259f0801e\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"528b6ecb3c4f2fb8\",\"/knowledge-medium/src/vendor/react.js\":\"4fbf56b9c98e8f1f\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
