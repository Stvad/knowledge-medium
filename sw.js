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
		buildId: "d75dbbfb16ee-18f65e64",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"22b712a03fab5f04\",\"/knowledge-medium/index.html\":\"22b712a03fab5f04\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-CByJ4Hcq.js\":\"6823c98886f5042a\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"ad840afad054e8ad\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-D3lZoGop.js\":\"b0456622128ef117\",\"/knowledge-medium/chunks/FacadeVFS-BwNFqisL.js\":\"2f56132e4535f566\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-Dwdsm4lU.js\":\"c3e7e8810275edf5\",\"/knowledge-medium/chunks/MemoryVFS-hnKDI7pY.js\":\"1234f2caf0bac672\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-C7bb2hEC.js\":\"684a814c0c46dc3a\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-B9hbpIHk.js\":\"02411ce57135388e\",\"/knowledge-medium/chunks/Preview-Do1Gxur1.js\":\"ca363935085d3236\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-Db5DH0yC.js\":\"14659afa8d156e00\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-9Zvegn0s.js\":\"4f2a62b29848a9a5\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-BR4Y_pg1.js\":\"bda8c1dedde4632d\",\"/knowledge-medium/chunks/react-BRBYNbqy.js\":\"bdd1a6dfb1875f37\",\"/knowledge-medium/chunks/react-Bba41Zll.js\":\"fc6dc05e033e8e23\",\"/knowledge-medium/chunks/react-CkemyhoD.js\":\"d6f270e859fc8434\",\"/knowledge-medium/chunks/react-DPPF6OoE.js\":\"0ea7b90f39095272\",\"/knowledge-medium/chunks/react-DS1SeTr9.js\":\"734ede8202f326f2\",\"/knowledge-medium/chunks/react-DX4qjdPD.js\":\"41bdb1a8891510f3\",\"/knowledge-medium/chunks/react-DcExO27m.js\":\"29f43c6afa7c5b99\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-BuEsnWC7.js\":\"861140981e94a3a0\",\"/knowledge-medium/chunks/react-dom-server.browser.production-CY7G_R4q.js\":\"3488e9b70d571703\",\"/knowledge-medium/chunks/react-dom-server.edge.production-Dt1ve5_X.js\":\"d3536d40b8a3d630\",\"/knowledge-medium/chunks/server.browser-B82kNVyh.js\":\"0eab2bc613c745b1\",\"/knowledge-medium/chunks/textarea-D8B-nNEq.js\":\"1c60419192037ac3\",\"/knowledge-medium/chunks/ui-BWU6vXA2.js\":\"f70b1e7ad0a12357\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"95aa798d4b582245\",\"/knowledge-medium/src/appUpdate.js\":\"e6e85e36d806ca47\",\"/knowledge-medium/src/appVersion.js\":\"e9fa7aef9a79390f\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"b7853c09ce23573a\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"e121e255baa161ea\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"ccd3fc95bacb4055\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"ad34b0ed9dc3a87a\",\"/knowledge-medium/src/components/BlockComponent.js\":\"43782620f1ee5d2f\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"b5d481474dd3c8eb\",\"/knowledge-medium/src/components/BlockEditor.js\":\"15f5603e059ccfe7\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"db78fba50b84adb0\",\"/knowledge-medium/src/components/BlockProperties.js\":\"7603140512c00d17\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"05dd08ce116a231a\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"eee7430425f6b11a\",\"/knowledge-medium/src/components/DividerHandle.js\":\"d7e16b7fef860a2c\",\"/knowledge-medium/src/components/DraftEditor.js\":\"cd7f6c7887f6b7cd\",\"/knowledge-medium/src/components/GutterPill.js\":\"37ecd866f1bfbf34\",\"/knowledge-medium/src/components/Header.js\":\"9efe584520145ee7\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"0d50a38ea7003d71\",\"/knowledge-medium/src/components/Login.js\":\"e76a161ccd60e302\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"8fb28ca0a0b631e6\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"4d18bb3b5287ebff\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"3f7ba8ed5f25f2b2\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"d97ffa750cc1b49a\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"abf348d139815d6e\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"72d88d7dfed4ea19\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"c4a3c588d66118da\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"9063049a9fcbde7e\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"9c6384972531a04b\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"9e3f02ca2c657576\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"705f9108b15562ff\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"761a45e948cab0fe\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"7b8310d5389e83d5\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"17f5b6d81dd59cb7\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"a1790117ea131d6c\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"83f85f238448d031\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"6752964b00e8846a\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"6d7ec34a58970d14\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"65270fb9c7bf99b5\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"4532ea7d00e6f9b6\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"6f6df2f54a3abff8\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"bb317b8f84df64e5\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"4a7c0ce477acd907\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"d67b7dcdb16cec6e\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"35363bf38297c9d7\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"cd72d07e4ce28457\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"a32a0fe92606e1fb\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"1989be5a495a3ab3\",\"/knowledge-medium/src/components/references/CompactReferenceLink.js\":\"4a3665cb59d47705\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"2fdfab886a7f6ebf\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"4c2e5d3c59a52bda\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"02058a40a44477ff\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"55f8fa430063d8db\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"6404156e6ad968e5\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"fb9428178b58b053\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"21111feeb9d60eb1\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"d31118f061597224\",\"/knowledge-medium/src/components/renderer/BlockReadText.js\":\"e00cf773cfcffefa\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"eae5c00b68cece5c\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"b333be9461e1eab4\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"4631ebc31dcacf18\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"f5b2eb4bfa3934da\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"8a327c95963af833\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"ab311207263652a4\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"8ae3eae5078b2a84\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"0375d55b94ce59f0\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"9ec15228b24556f6\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"a07b65dbebcd1637\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"c3e8eb11df664ce7\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"0c38738f0174fce2\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"7e785543fc195d35\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"dd82debd810f2cea\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"a5bcd84a32c5d7c4\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"56095e5c5fd5d346\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"50a149c0b9baad84\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"62052782d87be9fc\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"053fccbea236d202\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"354b8de4ce122e19\",\"/knowledge-medium/src/components/ui/button.js\":\"fcd04b6607af378d\",\"/knowledge-medium/src/components/ui/card.js\":\"da3ad7815ba3cac4\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"4075341b2340ffa4\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"14dcd90d71ca2cd4\",\"/knowledge-medium/src/components/ui/command.js\":\"2a6efe3eabd1688b\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"f9cb474645e78336\",\"/knowledge-medium/src/components/ui/dialog.js\":\"a81f1530944f68a0\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"6fea18c2014f992e\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"5577b32d406dba2d\",\"/knowledge-medium/src/components/ui/index.js\":\"6846d87d2a10ac4b\",\"/knowledge-medium/src/components/ui/input.js\":\"5d0f6a8ab4afcf58\",\"/knowledge-medium/src/components/ui/kbd.js\":\"fd66bcd3e00e8fe1\",\"/knowledge-medium/src/components/ui/label.js\":\"402da27275b33e49\",\"/knowledge-medium/src/components/ui/textarea.js\":\"d4e4fae2697e992c\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"73dfafd1e97e5faa\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"d691f3f693ddb48e\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"98ac4f86964bff3f\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"69957d5a43186df1\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"60d88f99cbf8abb7\",\"/knowledge-medium/src/components/util/error.js\":\"39956645159705b6\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"a188748f79513537\",\"/knowledge-medium/src/components/util/suspense.js\":\"33d0c242b8ac4213\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"e66f79b21c2beac2\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"e22bb5a0f3ed3a9a\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"77c3f9fdad628c98\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"9443075d1df1d04e\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"f99864d36ad293a3\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"7ed6e06b1d437c46\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"b87405f9350b6fc3\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"906ba24b8a5001f9\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"de20243a794340c9\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"9e597d43c14523be\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"e18499c39b77817f\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"9fd1ba70581f694c\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"749ce965056faf65\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"aeaef4246e75426f\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"275ce54c6ea9ebc5\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"6997c87d3c48c5c2\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"02ccbb4eb72192af\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"92e4da8371f2064e\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"6857417184b36954\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"97a44071ab94f51b\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"39efebd97ce3cee5\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"6cb076506ed6bb54\",\"/knowledge-medium/src/context/block.js\":\"76b41a546e909743\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"a65d407d1f50922e\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"0d15b0017b7d1416\",\"/knowledge-medium/src/context/repo.js\":\"a5a5c8f8c268b133\",\"/knowledge-medium/src/data/aliasClaim.js\":\"f0bbc543c7866136\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"c3d4ef07d64a7558\",\"/knowledge-medium/src/data/api/blockData.js\":\"97269decf614e3f1\",\"/knowledge-medium/src/data/api/blockType.js\":\"f8abdb082f0e2db2\",\"/knowledge-medium/src/data/api/changeScope.js\":\"47bbef99f8d575e0\",\"/knowledge-medium/src/data/api/codecs.js\":\"15484b4e7665a6fd\",\"/knowledge-medium/src/data/api/derivedData.js\":\"a4fcdddaad9bf74e\",\"/knowledge-medium/src/data/api/errors.js\":\"2941ad2f826c3815\",\"/knowledge-medium/src/data/api/events.js\":\"5173649b8b64e90a\",\"/knowledge-medium/src/data/api/handle.js\":\"c323faf1122ec2b8\",\"/knowledge-medium/src/data/api/index.js\":\"9655c93241e823fd\",\"/knowledge-medium/src/data/api/mutator.js\":\"ab9638651757ff6c\",\"/knowledge-medium/src/data/api/processor.js\":\"59897bc3c942b94f\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"e4b81aef75bfdd7b\",\"/knowledge-medium/src/data/api/query.js\":\"86c4680669f06ce1\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"fbe8b0727bf957dd\",\"/knowledge-medium/src/data/api/schema.js\":\"c323faf1122ec2b8\",\"/knowledge-medium/src/data/api/tx.js\":\"c323faf1122ec2b8\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"6f71459d9983da8e\",\"/knowledge-medium/src/data/api/user.js\":\"f44144dbe8a27706\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"de187ed3b06d167c\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"08c6d893114fa0e4\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"ae22754f400864cc\",\"/knowledge-medium/src/data/block.js\":\"1e84dd67982a5b5a\",\"/knowledge-medium/src/data/blockCache.js\":\"536c3408106c7f31\",\"/knowledge-medium/src/data/blockId.js\":\"b34a8478e52daa38\",\"/knowledge-medium/src/data/blockLiveness.js\":\"a7afe1f2cadb61fd\",\"/knowledge-medium/src/data/blockMerge.js\":\"6f48ee3f03e61874\",\"/knowledge-medium/src/data/blockSchema.js\":\"62decc7925393b2e\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"947faacfc2a545c3\",\"/knowledge-medium/src/data/blockTypes.js\":\"a074f94189b9198e\",\"/knowledge-medium/src/data/childrenView.js\":\"bbccc9bd0d8e38e5\",\"/knowledge-medium/src/data/clientContext.js\":\"d9f683c8c7daff91\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"cc42c5e94212c084\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"538bab4aeb9181bc\",\"/knowledge-medium/src/data/derivedIds.js\":\"30b27ace69489755\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"b32b26d829f6ebba\",\"/knowledge-medium/src/data/facetBridge.js\":\"8bf07729bf33f3c2\",\"/knowledge-medium/src/data/facets.js\":\"e470d38465d0df5b\",\"/knowledge-medium/src/data/globalState.js\":\"f16ebf505d4bca51\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"696fe65645eff074\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"4844c64690015893\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"3969bc6e42f15fad\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"109c779003e0e013\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"bdcb6787bde7bdb7\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"525d10f8c2a7e017\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"33f2405c066fc922\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"cdf05e2334292178\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"8b0a2b4bfd9ca514\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"022990383aac7003\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"f61148fa6a941434\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"7d8c65b47355b372\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"eccbbf34594a3e10\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"62b6170a32fbfe09\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"5f2d3f72b61ac42c\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"d752630a304879ad\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"b5ee966831e7bed6\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"23a343c598a22536\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"c2cce42e3f3b61eb\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"a1dbeb38cde8ad51\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"1dda71ced5a66283\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"aa2f0b374232c539\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"569960471e74ceee\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"48cbf6ebb5e1b81c\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"979291ab398a04e1\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"46278d0fe0a7e827\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"3afd9cc8ee3955ea\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"4c18af7c018289c5\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"1142b38152804770\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"654cdb7063629c50\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"08a444363b82ccd9\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"3b8c93e7919530ac\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"66649a908067f26f\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"c30bc24fa7862796\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"3e85be89f5ebff6c\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"39d7cf3e734424b1\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"68e0649afd94bb90\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"0322590489697feb\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"d034b4e2f595fca7\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"d1415a503db02b67\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"f7e37750e734992a\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"1765c9536216f8b5\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"66e18e1cf02f1c11\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"a0429126bd39a20c\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"b343f0ad46f467cc\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"65cc6b86e37b5ac0\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"d18b8be36e9ce844\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"b705a9a34000ae2d\",\"/knowledge-medium/src/data/invalidation.js\":\"56472090e556b395\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"d31036481653634f\",\"/knowledge-medium/src/data/kernelPage.js\":\"9e5eef4a847f43bc\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"71c8a95e3e8368fa\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"9426fc9a011597d0\",\"/knowledge-medium/src/data/localDbStorage.js\":\"2b244a1d6b93320a\",\"/knowledge-medium/src/data/localDbVfs.js\":\"460d9b2b08ecec08\",\"/knowledge-medium/src/data/localSchema.js\":\"9eeb2d7af13949e7\",\"/knowledge-medium/src/data/maintenance.js\":\"0d5e79f4070b4c25\",\"/knowledge-medium/src/data/mergeProperties.js\":\"143d9b3905bb0bed\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"49cd8891e55377bf\",\"/knowledge-medium/src/data/migrationsPage.js\":\"b40663c393a728e2\",\"/knowledge-medium/src/data/mutators.js\":\"b5aef0a32551cace\",\"/knowledge-medium/src/data/orderKey.js\":\"519c913097a4f11d\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"d9567b4c424d4826\",\"/knowledge-medium/src/data/outlineSurface.js\":\"31c6759a1436950f\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"e4d3b939aa4fee45\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"8a77ace873199a62\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"2c189c69bf63bd31\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"1d51dc2d86adcca9\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"de878219dc1969a2\",\"/knowledge-medium/src/data/properties.js\":\"841a51ea7438e5be\",\"/knowledge-medium/src/data/propertiesPage.js\":\"5d1ca47625eaea6e\",\"/knowledge-medium/src/data/propertyChildren.js\":\"1bbe11553d8394be\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"1b65b6cd437ccd29\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"cd6136ece596b2df\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"f779b09876e670d6\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"09409ddc57d637b0\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"e5e080a92b45291a\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"4890d35c4e9adc12\",\"/knowledge-medium/src/data/propertySeeds.js\":\"1ea6c2e461b39d0c\",\"/knowledge-medium/src/data/recentsPage.js\":\"c89cc51d8fec2865\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"b6e05cbba63cee65\",\"/knowledge-medium/src/data/referenceBlock.js\":\"9c2018aa0c893e7d\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"2e68038d4da3b529\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"68187a7d4ae217eb\",\"/knowledge-medium/src/data/repo.js\":\"92be09e416c351a4\",\"/knowledge-medium/src/data/repoProvider.js\":\"0318cfbb4a24682c\",\"/knowledge-medium/src/data/rowProperty.js\":\"711d169718364e3e\",\"/knowledge-medium/src/data/searchFilter.js\":\"9af0e5dd1252927e\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"60885a1fa09c312d\",\"/knowledge-medium/src/data/stateBlocks.js\":\"5b0f5bb38bcbea91\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"9ebd9606a2420c1e\",\"/knowledge-medium/src/data/structuralInsert.js\":\"9b691656b3ced2ea\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"ca5bc24d9e173224\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"e06bc359bdddb473\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"1ddd52c31a277a30\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"21288e59b51e8447\",\"/knowledge-medium/src/data/targets.js\":\"583a0b5e07f0770a\",\"/knowledge-medium/src/data/typeColors.js\":\"dcc366bb45eb3f02\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"99353d17885c58e4\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"3652d9772b13aad6\",\"/knowledge-medium/src/data/typeExtraction.js\":\"b62c65a2b79e1f67\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"7726223499defd7b\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"f977812e6d861097\",\"/knowledge-medium/src/data/typeSeeds.js\":\"ebba2f68a15dd2e1\",\"/knowledge-medium/src/data/typeTagger.js\":\"9755c9a84aa58074\",\"/knowledge-medium/src/data/typedRecords.js\":\"0894caa9b54093e4\",\"/knowledge-medium/src/data/typesPage.js\":\"51ff27b31885f657\",\"/knowledge-medium/src/data/userPrefs.js\":\"cdb5a0c944beda32\",\"/knowledge-medium/src/data/userSchemasService.js\":\"e4b2c43b1213a9b1\",\"/knowledge-medium/src/data/userTypesService.js\":\"138d1817671cc9c1\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"6fe2a0dfe92a6c12\",\"/knowledge-medium/src/data/visibleChildren.js\":\"c37e08a0e11a078c\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"51bf8bfac8db7e46\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"72aecf3aaa90f059\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"d9d1717adde5ec3a\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"cc166a0f3001c161\",\"/knowledge-medium/src/data/workspaces.js\":\"7f5e79a5798ed06e\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"af0307293ebe8589\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"e496cb57f3e00800\",\"/knowledge-medium/src/editor/atTrigger.js\":\"6265fc54eb841fee\",\"/knowledge-medium/src/editor/autocomplete.js\":\"e505b833fcea4bd2\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"3cca8b435e250461\",\"/knowledge-medium/src/editor/contentFlush.js\":\"73e9a441612bd43c\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"45b731bd41925864\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"117e8b770429c68c\",\"/knowledge-medium/src/editor/insertImage.js\":\"a4fdaefa8d8d4c8c\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"57607af5f03fb32a\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"34d4253c2eb98c61\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"c0fedee7e3903f2c\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"7a79a0ba6a3b0249\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"3d6947958de5a6a5\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"8ad7bed825539a00\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"f04303c56c0b2636\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"a7f4e4b8bc76547f\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"6f7b78be410b6117\",\"/knowledge-medium/src/extensions/appRuntimeController.js\":\"b2b0d77efe07c9cc\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"c1cfd7cd816813bf\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"112aea331dbdbe2f\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"5b3961b3c535014b\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"ab411d43f749617a\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"16f7178d0e1583d7\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"cb732f892ecea4e6\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"39d6f6bc78e2382f\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"06aaef695026cd94\",\"/knowledge-medium/src/extensions/core.js\":\"3b59f55ccb9189c0\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"7f73a91e76cf022d\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"b0d84fba71c0f4ec\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"5a9418c1bacbbbe6\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"2cb529733295a815\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"4f8a72a6e6a93ce0\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"eb3119701917c866\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"700b417da456d23c\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"49103fe8d9260c46\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"9080b59e2a9c60c5\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"11185ca686e72d2b\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"0da77dd83d87a7b4\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"cd7d0f8c903a4ae0\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"5af10c046e193af9\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"470d0cbadb1ee207\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"1c747632f75a0e30\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"0e803306fadc75ab\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"abf926f1487ea4f3\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"cef86a29560802fe\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"6203fae5ce5d2b03\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"0a0ef65d9c085061\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"7d93b16c8ced665a\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"67967f921c3bc289\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"5674796fc1c08c4a\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"5f783e03bf8820b8\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"7594cb0cf8777b79\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"5380328e4b6bdd40\",\"/knowledge-medium/src/facets/facet.js\":\"eb5faaeb281ddb60\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"aa5b2f05187e94c7\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"6962672f40941475\",\"/knowledge-medium/src/facets/togglable.js\":\"77a9a997bcc25c8f\",\"/knowledge-medium/src/facets/variantFacet.js\":\"f03e9d9712874312\",\"/knowledge-medium/src/facets/verbFacet.js\":\"80e99ab86486af08\",\"/knowledge-medium/src/hooks/block.js\":\"f667183af8c73dd9\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"97db22d57d05286e\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"b431d99050600c75\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"2564290a405f2a45\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"6b35efa30d63f1b8\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"cae48206828df0a8\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"5bb8326d620b2d31\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"f6f8b4ff99ece1fb\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"6a0a43a76341f612\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"801e1586a99c374c\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"9f23cc86af4b613f\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"ea5e1a5b67026d0e\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"85afaa0fbacb2a7d\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"affa266446f5d66c\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"b0fc5c7a4bbc261e\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"a24f35249d82b55f\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"8d5e487f85ad7750\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"737634df8a3c115a\",\"/knowledge-medium/src/lib/utils.js\":\"9aa94bd5ed9fef95\",\"/knowledge-medium/src/main.js\":\"8ab185c85528570c\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"b8d22ffff4356174\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"c92e796d06d5604d\",\"/knowledge-medium/src/markdown/context.js\":\"aa15078ed4f64727\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"5487ab8fe59aee29\",\"/knowledge-medium/src/markdown/extensions.js\":\"215e3277498d2e9f\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"b8e1e56f0fca61b3\",\"/knowledge-medium/src/minimal-editor.js\":\"1d50aefb830bb60d\",\"/knowledge-medium/src/paste/armedCut.js\":\"04cafe6b6d68408d\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"af6fe935502ec9e4\",\"/knowledge-medium/src/paste/clipboard.js\":\"8e033f162ee5f185\",\"/knowledge-medium/src/paste/decision.js\":\"271ca39379772a5b\",\"/knowledge-medium/src/paste/operations.js\":\"3849fec6ab1c846c\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"a3d608bb3b3994fe\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"15492dd5a8f87c50\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"171df4c81e32cc33\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"ab531e2334e959ce\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"d94f9375acb5cbb2\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"9c63537490ba3f42\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"cddedc250d5a3a3f\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"c9aedd49e76a67d8\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"b34aead08af7cc6a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"1681b7f848d30f17\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"f155a9037f6b824c\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"a15f4e6a0b30fa94\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"8cfe7ba78c23be74\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"a2b276e1d80f5d70\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"4f6f1df89d12f5b8\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"d8aacca102bd1ddd\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"a60fc9743a65dd6b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"b9c984e78d721e0c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"f27ad093954f1872\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"7f21942cf76ecf41\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"ff8f96c2462eeda4\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"83239ed551a9bdf6\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"2ac37fa5fdb857c1\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"0797926134c36b0e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"cd5e218ca1b72552\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"d678805a8d51a130\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"babafa8fb618b7a5\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"5bfbd5821c232904\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"f18bce5649629915\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"8e14baa3c4621d6d\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"b64766d0c428e882\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"c0673a9114045b4b\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"e8acf17f2364a587\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"a1d540c7c935673a\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"4bc49234a2ceb7ae\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"48e93879afca1b61\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"8a7f94d42bd29b0a\",\"/knowledge-medium/src/plugins/agent-runtime/dayPropertyInputs.js\":\"2527ed0afe4f6f33\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"1177556f59186e57\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"78e2aa6ee142bca1\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"3201e9551a2db2ba\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"2eebe4f2ae1a156d\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"67b291f26b9f4cad\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"64b066907cd0168d\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"667434dadaf60703\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"7d483cb18f6228e0\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"b5fcefc6333ce3e0\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"018defb422f10c3e\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"5b2e754de063d15a\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"bee4a460233e5589\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"f5b739e128f0945f\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"c7488bb35f2b4e12\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"987136b906b9b2f8\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"90c832e845233d9e\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"f422a2e0d3c5d66b\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"917079009b9f5a27\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"f720452f970ee1f9\",\"/knowledge-medium/src/plugins/alias/index.js\":\"0458b704dcdfe64d\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"32522af0bd371328\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"7394e18a1957c680\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"54d30a89131b4af9\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"39859a31807b1595\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"04f6446de5531217\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"439789fb437c6cf8\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"58817efb4b47566b\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"368339f3b67bea1f\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"9f4a6951424d1c66\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"6ae85ca872dd89d4\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"1a827cb2d62e4dd1\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"9d29d9b355098208\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"18b6215d625c7e6a\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"eb71f482a8598f84\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"991dcf557c038b8d\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"4499e4f6ab1859c7\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"5a5411427a359ccf\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"b786526b47d8fed4\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"d46c7433232ed03f\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"8a048ac7c7920eb5\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"90a79968dda15c73\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"01dc90af7db32b80\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"caa3002cbdceecd5\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"4c77c04c9a50c87e\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"e2ac57d93c9297ce\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"013bda0ee4806e7a\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"ceaf2d277d0a3950\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"b1a705f95a7ef2c8\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"66f3565f8bf2c1b8\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"0f4285ba7fc95ea4\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"bbc5804287ab801c\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"5c135abb829335fe\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"8f7294f168f2731f\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"bce089f17ba39ab3\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"0ff34d26b86b0c03\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"67ac88c980e94132\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"e8b7ea155908e860\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"87e27d741b655dbb\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"a7c3fa356b1761af\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"75128e0077b291bc\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"9151e9f4e47a0074\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"9771e8ac2d8fd47a\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"ef8475ff1406c0a3\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"3fe95711cc2f5607\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"be7ceb5d598afbaa\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"4c4ef86960af2efc\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"4bb2b57b8d340cda\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"771b7e342f672066\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"0f2211315364b932\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"0db5a673e6d6f8ff\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"ed2125257237fd42\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"d7d060caa038a1fa\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"f9e1aec602448327\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"68837c6b0d3dc0e9\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"c85d54b32c5ef969\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"4cabc51b8a6d490d\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"2d97af83d611d141\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"cab968a6c61d99c9\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"622310115b2b9a4d\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"6cd1e9fdc8488109\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"691492e052af7405\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"c0df3f5dcb4e8f45\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"da634a04746e6436\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"55ed8fc7ed8679c4\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"c5ed3d8131acf83c\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"5aaa31eab1834090\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"ddbbd600859068f6\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"8b34c51c6c56be8b\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"dc4615617c4bbf37\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"6b19b43d74d9e2cb\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"64de7f68e50f202f\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"31b0b7781edc8069\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"43d11cea935d4e67\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"a6cbc3b7513c0a6d\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"db94e2579d92b427\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"bfc669c3d8a9a4ae\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"053addaee4418559\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"bfb8469762081ca1\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"1d17297fa7f2fcbb\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"ff16f78149179a5c\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"822253eb33a1e329\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"93f9eefaa1197091\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"35432e5a5f7b80cb\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"22b7db33c1b924d6\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"df8f84602ddc8632\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"02357fe89d861d28\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"c58672828b747650\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"967c88f45cd6de93\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"17377b983aa64a9a\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"45cad7ca6c84eb04\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"02176004013e8f80\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"c8a420599ce423eb\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"51d64ced7080885c\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"c956e78687b53f25\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"7c426fac5448da7a\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"24cec441d41704ba\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"0c41e6677cb29a28\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"6e1b28a7c394807a\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"f186a89e90c5a9f8\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"3a4fcf26192e7f57\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"5575308487b281aa\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"eb5cde9dd00192df\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"9226eeae5274c54f\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"85bd51f53c97e4dc\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"19727130e9c4a755\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"6a16b540327dcce8\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"ad8c432f1e1ab331\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"a89847817974352e\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"b4e22f80a9922253\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"62444e7dd0d647c7\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"999c4940eb01aee5\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"31dce0c3a84e7c65\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"578c5ffe1e8c9e2f\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"7f23a3161f8454af\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"66a26b3b05366f87\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"809fdd12467a78be\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"44888700b1f7c96e\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"145f99d3b238e72e\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"7be83d8106b1edda\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"5a62eba2a8fa6e98\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"fb9c8529eb928378\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"9ba127d0861deecc\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"84ca44f8a1e56ad6\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"0990484c2be2f26a\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"305e50d7fbbdfccf\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"6b65e07eee90c43a\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"71ea7e7c7f387c37\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"62c08b00b74bd3fb\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"aa88e6242d517856\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"f221bcdd7c0ce396\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"a1725db9721555c3\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"d77de31db631cfc1\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"b14bc506e51a2ec4\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"aeef0526efb7a345\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"362a50ee3999d0c4\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"98716f5dbd1795e4\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"4c2cdefcecb04cdc\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"cfada3d03a5a34f4\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"8d22e12be2b48d59\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"bb2939bac76fd1bf\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"519bd5ad438f4411\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"f5ba3b2001581952\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"285b5612b6623f0e\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"facf1cad4804fc83\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"7bfdead794d4f3c8\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"c66a82d0c1f4bc6d\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"4fd8f084eaf6cd5b\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"b81fbc66d46cb986\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"2dbaec7c89301852\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"8ab58c6ecab8b864\",\"/knowledge-medium/src/plugins/character-counter/subtree.js\":\"d0deb9a64f26e849\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"51bd6710fe04ec9e\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"95c4dcc17f8f4d49\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"9f645e040bb2cfa0\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"4fc700693de6cc1f\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"875ed6905188872d\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"a28db065c696ae5c\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"ed7a808f2e056100\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"1f3c50a8cf93f7b5\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"4f20354a6cdf824e\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"047f45876cbc14f5\",\"/knowledge-medium/src/plugins/contributors/ProfilePicture.js\":\"4c5121de63d4aa6c\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"0e9d0b1666eea9a9\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"5c4837f1f61c3580\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"f4d40c3293350b65\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"144ef16682f56712\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"7fe7bce1eaa20409\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"578a041d7157d790\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"04338b9cbd4ba799\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"ba387eac3468c6a3\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"40c82202144b7d7f\",\"/knowledge-medium/src/plugins/contributors/useCommentAuthor.js\":\"308c1feb7fc298b5\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"568115c3048a9c69\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"b46d938145f023dc\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"0ed720d46184a914\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"2ed5a39a9f7923e2\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"acc80b626c99d9d7\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"4d8617aa0d243cd0\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"052ac13360be71f2\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"84b35333859f1c1b\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"f333fe810f8a929b\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"81582ec4e547e7e0\",\"/knowledge-medium/src/plugins/daily-notes/DayPropertyControl.js\":\"4df9cbbc9bf2ee37\",\"/knowledge-medium/src/plugins/daily-notes/DayValueReferenceControl.js\":\"1740b7852ea2dca0\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"acdfcfa549da1139\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"6674eed157b7732a\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"b25811bfb5ef27a5\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"84d19d78930d7701\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"de32efe04de93f9d\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"f460c6752ef36b95\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"ad5d76b9e6b988b9\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"1be79f0dabfc32db\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"50afa0efa1c7df7c\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"b90839e740b9879a\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"c8b099ce4c54b4fd\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"8e78c63b0bbe5461\",\"/knowledge-medium/src/plugins/daily-notes/dayProperty.js\":\"9d68e293ef75a4b4\",\"/knowledge-medium/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"099cdc1b2eb02e20\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"16ed6215dee7342b\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"a9fb2232d2f0065c\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"31654cb383d3ed76\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"34c3960373773f2f\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"2d265096289f2f9a\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"1507cb30a90e3b5f\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"20437acbae9f0d75\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"7bcdb4e58af7266c\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"33dc5eec803e5939\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"c6b2a0375bca7e20\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"a0f7244d464c651e\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"6d47ed297fe18124\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"492ad6f223206be4\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"b0f2d9f200b1a45f\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"b67c6b4a57f01f1b\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"b9dbde1dd6dffa8d\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"c6f063e9178aa940\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"bf2a9b3e3d9f69ee\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"a31edef79fa4997c\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"7de750b4b5960623\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"98d2ac54086266d3\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"afc4475595c4b940\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"6f486391b818af80\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"f65df29a9d66902c\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"a07b71722dab3a7f\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"e459b6f0276fb69c\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"ae824a37af6095a6\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"adf3c0b4f153753a\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"33362a10297bf032\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"ba91d89d5f70d80a\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"6ebfff0c5d82518d\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"6292a90b18deb0ad\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"63c0f4c4a9dbb857\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"2bdc8b7ca0f423e7\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"73aafcca67a80515\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"6bfbd4da881bdee0\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"a559f21ca7d978cb\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"d86b2841b24a6fce\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"ab0ab7b56dcf3e5c\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"211ef0c24b7d9113\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"c93c7a98cc623b22\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"5b9d66f6db4308c1\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"62571248868426d1\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"686b0db1c8f62d2b\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"feeab980fa282058\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"7dc181a4b4889886\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"40b171b405e6db64\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"90c10e075c6a9c29\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"e36484c4aa0c740c\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"2de4838987692621\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"75ac925d09c5142c\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"1c52566c8c7c870b\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"e92d678bf5cf674c\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"d88b76b3f0ce938e\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"1e99282c0d4dbbc4\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"f09652ca4c40383b\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"a2be3b4b438b1d47\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"dd6a37a8da056a50\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"b1b682fed02d780e\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"46b53d7f3bf1f345\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"7a724b6b9a4f058a\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"8f7a7856be2e6aee\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"ca2c379bd75c592d\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"dda27ff4d8b2a2d9\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"e34e9d3eecd4cfec\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"ae43ce93d3139565\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"6dd4b2176b9b0948\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"91609f02df0fed67\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"c550fedbe0716fef\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"271d0580d03e4af6\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"9b160f956a1931e1\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"d56c8cfa667bae3b\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"16ec550a7bd89ab7\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"059fa77aa63611ee\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"02c985be4b55f182\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"f76e2b939fb3828f\",\"/knowledge-medium/src/plugins/geo/index.js\":\"0cb6fe410978a7ea\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"ba3db370a2fb5693\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"ef61e469c4fe2c3e\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"18992ea2b195a720\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"7c36d9228869a3a5\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"e6b6296fe5aeb8dc\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"d56644755b0db92e\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"bf657020d6dfdb13\",\"/knowledge-medium/src/plugins/geo/query.js\":\"81088849d81dea26\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"354c509e5943450f\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"8ce0234f85b9b358\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"1435245ade139308\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"bca20df40256345f\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"7e7e32d814c4df4f\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"4f3eb9a614a9c0b3\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"f92d90155a24acca\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"dda142076422744e\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"49c25dfd54c85214\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"ede7661b1d1c650a\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"c08f51e8569f3aca\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"a0496ceb5d99e33b\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"566e1841631092b9\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"5877ed64319e0c76\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"afac51708ec65b92\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"1371094c0895ea8b\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"6cb1183ce774e807\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"de03532d94cc2ef7\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"28ee32990921cfdc\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"4b8939ac60275e56\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"f6e591b9e4dcab67\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"8c8bcd6b6202864f\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"4d99bf2c97e2c2e2\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"fcc95ad3f093c7d4\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"5e119b0ef41500db\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"8717eb31c659b0aa\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"02416e63c23a489f\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"e1478a60ce98f567\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"83837382e699d20e\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"94d99a144d6d1464\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"e00bf06a01f44c39\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"a2271234dd10801b\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"b01d0f7b48fcaf09\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"bcb702bb9ded432a\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"c49b132629f2ce20\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"a0fde495bba7ae80\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"a3e4e3f96bba7410\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"e024f569ca1eed54\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"256aab889834886f\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"d23e6decdca55894\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"6bf59453e484ff82\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"3ea83aceab931b72\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"c1f5eb6f23979e80\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"8978d5927454fc54\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"2f3ed56bb1a27ef4\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"bfb270001c941dad\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"a2791a67ad1c6cdd\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"4b7d0aea5be5446b\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"7c0446b3f5aa7e55\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"8b2fbd765cfe374a\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"e0955f2ae6aa5eed\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"8bc8f86b4302908d\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"a2669221c00f6b4f\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"7d2a45b5cfb17032\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"4b9925075b65c984\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"c346a875adc2ab57\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"266ffadd30a79d13\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"7164441ffa747332\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"eac8bd9c305d62db\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"fb7092123a954853\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"6dd8eacec10abdd2\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"dd778db20044ebc6\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"21a1f899c3ddcf91\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"78ea364cc99180ff\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"3d39da88f5f58075\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"9951416062574622\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"86a464c6e0326d73\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"3f45ff389952ce25\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"c4027a532578d66c\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"837e704fcc37edc5\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"f750e8113502603a\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"6ba26db2d95e7662\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"48639153497cfb0d\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"032a02d8edd39c9d\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"17dc290e4509ae41\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"f7243e1feece8468\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"dcbc2a999b7c489f\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"c4089670784dd5e5\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"81371eb011347950\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"64ca3750cc2559c2\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"b33c046ef458d1c6\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"d4855b385e811dca\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"35c018f210aa4255\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"a744dc0250ac9717\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"50ef487704f7b5b0\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"0827a33143e075e6\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"671e91d5e0541439\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"c48403c5052fba74\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"303b7f457594756c\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"aabfb1da611d0844\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"d16b6ae6216183f9\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"e2f70b406453cc94\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"e03b150afcbe2dbf\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"08fde39c6ff1752f\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"c97ca7c46e1c18c7\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"cf423ea63c0f242f\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"d679218546a3044c\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"1a200b5adbc608bd\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"036af6010699f70c\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"51bf758f772b8509\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"8729748b93d2ffee\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"ca2d33ba5825c92d\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"5d94e6f6e48dad4b\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"857adf37f6abb402\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"f2824cc0622f4724\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"1233c622ea46da07\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"987791ba186482cf\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"3a469d9fdf57c9ee\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"0b9a59d975353cd8\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"3785336e2714e8db\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"a8b53964da975625\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"6be502769b28dc11\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"76fcb97fd57c7c53\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"49600378dc83c586\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"0d56467b90da3a06\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"53a4ccbd81d184f9\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"273f3620d498d61e\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"bd4475d384512e4e\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"f932cd54fc1bffca\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"c9a9287db9259b9c\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"0ae8bf0f7a167f78\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"d198f9f78207d975\",\"/knowledge-medium/src/plugins/recents/index.js\":\"ec1d53e5b01a050f\",\"/knowledge-medium/src/plugins/recents/target.js\":\"abeac537f59f7d32\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"6c3a36267338651a\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"689d5ba5be9e847c\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"e29aeb9389961a16\",\"/knowledge-medium/src/plugins/references/index.js\":\"fe8ac9f76587085f\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"447a5c1867119565\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"3eb88667bff1e6c0\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"abbcb3c7626d1a28\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"baf708bfd94fb014\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"bccb712a02d7ad55\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"fae5d2b815fa214e\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"894d7271da2c9320\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"ee94abf52dbe1cf8\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"93faa8ceb11be9dd\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"11b6e60530243751\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"fa681669e02e0b1a\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"094fa6aac3881e81\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"1607161e33bca6a1\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"fc6205803f7a1cd7\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"5f4978cfbf95162a\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"3eadc9da04535bc4\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"a4c44f919afcc213\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"0e097822cdaecc0d\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"5f683f81c3500c17\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"630a37a62bd0493e\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"97f1d9ef633f8be7\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"12cd070df018b2a8\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"043402c9c92c3122\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"25bfaa3826a52520\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"10073d4e51c443da\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"35c57a9e999ec5e7\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"7d782c34cd5028ce\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"31e9a2069abc684c\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"4a0e73e92d348224\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"a3ec1d6dce0e3b9c\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"93854cef6af399de\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"a9f5df96a0caa1b4\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"15bfaf97bd2d176a\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"fc7da3e34647cf6d\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"51542883e79aaa35\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"44518dc8ace2336f\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"ebb1faf1c6a26146\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"c563ede531396bf1\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"49e229387892a4f3\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"e7cdb2913b7b1e8f\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"9b3a49b146dd7e99\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"44052b1572a30fcf\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"683e563d6a101236\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"977c95c0de8997a0\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"7cd89c39d1f07c15\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"f2648b4fe85ddec5\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"74ab30efbfb87b9a\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"3c782478f073c96a\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"8de4c5df5a3a04cd\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"3b84022d817092e5\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"faf3ad6f0750f428\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"edbe077cfa6ce2b7\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"7d16c06ce63bde94\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"0948f3f62177b0d7\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"48b8f9f9d64cc5ca\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"ed5203c74efbe9ed\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"8995932368e80ca8\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"7029cd10fd50acd7\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"08edfcfce0b7b5f7\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"882e462aa955f6c4\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"c2bbce18ac11067e\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"1b5ab765fe3fab20\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"694f861fc294fd20\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"a70d3b6558adc59f\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"46bb61fee7b78570\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"db8ee702cc32198a\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"b1cb3b15bdd8edf6\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"3ea0193f88977b96\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"015fe3297d3b0ae2\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"73ed77ba8fa4a1bc\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"984a68c3b5ee4927\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"9129a565b6084119\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"7b56b74593729a1f\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"7049ec28dd1badf6\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"05baecab5ff5814a\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"a91c62703a853bd3\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"3c105557987d2540\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"065f3963ede7ffa7\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"9d9c6035095276d8\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"7b4fd51a6cedb9e2\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"9c0cc3cd70e71612\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"44cd06357caac08b\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"c029fb5f867a0bf0\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"8d87b73443241a63\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"20a1778f8afbd45d\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"76fb38dae7306f13\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"4a9b1f178f3b93ea\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"63d7b49572ff537f\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"2926ed7dec204d4d\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"db1822788cb16c6a\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"2474f9cb29b8997f\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"746fab4e3385e9f0\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"25d81960b2074e38\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"84e80ba49240cf07\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"9c82f5e1c3ffc517\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"a9c094d6973b90c5\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"339721b7b6ac64f5\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"ab22e8fa487654f9\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"b3de62346f83559c\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"405581a8f82540cb\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"90cdae39a6e2b58a\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"64686e5358f2af8c\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"c5e4d705766aa8b4\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"0a2d4e1d296f50ee\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"714cde5f78bafa24\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"5eb686310409531b\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"4af09f16bc8b335d\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"8d2d380046d85d03\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"a9ba8cdf8ddbea49\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"223dcdeac90bfa8b\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"0d933e6a5a9a6da1\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"34d58127c012913f\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"4c08c13c11589e4d\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"b0603b9016a068d6\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"017d9df46386f526\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"ab7c7da7c92e49be\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"e27c56d683e8d354\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"8382af11ff39e13c\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"482de216f287c990\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"496c0ed8fb34fd5c\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"f92116f76c562971\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"986937623f284913\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"f8c82aceecc39b30\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"eeda4189eef31054\",\"/knowledge-medium/src/plugins/tables/index.js\":\"fa8d4efdd972ca0d\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"b3d6e3cd65657416\",\"/knowledge-medium/src/plugins/tables/model.js\":\"139191aecd1394fc\",\"/knowledge-medium/src/plugins/tables/query/QueryText.js\":\"770f3a2f5e5fd575\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"75a18dff06bc6db2\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"3c21cf222fe8bc15\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"f6f6ffbce115e66b\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"ea134802049fc792\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"7a6c45f779d49f83\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"7152ddcfc974f73f\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"8eb6d1ea4780e90a\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"d2a6cf7834461e95\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"e63aa2b1f004858f\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"7c6394477590e9d0\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"9ed50066ccafea64\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"558e9fc379023163\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"cbe7a48055179296\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"22b05b37e3ce5b43\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"1ad4e8cd8adea1b0\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"8c1ccb74072ab040\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"0557727c045931de\",\"/knowledge-medium/src/plugins/todo/index.js\":\"5578e7ccf84c494f\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"09daad55435e100a\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"a7ee65757831b981\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"e23b0f732f25dc88\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"587adc81ad7de46e\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"da443bf7af3ecdc5\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"1264b4c7530392f7\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"cbcfdefda3ac1d49\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"ea063c2bb580ad98\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"1d9c4cfa22d8720d\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"73bbb8b79cc4ee44\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"673e3b517dd4eda0\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"dcf701aa3b78dcd5\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"cf5c1c13cfb9a17c\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"f77f81a524cb3c76\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"d638c0ef27d30511\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"8022766477bd0d34\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"fa2dc52c849db76a\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"d39e87f86745cf37\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"2d970327f88346d3\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"94aac1fc25be10b3\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"493cc23a589b6cc4\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"7b098dbbc5f8b378\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"2ff353506c9f3a74\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"8ee5d8b0062cedda\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"735bc7adfe8e7dfb\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"84118d57b815ce5a\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"eaddd87a9e3eda39\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"2a2935494896b1cf\",\"/knowledge-medium/src/registerServiceWorker.js\":\"f738a1168c0498eb\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"50a81a841e1861fe\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"23b0896ca43f58f8\",\"/knowledge-medium/src/services/authStorage.js\":\"85d082f01afaba19\",\"/knowledge-medium/src/services/powersync.js\":\"b5a52c502e3ba659\",\"/knowledge-medium/src/services/supabase.js\":\"aeb6261b4cc8d5d7\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"655a6c5e21837e07\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"5a0dba8a5b20ec56\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"4fb298e2739e474d\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"a17d14093c672fa9\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"27933bad99d389ef\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"46c4d0852e8b9fd6\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"a2d0b4c2c0740a05\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"99d2bb2aaeab67f5\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"2b8a9dc6ad3e3e42\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"7c5f601b18a8fec6\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"a7cc4971d21274c5\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"447f8705ec9ee870\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"6036bd6d12acac9b\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"b74cc307f1d6eb83\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"049dcfe01e0176f8\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"e4cb2133cd6a0ef8\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"bce6ef6bef6d6680\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"ed317dde5c0426eb\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"4ea488cc8bd5b9d0\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"07efb98c8f400808\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"36a76cc6e2b0bf14\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"002f2fc6347e1487\",\"/knowledge-medium/src/shortcuts/types.js\":\"c33c6c87381897cf\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"bbfdea72bde3a5ea\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"4cda87b1aab1c07b\",\"/knowledge-medium/src/shortcuts/utils.js\":\"417be6e41176361b\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"d91159c568ba3545\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"507169550603f2b3\",\"/knowledge-medium/src/sync/byteTransform.js\":\"2753128e50489f61\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"af23a3fe5b801f8f\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"252c13a7c8e9b2e0\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"ba1fb7d58794ccb4\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"0c79046b23bd9020\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"1ed7027b306de661\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"0d499ff92d899c34\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"d9a64f96ac4936ef\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"58a79379938fadad\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"147c2be5a00d7d58\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"4e101acbef74860f\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"1eb0f7010f5112c8\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"4315fad8dc974532\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"39ab81c09937309b\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"7ae0e02431191615\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"c83c79b958728301\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"007f0dc4821637cb\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"dbfaa98efc455b69\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"7b89582fd3cc338f\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"b9ff4c1d8827ca21\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"1a030ce6199177e0\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"ac29138f5608239c\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"2bf8f28a4c65d553\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"79a71e6141903121\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"0eae4a40ad701d5f\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"a19618cc9048b057\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"1a95f0376a877a62\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"b59f68af7dd3bb4f\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"7000af9b43bc21e8\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"93f115740c53e48f\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"7501c544b54aaba2\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"d352088b6677e240\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"959ac4c1af7162de\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"a571378c4e5b4915\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"425f99882cd23e64\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"e0b3a2e3b49af6b5\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"672dc78699d54cb4\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"c05480607ca69991\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"46bcc880200a9c2f\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"5c5f87fb1deed38b\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"b7149ff7f0617a4a\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"bd92a57669f3e1a5\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"dc9eaffe48854168\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"9fe0e65ff0c93ac6\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"e6ee4860aff871dd\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"7da829d346e393c9\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"c673c2174e19f0b7\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"1723a2d175eff9e1\",\"/knowledge-medium/src/sync/transform.js\":\"976a10ab119efad6\",\"/knowledge-medium/src/themeBootDefaults.js\":\"beeb32e925f17fff\",\"/knowledge-medium/src/types.js\":\"b17f832530181db2\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"5e1e10f3ac1ddd11\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"12aaa47de34ce237\",\"/knowledge-medium/src/utils/array.js\":\"64797ef89c98162a\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"f6013ea876b33158\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"572ccec0d953336c\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"6dd25544c062f468\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"0ae473df3c9d2fbe\",\"/knowledge-medium/src/utils/callbackSet.js\":\"d7a09ef50bff3ffe\",\"/knowledge-medium/src/utils/clientId.js\":\"0fadb95795471895\",\"/knowledge-medium/src/utils/codemirror.js\":\"197949d361248873\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"ba3cd6ee3af4b501\",\"/knowledge-medium/src/utils/copy.js\":\"39c425f02c3d49de\",\"/knowledge-medium/src/utils/dailyPage.js\":\"7220b2d345153202\",\"/knowledge-medium/src/utils/dbForensics.js\":\"a3bb93dcc091ab0b\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"92fbcbd62d2c81ff\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"f49e41eced6c7e0e\",\"/knowledge-medium/src/utils/dialogs.js\":\"191486197edf5bcf\",\"/knowledge-medium/src/utils/dom.js\":\"2a4228cce6c93128\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"254c5d3cfa1618b8\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"15955937025d26db\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"f6d907e47fefb560\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"070623cd49448ade\",\"/knowledge-medium/src/utils/flipSlide.js\":\"2cceb7cf8eba3645\",\"/knowledge-medium/src/utils/fnv1a.js\":\"77cc89563cc39b19\",\"/knowledge-medium/src/utils/formatBytes.js\":\"551fab8d10907aff\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"b12d063ad2fdb7fd\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"ac5453a352dfb937\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"e590e9985b073299\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"05bb7e9b11a0d549\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"d086cf73ad2a6f58\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"3523169f06412afa\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"897457c2ab7ba483\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"25928a8adf01c5d0\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"ba2347bcc51b3fb0\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"937b96e60cd86ae8\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"faae7d637ed3e7a3\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"9c16153b6472e93c\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"153db5a28bccf532\",\"/knowledge-medium/src/utils/markdownParser.js\":\"370b805d2aad48a4\",\"/knowledge-medium/src/utils/memoize.js\":\"0402116a2783b2d8\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"f9cf36f3777e3766\",\"/knowledge-medium/src/utils/nameList.js\":\"0cdda0eb4e08d2c0\",\"/knowledge-medium/src/utils/navigation.js\":\"5a82d38a0dc457b8\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"d06039a0d2281b37\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"71daa4e4fa322ba8\",\"/knowledge-medium/src/utils/panelClearance.js\":\"44e092bc3e1203bb\",\"/knowledge-medium/src/utils/panelHistory.js\":\"80a9d52df3a6ed4b\",\"/knowledge-medium/src/utils/panelLanes.js\":\"cd8b29ef5ab06b77\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"584f28592950e192\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"67b74519d38dd149\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"642a21f091492d9c\",\"/knowledge-medium/src/utils/platform.js\":\"beb8ab47f635c1fa\",\"/knowledge-medium/src/utils/pluralize.js\":\"06dc8991475fee52\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"ae67f7753179326e\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"776265eedeb2b47d\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"f2d0506963364330\",\"/knowledge-medium/src/utils/react.js\":\"3f3cf259825ec1d7\",\"/knowledge-medium/src/utils/relativeDate.js\":\"6fc18865f794f956\",\"/knowledge-medium/src/utils/relativeTime.js\":\"933d2a44a47df32e\",\"/knowledge-medium/src/utils/renderScope.js\":\"5c82c36cbd74cf47\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"05cd8ea7aa84919e\",\"/knowledge-medium/src/utils/routing.js\":\"41728bacbf72001a\",\"/knowledge-medium/src/utils/safeMode.js\":\"8dce5eb873720d08\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"0f441160620467b9\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"a7882ccebeaad809\",\"/knowledge-medium/src/utils/selection.js\":\"f67b6f803c5bc82c\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"f553e17581a24ee8\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"4a5f396c14e5f792\",\"/knowledge-medium/src/utils/state.js\":\"e8011dc6556da704\",\"/knowledge-medium/src/utils/string.js\":\"52277b2e7e2a0544\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"824285165d54ae67\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"6c92228a53db388b\",\"/knowledge-medium/src/utils/toast.js\":\"37ced84fcd26dd69\",\"/knowledge-medium/src/utils/toggleStore.js\":\"852a34d157a0afab\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"e85be6af33790c80\",\"/knowledge-medium/src/utils/userActivity.js\":\"1a9d2c2fd681e922\",\"/knowledge-medium/src/utils/viewTransition.js\":\"f9b690d7fd736900\",\"/knowledge-medium/src/utils/viewport.js\":\"fb18854530b4b8f7\",\"/knowledge-medium/src/utils/webLock.js\":\"04ad2bfe5e78b71e\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"ddebd89bc967142d\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"7d3043e30337f75b\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"199ffea252e63f05\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"e2085f3c36004c49\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"c268150abe04162a\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"884faec605477690\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"2aea286d2f2997fb\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"f5a0718a7c9e2471\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"8192726cb3b9fd30\",\"/knowledge-medium/src/vendor/react-dom.js\":\"6845d4b53fbe1d32\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"785dc5b8006f6130\",\"/knowledge-medium/src/vendor/react.js\":\"6239d8c40f0fa4dd\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
