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
		buildId: "1b132bcfee53-f2c7547c",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"a8cb9f12b2298d67\",\"/knowledge-medium/index.html\":\"a8cb9f12b2298d67\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-DppXURij.js\":\"3da179279ee87e6a\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"910616881d1dd5e1\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-DT0R159I.js\":\"4fb2cb23e789e42f\",\"/knowledge-medium/chunks/FacadeVFS-BgfiLrus.js\":\"dbc3ffef7129ba2b\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-BEBWNWdJ.js\":\"1132f07bb08b827a\",\"/knowledge-medium/chunks/MemoryVFS-C7rP61k-.js\":\"6547350f993e8608\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-BJPazNzg.js\":\"d0f4564e8e421eea\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-Dy3sAZZZ.js\":\"9a17019cf8cbec71\",\"/knowledge-medium/chunks/Preview-DVxZL3gu.js\":\"758e1ccbf4eb2e93\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-D_Av8Kak.js\":\"b2003fb7ddfc8d8e\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-U7BDGAFG.js\":\"d826e2f205041b1d\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-CtItMBmk.js\":\"09c46d30c7eb227d\",\"/knowledge-medium/chunks/react-CueEkHMC.js\":\"2d0fa16526b9f9a2\",\"/knowledge-medium/chunks/react-DC2CdEbj.js\":\"bad114d0aee9d430\",\"/knowledge-medium/chunks/react-DKpY001A.js\":\"5bc99d3c345266d1\",\"/knowledge-medium/chunks/react-DWiCoWQy.js\":\"d5075489d6053c98\",\"/knowledge-medium/chunks/react-D_0OfLwF.js\":\"ca44cf1b62cd0ace\",\"/knowledge-medium/chunks/react-cuM15eqr.js\":\"bad78c288df1d06a\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-BC_yoF3K.js\":\"6db1b68da6f362d0\",\"/knowledge-medium/chunks/react-dom-server.browser.production-CKzBb6oL.js\":\"7871e50e9edb3dfe\",\"/knowledge-medium/chunks/react-dom-server.edge.production-BqVWrnHH.js\":\"06ab7cd930b4a77b\",\"/knowledge-medium/chunks/react-wT05BSeB.js\":\"0dcf55ec4840116f\",\"/knowledge-medium/chunks/server.browser-RO7ftgkl.js\":\"02bf9a8c01a77226\",\"/knowledge-medium/chunks/textarea-CWljVSwT.js\":\"26d4cc2e6cbe68d6\",\"/knowledge-medium/chunks/ui-BVzcvF_6.js\":\"38760fbe7d73cc8c\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"807fd7b31e018d1c\",\"/knowledge-medium/src/appUpdate.js\":\"236f58ea683e6108\",\"/knowledge-medium/src/appVersion.js\":\"184d292e68d8fcef\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"fb7fc41c45da7315\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"a215ab71ea6d994b\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"d57be577cdfdfc47\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"2d6c54f3091772af\",\"/knowledge-medium/src/components/BlockComponent.js\":\"6b15a6d784250012\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"7101267970ac0687\",\"/knowledge-medium/src/components/BlockEditor.js\":\"426e0e358b99998c\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"4d7ccc9165909774\",\"/knowledge-medium/src/components/BlockProperties.js\":\"dd316f7198a53165\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"a0a2e65a84502c46\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"97b1f6957b75de9d\",\"/knowledge-medium/src/components/DividerHandle.js\":\"e09f851980d011b0\",\"/knowledge-medium/src/components/DraftEditor.js\":\"89ad3f6b4060520c\",\"/knowledge-medium/src/components/GutterPill.js\":\"6b642d9be4eb5c22\",\"/knowledge-medium/src/components/Header.js\":\"9e6c36211c21bec8\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"93def25ca65a30f6\",\"/knowledge-medium/src/components/Login.js\":\"0a500081fd20e24c\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"bd4d68cb6e453544\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"521ca78be1c76ebb\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"680bf8a04348c5dc\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"416fa62a1b570ccb\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"4b7618b26325a9b4\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"7cba8971de368305\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"984150bf8b7b9a83\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"fc6f5f0ae154af0b\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"8a34fc62486d9ec2\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"3de2c594e1a80c99\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"d7ec95bf9af886fd\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"37e8152c9b3ca317\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"495e69e5d5f7de3b\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"d01b88425d21581d\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"730d25dd973ba619\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"5a170e5c367395c7\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"afbd921dfbdee652\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"4bc8392c9ff78994\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"1163f1ddd2750353\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"4609a2c6e57bdeb4\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"d2dfa48ed2eae3a7\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"440d52b08ab9a62f\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"eb4f4fa2f1b275e8\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"701ef30d3e538042\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"2f248810bf3455bc\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"d90785c70e82f5dc\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"1194187d7a4be8f9\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"4225eaa517f3125e\",\"/knowledge-medium/src/components/references/CompactReferenceLink.js\":\"488a5d9e27e75581\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"3c5ed53ad3bce96d\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"0bad7606e975eff0\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"1cf0b37fed4835b3\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"51d2edcb05142751\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"4eae87a305a01f5e\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"15ef527452f64670\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"12d8856dfba5c1fa\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"7eff8370870568c7\",\"/knowledge-medium/src/components/renderer/BlockReadText.js\":\"30a9b97d42f947cd\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"0d3b4cafd498dfec\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"9e6109aad4e9a866\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"312f29122e1fbafc\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"c11446d26cc642cf\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"b8143f7ab40b4a31\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"709a941f6fdeae11\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"47743de55f8ceafd\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"e00a7ff39a2deaeb\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"a5e12049f696bce0\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"a787abea82c4088a\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"359f8823d7d37af0\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"cf9b503e7a986b29\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"f0afbf8fd7c9ccf4\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"e7ded1f50ce24409\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"ec276d32cb870230\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"e559658bdd3e423f\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"0d48c5282cc1ffb4\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"61df3eea20937b26\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"caabeb6b81e48f9e\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"71a7be68fd095ff7\",\"/knowledge-medium/src/components/ui/button.js\":\"03e0447a13930303\",\"/knowledge-medium/src/components/ui/card.js\":\"3cea229f8246c70d\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"868e4bcde83c0cf1\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"6e5033fc0fc56fd5\",\"/knowledge-medium/src/components/ui/command.js\":\"23bf4f42226d0fd4\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"99a7a28223fae070\",\"/knowledge-medium/src/components/ui/dialog.js\":\"d6bdc8704c2953c6\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"2ed47b3dbe4c116f\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"e7f7d191dbaa5fca\",\"/knowledge-medium/src/components/ui/index.js\":\"b89afbfa57f0bee6\",\"/knowledge-medium/src/components/ui/input.js\":\"bea83c1e1bf75986\",\"/knowledge-medium/src/components/ui/kbd.js\":\"a4b3a37b562c15ad\",\"/knowledge-medium/src/components/ui/label.js\":\"fdedf17575894e76\",\"/knowledge-medium/src/components/ui/textarea.js\":\"7f5652ad8577b6cc\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"25cf422be888ffe9\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"a24736db08f5204d\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"239c4e1db8140cc4\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"46d1d10516ff3732\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"9a894c973cbc4b28\",\"/knowledge-medium/src/components/util/error.js\":\"6d151fb71e1eff5c\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"725626c2dca8b053\",\"/knowledge-medium/src/components/util/suspense.js\":\"2aff3a08a0def866\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"6a7b0b0a85135185\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"4f1e8daf1936f44f\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"e4d61181c3422eb2\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"d7a9f63687645c4b\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"b5a6ddfd00422fc8\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"ea7a1f68701708af\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"d04738c8a05184ea\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"718f9b98dc3ebea6\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"c52233203b4bcd63\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"d41349a837eed361\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"1bfb7bca9b8c4bcf\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"cf5397eedb5de840\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"c46caa5c06059397\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"9a4385f4073eca26\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"c356a1eecf84a391\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"e778f5044b99d0e1\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"b451217d87636bf6\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"47ed8690547215f5\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"c5eea33c7bb55f31\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"10e140322966cfed\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"95f42b42addbb4b6\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"e88f0b5a08e6ef24\",\"/knowledge-medium/src/context/block.js\":\"86e4a9ea09ed87de\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"2f12a5ca3b3e5000\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"e1a12e0f19b41846\",\"/knowledge-medium/src/context/repo.js\":\"41aa0dd3bfa045cd\",\"/knowledge-medium/src/data/aliasClaim.js\":\"4aba2f453574257d\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"9b090a30b10962de\",\"/knowledge-medium/src/data/api/blockData.js\":\"d097fa15fc4c7d06\",\"/knowledge-medium/src/data/api/blockType.js\":\"bb93864aa4260156\",\"/knowledge-medium/src/data/api/changeScope.js\":\"b4108db19db09414\",\"/knowledge-medium/src/data/api/codecs.js\":\"61d42cf2841643da\",\"/knowledge-medium/src/data/api/derivedData.js\":\"41077c6eba2402ac\",\"/knowledge-medium/src/data/api/errors.js\":\"11b5dbd335225646\",\"/knowledge-medium/src/data/api/events.js\":\"211d078ec5e9666e\",\"/knowledge-medium/src/data/api/handle.js\":\"6ff0cc402b6e73ce\",\"/knowledge-medium/src/data/api/index.js\":\"6fd7db0e47522018\",\"/knowledge-medium/src/data/api/mutator.js\":\"85a98ab60631b4a8\",\"/knowledge-medium/src/data/api/processor.js\":\"008097922ac6b701\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"714f1f4fa057ba60\",\"/knowledge-medium/src/data/api/query.js\":\"d87c92bf32d949d3\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"2f8a42f2cf9cc401\",\"/knowledge-medium/src/data/api/schema.js\":\"6ff0cc402b6e73ce\",\"/knowledge-medium/src/data/api/tx.js\":\"6ff0cc402b6e73ce\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"2fab2c0ebb33fba3\",\"/knowledge-medium/src/data/api/user.js\":\"704b666ac1a035cf\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"0a80ef918a98f365\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"937825f85548dd08\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"9d4e80011ed4098b\",\"/knowledge-medium/src/data/block.js\":\"7d4c7d751a834a82\",\"/knowledge-medium/src/data/blockCache.js\":\"a72f21cfe2ef8ba4\",\"/knowledge-medium/src/data/blockId.js\":\"fb332bfd7164e9ea\",\"/knowledge-medium/src/data/blockLiveness.js\":\"b1679cff937c269c\",\"/knowledge-medium/src/data/blockMerge.js\":\"9c0b8c22c4c48645\",\"/knowledge-medium/src/data/blockSchema.js\":\"8e6a5ffb7d1f1f9a\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"2611737b02091aad\",\"/knowledge-medium/src/data/blockTypes.js\":\"564802a5add747e8\",\"/knowledge-medium/src/data/childrenView.js\":\"e60e4bf471b8a85f\",\"/knowledge-medium/src/data/clientContext.js\":\"f021814e9c8c2028\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"02a7f6d903aea249\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"e6112a5c03dab3a7\",\"/knowledge-medium/src/data/derivedIds.js\":\"2e073d3ee874810a\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"767f7064084a7010\",\"/knowledge-medium/src/data/facetBridge.js\":\"1d5e2a9583b13b6a\",\"/knowledge-medium/src/data/facets.js\":\"599144b25aed5487\",\"/knowledge-medium/src/data/globalState.js\":\"61cfb659a25b10c8\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"59e64fa6d0ece5aa\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"4dbae054c4cfb7cc\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"4c1fdb06b28f29d4\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"d467f139d10fa2ef\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"9f5c414c5cf8e671\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"c13bf4ea1536a42a\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"9b1d588e57fb4ed2\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"9caf43a8dac48875\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"c48334c331076fb4\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"32ef9dfd76ffcd64\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"837baa1ed827f1ab\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"3682ec1fa9d14e39\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"4c891252187d25fa\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"5e3e0eebe849bfc9\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"d3bff85e84867b9a\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"87a465c9804cd369\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"be65627465f547da\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"2f44642643240e6b\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"24d6591fc956afa2\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"62c223085535a493\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"533b2a2e5401f41c\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"fd7b59356fc3cc5b\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"814c5c55dc8a6bc8\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"5636f449c4e0483c\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"80e99a6947aa5037\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"03ec3bbad72d9371\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"f4e4e16d5fbdf111\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"6f15d00159a7fd9a\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"1b9e43c738f97b46\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"e70d5f6d4b87f73f\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"607d93c831d9e5c6\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"a4fd19776d4072a1\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"ed12b8e9d21548c7\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"d62e9e3a9110cd6f\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"5f47dc2c17ac43c0\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"90e03e9a922c981f\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"f4788c78ebdcbec0\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"9e5765a6129bf812\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"157e3eee566eb6a9\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"aa726e3c80b93ff1\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"6f0ecb493d142c47\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"82436d82ecbd2953\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"a3eef506353c52d2\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"ea1c74eb3e39b6b2\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"c0fdf21c36cb741b\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"ef9848fe165f18d1\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"80609f184eb15160\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"ec9cd76fd7d02574\",\"/knowledge-medium/src/data/invalidation.js\":\"7eaf4180d09131a3\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"1602fdef0b129b0e\",\"/knowledge-medium/src/data/kernelPage.js\":\"f7647d4f6fd879ce\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"1250ffda3bb72f9e\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"95c05bd82a3f702d\",\"/knowledge-medium/src/data/localDbStorage.js\":\"70e57d11fb443896\",\"/knowledge-medium/src/data/localDbVfs.js\":\"7ad567b754767045\",\"/knowledge-medium/src/data/localSchema.js\":\"61b0b8de39bcdf37\",\"/knowledge-medium/src/data/maintenance.js\":\"3fe6010c50701527\",\"/knowledge-medium/src/data/mergeProperties.js\":\"1b7257f68fd8d07a\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"59097a00a93f656f\",\"/knowledge-medium/src/data/migrationsPage.js\":\"2b577e9d26f7ecae\",\"/knowledge-medium/src/data/mutators.js\":\"1c0ae7ee6268c8b8\",\"/knowledge-medium/src/data/orderKey.js\":\"a9b8b6f3a2b15f23\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"8c067423f4e607fe\",\"/knowledge-medium/src/data/outlineSurface.js\":\"2f08ff119787aaef\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"bdd8a6fbbf77ce98\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"5e97a2f545512e5b\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"88cc809c638c3a3e\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"b63a7721b9ab6322\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"e268a07443da31c5\",\"/knowledge-medium/src/data/properties.js\":\"166a95e5ac1659c5\",\"/knowledge-medium/src/data/propertiesPage.js\":\"3353856aa5eb3c2e\",\"/knowledge-medium/src/data/propertyChildren.js\":\"f94e468edea0d83d\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"c27c11b496e07b9f\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"921ef093e5268b8a\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"01d513dc9d1ad7e3\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"c96efd3c157b901c\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"cde8a5ae3c4afefe\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"71f7f66253508d62\",\"/knowledge-medium/src/data/propertySeeds.js\":\"15ef44c227e082e5\",\"/knowledge-medium/src/data/recentsPage.js\":\"6a1d6bdbe04ba379\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"a25099af984aacd9\",\"/knowledge-medium/src/data/referenceBlock.js\":\"5d40510cf9ecf030\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"8c791ff9904b7f1b\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"b0998fdb7909adee\",\"/knowledge-medium/src/data/repo.js\":\"ca4d40226dadd827\",\"/knowledge-medium/src/data/repoProvider.js\":\"cc0b59e9d1bf6733\",\"/knowledge-medium/src/data/rowProperty.js\":\"cc637cb6d1f7a1a3\",\"/knowledge-medium/src/data/searchFilter.js\":\"63249de9abe0081a\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"b5ad9f2d7b006d59\",\"/knowledge-medium/src/data/stateBlocks.js\":\"0d27bbcfcc51093f\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"1b51f24a626a17eb\",\"/knowledge-medium/src/data/structuralInsert.js\":\"9f89a1fb2c03b4f4\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"d3d7c8213d35bedb\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"8990a7c51157f969\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"809c0c6745b120b6\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"789deef8cfcf1ee1\",\"/knowledge-medium/src/data/targets.js\":\"3d6e2624d24a7a6d\",\"/knowledge-medium/src/data/typeColors.js\":\"bb97cf0d37d028c7\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"26cdb9aeccfc4a53\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"4a0e73306d5dfda8\",\"/knowledge-medium/src/data/typeExtraction.js\":\"19911bb17a6e3312\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"7f650de476272d1c\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"9820282f0511c820\",\"/knowledge-medium/src/data/typeSeeds.js\":\"40caabb9a912d1ba\",\"/knowledge-medium/src/data/typeTagger.js\":\"fa2172ea9d4fff9a\",\"/knowledge-medium/src/data/typedRecords.js\":\"dfeb18e511b2e04b\",\"/knowledge-medium/src/data/typesPage.js\":\"d027fa8e4e7c46f5\",\"/knowledge-medium/src/data/userPrefs.js\":\"49c68b18c6772d51\",\"/knowledge-medium/src/data/userSchemasService.js\":\"7dd4d3404a9cb580\",\"/knowledge-medium/src/data/userTypesService.js\":\"762172f8c01d66b6\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"7f187b2c529f8389\",\"/knowledge-medium/src/data/visibleChildren.js\":\"fc0d832db9da214a\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"5cfcb5877e25e13f\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"05c9283df4a7c208\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"4c7785f9d229543b\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"5335752ff9cb7f88\",\"/knowledge-medium/src/data/workspaces.js\":\"331cdd2bb21302fb\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"4163400b44125441\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"ef44046d51b4fa05\",\"/knowledge-medium/src/editor/atTrigger.js\":\"4baab906facffb7a\",\"/knowledge-medium/src/editor/autocomplete.js\":\"4773e60a125ac689\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"fa94b25f7ac8a0b2\",\"/knowledge-medium/src/editor/contentFlush.js\":\"72d67d25f983b6ec\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"5cbbc6ab72276348\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"f431fd4cdff43a19\",\"/knowledge-medium/src/editor/insertImage.js\":\"780c934f8448b7fe\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"903b43d7015a2a8b\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"36b5f441a8e22eba\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"b21f35790ce69188\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"301ed8415f94c1c8\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"3815e97f126a34e4\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"02854c24c2f04fd0\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"5d23e422dd5928bf\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"c084268ca2da78c9\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"c6ed09fe31cb4d24\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"17238d69d96f8d23\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"52d070198709cdf0\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"662338be7eaf6d7d\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"ad6e931f9ac7d470\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"773bd7bb717955d0\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"ae2c505bc3b37fc1\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"9cd8f88fecf8d8ca\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"88951beb290972b7\",\"/knowledge-medium/src/extensions/core.js\":\"0566683ae34d6368\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"4cd86ef0fa377a89\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"2cbcf1cd07ad4f7d\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"348c99bc871cdaa1\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"9ce1c4da0874c7a5\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"87dd4351a77e9959\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"66744fa6e8c0f78a\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"7e0ea8b8c0b4c750\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"7d77de1e42e6d302\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"ed074d2f58b3a082\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"7a296f56ef341df3\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"8ad684cc4d50e02e\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"95c2f492ec51caf6\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"da9f618cec222900\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"a6e93890d2be9814\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"28490acc358b58c8\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"e23c090978ee8874\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"03365cb3d0c69c0a\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"aad8a9e13048a8d5\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"82f0cd1c038b7195\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"1c63ec8f51a8fd62\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"b499e541419a89d7\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"5f1ad35f2d17bcd7\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"217a040306912a83\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"4581de9ec4a63ff9\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"1b804fda3ee93b13\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"b603789eb7b16d1d\",\"/knowledge-medium/src/facets/facet.js\":\"31d2ae4602f97772\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"014cac7c642c542f\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"e74f2cdab59fe0c2\",\"/knowledge-medium/src/facets/togglable.js\":\"2b1bd1a6db1caaed\",\"/knowledge-medium/src/facets/variantFacet.js\":\"0159215fd86cc6f9\",\"/knowledge-medium/src/facets/verbFacet.js\":\"84ecb625c2057fc0\",\"/knowledge-medium/src/hooks/block.js\":\"68ca66b91b68f9be\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"d60b33c1338d758b\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"f5c7c435eb1edfba\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"b55d81e3f42451c4\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"12fb30aff74e7034\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"bfc04622b593a231\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"47e6e6f7c92c7931\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"1cfee328089e9947\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"3fa3d72799fdcef2\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"6c4f1396ea8e0d38\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"14f1c3eccaf0ae4a\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"e990df395330107e\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"d0650e3478014cc4\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"ad7fae88d36f0f02\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"128c5f44810c9328\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"64b84fae3c19c0d3\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"c6056f329e60294e\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"484c70fafe6c5cfc\",\"/knowledge-medium/src/lib/utils.js\":\"0a1a9a455ee1851b\",\"/knowledge-medium/src/main.js\":\"a8b96841918a23a4\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"cebf27766dca6499\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"b2e614b2f6c9fb64\",\"/knowledge-medium/src/markdown/context.js\":\"5558aa152bd5a6f0\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"ebc001cb65e0768c\",\"/knowledge-medium/src/markdown/extensions.js\":\"fbd13f7864ebc755\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"13f80690e43573a2\",\"/knowledge-medium/src/minimal-editor.js\":\"deda95965ff9ac21\",\"/knowledge-medium/src/paste/armedCut.js\":\"32964e5715f86200\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"0f403dfafeb156eb\",\"/knowledge-medium/src/paste/clipboard.js\":\"b3f41a4c62e466f4\",\"/knowledge-medium/src/paste/decision.js\":\"3d7335539089f38a\",\"/knowledge-medium/src/paste/operations.js\":\"58c0a604654db7ff\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"ef25b2b333e610ef\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"e3d3d6c657747896\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"99015ed5a25810bb\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"29effc2f8e5ef0ce\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"45ac945661419f6f\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"79eaf8b601edf95a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"35ef9ce406edf10a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"3702da90e9424653\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"03713300c79577ac\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"7f86860b784df61e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"761b28b55e871aec\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"ab184e2f4616ec7b\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"3256ac57d645a5f2\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"dd2e078bea475274\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"f5b5212e963d62ca\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"28e8f9eb00aabc41\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"ad0862a392e1de9e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"379e7916fce1f7e3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"fe05a48dde8e73b4\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"851a80fe41a089c4\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"92953930c9357c19\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"2d8cb1b56b49228c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"69c1f2767a9cb269\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"7184426ea9337af9\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"7b0d05df40304c9b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"29d2b63bd2a12841\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"45da417871cc6e30\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"7cf6caae07d40c50\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"9ce7dad76e338f23\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"aaa8de144fbb81f3\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"31751ec92984eafe\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"3a0d5e9b7590d027\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"f8fa15155ee54d68\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"dc5382ed8bc75e2a\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"e68fed89eb6d8ad8\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"6435d68ecb00ee40\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"1c76046fc8d1b133\",\"/knowledge-medium/src/plugins/agent-runtime/dayPropertyInputs.js\":\"1b67143dd1ed5694\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"367dade3a06f0080\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"d0c40b827d78cae0\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"8b2d4474a1b002ec\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"afba2024e75a27af\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"c6a3ecc1f14db56b\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"b98f2a0560f985ea\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"98dfd34515724efd\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"8cbcfed4c95256c0\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"acf452996b65b87f\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"9001491f03f2901d\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"fac8b869d18a27ea\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"f17d70d76cee0b1d\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"9a7f1223c1bee2b6\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"961e824545e55654\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"831bceedd25e8de9\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"e20871817147b7aa\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"489bdb50d62747fc\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"e9dc8d3e9233374c\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"139ac8fd652be724\",\"/knowledge-medium/src/plugins/alias/index.js\":\"33c604a540d3e01c\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"0318bc59a596248a\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"b223fe5bb124d0e7\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"1ce23a9581520c6d\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"3d5b7d565c98288b\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"5801af1faca65441\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"27d3dd229a7a9f5c\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"01c21e557dd0a5a6\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"4ef9fe4a5d67fab2\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"c126e6f0fd87356f\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"91e12eb55f1746c3\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"0f1d3567cd30d0f5\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"c4e7a9d78600e1b9\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"11e592955a61bf74\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"0e8b6a6653f37aab\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"402c9314d45435fa\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"7854951e903dda10\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"af9c5a988e260de6\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"f2b8a5f7f78e0bb9\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"2a23c9449ff1f474\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"2c1e615e1e5d350d\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"99602bdd641a4324\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"038bbfdb15b4f113\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"1092d9b047ee39c3\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"a1080fae27cb8c2c\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"fce19fd955251f10\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"6a4555d08d9d2fa2\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"63bbe7d9fb3aea5d\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"a2f02a5418a39bf8\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"c2fb4e9d18abcfc2\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"0d9a11dd3bf3d827\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"3cc7610780968cf1\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"01379b10e1353e26\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"cb95304f2827363c\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"2d021a73e804ebf8\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"eb92d254cce237b3\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"3a6b9ec391780d9a\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"4a96e64b8ea0d622\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"aeccb42c7956a28c\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"87edda927fe2447e\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"f75ab11c9eabbd3e\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"a62c3b0cb0940ab2\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"2c657d3b4785b646\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"5a041d894e106354\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"26e3f24593851c1b\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"165850eb4c32a5ae\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"34b0e1939dffd859\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"25fd71aa2d0217d6\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"6c6325e32a286f9f\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"0444b3b1a55c33cd\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"848a8861afcd6521\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"673c1b6ccf14d56b\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"e2fd074c6b224948\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"017ca5a8832568e5\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"3a8dbd2c2725a9ed\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"27c071f71d0c8d35\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"41abc4058c7a4d54\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"b0fc2849a15b5253\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"f838e6908be6d00a\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"b30de1e476b36ce0\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"0ca736ee6593bc0d\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"ed6300bc690aa911\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"0445cfd9a27b23f9\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"2cfa10f3da35baee\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"ce242c11f6f3ae07\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"db8407aae8d75b94\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"73bc046cf2d2e46c\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"e01563a9d885566d\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"d45606f8e609776d\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"b49f1403fce7fa28\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"898166ec1c80bb7f\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"165be5a2da79f531\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"d1d3e94f0be5e051\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"3a774e66d632b6a4\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"eacc283bebc96b93\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"8df4af1a9af76588\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"43d89c6d9a7be0bb\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"65f422d54e818391\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"0ee98b0d94d42965\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"ffb437b8a163d48f\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"790e200d98a6f8cb\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"f678b3c6d0e3cfe9\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"78a2ce3b2db05890\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"1f004983ae5cac0c\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"cbe2100720e0d30f\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"f93b2f4496ad4f35\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"b83ba128a51c7e5d\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"aaad39f5313a3782\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"0996c0eba021234b\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"ee36ba288b18b712\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"e73a16e1c570dfa5\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"a850bca7e4091d5f\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"30dcbceb24fca664\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"1fd0c5fe3cd01b9f\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"9f31e6c7fd46a2a3\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"2f490c95ac61d557\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"68251677ffc5db67\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"dbeb6e4a57b2a861\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"2d31bdaa6b0c9796\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"5cf1d13ad29657e6\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"63cbf67c2532bdc8\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"252662401c880dc6\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"3b139437dbb3e939\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"40ca2cdcf8f48339\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"b6fb20ec8ccce193\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"62c76107cbb4cb22\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"47d81799e4fc5d87\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"2e252902b2bb0808\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"853035980b705469\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"829ac73578f5a69b\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"08c123aec3a1a61b\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"d95aef6f5842afa3\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"6e419f6f3f448431\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"fcb81b5c6f4e84aa\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"1d671744b73ef5f5\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"31552abc2dd68ce7\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"ece313965f1783c7\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"736e9cc2df92057e\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"215bcf44cade0277\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"cc11391e44aa83c2\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"80e66ac6c49916c3\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"e1edffe0fa5fbcda\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"4a1bebc4d21996c1\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"151e1a8c863994df\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"de5139c0240fc060\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"47203ab6309a993e\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"c77ac3629c3be5ac\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"061d56ad8b6d81d9\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"c74b026e61f16b7b\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"8e6edb8014314574\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"28356cc28fd1cac1\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"0089e3808b991ff2\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"90012a983d46f0a6\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"0e506850fd506210\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"4caf696e5db86977\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"1fc979d6a270ab34\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"df8ca88078cd46f3\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"5e7417d5ec0a5658\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"7a6d70e923fec347\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"24e146da8811192b\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"0e0d0cfaa5020155\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"c49cefc854edaef8\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"cdd1ec176143498e\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"f5ba0140703ad1e1\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"a222a82b45891179\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"724bda3085b31b2a\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"de151871817b8242\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"4d1c39353a3347da\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"40d5aef57c579c8a\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"e31b68ad439ce3a0\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"34b1847dd29b13a3\",\"/knowledge-medium/src/plugins/character-counter/subtree.js\":\"21323abdb2292c90\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"779d2a6136570f15\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"f1690ed3d607bba3\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"df6d1825f28ebf0f\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"09fab877f91cea9f\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"7d7635c644999682\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"9cd7f6cb2a028537\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"3c3aeb209004e214\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"f987777835579a25\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"20d2e2c6d208052f\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"09e7ed9a62d93caa\",\"/knowledge-medium/src/plugins/contributors/ProfilePicture.js\":\"c4ab6bf0095680d5\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"23ee49e0346ecea2\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"7cbacb6e3ffd331e\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"5b0c8a782dccf445\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"4b4577e8bea14dac\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"a871aca24a93aa05\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"6915bed9feabc343\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"7bc8472554aa10f0\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"32c6e01e4addc09f\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"0177700cc7b10ee2\",\"/knowledge-medium/src/plugins/contributors/useCommentAuthor.js\":\"ceb84e183c137ae1\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"75f58712b1ed9d96\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"291a24f29bc23b8b\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"a6e344a53129a691\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"8d44683335805d84\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"55e4a794b5125d87\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"ac79a1523c2795c8\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"8b00e1011af824e8\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"7040529457b72493\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"88ea84f188c931d5\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"e6c649c6446b0b2d\",\"/knowledge-medium/src/plugins/daily-notes/DayPropertyControl.js\":\"08002f5797020e91\",\"/knowledge-medium/src/plugins/daily-notes/DayValueReferenceControl.js\":\"865cff228a988883\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"b302b2284ae29652\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"a9302d47c030950b\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"161a68e9d618f55b\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"10a97f2510b7527e\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"1b5f444616d9ddad\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"54fd1b62b49f35da\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"5f2f566c639239ab\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"14ad62d17f9b4bb9\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"de04fd1230decb5f\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"c7e299dfafb52bcc\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"64a4cf491728e5b3\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"40fbc57d177fb983\",\"/knowledge-medium/src/plugins/daily-notes/dayProperty.js\":\"a791ea649cecc586\",\"/knowledge-medium/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"86ad5707cc532b6e\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"f248f2cb896aca73\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"031611dcf533fe06\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"a7626f847cd96a33\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"7547670fc39e9fa8\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"6b755db7f676f2e7\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"8df430e575d9af21\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"a695ee250576b7fb\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"b5bbbb97bc9ed6ef\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"c722665ba350947f\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"f92b2bf10740145c\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"463cfbaec4dfee2e\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"d36c0b943e3254e5\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"6e4117774f87571d\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"fbc7f175c45c5698\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"aeaedc3b6859578b\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"3dab89299c2cbbce\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"994d238a5f599e22\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"358fc02c7ee0f82e\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"615ce0c48ce3695d\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"c6022fac7a25383b\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"ad52ae207c8c1150\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"28f0ecd8d04ba9ca\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"621eed0239efec1a\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"29288bbd14117b84\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"415bb0c9f338e169\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"0b59a379710a0962\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"a6b6c99a860bdd63\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"58e556d08179cb9b\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"5c365a253edf2545\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"3178455025c7ccfe\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"9234faea9c366c44\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"bae529a3c9ef3d8d\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"cfed4cfd8203805f\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"23d8552f036de0e3\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"199a61859728c222\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"50211b5b49941ba3\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"91667287d70010d9\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"b57ccfcbe91ea87c\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"672507218b89ad67\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"1d9fe7fe6872738f\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"404346bc50b39d2a\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"0c5793605d4a4e23\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"cd210675aaab9b23\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"711ad0dbf6673868\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"b6030ec02462a65d\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"8e4c9a73712b8e0b\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"21909eed3cf1b5d8\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"78a855eaced50693\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"3ce6c44edeb49465\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"85416de9f8cd890f\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"caf3ece5359585ff\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"7ee8179797c6de28\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"0e5ed8a5afc23e3c\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"26b0291ab36e23ef\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"2db6497fec6214d0\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"21d2a79a689a179b\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"847a60864b0ceaab\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"83e91226d0669154\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"74b489fd60e27c6f\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"ffb4ddba383d5b6c\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"d0d20ae086f882a1\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"66b1aefcb0d583ac\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"4d820fea8a9ab9ac\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"0b39c75d88684809\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"91cf19bf824e3724\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"79582c0844d9c378\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"51e07946f53ffd51\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"543e76452d1d3ee0\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"0f3f2d94031522c5\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"ccbb4621fe82a3e1\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"832c6fbb7fe65194\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"0c0309638e9d4886\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"1dbdd0b4eff85057\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"747aa99e2f41e68e\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"b619492a342be5e4\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"f3f281f23dd3a9c4\",\"/knowledge-medium/src/plugins/geo/index.js\":\"b22e879910630542\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"fa758e6d39456094\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"cd4dce2f64786a19\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"7a1d5a7bb30fd4a5\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"f2ea3b37d17ae1a1\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"96fbe59e23f3e9ae\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"4013164aa8440566\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"462bae4d9ba39c90\",\"/knowledge-medium/src/plugins/geo/query.js\":\"ba02ebabb5635023\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"b20d52d52891655c\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"7a339138cfc8789b\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"b4fe48520d8dff2e\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"87c94a94f20eac18\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"44b7b1e81d941610\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"82d98b2d50e7128e\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"e768aee7483247f6\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"a21dceb44c8023d5\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"a7f8b38897b86fc1\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"c53ac837a152b0e7\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"e2fff8eb5216f33a\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"d68bdc4437bef72e\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"8df3591c57cea0f3\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"3b7e04d404f3b373\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"6e8399b19f4e8a1a\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"fbc43e20b00026f2\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"f35388c88b5b0b9a\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"94edd744a0be4499\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"51feb502563dc05a\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"da218deb0dc9e23a\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"574380a71925f55f\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"b93270c23ee8180b\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"26385e6abc95661c\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"839f22af61fcadef\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"2977da482c9d0d6c\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"2e2494b540d9a8f6\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"fe1671ef4f28b165\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"b63570405aac6b30\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"c0bcc0677bc76ae0\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"d9927fd13699ddc7\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"60e28e0d2a33a1bc\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"eed6724e96a05c94\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"758536d9a8fa69fe\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"a78b3ca30e267838\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"a26f24ac290b9fe7\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"4a69449efdd18e93\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"ff21ade90cc4faaf\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"ab5de9e3ca3e9c9f\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"e1c765112713adeb\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"5b7c49bc889429bb\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"2e2247999a4b97ff\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"9ec6ad7beebe37e3\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"70d72ee98f4631b9\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"7bdb1a171714959b\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"76ee15a3473dd1f0\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"c2065e22addd13d4\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"4d3dd704d8c7a9ed\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"443a56fc695b4542\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"86ae3e3d8cbc7047\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"ace578f05c2e1c84\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"31abdcbbbed507f8\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"99588d82062f7f3c\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"8051df1ae76376bc\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"e917c1d2dfb95e27\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"3e7a2606d41cb263\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"1c244ba6d9b9fe3e\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"d2e9f458eb17cdc2\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"9202c15b7b7883af\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"840824299b19efb0\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"fa45dadcbeb397dd\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"aab917d5ff0d7793\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"5ef9f1d654d66a64\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"4ce7a9a9da33f5f3\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"13716075f9bca766\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"82ff3bbebd04b16c\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"f8167cb6cf9be5de\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"11633ced275dc88c\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"8f83d06b925f59f2\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"cf1cfc171ee0a15b\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"7412bdb0239a66b2\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"c6b9f772c369ee7d\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"77e0aedc4e9c6f18\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"3410918e6d5e2787\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"cc353f97a43f164d\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"c888f643a961b8de\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"3d4127e0747d6700\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"e77a79496bc1e474\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"d825b3e5f1743656\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"18624df408443480\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"9567aeb5060e90f0\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"e64a8ae6b501a91c\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"b2a6e6f054e3750b\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"ea5f2054de4aac79\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"ad59e23c2a02c6bf\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"cb6f06751eefd669\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"d620d9e8bd3d5d40\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"ea27a420c223d51a\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"da77ee2160b31d39\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"6ce738b6a3a90bf1\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"85f9160b049f348c\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"b3c3e1e6f0a56d17\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"d3884f3a19239445\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"5326d4c9e753aa35\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"53891e59c66a4375\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"04055b11dbc11a01\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"83bb9db424cf5377\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"165ec89213d21368\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"c6db92573914611f\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"dba743f97940953d\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"4975c335dce8af16\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"c68763be504d3032\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"7ecb0f715f6a55fe\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"545c39f53f182762\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"abcaa05233e42d35\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"e9ae3bb7ed884223\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"279501e1b4a86451\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"e891e943d4bdeceb\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"cb24c1d1cf46b21a\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"a40e87e6ad088292\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"ac06f563c0cfd7c0\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"006e797a592115e0\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"88df0d96eec67d03\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"e649221be7f232cf\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"24c1d11afb543c2d\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"f1ad6d10a5868822\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"516947cbf8a02fd6\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"46a4716854c0cfee\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"014fc5c5dbe2eaf0\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"ec96ddec7c1cec0b\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"7c2a67cb7bebf239\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"2954c7a29b074fa5\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"ce3e475963bf4c1a\",\"/knowledge-medium/src/plugins/recents/index.js\":\"4e51b717e01f627c\",\"/knowledge-medium/src/plugins/recents/target.js\":\"67be5f9ef7363d47\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"c6745c9b8f36374b\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"a5cef9572a7381a8\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"12e8993e02a1cbfe\",\"/knowledge-medium/src/plugins/references/index.js\":\"582449f85b8d89a8\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"24949efd5efa3519\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"b61bb3acefc0fe64\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"d02ae0f13a3a2fc9\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"b78c8cd066e4b710\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"e195442e4039b34f\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"869f01e7ada79806\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"8eb9941e5d5b6f3a\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"92c647416cc1f013\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"11dea2f62a32ef49\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"0d63ff765f1193d1\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"cb97a26b99dc76a6\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"738eb51b744ffaec\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"8277be0f49692a51\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"ff6a88924cf45613\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"67081669c7d1e053\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"1206f573aab3ba23\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"b3b4201a74067902\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"ed8da23579ebcfff\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"a017273088d3bac5\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"56f6864df9eb8b02\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"69477f9e9feb4fcb\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"0844696dd08d2c5d\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"3c149e134d1c7e59\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"e1eb54d97c2b7502\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"8ac119d79deaf50d\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"e2ac94d54861549d\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"7bff10e5609434ef\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"9540f8b2a07e3bc1\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"a4235f9aad56d7ff\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"bc4190b08c3378bb\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"2e696a604a790bb8\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"2cb87a0238759068\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"e2920770fde5be03\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"a93a2ba7f5d8493e\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"a61a3961aad0712a\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"8b470fe0e4203fcf\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"c54f24e8d389e3db\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"8ac4abf26897220f\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"7db3c65288d93a33\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"5001c592a4e1ec1f\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"6a2977cba55220a0\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"ca086d48c9d900a7\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"d787c0101242af9c\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"24c9e3e5d42ca327\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"e7b19e956a3a889f\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"89b7c24b40ac7aa1\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"4ccb041bc181d19e\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"099b79668bd1988b\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"cea852a98f05b594\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"88d967b0332fcc38\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"60edbe5255650d0c\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"0790c4b8bd1e855c\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"149c4d111b5f3c9f\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"c6c11a92b1e664b2\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"c87bc9850b5b4d28\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"271f183c18b87405\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"b9c705f98d84564b\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"b550a07096782dfe\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"843ee91587357155\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"c46c2118c25411f5\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"dac5306858f5b345\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"0ce722532b2818b4\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"e2131ef4c7a4e542\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"8924d44c2ab6280f\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"c8267b3792349278\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"5ec45c2d714938fa\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"cc41fe365eda18dc\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"b4e0ef00732f3973\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"3e521e5fdc7b9440\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"3a7f865610db7067\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"4488a7a7265e7113\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"abf83e241d56c03a\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"fdca8ec609c0a131\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"685b6e346266550e\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"b2957b4c53d3c351\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"6f27faf77a821387\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"830fee0f86654864\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"690c204a831173b2\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"ce524ed6e84de508\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"bec220834c6d60b8\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"c7714e856810ac95\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"8a8306dc96ccfb4f\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"8d5ad5949fd68547\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"e9ae2a0439de4809\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"760eba062cacb161\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"dda4ee4047d3fc1b\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"338f2b902f00c55b\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"6e42766d5fdf9620\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"58c2bd851c4ec3e8\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"e353a6cb43aa9e6d\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"fa788e4a591c15de\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"3ddf6a654879c0ea\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"30a6ffce9a004ee3\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"08aa659b8f866008\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"4095294e203cfae9\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"62f4130b9a7a5067\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"6ff41760a46bd843\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"4046630b4e4d84b9\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"1321d7e8214c870c\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"f81eb696a67c02cb\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"49da8209ecb6dcff\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"26c995db1e9a49c0\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"13b3ee961d16f78b\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"86a2db7bb66d281c\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"0868e7f216b8c534\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"82e7cbc8295e980b\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"c705073706e405c7\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"572861909cf7e009\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"5d466a82a76e46b4\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"93b97116f216c8c0\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"119129bd55fee8fa\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"83e10788892258b3\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"167020faaa3b1506\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"6146d1f27ee3522a\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"eaa17fdf94e9f145\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"4a0ff20727be99c4\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"c6abb63738d36608\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"46fcc4afd3589a7b\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"f919ebb6f6db3a2b\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"32d9ecaec1634a56\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"2dd44ad155686aa0\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"b2d6adca72d8541c\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"5d3eac5f1eea34f1\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"a55a3dcf2204e3d0\",\"/knowledge-medium/src/plugins/tables/index.js\":\"d25b83eaf2251f85\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"73df51d4c098d6af\",\"/knowledge-medium/src/plugins/tables/model.js\":\"6b7b6562c1dc473a\",\"/knowledge-medium/src/plugins/tables/query/QueryText.js\":\"5b9e2a2120527680\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"b74d48e97a915860\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"7476ff921f48ad28\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"bde2be70c465cd56\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"08732999e598c00a\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"bbde194b5e2b534c\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"86f8cf73fb0571f5\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"8bfd07a23c5c3476\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"4c31ace3421c01bb\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"254d6640f6358cc2\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"1a8e2df63a667ce8\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"a3caaa8eaa530eba\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"ebd497cb31c61935\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"b00beb7ff29b47f4\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"6deaaf0763b3a59d\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"a767a0c3062b94de\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"1befdfeddc8a0413\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"bdbd10d80ef46cd1\",\"/knowledge-medium/src/plugins/todo/index.js\":\"1378f7b97f03d276\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"60b2762bde1f5233\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"8363690ac55e1a3d\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"0fbf9c424e0855b0\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"627b672603895388\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"b0ee025ace3d9f97\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"c0de55990e06a177\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"47c6baccc53583f4\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"c39c86c9e56470a8\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"c9d4d19f7cd5fb7a\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"4b517c690d98e147\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"ae89e1d84c394125\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"fd9aa261bd2b0031\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"599331f0783857fc\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"b93373c4af9aaeed\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"dea03ea78079f2dc\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"2f054c29d3b6cb81\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"586003d8f587d83c\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"d46a2bcd467ee81d\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"2d06c8c5241b0f95\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"302991129f172d30\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"a1d3e62287d38fe1\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"9818d901c675ad59\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"17d27c18f1f983b4\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"e438cd608d3ed614\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"0b846d9bc10af985\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"5b5e8a9ad0e4ea5e\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"3e42dfef97dda66e\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"3bfdc176dce64ac0\",\"/knowledge-medium/src/registerServiceWorker.js\":\"a36601de341c5402\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"457183d3e658303b\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"4fa38a78e37b7e31\",\"/knowledge-medium/src/services/authStorage.js\":\"c004bede3a99cc16\",\"/knowledge-medium/src/services/powersync.js\":\"d83cb2e91d422107\",\"/knowledge-medium/src/services/supabase.js\":\"80536302149ec763\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"38e1de24962fd36a\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"617b1a62620815d5\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"6a4d4769cd3d23ee\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"59cf2bb098b73247\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"322bd732d4e708e6\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"c76e4116f92e12e9\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"a229d26cc6042aa8\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"cf329b7b5810cf9c\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"54850656cb8d3b79\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"89e3c37eaed1bf4f\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"3ff83a5e216ede77\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"56c654b94073f859\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"dc26e1519771863f\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"a003aa080f7624df\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"ad6db3be26a24191\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"1d1bc76b054f8f2b\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"9db7c689a2b1dbfb\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"16aa407dd3cdd1e9\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"bdc3a870524bba6b\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"d110691a151f25a5\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"1051b5282be01821\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"346217cf774b211d\",\"/knowledge-medium/src/shortcuts/types.js\":\"05cb2b43cf8d4fa2\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"730032fc7f9d1f4b\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"d98a131558efa2fb\",\"/knowledge-medium/src/shortcuts/utils.js\":\"d20ff69439d9b78e\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"006badb6f50b4b13\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"bc77297f980d6779\",\"/knowledge-medium/src/sync/byteTransform.js\":\"bf577f72bd8613cc\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"871fa61e24ba7f8c\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"aaf4d607bc8cac65\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"b3ae83464b034c14\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"db0d7852418208fa\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"95ff21a8a0b33cd2\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"8e0df5781428c176\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"6c133e97c61d2e50\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"6ace736e1e9c020f\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"51200104d55541c2\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"2435ef5c827cbbdc\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"05838013444fc908\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"3e9cab68178aea00\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"96eafbfbe1201ef1\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"a0a2d417cd2322c7\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"dfc0a1ffbd862bef\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"eb0ee952c0806680\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"3933e41f58f3979d\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"835a5b18f7ac4ec0\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"c465b4c14082f7a1\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"afdf89c265716215\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"8e2c6a464192ddae\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"053d7616e60a0480\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"7489de2e5cc6b706\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"e0a314e0ed03637e\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"3c7a95d74d50c202\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"ad943c4a1eee7818\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"1ecc19a3f2ee855f\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"b5060265ccb4444a\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"10b2d3d8937d662d\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"8be2d22dce3bd662\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"0f939c1c278f2e30\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"9ca6c94e0f641723\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"d885f803d2cd94db\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"a2e64b26a4e6f563\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"875b74eab3be3b36\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"684ef9db36404c85\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"6bd99799fac607f1\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"612e0265a99a6b9c\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"1efc70f26558bde9\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"6fd6726cfbb3660e\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"19845f541be9b010\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"445e8ff7394e6acc\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"3edaaedb9ae30410\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"36878299888a8f95\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"e78bb711317c0705\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"ca627b606c44d154\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"589da804b74b929a\",\"/knowledge-medium/src/sync/transform.js\":\"59628ec74f38429f\",\"/knowledge-medium/src/themeBootDefaults.js\":\"9bae12225405eaa3\",\"/knowledge-medium/src/types.js\":\"5750aae47f46c1d5\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"6cce683b0e6cfcd7\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"0f1e6677ee28811d\",\"/knowledge-medium/src/utils/array.js\":\"752a00b4b202a0b1\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"109e9fc9e9153b0f\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"0e95297d11a28999\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"3b5fd6350c02a5b6\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"6b7cd206ad4de5b2\",\"/knowledge-medium/src/utils/callbackSet.js\":\"3f0de74459710b36\",\"/knowledge-medium/src/utils/clientId.js\":\"3d36c91d8c0f0f9c\",\"/knowledge-medium/src/utils/codemirror.js\":\"0f9b5ea27318b3cf\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"184902315299fe8e\",\"/knowledge-medium/src/utils/copy.js\":\"3477be5b9ea8d288\",\"/knowledge-medium/src/utils/dailyPage.js\":\"da7de92531388a70\",\"/knowledge-medium/src/utils/dbForensics.js\":\"3ed8f0adaccf30f6\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"a1da0c1f63f504c2\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"515b92ca00824fd6\",\"/knowledge-medium/src/utils/dialogs.js\":\"a729c90163972e93\",\"/knowledge-medium/src/utils/dom.js\":\"a803827a2a45bca6\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"f072ca636521f193\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"ae7072cf2f80cafa\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"7c3bee8f67a96431\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"385fea20a6948695\",\"/knowledge-medium/src/utils/flipSlide.js\":\"b58ef41a926e96e5\",\"/knowledge-medium/src/utils/fnv1a.js\":\"66253b305e75b4d8\",\"/knowledge-medium/src/utils/formatBytes.js\":\"fffd1753c2dc2ce2\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"2452fb5be392f7f9\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"db42123c065a9c4f\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"d957589aa5cc2f09\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"5f7c85a18af78437\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"cceaedd40b3d28e4\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"124e410ce392ec94\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"0778b38ea1f09044\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"2317bdfd25e27e1e\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"0fe4cb7757600513\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"5cf1cf94d25ef279\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"5595941c3defd6a7\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"10878c18a58c6427\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"518c375c5ec919c5\",\"/knowledge-medium/src/utils/markdownParser.js\":\"7f1920076464b161\",\"/knowledge-medium/src/utils/memoize.js\":\"6aa35ef4ccf686e2\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"3e9346c2effd79b7\",\"/knowledge-medium/src/utils/nameList.js\":\"dee6e1e130c5daa9\",\"/knowledge-medium/src/utils/navigation.js\":\"2c09c3524aafba76\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"56eeccdc840a3672\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"cb8499916157fb20\",\"/knowledge-medium/src/utils/panelClearance.js\":\"9dd56a58c6960784\",\"/knowledge-medium/src/utils/panelHistory.js\":\"53c1d030f8edb10f\",\"/knowledge-medium/src/utils/panelLanes.js\":\"01bd3a4af27bc9bf\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"3b37d5fb01b4bc40\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"5e897d4d8e88a4af\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"76e4a7cef2fd24f3\",\"/knowledge-medium/src/utils/platform.js\":\"faf5a4ca683273ee\",\"/knowledge-medium/src/utils/pluralize.js\":\"1b4f45cec10dab0e\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"8de6228e1cecf563\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"cf45ef4201fa62d4\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"133d2bb7ee030e4f\",\"/knowledge-medium/src/utils/react.js\":\"8f889b760eaa9a00\",\"/knowledge-medium/src/utils/relativeDate.js\":\"83aaf8307a40e051\",\"/knowledge-medium/src/utils/relativeTime.js\":\"f16986a55611aa4a\",\"/knowledge-medium/src/utils/renderScope.js\":\"ab7a552e72ae077b\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"213486b2ed42a0dd\",\"/knowledge-medium/src/utils/routing.js\":\"db95c6d8c259e649\",\"/knowledge-medium/src/utils/safeMode.js\":\"5b96db82985da420\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"bbba73775797ff2c\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"ddb80e3db597a835\",\"/knowledge-medium/src/utils/selection.js\":\"78c04e2496eaaaa1\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"99545c0b0333ee13\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"03fe1951aee63e1b\",\"/knowledge-medium/src/utils/state.js\":\"7568e605415368f6\",\"/knowledge-medium/src/utils/string.js\":\"f8b7e538e8192b3c\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"805f6f5dfd5aee62\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"8180df8b434dc0c3\",\"/knowledge-medium/src/utils/toast.js\":\"012260e7b8715913\",\"/knowledge-medium/src/utils/toggleStore.js\":\"8c51d7a526b50955\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"535ca10aee882d6a\",\"/knowledge-medium/src/utils/userActivity.js\":\"5604d00853c046be\",\"/knowledge-medium/src/utils/viewTransition.js\":\"15323c26d450eb24\",\"/knowledge-medium/src/utils/viewport.js\":\"8b6a7ac2bfacb65c\",\"/knowledge-medium/src/utils/webLock.js\":\"6849760886117620\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"bee8f67b9e138cf0\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"5aa271c32ef1c013\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"321c4491361be289\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"98df5d1ec58d9640\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"76aebe1597a39063\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"2099202b7d7c2a24\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"c00d76b901b3c0ed\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"513418305d846f97\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"dd2bf8e6fb621ecc\",\"/knowledge-medium/src/vendor/react-dom.js\":\"5c9cdf584e07a317\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"7b8234d9c23e060b\",\"/knowledge-medium/src/vendor/react.js\":\"54cb1afb991abefb\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
