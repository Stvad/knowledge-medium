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
		buildId: "742ce1a46781-a825ff3f",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"891c19739bfc1616\",\"/knowledge-medium/index.html\":\"891c19739bfc1616\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-CDznvycP.js\":\"0963bd12319efbd8\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"905dc18a98f5efca\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-lWqxjSrW.js\":\"e38cdb4391769bb3\",\"/knowledge-medium/chunks/FacadeVFS-ou8-tq3c.js\":\"27e81a77203e017a\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-7mFOac4d.js\":\"6869aefa0a4d7ce4\",\"/knowledge-medium/chunks/MemoryVFS-BOYJF8bf.js\":\"61a0e8699df54c9b\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-D7jOqQ5y.js\":\"573be8fb8e82202b\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-DTenfSfw.js\":\"b89181c95647e589\",\"/knowledge-medium/chunks/Preview-CUcY1M5B.js\":\"7a32e5a73e7a711d\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-ByoWdLOC.js\":\"0af58fdbadd2d92f\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-DdxHlFcA.js\":\"74d659895367a553\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-BnBEpmpK.js\":\"1575a1cf0ecca486\",\"/knowledge-medium/chunks/react-CJV2QOc4.js\":\"2e6baa690c2d5cba\",\"/knowledge-medium/chunks/react-DJTU3IPV.js\":\"4de7475f091e4571\",\"/knowledge-medium/chunks/react-DK0SJANc.js\":\"c5f468bcd9d83056\",\"/knowledge-medium/chunks/react-DL-p5z6q.js\":\"1dac31cdca5ec466\",\"/knowledge-medium/chunks/react-DRr9GbYj.js\":\"d197d552be774692\",\"/knowledge-medium/chunks/react-DT3lxH-o.js\":\"68106f5a4af60b54\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-DaDHe5gX.js\":\"b9bf0db7ac7a3316\",\"/knowledge-medium/chunks/react-dom-server.browser.production-CsFsha79.js\":\"fa8eb64925dcd44c\",\"/knowledge-medium/chunks/react-dom-server.edge.production-D9gVgAP6.js\":\"3de06439a95abc33\",\"/knowledge-medium/chunks/react-y1Z2qNje.js\":\"2c2e82930907f6bd\",\"/knowledge-medium/chunks/server.browser-CGaR4y-y.js\":\"1dd0f6dae061f75c\",\"/knowledge-medium/chunks/textarea-BN7hNA6C.js\":\"f52e685edf359dfa\",\"/knowledge-medium/chunks/ui-DUU0c5kt.js\":\"75469e7c2372d47a\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"1c82665a6d55c637\",\"/knowledge-medium/src/appUpdate.js\":\"bc5c6c24de498401\",\"/knowledge-medium/src/appVersion.js\":\"b573489561843926\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"764576e9db510632\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"ab61c28723ba54d0\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"bdae533700d0723b\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"9565317f0ff750cb\",\"/knowledge-medium/src/components/BlockComponent.js\":\"b824030ff9a8b4ea\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"29921ca07831eea5\",\"/knowledge-medium/src/components/BlockEditor.js\":\"a1960320c934d3d7\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"b1a3b55ff071c706\",\"/knowledge-medium/src/components/BlockProperties.js\":\"c75b341dfaf6fec3\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"f9d1767d8378e1b4\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"fd718e53bc3da2fd\",\"/knowledge-medium/src/components/DividerHandle.js\":\"a56bb90a34192793\",\"/knowledge-medium/src/components/DraftEditor.js\":\"1913023465beb43b\",\"/knowledge-medium/src/components/GutterPill.js\":\"f0e83622d0f62ba3\",\"/knowledge-medium/src/components/Header.js\":\"d7486af79bcda779\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"43df88fef8fb8352\",\"/knowledge-medium/src/components/Login.js\":\"1d8b011d32d4d8af\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"bf4d78af38698da1\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"aac75d8f309f633a\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"9edac4474578abb6\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"b538a96f9db38abe\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"fa507327c9dbb887\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"3d1559a7a122fd8e\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"e5b0b11208b47937\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"0e435ae31b93bec7\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"ea83c24f966753f4\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"ed3971d8c00c6fd0\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"fa1db5e8abcf0f1a\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"f9fc8c4ecd0465ee\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"05a694e95a922f2b\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"295c51bec49d6e72\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"16ac65679ec98e57\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"ebf18ed27a86c738\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"5015eb417eb4cadd\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"3f45e9fa66ef5219\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"af90a32c4de44695\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"717e185d927e3391\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"48fe6d639fd5b5ba\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"8dc1134acc65f963\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"96e477cc0534b1f3\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"47faa34837b31fb0\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"18f268359da939b1\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"c4f1643ccca2919a\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"d0866df9428f4a34\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"6c302ef05517d16f\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"b4faac2c1560eb58\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"9ca1f78db0e0e349\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"868bee3ddb62e1a7\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"6407a9b680e88f50\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"e681674101649ee7\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"15c8b190ebf1c4a4\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"720adb4036b34646\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"40a2e5872b352e51\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"2ee8b6a0a089d51d\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"760c87055df0c902\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"6bcbdebdafc81915\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"389565983e2c1823\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"f05dfbedd8ae3066\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"5e0f05f30852e3d7\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"3647439f6089faa0\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"104f692f218d221e\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"48645171b2338dd6\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"3fb75cc953cc6cfc\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"9f94afc6ad5b42a2\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"ba3df7199e047da4\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"30b27feeffd69d8b\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"8128b726a3ba280d\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"5f3030bd0ef7f938\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"4a22d0d407fe5774\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"1c19c87a9366383e\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"763e3c5cec177c66\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"c221c71db4c20f18\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"159def836e2050e6\",\"/knowledge-medium/src/components/ui/button.js\":\"928a21dedbb4c9c3\",\"/knowledge-medium/src/components/ui/card.js\":\"31024c702dc049d7\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"c07134d540e183b6\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"3b325f89eb2b7400\",\"/knowledge-medium/src/components/ui/command.js\":\"f62b296d8fc5574b\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"0ee65f33a26f62a5\",\"/knowledge-medium/src/components/ui/dialog.js\":\"72de6115584035e6\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"369c982ae7411d18\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"525384ad3256826a\",\"/knowledge-medium/src/components/ui/index.js\":\"3acb91c0c65e04db\",\"/knowledge-medium/src/components/ui/input.js\":\"5cb38a68d8227104\",\"/knowledge-medium/src/components/ui/kbd.js\":\"586989dbc75bc965\",\"/knowledge-medium/src/components/ui/label.js\":\"57ab432bb6a74896\",\"/knowledge-medium/src/components/ui/textarea.js\":\"16ec56ec1bbee372\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"3427d658c517fb8a\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"2178c97dc3e6f191\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"ab4ea423cd1a4a95\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"da3c4e0b65a306d3\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"124a4815856c9eee\",\"/knowledge-medium/src/components/util/error.js\":\"ba6c1ed8f1202209\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"d69d74c5684321bc\",\"/knowledge-medium/src/components/util/suspense.js\":\"26fd8956e61040f9\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"892ff99fa7c51955\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"7898a007f6889189\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"28e6e8770aeaf59c\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"63ad915edd7b3b17\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"be6f0bc99d28ccd8\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"e1c51f470d073862\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"7a89769e56fbd098\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"e4cc79a02983f81d\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"7f3980d955a83015\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"ac2a3ca080976015\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"ab27a595f03f4a21\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"fccffc712c8b9747\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"6893ac1237319e12\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"9c1c6c0e67b25e7a\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"0e0d2fbab54b214b\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"f74c0fc4bce1715d\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"9878406a85a2c4cb\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"c320a727f0187211\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"07b6b2b30cb99a2c\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"0b9e1638dc4cbd15\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"8eb78ba7df07f3aa\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"9db2cfd41d65c5fc\",\"/knowledge-medium/src/context/block.js\":\"9badc082d088203b\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"eec49be07cc1c26a\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"7fabe1dcdee1dfdc\",\"/knowledge-medium/src/context/repo.js\":\"fee2b139d0afad7e\",\"/knowledge-medium/src/data/aliasClaim.js\":\"89adfc9ec89016c7\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"ea61dffd6c6ae2fe\",\"/knowledge-medium/src/data/api/blockData.js\":\"9e4906bdf125334d\",\"/knowledge-medium/src/data/api/blockType.js\":\"f0b68990e613c2e0\",\"/knowledge-medium/src/data/api/changeScope.js\":\"0c500a961a12f8d5\",\"/knowledge-medium/src/data/api/codecs.js\":\"52ef00aa50795f0c\",\"/knowledge-medium/src/data/api/derivedData.js\":\"eea6450e99f575ab\",\"/knowledge-medium/src/data/api/errors.js\":\"7c6d8915b70a8cac\",\"/knowledge-medium/src/data/api/events.js\":\"58cdaa6ce213eb4e\",\"/knowledge-medium/src/data/api/handle.js\":\"39bfe02f2676accd\",\"/knowledge-medium/src/data/api/index.js\":\"57dfd9a90357263b\",\"/knowledge-medium/src/data/api/mutator.js\":\"8dbe989b830731be\",\"/knowledge-medium/src/data/api/processor.js\":\"ae7cd7ce4de719cc\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"030c12a8debf5878\",\"/knowledge-medium/src/data/api/query.js\":\"ce8ebe5169d810a9\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"8e84161b9a7f48d2\",\"/knowledge-medium/src/data/api/schema.js\":\"39bfe02f2676accd\",\"/knowledge-medium/src/data/api/tx.js\":\"39bfe02f2676accd\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"51f92fda9efe951f\",\"/knowledge-medium/src/data/api/user.js\":\"8ff60ac580273a00\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"bb834a52f7c42df6\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"f2749eab417ad24a\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"d8ae44792746e12d\",\"/knowledge-medium/src/data/block.js\":\"180cf3ffae359a63\",\"/knowledge-medium/src/data/blockCache.js\":\"3366dadac44b831a\",\"/knowledge-medium/src/data/blockId.js\":\"044c7e3163723b86\",\"/knowledge-medium/src/data/blockLiveness.js\":\"e9129ffaa4b7cb03\",\"/knowledge-medium/src/data/blockMerge.js\":\"78843ac74323b8de\",\"/knowledge-medium/src/data/blockSchema.js\":\"170eda84be36f5d2\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"24965bd60e1bb18f\",\"/knowledge-medium/src/data/blockTypes.js\":\"89a1e0731d5fabb3\",\"/knowledge-medium/src/data/childrenView.js\":\"0d0193493574df49\",\"/knowledge-medium/src/data/clientContext.js\":\"6dc9cfe075b5751c\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"0e087e816369b79b\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"b6d0ffdab23202ea\",\"/knowledge-medium/src/data/derivedIds.js\":\"f5b42b6135c89718\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"aca8c8efe395f26d\",\"/knowledge-medium/src/data/facetBridge.js\":\"8ece0c0de460cde3\",\"/knowledge-medium/src/data/facets.js\":\"a40962b03d9b09f1\",\"/knowledge-medium/src/data/globalState.js\":\"1752e716e0e5c1c3\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"172895094b0aa90e\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"8db75a5b3b8255c7\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"6ecd77d0ca1433dc\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"2f1a8f90a1dd7000\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"001a29b58a85684b\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"cc75ee1961606091\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"3be25ae15127340c\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"458a9a536f48ffbf\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"baf218ea79cc5560\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"f9a74621b6d671ba\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"31ab57422cd96983\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"2777c1a19f0eed79\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"2002afb9f9463265\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"6ef70210d2bc0203\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"2e92ceffae98d399\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"bd0b4e5c9817072b\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"b8e5ad02ed858956\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"09bbbfff32de7091\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"c28cba426e92e590\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"598ed3c510fce4a5\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"d39a7949f086bbd8\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"042e3c3fbd9b4e4a\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"11a92b92aecec3a1\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"79b206778ce16d05\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"f84dd1ddf8185ca6\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"0ba603b1f63ac0e1\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"e8b8c2ba864a618a\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"d228c8286664de2f\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"fabdaf2e7e75dff5\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"f05299e02303be2c\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"2007db867b88684a\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"21c091c04d2ae864\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"e2dd0a35cfc4126a\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"a4c93b38c45ab40a\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"c45772697ee13300\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"26daec71d3ce92fd\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"f998b40df24e97f5\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"12918e392dbeb721\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"eca9fb8764b6eb2a\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"796defa83a888e27\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"6429889e5d4e8336\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"d6f40cbb0e3db771\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"4a98afe9d9576193\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"ecba4e49e48f6aa2\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"26b00941a527b5f7\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"4f3d5f035a913db1\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"7a603692f3a550ce\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"9013d3eadc160c57\",\"/knowledge-medium/src/data/invalidation.js\":\"9eb6d78d6afecbe1\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"7401fadd41a8f825\",\"/knowledge-medium/src/data/kernelPage.js\":\"2d4d0a34b616125a\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"8f241316ff9c1164\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"2e8a9b420ea153bd\",\"/knowledge-medium/src/data/localDbStorage.js\":\"d94257127d2e59e6\",\"/knowledge-medium/src/data/localDbVfs.js\":\"36dd0043e730cc23\",\"/knowledge-medium/src/data/localSchema.js\":\"a00c907935fb96fd\",\"/knowledge-medium/src/data/maintenance.js\":\"98039704349a6d40\",\"/knowledge-medium/src/data/mergeProperties.js\":\"d608dd64a5de91a7\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"031b48fb538265eb\",\"/knowledge-medium/src/data/migrationsPage.js\":\"ee50f36eca5468de\",\"/knowledge-medium/src/data/mutators.js\":\"86918aedc193719e\",\"/knowledge-medium/src/data/orderKey.js\":\"2328e36b79f318ee\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"753e36465eebe394\",\"/knowledge-medium/src/data/outlineSurface.js\":\"24b53ea273cc38bd\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"7c36b2f699a1f21f\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"9346999c510f8e1b\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"b5dcc1589ff45eaa\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"8e10d5fff0160b7c\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"480250da593439f3\",\"/knowledge-medium/src/data/properties.js\":\"c06d39d91b2f2844\",\"/knowledge-medium/src/data/propertiesPage.js\":\"fbaca2e91e43e7bb\",\"/knowledge-medium/src/data/propertyChildren.js\":\"5042a333fd89267d\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"0cf576e1a49b9f01\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"2efe0298be46d771\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"7deb383597ef993f\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"7e43576c9042cc65\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"03fe18542d249841\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"ce8e27e61c446ad2\",\"/knowledge-medium/src/data/propertySeeds.js\":\"b5eb40711e3a3ffe\",\"/knowledge-medium/src/data/recentsPage.js\":\"bc3cb22c2de282f2\",\"/knowledge-medium/src/data/referenceBlock.js\":\"16f8b541dc726629\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"aa81ba132fd1739b\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"d1b64367e1e09367\",\"/knowledge-medium/src/data/repo.js\":\"fd598b22833d2bca\",\"/knowledge-medium/src/data/repoProvider.js\":\"baecc58cade86a07\",\"/knowledge-medium/src/data/rowProperty.js\":\"ab84480800bc6cb1\",\"/knowledge-medium/src/data/searchFilter.js\":\"cbf10ab9b6003555\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"8cbd1bc1baf27ebf\",\"/knowledge-medium/src/data/stateBlocks.js\":\"5913a949e937bbd6\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"a70a9cbfcf40ea89\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"bf2c2cfabbed70e3\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"a8fed64f3db6780b\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"b1d7537876a0bb83\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"5c8dc084bb18444c\",\"/knowledge-medium/src/data/targets.js\":\"fba38266dcecf80b\",\"/knowledge-medium/src/data/typeColors.js\":\"6495af34842512b0\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"22db0bae1957b05d\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"5bb4622872ab0ccb\",\"/knowledge-medium/src/data/typeExtraction.js\":\"04902f8d6c4ac511\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"683b7a694f16eae5\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"0ced9ec65e92e8bc\",\"/knowledge-medium/src/data/typeSeeds.js\":\"6e47dbb409284d69\",\"/knowledge-medium/src/data/typeTagger.js\":\"cdc812e7f9f766db\",\"/knowledge-medium/src/data/typedRecords.js\":\"ce7075e1d3376628\",\"/knowledge-medium/src/data/typesPage.js\":\"753bd24db2004f70\",\"/knowledge-medium/src/data/userPrefs.js\":\"384ea9a34822bfd0\",\"/knowledge-medium/src/data/userSchemasService.js\":\"f863dc78456486ac\",\"/knowledge-medium/src/data/userTypesService.js\":\"c70a973445bf0381\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"7479d4d9e3c6fc6a\",\"/knowledge-medium/src/data/visibleChildren.js\":\"6cedff0425484c23\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"cdba9855c299044a\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"adc0a911426b9d21\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"3a0536f40808a1d5\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"7990b98331a045bf\",\"/knowledge-medium/src/data/workspaces.js\":\"b9fc0f2cc8eb137d\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"eb4b2729486379cc\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"3519a7ff740536a3\",\"/knowledge-medium/src/editor/atTrigger.js\":\"2b52a27808290f15\",\"/knowledge-medium/src/editor/autocomplete.js\":\"85f39888a1db2faf\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"cf61af06d6c08d8a\",\"/knowledge-medium/src/editor/contentFlush.js\":\"278147c2a95bf7d9\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"00ea7b7abadf8171\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"2f0e095e7e9d8393\",\"/knowledge-medium/src/editor/insertImage.js\":\"38f1da07d8ad2edb\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"f103ce19f170973e\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"5765295bd6dfa616\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"a5caa0a3cb96f6bb\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"1d2f7941c1b9c7d2\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"976e82683cdcadc1\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"28a6a9b66c569125\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"1b499862a6cab68f\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"e982affb63b7a1b8\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"fb4c80832012ea81\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"9dc8ac7ae2ce6f72\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"e7bcbe0106df079e\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"38a5cb970ff07c6e\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"0da684ee62d84e57\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"2b429923d53a7814\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"d9e71c79b81c2136\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"4375cc7b8872cfe2\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"182792e33407e39b\",\"/knowledge-medium/src/extensions/core.js\":\"e5f64b66d66a174a\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"532531033bfe1d46\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"f590f2fe52e8fada\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"2507f95bc8a879ec\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"90aa348001375691\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"9507d7e2675300f6\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"713ddf783bbf3831\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"c06f3985f3f9d861\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"85a23d88e48d1133\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"1d9d762e4d6e849a\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"36fc3f38ea1edcdf\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"f002bb4d52afd20f\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"20a1624ee4aef288\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"70be23d8e55ab562\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"083c9a652b1e308b\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"7ceb52d667917d2a\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"8ab7489ff1bd9f45\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"15d31d454e758540\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"cbc08c1faa124989\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"0184b7304415b291\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"0bd2d1e98c4964a5\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"2e7cb75f539f3f9f\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"efc9adc031e12f09\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"970699d9abc2e117\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"dde03bacbab52a39\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"783f7b7d432cb04f\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"aa20af40b58f8264\",\"/knowledge-medium/src/facets/facet.js\":\"64370d10b59ff832\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"f1002c7b303dfaaa\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"798767635a57991c\",\"/knowledge-medium/src/facets/togglable.js\":\"f04903b79abb7908\",\"/knowledge-medium/src/facets/variantFacet.js\":\"e5af1a5746bbadbc\",\"/knowledge-medium/src/facets/verbFacet.js\":\"e2ce0a717c7c8cb8\",\"/knowledge-medium/src/hooks/block.js\":\"3fa2f5b756728684\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"05c0e1e552b9d271\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"0f6a14fd789ff9dd\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"7c13f9250ffc8c95\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"c18bdc5522218954\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"51bb3fd3a23ea5ae\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"a2124548b9d3506e\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"4ff0284a10283190\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"0e2d7d0225549984\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"18337f07e3583a6e\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"73d0932ccec14955\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"454f5996574a6d3b\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"5e08fc3b71a73b21\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"4bfb1aef58b78e88\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"470dde356c6e1a1b\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"242d5b8be696a0df\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"d78477359ea53338\",\"/knowledge-medium/src/lib/utils.js\":\"658a7574cb65aaba\",\"/knowledge-medium/src/main.js\":\"b51fe564105d944c\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"269656154c95c46e\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"9bd66ae31ae49c48\",\"/knowledge-medium/src/markdown/context.js\":\"640e83c753ec0e8f\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"c07cf945e3654e91\",\"/knowledge-medium/src/markdown/extensions.js\":\"683ca7cdaac386c8\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"8d71e22357aee0ab\",\"/knowledge-medium/src/minimal-editor.js\":\"feb01b7beabbce18\",\"/knowledge-medium/src/paste/armedCut.js\":\"de3d60b8eb1c3ee0\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"5a87d57e5a8e7fd9\",\"/knowledge-medium/src/paste/clipboard.js\":\"f13526aaddf6c080\",\"/knowledge-medium/src/paste/decision.js\":\"5c360e095f969f72\",\"/knowledge-medium/src/paste/operations.js\":\"c6f7e10b17817aea\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"e9e2bd625f22b73a\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"7938bf25ef5c4a5c\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"45253b8c4c4ab48f\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"bd2fd4ef1a7d115d\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"3da08f2a1774a6e5\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"177d97ba62fc54d8\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"7bbbc957dadb6565\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"14b447e75f3ab8b5\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"abf2cb22b702c198\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"de80072e2caa254a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"b269921c3f99f0fe\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"e98a9187130418a7\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"8f2425039ab0fcf9\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"1dddd04d3420d1f5\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"4cdd11c89456245b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"93927200f98c2714\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"4a38870333127abf\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"0294ec6ceb292afc\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"bb1acfcfb20cea62\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"053d3792d29b8c88\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"f67893397338bf35\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"475d551f51ea66bf\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"2e7ec1b40b939513\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"2f59baf53b4f6ac2\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"20546c9a201c5765\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"93efcfad094d5d42\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"8b18c4e2272229b3\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"8db0049e3dfc60bf\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"d582bdb164526c1f\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"02809fe9f2d30de1\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"21d542daa716c02f\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"2a3309bcfa42e27e\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"854aa317f6d4eadf\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"7845c18240ef2299\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"5c97ed62abf119ed\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"fce6bd989b50f70a\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"3912cf7ea9c54b38\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"baa3ca3d76c7a933\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"48f631f4c1c5273d\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"16ef305dcca1678a\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"d1c7a9e75bc5f0ef\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"156a9d0918cf27d4\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"34f908c47d57c88b\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"234328b0af69421c\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"7ca50beb8fef3a48\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"bd3e19da4ffb5a58\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"cf1d9836ae11fc26\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"372ea9d66a4b9753\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"79bc8e83bbed18a8\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"45751ee5a7fbb31a\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"26c93c59031e2255\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"fdf183b7ee6a914c\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"4a0d9d35ba490632\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"0a75a86371e3defa\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"c018e0555c170784\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"28725aea43812333\",\"/knowledge-medium/src/plugins/alias/index.js\":\"c8df8642994cef8c\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"401707abf4745e5e\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"8ceea9ab6290dddc\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"132d8348436bf3fb\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"d091ec653b8ba1ae\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"156decfbcad6cde1\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"a4370611adbdcba4\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"fb7294dbf84c693c\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"1fea5f893a3c1a7d\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"8f5157021bee8fdd\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"2792457dac7a9b8d\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"54fff47bbe1c7baa\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"12a7f244d09c5c90\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"027759bdcac61c0e\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"99f2ac9f0e5faf3d\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"2b3f4d9eb71ae6c6\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"1bcda1d427948be1\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"109e7c850693368c\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"a3cfa226be150323\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"588efde1c150d909\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"74a9728c66bd04cf\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"1af7eff3d4ef90a6\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"88a7f6efc9e59b6f\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"515ed21db6fd95bb\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"2325c8eb61e515bd\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"78b0f26617634214\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"f7ee0ec70e353343\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"7c788f890b7c81b7\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"1092ce895d5ead1c\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"52f26de2c2bc5b75\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"b10031c5aa29c1db\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"1e9ae85adf042bac\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"289fb3a796fe9106\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"d1d1c3e0b7fc94f5\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"7da28989f9e04d44\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"7fb50502b1b59d50\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"46d3bf1e3a92d2be\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"47b318da56546d47\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"2b5fc85dccce359e\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"511d24bb37f44e03\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"fb4b8ed3668f2208\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"3c99dd7808fb2e5e\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"2924d4d563cce90d\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"c13eec36a0f77577\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"b2048ef554899bc2\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"83f74ac2b188f815\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"287f1be4c36b5621\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"3a84919d3e7ad009\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"4d29a8284f8d7702\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"90261309e0227deb\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"da03f3d09dc83794\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"09130e372770c1e7\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"00d08d3eda75ba7c\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"9848da25bcf1ed9c\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"85cd14f83f2d879e\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"3d6e392c15526269\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"76c0510f3f13a310\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"feb8ec2f6d26d1c8\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"4130db1c2a1909e8\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"3d1395ffa3aa6666\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"5a8e30ef39e09691\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"2e956b294e04c379\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"c2a8a50bedece6b0\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"d5b5889ffc98e3ff\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"250beb93ac2c6a9b\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"7adfe9ce38f3b537\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"69408ae1859718e8\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"2ce922e90f615c97\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"3e3d050c0de3bb42\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"3cc117012d83e301\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"90708845dca5e8f5\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"54dac589513a6eb1\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"b76b6e2b24b66f1d\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"8c2dee7b4b931f28\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"294213a13850169e\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"74cc3f8e71bf45ab\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"19643abb6cb62ee9\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"b1bbe2268e402d95\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"679ec020afba1fac\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"eba97bd80e15fc81\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"0472ce53a3713236\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"e3385689e06f30e3\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"dd96348722af2f49\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"5d04b1a440392a77\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"a81d3618c4a41234\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"3c4b7dac1f920de1\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"ef008510b8ec2afa\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"b79bc62a525af770\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"92123ef1f66cae28\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"5859a64b64136c69\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"deecedde9c5fc0bc\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"3db062c52dff3703\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"b2c2bcf7c76a0d9b\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"ce20f7b6d72bf7dc\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"60eec151e486b3c5\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"6de995d59d8d96f6\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"270d9fe76885b603\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"82c06eb195d67ad3\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"751ee6268b7fecd2\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"8c7fbd973a7fcfab\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"c922308d0f69aa4c\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"9bf7598c8194c555\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"12257c1e7e6dcc4c\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"6580ba2e159f8757\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"1b13d95274f23f6e\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"fcce280f17a05f37\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"1e586e2dd2635c7a\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"49b90f8ae486751b\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"0130b79f1e3eff39\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"1f491b801c389675\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"ca009dec75852f10\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"f7136fe62918d94e\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"1edad228dcee0036\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"203043d4983087b6\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"9f091a39833de837\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"6a02dba135d13d93\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"d3147947d0520811\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"057d7434049d2933\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"0b3b00c1c4d20c7c\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"86bce20f0ec7411b\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"94cc4059a8731ca9\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"45fefc45e1848051\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"732b404346520e58\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"cfe7502c675af120\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"5b6e325d6334b54a\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"039356fc7018c957\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"a88fd04679f41378\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"ec9c7bb5af33baca\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"dd561f37154f9900\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"cc9eeb44e569db6d\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"c438b2095fdc4d1f\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"c82f6546f60ba743\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"1a8388fa43b69d49\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"72f6221cf2a16fb8\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"3405742b6fb1f3d3\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"d152fc10e2aca031\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"af96b3ca1495e2e5\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"358fc0332f2769ba\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"bac9190a7f976b7e\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"e79d0af5c366e71f\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"da0ba8f1d61542c5\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"8c90ac63e7bd44c7\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"9bd9f4805251faa1\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"6b10e81955e42907\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"06a6bdaeb30740d4\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"b06954975f515125\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"6711e99c6c4df086\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"a109f1969597302e\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"89535462ddd6fcac\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"50462a06249206b1\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"9f3d58139e2c49ca\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"608be77142728e72\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"1449c70f82a631fe\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"7ea1c0a23a6540d6\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"0d9d38e05f2c1c6b\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"175a4cd50b27ae62\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"66837656217909d2\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"a35c8d2b065ba463\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"10b58a2f91069560\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"f610a5cf1442d388\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"30e7f84c2710b887\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"dc58f5ebb4c9c058\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"35d73bd8be4a1ce7\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"b25e38eaec885347\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"7a196d3f7c9361af\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"30d459a08d49f988\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"a27f759904da465f\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"4746179b3e0f1ad8\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"56ac2ae9c81df906\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"01973a1f7daa77f0\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"e51b89aba311e335\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"88cc66748bb72ad7\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"4b6b47e68f308d8f\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"e42d573dc263e6e2\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"60a5dc124d59b37b\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"41b724b3c926c19f\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"249161a710a379de\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"7e60e83c8e586793\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"37a746697a741189\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"22ccdea707fc0fde\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"fc4f4ce1f7067e76\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"ffcc432bcdb15364\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"b526e3795d3ada56\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"e789bd542bb31676\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"5b2598e33ca659ad\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"0fb4417be0770554\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"09651a0b678cbd4e\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"3b5669e17d44dcbe\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"26c91fcb2a8e0433\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"e167118df8dfaacd\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"4841e63c7b21f167\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"08bb382aec10d9ac\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"f96d3dcf085412aa\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"1b3781311c5caf8f\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"0095223df9de4e79\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"dd3f8f120f7fad1b\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"9dc728e537d63129\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"16297941e1703088\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"2d4bec4ac9cbd108\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"8c299f730d7f9e33\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"587ce27ce98993dc\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"e150da141ba8ad8c\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"d2e8c890b9edcbc2\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"f73b1d2027be9252\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"078486fb71f35191\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"bd0882b1a132d863\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"f6af5216237eec24\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"0157a4bedf59deb9\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"97796816c6a0c8f0\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"9a3288d11917f58e\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"8b573fd9815c5cb4\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"cf2b53b0fe6e1192\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"008d8e9b3449b65f\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"17b658db4e89d5a2\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"6fe3fa76a18c2c5f\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"72e7f2aa3de52132\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"39b05e1d68ace3a6\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"b20eed18bb875d5a\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"1a442d00d02e4398\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"72064295e12d33ff\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"fd6a9df3f12a14ab\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"ac688dc42b859fe3\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"9f34994baeb5a5e5\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"9387e4c8ce0526de\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"36621fae2d0ef694\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"5972b938f09de614\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"d2399f637d01a8f6\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"70f955001b42ecb9\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"ad51a50cc0dd0b08\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"32ce7c189f3eb459\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"21c11d99e7526e3c\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"62a452bd71b19067\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"0dbbfe36887ffe95\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"12551695faf191c3\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"e6bae8c3e09fb7e7\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"8dcd3a1944391fbb\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"220c3b2ec83c0a2e\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"5f9c2dc85a9bcf2a\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"031c3d913d894173\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"e4a82b2a605d8b91\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"6b00b46aa945ad24\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"2f822059cea272e5\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"a43f6ccf9d97a0ab\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"09735cd62359c574\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"5a8a5445d7f04337\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"bc399ca471c0688d\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"f10f85feb076c25a\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"cca77a85d4e0dcfb\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"43ad25e4eefd9240\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"e301bc2549ddf819\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"b649ab61389cf909\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"f0b0f010165a09d4\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"f9c2af75bb663815\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"816ff6e5ecfabb82\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"83c68ce9e1867618\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"35922a5a39013629\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"16b2818f39d89238\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"3f0f77f2692458ab\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"18fae1ab9c2d964b\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"82fd73481120a4b7\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"dd3e2f03bf5fcde8\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"711ed3d705168bf6\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"7a1d826562aa8d7f\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"d52918950fa0f0f2\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"22035d99f0f36b2a\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"47fd98d7e90ecd3b\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"e677e03cd7bd9d6b\",\"/knowledge-medium/src/plugins/geo/index.js\":\"c583daccdd0bfcfd\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"547037bc15584bc9\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"94eacb23ca227426\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"a95fe60170d8861f\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"c9c7b16a297b8756\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"f94527bd5ed6c88f\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"37d929d817275a91\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"267184adde2af52c\",\"/knowledge-medium/src/plugins/geo/query.js\":\"5804d6899689f63f\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"3b62d21b6fede052\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"a6c562503a098e64\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"21b57c17c57e7a34\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"3e77dbd254cdbf5f\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"343e66d9b101862e\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"c2a945e6e6b797d1\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"99ad12c127cdacde\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"fa5f9ef18c93a7fa\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"f5015eee9e391280\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"2ea26d1e5dc49968\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"2bec299c2f6f762c\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"f2ff02d205486870\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"72ed45ca788c3ef3\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"8e7df5d52d400524\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"fe0400740f230f93\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"4461e499c3951fb3\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"9b2b5226c9821275\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"810e5f65c4f9f035\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"fe6fc6faed64d469\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"fdeea10cc4a63615\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"778f1077967d5411\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"1ac8c697e81ee37c\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"edeb2d0d77a07f99\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"4865777057e4ca2a\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"38c927a88d06b22c\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"9c2e7b6a0b935636\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"989e83c949faf3c7\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"de7ec0f86bbb3bec\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"45ffb140d509255b\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"5c72b3d89306d530\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"3b29fbc15f87351b\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"69af417ab8121a4d\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"a30b29fef3ac0631\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"f912799462aae78f\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"14da3cb9cd37e777\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"382d10b08cbfbfe4\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"62bd3780e12f57cb\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"c3c532d68ca332e6\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"9ed57702feb4fad5\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"c89f8113813f8d4a\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"77ff069f6232aded\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"19d665f559c6bd61\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"5b798b768f455eef\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"decad311e288e4fd\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"519088e3fc70c20b\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"73a05e513f5109dc\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"5725ad96e1251494\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"1476ff604a221500\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"b23b9c6f01aefb17\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"c974c6a2c073fbe5\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"5f934f593ed2a3f7\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"8eca46d8d31a571c\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"12d05eb9254afa9e\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"57bb6472119e5ce4\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"60340174fcdca2cd\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"f229a9faf9005e67\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"5fdf8b17c93c2a20\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"8c36071a986c5b26\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"221a209a18eaaf97\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"cc1c06539420fdaf\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"1f2506d750607934\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"56772c79782c9483\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"7318514f0627fbd9\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"c15e18edd49057a9\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"a770cfc187925473\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"d459df2e7aa69f95\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"1f00e28cc6d7e600\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"affeea7847e71527\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"30565e8821f5be77\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"1cca9a6ec30ca1a0\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"09772f2f7df63f91\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"dee01efeded4888f\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"34a9c06bbd9232de\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"323f9c7ec4c8f7e2\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"a0ee4e08e376e29f\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"8e5ba811b53b1be1\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"abb54a7b3adab8c8\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"998cb520a5097723\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"14e2c87834f11512\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"ed443ad6cda8f0e4\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"8af39bc304f0364a\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"1439192065b8cf0c\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"a4ad3d1c412c154a\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"0f4c6340c1a8007f\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"24e2c126d1a924e8\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"adb57b583ee5b247\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"f225869cf3896c2c\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"2155c244ead065f0\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"0d49410b93bf5eae\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"2346b8c68e679b7b\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"948c98cae210a57d\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"c759b7df68f3cb4a\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"e7b59c9b4c907a1f\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"e7dc96e6cc4b948f\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"31743204c9574326\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"89db0f4888394cd7\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"7ae657c70debcc8d\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"2a416364e0fda51e\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"5bea2fa571e57d94\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"f35e952b6e82aef6\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"649d7d9fa3c64e41\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"5c90b6a9d3aceaf4\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"04779200754548d2\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"16a7c4fda8864dbb\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"3b02f5d2217eccf8\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"ba8afeb297a77dc1\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"bb971d636761ab24\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"1ca2791ed3faac5a\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"0babe741c8a865b0\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"d5c9f0aa37896072\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"87f276c5a5191302\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"08133ab260087833\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"b6237e6fe22f10a7\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"553c916b5df6342c\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"a64d0caaa6d06510\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"318872bf158f7a5c\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"a99cafddacc9a5ff\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"8990ef93ee04c182\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"5a5037f16c10a739\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"fe7e5b8eeedf46ec\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"e3307ada9740d038\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"ad32f0601137b480\",\"/knowledge-medium/src/plugins/recents/index.js\":\"5c474e561e70b43e\",\"/knowledge-medium/src/plugins/recents/target.js\":\"5648b49130665e36\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"a6ad64f19ebf7a4f\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"753dba8479be8658\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"2a3e8eca77a7813c\",\"/knowledge-medium/src/plugins/references/index.js\":\"813028471d1f7a19\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"2c0cdf2935978536\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"948b588e57501adf\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"29c756063e46c616\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"5b1e583e329fce08\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"650a928b6ec05ac2\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"21d7bab35d7a592c\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"257bee2a24c8cc23\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"c3dd26e5bee3249b\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"5f1dadd678c85074\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"da9519d29522a58d\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"794a4c390c3a8674\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"1716a8d7ba04c29a\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"c2b9d5efc3a5eb67\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"6bd5470757e87502\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"ab71ddff431a3107\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"9b80d98e7b0a4c05\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"48f3cbd2493c813e\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"e632223af55183bf\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"0f1f635d66afc495\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"60d94ec7fc8ea6fd\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"956b862ceee25730\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"d9e028ced4aa90d1\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"8b4bb797510e0411\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"5d131879e3c69279\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"c3ff85828a1a0a69\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"ece49c4acf4fe5b4\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"85b8e5c3ceae0993\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"890be141c1c1140d\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"137081a76b610444\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"42972800cf70d024\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"ada3f0589b6f62ef\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"1fac1daf88d56c36\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"725c5f907df2520a\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"8dbf5454bda499da\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"c9203209f89c16b3\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"fa7dbabd70ab2fd3\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"a7e9d9730d74cdf3\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"5f0bb3e75384f5c8\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"3c495e429efb4cd3\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"08dd70b0b620829e\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"71f6092af54568f7\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"2cc986bc06c60825\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"96b3af99ca803023\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"7d166048e7f7ed57\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"ea421e20def6c4f9\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"367783e0b7bb57ee\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"e4f684562f47492f\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"784de97c854537d6\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"c47ce516503de9f1\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"88b5b61df6ac2e93\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"9f2ce7104b4846d4\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"fff603fa2979a1dd\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"477a821e9ea9d331\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"af71ddb272743ba2\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"cc83a0e057c7e183\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"708a14c08b072534\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"016c80f6993b315e\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"fa4a5d34aa7be8ea\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"31135177408f2f0d\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"4df530e2a9d5fe07\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"0aba58d5b182058f\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"cb932b7f922d0945\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"2355040ec5b83ae3\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"17d8be320c10c174\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"d212f89953320e00\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"c23be7289de6595d\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"9da92d73a3a455b3\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"74260b76a5dc401b\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"1964eac2521442f4\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"5f4cf6a4a05ec18c\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"71c221c7ac2f4465\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"d454b174f470ff82\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"b023cee9320e70fe\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"789298b9f70a29b6\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"af451d61a5254d1f\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"1fdfc8f339346fe0\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"ce52bd39f0e7d953\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"82e74f61d41864ee\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"1442973522660cab\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"2e051da0599d1a1c\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"53cc8a23febdb264\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"d670c9b565bb5d1e\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"14a615a08574e237\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"0058cc0068f112b3\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"d377239aaaa10d47\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"d3ae7fe853750f85\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"5d3f820de27dfc2f\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"94c138d959228d18\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"572dfbe56985e1a9\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"a97ea24515cad7eb\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"84859eee0418da95\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"0ed40b41de565a42\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"17d5a042a0207cdd\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"0083ced0bfde01ab\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"3a5731bbb040608c\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"c494db223b3a4e40\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"a8eae3ca375e1702\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"136c424c23fc86c8\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"56f9cbc9aea5ff23\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"66d1b25723893899\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"9e2ff848492ff9c3\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"49adc68b5562e32f\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"44ffec68afa7c5ef\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"779e70d6d826f209\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"413c2d93453dc22a\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"a9657b7fc4010552\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"911ea19117727d2b\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"db42a1c8c8e82c57\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"1da3431dbbbc7b7d\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"391f8126591f1fd8\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"d6a7f210fad73c2b\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"acbf3d55a53032c3\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"e34ee8553471ff68\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"3bc6c4e9721555fc\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"d53a8d3c767e7a2d\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"775e90d3d767c013\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"60a4f0ab6db047ca\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"7f6d09fca9fe094b\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"d7f3bed416566794\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"b2745be1a70e48d5\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"e45b9c4c98123357\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"7be3e56f40d0c61b\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"e4d0101abcc640f5\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"8f8af0f21a10a827\",\"/knowledge-medium/src/plugins/tables/index.js\":\"54a6602b8962c320\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"0172930aca3dc375\",\"/knowledge-medium/src/plugins/tables/model.js\":\"9d9fa86c27dbf57a\",\"/knowledge-medium/src/plugins/tables/navigation.js\":\"aa2cdb2d82f494d0\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"b8233e06852522cc\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"7aa8e92203b43527\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"b7963bda09522a58\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"bee99b37431ed224\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"69096c33c5d2876e\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"84813231d017f78f\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"800f0cc5ced29ff1\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"3a14adb6823838e8\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"4e543730e029ac69\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"b78aac1c48714b10\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"59c298d6cb2ea743\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"45ddbae099fe1125\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"79e69d11d1327bb0\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"19eaa9d9806a678a\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"d794af56ecbde4dd\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"578543243880b374\",\"/knowledge-medium/src/plugins/todo/index.js\":\"396fce86e5b9346a\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"8acad3daedf5ecd6\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"5e563d46e9fe4b74\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"256e99daa8e473b3\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"e42e6376d497a343\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"f0033014136be81b\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"8f3bf7faa62032d2\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"b7a68e473c51adca\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"38835f521b7fc695\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"408e0ff5112d2601\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"0cae8eeb543e46d8\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"0e8a51af2cf438cb\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"f93cc2d441bf4aa8\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"a55eafd570dcf51e\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"24c02fa496309516\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"5ff6b81630ebc8f0\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"23c34d686b30d775\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"f053495b95dbd64b\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"356f01ab94e7ce91\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"c55047dc677be344\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"a471d845983d78ee\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"b3c1c7c54261f447\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"303c7fe1826eab96\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"49c1c12d79942cca\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"4173b69de14f9bab\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"e550fe43a0a11bbb\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"3741271d87a425f6\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"aa06db5d89fe0d34\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"dca599f4fc3eab2c\",\"/knowledge-medium/src/registerServiceWorker.js\":\"bc62d1f4371bed65\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"892efe586a67be9d\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"72ea321e8dcc3d22\",\"/knowledge-medium/src/services/authStorage.js\":\"42dd4a5b33e51fcb\",\"/knowledge-medium/src/services/powersync.js\":\"ac26d2a9b1618d8f\",\"/knowledge-medium/src/services/supabase.js\":\"a5cd9a22d58280bf\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"4615c083b2eba0e2\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"cb8aa69bc8cf3d67\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"a7fdda51f60ba8b7\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"29e526c86aaf6aac\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"e57ab89df6ab4d13\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"dee4e7f7c7c6455a\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"60fbcac4c860e4ea\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"42ef6bf8829e5827\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"3222e1f8b0237393\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"97b76ba647551169\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"2b9bf720780113f4\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"32a017f6aa64c1db\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"7962cee8ab8da5cd\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"08b97640250da2b4\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"d4dec44c6fae539e\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"7b86bf1d677ed4c4\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"cc919d34b4a24b9f\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"b5873f5023fa462e\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"988b1513de04a847\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"0c8ad07aa97038d5\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"1c4a08c955f075cf\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"1f57dcf2beefaad6\",\"/knowledge-medium/src/shortcuts/types.js\":\"c6d9d9386d8c58a3\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"ed9c93a235a2afa6\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"e80ecee5e1c1ea21\",\"/knowledge-medium/src/shortcuts/utils.js\":\"d35965fb0f8924e0\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"927baf6095c7cd87\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"4f42d01cad85c71d\",\"/knowledge-medium/src/sync/byteTransform.js\":\"4aaddee533c2a064\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"729a2abe44f68306\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"df458c2b7c0ef744\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"4aaa14a45875d320\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"8bbdc007a704f24b\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"ea64becbcfd5affc\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"03be5ba4c3da215e\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"e033db1a7434f1ae\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"022599ae8cba94e7\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"f873102c7cb5f0ce\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"c6b4aeba6e9cd498\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"5110885e205a7ff5\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"cd5f6711de720634\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"aae190cc0fd718ca\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"b95da29c1c8636dc\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"9f59ad4b7cf37099\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"252875a8486166b5\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"f5b7a72982bc32fe\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"17b278a838ea6131\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"cb93b26329cf2b75\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"391f4b17e840acdf\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"2ccd3fc726f69023\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"37c5a8b0cef375a6\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"b7dadb8d4fb3124b\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"2883059aad63f675\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"d42abf932388df39\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"1c595e5149d02e5a\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"fe1cecb0a4a43c66\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"5e411ccbdd35edb6\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"aec4220c3da48080\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"5dfb3f855be13a98\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"b2009669393bd601\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"2aa3c63aee811cfb\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"998d677e2c73c6f6\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"c79f65e493bc6467\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"4c8c42d8bd1cc53e\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"62eac72fda89171a\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"0da0dccaab604686\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"d39b118a79482be2\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"90b54654738c250c\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"09af6a0528e18add\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"0869039fdff4c955\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"5828a70c1820bb7d\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"e98197456732772f\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"5858ff7822b25abd\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"1f6bf2c482e97394\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"186e8cb0714ee055\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"b94bc8daf28276a0\",\"/knowledge-medium/src/sync/transform.js\":\"6c9a772860b3ef2e\",\"/knowledge-medium/src/themeBootDefaults.js\":\"79cad02c4f20de81\",\"/knowledge-medium/src/types.js\":\"5decf139777ee833\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"adcb34db2e3e5992\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"98ce9dc8abaf62bb\",\"/knowledge-medium/src/utils/array.js\":\"f4bc1a09ec77894d\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"df30469b66793ba6\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"2dc34834439f7421\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"c1c2e2de1ba57cb7\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"1fca97f468c47a31\",\"/knowledge-medium/src/utils/callbackSet.js\":\"3021bb1d9801fdd9\",\"/knowledge-medium/src/utils/clientId.js\":\"450ff1b70140bf71\",\"/knowledge-medium/src/utils/codemirror.js\":\"0cf1edb6ae374902\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"4b35195e184ea478\",\"/knowledge-medium/src/utils/copy.js\":\"83b70c08f4441b79\",\"/knowledge-medium/src/utils/dailyPage.js\":\"0c1cf7d385f26733\",\"/knowledge-medium/src/utils/dbForensics.js\":\"9beefe7632fdcf11\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"2ea2b06458609798\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"1cf9843ade02b8ca\",\"/knowledge-medium/src/utils/dialogs.js\":\"9b809a5934836b9a\",\"/knowledge-medium/src/utils/dom.js\":\"0076cfc6e6827374\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"4d02bcc39b3eb4fe\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"ac83e2d667dd6e25\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"1871d20583c931a1\",\"/knowledge-medium/src/utils/flipSlide.js\":\"1fc250635ee1300e\",\"/knowledge-medium/src/utils/fnv1a.js\":\"984ef50fd3b38c0c\",\"/knowledge-medium/src/utils/formatBytes.js\":\"cde48965e8f0b5b9\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"94eb79e1ba65d9e5\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"0ba9b80da1d3e73f\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"23039c5153abfea4\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"eaf988b0227f2525\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"c05446a6e84ece4d\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"eb4b0ad05cb27794\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"7b1e22b24814c54c\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"8a78b6e6bb9008c7\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"77014d1d89b23eda\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"0cc91d52723aef1f\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"abb372c5caa4b51e\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"b3393944adbdb2b9\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"f919c095fd9011f7\",\"/knowledge-medium/src/utils/markdownParser.js\":\"15a6102503c9a9a9\",\"/knowledge-medium/src/utils/memoize.js\":\"eebdacbb9d1b2493\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"7b0f39ac809d2a4d\",\"/knowledge-medium/src/utils/nameList.js\":\"501df3b2d03f1c12\",\"/knowledge-medium/src/utils/navigation.js\":\"3f42996a6b015f56\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"0cd73efcd8736d02\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"8c93cebac9fdf4d7\",\"/knowledge-medium/src/utils/panelClearance.js\":\"8b934d4618c6709a\",\"/knowledge-medium/src/utils/panelHistory.js\":\"ca12da7c0d2d6de8\",\"/knowledge-medium/src/utils/panelLanes.js\":\"a85674045a2a40f8\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"45167dd5af2ed416\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"c4f1ffaa211a8a65\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"cda6c441c2dbd55e\",\"/knowledge-medium/src/utils/platform.js\":\"c2ce78d24da36dcd\",\"/knowledge-medium/src/utils/pluralize.js\":\"a631e66afc1e5032\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"5d4a90d89bb36d17\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"7ed3dadecba50104\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"6031a8a855aacb8a\",\"/knowledge-medium/src/utils/react.js\":\"7a03266e144284c2\",\"/knowledge-medium/src/utils/relativeDate.js\":\"ac9af7992028ac21\",\"/knowledge-medium/src/utils/relativeTime.js\":\"070d7a7e8711af23\",\"/knowledge-medium/src/utils/renderScope.js\":\"df4245820d127863\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"67eb834c235a6e1b\",\"/knowledge-medium/src/utils/routing.js\":\"f1ee198735112ecb\",\"/knowledge-medium/src/utils/safeMode.js\":\"fc2bb2de96abae36\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"cb36c63df595fb93\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"a12f485cd6499df7\",\"/knowledge-medium/src/utils/selection.js\":\"158787355332e4c8\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"b9bc5e2101e2bf0d\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"f0e9241f32508883\",\"/knowledge-medium/src/utils/state.js\":\"9f386444d8ff8bc3\",\"/knowledge-medium/src/utils/string.js\":\"91887f858741f028\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"ca39df0f01e22ba9\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"fad631bf66d52789\",\"/knowledge-medium/src/utils/toast.js\":\"8297475d156c2521\",\"/knowledge-medium/src/utils/toggleStore.js\":\"10d81cf2f8c5bc7b\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"0f88c34ab58a4297\",\"/knowledge-medium/src/utils/userActivity.js\":\"69720847adb675c9\",\"/knowledge-medium/src/utils/viewTransition.js\":\"acb612637f5ea584\",\"/knowledge-medium/src/utils/viewport.js\":\"797090ebb14b3696\",\"/knowledge-medium/src/utils/webLock.js\":\"5a096081b666d1d4\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"7dee9d05f51368a8\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"f45b0a46901f8e58\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"5433061fc0b2501c\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"b8b4dce835b47d40\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"dc15d74734edb7e8\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"a46375efa13bb34d\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"41b9814895f6d49f\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"c140fe2ab56426c5\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"c75e79dec0266714\",\"/knowledge-medium/src/vendor/react-dom.js\":\"09b746d430fcafc9\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"01ee70a9adf3ff56\",\"/knowledge-medium/src/vendor/react.js\":\"bd7dbdfb96ffdd90\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
