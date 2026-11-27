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
		buildId: "6b45e6234110-e237cec1",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"60019be5b6707c6b\",\"/knowledge-medium/index.html\":\"60019be5b6707c6b\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-CQKvyX1U.js\":\"37805e89bd7bc585\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"dba62bb0fd70eb5c\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-CibuggXx.js\":\"2daf07602d00ddc5\",\"/knowledge-medium/chunks/FacadeVFS-DLV_HQu5.js\":\"01763d3a9d873487\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-CpniPVAW.js\":\"a9554026fddadac2\",\"/knowledge-medium/chunks/MemoryVFS-iAhtgPVS.js\":\"9d28d08a7d05b878\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-IQvcRa5c.js\":\"aad987879b3b8776\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-Ch-S6q9V.js\":\"d8c8d454e69f80fd\",\"/knowledge-medium/chunks/Preview-BUbsSSHz.js\":\"3135bb6d54891940\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-C1T5VCea.js\":\"f7db38eae797af3a\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-CQ0LM4A7.js\":\"07795577bf3b3400\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-BB_lRgpG.js\":\"3f31c1021abdf706\",\"/knowledge-medium/chunks/react-BNfyAeUm.js\":\"087c44bc46825ae1\",\"/knowledge-medium/chunks/react-CFSKCXDX.js\":\"d3873fada6fc6ecd\",\"/knowledge-medium/chunks/react-CHZPG1Vl.js\":\"e93fa0329b6d910d\",\"/knowledge-medium/chunks/react-CfEuanAD.js\":\"6748aa6a73823fa4\",\"/knowledge-medium/chunks/react-DLOniZ2M.js\":\"f1d354d4c437e109\",\"/knowledge-medium/chunks/react-DZtNMWrZ.js\":\"5461bd2823a04d5c\",\"/knowledge-medium/chunks/react-UctO0Hgc.js\":\"5a7418b6e6623ca1\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-CKqpGugc.js\":\"67bb69ff40af27d9\",\"/knowledge-medium/chunks/react-dom-server.browser.production-B1bEa_E6.js\":\"d2cf19e42561d120\",\"/knowledge-medium/chunks/react-dom-server.edge.production-CPHoze6o.js\":\"4f34f7946e04781c\",\"/knowledge-medium/chunks/server.browser-lfF0_VtV.js\":\"7e32aa05fad7e98f\",\"/knowledge-medium/chunks/textarea-CKN1QJha.js\":\"a4da2d5ca5a95112\",\"/knowledge-medium/chunks/ui-3WhWSG9F.js\":\"0ff3d1a20a9b379e\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"ba493674d5185684\",\"/knowledge-medium/src/appUpdate.js\":\"d27c3f8a5ae7eae2\",\"/knowledge-medium/src/appVersion.js\":\"90c1bc4ec68e4a58\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"e84a379787a4ad69\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"d2afbaac3bf42d99\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"7ceb5cce8b9db7d1\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"b808324b8d21032d\",\"/knowledge-medium/src/components/BlockComponent.js\":\"08acf405ca8600d0\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"783b90c8147a0295\",\"/knowledge-medium/src/components/BlockEditor.js\":\"32597fd7495dfcde\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"6ee3050cfb16d22f\",\"/knowledge-medium/src/components/BlockProperties.js\":\"6e21f1de699adb50\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"29c45eb37bf347c0\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"130b0e89a49d8176\",\"/knowledge-medium/src/components/DividerHandle.js\":\"69719d6dae2a1f41\",\"/knowledge-medium/src/components/DraftEditor.js\":\"916f47b94d02af86\",\"/knowledge-medium/src/components/GutterPill.js\":\"29d1d086980cef64\",\"/knowledge-medium/src/components/Header.js\":\"8215920655c152c9\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"75f4704ad0d6c206\",\"/knowledge-medium/src/components/Login.js\":\"77742996d139ddca\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"c2ad28306bc358dc\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"17a81ffa8c6359f4\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"a60623076c938c9b\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"8c8466d415266959\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"4b4d8dbdd773ab70\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"926d8bdb604a3c4c\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"c4aa70b865d61afb\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"81ce7a58e8be1ee2\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"c7a1bf3f1c4071ae\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"56879852943a495d\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"f2751e511503a969\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"715ef1bbd7b0417f\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"3e5de0230774fdd2\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"7529338766d108b0\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"49fe3e7138aa7912\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"d7dbc402a3ac20ce\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"d58e0412a1add7cb\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"949b04b178c9efca\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"cdf6183b1e99e776\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"b34caf7bd631177a\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"4ef40f5b7fb143ce\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"aa9ea45404d46fad\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"e71e1548973bc17b\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"9e40539f648d2e5b\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"718277addd8119d6\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"10c27233f6cfff26\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"356570f38bd048bf\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"d7317a2a90d29037\",\"/knowledge-medium/src/components/references/CompactReferenceLink.js\":\"244faeb0e3723396\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"70f08a4c02f48941\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"04274a6392afc38b\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"a48eb040560303b4\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"81828f41c6aba2db\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"5e5b826fc69c4428\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"e68ba735f5fa8509\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"2d31185373e0c79a\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"2dfd552bdddfe8b6\",\"/knowledge-medium/src/components/renderer/BlockReadText.js\":\"cbe305e444bf36a4\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"ab9c09f099ec6bf4\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"fa00fd3b2686e48a\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"6262baac567e8d48\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"894db4c3ea6fda40\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"9f792b4fb056049f\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"874853467f293e13\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"23e9a075dc677e93\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"8acdedd427b38d08\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"ac5c37a93828e1e4\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"afb30f9ab4bcc1bc\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"be11f476cb2e42a6\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"0e3d615c1c8b1c55\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"4fb9ce7ebfc65b26\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"37af003bd9545bd1\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"b16c5d383fe4f961\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"af0872ef07e0865c\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"6e881d50e118776e\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"33ab20d375a710cb\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"37dc46f4a1bd8a8e\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"447846d30b5e3c73\",\"/knowledge-medium/src/components/ui/button.js\":\"7090c2647b32ca3c\",\"/knowledge-medium/src/components/ui/card.js\":\"1ee73ab795f5b792\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"da9074279b66bb55\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"f5260468c5cf3f65\",\"/knowledge-medium/src/components/ui/command.js\":\"01d7893a3f777469\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"147beb760fec4a18\",\"/knowledge-medium/src/components/ui/dialog.js\":\"d44db59978fd428a\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"794ac9d9e32588ab\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"27587b8bbeb13955\",\"/knowledge-medium/src/components/ui/index.js\":\"f3f2b6f2bad38779\",\"/knowledge-medium/src/components/ui/input.js\":\"2215b7097b8a9833\",\"/knowledge-medium/src/components/ui/kbd.js\":\"3cc5af63a6f558a7\",\"/knowledge-medium/src/components/ui/label.js\":\"38b1e47828165ad6\",\"/knowledge-medium/src/components/ui/textarea.js\":\"1d98fc031e8ddd67\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"adaa8dcba6021419\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"0e224573a118d8c4\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"d539e58caf48af94\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"72b2b39f56d34228\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"bd3eafb70e8e4672\",\"/knowledge-medium/src/components/util/error.js\":\"db53b77f1f384844\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"72c43f7fd8a07a4e\",\"/knowledge-medium/src/components/util/suspense.js\":\"66881198ab595026\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"38799713bd479119\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"e5549d46c9a66927\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"5371626441844874\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"9af3cd922abb01a3\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"6b93234316c930d9\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"b75b3722972e53c9\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"48333acca0976546\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"ca3c3e3e863a8263\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"472a1e7860c3cf12\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"8f5d384ac4f02c15\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"932115acd5ee4363\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"ecfdc4276b34e470\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"d22a7d743fa8458a\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"7fe5002c96cdbbcb\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"d0410afee5fdfcb9\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"e1a63a949b8b9ae6\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"ba678d258273080f\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"1791d351745c34ef\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"a34993266073dc3d\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"02fe4c5180a54560\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"895c30a23e9d13e2\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"463df98d90d6696e\",\"/knowledge-medium/src/context/block.js\":\"a811d7962f25a442\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"94795866b0d99688\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"dc0efd6d9102d722\",\"/knowledge-medium/src/context/repo.js\":\"3405ed5938cf144c\",\"/knowledge-medium/src/data/aliasClaim.js\":\"fe5d7cc0a138c83b\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"5132949588df6cdf\",\"/knowledge-medium/src/data/api/blockData.js\":\"d93e70a57a9239e7\",\"/knowledge-medium/src/data/api/blockType.js\":\"17d5bfcd04c1eddd\",\"/knowledge-medium/src/data/api/changeScope.js\":\"f304649f3679c9c1\",\"/knowledge-medium/src/data/api/codecs.js\":\"0a1610fc4ca4f0f7\",\"/knowledge-medium/src/data/api/derivedData.js\":\"f615b195df47dacd\",\"/knowledge-medium/src/data/api/errors.js\":\"bb3565261e63037f\",\"/knowledge-medium/src/data/api/events.js\":\"59aee7f10c38c104\",\"/knowledge-medium/src/data/api/handle.js\":\"42d101f54849a25c\",\"/knowledge-medium/src/data/api/index.js\":\"00e0c21e2fbc41f8\",\"/knowledge-medium/src/data/api/mutator.js\":\"c7c9a22c117d2076\",\"/knowledge-medium/src/data/api/processor.js\":\"04735d0af5267aab\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"57fa379e5da4b0c7\",\"/knowledge-medium/src/data/api/query.js\":\"34e927668a3ee5ea\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"8f1d13a775492973\",\"/knowledge-medium/src/data/api/schema.js\":\"42d101f54849a25c\",\"/knowledge-medium/src/data/api/tx.js\":\"42d101f54849a25c\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"d295faabdf3e5106\",\"/knowledge-medium/src/data/api/user.js\":\"985be4413fb93f02\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"df0fb8c52499702d\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"18dd2bd52c78674e\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"c805057d55681f4c\",\"/knowledge-medium/src/data/block.js\":\"2e3cc8765cead33f\",\"/knowledge-medium/src/data/blockCache.js\":\"cb82d284def3b6dc\",\"/knowledge-medium/src/data/blockId.js\":\"e6d061d91360e583\",\"/knowledge-medium/src/data/blockLiveness.js\":\"5a946611c048634f\",\"/knowledge-medium/src/data/blockMerge.js\":\"32230182ce31b3b5\",\"/knowledge-medium/src/data/blockSchema.js\":\"608517447f6bf801\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"a6df8e0b9b1eef68\",\"/knowledge-medium/src/data/blockTypes.js\":\"404f027d7c1f894f\",\"/knowledge-medium/src/data/childrenView.js\":\"bba963050922430e\",\"/knowledge-medium/src/data/clientContext.js\":\"cb29f04143168f36\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"af9e1eba203fc7ba\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"c57209e9a18b8222\",\"/knowledge-medium/src/data/derivedIds.js\":\"d4b5d0d80244538c\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"32c0e7c42823ae71\",\"/knowledge-medium/src/data/facetBridge.js\":\"f969faa08e07e406\",\"/knowledge-medium/src/data/facets.js\":\"4985f6d8480370ca\",\"/knowledge-medium/src/data/globalState.js\":\"dd2852c323cd12aa\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"c8f0c26075249a81\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"7a12c9aab30b0500\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"a901d4bd43eb4215\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"3d5171b92cb2f174\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"cdf875c01726fa76\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"00efcb6be4cdbca7\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"a73aea0ac8851be1\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"81aa3a53a54420f6\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"ef299d713400f4f4\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"49c9bfe02aa89a55\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"e31d16d503778689\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"1e71cff78cfa97a1\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"3c78c6cf1a1f6eb2\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"666be57a41c055fc\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"70fb2dd9b431c654\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"b5363905eb086b12\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"82645bfd783a51ca\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"2832ecb5224f9bdc\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"d58c0d20db1dc734\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"d3993652af7373d8\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"12cbe647308ff4b0\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"7cf2e8f11ca8c1cb\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"154784f1d1297657\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"1e122afd3a352c27\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"204e4c2c2975068a\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"b8e540050c20c496\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"7ec11413e8dcfff7\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"ec2adc817ed5fb9e\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"e7e519c4ac0912aa\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"9581077861ba531a\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"68b4d8b3baeedb94\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"a4841ca47890888d\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"2391e29ab10fc7c6\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"1692cd99a58ba9d9\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"8361816ff3b2dee4\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"8181746d8c5fa75a\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"b4a6ef2ae0f22025\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"bdc7232a3d279551\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"95c34fe87f717638\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"3c5568a649201193\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"8c8ae0f6a78a5f16\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"d4e7f951384430f5\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"9314fbbc966a856e\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"e694ac406d892cfb\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"fc89d0ef6776847b\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"191adb9f5e326cb5\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"cac6717d0d4a3253\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"f36f30f8a8e1fc00\",\"/knowledge-medium/src/data/invalidation.js\":\"2514f16600ac72e3\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"9fa14c193b3b13ae\",\"/knowledge-medium/src/data/kernelPage.js\":\"aeefe8d531481668\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"15391fd1af865da4\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"5dba3899c72f3517\",\"/knowledge-medium/src/data/localDbStorage.js\":\"71b9a46cb911289d\",\"/knowledge-medium/src/data/localDbVfs.js\":\"9b596cff5eda9355\",\"/knowledge-medium/src/data/localSchema.js\":\"d5282bfa7a493cdb\",\"/knowledge-medium/src/data/maintenance.js\":\"f4b19167a730bd1e\",\"/knowledge-medium/src/data/mergeProperties.js\":\"1ec5b3533e0a8996\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"457a36e511e3d298\",\"/knowledge-medium/src/data/migrationsPage.js\":\"4c48e29d09479074\",\"/knowledge-medium/src/data/mutators.js\":\"031e29c1d14baf37\",\"/knowledge-medium/src/data/orderKey.js\":\"4ce66db5e8f35fa0\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"474a9812b2f46d5d\",\"/knowledge-medium/src/data/outlineSurface.js\":\"51240289d68b9d5d\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"c54bc57cfc3c6045\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"dec1c1575c302d9c\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"714e53861cd1fd3d\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"7dd40066cbf0e23e\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"781e94b87559775f\",\"/knowledge-medium/src/data/properties.js\":\"db3a300617762a54\",\"/knowledge-medium/src/data/propertiesPage.js\":\"f1492566205b4949\",\"/knowledge-medium/src/data/propertyChildren.js\":\"c2e6e17a2bfe88b1\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"716347c4b904579b\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"dcd3c0202d9fa1cc\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"1794947560539e7f\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"25c29b74894d095e\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"9bde97e6119cca1c\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"eccf695dcd1fae85\",\"/knowledge-medium/src/data/propertySeeds.js\":\"1e184df77670102a\",\"/knowledge-medium/src/data/recentsPage.js\":\"dca888c64f0a3b8a\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"c437ddfbf4ba44d0\",\"/knowledge-medium/src/data/referenceBlock.js\":\"d9476d432d6f1747\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"de795dc2bbd43afe\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"3f2e6eeae34b3e3a\",\"/knowledge-medium/src/data/repo.js\":\"afd84dfc2e73aa59\",\"/knowledge-medium/src/data/repoProvider.js\":\"396c4c33f612136e\",\"/knowledge-medium/src/data/rowProperty.js\":\"683ffa2bc097a643\",\"/knowledge-medium/src/data/searchFilter.js\":\"a3b6a756c272887a\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"38663a33bf2cfb4f\",\"/knowledge-medium/src/data/stateBlocks.js\":\"101bc818b4bbf8e7\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"4ad1c5279d5bcf08\",\"/knowledge-medium/src/data/structuralInsert.js\":\"fdb731fd1802f102\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"a37e88583935b82f\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"f9ac6c118a01a53b\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"fc7870be9b10ce60\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"529ac865dab24946\",\"/knowledge-medium/src/data/targets.js\":\"026f869523714f78\",\"/knowledge-medium/src/data/typeColors.js\":\"2c0bb78fb3085009\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"5539120b8843b5ff\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"fbb51c6c1132b4ea\",\"/knowledge-medium/src/data/typeExtraction.js\":\"9e16b11bf68b8fa6\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"0315d7c2b6eaedf7\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"1ccfaf30e75ff7c6\",\"/knowledge-medium/src/data/typeSeeds.js\":\"45cb4954f7e50107\",\"/knowledge-medium/src/data/typeTagger.js\":\"76ebc61df5ac09c7\",\"/knowledge-medium/src/data/typedRecords.js\":\"65749af8185cf21b\",\"/knowledge-medium/src/data/typesPage.js\":\"c2739e015dd800c5\",\"/knowledge-medium/src/data/userPrefs.js\":\"c865248b557648eb\",\"/knowledge-medium/src/data/userSchemasService.js\":\"1319adcc277a0e34\",\"/knowledge-medium/src/data/userTypesService.js\":\"cede164451536283\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"b4f323f297539e2e\",\"/knowledge-medium/src/data/visibleChildren.js\":\"7a4156116fa62ee2\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"1f0fe2825fb4c2ff\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"d8aef5df30ecac84\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"4abec9429059cf7a\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"4217c9b86b4211cf\",\"/knowledge-medium/src/data/workspaces.js\":\"2d20ac5ac743435e\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"5afe40b316d5a53f\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"303b3b62e8682c51\",\"/knowledge-medium/src/editor/atTrigger.js\":\"6aaf62825fbd7bdb\",\"/knowledge-medium/src/editor/autocomplete.js\":\"a5866c314b1361c2\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"4e7490804531ea0b\",\"/knowledge-medium/src/editor/contentFlush.js\":\"3f23e286001ce99a\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"31242c3625deab3b\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"533b18945934856f\",\"/knowledge-medium/src/editor/insertImage.js\":\"00307f757095ba9a\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"782cda735cdcbe8d\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"75c31c2fa5f5f1e7\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"4b9ac4bdbdccb717\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"d41337e94319be85\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"5b8fb2b7e317bda3\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"12886dd6530c1356\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"c6f6d501d71de87f\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"8fe5a664f635b78c\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"787de68bad16982b\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"713fbd516322caa1\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"23d46b8c3d6b56b1\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"af1ab458e1bac8ef\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"8aae8e65dbab0ac4\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"84788aee0bda4b83\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"7bb7f767173c9aac\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"2438c47df23fe3dc\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"389d68fd644e4232\",\"/knowledge-medium/src/extensions/core.js\":\"67c59724d74ab01c\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"9bea592a93baad61\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"c60c41308215af4d\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"638bc845fa478f60\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"8808c72cf0761f64\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"fbec0054da6a9713\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"7a225da139339aaa\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"85b2458c1137244e\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"3836b26667ada534\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"ba4a79a21eb27ddf\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"7350f15f03d5683a\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"af04b76cf36669b8\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"7852f2b388c767dd\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"9b3b982d3028b9cd\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"ad28e144fe6becbe\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"8229e9c845659063\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"1160410341bb932d\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"d6cfb706eea5d2f7\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"2bcce1fb23a3edde\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"b6b5cad1dfd3d866\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"21fba59375a15b22\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"d8d54053616eb8c3\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"5fe7506e4a333426\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"7b2fb196410ae0eb\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"fad2d501c41d026c\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"c011a6b26442670f\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"1c8e7b640b5c95ed\",\"/knowledge-medium/src/facets/facet.js\":\"d0149b9bb548b0b7\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"e830f2934b12df79\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"0aad24d03c75fce5\",\"/knowledge-medium/src/facets/togglable.js\":\"116eb5d017031022\",\"/knowledge-medium/src/facets/variantFacet.js\":\"b338128ec49a099d\",\"/knowledge-medium/src/facets/verbFacet.js\":\"d93961dfa679cc25\",\"/knowledge-medium/src/hooks/block.js\":\"a45a00cf2dc63517\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"7f19936a867ff68c\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"e3e81080933a83ef\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"1332cb39996bb6e1\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"00b7f90105e795b1\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"2a32b405aa154e72\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"96aa225f3e678440\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"e620b0929f674dd4\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"9e62567ca5895056\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"53fd3c1b053d4ab3\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"0332dac538ba607d\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"0f9857f229d5efcf\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"8b62f4300b84d8ee\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"320ce61cbb1ef73b\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"76cbf8eb545a8b4f\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"eb15a3819929831a\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"b28bb8a6cc525242\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"927a9d17b24444e7\",\"/knowledge-medium/src/lib/utils.js\":\"2801a6bf736bde74\",\"/knowledge-medium/src/main.js\":\"a4a1716c26d8c183\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"27bbecda18f27c8e\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"25686746ab47bb1a\",\"/knowledge-medium/src/markdown/context.js\":\"a122159af8505f0a\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"fbf4742e919412c3\",\"/knowledge-medium/src/markdown/extensions.js\":\"3c43ff7694480ff5\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"22268f021274d199\",\"/knowledge-medium/src/minimal-editor.js\":\"3b2aca97e285c0bf\",\"/knowledge-medium/src/paste/armedCut.js\":\"72d618b76279a101\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"aec31c558fcf234f\",\"/knowledge-medium/src/paste/clipboard.js\":\"c810ea0724ba9704\",\"/knowledge-medium/src/paste/decision.js\":\"185c0240015dbd7f\",\"/knowledge-medium/src/paste/operations.js\":\"ef23f8f1267474fa\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"38cbf368172d4daa\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"49a19d5970295c05\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"b21791254642f1e0\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"b19c37d6319b133d\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"e760fcb92efa3120\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"82ada83621587a1e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"4576faa0b7d4b04a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"0b28f8b330234178\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"5569639802085827\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"b9323da02be5f8c4\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"93822edcdec151c1\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"f1a486c117262413\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"611330403f305270\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"e6da9b46ec8cee63\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"87f0f6663e862ca5\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"42a2d35246b6bf5d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"5ef1bf26b72540b3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"68bede882e2e51d4\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"72281e8a0657c959\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"e457b6dc71b1a380\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"0edc75d897ae5e92\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"bf2805291e60110d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"59afdec4ad13127e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"201e100dc58ce123\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"771a8cf984cef2b3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"6c70f368ebd0305f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"3448a6bc77730f06\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"7b87a2f0f3dc1a64\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"1862715f9ce807c8\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"0074248467206cd4\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"d83721ee4794825e\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"eca218be4e9cc7aa\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"ea94ab98f37cdb0f\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"76636f4ba0b15f55\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"72f5647c5b1dcf04\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"876aa6b882847503\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"473b8c97055754d7\",\"/knowledge-medium/src/plugins/agent-runtime/dayPropertyInputs.js\":\"fcd274412ddb78f3\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"f2ebf0a75b4aaacb\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"0bfd5837de22a748\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"056b36f4d6bb626b\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"9bc593aadf91a01b\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"8132a794395cb18d\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"f79bab4fd3396efc\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"7e6bf0c6dab327df\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"2519752868cfe9c8\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"5f2901d4b35aca46\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"9a5f521a215f72e0\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"6ed61b8e89215131\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"6d01a3be320d732b\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"220f6f7ffac2e818\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"2947fa9d9e708645\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"7fa91d2f81829250\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"c4a1599de9cbf763\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"84b479221d835972\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"07bb6e81a0a95dfd\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"3d19de6c4c1355cc\",\"/knowledge-medium/src/plugins/alias/index.js\":\"a6d313ecf797b8a4\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"c23754e70015b4d2\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"8b87546c372abf4a\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"4ef746cf7df7eed4\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"a1c797d8fbaec6f8\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"4226f2ddf0b2776c\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"51968eadc420e2eb\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"80ec64629322ea88\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"baee6d19ce15e9ac\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"2300665484e74a73\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"0c7cec5acb215670\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"6d4ceea2ae46622e\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"6e6e91829ce6aa92\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"7718af04d4ba3689\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"3ff03f976c7c0993\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"5b5e712da6f34de0\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"e39bdc7417ba97a2\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"ee5a38fe1f191523\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"41eeeb0b3555edef\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"e374cd70077a5cf8\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"cbe0f069c5c3e0a6\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"2e74e71a80161de1\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"0353ce2c07166ed5\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"0f256d38370ac87a\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"8484cf83a02d1465\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"4153b03a918b1942\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"e35c41ed737f3557\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"749beda8831f06ef\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"80304c45afba52b0\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"03718a44c728f959\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"967ba7fcb62aab03\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"947c2827fecb9c6f\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"a77d1362ccc83b7b\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"c303d5b47f6529f5\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"78c650d9ef3d8e15\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"a881c1d1443b7453\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"25da892da30ac49a\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"dc544000f10d67ca\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"dd00403737b9182e\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"cf0cf5d74d33d3ff\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"0761c03ecfcbd696\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"171aad5b5d776984\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"478ad8e4263e8fe0\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"010948f5350475da\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"b68108bab78304ed\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"9e2095c00d12ef0d\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"6ac8ab5cb174f873\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"ee6b13cb577a7d9e\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"71222fbe66bd1638\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"b86de90bb468c3b2\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"cca3c6c531a82da7\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"b111286473f307a1\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"06e7fff634952dc0\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"6f28109a4e816115\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"39e0befbf04cd5ab\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"e70ca7ecdc484f02\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"28f77de0dac3867d\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"4b678217ad9a98e4\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"979ec9bee33af7a6\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"94dae7d5c97b236b\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"3586bf6b4d537b38\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"ef25581ce5082a52\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"e31a5672f932508e\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"06e93956783e10e0\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"8654bc706c4efd64\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"a3462c7fb3b536fb\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"d8bd3f6d668805e2\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"575f154b594510d2\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"805c719d39263678\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"73dcf4788805fcd7\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"bfb95d2bc98ee577\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"7bc953e2c2f4e15e\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"f57e235213c401d5\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"d9949a74640583c5\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"3d81ba2df3e7f1d6\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"5a7ba8a1c9544266\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"22fe4ac9f50a7d6e\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"b2eaa82a8c39acdf\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"55525c09fec02238\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"0515798a76362155\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"daf9d354d1eadc27\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"33b3670529ca15e8\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"3b2ba237ee5d169d\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"b2dd35d46ce2ffa7\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"968dd317a1d08b65\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"cf4ba9e8a8abbe53\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"9d131c260953e040\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"88649aff59cddf80\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"3d64e2c06e1fbe34\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"5cb11f811f8da903\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"3d1a679ed9fe6aeb\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"44835e50ca60b4b1\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"fab38822e68e0308\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"9ec967ae27fa5ce2\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"166bbae10e0c3bde\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"dd8cee3555986e3d\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"f7b29b6edadbde5b\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"3636815ba8c2cd9d\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"8b15e8a708a08a0f\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"1988fa5d5bcd41c6\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"4340540bcfef4952\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"689df2ad9a68332c\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"0cb071beec45d244\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"0f9824200248b84f\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"7216250824fa183d\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"88195e036e5b48d8\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"b782e103a63d7a03\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"12556f670e74164d\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"11d6d149a45a0df7\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"f1004d4ae684c453\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"915732ad18fcb198\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"909947fb676ee96f\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"5f49616ad4fdc44b\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"a6447c429f998010\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"8258ea2d3cca3af0\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"3ffe2d2325eb3ff6\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"5cbeba77a343ffbe\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"48d8eae69c8f495e\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"94a835f60ad1fd70\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"d68f6449a5a6c80d\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"0e51ec8e72eeb4fa\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"9db288b60c14782f\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"0ed757b2548d943f\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"796247f885bbe816\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"adb4b9049f5fa04a\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"9f4dd25c75902f0d\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"2c338a6b2a9c232a\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"958d81a77e389ad2\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"1cb1249638f050eb\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"fe1c9e71e6bb0d4a\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"430f9ae2abe640b4\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"683e116d6ab00040\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"785f9bcdb8f822cb\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"7cfc53c78aae81e6\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"4c3beeeacdd3014d\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"f165cf9a29a7f4e7\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"3acbc48bd5dcbbde\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"e2d41a8128c2cdf8\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"7a371587330a01f7\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"1c9776f1f897baae\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"3545c2d0ce712efd\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"35be94baadc92ac0\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"49619e589f6846f6\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"cb8e614946fa6532\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"f8ee5d311fef0248\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"d5d4961d2f708384\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"d2edc75225e3c984\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"9067e4926f98b773\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"97cb0190d6f65a06\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"cdb87ad0e45d3afd\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"b82fdd57bf3be119\",\"/knowledge-medium/src/plugins/character-counter/subtree.js\":\"8c0e012252fdb2e5\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"290dc35197e6a40e\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"82ab5b225311508b\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"7885a3e100673e80\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"b726fb6c325218e5\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"0d0953c1b52b5640\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"65b5fff486530637\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"db548bcb2d3ff96f\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"f36ba676a7c91d88\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"869ac5b198cc70eb\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"721fb016e3e3f81f\",\"/knowledge-medium/src/plugins/contributors/ProfilePicture.js\":\"c939382c4be2b8df\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"8f165d5cef93b728\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"84863addb579d21f\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"8fe1d0a300cf78d6\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"6fcd29e8c5d9f594\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"286973665452568f\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"e58ae4947526a2bb\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"f94511c9e7ef360f\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"7ba670662447cb51\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"52a43ae2b0f449e4\",\"/knowledge-medium/src/plugins/contributors/useCommentAuthor.js\":\"c71d4cac7d79de26\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"045ad27b8739d4d6\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"5b6c1f97febc78cb\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"213c913854bc73e6\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"79c24ff28381a804\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"1ae9532c3c078f9c\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"0df737ba4daa1621\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"8f0c4e818796eb47\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"02452143295406e9\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"f41a86e2ceaa29e1\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"f692445fd08d7a33\",\"/knowledge-medium/src/plugins/daily-notes/DayPropertyControl.js\":\"60eae75afc68e17d\",\"/knowledge-medium/src/plugins/daily-notes/DayValueReferenceControl.js\":\"e169b9285d7be583\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"2f22b0c3f0e58953\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"7664d68f07dd937e\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"732946ad69b881fb\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"c5e1442798da37ed\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"cd8af83ee779c741\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"31c141b693d82d7e\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"95ce006ffdeb8809\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"a34503c4895e8aec\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"494a3f9819cfeb4b\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"20f0957ef4d653de\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"6eb8037c5c48a165\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"a0c2a70d94f2ea93\",\"/knowledge-medium/src/plugins/daily-notes/dayProperty.js\":\"5c0360e270e29b3c\",\"/knowledge-medium/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"d9bb907075505d86\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"ff9daf90ce13e6ef\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"194a347a86b9c423\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"36df06a3e6c58383\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"20f78f14c84d8aee\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"7fce8b23750475b7\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"b7f3eb548751a9c7\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"16cf6410d04075a7\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"8ed01fecbffc62ea\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"553e033888c6d3d6\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"080e6c0ea7494a94\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"72da04afa80bae3f\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"8539bd27fa3202d5\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"cf5011091deea5dc\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"90f1cf2381388b55\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"b1b207f42afa005f\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"763705b6576fe099\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"a6da6cd12ac02612\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"f6fc712c8a3a8d91\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"e7614c3f9559bbbc\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"86dc724c54fa3834\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"a65ba43b27098e4f\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"a1fd9e52e5a2c06c\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"dee2a011839fe854\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"f95ffab5380ea0ac\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"cbd179c20ef2db47\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"2145e004de449983\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"78f14b5b98e171a1\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"be1356d4ff6cd7d3\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"950c2d1faa9e22dd\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"8d62f2c5573249f5\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"72aa0725affb1823\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"75eca6e13f45c2c2\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"796613a2426cf539\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"00f3047783c18534\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"dde2af35595793b5\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"ce035996383c6718\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"2b239bdb41b1faf3\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"0b3e070662de5eba\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"304c8abbf1421e28\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"a87c12b6a18c0c6e\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"47a6b24abb2b1c40\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"3292c50778f2f02e\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"a0f485d31d20bf98\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"93b226afdfdb9c89\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"2bedccbb73f95de8\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"38770b79a160ddbd\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"5185fa3345f8bcef\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"e35b18bd6b27ebe2\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"42cac16ad6c9571e\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"96b8174c2d87f31a\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"6ee1ed5569f352ba\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"af6dd97063f96294\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"304fe14bd6a45776\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"78b270c03bdeec1c\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"05a9a0f2bb013389\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"5feddd6d5ff7cfad\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"e27c1ec36587e9dd\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"17504ccaac4c62d9\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"034ed8069dd295e3\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"d0f97c04c329114c\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"bf45d9fdba146d03\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"4fc44404b2ab9e7c\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"e9f62e8c9716c57c\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"1258390113e33f03\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"1d50f7d436602fd5\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"1d72399f5e4530a8\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"0f0ff2fcfafb71f1\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"698110b5f89717f5\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"4f98887deb8ace5c\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"9295492eee28555a\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"fd534c91da092d8c\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"61c3124490b8fb1e\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"4c50593461f763df\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"64887513705cced6\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"059fef1fe6d9ab82\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"a4916a6b17e245a5\",\"/knowledge-medium/src/plugins/geo/index.js\":\"86543ed357c126c4\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"9523c2d5197a84d7\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"5a4b7bfe8da4d439\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"ecb4c02276c7f4ea\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"bf30d6db5e3369e5\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"423f90b4d72a259d\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"65ecec38e4d13039\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"833b0c638812da6f\",\"/knowledge-medium/src/plugins/geo/query.js\":\"2a89a9d707a9a41e\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"478d5ca30e12e664\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"fd0f9f5a380b7b96\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"864f9fffc3284438\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"3909922f1db5e214\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"07e701a8b7e5130c\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"f433f9beb9290fa8\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"abf37bffb6e4d33f\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"bdae1fdf2041b7b1\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"90244f73b2179063\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"70718046862122b2\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"5c78a3842d54654b\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"64c5b7a9fcae2531\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"45088e9ef568c3a4\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"b558efc75c82794d\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"e2d5dbc405c01df1\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"284c550abf7ae9f4\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"5ebc14dd25c8b309\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"b539e2b694e21ba6\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"709d6f433791ba45\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"6d2f0da16f211fbe\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"24844f46d830b5de\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"2c2a7e687c17711c\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"7bfbbcbe624b31a7\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"afa5a6219fa1256a\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"a47f4c780ad51269\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"7028ec8cd3be098d\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"3459a51907df92b4\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"433028dbd89578b8\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"6d11b517c3215a41\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"7adb48f81297b73e\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"8607ca16da2cc50e\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"5a3e2015afe8be7a\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"95188b76bfb69bb5\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"5ec508f6b02ed9ff\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"d4a5617ab0e7a0b7\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"3b8362abd6f6a4d7\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"cda978121fcbe4c5\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"8dfdd5e5df55c17d\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"91924efe5fae1a69\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"5737ae904c29a53c\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"c6f0ba52975a51ca\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"1757f5809fefcb26\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"c0463dfd343af212\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"5bcae96b37bca744\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"b596922a46d4459a\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"535e316cbf482871\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"6b91eafe8d3ec338\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"e734b418dd06ff19\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"fd52b000dbdd67ba\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"f1a7aaa234211724\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"924c1aca644ea8f2\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"20d84f04f075aac8\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"4a610f83475de300\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"e98736cb8fd325c0\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"fed0ac15b702952a\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"9d5bce3194c69f2d\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"c257f50dc273734f\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"77d62190e8b0b934\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"7d473996e888aaf1\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"b1e5ca9f850d077e\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"a7d65949485a7509\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"b62b6c4280cab9a5\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"a979a7ce03a8d240\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"1fcf4e1a6bcc103e\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"e4b7bef4fc7a8707\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"10a94310c81725e1\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"9d28cb708a5c91c2\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"bda07bfdc0ffe621\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"e89b5efd43a68cd0\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"1fd8e7a8b74262da\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"6a7433d88a65c601\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"3788bb19cc333aea\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"bb148def67c23231\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"5378ea3ca2c48368\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"477cda68354532ce\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"754b8a5833aea67f\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"1f024f321b05699b\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"364e9c34f97b4e45\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"00878a6002a9c6ff\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"2cdf46e09c7de16b\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"284bd5bfe80305c1\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"12f486fe8af4ccba\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"dabf22818d88f6c0\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"7f3d341b354110b7\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"fe4a55ec06a7947b\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"5f0a716dab0ca468\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"a398287daa56be72\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"a6d66932808abcbd\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"472ff739c53d9cd3\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"29714b09d649bd43\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"40798924f4986d5e\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"1780cd3d23d00e83\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"bc296158d000bd39\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"dac14b3a66d1fe0a\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"ccee2801f8bbd1dd\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"f9439f484ae1f214\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"08345c82657a7bce\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"de3ac411dbc42171\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"d1ba9da5cf32b227\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"4fab117fc3baab48\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"a85f844bb9bcd6ac\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"650811a758fc8d97\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"b8b13cc3edc3a8de\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"4918da588d8f3034\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"665da58c74835ff4\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"6795cd5e3265da39\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"50c1aac8e659154b\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"95e03559e10d9d5f\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"a821ce111fba1c49\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"2296876e25856e14\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"61a955e7c0e4c529\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"28464c4f9c547b86\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"a7631bdbbb21b605\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"ab44a0e9d1fae76e\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"f4f1819c78aea8a2\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"11d102d5833571ea\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"2931be9b26998730\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"3dde552d8398b573\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"4aefbaa958a6637f\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"803fb210129bc611\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"80cb30e29cafeefa\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"4047a9c3b080616c\",\"/knowledge-medium/src/plugins/recents/index.js\":\"fceecf1bc0e00ee2\",\"/knowledge-medium/src/plugins/recents/target.js\":\"709c489256aee63f\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"76db6634818acbd9\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"c84fafbf1822b91e\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"fe66d0fcc9d4ebee\",\"/knowledge-medium/src/plugins/references/index.js\":\"a596b388adbadcbc\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"be85c874bbabba8c\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"e0f4513da349370a\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"986856f16cee1514\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"58fc9874a0689a8e\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"f0923560c41fa829\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"fe5efb84e9c22bff\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"78962c163416f0e1\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"e99fd8a047fe655d\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"dc44ba3f9b27d6e4\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"2066af5dfff861cb\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"3dd035292f85cb6b\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"b94aa3e4bcf4c703\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"6c0734de426742b0\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"153331a1d95745be\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"90af2234d009d049\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"975553ddcb6f4649\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"6aba529b1cf1a429\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"7f4ac360fbc15bfc\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"26ab790f5cbec473\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"2c48c2f0d97e1067\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"dffab3442ceac00d\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"3111ba7e2676bce0\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"76aed3146be13de2\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"c4396e8247c4a155\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"29a7f8aa0929cacf\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"932c3743ce6069b5\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"8c8c6dbc30157010\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"f28a8216829e364d\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"a4375ca01e3cca05\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"cc827bf42c6ddbc5\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"890a04c98b177b32\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"83a0c6e706ca86fb\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"8886842229f88455\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"129d74e90d1abc1f\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"ef0c36e2e946a8e2\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"7c72ca743824bea7\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"3e2d61e2419627f8\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"66fd138de2ca617c\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"741de6acd7c9c101\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"20bdb8f639947a91\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"4764dea099d3acc4\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"c0478500dad803ab\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"12c0e8344e206d8a\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"9ce34052c77e94ec\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"2cf1c2c68078fb96\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"346286f49e8cc889\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"5dded1f316014aed\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"44908f025fb2c019\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"3468764edfb24f52\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"1f22365c45773e05\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"87036a0cae442cc7\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"3c97234dfe1c3176\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"0c06e473eee34e8f\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"7ffcd9d8cc7c6ed7\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"26dec349b4bed1d2\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"70de11a493c503b5\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"c5aaaa9c020ff6f4\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"63eb2dbbc35bcb7a\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"69e3a28b1bb8af09\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"136a50634b5212d5\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"5c91832c2fb921e8\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"e67be12cce5f39b7\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"0fefafedf11c6dc6\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"b1daa66c1c203957\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"588d1bc86d7b2caa\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"2d8e5050ce64a9f6\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"17887ec2baf6542a\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"c1a2ef456cd262da\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"776b96ed353be2d6\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"edc28e578213967e\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"2802720c68fb85d7\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"d1b008870e25a2f3\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"1ec2a2637d7db4c9\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"d3e7577d4463c175\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"a15fefd6e2df4143\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"1f5ea38a69057404\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"bcc0f4ab70df87d7\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"d0923a7dc11dfd51\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"e62a45da87fa4d0e\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"de4256768ec7bc53\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"8ae2bf820575e170\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"d400954ce79427ed\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"3559095cc70251b1\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"85d3ed37d27fda1f\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"f4dcb742cad0712f\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"a74805dbe40aa60c\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"9d7ce75825a7e71d\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"86965abff41a9fb9\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"9a1dc0a369bcd4a2\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"431b9afb3dc5c89a\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"3471be927723ffa9\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"fbbaa5e1a8e6c1ab\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"a1ebdc6808289753\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"cc7b8100fdec2930\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"e31262ac8475ad41\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"d1d98c4a5de490d7\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"a49f4f767c7c35a7\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"45d8ef214a5c8574\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"2cf6045c5778a328\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"e9696d237a3d5172\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"1c79387472e4016a\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"b6dab500c95e4dce\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"8f55b27bf5317551\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"ba59b63faebb230f\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"48544d08e8eb9342\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"1f1dcfd027fab83a\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"6aa2307305206495\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"f21a5357e060e8d4\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"495d36e66f5f94fd\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"05fc16b4a108fb2e\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"992d60ec5cd63e15\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"9d7b4a312a3fdf03\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"04c6545a9f7a34b9\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"92d2d800032600b6\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"81cdc9b0603e872f\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"6b4bef580147193c\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"6951c202df0f767f\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"51566926c0093e16\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"d37774d03baf46bc\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"7e24f898e6ace73a\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"73b1aa4173d9d32f\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"3ac6d0417bf9a13a\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"840cc713502cbbcf\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"ba1c47dc2d3cbe36\",\"/knowledge-medium/src/plugins/tables/index.js\":\"19931827804dedd7\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"506cc047b403f366\",\"/knowledge-medium/src/plugins/tables/model.js\":\"bf01f20e09cb6faf\",\"/knowledge-medium/src/plugins/tables/query/QueryText.js\":\"f503d73d9c8171c3\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"6753367848450f0e\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"b7e13f0ff99b0856\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"65e41139a84d8c87\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"94c6118bf3ab1932\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"45b49fc7d3212bd0\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"d5d2f87c042e1ed8\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"12cce4d66b0bb055\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"acb721c79e81f3ca\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"8e8a8f77c43dc332\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"cb56469c2ac68aa9\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"597be85805cf354a\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"51d8e108f840b3ae\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"60025ff0f08fad63\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"766db196ba40db85\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"0ca2ecb0ede79f5a\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"b755b9b13be8fec9\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"4cea704a577d8835\",\"/knowledge-medium/src/plugins/todo/index.js\":\"5e223529f6b16c37\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"7f5a0fca8b1371d3\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"36f1b84358391ac7\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"9a39f91911798186\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"494bd90ea5ff6010\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"5ffb0386c536b606\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"b46043be31de9707\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"81a94916daae1d0a\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"48946b3d5ea449e2\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"a2b3d749fb4f1655\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"9000d69f6d3c60d4\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"2bc2203abbc4c861\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"83ff33edebeca85d\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"f52fc27a9e09f0c3\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"a0d16f552d8f6e9b\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"67b2eea26005bdc3\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"accb6510627e4094\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"aa4f7ba61663e6e3\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"1b236ac04965877d\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"7d629c23de44590e\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"134c3497b8d4cd1f\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"66ac44ff703242c0\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"2a27e4feab8685c8\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"f22589848ad02f26\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"394d60a33cac49e4\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"66ce1a0793dcfd70\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"79b0370f23b78b78\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"706db1b3a6eaf384\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"4279bfb94abbb638\",\"/knowledge-medium/src/registerServiceWorker.js\":\"ac032e49faeccbf3\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"26b36607ceb31673\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"f565f4feade7df73\",\"/knowledge-medium/src/services/authStorage.js\":\"c7c4a5184fe0b75e\",\"/knowledge-medium/src/services/powersync.js\":\"0911d8be5c72400a\",\"/knowledge-medium/src/services/supabase.js\":\"c631a6a916fcf598\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"aad8986f92708500\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"200c9e0fd057e9b4\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"4bb736a1a53efcb0\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"2f537db5741b1bf1\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"2c44660a9c64d450\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"e1aeebbba5e03a30\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"ad8f91d9f4c0cf5d\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"2213e3e3c570d3c6\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"3c940911b287f070\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"96e7b20a35f16a84\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"d7fdef20d5853d62\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"a3fd2fb255043f04\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"b6a472acf5af2f11\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"f8c31a86d982322c\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"61356b7534ccb0bb\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"29a0135d29685ebd\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"9a4ce7049dc44358\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"027ec35642285270\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"daee5d1c0a7bb285\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"1aaa5575a3d839fc\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"841419a99433d68d\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"cc0815c7a9301e6b\",\"/knowledge-medium/src/shortcuts/types.js\":\"a114283766788404\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"a64fd5442a710133\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"76526377973c2ec9\",\"/knowledge-medium/src/shortcuts/utils.js\":\"5a213454da4b197d\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"ac4da55456bf5e27\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"0686ae9b3597089b\",\"/knowledge-medium/src/sync/byteTransform.js\":\"77d97793c7377ac1\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"25fa2ae2032b62ca\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"eaef329427d7c686\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"e0d6404693a83f22\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"52edba5a375f8ea7\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"b9f51a94a486f376\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"f3191a0269771dba\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"6a8840b9fe517120\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"47e9113febdc3791\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"39a5120de7a2c111\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"ea973b38c28094f8\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"bf7be87b66ad6a37\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"2c4688fd9785d150\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"c6335e8c2a22da95\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"5b8ee76e059fce87\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"b1bb8826fb782d1b\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"6cc62b5f30969482\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"d938c6c09117bc5e\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"175d74a250fd103e\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"7623471ca873e83d\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"7f7f1666e75a9828\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"78c8691122fcb7c2\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"34c16cfa5de1d837\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"216068ee6f03ecd2\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"ab569c9b23ec4c3f\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"d9768da934e5f0a1\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"3ce8eda6fd795dfa\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"a05002fd4d4cc954\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"87efb61b091aecd9\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"cbdcc5c27bd9d743\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"1579aea12f1bb406\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"4fa84e6050675bde\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"d5e896426633fb16\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"a86c220847ae5b49\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"7f4a5a58520198c1\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"ba1e889d45048368\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"e5c353c435ba3ce1\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"05998667886fc0d2\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"8d06eef81c13605e\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"3fed857dab307012\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"e7470a8727cdd025\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"6e1fc8c989cf1f6f\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"5225f149148cf565\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"bf88a82703609c8f\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"59397c2197d1882e\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"e2daeb77a36db099\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"276854fdd8932418\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"246c47e42b8b8aa1\",\"/knowledge-medium/src/sync/transform.js\":\"46781fa04c6f343f\",\"/knowledge-medium/src/themeBootDefaults.js\":\"8de97555b09f1e6f\",\"/knowledge-medium/src/types.js\":\"ac57b5f80813f174\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"44292cd0ac24ac3b\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"c54ffef6bfaa502c\",\"/knowledge-medium/src/utils/array.js\":\"54c51446aa7cc3d3\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"8abf8755b085ce6a\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"805e7c76789a1550\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"223e1b9f1e9a57cd\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"a559e27e3c31144d\",\"/knowledge-medium/src/utils/callbackSet.js\":\"b57f285c1d99a809\",\"/knowledge-medium/src/utils/clientId.js\":\"46acdfffa3feaebf\",\"/knowledge-medium/src/utils/codemirror.js\":\"da9319873a547e4b\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"90e36460cc2b518a\",\"/knowledge-medium/src/utils/copy.js\":\"4ae0f91b0681737f\",\"/knowledge-medium/src/utils/dailyPage.js\":\"1e029ea103dbee04\",\"/knowledge-medium/src/utils/dbForensics.js\":\"9f26f03c03765fb1\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"6416013124d3c6ea\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"efeb07e1ea3e7b12\",\"/knowledge-medium/src/utils/dialogs.js\":\"358d25604dcaa6fb\",\"/knowledge-medium/src/utils/dom.js\":\"dd1d17022f504f5a\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"00bf385e37a70258\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"036c5f346844984e\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"9380756a6b7c53ae\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"a72e5621ce0debf4\",\"/knowledge-medium/src/utils/flipSlide.js\":\"aba71a787520b44d\",\"/knowledge-medium/src/utils/fnv1a.js\":\"8714760d03a58627\",\"/knowledge-medium/src/utils/formatBytes.js\":\"51dda673341cd509\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"65b386e3066210a6\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"b0a51890d743f05d\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"f2ab756c9c02d93b\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"c83eafae28c9003a\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"2cd464870e5b3355\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"fbe158ca77c32e3e\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"0d14c8800ffc7b52\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"49181c753c8f9174\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"5140e23d1da1ac37\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"4e23b7ffdda2c1a3\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"d1ab6cf90bf6edc3\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"a15ad6b945409870\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"e18dabeb77692bbe\",\"/knowledge-medium/src/utils/markdownParser.js\":\"4921ed43197fcef3\",\"/knowledge-medium/src/utils/memoize.js\":\"08367f1795fc3ec5\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"51824939ae32a5c2\",\"/knowledge-medium/src/utils/nameList.js\":\"73b35faf9c24563c\",\"/knowledge-medium/src/utils/navigation.js\":\"b9049090a759cce0\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"397604eb85db406d\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"e5309d3438e8c85f\",\"/knowledge-medium/src/utils/panelClearance.js\":\"64e35714685e9f85\",\"/knowledge-medium/src/utils/panelHistory.js\":\"2fccc0ae6bf92fa7\",\"/knowledge-medium/src/utils/panelLanes.js\":\"dc1118a2cac9641d\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"d2898ed944ddccfb\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"f71bcd7079f99bc5\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"cd56c50e691c2ad9\",\"/knowledge-medium/src/utils/platform.js\":\"25c8dc0fb9533abc\",\"/knowledge-medium/src/utils/pluralize.js\":\"f3ce0f2c1401423b\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"4a6e73bb61d28261\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"7087757c78a3d890\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"057b50f21d4fedcd\",\"/knowledge-medium/src/utils/react.js\":\"f8d4d15bf5821dbd\",\"/knowledge-medium/src/utils/relativeDate.js\":\"42002fe98c117d57\",\"/knowledge-medium/src/utils/relativeTime.js\":\"f31cc2fdbca21d3d\",\"/knowledge-medium/src/utils/renderScope.js\":\"ba990ff527763eee\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"0f6de9d080b2d883\",\"/knowledge-medium/src/utils/routing.js\":\"78ce08d3a4386a35\",\"/knowledge-medium/src/utils/safeMode.js\":\"373945d60d9efbba\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"bfc79fead49d5377\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"e0ba386952e99a84\",\"/knowledge-medium/src/utils/selection.js\":\"97a2fdc84da4910a\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"26552a17bffc6168\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"d27d19c182848b27\",\"/knowledge-medium/src/utils/state.js\":\"f6ef6cb3dc309a63\",\"/knowledge-medium/src/utils/string.js\":\"1ab51cad1293e9f1\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"2cb4ca149be7d5fa\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"8e8e6b36165560fa\",\"/knowledge-medium/src/utils/toast.js\":\"fc81097a17af87f3\",\"/knowledge-medium/src/utils/toggleStore.js\":\"bc6c39abdac7d7fe\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"2510c6a3a66251fd\",\"/knowledge-medium/src/utils/userActivity.js\":\"20abd458f3c7a7f8\",\"/knowledge-medium/src/utils/viewTransition.js\":\"ffdb8d662bed774f\",\"/knowledge-medium/src/utils/viewport.js\":\"687d77e5e7667452\",\"/knowledge-medium/src/utils/webLock.js\":\"a4556d227fb1f617\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"c764546f958d10d3\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"74c50df4f2f61be6\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"9d5a0553ba0cdbfb\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"2291c6af3f6cf061\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"56ec0a2114582539\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"e9d22f7982d37b34\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"9bf4ca46082c53b5\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"c6396fb9b12a0038\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"92f2158fda0929d1\",\"/knowledge-medium/src/vendor/react-dom.js\":\"59dc39449287670e\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"562afc89a45f14c3\",\"/knowledge-medium/src/vendor/react.js\":\"fe3bade01632b494\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
