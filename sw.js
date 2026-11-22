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
		buildId: "300267d1cf9a-e6aecacb",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"766a16559c551198\",\"/knowledge-medium/index.html\":\"766a16559c551198\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-BpND7Qxz.js\":\"4c4eb14e26aa5fb9\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"260b7ea731db9085\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-By__9AoY.js\":\"926a278c7d82a5c7\",\"/knowledge-medium/chunks/FacadeVFS-q-9ZaqUe.js\":\"559e7b8ddaba76e7\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-D0gwTpeB.js\":\"5a1bb0926909b82b\",\"/knowledge-medium/chunks/MemoryVFS-Cn7KYHmw.js\":\"f424726b0a24c5d1\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-BcvcMD5O.js\":\"a9352f3f02c0b924\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-BOLQpk5o.js\":\"5f5d1c8dda3a44fd\",\"/knowledge-medium/chunks/Preview-Ccm65V0l.js\":\"72323683dd37cbf8\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-ChKaBEyx.js\":\"df566076026ad3d4\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BZs6_q6n.js\":\"b621e072f96ffff4\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-0U2qNDpt.js\":\"a88c698fbcc31439\",\"/knowledge-medium/chunks/react-BrfPISHr.js\":\"c930161fa1f505cf\",\"/knowledge-medium/chunks/react-BundW3mw.js\":\"0ff3ba5e00e5ebd3\",\"/knowledge-medium/chunks/react-D3USyS60.js\":\"46388464c5f8264c\",\"/knowledge-medium/chunks/react-DKo47JrB.js\":\"21ae681704c40ee8\",\"/knowledge-medium/chunks/react-DhKwOGAY.js\":\"8702ac0f5001e2ed\",\"/knowledge-medium/chunks/react-Nyrer41l.js\":\"4f0abbe23327d10d\",\"/knowledge-medium/chunks/react-aRCKmyYs.js\":\"0a5c4af97443db91\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-C1bePzPO.js\":\"880a91bf92bc9ee6\",\"/knowledge-medium/chunks/react-dom-server.browser.production-zVRjgXJF.js\":\"f9a6f40bc0f0ca6b\",\"/knowledge-medium/chunks/react-dom-server.edge.production-CaNaZYTH.js\":\"0b7720c67154a02e\",\"/knowledge-medium/chunks/server.browser-C4-JMzAg.js\":\"3080448f05d35603\",\"/knowledge-medium/chunks/textarea-CMDkjOnG.js\":\"fd1c892e2c932e58\",\"/knowledge-medium/chunks/ui-DMgvKmKU.js\":\"a350cfbb5cf3b129\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"817a81c731d64a4f\",\"/knowledge-medium/src/appUpdate.js\":\"0807ea5f827d5120\",\"/knowledge-medium/src/appVersion.js\":\"44022db0808328ab\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"0ca22e23b963d315\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"0359b378b49913ca\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"4ad78683d7d3f95a\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"6394bfc5b1f29942\",\"/knowledge-medium/src/components/BlockComponent.js\":\"3f4771059d7cce7c\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"d74bc7822f89bf8c\",\"/knowledge-medium/src/components/BlockEditor.js\":\"5967d460bff50a5a\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"f25fbbcdd87f126d\",\"/knowledge-medium/src/components/BlockProperties.js\":\"4bc86dceb215dc48\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"b76e4c2cd5ce86f6\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"a042c4bcd32a5e92\",\"/knowledge-medium/src/components/DividerHandle.js\":\"35e6913826312e00\",\"/knowledge-medium/src/components/DraftEditor.js\":\"1537d88abec3611c\",\"/knowledge-medium/src/components/GutterPill.js\":\"595476b9359123dd\",\"/knowledge-medium/src/components/Header.js\":\"f51c8f4081601378\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"96cbffa3bff2d0d1\",\"/knowledge-medium/src/components/Login.js\":\"8e045530910cedcb\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"fa55994d3f0ccd09\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"2ebad4c1116a3b18\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"6321e775dcebbf21\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"a603a51e16ea53dc\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"c2bda36816b89072\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"18f641942900f7e0\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"2bf3a30d3dbbbc69\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"9575a702ed3f7939\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"d064e9f14fa0c89d\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"5aee61590c6bea39\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"76ff9e7f202ea8b8\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"8b860d6021fb21dc\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"39f37e4935f187a0\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"643f9753cf9e2d92\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"412100076475afb0\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"cc11aeb8b030e6e7\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"8bf90aee317aa886\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"261f11681786dc6d\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"6c883cd440cd686e\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"b0d1f0e47a6a9953\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"a3b6971fb91883d2\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"7d6e34fa2d7f22d6\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"111b4175230a5761\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"1ea6b17e5bc53214\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"43f3b1419654ff27\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"b862dd43b96e7aa3\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"b9cb64aeb7925ae5\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"0992f45dd131f60b\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"928971f66b6c44f5\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"4ab501b1d6bf0aec\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"184a6075040672ac\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"0535f754919adae0\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"f3454fc9ff9bf5a0\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"b0c7e3576696b003\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"4fe434592dacca71\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"bdd7b3618ca8a79b\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"86e85b135eacbc6a\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"6c3a21a044bc59f9\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"fbdddf3cfa940365\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"aa02b512481c5309\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"c6a30bea6b391488\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"a2f5975d158abe76\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"10b8b45fade8ade6\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"130410e5bf3d9c42\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"c0c1870be72206bf\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"b4936c0197ebce81\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"46b9f6dd7f9d248a\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"5027679209611d4a\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"a2aa62a796f5e852\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"145224f6d6abd8fd\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"ba3218613179b703\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"9f5eaaef142944a2\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"f6ccf842f21aaee4\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"cd5d1721f264b85e\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"d0a9b0b1fd59f93e\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"f585fcf71715e140\",\"/knowledge-medium/src/components/ui/button.js\":\"ca6258a674f9e214\",\"/knowledge-medium/src/components/ui/card.js\":\"bf79bff2f9ddfa2a\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"f90de7eaafbd800f\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"81ed03b013eb65be\",\"/knowledge-medium/src/components/ui/command.js\":\"c2681f18e061285c\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"6b64530840792a5e\",\"/knowledge-medium/src/components/ui/dialog.js\":\"316e73cd67181e08\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"0a2921cfd0cfda5a\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"a79c4e819b6be94e\",\"/knowledge-medium/src/components/ui/index.js\":\"279d83a423fd09a7\",\"/knowledge-medium/src/components/ui/input.js\":\"eb29f481c95707b2\",\"/knowledge-medium/src/components/ui/kbd.js\":\"a20ffe6efe9c23a2\",\"/knowledge-medium/src/components/ui/label.js\":\"fece2b1475162322\",\"/knowledge-medium/src/components/ui/textarea.js\":\"8209ace5d5546603\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"0a0e8bfbfb36bc73\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"3839685e208274f0\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"98801b4b48199a38\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"b93dfeab3d769490\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"aead35792b2545e9\",\"/knowledge-medium/src/components/util/error.js\":\"a33c1fbb7bb66335\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"551147d07ab74c24\",\"/knowledge-medium/src/components/util/suspense.js\":\"f37a66fdfaf876af\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"90d591ad43805ef9\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"4760c6d8f0575b89\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"db389889d84a57fc\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"f3f3f05bd881c5cd\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"0c263e88e201e3d0\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"cdeacc038db1014b\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"253b03b48f8c489c\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"ad2de44e8878e556\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"a62a4a7cacfed6ec\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"353d0ecf0f0ba9c8\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"afd1314aae501404\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"23d03277ebbdccb0\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"48597e61ced4c977\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"4137b3ac78c99349\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"80ae24992cc99e9d\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"0648375b69ecb16d\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"e6941a73f15fb06e\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"e538615b88275293\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"155f4a18d0ad301e\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"9ab7c1316ffb03ae\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"1ca5e9c749304c17\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"3d80c0dd1c5daa32\",\"/knowledge-medium/src/context/block.js\":\"fa8d55f6273fa349\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"8938e3896564bf4c\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"1785a15a421686b4\",\"/knowledge-medium/src/context/repo.js\":\"8c1facb34d87fba0\",\"/knowledge-medium/src/data/aliasClaim.js\":\"4bb59f0b3bea5f28\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"1049ed91d12d5fbc\",\"/knowledge-medium/src/data/api/blockData.js\":\"18acbf81cdff4182\",\"/knowledge-medium/src/data/api/blockType.js\":\"ba0e223939213fda\",\"/knowledge-medium/src/data/api/changeScope.js\":\"5bb1b314dfc34c0d\",\"/knowledge-medium/src/data/api/codecs.js\":\"5fdb084447105d00\",\"/knowledge-medium/src/data/api/derivedData.js\":\"18cbd7a405062a12\",\"/knowledge-medium/src/data/api/errors.js\":\"28d582fe5ca94e96\",\"/knowledge-medium/src/data/api/events.js\":\"6ed80449ee165382\",\"/knowledge-medium/src/data/api/handle.js\":\"23c3629020ee3d98\",\"/knowledge-medium/src/data/api/index.js\":\"0e80ee94e916504a\",\"/knowledge-medium/src/data/api/mutator.js\":\"30f162eb0ec92704\",\"/knowledge-medium/src/data/api/processor.js\":\"7f5f74076cf99c04\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"ee3a3df9d02136d4\",\"/knowledge-medium/src/data/api/query.js\":\"3e47921953aa9547\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"584c20400a4efb69\",\"/knowledge-medium/src/data/api/schema.js\":\"23c3629020ee3d98\",\"/knowledge-medium/src/data/api/tx.js\":\"23c3629020ee3d98\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"b5bfa6573d4a3f0f\",\"/knowledge-medium/src/data/api/user.js\":\"1e34dbc502cff641\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"b2e21b71997a9b71\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"9cc3bba1847665f5\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"afa5bb737e650d17\",\"/knowledge-medium/src/data/block.js\":\"e7d27ac8dab6ffb6\",\"/knowledge-medium/src/data/blockCache.js\":\"93c06c9291657fe9\",\"/knowledge-medium/src/data/blockId.js\":\"92274426f231990e\",\"/knowledge-medium/src/data/blockLiveness.js\":\"2930acb6c92f4353\",\"/knowledge-medium/src/data/blockMerge.js\":\"ab6c3ce1b2b93170\",\"/knowledge-medium/src/data/blockSchema.js\":\"63ac947b069d2929\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"ee2f79672a1e93ec\",\"/knowledge-medium/src/data/blockTypes.js\":\"878de89dca462e8d\",\"/knowledge-medium/src/data/clientContext.js\":\"616fd21efa255438\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"8adce033b7e2c4e3\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"8c6033282ef930ed\",\"/knowledge-medium/src/data/derivedIds.js\":\"c2b8f92992cb6273\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"f45fc09595174d3c\",\"/knowledge-medium/src/data/facetBridge.js\":\"8e42b2eab16c5ab8\",\"/knowledge-medium/src/data/facets.js\":\"c275b926c774b445\",\"/knowledge-medium/src/data/globalState.js\":\"ac9b03648b328c46\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"b890df1f813d88af\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"841c52d6a38ef1db\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"be3f249611e94b4a\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"8ab40a032404a5bc\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"21613e17c9b99759\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"6d1ff43fa56f53a3\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"d4cb41a4940bac4c\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"594328ae3b5c9c15\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"70ceb279238e297f\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"d24bda2f021dd465\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"02a2c060427f8758\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"17d5e2098ef66e57\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"d18ad3ed4c1e2fc5\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"fb7e8abd76c8bf93\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"cbe6dbc74a24646c\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"c1535c237008642f\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"ef5b68eac2c3d4c6\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"1537ef4ed87ad00d\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"6f3ae44d13ae1557\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"668337f05cb85a31\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"42560ee1d0f325d2\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"5490e552c3464fc7\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"47f313a866af4105\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"de4c97dc3b123df7\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"718c7d8f8e44e377\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"db8564facb94c242\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"a40246cd6c7e2cb4\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"3643bd5ba93290b2\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"4adab7a08dd43a41\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"32ff2b8777d04029\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"65b7ebe37652002b\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"5ba00e0c8c4c36fc\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"b1455e6a11da5cc0\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"5f64c26e1997cb47\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"9f4928940c017d61\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"fbd247852ee72990\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"653f9225877056e0\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"ace3414e903e8e23\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"f61a2a8bcd269aa7\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"8a4cae72262d6075\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"77704b9477609702\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"77a1706328be685a\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"3710ed6ba5527bd2\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"01f174dbfb294e6a\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"0765dee2decfc9de\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"2d5374e9da6f26ff\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"d4cabc4d6cb57974\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"b901fce8cd0ed705\",\"/knowledge-medium/src/data/invalidation.js\":\"346bc6e45c7be73d\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"320a15b4c60cf8dd\",\"/knowledge-medium/src/data/kernelPage.js\":\"544606cd220dedf3\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"1a338d7fec3a4881\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"bc08f347d4c02f56\",\"/knowledge-medium/src/data/localDbStorage.js\":\"eac075519e359f3e\",\"/knowledge-medium/src/data/localDbVfs.js\":\"c449e4480cb9ca07\",\"/knowledge-medium/src/data/localSchema.js\":\"3b5e9b0ce588bfdc\",\"/knowledge-medium/src/data/maintenance.js\":\"57abb0ef770aaa87\",\"/knowledge-medium/src/data/mergeProperties.js\":\"45e73e01f0b6a136\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"1ead8276826d333c\",\"/knowledge-medium/src/data/migrationsPage.js\":\"855f2989122259c7\",\"/knowledge-medium/src/data/mutators.js\":\"ce639e6ce4fce32f\",\"/knowledge-medium/src/data/orderKey.js\":\"320862d294aa331e\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"fdd5f03ed94f3602\",\"/knowledge-medium/src/data/outlineSurface.js\":\"11fa56eccc407c1e\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"841872a561e5bfc7\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"6c6062a92f55aaa3\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"32862f3462443452\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"0fa48d75f9da6084\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"a7696fc354cf681b\",\"/knowledge-medium/src/data/properties.js\":\"b681561277c97429\",\"/knowledge-medium/src/data/propertiesPage.js\":\"25df5e746f9d68df\",\"/knowledge-medium/src/data/propertyChildren.js\":\"aa46de2363863923\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"bfb7493a20409c75\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"1adc56a19b7dfdeb\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"174c5f7a7f088624\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"5da5a2abde1ed4cf\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"6eb31820377c6849\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"87f8f0d25a4b790f\",\"/knowledge-medium/src/data/propertySeeds.js\":\"9b52da05b34ff6e9\",\"/knowledge-medium/src/data/recentsPage.js\":\"5e982f86067331fd\",\"/knowledge-medium/src/data/referenceBlock.js\":\"4631d2057201b350\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"d10020c5d6409ac1\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"95d88e30ab11537f\",\"/knowledge-medium/src/data/repo.js\":\"70ffbcf1f58feb33\",\"/knowledge-medium/src/data/repoProvider.js\":\"10d54995598e78ac\",\"/knowledge-medium/src/data/rowProperty.js\":\"bebc895110921ad2\",\"/knowledge-medium/src/data/searchFilter.js\":\"6e027e0a93441948\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"23a71ce721443a43\",\"/knowledge-medium/src/data/stateBlocks.js\":\"ca394f7f7dd5bbf8\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"6dcd349d8ed66740\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"90161f7deec645a2\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"7f41f303e32fc741\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"6ef96e0a79fe27ef\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"43c18a86e86613d6\",\"/knowledge-medium/src/data/targets.js\":\"7c76db5fa3da1b65\",\"/knowledge-medium/src/data/typeColors.js\":\"f9cf7e4fa5e8e2bf\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"d230c7c0054322cf\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"73b06229a8ec6590\",\"/knowledge-medium/src/data/typeExtraction.js\":\"6ff56aa4dde7e623\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"f6603fd79080385c\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"7dc6e62b83208c0b\",\"/knowledge-medium/src/data/typeSeeds.js\":\"17e0b1b7c6d8c379\",\"/knowledge-medium/src/data/typeTagger.js\":\"305cf969564f8fc2\",\"/knowledge-medium/src/data/typedRecords.js\":\"c68e4923da8a50dd\",\"/knowledge-medium/src/data/typesPage.js\":\"abcbcbd66812a8b8\",\"/knowledge-medium/src/data/userPrefs.js\":\"9dfb01e191f9c43e\",\"/knowledge-medium/src/data/userSchemasService.js\":\"6ae585c834d39453\",\"/knowledge-medium/src/data/userTypesService.js\":\"e4c475e9d64347f9\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"905191aefca93132\",\"/knowledge-medium/src/data/visibleChildren.js\":\"6d7718827fcd64b3\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"c498bd9dc2072415\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"31041eefbb46a6a9\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"e680ffe88a734754\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"edfcdfb6334929aa\",\"/knowledge-medium/src/data/workspaces.js\":\"796dbf2721a4f987\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"577f9f317cc57ab4\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"252f3f6b773efcee\",\"/knowledge-medium/src/editor/atTrigger.js\":\"d942c6edae86dd81\",\"/knowledge-medium/src/editor/autocomplete.js\":\"f0edef8f3a564a39\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"2eb231bed05bfb93\",\"/knowledge-medium/src/editor/contentFlush.js\":\"53e48226f1a79048\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"a2d38f8de74c2430\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"a2eec583ff105b2d\",\"/knowledge-medium/src/editor/insertImage.js\":\"f875f25e005f798a\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"6c0f2ba6a5bc28fc\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"52ce9c26074d012a\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"d87e5c45255c2600\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"66df9e5f75fc1e77\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"bec9a6e950bc7a28\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"c9cb4291109cf38e\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"7bfbb67f8eeae8f7\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"42873c0c278ccfad\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"0be59c581ed0b09d\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"fe67f234ca8a3572\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"c8c5653cdd4366fa\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"dc0b9b4009a75e02\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"09d42c9ea1e63491\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"74e9c1159c820ba8\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"88008f7a6818ede6\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"acf70b9c66030af6\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"756b884d7684c4ad\",\"/knowledge-medium/src/extensions/core.js\":\"770941ae2fa47d9c\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"c091f760e923bfe2\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"4d4995ea1be04d26\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"1672bbf97c3d1705\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"fa9c7f13fd3de8d7\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"bb23d6181857f1bc\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"915772c58c92c3f4\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"4299a36201f6d8c6\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"6674fd30ee009207\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"5e4e499a7bb5677c\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"a15b73d05e84fe9c\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"c818845ef37ba110\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"b821d74e13dc68af\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"eedcd04aa16787fb\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"1dd45e2b54d20a1c\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"a388299883ec956a\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"02eb93689a55fced\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"fa84808c7054be2b\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"732e1e9ca757d994\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"811a012de9a76cf1\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"8664b6c00483ffa2\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"16a3478aac451b30\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"ceae3f5679442a6b\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"07ae6e175b3acfa2\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"e94ca98e793664df\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"189d0361330a5ce2\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"b4c2640a7ab235d9\",\"/knowledge-medium/src/facets/facet.js\":\"943e2cb90cfb4b85\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"0e36be6db7bb6742\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"3454e7f50b769b1a\",\"/knowledge-medium/src/facets/togglable.js\":\"e38eb34840f1f32f\",\"/knowledge-medium/src/facets/variantFacet.js\":\"c4b46c34ce35a9fe\",\"/knowledge-medium/src/facets/verbFacet.js\":\"4378a939f620cde0\",\"/knowledge-medium/src/hooks/block.js\":\"a72b61be522146d4\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"6b3484c26392a13c\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"f6d45549a4fcc52e\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"eebd61f923e73d34\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"75b3315253edc9f3\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"834ae8ae529a19ec\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"bbce66e645f6bee6\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"ff7c1607020faf34\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"461ea344c46cf807\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"826fa7e843bff16a\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"0be6e55c037e0407\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"27ce3791dc5ce0d9\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"5df60cc1131ca860\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"213dca6baa6c99f3\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"146e57e9e1368ab6\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"f47e0003e6aace11\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"c717bd820bf314ea\",\"/knowledge-medium/src/lib/utils.js\":\"8e12b7f0af965455\",\"/knowledge-medium/src/main.js\":\"51add6a923795d32\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"5e9bfa66f7ef7935\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"ee88129db47120a5\",\"/knowledge-medium/src/markdown/context.js\":\"a38035c1c237130e\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"72e7fa48bc30990a\",\"/knowledge-medium/src/markdown/extensions.js\":\"a8eb48a3302b1b42\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"ab557782a8e1cc09\",\"/knowledge-medium/src/minimal-editor.js\":\"cdf016f88b6dc899\",\"/knowledge-medium/src/paste/armedCut.js\":\"b12a126d4b47a105\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"697d1c77ad34692a\",\"/knowledge-medium/src/paste/clipboard.js\":\"47cbd48e78c92442\",\"/knowledge-medium/src/paste/decision.js\":\"e12c8f29a76fb1ea\",\"/knowledge-medium/src/paste/operations.js\":\"ba465925692763f6\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"8672941bf28525b2\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"12d5f9114a619d32\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"38210b84a71872e9\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"88acb0b9c85b5a2c\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"1c144e194c9590fa\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"1c234f0fdb0205c8\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"efff635f527cf57a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"4c13a1a882658639\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"bc62268f1c82914a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"07b26b37497df4b8\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"4df27c1bf6e21717\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"e0d41316842957f4\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"b934511a084262da\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"b39aaaf239d30609\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"f5e37233da8b9a0b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"501b3d359d016756\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"bd9fbf70c0be768b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"5e84ad108aa69e56\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"ca73a05150ed4713\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"3b3b53555df2695f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"99ae28a9e3ce7bfd\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"309b532ee2ff6442\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"f0ef5adfd55d9391\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"6a4a36c6aadf7f49\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"47c04481b33eeade\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"01148ee4efa290af\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"16b3e378a8e23c35\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"0e75533fae80c267\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"90a1795e4b5fed08\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"74bccfacf0ed3fb4\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"d637feaaa562f517\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"503b92af7c4079b1\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"98c22a5a08197c4a\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"e513c0f60e2b52f9\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"66a7f85e00998ce4\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"28861b34aafd2e67\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"4d401dc8b91d589b\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"9dab183641309841\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"85fa3f98d58f7164\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"09bcee4be835c594\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"9fe33376be869526\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"810ffcfc2de150df\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"596b601082507e28\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"df3a4fd2e37e6e20\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"fea32b9223642297\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"6b6027675dda73b9\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"17492b50dba812cb\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"d29a17336ecf4265\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"726e9550ae83a031\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"bc7e7dcfe56e38ef\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"5c2772da552bc2b6\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"edaa863c4e2f71b6\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"60a170deb10d54ea\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"f0bc6335c9131ed0\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"bde6badb3b015a00\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"bd8937ccb598e77b\",\"/knowledge-medium/src/plugins/alias/index.js\":\"0448eaf3aab791c7\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"cad3fb654f288028\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"64a7086c72715a7e\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"eb9623f3ec1c45d9\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"df01bc2317ae600f\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"47ec4385f84727a7\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"ddbacd7acc09d115\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"2188945fcee4affa\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"06f4fa2a282dd200\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"c7e511f11813aac8\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"53f4d3b5264d36df\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"538a77dc08604f38\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"20780874bf4eb0d2\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"48981293aa2c69a3\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"d77e8dbd9e1da538\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"c000e820282fd709\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"e595c802ef91fa22\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"86be9f3d4847670c\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"082de9f13fde694d\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"561169c9266b50ec\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"50c4027db3a17990\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"2ef2918a95c8256d\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"f3f8f32800bd2eba\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"8244a444a0c1a547\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"f42c1af8dbcc4648\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"76fa9737f36def4a\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"3f2396a728f3602b\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"804490ed3305a00b\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"30edce344cb1b16e\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"d66325f2921aa0ef\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"a1dea2c42f8f6f75\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"006cd673a01be2b9\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"6faef9c3df1ce413\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"bda4197d6f6c357d\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"9c4421c809145383\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"19f5072048e77322\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"fb2aa66d3aaffb6b\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"a1b0655908a02e62\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"3bb07f3b0418602c\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"353b40edc91958f5\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"6cd1000b1dd03880\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"ca2743f3c8ad0506\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"f10e598e3052c6b4\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"98c31eb3d03c51f8\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"f1e23cca48e6f269\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"52b395c0e9eac412\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"5624e5f5737aece5\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"13229d213ed72838\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"8dee35baea4ce468\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"9cc7413dd05ec2f7\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"2d210b23df493262\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"c3684ab4b2b76a01\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"17af679c12f68b85\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"9cb186e488f653c0\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"051e634a4107d56f\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"b4c4d8e896d5408d\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"0084f6a952e61ba3\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"05feb8b8bf3912c4\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"83c01ff73884d1f8\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"c6324235053cfad2\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"1f82660d1656c2e0\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"1d5bb54eba29c285\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"a73661c84e37c84f\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"76a71fc786c126c9\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"5d3ca7ccf7b87786\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"a0ae4ce845458410\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"22d79345c12d5311\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"7f7e56741fa328fa\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"c16258d1b361912b\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"4d30a3c1220c923e\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"ff348ed8ae79b17b\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"fdca3f8a83e5005b\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"6386b711f22667ad\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"6f566a13fdad85ee\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"622b6fb12b02ad95\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"50b7c175289aaa58\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"7af0a261ecf46900\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"4967e32558daa3d5\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"0cf27699d121b35a\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"feae12e26e49cd3e\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"a060a516bb864267\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"d093c100ded3904a\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"3d28e9979743ffb8\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"f8101ec6a1a24aea\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"9ead3c946799f8bf\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"607a1f96396330bf\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"798260bdd769251a\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"5f432e842da75768\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"ab453462cb9da8fe\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"881fb4213b65683c\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"33adb7758736fddd\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"2536a2f73a0c73cb\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"d62f1795199e1871\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"7a8d09d5b03717df\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"9bc77550663ea379\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"164763d023579c1c\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"7200b58fa2589883\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"54d37e5f0ccb77d6\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"d9c0f8d54a8ae122\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"23581776b641e3f0\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"69e386d8d2aecee5\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"6c079633b8d70db2\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"2fee65430b4a638a\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"0f30696055601147\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"f3b20992f4cf2ac9\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"13e1061783829272\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"6f8c090ff71d0173\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"076a9277ecfb1657\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"1143b1592b473612\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"e2290ddd92aeed21\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"60b771233cc695d3\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"568b4cb8dcaa7404\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"e2a71ef87953f229\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"3b2381cc5f854dce\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"fbbccdd7710fc01d\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"e004ca35108e218a\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"aace1d295ac87a10\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"c7e195ae31976a63\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"9e0bfa32b770a610\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"0a5a8d6e87087fda\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"2707c404b3297151\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"87145d1eaed6b88d\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"cc6ab59cc4487f63\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"598e95dac9422fa7\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"beee357dbdb4c0e4\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"1c635176a99d4399\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"549bf04d7104e13f\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"eec77244dd22dac7\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"599fe6ca9c037467\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"c5b30918d34da555\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"a43b662d2d04b563\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"9deea11595392953\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"bbf1238c0fca5ec5\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"04a484e8b0871d42\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"99f6c6867ba781dd\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"6a3dc0b5c5bfeb33\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"268c8aa899d5cd58\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"a5ab1ad92355ad83\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"eca28e6f8aa235b3\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"d7037cfc9ab3eb57\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"1b94568e1cfb6941\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"3d3cd6a7436ee359\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"39f63a87e4e46d1f\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"7cb8b90c464e14a6\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"45c6ee96c7dfa052\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"535b170f1ce85f10\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"1979fdfc363db8ef\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"c534dfc768c28924\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"a2ce9ec8a824628c\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"6c9349b70f7e8901\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"aa3b7fd42b37b3a3\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"a03a857564e187de\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"0f35a5d6de1060d2\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"b44d00177b166bcd\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"b931da6ec7724f54\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"efb19ddcad8717cf\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"12b4e9d8aefd2b7d\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"4428d8093e902e08\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"e204c11b11408464\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"4a1742a85cec1f3f\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"dfecab0481228d93\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"9c3e89619aae7ffd\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"1857a21cd63ec148\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"bbb649f144eabc73\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"8df3179c040c761e\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"348a14cb42567c51\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"0060f0d71cc93b1a\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"f3c6cbe972d13ff3\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"87ce0d944aa130c4\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"98a22bad2edd0b81\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"94a2fb64721ed7c1\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"739c1d5bb567b85b\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"33bc4b71fbe96f12\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"15fe41d3a88a602e\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"784d727e6e075dc9\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"2f8024795d73a07d\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"24896eb741fde5ca\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"ad69ab8abf04d024\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"3a4e2d39db3d1812\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"6f01f9e7307b131e\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"d6d927eee0f69cbf\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"a2174cb47b29b597\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"258c1cff385853cc\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"029a9c1f5c85179a\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"cc2ad9ae98a3f5ff\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"6f06e87cb6b5cc48\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"c29c1c9e2aa605ef\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"2b2cb63f0a7b1d8d\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"b6718cc065965e27\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"4c2dc73535f86d6d\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"83dcd053301b419a\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"fd234955d2310017\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"644eed05d82ad571\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"a6c3bb75e9c661fa\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"d047a0fbfe9d3d2a\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"8d9141ff25d8a689\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"d5fd73886d1e36a0\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"837ebac9f94dd48b\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"a250590493e38e35\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"c30bb887b69596e8\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"e4b7a1b7516bb65d\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"c1a1f5aedeeae21d\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"995c2de076d2b83e\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"553d56ed86370ff6\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"722513f7b49f7a87\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"8461bc4cea1df385\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"2c9c6692a9edf473\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"e1fbdd55eef336af\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"3f5f45eaf8fc5a86\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"e34c4c7e21033e6f\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"b1ab149a5c1d65ff\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"853419d5fad4f172\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"56b3062b6d52f4e2\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"979715f322672253\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"42286f8efe836c0e\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"370818822f6fa85f\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"da9de8cbbeeb7f60\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"eecc6b6ae39fab34\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"7e1cf872f5f05864\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"baa7ff05e48dbe55\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"17e51822d57d410c\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"6de72757581dbd51\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"70e04d8019a5a2d5\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"1d2d2cb39a3bf1e3\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"700ac2b6a313fe1d\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"3baad3c201e62308\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"e03903021670095b\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"8788e594daf723c7\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"b6c436e0724272ad\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"f60f69bd0fb7e591\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"201a713554c8dbf3\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"35865673164e661b\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"0015622dbb0d36bc\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"14a0ad9b2fd8326d\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"98da21cfeed840ec\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"37bdf24abddf76ec\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"15d220f864e93dd4\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"720c687a47885209\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"f645bbb252233001\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"69a4727b11366dd7\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"428f9b75cbb8b64b\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"2f39fc6f2ecddade\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"a3c2ec2dc56a09c4\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"61a9bcff17b8c829\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"c3f2334e921fbb46\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"834524ec4918603d\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"59836d65298788ca\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"6f1429d439de1d37\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"93dbfde52e12eda5\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"99492307744c9702\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"d73d2febd99f0a62\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"211e66de67674686\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"7f8c356dbcf63533\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"59348e18b3ee9f17\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"cca296066cdd31f6\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"87d8f67c230bec50\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"10a709c157585be9\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"cfb40d65a83d6a93\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"aefaf5c5e3c1b43a\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"2526a7f2d957ee2a\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"77dd618d582d43b1\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"f1ffa1fd5b0da747\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"73e2ff5363b1782b\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"19a388593d19f2c7\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"861494fbacac737c\",\"/knowledge-medium/src/plugins/geo/index.js\":\"e413b33d80b8fea7\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"7ebbf98cdfbff5ce\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"d22064239a046c09\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"13155f65914eb1a9\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"fa093415f0c1ba2c\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"a71aeceec4ae0f2b\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"7407e2e5def8747d\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"ec4984f79e048351\",\"/knowledge-medium/src/plugins/geo/query.js\":\"ca8c7e75bdcb8d47\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"a62b2c6de23b5444\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"8e249cc7832751eb\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"719e06504d1447ed\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"4c8d500129a6f460\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"f0794fd8d4002611\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"e542eccac9235202\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"679600e46c893df1\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"91ee63b566afa554\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"463eb3c69d8f82a4\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"fdcb8047fe0f80e3\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"9b315de576cd8fd8\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"516eabf250f01546\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"b8de7d9e537d70d3\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"3c7ea79022114c75\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"663c033569c0302b\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"469cfb4b95020866\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"425f761d2dcffd20\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"c318e8ac1951bc6e\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"9c5c0a22b11a87cb\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"9a9d30780f54ed67\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"44a5389343ccfccb\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"6745339c1d865fc0\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"18806f6fdb8d65fb\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"6f006185efda50f6\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"f2b8654e5be816eb\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"4feb11cc7d1fe6d0\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"fc1fd3497334baf0\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"47ca8efefa2a7b84\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"7d2d94f08543dac5\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"3de566839cffb846\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"8cb2d2fdd4abd42d\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"5fc9e610169199b6\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"7ddae9f1e1333c2b\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"8be411732420546f\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"9edcd74d935eea10\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"07e8347d264f2ec0\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"dbfa16d6f38100ba\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"11dcd26a52d12201\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"fcaf26b7c08a9527\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"1a23100d16aca1f6\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"4e115a88e8f01122\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"8804d1c19df1a789\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"3e23574a75f3d50b\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"dbeb76950c4dfa60\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"ac52f7fedbcda9f2\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"ee9a6492e8a3ea33\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"f1cd0f3c129ac6a2\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"b17f66e6e8a0a0de\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"903b9463ddead042\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"c77026507a00333a\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"52bca5a7c65d6a9b\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"659ddc88fba08644\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"02f23415b839d51c\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"aa2e35635680ee83\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"b0ad233d510378af\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"e56b2fb1c625801d\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"77fbc021f9ab7de1\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"11240eb2125f8d08\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"ec8b6dd6af13c6ea\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"a10257238bf25e7b\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"def0b92626cd69ce\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"19cd3e1f849886e7\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"589d0d134f42f37f\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"9b7e9914b9ddb9f1\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"a486ba2142810516\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"d9dfb54390f83a2b\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"55eb2d590e54ce95\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"02f09077dfe2a393\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"afaccc64c020f625\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"0845a825629e29e5\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"31172c7ae989f524\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"219d1303a5527871\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"3564f372b9dc5411\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"d5a32eaa9197a863\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"91c8a5e5dcc4af43\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"81a4d20b34961fa3\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"d52321913aedd818\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"291b0544c80c4e48\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"4e34e2bb74278563\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"d460e105f82c5452\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"ed1b3f0a7574730d\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"5727e7029be642ea\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"8ca4765b0ef57290\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"f8fa1e53e166e57d\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"9c06bd9f13a15b28\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"b96c510c6327b189\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"53b81fa316a3e328\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"992134fcf1cbc098\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"2e4898d4d1755aaf\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"8db831f28f8d7bc1\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"c74531445fe6597d\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"e7ae2d0cfa4f3bb1\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"9dd8041d71d40a0c\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"f81beb9c1ecb6ff8\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"80e0df21d8d81c33\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"94273d47bc51d57b\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"4cc1f1f34451bca3\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"173668f10286fc5a\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"8450c454018969e3\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"112287fdfa7fc732\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"57cf4a7b3058b624\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"45af6b5e20a2dafc\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"12546230e5af1e77\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"cdead8e0394922a6\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"bdb7d6ffbf1d7fa1\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"242a6174c9052383\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"0a333a811d3e8c24\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"ce0a5a3d7012bbee\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"e701f4f3e79f76cf\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"0a55160d7be3cf2f\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"400927ce89145c5c\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"f31a0c3647e34757\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"dc4c5614ebf80ddc\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"1a84dfa0a3845a5a\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"fe507930490477eb\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"ca0cf1a6c6d9b81b\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"00beb378a9165ec7\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"af2dae70622a4044\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"ac94bd6bddf270b6\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"d6aa31f4e67dd166\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"0b2447ab895d00c5\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"0ba74aa2d00f3a6f\",\"/knowledge-medium/src/plugins/recents/index.js\":\"72525bee641caffd\",\"/knowledge-medium/src/plugins/recents/target.js\":\"40eb51c44fee1732\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"22dbaa13c9da337c\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"eb0a524e86fda6fe\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"85ff2dabae703da9\",\"/knowledge-medium/src/plugins/references/index.js\":\"e9a0771b2c7d2ef5\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"f280668adbcde124\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"1c3084566f0255ec\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"5fa6d4341548cdd7\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"c04c239e6ead753a\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"2975aa607cc6f399\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"6b10e51ea9207edb\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"be7ec3ed483485bc\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"92a06957b7c59614\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"d4fc59418c94ee03\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"d54ff14afa718f5a\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"f1eb49670c57a0af\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"1e900a8e7ac66464\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"6cdbb5b2b48541e0\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"99f17056c28f25e3\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"d53c12ad216bde60\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"9bb96b6cc909480b\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"932854b39760c722\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"fdcd24b180ea53f1\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"e7b7ff9d06a9faf3\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"25120fac20a1fea6\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"a55786abb4f061a6\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"8425f63f5d93572b\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"44f24caca3609f5f\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"404acdc56fd45fbd\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"07fd6da2b6ec4950\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"9f65fe714053422a\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"a8cb3db26a1d5628\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"b074e1e60198f437\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"cdceb7deff571085\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"eaa6f7a33a1b7fcf\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"4acf0a2c9150f750\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"915b8d51d5581085\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"b92f8d0b50bdd84c\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"48f7ca7ccad57568\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"86dc87fb27e13e5c\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"44a99f8254bcd914\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"22ebe7c9c61affad\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"98c00efc6f541fae\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"2530aa670c65ca4a\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"590cc08aa02e4b22\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"38bbde995d6721e1\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"5ef19a44427eff1b\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"d050c4287475f4ef\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"e0cce631f7305382\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"6a9344f0f67f2475\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"2cd135e51daa3381\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"16d76c1377ece95a\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"a3e97830bd26a9e6\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"62c0206e0deb60c8\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"7ad7723607dad830\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"b7d19d58525e83fe\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"53394d121b108900\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"2cc0542f5f0dbd1f\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"242df16158866280\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"e14488efcb794d55\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"dc8a7b46ec7ee1af\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"532d8b18411f1efa\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"9be7631d9e67f660\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"f377085d23a44882\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"219b5a7e6362a362\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"09476e0ded5cd2fc\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"09c377412232f1e0\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"602807200740096a\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"3c38ebe6b7f7243d\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"1d4c6a59d6f0632e\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"083ee7d0b84ca310\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"327d5a5a9d64fb24\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"5ac9fc5a72f08800\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"7b12324292c1746d\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"01314699a4a088c5\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"07cc46efffb3595d\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"019c61ae849d5b6c\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"3425a96bd3b85ef4\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"20932178a99760b0\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"112e7a975ca2a21e\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"d054fa9b450b382f\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"8d57f59d05802e44\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"35f1b87fdaa21eca\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"bc2e7eaaf8b9dc38\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"82c08837a748642e\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"305305c7925b76ed\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"4042d41de4a4afd8\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"bff5cd5043cd8d12\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"154f4c78b9b9dbff\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"d995a653c092339b\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"d802538b4b73c24e\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"4bb3f0f66d919f15\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"80118fa67cba4fe7\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"37f6d3e70bb0b542\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"91411fff83d55d0e\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"59e8812096719165\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"fc17b31a672443b5\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"51957f64e69515ba\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"f9d180dc47668281\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"7adca75c3279175f\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"15599aff5c5af036\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"d17320c2c6f8fcc5\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"8788579b109af60a\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"387fdea058647fb1\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"551f4da7a0e4483b\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"4ee687b5df6b1b3f\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"4c3e82ab2bedddbb\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"114c472cf73989f7\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"e7b6f0cb80896761\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"db801f0816e7a5f9\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"2f361423d2e398d2\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"02aec6d993855229\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"e63a367414d4efa4\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"db32b3b02141f5f3\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"616c542cffdf19e1\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"4bd8542806591d73\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"9a4aac9c9caddd9d\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"8fe769ea6b7fd005\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"ca7a05f0b52bbe8a\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"4800f038fdef83ca\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"7a0fddeeda4fbeba\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"e765537d1bcbcc93\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"5337397f40e6a84f\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"c7c70b3f790ce562\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"9d1216ca54358f22\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"428737c777fe64fc\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"2bd2ad785871d02d\",\"/knowledge-medium/src/plugins/tables/index.js\":\"e929d581b61cdc71\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"1e7e2f230bc469e1\",\"/knowledge-medium/src/plugins/tables/model.js\":\"20fbe800471cbdb3\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"d030498875d246a0\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"1a0c92833cc95738\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"85152cfac482401e\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"5f00915d8f5083d2\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"ee464a80dab0b760\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"592b3dc4db0bac8c\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"f9caedfd4013e333\",\"/knowledge-medium/src/plugins/todo/index.js\":\"c7d9539d2f28de47\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"8dfc01eddfb9f727\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"81d0cc0029eba38c\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"f5629cfa56be10c6\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"c8366e4eeea97e19\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"a81e53dae1e703b8\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"74bb407ebb3048ad\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"2c0e60eabeec027c\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"b7d85aca5c4aa059\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"20dc3e7190c63fd5\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"937850076570aa98\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"28b4ff3d1fe5dc84\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"bc5db3b9cb1eac70\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"a6b20cdb45324647\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"dbf13304387d194e\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"765f41844cc2b85f\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"eb7fe3709e1643e3\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"363e8020af84f9e9\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"63a390a977c830f1\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"8cbd09dd6387626a\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"f98fd9f4ee8a8f62\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"1e6ad02d4664016d\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"ae4fdb482ecdc7c2\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"2b636cd56c44f387\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"4b7e4c9ed621ab64\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"df4557b273746f37\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"5c57f493e27ed365\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"f9430449c51f7583\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"fdfa1fbd342e51c2\",\"/knowledge-medium/src/registerServiceWorker.js\":\"83e514d0a0bebcc3\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"7cf2655ba2cf0cab\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"0d4d87d4515b191b\",\"/knowledge-medium/src/services/authStorage.js\":\"c9363b3c5e7f987b\",\"/knowledge-medium/src/services/powersync.js\":\"478565f4920b5e06\",\"/knowledge-medium/src/services/supabase.js\":\"a1bd26af843299d0\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"39e0cad1dda79d82\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"8c77f76a9c31a2d5\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"4d343cb2fa8529f9\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"706fb71ddf43fde7\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"587d300d6fa646c8\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"9049de519dbd7b16\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"27e8d3e5980ecc8f\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"f75dc99b52f19ca3\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"6cfd6765a9a1c3b6\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"5158002b07868827\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"a7d96b2a389e305f\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"a98ebdd3aa46db23\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"2231e6dd40455a7b\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"a3d7cfd879d1bf54\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"affa07c8a5488f7f\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"a813d3d12fa0c1c6\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"d8a9252e9fe6224b\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"f7a3b4c1bd52d903\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"04fd6266286114c1\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"789b3bf6795ce6f3\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"528fbc72370bebdd\",\"/knowledge-medium/src/shortcuts/types.js\":\"bb5d59961b56b943\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"126a324281712127\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"e5895a3e2f300493\",\"/knowledge-medium/src/shortcuts/utils.js\":\"171374a5ccb6b92e\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"4757a0c70a53ff30\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"4638807fbf91421f\",\"/knowledge-medium/src/sync/byteTransform.js\":\"d9c6e13513a0d0cf\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"b07f5426f4d77271\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"9a22e46e8c9268a3\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"be2267cdb8f23c60\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"8a8ce560722c8b31\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"08bc4a417b73a929\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"779297ee4dbbf98e\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"6be61be6fa83aac1\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"b64486f0b6db6f0c\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"abe36988fec7f567\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"c57ff4f8dd242c35\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"3ca01f3ac2914b68\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"095eee2d030eed67\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"b2f29326661d8c29\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"509e48d63868d911\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"fc9fbe6665d9440a\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"4fb63b3ef2e46d2d\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"3d759a0a54426d6a\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"6f8582068fb6a9f8\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"f113eb9a0542ca56\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"450ec5da51390f56\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"4f394940820d3e45\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"62fc01d7955af00b\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"32e6290d81ec2e1a\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"063b38d94fc75cbb\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"c6287dd31325dba2\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"698f9a07b4c3e4be\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"82cc72bc074f14bb\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"32d45105ac4a059e\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"15601ff98d5e4d9a\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"c3f0d343be8da2fe\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"7ba2543f7187eb4d\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"6e2cb7ba44451438\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"32906135394db743\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"c7780738106043a7\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"1a1d5ad771648039\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"9b4ab9d23ada2d58\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"45846a968d256f05\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"d4508ece60f044cd\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"db8cb5c584884dd3\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"1646282d8045807d\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"59a98c5014841340\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"8481652ff2ba04b8\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"081f97db7c29aba2\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"bdd3aa7f2c819608\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"bc6b34aff4067ec8\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"3688225ab51b2ffe\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"447c21b847caf99b\",\"/knowledge-medium/src/sync/transform.js\":\"84a3492385c587f1\",\"/knowledge-medium/src/themeBootDefaults.js\":\"8692a6d58194161d\",\"/knowledge-medium/src/types.js\":\"1429af3db8fa380f\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"b73c8f2fa5525e7c\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"100d2197fbbf4976\",\"/knowledge-medium/src/utils/array.js\":\"9818e949a9799499\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"b7d7e0316219d36f\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"c3be614830a262f5\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"4ed1e5d95eae532a\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"2605d5fc691a099e\",\"/knowledge-medium/src/utils/callbackSet.js\":\"15845b3a679572e5\",\"/knowledge-medium/src/utils/clientId.js\":\"12fb02763f29a769\",\"/knowledge-medium/src/utils/codemirror.js\":\"367bc260b052f081\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"71dcd4c7718d576d\",\"/knowledge-medium/src/utils/copy.js\":\"1d4cef9b28b71850\",\"/knowledge-medium/src/utils/dailyPage.js\":\"d493f3556d8ea60c\",\"/knowledge-medium/src/utils/dbForensics.js\":\"149426fe350656d2\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"5910539fe2457007\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"ce8a43e51854a608\",\"/knowledge-medium/src/utils/dialogs.js\":\"fe3e98b9c05c8621\",\"/knowledge-medium/src/utils/dom.js\":\"27692b00ee108a8c\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"2c628a378f73d864\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"4f3252c83b8a0c44\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"c5fd0f20a9880935\",\"/knowledge-medium/src/utils/flipSlide.js\":\"03ee3daeec4368b3\",\"/knowledge-medium/src/utils/fnv1a.js\":\"ecc7f8b1fb6ecc22\",\"/knowledge-medium/src/utils/formatBytes.js\":\"b7bbc9620d968560\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"c8cbe8315b3208b9\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"eb30348576ca7cee\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"24d3e12b43f83ffb\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"9e428113cb036757\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"f6b045ddc406df38\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"396e6f002f1e1957\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"bb67a8426dd19fb9\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"0dc291d1df8cc981\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"37268235b5343e3c\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"6c0e525b90feaf9c\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"e8e8c4e9b0845f89\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"5fa486f547fe05db\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"7734946d1b177c4b\",\"/knowledge-medium/src/utils/markdownParser.js\":\"58e069f7d0779ce9\",\"/knowledge-medium/src/utils/memoize.js\":\"ff1871db5d132ab4\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"58b4efe4b37c5e07\",\"/knowledge-medium/src/utils/nameList.js\":\"bbe2bcc6732afda5\",\"/knowledge-medium/src/utils/navigation.js\":\"459af284ed7ef3f0\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"2650b3b1c2496e81\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"74b6b4cfc12fd468\",\"/knowledge-medium/src/utils/panelClearance.js\":\"b459b2762801d4f7\",\"/knowledge-medium/src/utils/panelHistory.js\":\"2bada939516c4bbd\",\"/knowledge-medium/src/utils/panelLanes.js\":\"171981a58889fbea\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"b5428adcf898bfc2\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"3cb008ad57154183\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"864898979960baae\",\"/knowledge-medium/src/utils/platform.js\":\"9e2d610580ca9663\",\"/knowledge-medium/src/utils/pluralize.js\":\"f1e4de905cf12f5f\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"c94eb7cdd423e2e5\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"2f874a9da766bd13\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"4eee0f1df3e813a9\",\"/knowledge-medium/src/utils/react.js\":\"3f31d1dc3df2bcf5\",\"/knowledge-medium/src/utils/relativeDate.js\":\"91bb3800f8697fda\",\"/knowledge-medium/src/utils/relativeTime.js\":\"2e1043954be571e5\",\"/knowledge-medium/src/utils/renderScope.js\":\"54c1c56b26999691\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"7f8720c218428291\",\"/knowledge-medium/src/utils/routing.js\":\"4d790dbceae626fb\",\"/knowledge-medium/src/utils/safeMode.js\":\"4559b37b730ea498\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"2fc702f1c57c569e\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"1c7463dc4881e419\",\"/knowledge-medium/src/utils/selection.js\":\"9d470e0645bbb601\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"7cc75496d0380881\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"6c55de8fe601c12f\",\"/knowledge-medium/src/utils/state.js\":\"49de5e3419657a69\",\"/knowledge-medium/src/utils/string.js\":\"d02976dd25d2451f\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"488a2a929915b5fb\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"611f1cad42b2179e\",\"/knowledge-medium/src/utils/toast.js\":\"d49765f1bf0a8f98\",\"/knowledge-medium/src/utils/toggleStore.js\":\"2c2c0f629fe97631\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"7124e5a95c33b215\",\"/knowledge-medium/src/utils/userActivity.js\":\"f134d27bf4204cc5\",\"/knowledge-medium/src/utils/viewTransition.js\":\"40b8bc23c309afb3\",\"/knowledge-medium/src/utils/viewport.js\":\"3c1b11f41120b57a\",\"/knowledge-medium/src/utils/webLock.js\":\"890981de1755c054\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"e166aa4a858c1b19\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"73daa53008cd359d\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"9cfdb6a3e332e556\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"8100d8b0b5331eb3\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"78b9eb314e334ce3\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"aa9c483aae879679\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"53a18c188159b6c9\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"be10c1d87d005c21\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"72e195cb68ee869f\",\"/knowledge-medium/src/vendor/react-dom.js\":\"f2ae127140288949\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"4213d3e135882958\",\"/knowledge-medium/src/vendor/react.js\":\"fb2e512b9f3e75e7\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
