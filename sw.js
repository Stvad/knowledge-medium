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
		buildId: "ebc34f41cbac-fd49086b",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"77c47610be60e727\",\"/knowledge-medium/index.html\":\"77c47610be60e727\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-Bx8aI1mA.js\":\"05fd20654111961a\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"e1b241a638bd9d56\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-BGa5JNxo.js\":\"5a99a7b0eb1ecbf0\",\"/knowledge-medium/chunks/FacadeVFS-N0K1M5Nz.js\":\"cbde9830115be6cf\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-B-xugFlo.js\":\"3d7b8c1a325e9d9e\",\"/knowledge-medium/chunks/MemoryVFS-CKDUDdn8.js\":\"495040146f4b3f1f\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-x-NlGySY.js\":\"50cc0cb8824377f4\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-L0T5vuj3.js\":\"aaead997c7dd21c1\",\"/knowledge-medium/chunks/Preview-Bj8zOO_Q.js\":\"95e955234962cf7d\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-jwlmdyQp.js\":\"7020551653e35621\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-DnoB5n1I.js\":\"ca3601fed9c5ce96\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-BaXEvBO6.js\":\"0042370b0e87d66b\",\"/knowledge-medium/chunks/react-Bz-sONEL.js\":\"cec0551295d05151\",\"/knowledge-medium/chunks/react-C_kKWaD0.js\":\"fa25231c96f8e8a8\",\"/knowledge-medium/chunks/react-CjizPFmw.js\":\"3d9e015449ec6617\",\"/knowledge-medium/chunks/react-D9AFhtqa.js\":\"736303c39790d990\",\"/knowledge-medium/chunks/react-DrJLa0q4.js\":\"96ed755fdb4db09f\",\"/knowledge-medium/chunks/react-DwloC_1Q.js\":\"715eb52ddf705741\",\"/knowledge-medium/chunks/react-I8r7Nm9R.js\":\"dd14fb6b3c6a52a1\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-CFH3Yv-e.js\":\"94bca226d96b083b\",\"/knowledge-medium/chunks/react-dom-server.browser.production-CzTs67Az.js\":\"8f0e33de11b5b125\",\"/knowledge-medium/chunks/react-dom-server.edge.production-DN7KTGMS.js\":\"959f0e879c5dff5c\",\"/knowledge-medium/chunks/server.browser-8hc9oVDZ.js\":\"d3f2dc6bd086e0d7\",\"/knowledge-medium/chunks/textarea-CG9TK8sR.js\":\"14b89d94556354e7\",\"/knowledge-medium/chunks/ui-DMoW8QAh.js\":\"23daefa10a1dff40\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"394aad018897072b\",\"/knowledge-medium/src/appUpdate.js\":\"e938f1a1e4eb4d2c\",\"/knowledge-medium/src/appVersion.js\":\"77bfff9336b6c0a4\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"e3698dc8cb8eed44\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"5b024f7c470a8adc\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"1591b229fb0f2131\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"f7085f7f8281aea8\",\"/knowledge-medium/src/components/BlockComponent.js\":\"d9abb481ebd70f10\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"3e4fc45f83e806e1\",\"/knowledge-medium/src/components/BlockEditor.js\":\"ddef4ab518595848\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"28a5837d114bb31f\",\"/knowledge-medium/src/components/BlockProperties.js\":\"e6ed827363351f32\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"f814fe8625696651\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"e1c937493eef5b3a\",\"/knowledge-medium/src/components/DividerHandle.js\":\"8656e9cda799f6a0\",\"/knowledge-medium/src/components/DraftEditor.js\":\"91badd20a1931899\",\"/knowledge-medium/src/components/GutterPill.js\":\"fda36191d0a9ad18\",\"/knowledge-medium/src/components/Header.js\":\"e642aa17300e259d\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"603abbc4780454b8\",\"/knowledge-medium/src/components/Login.js\":\"06fd85ac911ce71e\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"f8413eabbd3817be\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"d6408b5214db1c18\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"5ba0864cf196cbb3\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"8c7fb0f0a2362167\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"57c8204844babebb\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"72db1dee1cd63e6f\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"df7b05d4c285b7df\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"c5b823edf1090884\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"d5360838aa0e1bca\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"fcb100288c2e86aa\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"cafa3a9cccfa7d0f\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"3a0f52ad0097bbb2\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"287274f84b578f91\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"9d11668ed96e5631\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"366154084812c4fd\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"331807a7051e2260\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"68e4309e2c7b35ff\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"0ce55ed239fd1fac\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"0d5ccaf95d4201b4\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"5b5f2953ec7ab3bf\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"ab28ada8288b0f6f\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"371b36d1c5763b53\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"230e08406f8661af\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"69b0a8171224f702\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"37a69bf38a1efe14\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"6a72540ffaa10424\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"2bfde3381805ee91\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"ea488a005e73dce5\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"51899631701a2499\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"b49ba1e6ef562e8a\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"0b359eac3d20cd0d\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"8c61a313ec10de1c\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"cd40d8b1b48ccd0a\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"7bd23b2b106460df\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"8dc37004c4fcebcb\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"41af282a1979bfbc\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"c28a9f1ac9606c09\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"3f3afb9ac154151f\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"d579faa05249297c\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"8a8dae7f5b6191cd\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"b4eed9866c1acfee\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"9adc7502e7f43518\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"38f61e3d31a33426\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"0996dab5e619d5c6\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"7ef8b0a5d788a062\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"7dbd137ee13109ad\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"507ca01a9983fdc4\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"86591ede577281c5\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"c9d6b3c7ca22735a\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"ad63b29397d6cbeb\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"30798ba8bab6cca4\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"8a5ee11aa95b23f2\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"e83b7387ea49c9fc\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"eb34067c5082823c\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"527f3aaad0769f01\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"6d659f095ab982f2\",\"/knowledge-medium/src/components/ui/button.js\":\"97c26ad66ca631e0\",\"/knowledge-medium/src/components/ui/card.js\":\"6d65955aa96bce23\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"eee6fea8608333ac\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"c7d1518733bafa03\",\"/knowledge-medium/src/components/ui/command.js\":\"4419ad212e2e8588\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"e0cebcec4d06871c\",\"/knowledge-medium/src/components/ui/dialog.js\":\"76adf73ade2783fc\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"0c27701d38fa137e\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"df30a8617071d962\",\"/knowledge-medium/src/components/ui/index.js\":\"20ce5e2e02f5e027\",\"/knowledge-medium/src/components/ui/input.js\":\"a2bc79b5d00c892a\",\"/knowledge-medium/src/components/ui/kbd.js\":\"1318553d37d6b560\",\"/knowledge-medium/src/components/ui/label.js\":\"23d0ce2df5a63f90\",\"/knowledge-medium/src/components/ui/textarea.js\":\"397097bdb5bf96bb\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"f4ed43a579186308\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"94b5cbbb02aa8258\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"7d895868ad5e65f7\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"bd251508cd118cff\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"b4374826d3a229b3\",\"/knowledge-medium/src/components/util/error.js\":\"a33b33b5b72b7f9f\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"a56ac4f0679ff1a2\",\"/knowledge-medium/src/components/util/suspense.js\":\"a20761eb2504fc7f\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"74b660733327b9f1\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"c08b3d397c653ca0\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"827bcbe0f3789467\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"9960fd82ffb8b26e\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"46de1c20adb0d126\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"91a2e7e7291954a2\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"f768d0e11c4ed438\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"78b5b7700312a368\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"f16476380230ebeb\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"ff1399569beb46a2\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"8565005482a0a86e\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"8262bb40cc7626c7\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"3df23b27af9589f1\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"eea76f6f6001227b\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"fb0ff5ff71400e1e\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"61ee01d98bdb4df8\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"ce64070ca2ccff32\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"b92e5bc2f01ced87\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"d8e6a2bd43ece7eb\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"1ea8710b449dbc2d\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"b6f6d06bc7258a79\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"6076b758bb527c20\",\"/knowledge-medium/src/context/block.js\":\"5b94463708af4512\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"7981777b0487378f\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"5d8824a13fe13fe0\",\"/knowledge-medium/src/context/repo.js\":\"9f7729539b0d59e5\",\"/knowledge-medium/src/data/aliasClaim.js\":\"454437a8d8061e06\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"840516f8a03f499d\",\"/knowledge-medium/src/data/api/blockData.js\":\"aaafdeb581f1008d\",\"/knowledge-medium/src/data/api/blockType.js\":\"79bb617c6388b92d\",\"/knowledge-medium/src/data/api/changeScope.js\":\"0870fc1460a18be2\",\"/knowledge-medium/src/data/api/codecs.js\":\"cfa9d9dc2443d63b\",\"/knowledge-medium/src/data/api/derivedData.js\":\"f268af7c59a03d4b\",\"/knowledge-medium/src/data/api/errors.js\":\"1bb875954f94fb31\",\"/knowledge-medium/src/data/api/events.js\":\"dd4f982e03615fce\",\"/knowledge-medium/src/data/api/handle.js\":\"f3450bcfa1ecb990\",\"/knowledge-medium/src/data/api/index.js\":\"2cfc6ae69e80c872\",\"/knowledge-medium/src/data/api/mutator.js\":\"4173c42e27304a69\",\"/knowledge-medium/src/data/api/processor.js\":\"21727cc3b3f095e5\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"1c986c91050a680e\",\"/knowledge-medium/src/data/api/query.js\":\"ea98e437b9f84e73\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"c698eea598b85b41\",\"/knowledge-medium/src/data/api/schema.js\":\"f3450bcfa1ecb990\",\"/knowledge-medium/src/data/api/tx.js\":\"f3450bcfa1ecb990\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"f9fa79451d818ac0\",\"/knowledge-medium/src/data/api/user.js\":\"cf1c1b5f97aa0589\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"f8ba1b4cceaaef3b\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"f71eeb0390317450\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"0ab75cd294b582d0\",\"/knowledge-medium/src/data/block.js\":\"4f52bc7d03bc0136\",\"/knowledge-medium/src/data/blockCache.js\":\"bacd3e7fe6671f4c\",\"/knowledge-medium/src/data/blockId.js\":\"2824115ffc5995a0\",\"/knowledge-medium/src/data/blockLiveness.js\":\"c19690060896bb26\",\"/knowledge-medium/src/data/blockMerge.js\":\"74d4ab8df0b92395\",\"/knowledge-medium/src/data/blockSchema.js\":\"6dc3961826f60319\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"cd122f82b29fa545\",\"/knowledge-medium/src/data/blockTypes.js\":\"991cd5647afd206e\",\"/knowledge-medium/src/data/clientContext.js\":\"2190e5242d2c9435\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"8688241c6e80ddfd\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"9f86f6d4ada13cf9\",\"/knowledge-medium/src/data/derivedIds.js\":\"73effaadf40e7301\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"e9c560e18ff870de\",\"/knowledge-medium/src/data/facetBridge.js\":\"80dcb6c2cbb918a8\",\"/knowledge-medium/src/data/facets.js\":\"5c697968276bfde0\",\"/knowledge-medium/src/data/globalState.js\":\"9691da63c611efbc\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"045cac37efc4f8f4\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"3e608c004b201926\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"7e27af991c22ee30\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"a3209eb802af1b3c\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"c10c3c4761f6c3b5\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"d846be7288955a5f\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"def9d244343dc7d4\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"315eebe5a3d9724d\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"4d419e6bb5708b76\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"eb4cbb438b26e269\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"a06f750fe350ce1d\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"ed5a0b37076d657b\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"aa53e5a85dadfa27\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"808cfe649cac35ed\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"b7f8d03fdedab726\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"dc749e66cc35d5fb\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"f6a3553408b45306\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"9001b0e6019fb369\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"e9c3b92a564b8479\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"b4108ce3cc794605\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"6bdd2595f13e57a1\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"f2d1270befdecbf3\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"dd4ca7ffccbc978d\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"6bc34b0328ce64ce\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"1122d52186ff123b\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"265582349f217aad\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"a4d9906f991adf90\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"c1188631585ae12e\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"1357d472d44cdac5\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"06308b499fa156d1\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"9b023f5e4f8b0f88\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"1ffb75bf245a944c\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"e816e7d67af13d98\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"aac16b7c5d1c3e66\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"3a31dec827028182\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"032c53d331347781\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"0aa6ed23ee44d069\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"a0dd2a6954ac2ad4\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"57731acae9bb4d76\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"5a863f136b19e6a3\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"54bb961dffa3514f\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"1bafcd9465db4f05\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"b2a822fc923a0612\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"ca7f3a3cb4aa154a\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"044e8295ffc36b72\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"12dd53a74f3b4acc\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"effcc7a808c0cb2e\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"ead9cbdab8ed41af\",\"/knowledge-medium/src/data/invalidation.js\":\"6f9e1c65b19657b4\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"402e7db8d8793767\",\"/knowledge-medium/src/data/kernelPage.js\":\"dd485251155a3899\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"45e142fca91512a9\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"0f4640a6d90b36d7\",\"/knowledge-medium/src/data/localDbStorage.js\":\"765612402f141568\",\"/knowledge-medium/src/data/localDbVfs.js\":\"c8071a51cd88f4d5\",\"/knowledge-medium/src/data/localSchema.js\":\"b2d9a7fc24bb6414\",\"/knowledge-medium/src/data/maintenance.js\":\"89fb31bea07c6b72\",\"/knowledge-medium/src/data/mergeProperties.js\":\"56443fae6a2f0814\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"1fe6c36d8297ca84\",\"/knowledge-medium/src/data/migrationsPage.js\":\"b9c37eb586958e6a\",\"/knowledge-medium/src/data/mutators.js\":\"21c261f3bd5c1bad\",\"/knowledge-medium/src/data/orderKey.js\":\"8ae30ebb9b1fdac0\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"143bb7fb9bb26b77\",\"/knowledge-medium/src/data/outlineSurface.js\":\"6313c67526e0bcc2\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"3f24b74df771013c\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"78c6624e413d4530\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"f3b3df6a8c7ff04b\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"b70fab43037e2a7f\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"2ab58c50d101e3c3\",\"/knowledge-medium/src/data/properties.js\":\"bf72647737daa5ae\",\"/knowledge-medium/src/data/propertiesPage.js\":\"963957d7823544ab\",\"/knowledge-medium/src/data/propertyChildren.js\":\"0a67bf37ee709ff2\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"d5a69b9a1f6fc545\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"3f3df20fe5c3eda0\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"4367917ab377f172\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"bd989f3bbf608861\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"a4bc2dd335c07a24\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"3d9983ed8a6fe1d9\",\"/knowledge-medium/src/data/propertySeeds.js\":\"e2a2d5aa96bba7cf\",\"/knowledge-medium/src/data/recentsPage.js\":\"9c8040cabd6bf450\",\"/knowledge-medium/src/data/referenceBlock.js\":\"460ad4184e9be2b0\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"3d7091f4d8965e13\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"b376573078d9e884\",\"/knowledge-medium/src/data/repo.js\":\"ec1dc2ca5e7d6051\",\"/knowledge-medium/src/data/repoProvider.js\":\"d20b0f6ed9e2cfea\",\"/knowledge-medium/src/data/rowProperty.js\":\"5071a3139b468aa8\",\"/knowledge-medium/src/data/searchFilter.js\":\"7576ae12ef18d22c\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"8474c1e949cc92a2\",\"/knowledge-medium/src/data/stateBlocks.js\":\"52f564cc8616966a\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"e9c2073e249c3f08\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"0d45aecff4c50495\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"6bff7c2f1b3865c0\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"f2ed432eaf4ba1cc\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"1bd9b165a265cf60\",\"/knowledge-medium/src/data/targets.js\":\"58a3462b6bc7a320\",\"/knowledge-medium/src/data/typeColors.js\":\"b8e0f538dfc8a645\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"63aa2fd8ffe72032\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"040c26f4ece7f1fb\",\"/knowledge-medium/src/data/typeExtraction.js\":\"7e50603bb9d5924a\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"b9cebf0101d84760\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"35a08ccb8b2af7cf\",\"/knowledge-medium/src/data/typeSeeds.js\":\"9fd33bff4f3517b7\",\"/knowledge-medium/src/data/typeTagger.js\":\"4eb84c0180165082\",\"/knowledge-medium/src/data/typedRecords.js\":\"b93576b61de5c6b7\",\"/knowledge-medium/src/data/typesPage.js\":\"b3d2dae2ab541377\",\"/knowledge-medium/src/data/userPrefs.js\":\"77568c28c74b3efb\",\"/knowledge-medium/src/data/userSchemasService.js\":\"39807ae66881802e\",\"/knowledge-medium/src/data/userTypesService.js\":\"2a34697bb035219a\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"d12ac6a954b10a14\",\"/knowledge-medium/src/data/visibleChildren.js\":\"0dfdb2887c26f462\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"68ea23d5b2ea1781\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"a7251b8256f4d3c9\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"cbd9883b8d4b063e\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"2e5920cc022d4981\",\"/knowledge-medium/src/data/workspaces.js\":\"a737c72ffc072387\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"c308d9fcf72923bf\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"3ca91ad5605432aa\",\"/knowledge-medium/src/editor/atTrigger.js\":\"ebf6ae6e3938287a\",\"/knowledge-medium/src/editor/autocomplete.js\":\"b64daaf20284bac5\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"4163bf23a44e0c88\",\"/knowledge-medium/src/editor/contentFlush.js\":\"744823f4ffe7b9c6\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"a9fdbb77cf474bdf\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"8938a1ae0b0b739d\",\"/knowledge-medium/src/editor/insertImage.js\":\"1dd83773b05dd947\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"a49cdb1c3ba8b391\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"9c17529a1c589a1e\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"bc4376a0e78dcb53\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"82cb01e4a38657b9\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"1758b3d6faf078cb\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"04286ec1d64f897a\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"cd284f897926d112\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"dab1fef80ff0342d\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"06adc007e0c6c5ec\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"73517fec4c22b44f\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"33175bd142634608\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"cc6e9c6d1258cd6d\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"2ee5a2a440c50038\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"c1b7b8b29e77d492\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"572e40b9a207770b\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"c567646d94fcd43b\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"8163025eb058575c\",\"/knowledge-medium/src/extensions/core.js\":\"8ff6f8fa2597e694\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"747c65602e372e9c\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"f6f85e9b9db504f8\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"96738afd49bd8553\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"88b29c2a2bf35356\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"7424b304aacbde9d\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"605fe7560a4eea6b\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"685dd1bf8f185b9c\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"dbf19a9aaae4b5e4\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"40cbb26eab00b486\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"e1189b3fe57d1461\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"ed21683714fa6428\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"81d01cba432ac5b9\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"3374fc09c374c841\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"3e298508aeeec5a5\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"76c895d0a7e84764\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"44b5ebebf0264ce1\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"eeb2f81604d7a0bf\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"410d2abd76e29eb1\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"9dca6549a16255b4\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"9ce13371876971a7\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"98ce6820efd53795\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"93de2bb4133c8e84\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"e0ccd15efffc5fd2\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"b51de3f361315d43\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"b59f326ea097811f\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"f7a6d7a59c23f632\",\"/knowledge-medium/src/facets/facet.js\":\"915cc4dadd6747eb\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"a3d337587a7a1068\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"430fbd71a2d8d369\",\"/knowledge-medium/src/facets/togglable.js\":\"6130f2c2283f398b\",\"/knowledge-medium/src/facets/variantFacet.js\":\"f9109384457705ab\",\"/knowledge-medium/src/facets/verbFacet.js\":\"050c6f296c05e5d5\",\"/knowledge-medium/src/hooks/block.js\":\"5392d53676d46347\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"f3ca203a873606d7\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"f1d2157f4039d346\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"e823ddcc6ac9c871\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"74f5a30da2c06f47\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"fbdfe0f581b06bda\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"1cf7392b3f89d797\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"43948709997c7a4b\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"ccfeb19dd89ef01b\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"3869e1502ce01446\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"835d4dcc0a6dc7ce\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"7d31fee853a6e43f\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"c7a80dc60c780e33\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"48a67c163aa5724e\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"2608a6199e01c0dd\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"c3e60986e66363f5\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"3950f3d8e2d24f89\",\"/knowledge-medium/src/lib/utils.js\":\"92ded53dead2b475\",\"/knowledge-medium/src/main.js\":\"9523992e03bcfb84\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"e32ca2cb950d4e67\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"48a8a11d46bdb7df\",\"/knowledge-medium/src/markdown/context.js\":\"927816a2997b81fb\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"e96314dfa33e619d\",\"/knowledge-medium/src/markdown/extensions.js\":\"cc46c95e9de4e672\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"a634adaa241d0352\",\"/knowledge-medium/src/minimal-editor.js\":\"020b45b7ab7a2196\",\"/knowledge-medium/src/paste/armedCut.js\":\"194659a0de8ba4d1\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"81c6707f3e79e293\",\"/knowledge-medium/src/paste/clipboard.js\":\"9b09a7eb594d834c\",\"/knowledge-medium/src/paste/decision.js\":\"7ad6b7d093dfcfc6\",\"/knowledge-medium/src/paste/operations.js\":\"8b96a77db26cf161\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"85fb8565a7d3c69c\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"2cd7e6ae3ff5c95f\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"65f2350b40cad084\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"c400b83aa53cea64\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"2d84597936ef7ae4\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"0efe0aea135c8066\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"29b1a4b7cb1f6bf1\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"8515cb3312c91766\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"cf13d5baaa1a4b5b\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"86d66327bfb768ce\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"45ee7f894b0c029d\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"be07cfff1befcba9\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"de1901c364d4399c\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"46f29f0eef5d5cd4\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"67624bf626dd20d9\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"bc8534c44b03bdf2\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"6c1ef17e8fba6b8a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"ba479934889b13f5\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"d555e95cf8da8783\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"d88b39c1558fda76\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"ac0ac5cb00165ad2\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"1eb106efa966a13e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"d30493c22453e6bf\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"b52ba4ccdbd537d1\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"fe78fbec9f61ae34\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"92172d2cfb2e691e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"337b4af17283e4c7\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"716203e2afe01cff\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"14b99420c5e253a8\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"be80e20cc1eaabec\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"0d23006f91e94243\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"7a5be4477e21d35d\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"9a91e9cb3deca967\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"09e11590a897db5c\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"24ac4465539ef1ea\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"497094dfdabe2f5b\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"e78ae78adfffd76c\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"416621d5d0ba0d9c\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"a9b4246f0c4c22eb\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"45f509b7d677c8e7\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"3d8971d88a528682\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"f4c501d23ab0d1e0\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"f49aa0b5fceb8d78\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"0f7afb01e2c6259d\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"d874d2f455d2182c\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"93cab4b12e320a2b\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"1953b6e773a2b0a0\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"dcb79e5530de0c89\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"6f22dc883e1cbd1c\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"4f63c4d157a6df4e\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"f4b8f887d0ecebb8\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"7ee850c4e51be03c\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"df94e3da57e705af\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"7947add6ca934f5f\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"0f6f74ea21d3e331\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"8a810a2254189388\",\"/knowledge-medium/src/plugins/alias/index.js\":\"84d4483576f7226f\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"d66adb61ffec607e\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"0d6165f3a7da22f7\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"723707f51062ccb8\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"0aba4bcbccb8d827\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"ad7d08ebfc0725f2\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"4a6c80f9e0b9e77c\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"a977ccd75305c090\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"64d9f1fe947e0e46\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"7f753032c84db404\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"52bf5e7938073730\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"6e076884152d2233\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"f69b0cb4ffae128c\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"c5f373bdfc31480a\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"22205dd3fb200a0c\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"7e49a778746bb26e\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"ad7c6d9249798c90\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"7fffdbe7fb44f7ae\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"9e3cb3dda008183a\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"316c84cf27f5e4fa\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"c62ee7a99b76e29e\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"867a0334903a33ea\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"14b31a874f049b60\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"010a65c9203769f7\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"195b1b17e1fdc0d1\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"6c32a88c96455778\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"4ef4e391888a79a5\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"f3307e579e38b0ef\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"feb41ffa42d37710\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"e41aabb1d7b7fee6\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"bfb8ba61e764cb1f\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"52f2bf03565c03c1\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"00115e4bab0feba8\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"f08195cf2d87709b\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"372e486af7cc74a4\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"2797cd2ecda82c33\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"a1b29d82a9da8886\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"21b6cf3fa6f3ca1f\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"2bd1d545f792ed0f\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"1419ad5c0b898a59\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"4d91869c7db2e973\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"16f4d497038b8bd4\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"abf274237efdb672\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"7a32c418cb98010b\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"ea42d50b87a1e4cc\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"34cdeaf32c1ec85c\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"14559829d18bb3c1\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"9eb48eec006fa142\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"33e8783dc7939a1a\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"6dc991aa1f51cd6c\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"3a6e91cc2f920b2e\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"ae3d7ab407e9c3d0\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"b82f4109211a87bc\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"ee86b6c0570b7e6b\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"423ae2b38e43e401\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"fcfa15307441f98c\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"087f4e47a98d4b41\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"0f11cab4aeec50f8\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"2b833350fdcab45d\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"3926fb49774c81a7\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"c684724d2da8f613\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"14d47ee6299b196a\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"14d82a47a6c4fa7c\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"dc38f620bec815dd\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"1eac9e21cab1aeac\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"49fa5e788522d433\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"168e387bc08dd8c5\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"656c511a243b800b\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"6ddc0a0aed15db92\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"a5f15669fe062cb7\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"ee01322d7a38a3e8\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"a8e1fcff661a70ee\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"1b6d956b3445dd12\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"70dd333bee3875e7\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"64631f921272518d\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"c9be08240d453cf0\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"7ce44c14e6450f32\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"afea9547be420dab\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"cb2a4bfd49fed559\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"1b86ea85e59a49ec\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"d9d6b867855cf3e8\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"09d083ba160cc479\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"46e1b2e9f56ec014\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"53959153dca3e5a1\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"54f65af396e13f39\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"4126b637c4bafd83\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"7cac811c9d5faa59\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"e129c4f4029cb21a\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"8bfff997e48bd990\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"10d6158159c787bd\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"34adc81c6cace13b\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"8fee189b2e593515\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"2fbc9e11050e88b0\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"c9314ab6ff4eeebc\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"2e78cc2196102238\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"57448f7611d9b419\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"299f8083683f0c37\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"f2f66edc8de61ddd\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"c163c4a0bf3df526\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"e0ab207e1702c089\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"b937a7fe43a14769\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"91d6749d4fa57ec4\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"563a37fc01baefe8\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"a4d37ef44599d801\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"a676705ec480bb7b\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"bc4efb9b5742a380\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"b32c155b4cce2827\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"cc483abb7a65076a\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"0e319c7f7d9131e5\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"cf0046ab367511dc\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"05e536a45f4d07c5\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"648266545d2bf16e\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"fb2b91146b459b6d\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"7f804d84cdb18c46\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"d1af98821b8fb6ce\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"081c1b1f51c7c8b8\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"66d486b85caa55d9\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"19a5d910f79a75ed\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"79e7682587710655\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"5b7ead9ea566c56e\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"c34c9cefb32dffc5\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"9d160d0cf541f9d5\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"d754b4cf0a277792\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"ca8dd43e5a75cf14\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"b7854926768678d6\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"7cfcb84ca4f57fb3\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"0a040a216f85e008\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"10793a307577447d\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"8beb64e4650e577f\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"35dad30a6337def5\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"f1db77b6afc52bc6\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"7655602887b8ab81\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"17f3a5da631e7945\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"44fe63846d240d9f\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"31f4a0921637b3d6\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"bf930f23af713dea\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"fae64c01374908eb\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"1198d00e6c6b7471\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"24aa7a1750a2c98c\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"cfeb8df3b5625440\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"f1f7aba34e36951f\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"95efdd4f0dbae294\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"dce76df506d88281\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"b899bf0626a64ab3\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"b5a7fddb8a992d76\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"3beea529547eae56\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"fef0a6d6fdcd19fc\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"8da6eeedb645e21e\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"7cdc63ffd55b2a1e\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"78bbc04022679355\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"f0f6c52287e67c1a\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"9240ea0b45cebdd6\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"780dab14a024e2c9\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"3512b94e70c8d73c\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"9ce799ff38200ec7\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"2f0ef75ee8de36e8\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"4e7c46e8146e1f63\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"796ea0a2714be1e9\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"6d4f065859d7cda3\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"9e370199154b187f\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"c25cd042a596be31\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"66aa5a99197962a6\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"b4fb5a454ebd9a0f\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"922c39afc3b17186\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"79ec6db88dc997e5\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"2fd3b7032ef494ff\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"9bc88bba532d503f\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"9f3a59276a3d4ee5\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"458bd563dd302320\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"2ccb5a572dd625d3\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"c3755f93d3821e83\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"b6192b9f619eeaeb\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"dd18ff466b0f59a2\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"f47788e1c8f76b17\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"02cc8f54e447399d\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"2d0348630a9bc76e\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"00d8939892fce7b3\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"7130865720f431a4\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"6f739a4959559827\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"af4ea88297408234\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"f5a9e9b61f4de087\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"7fbea115ea3006d8\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"7557749aede40d6c\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"536a17c3357528fe\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"8a7097d69b63d067\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"7975d8061a13229c\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"772dbe18c33cd1a7\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"63194edcab66fe5f\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"29fc50832abbdafb\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"0690b877c3826efa\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"104ee6f082ffb299\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"2f21f8a47d84a582\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"6b605c1d2a4648d7\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"df3e6aec40a42e59\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"169155ea75c48c1c\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"d2fa23a24189a595\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"6ae28f2e2ce279bc\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"a150cb43d7420f13\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"008c09c8a9685321\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"871d9024cdb88760\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"f455b52e2979e1c6\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"b95c042a6de54dd1\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"524813d486e5dbfa\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"309e964654e68e0f\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"3550cb10ac23093d\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"bea4c5d02ca21ead\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"7ddb1ed467c12931\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"b81caa136bce05ca\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"df966f32355fef5c\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"28249c5c1e56beaf\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"ae28acb37a41128a\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"055f7bf2071079f2\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"d742c3c54f31dd12\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"7dab531a8dff811e\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"d01d9eb8ee7d3dfe\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"96ea9d62d9fbeca5\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"93594316bddc34bd\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"6cd66aa20234e959\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"975ae3bf7ccc09a7\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"06ac306f3a3c2bfa\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"ecb1fcdb98279ca7\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"4c74631c578f2855\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"8cf27102d693b80b\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"c8b4bc7e4e079c89\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"1054312707caa457\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"937b04556b257b73\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"2a9c96eda97e4813\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"f53804d334bc855c\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"58be4c2ed97e2f5b\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"19b7534a08d85a8f\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"fa250681f2b4c891\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"33ac2fbfc95f4004\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"4e811d86d0319999\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"fa7de5e5ffd61b24\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"c2eb681f58fe3e7b\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"616511db17bbd651\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"e9be1c6485c9aa22\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"a526d224cdcf890f\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"c956ce0362c5104e\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"1c09b9fa397deea9\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"85a3766a74086d6e\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"5ec56f4db9256187\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"d81ef2d25d78897c\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"f6f4c65aca7fd45c\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"0db84e911209ca33\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"a967b0f74ad87a73\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"cc2a0e1ea3289168\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"7b2410ff90a2594e\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"5207da537a1c6711\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"79c0a759141a4195\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"ce5ed82e58ec4f69\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"8b6e26e3035201b1\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"c1547fc2e905714c\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"a482290b8bf4ed7e\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"f3c3e816b40224ca\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"be53b2a8a4d9ade2\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"75cc5eea2e5a80e9\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"1f51ee703d872137\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"6890040bda9cecaf\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"375562c0a38deecd\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"c6d38b8710577f83\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"a64e73d771fb7660\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"cf1f240f51b9f751\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"dae6f9b1da24492d\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"2971e7f89f818093\",\"/knowledge-medium/src/plugins/geo/index.js\":\"e3722996c316311b\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"e99677412dc1ed75\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"50f3f49deb4c422f\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"6f6b9b50cebf55d5\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"29dc737e9a93034c\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"8922a7e7b7496827\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"e2c2d57c46475fce\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"573d09fd946116ae\",\"/knowledge-medium/src/plugins/geo/query.js\":\"8afb5d7cf1b4cc32\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"f7eaf6de08a1ac76\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"377b36810b0fd578\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"4ab97a730b318304\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"8b9cb4eb660a1212\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"75c9cdb96e2fb0e2\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"836d3cb9d44a8748\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"610523c47a1afbe5\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"968bbe76b836e89e\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"985c803df1bd5189\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"34c8b8c74769f058\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"4ec5c528c8e44be6\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"6061f9920b2163ef\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"3ff996522b00a071\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"f56f19c8fbb8649e\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"3377722c120a0f36\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"e0d83e3fb16f743a\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"21216a62386708d9\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"a74a6d99fbe9197f\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"0bad64eb5915ab41\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"9bcd07c584675ea1\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"c367e215814344ed\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"857667713f9fe419\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"2b1ed7ec715b80fb\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"c62e52fa8b242fa2\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"aecde0e02d4d7b0c\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"ce18e79a19e84d5d\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"5531eec16798964e\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"18bef6c29d862175\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"1071933eed446799\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"7b795c96b520bdb8\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"4d238aa7406815b7\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"b0080adfc533ac09\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"98929c1f1e14ff0f\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"d042f9fc5a7ea291\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"4f9e180c9a212f7e\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"9a45d776aae81243\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"930db0158afc7a83\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"3337b65a075f09a2\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"cbe45adbcbffb311\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"3ff33bfeadad9b75\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"84817bc3a8f8911d\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"52fe770a0c7e2925\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"ee779171a62b155e\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"68550e06e00ba8c4\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"54c271a83c55aec5\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"7d58c7a7ec6fb5f4\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"5856aefcac38146d\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"906fe7bccf17aa19\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"b628de3bb64d523a\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"eaf543f9c9a0e867\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"08f658682b35507b\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"fde84dedd2b834cb\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"850678819e99bfa6\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"cec662f479e386bb\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"0a99758b136cc9e3\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"d4ade6ca4eadbf7a\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"23d439904a8aac83\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"d645a50e8b873e90\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"eb9acf2c4c8d68b6\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"3b648e6958db0ea0\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"f5ba8b462212182f\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"98e17f1a90df5f6f\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"8c15359051dc2ad7\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"b5ff80b2f03a3560\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"f87a0f3d90e250fc\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"114c5ec104cc4d72\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"d06795bbaec74818\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"c5ecc4e6c5184264\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"899e1209c135c100\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"1b1612591f42565a\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"57b636c90cfb1b9b\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"24e928f61022a592\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"c49673b26b993373\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"92042871985bd7ee\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"4e7d6672850eb71b\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"dd9cc0132023725a\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"df8b54c7ec4b56be\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"cc31b32f8f73fe71\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"b2ddf17c1595f581\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"e9bd7b94fbf69b07\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"8f8a44703fe10391\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"0efc1c5a579e1161\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"0240295d9bc39a32\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"fc1035fee465d254\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"54f4ce9846b679bb\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"4c29850164c58ac7\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"ada57d103b82633b\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"7caaccc0a998d85a\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"bdb2c7e547b1d0b1\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"b091de738910f034\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"9f11b7b67d3b715f\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"77a4ce830575b0d2\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"350098a9811e6f5b\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"23c1129654538354\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"12cb86ff7794711f\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"f72f3d38d584a78c\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"3f96822f9c926b51\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"0786e8ff11edc9c9\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"00faaefae731c53e\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"484f505ca1dd9e63\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"ba69d7831b618e96\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"69d2789319389c05\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"84b2982a1110347f\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"176607a944225f84\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"8a39e771648fbbbc\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"273e6632dac3de2b\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"b5ed2ea8f8a8d590\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"ab1cca302d382174\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"f02ed20562d02ff6\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"9e0a061561c00d89\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"e94ce950e0bdd04b\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"a0848f4dfe23a859\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"13d0914f50091c46\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"8303c870d074b7bd\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"2f1de82824376ee8\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"1a128e73b46e3e87\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"e6795e1c8ca12f4f\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"eb9e6d91b28dcd80\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"584e2bab3e126243\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"b98d2737e05ac22b\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"a27eabe65fb932cc\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"db4d2857306e4d20\",\"/knowledge-medium/src/plugins/recents/index.js\":\"e46da4c6aa6938a5\",\"/knowledge-medium/src/plugins/recents/target.js\":\"df8a2e8f44e638ad\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"9f059a03118ca1e5\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"fa59f89d0a3a0037\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"b9e594327aa402f4\",\"/knowledge-medium/src/plugins/references/index.js\":\"26bf7369fc50b59a\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"04d12db397b3432c\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"f3527eb7ff0d47bf\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"44825e2988d09112\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"c2d460b12f7abbbf\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"549cbcfb8d653f37\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"03b937ef28d21486\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"af210bb59234692f\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"3e017a22a5c46704\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"582d385442a9baff\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"921dc21463e6cc01\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"54400b72fd449155\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"5a56fee847be133b\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"c392e34a1eeee0b0\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"e063481faa2416c6\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"9bb7e95ca80545ee\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"06d68b3f63b60cf3\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"d9ea4b364d70abc5\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"ddfb708bb1a0f74e\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"825d54d88223284c\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"3c7323ddd1c60c2d\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"cc83177c5939426b\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"36ecbf1ce4566147\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"3f4fbc3c88579d75\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"538fb2a632c0bac8\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"1ca687e3076848ce\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"b72b0c468032dca1\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"7eb300cc13bc33a6\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"2df2b335e145c313\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"0ae5dc5b0c7d7303\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"a2cae939c967057f\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"4417972154002e44\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"3d4d30810ed45165\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"7bed88a0dc8ccaaa\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"5db58b8984fe9bb1\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"fc300b36d350a89c\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"cf117b7e097e8e81\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"fbb5f0e068824821\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"fc9c848fca763b5e\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"4cad31b52f900279\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"cc78f86492b6f9f5\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"86c22b32c777f688\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"7cda47f439d0b1a1\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"a9038f4c2b69857a\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"b6601e15459ba2f2\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"5f7778940cb9acd2\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"80bb0f9da407a055\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"f5e875f9477d06ac\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"a9fb59e67e062ed4\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"78e07379ed63b81d\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"bc09433e97899387\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"8b4e218a5efeeaef\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"51c97357f156245c\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"33ec6d7415f2cea0\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"84cdef5d4ce67d7c\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"b87bf81777cec88b\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"e248635138051104\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"9af30846f85e9b8e\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"c9326884c5d522ac\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"3af4919cfb28a4fa\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"81935157d2287ee0\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"614065b38cb9e461\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"01dc2b155b38ca7b\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"a81ebbe6de97fd67\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"72814326fa08d3f8\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"851b21bfb7ffa4f3\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"3fed16470e1b2832\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"5fd544518174cf58\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"0f93ebf8ea8ed151\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"6f06bf5ce198fe9b\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"677f1d68d4e4783f\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"c2976587cb85b059\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"450482483c12a8b7\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"5a1faaf0fd4b3ed2\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"3e4a09bdeda773c3\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"7f68d229f7c08be6\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"b5872542868e7881\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"dc0e518043a7adec\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"8f76faeec39da4ae\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"84bdaa9df5ae6b24\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"e67228bd4d25863d\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"c38c34c4b3452e06\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"aba878d3b5279c03\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"90c773046e1775e6\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"38cb42bfc308c0f0\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"65deee492ca04d93\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"62d560ed292fa490\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"fe91fc17d9a990a8\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"0ba3f95274eb2209\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"cbfbacd8c303fed2\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"a2cee21a88d8f9d3\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"1b09f882b0ec7e86\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"e869706e48c1c08b\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"056c6380a6ab4770\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"8b895b3a7f1d3925\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"4a1e9f8cea31b201\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"c563b174d0d7da8a\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"16fe1a9dc4893d1e\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"5d527ee31928e820\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"7a9f0463321aaad0\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"cd385cf991d38abe\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"20367708c9e799b2\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"da40ae0612ec499f\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"25d82e28c76cf7e5\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"4df96fe608cb0abb\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"65ea92e2f4da727f\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"ee84a6068bd8df09\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"51992ea49c284173\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"e1d412c7183037a0\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"f54dc348ebe623f9\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"07e4d998455fc2a1\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"3b2ccf0a23667d43\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"320808847bf08e47\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"a85c0d67509c5ca3\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"d5fffa4439cd09af\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"fe8c9dc6edf8f577\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"3bae33f02871db85\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"a13be841f4d41031\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"669fbab7fa648b3b\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"187f05aaf202ec0b\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"70ad7352475da505\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"79b46bc4fd3d7c63\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"82462be073dbcae1\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"8b20753ef267e9cc\",\"/knowledge-medium/src/plugins/tables/index.js\":\"6cf29a3a2079dece\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"41e20d60b4bffb25\",\"/knowledge-medium/src/plugins/tables/model.js\":\"a32089a533a58751\",\"/knowledge-medium/src/plugins/tables/navigation.js\":\"403dc24e6c201619\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"6d5e74e9f9c87f7a\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"5f741f348a0aa6e0\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"d3536e433ba3188f\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"c709ab6c70cc1899\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"077676e75be3c6ab\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"7d855d530089df52\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"277b70d4c21da63d\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"6a29d47d69f3d3f4\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"a32eeb8eb6134acc\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"a08314e90693ccf7\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"e033f6f76f000ee4\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"1dfbd34876e864e4\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"99afe47b85abd2eb\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"1d0f88921b316a43\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"0c4587c848e383f2\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"236cee75c738717f\",\"/knowledge-medium/src/plugins/todo/index.js\":\"fcfe185988427904\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"d7e0e464f2e414b6\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"544bfd46ae84a196\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"93a8f6357a20a069\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"e48a4e0f8665023b\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"253dd25967c5f7dd\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"31bf3c1b63dda910\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"5336799f190ba23c\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"eee653bae81aba92\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"711a7690a0c83062\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"5b4be77bb19aefe7\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"2e6b27c64180fc17\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"2054fa8cfdd938aa\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"1b270727e34f557e\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"819998e04015d663\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"b4d68e07ed37460d\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"212b3b84c954f7d0\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"3a54038a56a81821\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"a9d69e92692ce821\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"2ee8f01775d69304\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"70109e11d09bff64\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"3e8f957d1364a124\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"d0a82e3632376a32\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"047e5b8ff06cd885\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"ee9cac2645a72fe9\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"294c9c1ae211ba9b\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"ed72fa247105e261\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"f7f3e7a5d16d7ef3\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"703fa377fa898c7f\",\"/knowledge-medium/src/registerServiceWorker.js\":\"4bdbadf714b2c9d1\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"28e4ca3790cb3673\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"585d032394fdb866\",\"/knowledge-medium/src/services/authStorage.js\":\"6ad5f9229eff74b0\",\"/knowledge-medium/src/services/powersync.js\":\"56c7534ab99c19af\",\"/knowledge-medium/src/services/supabase.js\":\"a1f8deba4a6ebb5b\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"808d0905547e89b6\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"f5a0c50f981cde93\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"51f9bac146fa0921\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"efe03448bb125b2a\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"82c8c2de802cd30e\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"7ea663a7c848dcdf\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"ca6f22c8d5b9d02b\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"1d5d9faab16fc52f\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"2b6c2dc0d5a2f49d\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"aa630677779fe39e\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"4c28256e2d059c01\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"7e0cf4e7296b980b\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"61d812ab7713daf8\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"10057c5e9c670eac\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"652dfd4c4d4f73ef\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"734d98614c450263\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"40ef823145d5c94a\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"9d8b81e4135df63c\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"4659232e42c69422\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"55f5933a3e6e1884\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"ea8000c694e7c80a\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"6dacd7b7a79bd234\",\"/knowledge-medium/src/shortcuts/types.js\":\"5210763aa2859372\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"7b514b8d8b730992\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"a3bc1a7596931e98\",\"/knowledge-medium/src/shortcuts/utils.js\":\"611a55421d525cd7\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"122eb79684513fa2\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"d02bb77f6429d8a7\",\"/knowledge-medium/src/sync/byteTransform.js\":\"05dbda7710e57a02\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"6e90289800c5e4e0\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"de837d5f52634c23\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"cd5927dae1ea7787\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"d3378edf48d63532\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"7f0b315a31f41b4d\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"5798aa25f33219c8\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"c21e60e0c6a5e24d\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"7361f139b14a0f6f\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"0ead20ca67f4f3b5\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"2f712ea3114249e6\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"6c8d2a2b3d71e438\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"a42c3933eeb105c3\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"f33311346bc533b9\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"a725ea4387db1bff\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"e066aa3106b71d9b\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"31f59204157694a0\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"b6ccec956fa99b57\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"fee2ebc468998667\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"477955f784877131\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"05cd8c218a3ad027\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"98b1f72481749070\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"579aa4df1ad5a18b\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"9911d0bdfd3b6481\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"9a75379ce107d7c6\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"af833adc404cb99f\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"77645e1365317af5\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"c2f744b52263ad8e\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"e6da02df3228e220\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"1795c8a0678049e7\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"6ed9724bee4777a3\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"a1247062ec14071c\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"cac2f11796882bb6\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"44216646cc4c56ec\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"fab5afb9b149914a\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"61e35786d1a306d6\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"afa99b556e2d5b5f\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"049d96143f52e954\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"b857bf576d6b7712\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"8201f3b491f6ed42\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"d076770ca2ced6dd\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"89385c34b5a3715c\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"cae882d4550b218f\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"7cf65ff273852b61\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"1d950e1a6b7fdf9a\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"53236d1e568f08d0\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"4fc7fbc58aefe185\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"e9525a908e7e1368\",\"/knowledge-medium/src/sync/transform.js\":\"ae6de5672c84a847\",\"/knowledge-medium/src/themeBootDefaults.js\":\"ac7df28a47aa73da\",\"/knowledge-medium/src/types.js\":\"c02eb39c1e92bf2b\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"563e88c8def7fbc3\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"a917a0d30724ae20\",\"/knowledge-medium/src/utils/array.js\":\"819adea1fc4d01d0\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"b6c0ad4c924e338b\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"2fdc63c30c79e019\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"367bba40e2f335c0\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"abd8616937d1b347\",\"/knowledge-medium/src/utils/callbackSet.js\":\"59ffbcd5cd4d6456\",\"/knowledge-medium/src/utils/clientId.js\":\"59089be10e5c02c3\",\"/knowledge-medium/src/utils/codemirror.js\":\"917fbdc45fd297d3\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"4e3594e929c9c527\",\"/knowledge-medium/src/utils/copy.js\":\"a9fa28fe109dc6e6\",\"/knowledge-medium/src/utils/dailyPage.js\":\"ad24330ed7d54245\",\"/knowledge-medium/src/utils/dbForensics.js\":\"299c5391bc9c7dce\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"423f0b1ce7e10d69\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"5998b44884146935\",\"/knowledge-medium/src/utils/dialogs.js\":\"b13a98fd09021d0b\",\"/knowledge-medium/src/utils/dom.js\":\"d168a362e38bdb3a\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"bb51ed7c5b4117b7\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"bd5701c3808e8de9\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"0d0a83596101039c\",\"/knowledge-medium/src/utils/flipSlide.js\":\"c3f632940cc219c4\",\"/knowledge-medium/src/utils/fnv1a.js\":\"72cd57e03c6b1666\",\"/knowledge-medium/src/utils/formatBytes.js\":\"43877abd1c275dc9\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"4115424b5732a69e\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"4970177b5088974e\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"144fef3d0f85bc91\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"114265bd983a77f2\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"4b477d5609395b61\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"480daa600f6849ef\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"60b7a65a839ffb00\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"917539f8e49c276b\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"2f93379cc5e83c81\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"abaf942caf0b1bca\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"b9ba4ea75f0ceeea\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"a346032115f60f0b\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"67203aad6c166298\",\"/knowledge-medium/src/utils/markdownParser.js\":\"cee68e0ef6463fad\",\"/knowledge-medium/src/utils/memoize.js\":\"d7f98efdd14513f9\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"734130e00e3173ab\",\"/knowledge-medium/src/utils/nameList.js\":\"215bdd24b77d4d0a\",\"/knowledge-medium/src/utils/navigation.js\":\"7720ac3c04d11148\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"c01ced840b399c91\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"cefff7d1936597ee\",\"/knowledge-medium/src/utils/panelClearance.js\":\"d9169c7ee83ddeed\",\"/knowledge-medium/src/utils/panelHistory.js\":\"33061e006ef3d75c\",\"/knowledge-medium/src/utils/panelLanes.js\":\"716a52036b38e5f8\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"5bb7ce25284f8a03\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"4befa1503fd2afff\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"ee28825d16131d65\",\"/knowledge-medium/src/utils/platform.js\":\"efe07cc5d8721ad8\",\"/knowledge-medium/src/utils/pluralize.js\":\"eb522471ed43e570\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"a3def611a88a3ff3\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"a8276797c5a7b88e\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"0786e7ecf8670aaa\",\"/knowledge-medium/src/utils/react.js\":\"c7fac4fac0c4a33b\",\"/knowledge-medium/src/utils/relativeDate.js\":\"bef7e2f1eb0fadde\",\"/knowledge-medium/src/utils/relativeTime.js\":\"88c267085596f316\",\"/knowledge-medium/src/utils/renderScope.js\":\"9fd47b075e1295e3\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"941df4bbc9a7116f\",\"/knowledge-medium/src/utils/routing.js\":\"4ab9f144f086b11e\",\"/knowledge-medium/src/utils/safeMode.js\":\"4a33066dff3cd7f1\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"a4686f55e0e6cf6d\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"a345e6c8afd7bae5\",\"/knowledge-medium/src/utils/selection.js\":\"2d3c07d31718edc5\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"ed8641f99f312ceb\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"528f7e66dcc436bf\",\"/knowledge-medium/src/utils/state.js\":\"b9b447408d292682\",\"/knowledge-medium/src/utils/string.js\":\"69de2dc8b7f93471\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"3f4e6aed87f44cee\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"2a789bce519632c3\",\"/knowledge-medium/src/utils/toast.js\":\"64545625ceb3de08\",\"/knowledge-medium/src/utils/toggleStore.js\":\"0702a0ea5468dcc7\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"8e42f3875937d48b\",\"/knowledge-medium/src/utils/userActivity.js\":\"cd2c51c9f7ff07a4\",\"/knowledge-medium/src/utils/viewTransition.js\":\"22cd3dd86cbd7a28\",\"/knowledge-medium/src/utils/viewport.js\":\"f15608efa61cb098\",\"/knowledge-medium/src/utils/webLock.js\":\"7af45095ee51e92b\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"a358f3d7250ac53b\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"1cdb9649b60546b4\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"4386c9682bdbb70e\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"5e4190db0f537f2c\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"486944b1910ffbaa\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"6061eb12ffa0694b\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"be5488e6f781cde9\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"21da6d2b7ba87e71\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"88d5d9898062cbbd\",\"/knowledge-medium/src/vendor/react-dom.js\":\"d04e6b219d1d0403\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"2bc00b687dc4b3c6\",\"/knowledge-medium/src/vendor/react.js\":\"c9e48084406bba96\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
