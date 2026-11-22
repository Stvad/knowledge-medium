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
		buildId: "08759a45a674-c163c6c9",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"d5c8c87547734ea5\",\"/knowledge-medium/index.html\":\"d5c8c87547734ea5\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-Bfy_C_ZT.js\":\"e645d9f766bbab93\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"a1ec3b8c184e4430\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-CYsVwXrN.js\":\"f133e3d1094a3031\",\"/knowledge-medium/chunks/FacadeVFS-BRPKPeEy.js\":\"837f5ac06746a73c\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-Bgnb2ZnB.js\":\"3e2f0e310cdd44e3\",\"/knowledge-medium/chunks/MemoryVFS-C1EtiTA1.js\":\"2b4d48f7d7a8da93\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-CjPMFiYP.js\":\"acb64943cb255c23\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-CG5gVmSh.js\":\"2378aa1c4268b0ab\",\"/knowledge-medium/chunks/Preview-B1ZIuud0.js\":\"f6262ca0cb6e0899\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-BlmIbfou.js\":\"f18a82a588b1fedb\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BqIbocKu.js\":\"e5b5fdf8d7946dd8\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-5aCXocRi.js\":\"53d2656a8f1676af\",\"/knowledge-medium/chunks/react-BdPFRr-b.js\":\"de97a287a9c1834f\",\"/knowledge-medium/chunks/react-DFce4phv.js\":\"07dead0e8077a8d1\",\"/knowledge-medium/chunks/react-DHtv5V1M.js\":\"cd54cc461293e2cf\",\"/knowledge-medium/chunks/react-DtqUOxle.js\":\"b507abd5bba1e921\",\"/knowledge-medium/chunks/react-_DSfqNWm.js\":\"7b142d8964b1a3ae\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-B4k2EEUp.js\":\"3c69ef50fb06e314\",\"/knowledge-medium/chunks/react-dom-server.browser.production-DrDAd-M6.js\":\"55645e54bf2c1a56\",\"/knowledge-medium/chunks/react-dom-server.edge.production-DByU-hEe.js\":\"4530ab14ba451246\",\"/knowledge-medium/chunks/react-nwlXlJgS.js\":\"022c0e7b2104ec6d\",\"/knowledge-medium/chunks/react-x3UFlxOd.js\":\"30a95b7607277a84\",\"/knowledge-medium/chunks/server.browser-Cd929nAP.js\":\"345f660bc35db47f\",\"/knowledge-medium/chunks/textarea-CiiLtUfN.js\":\"79e43e5719879832\",\"/knowledge-medium/chunks/ui-hEkzTDGn.js\":\"062665c3e13f99c3\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"9ff0a640f4c8e7f5\",\"/knowledge-medium/src/appUpdate.js\":\"4f5d80119000cf75\",\"/knowledge-medium/src/appVersion.js\":\"ef447787bb46e921\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"d2eb3f3cd5a25c8d\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"ac8ef590be503dc4\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"6a23601b396c2ffc\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"14f97ae67c3998a3\",\"/knowledge-medium/src/components/BlockComponent.js\":\"bc25e28798dd797a\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"02da8fb49326f21a\",\"/knowledge-medium/src/components/BlockEditor.js\":\"7a18c40dca40ae7f\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"0b5ca46cc404cd36\",\"/knowledge-medium/src/components/BlockProperties.js\":\"7f1cd77c00744e05\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"cfe6834b8a6ba0c9\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"6e986c095554a951\",\"/knowledge-medium/src/components/DividerHandle.js\":\"eee2fafd45548a39\",\"/knowledge-medium/src/components/DraftEditor.js\":\"e5b737c99038a767\",\"/knowledge-medium/src/components/GutterPill.js\":\"31db472267b62532\",\"/knowledge-medium/src/components/Header.js\":\"416fb4f036c99a4d\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"57b2cbc4ffa6e1b8\",\"/knowledge-medium/src/components/Login.js\":\"7435790913cf587d\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"da4de0954b42ac15\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"5651bb78daff198c\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"c3638a1cd082340e\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"098c222f7b0f4b49\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"9e294a9ef3c80c18\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"d93b63236416f4c7\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"cc4896a70851c237\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"cdb26c57beab3c2c\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"92de5d18dbc444b5\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"a8db61b1745f3c2b\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"e424852adcb03605\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"3f05f94ab48b175d\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"f3f700925f82421d\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"566041c123bb1b18\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"e614a01919c12ff6\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"6d350dcbe3fb89ac\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"771986e623d8a736\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"5b737b04e481c8ec\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"2fdf3bdb939a21f3\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"f90c90cd190a9b9c\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"bf89f590c368ee35\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"ecfc8de1e21c75f8\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"892357c8829ec294\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"a995dc8788501c89\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"bb1b776fcdf3b4b9\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"ed2f30d8469f26ac\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"746601fab7620499\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"adf744a0b973381d\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"549c797c51901889\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"30b0beed06329339\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"9a79e2acf27808e3\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"e40d7a58d7b82930\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"e596a2e650adb784\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"b828e93c7add4164\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"002493f36540ec7c\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"dcdd1e29e0949ee1\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"ffb19f4a1c676b20\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"6ba9f6b834b357eb\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"86c8412f1e628b67\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"1d280c2737c72516\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"5112eeb277948a7a\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"d01cc2ce4d1e9961\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"c253a7aa0df2a103\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"bc613622f6877acb\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"4e999228e8f3af08\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"4dd493620aeec224\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"34a8ebeed7f8de32\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"775da0a29a49fb86\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"520d2f369acd5858\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"013de199bd3cf07b\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"3961007720d2533e\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"5eaf371f7cad40a4\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"b65ed783dc46e9e8\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"d6aabaad2c78e85d\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"1f87e4704d070e01\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"d7ff0153b85474cb\",\"/knowledge-medium/src/components/ui/button.js\":\"f23b952f3b57bad5\",\"/knowledge-medium/src/components/ui/card.js\":\"c299aff0eb091c58\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"7c02d9a120514c46\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"d626e701e9563ebd\",\"/knowledge-medium/src/components/ui/command.js\":\"83072b27b813293c\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"7af9716fb22f165f\",\"/knowledge-medium/src/components/ui/dialog.js\":\"0e992eb37e648fd5\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"b2cc8da2454489eb\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"d9812cb46f346b7e\",\"/knowledge-medium/src/components/ui/index.js\":\"30a1d79d1cdd36da\",\"/knowledge-medium/src/components/ui/input.js\":\"cd8e15697def1d79\",\"/knowledge-medium/src/components/ui/kbd.js\":\"df7b1c209597b09e\",\"/knowledge-medium/src/components/ui/label.js\":\"dbc51ea6dc17923f\",\"/knowledge-medium/src/components/ui/textarea.js\":\"952164ac76fee0eb\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"bf950b6c5961aa1a\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"012652e8ef2e7939\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"8969b30c23776869\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"8ba5da00b4a0e6c6\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"8819c7cfe290513a\",\"/knowledge-medium/src/components/util/error.js\":\"0eed43888717c7e8\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"e94d501417c6e767\",\"/knowledge-medium/src/components/util/suspense.js\":\"c7931a41b9f8fef6\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"0b1b09138f88b2c4\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"f8c3601059cd8e22\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"56d02c033b24ac13\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"d859e95e9fc0a1e9\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"6bfc506033a5d539\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"cdb4944de9e16276\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"70d525afd7a6b8b2\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"52be8095ffe68215\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"58bdf730ac7a0e84\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"bfa6a1aa1cc65723\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"b36790542f1fe5e9\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"edbfddbb85d027cd\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"145db30524c3eed2\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"4dc0cb3c5ed9311c\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"d46577fb22fd8c56\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"711f424ce80b748a\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"78f5c7af27894a8a\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"f6c1016859a293b5\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"3f7bdb307812137a\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"34d4bd4494563788\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"437b8398517287f9\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"4c4766010dabfe71\",\"/knowledge-medium/src/context/block.js\":\"690d9a7db1ceaed5\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"c5277f32a3d2cc9b\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"511c07c889918987\",\"/knowledge-medium/src/context/repo.js\":\"2c0295ee6d778864\",\"/knowledge-medium/src/data/aliasClaim.js\":\"5664e9bbf1d4dcf7\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"069a143c2f07095c\",\"/knowledge-medium/src/data/api/blockData.js\":\"9e7e0619ee6d773b\",\"/knowledge-medium/src/data/api/blockType.js\":\"28322953d6221a57\",\"/knowledge-medium/src/data/api/changeScope.js\":\"530bf884c993e76b\",\"/knowledge-medium/src/data/api/codecs.js\":\"4fa0e6c2a9101390\",\"/knowledge-medium/src/data/api/derivedData.js\":\"b21a7ce8c1d9cc7e\",\"/knowledge-medium/src/data/api/errors.js\":\"d819e3539344398d\",\"/knowledge-medium/src/data/api/events.js\":\"e6b28d2857d51c5a\",\"/knowledge-medium/src/data/api/handle.js\":\"a2bc0f0f47fd1908\",\"/knowledge-medium/src/data/api/index.js\":\"ad929df201062989\",\"/knowledge-medium/src/data/api/mutator.js\":\"f96f018a3e4cbf17\",\"/knowledge-medium/src/data/api/processor.js\":\"351909970de11844\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"23b36bcf9ac659aa\",\"/knowledge-medium/src/data/api/query.js\":\"419a972676414228\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"d91ef6e7a0732098\",\"/knowledge-medium/src/data/api/schema.js\":\"a2bc0f0f47fd1908\",\"/knowledge-medium/src/data/api/tx.js\":\"a2bc0f0f47fd1908\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"e41b6328d3591170\",\"/knowledge-medium/src/data/api/user.js\":\"3b2fd834f9c34d60\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"977e79da86898127\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"a86cafafd60a66bf\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"992d546a177c3fd3\",\"/knowledge-medium/src/data/block.js\":\"f94efbbe4612192c\",\"/knowledge-medium/src/data/blockCache.js\":\"e4fafd27b4b13d40\",\"/knowledge-medium/src/data/blockId.js\":\"de2bafcd83c75998\",\"/knowledge-medium/src/data/blockLiveness.js\":\"ba46b2cb016b8958\",\"/knowledge-medium/src/data/blockMerge.js\":\"63d3f222d6118768\",\"/knowledge-medium/src/data/blockSchema.js\":\"9766cefa6a415e42\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"d011d4e41faaa3c9\",\"/knowledge-medium/src/data/blockTypes.js\":\"ff4597065e807b7a\",\"/knowledge-medium/src/data/clientContext.js\":\"e2123fa06d5cc27a\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"0331e3bb3f94c8ad\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"bfeeeec3935b9db0\",\"/knowledge-medium/src/data/derivedIds.js\":\"674393c58342376f\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"fd0a1bfe3dcde579\",\"/knowledge-medium/src/data/facetBridge.js\":\"2c06b78de00ccc07\",\"/knowledge-medium/src/data/facets.js\":\"db26daa992b5ae1e\",\"/knowledge-medium/src/data/globalState.js\":\"1610530d7cf8b85d\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"44c83fef8b8ee635\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"e1b53b8afadd711d\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"a6b211c96847ab9f\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"8f65ce40833d082a\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"15f265fc2c180579\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"b4764a21cab88bb6\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"482b58c46063c650\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"4b98c4a06536edca\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"1cab979e461b87c1\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"4f1f49782b70dc32\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"1ae03c100cd0653f\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"8717f8377c1fc3f9\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"cd5af989b75040b2\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"4b6e7791f4da1b37\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"2eae66cb714ef48f\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"7d5e983ab74be481\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"8c74673f8fe7959a\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"e411b78f7cbf4198\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"35e76ce637e4aca0\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"ff7e2ada5624eca8\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"71b469d705da60af\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"de7d21bb31952248\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"8713882167296bed\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"b46e3c8704a82702\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"6c5cc3315155f37b\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"f1f913cda486b3fd\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"087c4de99e300f34\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"71ba142f0aaaf0a2\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"e6fb4f84bfad49f2\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"239964fefc378283\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"954978c9786a62ba\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"542ae739b503b372\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"354aaacea0c18d34\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"4884057f0ce76f17\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"b42d4e3fb180707b\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"baad4ed7a9ff93d0\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"f0427e885d9223e3\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"6c59ede104f4a486\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"3ed1d06e993a0c8b\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"d6a8875d6506ee89\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"fa308827767f0379\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"530ed29c98a4b635\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"5b13894842615b19\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"e25126e2ff40ef04\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"22b24a714032965b\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"fcdad0cdd35b9483\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"a25a368a76e7d6ba\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"81c28d8ef306311c\",\"/knowledge-medium/src/data/invalidation.js\":\"cb5d136f3ea0351e\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"88d27f4843be6941\",\"/knowledge-medium/src/data/kernelPage.js\":\"f46294d38f8ea277\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"7b138eb5f16e995b\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"dd888a7309264ef4\",\"/knowledge-medium/src/data/localDbStorage.js\":\"cb372c42a31844e8\",\"/knowledge-medium/src/data/localDbVfs.js\":\"29bd422e31eb1abb\",\"/knowledge-medium/src/data/localSchema.js\":\"784e5fd46144cc65\",\"/knowledge-medium/src/data/maintenance.js\":\"ff1ca32e6b7085bb\",\"/knowledge-medium/src/data/mergeProperties.js\":\"6af9e2bbe64a3ab3\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"4fe94a7afae9aa2d\",\"/knowledge-medium/src/data/migrationsPage.js\":\"f08f2380ae39a38d\",\"/knowledge-medium/src/data/mutators.js\":\"ac9813f0727f3cad\",\"/knowledge-medium/src/data/orderKey.js\":\"2253a76e24b9b259\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"b1baa44c7d2a25e4\",\"/knowledge-medium/src/data/outlineSurface.js\":\"079cc511df5380b5\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"34bc444fb24317d7\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"42b50f25b4a7d926\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"70740708975c4494\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"1302b41e0541223b\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"00044d2f68faf92c\",\"/knowledge-medium/src/data/properties.js\":\"880687fce606b67c\",\"/knowledge-medium/src/data/propertiesPage.js\":\"fdf8bdfe6ee6b197\",\"/knowledge-medium/src/data/propertyChildren.js\":\"2c188b8576e42628\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"c5a6530bbbf4c5d0\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"3e71818420c57dbb\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"acaf64944bd98fc9\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"53445fde6a249b75\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"75d12ea71af928fc\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"933895efdfe57b61\",\"/knowledge-medium/src/data/propertySeeds.js\":\"bd8d5d99fae94776\",\"/knowledge-medium/src/data/recentsPage.js\":\"04c8dd424152c1e8\",\"/knowledge-medium/src/data/referenceBlock.js\":\"695a52b7f25c9605\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"cffc90b248ab32d7\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"2c08dcfc08477373\",\"/knowledge-medium/src/data/repo.js\":\"74e8aae14e782f12\",\"/knowledge-medium/src/data/repoProvider.js\":\"4d71c767bf510e9e\",\"/knowledge-medium/src/data/rowProperty.js\":\"03abc6783a2e79c5\",\"/knowledge-medium/src/data/searchFilter.js\":\"7db1d8e1c8f1768e\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"7bf15aee27620387\",\"/knowledge-medium/src/data/stateBlocks.js\":\"9118bb70702a3c3a\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"6dde14c9310f642e\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"523a99956ab0cc44\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"2a639230a4b0c43a\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"3dd2db2aee94f08c\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"82ed7c9e616caff5\",\"/knowledge-medium/src/data/targets.js\":\"b53d62429da90a7e\",\"/knowledge-medium/src/data/typeColors.js\":\"33f1ef9f88ef1148\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"a55164342421bcf5\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"45003ec36702f0eb\",\"/knowledge-medium/src/data/typeExtraction.js\":\"1ef6f613ccbb901b\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"6af5494d48534df5\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"7ce877bbf46fef3f\",\"/knowledge-medium/src/data/typeSeeds.js\":\"b4253e2dff16ed95\",\"/knowledge-medium/src/data/typeTagger.js\":\"4976152a74ee2831\",\"/knowledge-medium/src/data/typedRecords.js\":\"72714e4cf6956ba7\",\"/knowledge-medium/src/data/typesPage.js\":\"6bbd3e782d8c5479\",\"/knowledge-medium/src/data/userPrefs.js\":\"d04d6814b1575f64\",\"/knowledge-medium/src/data/userSchemasService.js\":\"8376403c7b2a89f4\",\"/knowledge-medium/src/data/userTypesService.js\":\"978a567457e569e8\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"c871f7182aa7a7d7\",\"/knowledge-medium/src/data/visibleChildren.js\":\"b5a7059d8fc3b2a2\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"0517cc329c74b3dd\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"8f746f28c83d2748\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"ea564277c9e8bcfb\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"b14058ad16beb2e1\",\"/knowledge-medium/src/data/workspaces.js\":\"ee1620b53d7254ca\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"7eedf0fabbd8ad9c\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"8f539d92991101b8\",\"/knowledge-medium/src/editor/atTrigger.js\":\"f34d4bb03ecfa33e\",\"/knowledge-medium/src/editor/autocomplete.js\":\"ecd7bb65527d0645\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"d673314a49d44a55\",\"/knowledge-medium/src/editor/contentFlush.js\":\"a03f32ba2e30a2db\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"6b1a72b8734cab59\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"36491de71db8ada8\",\"/knowledge-medium/src/editor/insertImage.js\":\"5376f6b47f61fa9c\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"21d73a6f461ce53e\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"452d0d2cb65d8852\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"e677b2ad079d7b71\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"4cc8fe3ce080c7f2\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"1adbc9b79d15ade7\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"1ae02425ea3581a4\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"9870aa3c5a0357ca\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"b057e908da8159a6\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"6e58b021e46eeabc\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"4a41fa1c2c7b9cb8\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"bdaf7e2876786707\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"3a8d6fa0fe119a6f\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"282425887444e0ba\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"663cfd2a767e905a\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"6182b1a7af57def2\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"e243ec14d79e3d48\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"31a8e01fb6141446\",\"/knowledge-medium/src/extensions/core.js\":\"8873149af3a79910\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"38e8fcd70cf2884c\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"1b57417ea19eb38d\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"1010c08a4e04ed4b\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"e77d7ac93b085ea5\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"192e1a027cd817f3\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"207bc12fc864c464\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"76b6ffb9674fda9b\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"6cab0cc8cf2270e3\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"450c192c9b9b52d4\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"d0425c6c802ca21d\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"9ee124bde6f1288c\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"a727d7d2939adfdb\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"ce53e40f855bf374\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"d0b749cc040b67ac\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"dd42aae2dd8e403a\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"8c375b3eb723741d\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"d670353cf7195771\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"4ac3cefa3ae55f04\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"4ac7b3d2c68d49d5\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"9211d5094813c789\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"d8c3d9a7ac69053b\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"d9a69fee83e64da5\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"81d88fa14da0f3d8\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"51919190d307a614\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"9122bc5882ba8735\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"f5635f33e189f347\",\"/knowledge-medium/src/facets/facet.js\":\"e73dc8e737f559ac\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"95343a1b13f5ed4c\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"576c47c7f91887ee\",\"/knowledge-medium/src/facets/togglable.js\":\"4bef8d23e812107c\",\"/knowledge-medium/src/facets/variantFacet.js\":\"8615e063158835ce\",\"/knowledge-medium/src/facets/verbFacet.js\":\"3e3e29a61aa57c28\",\"/knowledge-medium/src/hooks/block.js\":\"2daeadafaffab811\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"1cfce6b89a2c702c\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"6be6a80ca6bfa738\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"4ac9c7e794ac1330\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"d59b47a7a8a70d2b\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"4bbfe667fd1e3616\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"86407c4835947c89\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"561b7e8658d7a6cc\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"c3e1c9d9fada5abc\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"84e652eb89f86aa1\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"dd440b6e8cda2d27\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"557416642344d2b5\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"dcd018a3f8f9ea85\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"dc8a7184e75b8309\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"5f40fa19f53157f2\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"4135f4f76b0612b2\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"cecf6dfe50eea4e7\",\"/knowledge-medium/src/lib/utils.js\":\"6098aa758dcebc80\",\"/knowledge-medium/src/main.js\":\"095101785e10d10a\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"54300f94ffacdb8e\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"14b84cfd169ac9b2\",\"/knowledge-medium/src/markdown/context.js\":\"f08f04a36d39816e\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"1c8652bff097919e\",\"/knowledge-medium/src/markdown/extensions.js\":\"c05c208b61ba72ac\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"b2e1eddc1f5e1673\",\"/knowledge-medium/src/minimal-editor.js\":\"b961e5ba83df5222\",\"/knowledge-medium/src/paste/armedCut.js\":\"4f489909a1f34c01\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"5575aa81b1c052b6\",\"/knowledge-medium/src/paste/clipboard.js\":\"1bc0328d08583441\",\"/knowledge-medium/src/paste/decision.js\":\"d47d2aa9fa3fd823\",\"/knowledge-medium/src/paste/operations.js\":\"a192cb402f08c6c5\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"34dcefb423dd3cbb\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"36819c8e492e1ab0\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"1078cfa6679ffe40\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"01a8e1be652eac96\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"3ac19d90b16411e8\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"420455eb59b008ff\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"0c6dc13e2888d745\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"cc685e6071ba3e41\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"a9bb33209a898cd2\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"21318882de8dbe46\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"54f366f4f7936192\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"0b46749e46b090c8\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"95c0c65fd045e432\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"2d8e0c0f7e5b3783\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"929b32744a9479ef\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"b9803f0d951d4dfc\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"e809a91c5f4ded5a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"9c9e2e9ba5bcd17e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"f3f33272342aa9be\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"0fe61b2fc896a609\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"0e7575ab14360aa6\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"d279a57c96b71704\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"cb2d42644159b775\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"2ac8af23bb9a4284\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"0f7bae8756f3cd77\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"1d6375398b6f015e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"bfa9c9f682348728\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"7947549ca0462ad7\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"d8f13169a355da73\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"0b8af335c26c6764\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"98fce0ce91ec5279\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"69aa3545a12d0ba1\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"9f1c10f9d1e29f18\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"a74fc3337994d3ed\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"03f3a7cb5d45ffac\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"295e5624588ab649\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"49f33192bf9685c4\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"0bf14500c7c67a85\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"1ed6fbaf8f3b9e67\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"0b6d5afcc5288d0c\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"e0e90efe8aab6bd3\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"d76125553ffdcc52\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"f2a272702f85b523\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"4efb1fcd09e332ec\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"2271e7b20f0feb18\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"7522e658fd53cbda\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"216c01d06d022ef3\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"c22da112b0b861bb\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"9b68f71bcc2c47d3\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"0ae0b8494a1d30bd\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"df95565305d32c37\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"5a8966785615f05d\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"77c742ce134a000a\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"30117d4325f53c8c\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"5320dc1bb7075c17\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"650f1944d9833462\",\"/knowledge-medium/src/plugins/alias/index.js\":\"1117d528a262698b\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"3c4d69607004b950\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"73e0e50701e15c5e\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"4b3f6fea6ecfee25\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"243b54804d9ee721\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"53cbceef4d63bbfc\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"fe0c3d478d13e050\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"5097b56ed020956b\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"7646ed4ed14953fe\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"674aaa97b9c1ae05\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"c80b13c5b29fc36b\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"e598cc33f0b646c1\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"8fc84f230518c6cc\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"b6d1f0c156257811\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"fff5262e4cd75b0a\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"a3c015acec850fb2\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"930044c5497ff7fc\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"3452b796b9a57692\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"67d3d09d2dfd91b7\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"a9b89cfb0dc0e260\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"9e631ba5e4edbc5f\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"240947087bdc787e\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"615c18fcccbf7cb5\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"f0407099b5700c0e\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"789005c92e57bb6c\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"afb6777f9ffdc331\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"84a31c2a581fa7d0\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"f3693b37f3f1958a\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"e2af9965f5df495d\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"6b24da09e0f8eaa9\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"09ae5177718890e8\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"a2fa2ca9f561221e\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"9395fe67a162e219\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"6b9aac62809c2bba\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"5be0d9257809d840\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"6362db284a1943f0\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"9d0aebf5b1eeca65\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"cc1f033cb0b8ea95\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"7887ff28a40ae59b\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"5b371ad6977f51f6\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"f7b1c63629e4ad46\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"9cdcbe0f3e9ef7a7\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"20b3c1e89c751117\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"a031339a1623452c\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"4bbcde1a449ccf77\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"c84a7379228af7cc\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"c72955ef2ce77d60\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"f322f2f09e21cd3d\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"47b072c3995b3c1d\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"9ce9f6db36519f00\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"e6c6e71352004d62\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"923337f9d76a5198\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"bf4a241ad5642c6d\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"d24000ab3fc2a0cf\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"7e21f94a7600ffd3\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"aafbc71e5c41d4f5\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"b5a533c12cfcc9b1\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"f75f0ff94c22aec9\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"239df34890745edf\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"90478d01ea2b9707\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"671999a4a2dc09b0\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"1c1ac32677a88687\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"c2c3f49206b6701c\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"c2aae1a1dcee3377\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"ac6da1fc3d138f4e\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"9cfd26ec4f36f0c6\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"eff39cc900ff359c\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"8c4815df763f36a2\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"2074cbf68379ffaa\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"dfe310c44bb2fc98\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"94bba462bde13caf\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"1ef60507d4e74159\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"f15f7bcc884a26ca\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"8ebe1ca98ecef10b\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"8cb2049596975154\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"85225d57e155ffa3\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"73502ed74c99b150\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"c15761bbe7f979d7\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"cbf7bcef07526e76\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"455ab5f7ad8d13d8\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"e20dd62e25cf1dd4\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"173f29c7d71a43e9\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"f6d2cf3d33699546\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"b324673f6f1982f4\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"4492eaee3b4debb8\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"f6a6d97881631d1f\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"2b70135212260b92\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"4bf3f75efd15c4cd\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"2472bfb052023837\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"41cd73a54db4ebdb\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"15a3cc7b3b28a4e8\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"3046cf8fe4eb513b\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"9e41b8073ac7dcf2\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"daf08e71ca32d841\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"2a52a52748931963\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"785ebf9aa16a67e1\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"09fba8564c5524fe\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"d3da63d277b12ed1\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"b90321a79d6ed05c\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"cff0e403cab2aa9a\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"f029408769c95137\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"a38a03dbf20d97f4\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"8fe6bd51f6de3467\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"0a1ab104d37f63fb\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"fe5e99ff435f359c\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"c3aaf6253e32db27\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"f9f6f1524f036c1b\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"49504f89233786c4\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"9db52f509bf7d902\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"41f8eb3f905b723e\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"eb9bcc9df3a9f28a\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"2e6b62bca480b199\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"98af58f0104240b5\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"ffd993850df12c89\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"8fb5e03435578a60\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"1061d4a186ac4cc5\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"62133fbec4e6dab3\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"ab6b4c79e38522ae\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"df35f4b19ac564e2\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"499073f69cbfe0ee\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"1d30c5a5ed6344a8\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"b0a5cbe643b7e0ec\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"f67c14952b718e4d\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"d10eb2d70766c613\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"6b367010798b352d\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"5da558fbd5765851\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"85416fff9676ae4c\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"7c30334f50f9e377\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"7dd5992902fbd9d0\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"616de182d287c433\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"74f22bbe6a6ff74e\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"3ec052cd701faea2\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"29537e8c80b454ab\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"7cf4b20140187b53\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"f80fe8191ea42724\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"2408c563cb402213\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"f7b714524c0a1715\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"a2606c793fb082c2\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"81c0d8f76e20e89b\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"e59af444ba8adf28\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"88ac7ea0894e4b73\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"f035c75868bf6323\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"66dc5cdb8a26a328\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"e65799e2d4818b06\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"72736a575f14f2a9\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"db037b4d55536829\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"0282710b11ed026a\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"312bedefa662185c\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"80589ecde1a96d3c\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"84235f775b976ff9\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"af1f5720af5f099a\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"d3400f7ef01e59b9\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"e3c9b44b38be69df\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"f56290fa406423d7\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"868195bf1bcfbebf\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"0f027f445936d98d\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"c05489b9080df31a\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"0c5db6c383e748cc\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"481dfc7447658a9d\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"c55e2fd2b9a1f209\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"ccedc7b34b99d0b2\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"a053d31b7bef66ee\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"08a82fcf2c5258e1\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"7a5a4f3e4d2fe8af\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"1f834d9330544d71\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"2c50290ccd660427\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"2af5ff926874af36\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"8bfe921e2bcf7351\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"e3429cdbeb31a0a0\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"e67fb4fc98f23fb3\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"6c2b8833660f1a8d\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"c5f5c762f68a8d06\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"8cdf0638ec5773eb\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"33f3cc9c8a906dee\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"00822a7c6d3a4a92\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"bc7e4c59f8257a6a\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"c7ddffa1795e8fc2\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"a4984ffacc6d092f\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"06bf2a1dd64d7dbb\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"40e789c6d519b1c3\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"da8c5311141c839d\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"3778a778902cb9fd\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"42b3b32b00f86093\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"996b37915ec9270b\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"5db50874017e2ae9\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"d04b50da8908a583\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"6f0b83146a44df4d\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"c4584ee4c5342889\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"3645fd1c0bda1401\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"73eef024df888415\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"56cbe4bb2598e76c\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"d423162a73b7e834\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"9ab9dee1616995ba\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"6c788b34937f6b78\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"b7c3a9171820fb67\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"0a5514380ac510d1\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"ff30b6863eb0bd43\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"9c9313123d5219cc\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"4d4f5c8d89cf6217\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"fa022641448ac8b8\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"98296da074697bd2\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"c25209a3e07b6808\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"289ece8eb4bc5c18\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"e0ed49f02ffc6cb3\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"1e3913628c15b311\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"543981f296471226\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"09f5e47361bc4377\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"922910c1571425a9\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"ade98ab2744d93bc\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"938a3ff7522dad5d\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"23fa834084262066\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"75e8368fbf74849d\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"b3122d24f094b288\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"03e99edd899eca02\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"86b1cbf0639b15e8\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"0f42795928ea857e\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"4297c646cd5f61a3\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"dc4bc6e2bce125b6\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"1f29dd5c79513ff9\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"84745b2b7cd2e1a3\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"d584de40ad854aaf\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"89f26d9de8cf5156\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"6832824ae55adb30\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"458395d5cbc94894\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"0b1c38c5816fb034\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"95ace6aaba6b53f5\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"9416b4327fe83edf\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"57fd06af316926a1\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"87e43112503f59f1\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"e090ce3d8e410f7f\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"932c50544cecc64e\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"0ece9ce99dbcbd50\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"fc5e625e082077ff\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"0a77f7ec9c200576\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"a58b2c1770fa8230\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"fb5dcfcc689b9640\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"b3c6152d0172cac2\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"62bfc65cb4ddd9b0\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"b53aeaeef946cc9b\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"f48811f37cb2c7b6\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"fd4ca012b73a2f04\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"c2fb66a3bd6c521d\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"e25c937a05da9305\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"932dfcfdda8a8f84\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"5f808e2204922e64\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"1dd54e19754ddcc4\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"f29238da4bbb714d\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"c0fb8a7a0a7a3d18\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"b254864023b47ff0\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"9271561b24f7bc40\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"558aab9fb2bb28af\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"3c5332387dc90b12\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"5c55b3e992946ad7\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"cb2c7dca8ef3b6c1\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"d8c17369a85e5995\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"e5b723611ea615b8\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"0305cdc3dfde0606\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"b80a44a0791a2d29\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"75cca647dfcc5f5d\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"603fc617c44a9ddb\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"31f777ee8d4843f0\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"f114e99a0806757d\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"edafd8a5c77a60c7\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"12c33b9e6ece286c\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"b0ac7e7858ff50f5\",\"/knowledge-medium/src/plugins/geo/index.js\":\"60f6986a7d3a5fa6\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"633d29a73a79de94\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"cd62fda850ecab22\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"3303258724443cfc\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"1b9dd1997a587d16\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"6bef3a642b455d41\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"6905c00363c24951\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"7ec9d800cd5622a8\",\"/knowledge-medium/src/plugins/geo/query.js\":\"382671a0ed1d2e28\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"9c1a6f4b35b186bd\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"ec96355b2ab6d646\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"d12f956df0b63928\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"79e44db7a004f93b\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"f6ad69c96065e2e9\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"1b4bff5a1b0a6365\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"0e59203f481a7e41\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"28f74c8bcde2676a\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"bb3fcf7b5f538840\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"c694277ad8cb9f68\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"abed6694382168fb\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"8f7a8ae05dad0b14\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"9958b012d76572cc\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"8456888b8b9ba9af\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"4ddc4f4c58922866\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"85147ed8bea72142\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"21de5faea60a7ac5\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"8e39f2520d80e973\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"96bbce051a9e9b4d\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"b8035b1fe2d3fd82\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"f0e05d79168c61a5\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"c159f1088ed21282\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"2bc2ae5f06fbe1ef\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"e44f982b9444165a\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"206cd22014ad350c\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"c6058e7667c3c61b\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"764ab0030de26dc2\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"348fc3a62046b08a\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"25782abf49734bc6\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"d3006ba554fbc6ae\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"4bfcb6fe061be2b8\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"13a87c8f665e0fc9\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"66415511fad2b4ca\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"e865e06b6cf49a1d\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"93b2c12af5085563\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"24e4ee5870dfc0c4\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"03a1e0248b989d24\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"11273b91076c2f0b\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"a659629f1a15da9a\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"da06f8251bcd8e11\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"11e8a0126a289613\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"51864625e6f3b71e\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"891b076b20e779c5\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"fdd358d7c42d25c0\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"5e8c030a188b81d7\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"7b5630ddecf43b56\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"c2930a54e32afbcd\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"65cf2d904ec0e04b\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"e084ed219005fd50\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"db0cee4314038e2b\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"72471fd3264821a6\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"abd97953fb15ad1d\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"ad353f54522ae7a0\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"45e45aeaf4532b64\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"f2b18e00ce156d03\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"5e4349247fca35b2\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"4394380647d8c596\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"0cd41a7219664aa9\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"5cdc0198f2aa75e6\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"3e9cbc691135e61e\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"cf92cfd3ddf5206d\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"0823ae41c6681305\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"2dae3e863eef7f03\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"e0f3a945ef7433ac\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"0b597086191727e2\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"926aabfe7697198a\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"017afd1b66fe6cc1\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"0c4f0f31e4a9bb47\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"af9cd3af2f126cb6\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"8fbf8894931eac29\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"01027a18538c188c\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"5bf010184322c54b\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"16ab016929d2f7ec\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"7f4b500e7a6bdf93\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"105e0ff61f4c85db\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"f8f0171534e902db\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"dde910cbaaf6ec36\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"bec0f8522bd06a3e\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"1111ca89c32efa60\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"78889435fafb7dfb\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"c158a9f03c00ba31\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"d50e8c08dbf92a8c\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"6b71697bd526ed3a\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"b732c937694df0a4\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"971b9f2766daea51\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"c45f6c33103cd34d\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"7bcf3b4138e7ca57\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"b40e161989844570\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"1ac31ef62b20de24\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"14b545ef307277e5\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"19a079f390ac7381\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"22445a62dac58860\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"73be63e71c03e0fe\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"0d235d9811d9e71a\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"4901b3e6edd0486b\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"c78e7a0dc5c646c2\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"2e3121cf2bf30ee6\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"1fff5783d85407c5\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"52d6dabf06a18a17\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"4ed9667dd21ea689\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"1e2b6be9ab147c56\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"d8cbf25f4e41f250\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"16a9266a625684bb\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"a529cd175115df34\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"91a43b48160709fe\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"45952207727400c4\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"076b8346b332adc2\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"d32ac15079d5e39c\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"e7c67937791f9e75\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"a434e7bd7053cf44\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"71cc3e68048c42ca\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"a180944abbc95444\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"315507ac2bcfcfb3\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"2f9c80129320a9c8\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"309a5d8215a72e0a\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"85b44640852c1b1b\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"9f9f1b961c5ced4d\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"b7727633d67a56b1\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"cbf3b78a9ba58cb0\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"319aa49f8b737757\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"a24917488d50b38b\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"fa3c8f897a0b0c4d\",\"/knowledge-medium/src/plugins/recents/index.js\":\"b33cedcd27608da5\",\"/knowledge-medium/src/plugins/recents/target.js\":\"0a10326fea91f333\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"2fc96a0d94a69b2f\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"73f14b5ea253705e\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"bc1ab4edf0209669\",\"/knowledge-medium/src/plugins/references/index.js\":\"22c7182663e33513\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"11595f8b86079fde\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"13606ece5e0dc742\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"aa3e831dcc53b6ca\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"f3ee886ae0f33fed\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"bdb0ee136e6c879d\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"346abbc9283a49c0\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"74d806301d5360f3\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"d100a9dcc6024b85\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"a131875faae6d5b6\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"c66baf6cc69e675f\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"92e0f541d3b345cb\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"11af80c6ded60b98\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"91d469343518af9e\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"5de3a674daa34c74\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"733ba70a71d28ee7\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"53691c53e85318e0\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"caec8ed348e353f6\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"cbaa6cf4b893c540\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"878409c68093c768\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"45449ddd421f3bd5\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"76e0e2e17692e602\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"252ef5f7bc9480a2\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"6ca7778f5b72983d\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"49201374a87282fb\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"eee4622f9bdf498b\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"e408b967f5172ef5\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"fe66617464af9e4b\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"79428d40ee1ff9b3\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"a1398243e937bf3f\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"93c6b29d234aa7bb\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"59034d7755777a12\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"8fb8135de63116d4\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"70b18fb2d876a4ab\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"5a3954f341a8070a\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"11ace86184b73491\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"d615df90487b7cb2\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"03d41e9292abb066\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"0e70e7bfc50ee695\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"222e0385eb4502d7\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"bc324e5efe5e44c9\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"7e7d82338ea3e50c\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"b42bc33c189fcbb9\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"824795b8c861ee5a\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"289e37943742f01e\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"85f031d732f1f5eb\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"97ef4da6f990cd58\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"864a66078c0fbc6e\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"345b11d446b1e668\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"16732681d182e35e\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"c13efe7b6a564175\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"c56438592814dc1e\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"a8d60968e0345ef5\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"d34c66dee76c6317\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"cd9773ae2b813fb2\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"58dfb4d52390a09f\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"4aadee30715f2eff\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"30b50d0b11e14b53\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"1e62f535962d09aa\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"9673bc39747fc392\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"71e0ab87f37c704f\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"1e538baeffb2577c\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"aac52bfa60398262\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"bf8e6bf497939bea\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"64d037efd55d5a93\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"3ddc5c757a3148ee\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"e4d41cda0587f8d9\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"7084404e04894913\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"6c4821df26cfba3f\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"d63151e4d1fff1a4\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"27035834d074f3bb\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"cf9df32d85c8a004\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"e76ca06e5cc4ed00\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"2e351984b56a3782\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"465d924438e62852\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"f573b31fae89a214\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"d8a46cad0ff94dd7\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"dbfada7178f5279d\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"ad520cf6f37f5b3e\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"0123c37eb86f6463\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"bf6fb3a6d2f58d45\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"97dd62631e5bd9a5\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"cd94f8b914ef70c9\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"d44dec680422637a\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"419df653a1f93a93\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"09fa25481da2f00a\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"aceccdc6f993d258\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"6bf4bc42ecfc6a20\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"a33f8f2534e7c2f2\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"d8777a5cbcd478de\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"617768c9d56784b0\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"5da046ad432cc967\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"887cc9e5539f1309\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"d9a30bacb5c4f4fd\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"8c82d1215694a2c3\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"09a8ca7fe42a4c15\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"23ecb5e18115d21c\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"39d9e7d007ad0235\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"d6d820b8090db5b2\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"42e2a6c0874e2a81\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"6899a14d02e4953e\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"53bdb260c82c285c\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"d57589154d748465\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"149887ad70d76fde\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"645164c2d78515ae\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"d0087ca7fe7d1f2a\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"502cf67eb5092f68\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"20a521c1c0dd3f46\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"ed41d923267c849c\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"8b7e1370c99ea20e\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"8f68ba1bd178e373\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"8ad66cfbbf6712d4\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"d580935f5a7de0ab\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"a6fad550c34d7911\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"ff8f7a0ba644cd61\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"5dad337cab53309e\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"b2d87c67c037a554\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"87646fd112452ab2\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"e4c7258c256bdbf1\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"115c6e31337c0658\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"194c4eb42401da66\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"a968d9f1a049db22\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"c8ea0503f077a2f1\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"07c984187c6732b5\",\"/knowledge-medium/src/plugins/tables/index.js\":\"8fb1435b0a6fd6d6\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"76302d16faaa4863\",\"/knowledge-medium/src/plugins/tables/model.js\":\"98aa62fad22de024\",\"/knowledge-medium/src/plugins/tables/navigation.js\":\"bc380f3f956ffe17\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"2313035d44cebc0b\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"acc226407096e026\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"b6239096b73b8c3c\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"829cb9e1e798f1a5\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"e7e17cb88dcf1a59\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"f9ba1053e4168689\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"9f6e094a40c11613\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"f2d00159027d1329\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"ffe66ceec9c91364\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"b6967541f16e5508\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"4a79ed6787cc8709\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"419527676ed81156\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"2fd04e042ec6f96e\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"a0e4367113e1fa98\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"8735a9ef3f8c32ec\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"4e190b2e2a3543ca\",\"/knowledge-medium/src/plugins/todo/index.js\":\"50202a0fe0136a45\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"3b33ef69465497de\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"6ad0bf23bc633a7f\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"c4e68b2cec4fa0f9\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"e33d9bea1bf03b10\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"0f1f1b98a1d5ba55\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"4b4d8173b2a7b156\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"2593ddd26b687695\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"db3ff18f5334f95a\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"3f70fe476f768ece\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"c3f629ac526b79cf\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"efdc37630c64cd78\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"f38d3a4c31f99039\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"0f268b8ec5bfbf92\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"411e023e033958ed\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"4af1d650a3e6e007\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"adb316bce43d3a2b\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"f25503509d997bcd\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"c1b2c0f090bc1dd6\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"34515a225322e46e\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"e8777ccab204acca\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"8335cc9216b71c86\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"f117acc3a3b78829\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"c760e5fee368fe51\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"0200eec7c151928a\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"0fef62bd2902847d\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"be32d1fce3153b81\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"04b1f70681ccdf5a\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"bee5f0806b8a3d8a\",\"/knowledge-medium/src/registerServiceWorker.js\":\"3d186de61cf80bbf\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"2549fa52b9a5dd61\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"1bdcdd243aab41ef\",\"/knowledge-medium/src/services/authStorage.js\":\"e6d7194657b213d7\",\"/knowledge-medium/src/services/powersync.js\":\"e7e26928906765db\",\"/knowledge-medium/src/services/supabase.js\":\"73adc19f047dbbe1\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"115a66ef2f5f2f16\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"bd8ca040a61c3111\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"e1af1ecb4a8c2e1d\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"b66d6c82fa642e16\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"ba852cc69725c4b5\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"6d9625114aa09d5c\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"7c0def371d57489d\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"c329f96f21b7966e\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"5a8e33ac59458984\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"9c08a01cdb64a97c\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"a389508728d00636\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"b3c59a55a286c867\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"308adb69873addb1\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"bd7fcab34626f75f\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"6f0dbcbe3bbe3541\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"1d5f80e9be3936ce\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"1fdc9a8fd1cc1699\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"b473376682edd21b\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"521b11a29acc99c5\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"1df55913de368487\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"a6dadc12dc6fd784\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"af9cba98cda1f1d2\",\"/knowledge-medium/src/shortcuts/types.js\":\"325a215bcec08b0b\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"b30d669c31c5b300\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"72f49eea7583f83e\",\"/knowledge-medium/src/shortcuts/utils.js\":\"d4ba9c709ea3c2f1\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"8ee8184f91f324f6\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"ffc9fe4b223772f2\",\"/knowledge-medium/src/sync/byteTransform.js\":\"4742cd7ca6b2d05f\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"3e0107340c6a2c30\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"143474083f7e2eda\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"5187cf340d446032\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"973f76facabc9866\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"db7e6de9436de269\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"1657f1f0b4c49a6c\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"ab2d98559c62f734\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"26b69479a08bfd08\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"89029b888c0d3520\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"05a57861e221e91f\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"d954453d85bf6bcf\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"18cdfd3fae97b2f1\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"eab6467320a9496e\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"92d9b853d7f6813a\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"00cf91d5572260eb\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"73f45d8b4ada1aee\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"d5c878e76c5d4919\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"f61db109bf069b2e\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"e689ce7ac793b330\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"ce7ced29bbe9ea77\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"1beaea26b8d747f7\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"037e414f1971f17d\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"806c7922f87127f7\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"dc2d905432dbfa4a\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"d6c448635aadc16b\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"b11c62fb378b77b7\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"437dc8ead101d95d\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"0028c32ecec9889a\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"cbe73ae3595c2bf3\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"637cbff541276f77\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"37ebe3dd27b6bbee\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"201c72a6b374f831\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"ba3d2d89e9eb7f09\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"9f614975d32e68d7\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"8b7a3dd76eeeb4bf\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"35ab91e411c292b1\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"6653a85ec733ddc2\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"d4a4aec683989750\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"174ac8ed7e41b2d9\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"6f64eb9ac71b6fba\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"af05a0326e978be6\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"a9125073db9e2229\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"218abf16351be6cf\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"aacd4aa9aaeb960f\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"6f2b85f861b0d20a\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"c255db1d476e95f5\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"6ab8c7ca1d71bb2d\",\"/knowledge-medium/src/sync/transform.js\":\"cc869b424de9b962\",\"/knowledge-medium/src/themeBootDefaults.js\":\"21507ab6defa9851\",\"/knowledge-medium/src/types.js\":\"394679a95e0cebe0\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"ae5246ff815a9738\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"e685c1210fb8e933\",\"/knowledge-medium/src/utils/array.js\":\"2f1f9a372a39e6d1\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"626422bc2d1e1547\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"a9aa97448ae560a0\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"ba601120f572219c\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"184fa1ae5edb504a\",\"/knowledge-medium/src/utils/callbackSet.js\":\"887f0a84869714c0\",\"/knowledge-medium/src/utils/clientId.js\":\"e1323b998f7aa044\",\"/knowledge-medium/src/utils/codemirror.js\":\"792809b9251c4261\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"3c91e877eb1e3a44\",\"/knowledge-medium/src/utils/copy.js\":\"17aa4e61cdb007fc\",\"/knowledge-medium/src/utils/dailyPage.js\":\"5b119baa424244ef\",\"/knowledge-medium/src/utils/dbForensics.js\":\"be5c9f40334c5267\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"fc929abd3fa4908d\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"20227f5d8106d610\",\"/knowledge-medium/src/utils/dialogs.js\":\"0aeeeebaf747801b\",\"/knowledge-medium/src/utils/dom.js\":\"bdc058e7fb4448f9\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"02a25ebcf679c3b2\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"ee59cffc68601ca1\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"ea72a99b7dd990e5\",\"/knowledge-medium/src/utils/flipSlide.js\":\"d0410feac02275aa\",\"/knowledge-medium/src/utils/fnv1a.js\":\"2c6b42d53e0bb592\",\"/knowledge-medium/src/utils/formatBytes.js\":\"5015e60d4b398072\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"4dfec632b6856074\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"5bccdd4c7455882b\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"325496b45a876c0f\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"d26fc50461f9d195\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"4857b0f32ceeabc5\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"c6ff375398d2d7a6\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"ef7482ca2bec9292\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"44a7aad767936908\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"87e08a354bc1be6b\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"1ff1befd06a917ce\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"e20425de7d82cc7e\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"07112a05ed0aeb5b\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"fd4c43a2d409fe18\",\"/knowledge-medium/src/utils/markdownParser.js\":\"d8300e61b7e5b170\",\"/knowledge-medium/src/utils/memoize.js\":\"af4a88718ce6cb31\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"ddf6ae0ce46f4cae\",\"/knowledge-medium/src/utils/nameList.js\":\"b2f1f6f260577767\",\"/knowledge-medium/src/utils/navigation.js\":\"56cfc2f12601e842\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"e9b8e76180d5f22e\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"5b6af801ea7c6772\",\"/knowledge-medium/src/utils/panelClearance.js\":\"1e622c99c6c2d2a0\",\"/knowledge-medium/src/utils/panelHistory.js\":\"b2d3deff45094105\",\"/knowledge-medium/src/utils/panelLanes.js\":\"eff5388306cf55eb\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"f3a2fe1ed85c87be\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"32fb24f05c1a8787\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"60d9962e3e6011de\",\"/knowledge-medium/src/utils/platform.js\":\"aee8f1b4b84dd76c\",\"/knowledge-medium/src/utils/pluralize.js\":\"6264f2dbd4499d54\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"a5e56ed09c377f9d\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"450219d3aa98b241\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"8e9e165b9d0b14cc\",\"/knowledge-medium/src/utils/react.js\":\"06f77c690739c115\",\"/knowledge-medium/src/utils/relativeDate.js\":\"4e21fb261cab2654\",\"/knowledge-medium/src/utils/relativeTime.js\":\"a66b637e6977f306\",\"/knowledge-medium/src/utils/renderScope.js\":\"4c6e07996b4645e1\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"dfc22f1ca0b5c3ea\",\"/knowledge-medium/src/utils/routing.js\":\"9497ed2ad135bb81\",\"/knowledge-medium/src/utils/safeMode.js\":\"3f9fcae1b3bf7084\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"9ba8a028ea0298a1\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"62c1e70dd78d69de\",\"/knowledge-medium/src/utils/selection.js\":\"2bf42f122217bbfb\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"24e1e9467e2fd383\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"8fd1a4c64c1bee26\",\"/knowledge-medium/src/utils/state.js\":\"46e2f5c6b18897f0\",\"/knowledge-medium/src/utils/string.js\":\"d19ba40c493f1951\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"0111d6734cead977\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"d3124d5f45dd4518\",\"/knowledge-medium/src/utils/toast.js\":\"e47d54008e4ed5b2\",\"/knowledge-medium/src/utils/toggleStore.js\":\"461afb8560f9a810\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"961a3782796bf60b\",\"/knowledge-medium/src/utils/userActivity.js\":\"a07524433bac3c42\",\"/knowledge-medium/src/utils/viewTransition.js\":\"517080fba862594d\",\"/knowledge-medium/src/utils/viewport.js\":\"9179cb208078c865\",\"/knowledge-medium/src/utils/webLock.js\":\"c6d77cb8c7580faf\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"12d12c2c7f5eba28\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"18fcf71e4fd5d76f\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"e24b3d04691ab115\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"dd648e061d59ab52\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"f43f4dd2acb7d831\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"2a711f4bd9aff501\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"f6828bcd815af853\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"b8a359042a3297cc\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"43fb4b30919c9110\",\"/knowledge-medium/src/vendor/react-dom.js\":\"77bd3311ba186f1e\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"9e28415b94e214f3\",\"/knowledge-medium/src/vendor/react.js\":\"3cd036941b909496\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
